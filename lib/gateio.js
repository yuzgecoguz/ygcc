'use strict';

const BaseExchange = require('./BaseExchange');
const { sha512, hmacSHA512Hex } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeStringLower, safeFloat2, safeString2,
  iso8601, sleep,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Gateio extends BaseExchange {

  describe() {
    return {
      id: 'gateio',
      name: 'Gate.io',
      version: 'v4',
      rateLimit: 100,
      rateLimitCapacity: 300,
      rateLimitInterval: 1000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: true,
        fetchTickers: true,
        fetchOrderBook: true,
        fetchTrades: true,
        fetchOHLCV: true,
        fetchTime: true,
        // Private
        createOrder: true,
        createLimitOrder: true,
        createMarketOrder: true,
        cancelOrder: true,
        cancelAllOrders: true,
        amendOrder: false,
        fetchOrder: true,
        fetchOpenOrders: true,
        fetchClosedOrders: true,
        fetchMyTrades: true,
        fetchBalance: true,
        fetchTradingFees: true,
        // WebSocket
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: true,
        watchBalance: true,
        watchOrders: true,
      },
      urls: {
        api: 'https://api.gateio.ws',
        ws: 'wss://api.gateio.ws/ws/v4/',
        wsPrivate: 'wss://api.gateio.ws/ws/v4/',
        doc: 'https://www.gate.io/docs/developers/apiv4/',
      },
      timeframes: {
        '10s': '10s', '1m': '1m', '5m': '5m', '15m': '15m',
        '30m': '30m', '1h': '1h', '4h': '4h', '8h': '8h',
        '1d': '1d', '7d': '7d', '30d': '30d',
      },
      fees: {
        trading: { maker: 0.002, taker: 0.002 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this.settle = config.settle || this.options.settle || 'usdt';
    this._wsClients = new Map();
    this._wsPrivateAuthenticated = false;
    this._pingTimers = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION — SHA512 body hash + HMAC-SHA512 hex (Gate.io V4)
  // ===========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = String(Math.floor(Date.now() / 1000));

    // Build body string and query string based on method
    let bodyStr = '';
    let queryStr = '';

    if (method === 'GET' || method === 'DELETE') {
      queryStr = new URLSearchParams(params).toString();
    } else {
      bodyStr = Object.keys(params).length > 0 ? JSON.stringify(params) : '';
    }

    // SHA512 hash of the body (empty string hashed for GET/DELETE)
    const bodyHash = sha512(bodyStr);

    // Signing payload: METHOD\nPATH\nQUERY\nBODY_HASH\nTIMESTAMP
    const payload = method + '\n' + path + '\n' + queryStr + '\n' + bodyHash + '\n' + timestamp;

    const signature = hmacSHA512Hex(payload, this.secret);

    const headers = {
      'KEY': this.apiKey,
      'Timestamp': timestamp,
      'SIGN': signature,
    };

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE HANDLING — Gate.io returns direct JSON (no wrapper)
  // Error responses: { label: "ERROR_CODE", message: "description" }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && data.label) {
      this._handleGateError(data.label, data.message || '');
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    const remaining = headers.get('x-gate-ratelimit-remaining');
    const limit = headers.get('x-gate-ratelimit-limit');

    if (limit && remaining) {
      const limitNum = parseInt(limit, 10);
      const remainingNum = parseInt(remaining, 10);
      const used = limitNum - remainingNum;

      if (this.enableRateLimit && this._throttler) {
        this._throttler.updateFromHeader(used);
      }

      if (remainingNum < limitNum * 0.2) {
        this.emit('rateLimitWarning', {
          used,
          limit: limitNum,
          remaining: remainingNum,
        });
      }
    }
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const label = parsed?.label;
    const msg = parsed?.message || body;

    if (label) {
      this._handleGateError(label, msg);
    }

    const full = this.id + ' HTTP ' + status + ': ' + msg;
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    if (status === 503 || status === 520 || status === 522) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  _handleGateError(label, msg) {
    const full = this.id + ' ' + label + ': ' + msg;

    const errorMap = {
      // Authentication
      'INVALID_KEY': AuthenticationError,
      'INVALID_SIGNATURE': AuthenticationError,
      'INVALID_TIMESTAMP': AuthenticationError,
      'FORBIDDEN': AuthenticationError,

      // Rate limiting
      'TOO_MANY_REQUESTS': RateLimitExceeded,
      'RATE_LIMITED': RateLimitExceeded,

      // Insufficient funds
      'INSUFFICIENT_BALANCE': InsufficientFunds,
      'BALANCE_NOT_ENOUGH': InsufficientFunds,
      'MARGIN_BALANCE_NOT_ENOUGH': InsufficientFunds,

      // Invalid order
      'INVALID_PARAM_VALUE': InvalidOrder,
      'INVALID_AMOUNT': InvalidOrder,
      'INVALID_PRICE': InvalidOrder,
      'ORDER_SIZE_TOO_SMALL': InvalidOrder,
      'ORDER_SIZE_TOO_BIG': InvalidOrder,
      'ORDER_PRICE_TOO_HIGH': InvalidOrder,
      'ORDER_PRICE_TOO_LOW': InvalidOrder,

      // Order not found
      'ORDER_NOT_FOUND': OrderNotFound,
      'ORDER_CLOSED': OrderNotFound,

      // Bad symbol
      'INVALID_CURRENCY_PAIR': BadSymbol,
      'INVALID_CURRENCY': BadSymbol,

      // Bad request
      'INVALID_PARAM': BadRequest,
      'MISSING_REQUIRED_PARAM': BadRequest,
      'INVALID_PROTOCOL': BadRequest,

      // Exchange unavailable
      'SERVER_ERROR': ExchangeNotAvailable,
      'MAINTENANCE': ExchangeNotAvailable,
      'TEMPORARILY_UNAVAILABLE': ExchangeNotAvailable,
    };

    const ErrorClass = errorMap[label] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPERS — Symbol Conversion
  // ===========================================================================

  /**
   * Normalize Gate.io status to unified format.
   */
  _normalizeStatus(status) {
    const map = {
      'open': 'NEW',
      'closed': 'FILLED',
      'cancelled': 'CANCELED',
      'canceled': 'CANCELED',
    };
    return map[status] || (status ? status.toUpperCase() : status);
  }

  /**
   * Convert unified symbol to Gate.io format.
   * BTC/USDT → BTC_USDT
   */
  _toGateSymbol(symbol) {
    if (symbol.includes('_')) return symbol; // Already Gate.io format
    return symbol.replace('/', '_');
  }

  /**
   * Convert Gate.io symbol to unified format.
   * BTC_USDT → BTC/USDT
   */
  _fromGateSymbol(pair) {
    if (!pair) return pair;
    if (pair.includes('/')) return pair; // Already unified
    return pair.replace('_', '/');
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    // Gate.io doesn't have a dedicated time endpoint
    // Use system time like Binance pattern
    return Date.now();
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (6 endpoints)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v4/spot/currency_pairs', {}, false, 1);
    // Gate.io returns direct array, no wrapper
    const result = Array.isArray(data) ? data : [];

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const pair of result) {
      const id = pair.id;  // BTC_USDT
      const base = pair.base || '';
      const quote = pair.quote || '';
      const symbol = base + '/' + quote;
      const tradeStatus = pair.trade_status;

      const market = {
        id,
        symbol,
        base,
        quote,
        status: tradeStatus,
        active: tradeStatus === 'tradable',
        precision: {
          price: pair.precision || 8,
          amount: pair.amount_precision || 8,
          base: pair.amount_precision || 8,
          quote: pair.precision || 8,
        },
        limits: {
          price: {
            min: undefined,
            max: undefined,
          },
          amount: {
            min: safeFloat(pair, 'min_base_amount'),
            max: safeFloat(pair, 'max_base_amount') || undefined,
          },
          cost: {
            min: safeFloat(pair, 'min_quote_amount'),
            max: safeFloat(pair, 'max_quote_amount') || undefined,
          },
        },
        fee: safeFloat(pair, 'fee') ? safeFloat(pair, 'fee') / 100 : undefined,
        info: pair,
      };

      this.markets[symbol] = market;
      this.marketsById[id] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol, params = {}) {
    const pair = this._toGateSymbol(symbol);
    const data = await this._request('GET', '/api/v4/spot/tickers', {
      currency_pair: pair,
      ...params,
    }, false, 1);

    // Returns array even for single pair
    const tickers = Array.isArray(data) ? data : [];
    if (tickers.length === 0) {
      throw new BadSymbol(this.id + ' symbol not found: ' + symbol);
    }
    return this._parseTicker(tickers[0]);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    const data = await this._request('GET', '/api/v4/spot/tickers', params, false, 1);
    const tickers = {};
    const list = Array.isArray(data) ? data : [];

    for (const t of list) {
      const ticker = this._parseTicker(t);
      if (!symbols || symbols.includes(ticker.symbol)) {
        tickers[ticker.symbol] = ticker;
      }
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = 20, params = {}) {
    const pair = this._toGateSymbol(symbol);
    const request = { currency_pair: pair, ...params };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v4/spot/order_book', request, false, 1);

    return {
      symbol,
      bids: (data.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: (data.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: safeInteger(data, 'current') || Date.now(),
      datetime: iso8601(safeInteger(data, 'current') || Date.now()),
      nonce: undefined,
    };
  }

  async fetchTrades(symbol, since = undefined, limit = 100, params = {}) {
    const pair = this._toGateSymbol(symbol);
    const request = { currency_pair: pair, ...params };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v4/spot/trades', request, false, 1);
    const result = Array.isArray(data) ? data : [];
    return result.map((t) => this._parseTrade(t));
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = 100, params = {}) {
    const pair = this._toGateSymbol(symbol);
    const interval = this.timeframes[timeframe] || timeframe;
    const request = {
      currency_pair: pair,
      interval,
      ...params,
    };
    if (since) request.from = String(Math.floor(since / 1000));
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v4/spot/candlesticks', request, false, 1);
    const result = Array.isArray(data) ? data : [];

    // Gate.io candlestick format: [time, volume, close, high, low, open, quote_volume]
    // Normalize to: [timestamp, open, high, low, close, volume]
    return result.map((k) => ([
      parseInt(k[0], 10) * 1000,    // timestamp (Gate.io returns seconds)
      parseFloat(k[5]),              // open (index 5)
      parseFloat(k[3]),              // high (index 3)
      parseFloat(k[4]),              // low (index 4)
      parseFloat(k[2]),              // close (index 2)
      parseFloat(k[1]),              // volume (index 1)
    ]));
  }

  // ===========================================================================
  // TRADING — PRIVATE (7 endpoints)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const pair = this._toGateSymbol(symbol);
    const request = {
      currency_pair: pair,
      side: side.toLowerCase(),
      type: type.toLowerCase(),
      amount: String(amount),
      account: 'spot',
    };

    if (price !== undefined && price !== null) {
      request.price = String(price);
    }

    if (params.timeInForce) {
      request.time_in_force = params.timeInForce;
    }

    if (params.text) {
      request.text = params.text;
    }

    // Spread remaining params
    const skip = new Set(['timeInForce', 'text']);
    for (const [k, v] of Object.entries(params)) {
      if (!skip.has(k) && !(k in request)) {
        request[k] = v;
      }
    }

    const data = await this._request('POST', '/api/v4/spot/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderCreateResult(result);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder() requires symbol');

    const pair = this._toGateSymbol(symbol);
    const path = '/api/v4/spot/orders/' + id;
    const request = { currency_pair: pair, ...params };

    const data = await this._request('DELETE', path, request, true, 1);
    const result = this._unwrapResponse(data);
    return {
      id: safeString(result, 'id') || id,
      symbol,
      status: 'CANCELED',
      info: result,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.currency_pair = this._toGateSymbol(symbol);

    const data = await this._request('DELETE', '/api/v4/spot/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    return Array.isArray(result) ? result : [];
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder() requires symbol');

    const pair = this._toGateSymbol(symbol);
    const path = '/api/v4/spot/orders/' + id;
    const request = { currency_pair: pair, ...params };

    const data = await this._request('GET', path, request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrder(result);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { status: 'open', ...params };
    if (symbol) request.currency_pair = this._toGateSymbol(symbol);
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v4/spot/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    const list = Array.isArray(result) ? result : [];
    return list.map((o) => this._parseOrder(o));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { status: 'finished', ...params };
    if (symbol) request.currency_pair = this._toGateSymbol(symbol);
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v4/spot/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    const list = Array.isArray(result) ? result : [];
    return list.map((o) => this._parseOrder(o));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.currency_pair = this._toGateSymbol(symbol);
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v4/spot/my_trades', request, true, 1);
    const result = this._unwrapResponse(data);
    const list = Array.isArray(result) ? result : [];
    return list.map((t) => this._parseMyTrade(t));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('GET', '/api/v4/spot/accounts', params, true, 1);
    const result = this._unwrapResponse(data);

    const balance = {
      info: result,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    const list = Array.isArray(result) ? result : [];
    for (const item of list) {
      const currency = item.currency;
      const available = parseFloat(item.available || '0');
      const locked = parseFloat(item.locked || '0');
      const total = available + locked;

      if (total > 0 || available > 0) {
        balance[currency] = {
          free: available,
          used: locked,
          total,
        };
      }
    }

    return balance;
  }

  async fetchTradingFees(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.currency_pair = this._toGateSymbol(symbol);

    const data = await this._request('GET', '/api/v4/wallet/fee', request, true, 1);
    const result = this._unwrapResponse(data);

    if (!result) return {};

    // Single pair returns object, multiple returns as-is
    if (symbol) {
      return {
        symbol,
        maker: safeFloat(result, 'maker_fee'),
        taker: safeFloat(result, 'taker_fee'),
        info: result,
      };
    }

    return result;
  }

  // ===========================================================================
  // WEBSOCKET V4 — Public (4) + Private (2)
  // ===========================================================================

  _getWsClient(url = undefined) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }
    const client = new WsClient({
      url: wsUrl,
      pingInterval: 0, // Disable native ping — Gate.io uses app-level
    });
    this._wsClients.set(wsUrl, client);
    return client;
  }

  async _ensureWsConnected(url = undefined) {
    const wsUrl = url || this.urls.ws;
    const client = this._getWsClient(wsUrl);
    if (!client.connected) {
      await client.connect();
      this._startGatePing(wsUrl, client);
    }
    return client;
  }

  _startGatePing(wsUrl, client) {
    if (this._pingTimers.has(wsUrl)) return;
    const timer = setInterval(() => {
      if (client.connected) {
        client.send({
          time: Math.floor(Date.now() / 1000),
          channel: 'spot.ping',
        });
      }
    }, 20000);
    this._pingTimers.set(wsUrl, timer);
  }

  _wsSign(channel, event, timestamp) {
    const payload = 'channel=' + channel + '&event=' + event + '&time=' + timestamp;
    return hmacSHA512Hex(payload, this.secret);
  }

  async _subscribePublic(channel, payload, callback) {
    const client = await this._ensureWsConnected(this.urls.ws);
    const time = Math.floor(Date.now() / 1000);

    client.send({
      time,
      channel,
      event: 'subscribe',
      payload,
    });

    const key = JSON.stringify({ channel, payload });

    const handler = (data) => {
      if (data && data.channel === channel && data.event === 'update') {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async _subscribePrivate(channel, payload, callback) {
    this.checkRequiredCredentials();
    const client = await this._ensureWsConnected(this.urls.wsPrivate);
    const time = Math.floor(Date.now() / 1000);

    const sign = this._wsSign(channel, 'subscribe', String(time));

    client.send({
      time,
      channel,
      event: 'subscribe',
      payload,
      auth: {
        method: 'api_key',
        KEY: this.apiKey,
        SIGN: sign,
      },
    });

    const key = JSON.stringify({ channel, payload, _private: true });

    const handler = (data) => {
      if (data && data.channel === channel && data.event === 'update') {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async watchTicker(symbol, callback) {
    const pair = this._toGateSymbol(symbol);
    return this._subscribePublic('spot.tickers', [pair], (msg) => {
      if (msg.result) {
        callback(this._parseWsTicker(msg.result, symbol));
      }
    });
  }

  async watchOrderBook(symbol, callback, depth = 20) {
    const pair = this._toGateSymbol(symbol);
    return this._subscribePublic('spot.order_book_update', [pair, String(depth), '100ms'], (msg) => {
      if (msg.result) {
        callback({
          symbol,
          type: msg.result.e === 'depthUpdate' ? 'update' : 'snapshot',
          bids: (msg.result.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          asks: (msg.result.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          timestamp: safeInteger(msg.result, 't') || Date.now(),
          nonce: undefined,
        });
      }
    });
  }

  async watchTrades(symbol, callback) {
    const pair = this._toGateSymbol(symbol);
    return this._subscribePublic('spot.trades', [pair], (msg) => {
      if (msg.result) {
        const t = msg.result;
        const ts = safeInteger(t, 'create_time') ? safeInteger(t, 'create_time') * 1000 : Date.now();
        callback({
          id: safeString(t, 'id'),
          symbol: this._fromGateSymbol(t.currency_pair),
          price: parseFloat(t.price),
          amount: parseFloat(t.amount),
          cost: parseFloat(t.price) * parseFloat(t.amount),
          side: t.side,
          timestamp: ts,
          datetime: iso8601(ts),
        });
      }
    });
  }

  async watchKlines(symbol, interval, callback) {
    const pair = this._toGateSymbol(symbol);
    const tf = this.timeframes[interval] || interval;
    return this._subscribePublic('spot.candlesticks', [tf, pair], (msg) => {
      if (msg.result) {
        const k = msg.result;
        const ts = safeInteger(k, 't') ? safeInteger(k, 't') * 1000 : Date.now();
        callback({
          symbol,
          interval: tf,
          timestamp: ts,
          open: parseFloat(k.o || '0'),
          high: parseFloat(k.h || '0'),
          low: parseFloat(k.l || '0'),
          close: parseFloat(k.c || '0'),
          volume: parseFloat(k.v || '0'),
          closed: k.w === true,
        });
      }
    });
  }

  async watchBalance(callback) {
    this.checkRequiredCredentials();
    return this._subscribePrivate('spot.balances', [], (msg) => {
      if (msg.result) {
        const list = Array.isArray(msg.result) ? msg.result : [msg.result];
        const balances = {};
        for (const d of list) {
          const currency = d.currency;
          balances[currency] = {
            free: parseFloat(d.available || '0'),
            used: parseFloat(d.freeze || d.locked || '0'),
            total: parseFloat(d.total || '0'),
          };
        }
        callback({
          event: 'balance',
          timestamp: Date.now(),
          balances,
        });
      }
    });
  }

  async watchOrders(callback) {
    this.checkRequiredCredentials();
    return this._subscribePrivate('spot.orders', ['!all'], (msg) => {
      if (msg.result) {
        const list = Array.isArray(msg.result) ? msg.result : [msg.result];
        for (const o of list) {
          const order = this._parseOrder(o);
          order.event = 'order';
          callback(order);
        }
      }
    });
  }

  async closeAllWs() {
    for (const [, client] of this._wsClients) {
      await client.close();
    }
    this._wsClients.clear();
    this._wsHandlers.clear();
    this._wsPrivateAuthenticated = false;
    for (const [, timer] of this._pingTimers) {
      clearInterval(timer);
    }
    this._pingTimers.clear();
  }

  // ===========================================================================
  // PARSERS — Normalize Gate.io responses to unified format
  // ===========================================================================

  _parseTicker(data) {
    const last = safeFloat(data, 'last');
    const open = safeFloat(data, 'open') || undefined;
    const change = safeFloat(data, 'change_percentage')
      ? (last && open ? last - open : undefined)
      : undefined;
    const percentage = safeFloat(data, 'change_percentage');

    return {
      symbol: this._fromGateSymbol(data.currency_pair),
      last,
      high: safeFloat(data, 'high_24h'),
      low: safeFloat(data, 'low_24h'),
      open,
      close: last,
      bid: safeFloat(data, 'highest_bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'lowest_ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'base_volume'),
      quoteVolume: safeFloat(data, 'quote_volume'),
      change,
      percentage,
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  /**
   * Parse WS ticker (slightly different field names).
   */
  _parseWsTicker(data, symbol) {
    const last = safeFloat(data, 'last');
    return {
      symbol: symbol || this._fromGateSymbol(data.currency_pair),
      last,
      high: safeFloat(data, 'high_24h'),
      low: safeFloat(data, 'low_24h'),
      open: undefined,
      close: last,
      bid: safeFloat(data, 'highest_bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'lowest_ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'base_volume'),
      quoteVolume: safeFloat(data, 'quote_volume'),
      change: undefined,
      percentage: safeFloat(data, 'change_percentage'),
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  _parseOrder(data) {
    const amount = safeFloat(data, 'amount') || 0;
    const left = safeFloat(data, 'left') || 0;
    const filled = amount - left;
    const filledTotal = safeFloat(data, 'filled_total') || 0;
    const avgPrice = filled > 0 ? filledTotal / filled : 0;
    const rawStatus = safeString(data, 'status');

    const ts = safeString(data, 'create_time')
      ? Math.floor(parseFloat(data.create_time) * 1000)
      : undefined;

    return {
      id: safeString(data, 'id'),
      clientOrderId: safeString(data, 'text'),
      symbol: this._fromGateSymbol(data.currency_pair),
      type: safeStringUpper(data, 'type'),
      side: safeStringUpper(data, 'side'),
      price: safeFloat(data, 'price') || 0,
      amount,
      filled,
      remaining: left,
      cost: filledTotal,
      average: avgPrice,
      status: this._normalizeStatus(rawStatus),
      timeInForce: safeString(data, 'time_in_force'),
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      trades: [],
      fee: {
        cost: safeFloat(data, 'fee'),
        currency: safeString(data, 'fee_currency'),
      },
      info: data,
    };
  }

  _parseOrderCreateResult(data) {
    return {
      id: safeString(data, 'id'),
      clientOrderId: safeString(data, 'text'),
      symbol: this._fromGateSymbol(data.currency_pair),
      status: 'NEW',
      info: data,
    };
  }

  _parseTrade(data) {
    const ts = safeString(data, 'create_time')
      ? Math.floor(parseFloat(data.create_time) * 1000)
      : safeInteger(data, 'create_time_ms');

    return {
      id: safeString(data, 'id'),
      symbol: this._fromGateSymbol(data.currency_pair),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'amount'),
      cost: (safeFloat(data, 'price') || 0) * (safeFloat(data, 'amount') || 0),
      side: safeStringLower(data, 'side'),
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      info: data,
    };
  }

  _parseMyTrade(data) {
    const ts = safeString(data, 'create_time')
      ? Math.floor(parseFloat(data.create_time) * 1000)
      : safeInteger(data, 'create_time_ms');

    return {
      id: safeString(data, 'id'),
      orderId: safeString(data, 'order_id'),
      symbol: this._fromGateSymbol(data.currency_pair),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'amount'),
      cost: (safeFloat(data, 'price') || 0) * (safeFloat(data, 'amount') || 0),
      fee: {
        cost: safeFloat(data, 'fee'),
        currency: safeString(data, 'fee_currency'),
      },
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      side: safeStringLower(data, 'side'),
      isMaker: safeString(data, 'role') === 'maker',
      info: data,
    };
  }
}

module.exports = Gateio;

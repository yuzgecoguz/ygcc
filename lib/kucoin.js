'use strict';

const crypto = require('crypto');
const BaseExchange = require('./BaseExchange');
const { hmacSHA256Base64 } = require('./utils/crypto');
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

class KuCoin extends BaseExchange {

  describe() {
    return {
      id: 'kucoin',
      name: 'KuCoin',
      version: 'v1',
      rateLimit: 100,
      rateLimitCapacity: 100,
      rateLimitInterval: 10000,
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
        api: 'https://api.kucoin.com',
        ws: null,        // Token-based, determined at runtime
        wsPrivate: null,  // Token-based, determined at runtime
        doc: 'https://www.kucoin.com/docs/beginners/introduction',
      },
      timeframes: {
        '1m': '1min', '3m': '3min', '5m': '5min', '15m': '15min',
        '30m': '30min', '1h': '1hour', '2h': '2hour', '4h': '4hour',
        '6h': '6hour', '8h': '8hour', '12h': '12hour',
        '1d': '1day', '1w': '1week',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this.passphrase = config.passphrase || '';
    this._wsClients = new Map();
    this._wsPrivateAuthenticated = false;
    this._wsToken = null;
    this._wsPrivateToken = null;
    this._pingTimers = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA256 Base64 + Encrypted Passphrase (KuCoin V2)
  // ===========================================================================

  checkRequiredCredentials() {
    super.checkRequiredCredentials();
    if (!this.passphrase) {
      throw new ExchangeError(this.id + ' passphrase required');
    }
  }

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = String(Date.now());

    // Build prehash: timestamp + METHOD + path (+ query or body)
    let prehash;
    if (method === 'GET' || method === 'DELETE') {
      const qs = new URLSearchParams(params).toString();
      const requestPath = qs ? (path + '?' + qs) : path;
      prehash = timestamp + method + requestPath;
    } else {
      const body = Object.keys(params).length > 0 ? JSON.stringify(params) : '';
      prehash = timestamp + method + path + body;
    }

    const signature = hmacSHA256Base64(prehash, this.secret);

    // Encrypt passphrase: HMAC-SHA256-Base64(passphrase, secret)
    const encryptedPassphrase = hmacSHA256Base64(this.passphrase, this.secret);

    const headers = {
      'KC-API-KEY': this.apiKey,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-PASSPHRASE': encryptedPassphrase,
      'KC-API-KEY-VERSION': '2',
    };

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE ENVELOPE — KuCoin wraps everything in { code: "200000", data }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && 'code' in data) {
      if (data.code !== '200000') {
        this._handleKucoinError(data.code, data.msg || '');
      }
      return data.data;
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    // KuCoin doesn't expose standard rate limit headers
    // Throttler handles client-side limiting
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const code = parsed?.code;
    const msg = parsed?.msg || body;

    if (code && code !== '200000') {
      this._handleKucoinError(code, msg);
    }

    const full = this.id + ' HTTP ' + status + ': ' + msg;
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    if (status === 503 || status === 520 || status === 522) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  _handleKucoinError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;

    const errorMap = {
      // Authentication
      '400001': AuthenticationError,  // Invalid API key
      '400002': AuthenticationError,  // Signature invalid
      '400003': AuthenticationError,  // API key not found
      '400004': AuthenticationError,  // Passphrase error
      '400005': AuthenticationError,  // Timestamp error
      '400007': AuthenticationError,  // API key frozen

      // Rate limiting
      '429000': RateLimitExceeded,    // Too many requests
      '200004': RateLimitExceeded,    // Rate limit exceeded

      // Insufficient funds
      '200001': InsufficientFunds,    // Insufficient balance
      '400100': BadRequest,           // Parameter error
      '400200': InvalidOrder,         // Invalid order size
      '400500': InvalidOrder,         // Invalid price
      '400600': InvalidOrder,         // Minimum amount
      '400760': InsufficientFunds,    // Insufficient balance for withdrawal

      // Order not found
      '400400': OrderNotFound,        // Order not found
      '404000': OrderNotFound,        // Not found

      // Bad symbol
      '400300': BadSymbol,            // Symbol not found

      // Exchange unavailable
      '500000': ExchangeNotAvailable, // Internal server error
      '503000': ExchangeNotAvailable, // Service unavailable
    };

    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Normalize KuCoin status to unified format.
   */
  _normalizeStatus(isActive, dealSize) {
    if (isActive) return 'NEW';
    if (dealSize && parseFloat(dealSize) > 0) return 'FILLED';
    return 'CANCELED';
  }

  _normalizeOrderStatus(status) {
    const map = {
      'active': 'NEW',
      'done': 'FILLED',
      'cancelled': 'CANCELED',
      'canceled': 'CANCELED',
    };
    return map[status] || (status ? status.toUpperCase() : status);
  }

  /**
   * Convert unified symbol to KuCoin format.
   * BTC/USDT → BTC-USDT
   */
  _toKucoinSymbol(symbol) {
    if (symbol.includes('-')) return symbol;
    return symbol.replace('/', '-');
  }

  /**
   * Convert KuCoin symbol to unified format.
   * BTC-USDT → BTC/USDT
   */
  _fromKucoinSymbol(symbol) {
    if (!symbol) return symbol;
    if (symbol.includes('/')) return symbol;
    return symbol.replace('-', '/');
  }

  /**
   * Generate unique clientOid for orders.
   */
  _generateClientOid() {
    return crypto.randomUUID();
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    const data = await this._request('GET', '/api/v1/timestamp', {}, false, 1);
    const result = this._unwrapResponse(data);
    return result;
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (6 endpoints)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v2/symbols', {}, false, 1);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const item of (result || [])) {
      const id = item.symbol;         // BTC-USDT
      const base = item.baseCurrency;
      const quote = item.quoteCurrency;
      const symbol = base + '/' + quote;
      const enableTrading = item.enableTrading;

      const market = {
        id,
        symbol,
        base,
        quote,
        status: enableTrading ? 'tradable' : 'disabled',
        active: enableTrading === true,
        precision: {
          price: safeInteger(item, 'priceIncrement') ? String(item.priceIncrement).split('.')[1]?.length || 2 : 2,
          amount: safeInteger(item, 'baseIncrement') ? String(item.baseIncrement).split('.')[1]?.length || 4 : 4,
          base: safeInteger(item, 'baseIncrement') ? String(item.baseIncrement).split('.')[1]?.length || 4 : 4,
          quote: safeInteger(item, 'priceIncrement') ? String(item.priceIncrement).split('.')[1]?.length || 2 : 2,
        },
        limits: {
          price: {
            min: safeFloat(item, 'priceIncrement'),
            max: undefined,
          },
          amount: {
            min: safeFloat(item, 'baseMinSize'),
            max: safeFloat(item, 'baseMaxSize') || undefined,
          },
          cost: {
            min: safeFloat(item, 'quoteMinSize'),
            max: safeFloat(item, 'quoteMaxSize') || undefined,
          },
        },
        stepSize: safeFloat(item, 'baseIncrement'),
        tickSize: safeFloat(item, 'priceIncrement'),
        info: item,
      };

      this.markets[symbol] = market;
      this.marketsById[id] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol, params = {}) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const data = await this._request('GET', '/api/v1/market/orderbook/level1', {
      symbol: kcSymbol,
      ...params,
    }, false, 1);
    const result = this._unwrapResponse(data);

    if (!result) {
      throw new BadSymbol(this.id + ' symbol not found: ' + symbol);
    }
    return this._parseTicker(result, symbol);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    const data = await this._request('GET', '/api/v1/market/allTickers', params, false, 1);
    const result = this._unwrapResponse(data);
    const tickers = {};

    const list = result?.ticker || [];
    for (const t of list) {
      const sym = this._fromKucoinSymbol(t.symbol);
      if (!symbols || symbols.includes(sym)) {
        tickers[sym] = this._parseAllTicker(t, sym);
      }
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = 20, params = {}) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const endpoint = limit <= 20
      ? '/api/v1/market/orderbook/level2_20'
      : '/api/v1/market/orderbook/level2_100';
    const request = { symbol: kcSymbol, ...params };

    const data = await this._request('GET', endpoint, request, false, 1);
    const result = this._unwrapResponse(data);

    return {
      symbol,
      bids: (result.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: (result.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: safeInteger(result, 'time') || Date.now(),
      datetime: iso8601(safeInteger(result, 'time') || Date.now()),
      nonce: safeString(result, 'sequence'),
    };
  }

  async fetchTrades(symbol, since = undefined, limit = undefined, params = {}) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const request = { symbol: kcSymbol, ...params };

    const data = await this._request('GET', '/api/v1/market/histories', request, false, 1);
    const result = this._unwrapResponse(data);
    return (result || []).map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = undefined, params = {}) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const type = this.timeframes[timeframe] || timeframe;
    const request = {
      symbol: kcSymbol,
      type,
      ...params,
    };
    if (since) request.startAt = String(Math.floor(since / 1000));
    // KuCoin returns max 1500 candles

    const data = await this._request('GET', '/api/v1/market/candles', request, false, 1);
    const result = this._unwrapResponse(data);

    // KuCoin candlestick format: [time(s), open, close, high, low, volume, turnover]
    // NOTE: close is at index 2 (not 4 like standard OHLCV)
    // Normalize to: [timestamp, open, high, low, close, volume]
    const list = (result || []).map((k) => ([
      parseInt(k[0], 10) * 1000,    // timestamp (KuCoin returns seconds)
      parseFloat(k[1]),              // open (index 1)
      parseFloat(k[3]),              // high (index 3)
      parseFloat(k[4]),              // low (index 4)
      parseFloat(k[2]),              // close (index 2) — UNUSUAL!
      parseFloat(k[5]),              // volume (index 5)
    ]));

    // KuCoin returns newest first — reverse for chronological order
    list.reverse();

    if (limit && list.length > limit) {
      return list.slice(-limit);
    }
    return list;
  }

  // ===========================================================================
  // TRADING — PRIVATE (7 endpoints)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const kcSymbol = this._toKucoinSymbol(symbol);
    const clientOid = params.clientOid || this._generateClientOid();

    const request = {
      clientOid,
      symbol: kcSymbol,
      side: side.toLowerCase(),
      type: type.toLowerCase(),
    };

    if (type.toLowerCase() === 'limit') {
      request.size = String(amount);
      if (price !== undefined && price !== null) {
        request.price = String(price);
      }
    } else {
      // Market order — size is in base currency for sell, funds for buy
      request.size = String(amount);
    }

    if (params.timeInForce) {
      request.timeInForce = params.timeInForce;
    }

    // Spread remaining params
    const skip = new Set(['clientOid', 'timeInForce']);
    for (const [k, v] of Object.entries(params)) {
      if (!skip.has(k) && !(k in request)) {
        request[k] = v;
      }
    }

    const data = await this._request('POST', '/api/v1/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderCreateResult(result, clientOid);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const path = '/api/v1/orders/' + id;
    const data = await this._request('DELETE', path, params, true, 1);
    const result = this._unwrapResponse(data);
    return {
      id,
      symbol,
      status: 'CANCELED',
      cancelledOrderIds: result?.cancelledOrderIds || [id],
      info: result,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.symbol = this._toKucoinSymbol(symbol);
    request.tradeType = params.tradeType || 'TRADE';

    const data = await this._request('DELETE', '/api/v1/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    return {
      cancelledOrderIds: result?.cancelledOrderIds || [],
      info: result,
    };
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const path = '/api/v1/orders/' + id;
    const data = await this._request('GET', path, params, true, 1);
    const result = this._unwrapResponse(data);

    if (!result) {
      throw new OrderNotFound(this.id + ' order not found: ' + id);
    }
    return this._parseOrder(result);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { status: 'active', ...params };
    if (symbol) request.symbol = this._toKucoinSymbol(symbol);
    if (limit) request.pageSize = limit;

    const data = await this._request('GET', '/api/v1/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    const items = result?.items || [];
    return items.map((o) => this._parseOrder(o));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { status: 'done', ...params };
    if (symbol) request.symbol = this._toKucoinSymbol(symbol);
    if (since) request.startAt = since;
    if (limit) request.pageSize = limit;

    const data = await this._request('GET', '/api/v1/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    const items = result?.items || [];
    return items.map((o) => this._parseOrder(o));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.symbol = this._toKucoinSymbol(symbol);
    if (since) request.startAt = since;
    if (limit) request.pageSize = limit;

    const data = await this._request('GET', '/api/v1/fills', request, true, 1);
    const result = this._unwrapResponse(data);
    const items = result?.items || [];
    return items.map((t) => this._parseMyTrade(t));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const request = { type: 'trade', ...params };
    const data = await this._request('GET', '/api/v1/accounts', request, true, 1);
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
      const holds = parseFloat(item.holds || '0');
      const total = available + holds;

      if (total > 0 || available > 0) {
        balance[currency] = {
          free: available,
          used: holds,
          total,
        };
      }
    }

    return balance;
  }

  async fetchTradingFees(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.symbols = this._toKucoinSymbol(symbol);

    const data = await this._request('GET', '/api/v1/trade-fees', request, true, 1);
    const result = this._unwrapResponse(data);

    if (!result) return {};

    const fees = {};
    const list = Array.isArray(result) ? result : [];
    for (const f of list) {
      const sym = this._fromKucoinSymbol(f.symbol);
      fees[sym] = {
        symbol: sym,
        maker: safeFloat(f, 'makerFeeRate'),
        taker: safeFloat(f, 'takerFeeRate'),
        info: f,
      };
    }

    return symbol ? (fees[symbol] || fees[this._fromKucoinSymbol(symbol)] || {}) : fees;
  }

  // ===========================================================================
  // WEBSOCKET — Token-based (Public + Private)
  // ===========================================================================

  _getWsClient(url) {
    if (this._wsClients.has(url)) {
      return this._wsClients.get(url);
    }
    const client = new WsClient({
      url,
      pingInterval: 0, // Disable native ping — KuCoin uses app-level
    });
    this._wsClients.set(url, client);
    return client;
  }

  async _ensureWsConnected(url) {
    const client = this._getWsClient(url);
    if (!client.connected) {
      await client.connect();
      this._startKucoinPing(url, client);
    }
    return client;
  }

  _startKucoinPing(url, client) {
    if (this._pingTimers.has(url)) return;
    const timer = setInterval(() => {
      if (client.connected) {
        client.send({
          id: String(Date.now()),
          type: 'ping',
        });
      }
    }, 20000);
    this._pingTimers.set(url, timer);
  }

  async _getPublicWsUrl() {
    if (this._wsToken) return this._wsToken;
    const data = await this._request('POST', '/api/v1/bullet-public', {}, false, 1);
    const result = this._unwrapResponse(data);
    const server = result.instanceServers[0];
    const token = result.token;
    const connectId = String(Date.now());
    this._wsToken = server.endpoint + '?token=' + token + '&connectId=' + connectId;
    return this._wsToken;
  }

  async _getPrivateWsUrl() {
    if (this._wsPrivateToken) return this._wsPrivateToken;
    this.checkRequiredCredentials();
    const data = await this._request('POST', '/api/v1/bullet-private', {}, true, 1);
    const result = this._unwrapResponse(data);
    const server = result.instanceServers[0];
    const token = result.token;
    const connectId = String(Date.now());
    this._wsPrivateToken = server.endpoint + '?token=' + token + '&connectId=' + connectId;
    return this._wsPrivateToken;
  }

  async _subscribePublic(topic, callback) {
    const wsUrl = await this._getPublicWsUrl();
    const client = await this._ensureWsConnected(wsUrl);
    const id = String(Date.now());

    client.send({
      id,
      type: 'subscribe',
      topic,
      privateChannel: false,
      response: true,
    });

    const key = topic;
    const handler = (data) => {
      if (data && data.topic === topic && data.type === 'message') {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async _subscribePrivate(topic, callback) {
    const wsUrl = await this._getPrivateWsUrl();
    const client = await this._ensureWsConnected(wsUrl);
    const id = String(Date.now());

    client.send({
      id,
      type: 'subscribe',
      topic,
      privateChannel: true,
      response: true,
    });

    const key = topic + ':private';
    const handler = (data) => {
      if (data && data.topic === topic && data.type === 'message') {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async watchTicker(symbol, callback) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const topic = '/market/ticker:' + kcSymbol;
    return this._subscribePublic(topic, (msg) => {
      if (msg.data) {
        callback(this._parseWsTicker(msg.data, symbol));
      }
    });
  }

  async watchOrderBook(symbol, callback, depth = 5) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const topic = '/market/level2:' + kcSymbol;
    return this._subscribePublic(topic, (msg) => {
      if (msg.data) {
        callback({
          symbol,
          type: msg.subject === 'trade.l2update' ? 'update' : 'snapshot',
          changes: msg.data.changes || {},
          timestamp: safeInteger(msg.data, 'sequenceStart') || Date.now(),
          nonce: safeString(msg.data, 'sequenceEnd'),
        });
      }
    });
  }

  async watchTrades(symbol, callback) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const topic = '/market/match:' + kcSymbol;
    return this._subscribePublic(topic, (msg) => {
      if (msg.data) {
        const t = msg.data;
        // KuCoin trade time is in nanoseconds
        const ts = safeString(t, 'time')
          ? Math.floor(parseInt(t.time, 10) / 1000000)
          : Date.now();
        callback({
          id: safeString(t, 'tradeId') || safeString(t, 'sequence'),
          symbol,
          price: parseFloat(t.price),
          amount: parseFloat(t.size),
          cost: parseFloat(t.price) * parseFloat(t.size),
          side: t.side,
          timestamp: ts,
          datetime: iso8601(ts),
        });
      }
    });
  }

  async watchKlines(symbol, interval, callback) {
    const kcSymbol = this._toKucoinSymbol(symbol);
    const tf = this.timeframes[interval] || interval;
    const topic = '/market/candles:' + kcSymbol + '_' + tf;
    return this._subscribePublic(topic, (msg) => {
      if (msg.data && msg.data.candles) {
        const k = msg.data.candles;
        // [time, open, close, high, low, volume, turnover]
        const ts = parseInt(k[0], 10) * 1000;
        callback({
          symbol,
          interval: tf,
          timestamp: ts,
          open: parseFloat(k[1]),
          high: parseFloat(k[3]),
          low: parseFloat(k[4]),
          close: parseFloat(k[2]),   // close at index 2!
          volume: parseFloat(k[5]),
          closed: false,
        });
      }
    });
  }

  async watchBalance(callback) {
    this.checkRequiredCredentials();
    return this._subscribePrivate('/account/balance', (msg) => {
      if (msg.data) {
        const d = msg.data;
        const balances = {};
        balances[d.currency] = {
          free: parseFloat(d.available || '0'),
          used: parseFloat(d.hold || '0'),
          total: parseFloat(d.total || '0'),
        };
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
    return this._subscribePrivate('/spotMarket/tradeOrders', (msg) => {
      if (msg.data) {
        callback(this._parseWsOrder(msg.data));
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
    this._wsToken = null;
    this._wsPrivateToken = null;
    for (const [, timer] of this._pingTimers) {
      clearInterval(timer);
    }
    this._pingTimers.clear();
  }

  // ===========================================================================
  // PARSERS — Normalize KuCoin responses to unified format
  // ===========================================================================

  _parseTicker(data, symbol) {
    const last = safeFloat(data, 'price');
    return {
      symbol,
      last,
      high: undefined,
      low: undefined,
      open: undefined,
      close: last,
      bid: safeFloat(data, 'bestBid'),
      bidVolume: safeFloat(data, 'bestBidSize'),
      ask: safeFloat(data, 'bestAsk'),
      askVolume: safeFloat(data, 'bestAskSize'),
      volume: safeFloat(data, 'size'),
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      vwap: undefined,
      timestamp: safeInteger(data, 'time'),
      datetime: iso8601(safeInteger(data, 'time')),
      info: data,
    };
  }

  _parseAllTicker(data, symbol) {
    const last = safeFloat(data, 'last');
    const change = safeFloat(data, 'changePrice');
    const changeRate = safeFloat(data, 'changeRate');

    return {
      symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: undefined,
      close: last,
      bid: safeFloat(data, 'buy'),
      bidVolume: undefined,
      ask: safeFloat(data, 'sell'),
      askVolume: undefined,
      volume: safeFloat(data, 'vol'),
      quoteVolume: safeFloat(data, 'volValue'),
      change,
      percentage: changeRate ? changeRate * 100 : undefined,
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  _parseWsTicker(data, symbol) {
    const last = safeFloat(data, 'price');
    return {
      symbol,
      last,
      high: undefined,
      low: undefined,
      open: undefined,
      close: last,
      bid: safeFloat(data, 'bestBid'),
      bidVolume: safeFloat(data, 'bestBidSize'),
      ask: safeFloat(data, 'bestAsk'),
      askVolume: safeFloat(data, 'bestAskSize'),
      volume: safeFloat(data, 'size'),
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  _parseOrder(data) {
    const size = safeFloat(data, 'size') || 0;
    const dealSize = safeFloat(data, 'dealSize') || 0;
    const dealFunds = safeFloat(data, 'dealFunds') || 0;
    const avgPrice = dealSize > 0 ? dealFunds / dealSize : 0;
    const remaining = size - dealSize;
    const isActive = data.isActive;

    const ts = safeInteger(data, 'createdAt');

    return {
      id: safeString(data, 'id'),
      clientOrderId: safeString(data, 'clientOid'),
      symbol: this._fromKucoinSymbol(data.symbol),
      type: safeStringUpper(data, 'type'),
      side: safeStringUpper(data, 'side'),
      price: safeFloat(data, 'price') || 0,
      amount: size,
      filled: dealSize,
      remaining,
      cost: dealFunds,
      average: avgPrice,
      status: this._normalizeStatus(isActive, data.dealSize),
      timeInForce: safeString(data, 'timeInForce'),
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      trades: [],
      fee: {
        cost: safeFloat(data, 'fee'),
        currency: safeString(data, 'feeCurrency'),
      },
      info: data,
    };
  }

  _parseWsOrder(data) {
    const size = safeFloat(data, 'size') || 0;
    const filledSize = safeFloat(data, 'filledSize') || 0;
    const remaining = safeFloat(data, 'remainSize') || (size - filledSize);
    const ts = safeInteger(data, 'ts') || safeInteger(data, 'orderTime');

    return {
      id: safeString(data, 'orderId'),
      clientOrderId: safeString(data, 'clientOid'),
      symbol: this._fromKucoinSymbol(data.symbol),
      type: safeStringUpper(data, 'orderType'),
      side: safeStringUpper(data, 'side'),
      price: safeFloat(data, 'price') || 0,
      amount: size,
      filled: filledSize,
      remaining,
      cost: (safeFloat(data, 'price') || 0) * filledSize,
      average: filledSize > 0 ? (safeFloat(data, 'price') || 0) : 0,
      status: this._normalizeOrderStatus(data.status || data.type),
      event: 'order',
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      info: data,
    };
  }

  _parseOrderCreateResult(data, clientOid) {
    return {
      id: safeString(data, 'orderId'),
      clientOrderId: clientOid,
      symbol: undefined,
      status: 'NEW',
      info: data,
    };
  }

  _parseTrade(data, symbol) {
    // KuCoin trade time is in nanoseconds
    const ts = safeString(data, 'time')
      ? Math.floor(parseInt(data.time, 10) / 1000000)
      : Date.now();

    return {
      id: safeString(data, 'sequence'),
      symbol,
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'size'),
      cost: (safeFloat(data, 'price') || 0) * (safeFloat(data, 'size') || 0),
      side: safeStringLower(data, 'side'),
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseMyTrade(data) {
    const ts = safeInteger(data, 'createdAt');

    return {
      id: safeString(data, 'tradeId'),
      orderId: safeString(data, 'orderId'),
      symbol: this._fromKucoinSymbol(data.symbol),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'size'),
      cost: safeFloat(data, 'funds') || ((safeFloat(data, 'price') || 0) * (safeFloat(data, 'size') || 0)),
      fee: {
        cost: safeFloat(data, 'fee'),
        currency: safeString(data, 'feeCurrency'),
      },
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      side: safeStringLower(data, 'side'),
      isMaker: safeValue(data, 'liquidity') === 'maker',
      info: data,
    };
  }
}

module.exports = KuCoin;

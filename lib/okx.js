'use strict';

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

class Okx extends BaseExchange {

  describe() {
    return {
      id: 'okx',
      name: 'OKX',
      version: 'v5',
      rateLimit: 100,
      rateLimitCapacity: 60,
      rateLimitInterval: 2000,
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
        amendOrder: true,
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
        api: 'https://www.okx.com',
        ws: 'wss://ws.okx.com:8443/ws/v5/public',
        wsBusiness: 'wss://ws.okx.com:8443/ws/v5/business',
        wsPrivate: 'wss://ws.okx.com:8443/ws/v5/private',
        doc: 'https://www.okx.com/docs-v5/en/',
        test: {
          api: 'https://www.okx.com',
          ws: 'wss://wspap.okx.com:8443/ws/v5/public?brokerId=9999',
          wsBusiness: 'wss://wspap.okx.com:8443/ws/v5/business?brokerId=9999',
          wsPrivate: 'wss://wspap.okx.com:8443/ws/v5/private?brokerId=9999',
        },
      },
      timeframes: {
        '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
        '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H',
        '6h': '6H', '12h': '12H', '1d': '1D', '1w': '1W',
        '1M': '1M', '3M': '3M',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.0015 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this.passphrase = config.passphrase || '';
    this._defaultInstType = this.options.instType || 'SPOT';
    this._defaultTdMode = this.options.tdMode || 'cash';
    this._wsClients = new Map();
    this._wsPrivateAuthenticated = false;
    this._pingTimers = new Map();

    // OKX demo/sandbox mode uses header for REST, separate URLs for WS
    this._simulated = this.options.test || this.options.sandbox || false;

    if (this._simulated) {
      this.urls.ws = this.urls.test.ws;
      this.urls.wsBusiness = this.urls.test.wsBusiness;
      this.urls.wsPrivate = this.urls.test.wsPrivate;
    }
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA256-Base64 (OKX V5)
  // ===========================================================================

  checkRequiredCredentials() {
    super.checkRequiredCredentials();
    if (!this.passphrase) {
      throw new ExchangeError(this.id + ' passphrase required');
    }
  }

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    // OKX uses ISO 8601 timestamp for REST signing
    const timestamp = new Date().toISOString();

    // Prehash: timestamp + METHOD + requestPath + body
    // For GET/DELETE: requestPath includes query string
    // For POST: body is JSON string
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

    const headers = {
      'OK-ACCESS-KEY': this.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
    };

    if (this._simulated) {
      headers['x-simulated-trading'] = '1';
    }

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE ENVELOPE — OKX wraps everything in { code, msg, data }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && 'code' in data) {
      if (data.code !== '0') {
        this._handleOkxError(data.code, data.msg || '');
      }
      return data.data;
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    const limit = headers.get('x-ratelimit-limit');

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

    const code = parsed?.code;
    const msg = parsed?.msg || body;

    if (code && code !== '0') {
      this._handleOkxError(code, msg);
    }

    const full = this.id + ' HTTP ' + status + ': ' + msg;
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    throw new ExchangeError(full);
  }

  _handleOkxError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;

    const errorMap = {
      // Authentication
      '50102': AuthenticationError,
      '50103': AuthenticationError,
      '50104': AuthenticationError,
      '50105': AuthenticationError,
      '50110': AuthenticationError,

      // Rate limiting
      '50011': RateLimitExceeded,
      '50013': RateLimitExceeded,

      // Bad request
      '50000': BadRequest,
      '50014': BadRequest,

      // Exchange not available
      '50001': ExchangeNotAvailable,
      '50004': ExchangeNotAvailable,

      // Insufficient funds
      '51001': InsufficientFunds,
      '51003': InsufficientFunds,
      '51008': InsufficientFunds,

      // Order size / invalid
      '51002': InvalidOrder,
      '51400': InvalidOrder,
      '51500': InvalidOrder,
      '51503': InvalidOrder,
      '51509': InvalidOrder,

      // Order not found
      '51006': OrderNotFound,
      '51020': OrderNotFound,
      '51501': OrderNotFound,
    };

    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  _normalizeStatus(status) {
    const map = {
      'live': 'NEW',
      'partially_filled': 'PARTIALLY_FILLED',
      'filled': 'FILLED',
      'canceled': 'CANCELED',
      'mmp_canceled': 'CANCELED',
    };
    return map[status] || (status ? status.toUpperCase() : status);
  }

  _countDecimals(str) {
    if (!str) return 8;
    const parts = str.split('.');
    return parts.length > 1 ? parts[1].length : 0;
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    const data = await this._request('GET', '/api/v5/public/time', {}, false, 1);
    const result = this._unwrapResponse(data);
    return parseInt(result[0].ts, 10);
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (7 endpoints)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v5/public/instruments', {
      instType: this._defaultInstType,
    }, false, 1);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const inst of (result || [])) {
      const instId = inst.instId;
      const base = inst.baseCcy || '';
      const quote = inst.quoteCcy || '';
      const state = inst.state;

      const market = {
        id: instId,
        symbol: instId,
        base,
        quote,
        status: state,
        active: state === 'live',
        precision: {
          price: this._countDecimals(inst.tickSz || '0.01'),
          amount: this._countDecimals(inst.lotSz || '0.00000001'),
          base: this._countDecimals(inst.lotSz || '0.00000001'),
          quote: this._countDecimals(inst.tickSz || '0.01'),
        },
        limits: {
          price: {
            min: safeFloat(inst, 'tickSz'),
            max: undefined,
          },
          amount: {
            min: safeFloat(inst, 'minSz'),
            max: safeFloat(inst, 'maxLmtSz') || undefined,
          },
          cost: {
            min: undefined,
            max: undefined,
          },
        },
        stepSize: safeFloat(inst, 'lotSz'),
        tickSize: safeFloat(inst, 'tickSz'),
        instType: inst.instType,
        info: inst,
      };

      this.markets[instId] = market;
      this.marketsById[instId] = market;
      this.symbols.push(instId);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol, params = {}) {
    const data = await this._request('GET', '/api/v5/market/ticker', {
      instId: symbol,
      ...params,
    }, false, 1);
    const result = this._unwrapResponse(data);
    if (!result || result.length === 0) {
      throw new BadSymbol(this.id + ' symbol not found: ' + symbol);
    }
    return this._parseTicker(result[0]);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    const data = await this._request('GET', '/api/v5/market/tickers', {
      instType: params.instType || this._defaultInstType,
      ...params,
    }, false, 1);
    const result = this._unwrapResponse(data);
    const tickers = {};
    for (const t of (result || [])) {
      const ticker = this._parseTicker(t);
      if (!symbols || symbols.includes(ticker.symbol)) {
        tickers[ticker.symbol] = ticker;
      }
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = 20, params = {}) {
    const request = { instId: symbol, ...params };
    if (limit) request.sz = String(limit);

    const data = await this._request('GET', '/api/v5/market/books', request, false, 1);
    const result = this._unwrapResponse(data);

    if (!result || result.length === 0) {
      throw new BadSymbol(this.id + ' no order book data for: ' + symbol);
    }

    const book = result[0];
    return {
      symbol,
      bids: (book.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: (book.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: safeInteger(book, 'ts'),
      datetime: iso8601(safeInteger(book, 'ts')),
      nonce: undefined,
    };
  }

  async fetchTrades(symbol, since = undefined, limit = 100, params = {}) {
    const request = { instId: symbol, ...params };
    if (limit) request.limit = String(limit);

    const data = await this._request('GET', '/api/v5/market/trades', request, false, 1);
    const result = this._unwrapResponse(data);
    return (result || []).map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = 100, params = {}) {
    const bar = this.timeframes[timeframe] || timeframe;
    const request = {
      instId: symbol,
      bar,
      limit: String(limit),
      ...params,
    };
    if (since) request.after = String(since);

    const data = await this._request('GET', '/api/v5/market/candles', request, false, 1);
    const result = this._unwrapResponse(data);

    // OKX returns newest first — reverse for chronological order
    const list = (result || []).reverse();
    return list.map((k) => ([
      parseInt(k[0], 10),    // timestamp
      parseFloat(k[1]),      // open
      parseFloat(k[2]),      // high
      parseFloat(k[3]),      // low
      parseFloat(k[4]),      // close
      parseFloat(k[5]),      // volume
    ]));
  }

  // ===========================================================================
  // TRADING — PRIVATE (8 endpoints)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      instId: symbol,
      tdMode: params.tdMode || this._defaultTdMode,
      side: side.toLowerCase(),
      ordType: type.toLowerCase(),
      sz: String(amount),
    };

    if (price !== undefined && price !== null) {
      request.px = String(price);
    }

    if (params.clientOrderId) {
      request.clOrdId = params.clientOrderId;
    }

    // Spread remaining params (excluding internal ones)
    const skip = new Set(['tdMode', 'clientOrderId']);
    for (const [k, v] of Object.entries(params)) {
      if (!skip.has(k) && !(k in request)) {
        request[k] = v;
      }
    }

    const data = await this._request('POST', '/api/v5/trade/order', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderCreateResult(result[0]);
  }

  async amendOrder(id, symbol, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      instId: symbol,
      ordId: id,
      ...params,
    };
    const data = await this._request('POST', '/api/v5/trade/amend-order', request, true, 1);
    const result = this._unwrapResponse(data);
    return result[0];
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder() requires symbol (instId)');
    const request = {
      instId: symbol,
      ordId: id,
      ...params,
    };
    const data = await this._request('POST', '/api/v5/trade/cancel-order', request, true, 1);
    const result = this._unwrapResponse(data);
    return {
      id: result[0].ordId,
      symbol,
      status: 'CANCELED',
      info: result[0],
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    // OKX cancel-batch-orders requires specific {instId, ordId} pairs
    const pending = await this.fetchOpenOrders(symbol);
    if (pending.length === 0) return [];

    const cancelRequests = pending.map((o) => ({
      instId: o.symbol,
      ordId: o.id,
    }));
    const data = await this._request('POST', '/api/v5/trade/cancel-batch-orders', cancelRequests, true, 1);
    return this._unwrapResponse(data);
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder() requires symbol (instId)');
    const request = {
      instId: symbol,
      ordId: id,
      ...params,
    };
    const data = await this._request('GET', '/api/v5/trade/order', request, true, 1);
    const result = this._unwrapResponse(data);
    if (!result || result.length === 0) {
      throw new OrderNotFound(this.id + ' order not found: ' + id);
    }
    return this._parseOrder(result[0]);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = 100, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.instId = symbol;
    if (limit) request.limit = String(limit);

    const data = await this._request('GET', '/api/v5/trade/orders-pending', request, true, 1);
    const result = this._unwrapResponse(data);
    return (result || []).map((o) => this._parseOrder(o));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = 100, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      instType: params.instType || this._defaultInstType,
      ...params,
    };
    if (symbol) request.instId = symbol;
    if (since) request.begin = String(since);
    if (limit) request.limit = String(limit);

    const data = await this._request('GET', '/api/v5/trade/orders-history-archive', request, true, 1);
    const result = this._unwrapResponse(data);
    return (result || []).map((o) => this._parseOrder(o));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = 100, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      instType: params.instType || this._defaultInstType,
      ...params,
    };
    if (symbol) request.instId = symbol;
    if (since) request.begin = String(since);
    if (limit) request.limit = String(limit);

    const data = await this._request('GET', '/api/v5/trade/fills-history', request, true, 1);
    const result = this._unwrapResponse(data);
    return (result || []).map((t) => this._parseMyTrade(t));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('GET', '/api/v5/account/balance', params, true, 1);
    const result = this._unwrapResponse(data);

    const balance = {
      info: result,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    if (result && result.length > 0) {
      const details = result[0].details || [];
      for (const d of details) {
        const currency = d.ccy;
        const free = parseFloat(d.availBal || d.availEq || '0');
        const frozen = parseFloat(d.frozenBal || '0');
        const total = parseFloat(d.eq || d.cashBal || '0') || (free + frozen);

        if (total > 0 || free > 0) {
          balance[currency] = {
            free,
            used: frozen,
            total,
          };
        }
      }
    }

    return balance;
  }

  async fetchTradingFees(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      instType: params.instType || this._defaultInstType,
      ...params,
    };
    if (symbol) request.instId = symbol;

    const data = await this._request('GET', '/api/v5/account/trade-fee', request, true, 1);
    const result = this._unwrapResponse(data);

    if (!result || result.length === 0) return {};

    const fees = {};
    for (const f of result) {
      const key = f.instId || f.instType || 'default';
      fees[key] = {
        symbol: f.instId,
        maker: parseFloat(f.maker || '0'),
        taker: parseFloat(f.taker || '0'),
      };
    }
    return symbol ? fees[symbol] : fees;
  }

  // ===========================================================================
  // WEBSOCKET STREAMS — Public (4) + Private (2)
  // ===========================================================================

  _getWsClient(url = undefined) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }
    const client = new WsClient({
      url: wsUrl,
      pingInterval: 0, // Disable native ping — OKX uses app-level
    });
    this._wsClients.set(wsUrl, client);
    return client;
  }

  async _ensureWsConnected(url = undefined) {
    const wsUrl = url || this.urls.ws;
    const client = this._getWsClient(wsUrl);
    if (!client.connected) {
      await client.connect();
      this._startOkxPing(wsUrl, client);
    }
    return client;
  }

  _startOkxPing(wsUrl, client) {
    if (this._pingTimers.has(wsUrl)) return;
    const timer = setInterval(() => {
      if (client.connected) {
        client.send('ping');
      }
    }, 25000);
    this._pingTimers.set(wsUrl, timer);
  }

  async _subscribeStream(channel, args, callback, wsUrl = undefined) {
    const client = await this._ensureWsConnected(wsUrl);

    client.send({
      op: 'subscribe',
      args: [args],
    });

    const key = JSON.stringify(args);

    const handler = (data) => {
      if (data === 'pong') return;
      if (data && data.arg && data.arg.channel === channel) {
        if (args.instId && data.arg.instId !== args.instId) return;
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async _unsubscribeStream(args, wsUrl = undefined) {
    const client = this._getWsClient(wsUrl);
    const key = JSON.stringify(args);

    if (client.connected) {
      client.send({
        op: 'unsubscribe',
        args: [args],
      });
    }

    const entry = this._wsHandlers.get(key);
    if (entry) {
      client.removeListener('message', entry.handler);
      this._wsHandlers.delete(key);
    }
  }

  async watchTicker(symbol, callback) {
    const args = { channel: 'tickers', instId: symbol };
    return this._subscribeStream('tickers', args, (msg) => {
      if (msg.data) {
        for (const t of msg.data) {
          callback(this._parseTicker(t));
        }
      }
    });
  }

  async watchOrderBook(symbol, callback, depth = 5) {
    const channel = depth <= 5 ? 'books5' : 'books';
    const args = { channel, instId: symbol };
    return this._subscribeStream(channel, args, (msg) => {
      if (msg.data) {
        for (const d of msg.data) {
          callback({
            symbol,
            type: msg.action || 'snapshot',
            bids: (d.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
            asks: (d.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
            timestamp: safeInteger(d, 'ts'),
            nonce: undefined,
          });
        }
      }
    });
  }

  async watchTrades(symbol, callback) {
    const args = { channel: 'trades', instId: symbol };
    return this._subscribeStream('trades', args, (msg) => {
      if (msg.data) {
        for (const t of msg.data) {
          callback({
            id: t.tradeId,
            symbol: t.instId,
            price: parseFloat(t.px),
            amount: parseFloat(t.sz),
            cost: parseFloat(t.px) * parseFloat(t.sz),
            side: t.side,
            timestamp: parseInt(t.ts, 10),
            datetime: iso8601(parseInt(t.ts, 10)),
          });
        }
      }
    });
  }

  async watchKlines(symbol, interval, callback) {
    const bar = this.timeframes[interval] || interval;
    const channel = 'candle' + bar;
    const args = { channel, instId: symbol };
    return this._subscribeStream(channel, args, (msg) => {
      if (msg.data) {
        for (const k of msg.data) {
          callback({
            symbol,
            interval: bar,
            timestamp: parseInt(k[0], 10),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closed: k[8] === '1',
          });
        }
      }
    }, this.urls.wsBusiness);
  }

  async _authenticateWsPrivate() {
    if (this._wsPrivateAuthenticated) return;

    const client = await this._ensureWsConnected(this.urls.wsPrivate);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signStr = timestamp + 'GET' + '/users/self/verify';
    const sign = hmacSHA256Base64(signStr, this.secret);

    client.send({
      op: 'login',
      args: [{
        apiKey: this.apiKey,
        passphrase: this.passphrase,
        timestamp,
        sign,
      }],
    });

    await sleep(500);
    this._wsPrivateAuthenticated = true;
  }

  async watchOrders(callback) {
    this.checkRequiredCredentials();
    await this._authenticateWsPrivate();

    const args = { channel: 'orders', instType: this._defaultInstType };
    return this._subscribeStream('orders', args, (msg) => {
      if (msg.data) {
        for (const o of msg.data) {
          const order = this._parseOrder(o);
          order.event = 'order';
          callback(order);
        }
      }
    }, this.urls.wsPrivate);
  }

  async watchBalance(callback) {
    this.checkRequiredCredentials();
    await this._authenticateWsPrivate();

    const args = { channel: 'account' };
    return this._subscribeStream('account', args, (msg) => {
      if (msg.data) {
        for (const account of msg.data) {
          const balances = {};
          for (const d of (account.details || [])) {
            balances[d.ccy] = {
              free: parseFloat(d.availBal || d.availEq || '0'),
              used: parseFloat(d.frozenBal || '0'),
              total: parseFloat(d.eq || d.cashBal || '0'),
            };
          }
          callback({
            event: 'balance',
            timestamp: safeInteger(account, 'uTime'),
            balances,
          });
        }
      }
    }, this.urls.wsPrivate);
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
  // PARSERS — Normalize OKX responses to unified format
  // ===========================================================================

  _parseTicker(data) {
    const last = safeFloat(data, 'last');
    const open = safeFloat(data, 'open24h') || safeFloat(data, 'sodUtc0');
    const change = (last && open) ? last - open : undefined;
    const percentage = (change && open) ? (change / open) * 100 : undefined;

    return {
      symbol: safeString(data, 'instId'),
      last,
      high: safeFloat(data, 'high24h'),
      low: safeFloat(data, 'low24h'),
      open,
      close: last,
      bid: safeFloat(data, 'bidPx'),
      bidVolume: safeFloat(data, 'bidSz'),
      ask: safeFloat(data, 'askPx'),
      askVolume: safeFloat(data, 'askSz'),
      volume: safeFloat(data, 'vol24h'),
      quoteVolume: safeFloat(data, 'volCcy24h'),
      change,
      percentage,
      vwap: undefined,
      timestamp: safeInteger(data, 'ts'),
      datetime: iso8601(safeInteger(data, 'ts')),
      info: data,
    };
  }

  _parseOrder(data) {
    const filled = safeFloat(data, 'accFillSz') || 0;
    const amount = safeFloat(data, 'sz') || 0;
    const avgPx = safeFloat(data, 'avgPx') || 0;
    const cost = filled * avgPx;
    const rawStatus = safeString(data, 'state');

    return {
      id: safeString(data, 'ordId'),
      clientOrderId: safeString(data, 'clOrdId'),
      symbol: safeString(data, 'instId'),
      type: safeStringUpper(data, 'ordType'),
      side: safeStringUpper(data, 'side'),
      price: safeFloat(data, 'px') || 0,
      amount,
      filled,
      remaining: amount - filled,
      cost,
      average: avgPx,
      status: this._normalizeStatus(rawStatus),
      timeInForce: undefined,
      timestamp: safeInteger(data, 'cTime'),
      datetime: iso8601(safeInteger(data, 'cTime')),
      trades: [],
      fee: {
        cost: safeFloat(data, 'fee'),
        currency: safeString(data, 'feeCcy'),
      },
      info: data,
    };
  }

  _parseOrderCreateResult(data) {
    return {
      id: safeString(data, 'ordId'),
      clientOrderId: safeString(data, 'clOrdId'),
      symbol: undefined,
      status: 'NEW',
      info: data,
    };
  }

  _parseTrade(data, symbol) {
    const ts = safeInteger(data, 'ts');
    return {
      id: safeString(data, 'tradeId'),
      symbol: symbol || safeString(data, 'instId'),
      price: safeFloat(data, 'px'),
      amount: safeFloat(data, 'sz'),
      cost: (safeFloat(data, 'px') || 0) * (safeFloat(data, 'sz') || 0),
      side: safeStringLower(data, 'side'),
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseMyTrade(data) {
    const ts = safeInteger(data, 'ts');
    return {
      id: safeString(data, 'tradeId'),
      orderId: safeString(data, 'ordId'),
      symbol: safeString(data, 'instId'),
      price: safeFloat(data, 'fillPx'),
      amount: safeFloat(data, 'fillSz'),
      cost: (safeFloat(data, 'fillPx') || 0) * (safeFloat(data, 'fillSz') || 0),
      fee: {
        cost: safeFloat(data, 'fee'),
        currency: safeString(data, 'feeCcy'),
      },
      timestamp: ts,
      datetime: iso8601(ts),
      side: safeStringLower(data, 'side'),
      isMaker: safeString(data, 'execType') === 'M',
      info: data,
    };
  }
}

module.exports = Okx;

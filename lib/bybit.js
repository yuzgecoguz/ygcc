'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeFloat2, safeString2,
  iso8601, sleep,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Bybit extends BaseExchange {

  describe() {
    return {
      id: 'bybit',
      name: 'Bybit',
      version: 'v5',
      rateLimit: 100,
      rateLimitCapacity: 120,
      rateLimitInterval: 60000,
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
        api: 'https://api.bybit.com',
        ws: 'wss://stream.bybit.com/v5/public/spot',
        wsLinear: 'wss://stream.bybit.com/v5/public/linear',
        wsPrivate: 'wss://stream.bybit.com/v5/private',
        doc: 'https://bybit-exchange.github.io/docs/v5/intro',
        test: {
          api: 'https://api-testnet.bybit.com',
          ws: 'wss://stream-testnet.bybit.com/v5/public/spot',
          wsPrivate: 'wss://stream-testnet.bybit.com/v5/private',
        },
      },
      timeframes: {
        '1m': '1', '3m': '3', '5m': '5', '15m': '15',
        '30m': '30', '1h': '60', '2h': '120', '4h': '240',
        '6h': '360', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true; // Bybit V5 sends JSON body for POST
    this._recvWindow = this.options.recvWindow || 5000;
    this._defaultCategory = this.options.category || 'spot';
    this._accountType = this.options.accountType || 'UNIFIED';
    this._wsClients = new Map();
    this._wsPrivateAuthenticated = false;
    this._pingTimers = new Map();

    // Use testnet if configured
    if (this.options.test || this.options.sandbox) {
      this.urls.api = this.urls.test.api;
      this.urls.ws = this.urls.test.ws;
      this.urls.wsPrivate = this.urls.test.wsPrivate;
    }
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA256 (Bybit V5)
  // ===========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();
    const timestamp = String(Date.now());
    const recvWindow = String(this._recvWindow);

    // Payload: query string for GET, JSON body for POST
    let payload;
    if (method === 'GET') {
      payload = new URLSearchParams(params).toString();
    } else {
      payload = JSON.stringify(params);
    }

    // Bybit sign string: timestamp + apiKey + recvWindow + payload
    const signStr = timestamp + this.apiKey + recvWindow + payload;
    const signature = hmacSHA256(signStr, this.secret);

    return {
      params, // Params unchanged — signature goes in headers only
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE ENVELOPE — Bybit wraps everything in { retCode, retMsg, result }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && 'retCode' in data) {
      if (data.retCode !== 0) {
        this._handleBybitError(data.retCode, data.retMsg);
      }
      return data.result;
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    const limit = headers.get('x-bapi-limit');
    const remaining = headers.get('x-bapi-limit-status');
    const resetTs = headers.get('x-bapi-limit-reset-timestamp');

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
          resetTimestamp: resetTs ? parseInt(resetTs, 10) : undefined,
        });
      }
    }
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const retCode = parsed?.retCode;
    const msg = parsed?.retMsg || body;

    if (retCode) {
      this._handleBybitError(retCode, msg);
    }

    const full = this.id + ' HTTP ' + status + ': ' + msg;
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    throw new ExchangeError(full);
  }

  _handleBybitError(retCode, retMsg) {
    const full = this.id + ' ' + retCode + ': ' + retMsg;

    const errorMap = {
      // Authentication
      10003: AuthenticationError,
      10004: AuthenticationError,
      10005: AuthenticationError,
      10007: AuthenticationError,
      10009: AuthenticationError,
      10010: AuthenticationError,

      // Rate limiting
      10006: RateLimitExceeded,
      10018: RateLimitExceeded,
      170005: RateLimitExceeded,

      // Bad Request
      10001: BadRequest,
      10002: BadRequest,

      // Exchange not available
      10000: ExchangeNotAvailable,

      // Order errors
      110001: OrderNotFound,
      170143: OrderNotFound,
      110010: OrderNotFound,
      110003: InvalidOrder,
      110017: InvalidOrder,
      110020: InvalidOrder,
      110032: InvalidOrder,
      110072: InvalidOrder,
      170116: InvalidOrder,
      170117: InvalidOrder,
      170115: InvalidOrder,
      170140: InvalidOrder,
      170141: InvalidOrder,
      170210: InvalidOrder,

      // Balance errors
      110004: InsufficientFunds,
      110007: InsufficientFunds,
      110012: InsufficientFunds,
      170131: InsufficientFunds,
      170033: InsufficientFunds,

      // Symbol errors
      170121: BadSymbol,
      170151: BadSymbol,
      10029: BadSymbol,
    };

    const ErrorClass = errorMap[retCode] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPER — Category + Title case conversion
  // ===========================================================================

  _toTitleCase(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }

  _normalizeStatus(status) {
    const map = {
      'New': 'NEW',
      'PartiallyFilled': 'PARTIALLY_FILLED',
      'Untriggered': 'NEW',
      'Deactivated': 'CANCELED',
      'Triggered': 'NEW',
      'Active': 'NEW',
      'Filled': 'FILLED',
      'Cancelled': 'CANCELED',
      'Rejected': 'REJECTED',
    };
    return map[status] || status;
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  /** Get server time */
  async fetchTime() {
    const data = await this._request('GET', '/v5/market/time', {}, false, 1);
    const result = this._unwrapResponse(data);
    return parseInt(result.timeSecond, 10) * 1000;
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (7 endpoints)
  // ===========================================================================

  /**
   * Load exchange info: symbols, filters, trading rules.
   */
  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/v5/market/instruments-info', {
      category: this._defaultCategory,
    }, false, 1);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const s of (result.list || [])) {
      const symbol = s.symbol;
      const base = s.baseCoin;
      const quote = s.quoteCoin;
      const status = s.status;

      const lotFilter = s.lotSizeFilter || {};
      const priceFilter = s.priceFilter || {};

      const market = {
        id: symbol,
        symbol,
        base,
        quote,
        status,
        active: status === 'Trading',
        precision: {
          base: this._countDecimals(lotFilter.basePrecision || '0.00000001'),
          quote: this._countDecimals(priceFilter.tickSize || '0.01'),
          price: this._countDecimals(priceFilter.tickSize || '0.01'),
          amount: this._countDecimals(lotFilter.basePrecision || '0.00000001'),
        },
        limits: {
          price: {
            min: safeFloat(priceFilter, 'minPrice') || undefined,
            max: safeFloat(priceFilter, 'maxPrice') || undefined,
          },
          amount: {
            min: safeFloat(lotFilter, 'minOrderQty'),
            max: safeFloat(lotFilter, 'maxOrderQty'),
          },
          cost: {
            min: safeFloat(lotFilter, 'minOrderAmt') || undefined,
            max: safeFloat(lotFilter, 'maxOrderAmt') || undefined,
          },
        },
        stepSize: safeFloat(lotFilter, 'basePrecision'),
        tickSize: safeFloat(priceFilter, 'tickSize'),
        info: s,
      };

      this.markets[symbol] = market;
      this.marketsById[symbol] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  _countDecimals(str) {
    if (!str) return 8;
    const parts = str.split('.');
    return parts.length > 1 ? parts[1].length : 0;
  }

  /**
   * Fetch 24hr ticker. GET /v5/market/tickers
   */
  async fetchTicker(symbol, params = {}) {
    const data = await this._request('GET', '/v5/market/tickers', {
      category: this._defaultCategory,
      symbol: symbol.toUpperCase(),
      ...params,
    }, false, 1);
    const result = this._unwrapResponse(data);
    const list = result.list || [];
    if (list.length === 0) throw new BadSymbol(this.id + ' symbol not found: ' + symbol);
    return this._parseTicker(list[0]);
  }

  /**
   * Fetch all tickers. GET /v5/market/tickers
   */
  async fetchTickers(symbols = undefined, params = {}) {
    const data = await this._request('GET', '/v5/market/tickers', {
      category: this._defaultCategory,
      ...params,
    }, false, 1);
    const result = this._unwrapResponse(data);
    const tickers = {};
    for (const t of (result.list || [])) {
      const ticker = this._parseTicker(t);
      if (!symbols || symbols.includes(ticker.symbol)) {
        tickers[ticker.symbol] = ticker;
      }
    }
    return tickers;
  }

  /**
   * Fetch order book. GET /v5/market/orderbook
   * Limits for spot: 1, 50, 200
   */
  async fetchOrderBook(symbol, limit = 50, params = {}) {
    const data = await this._request('GET', '/v5/market/orderbook', {
      category: this._defaultCategory,
      symbol: symbol.toUpperCase(),
      limit,
      ...params,
    }, false, 1);
    const result = this._unwrapResponse(data);

    return {
      symbol,
      bids: (result.b || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: (result.a || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: safeInteger(result, 'ts'),
      datetime: iso8601(safeInteger(result, 'ts')),
      nonce: safeInteger(result, 'u'),
    };
  }

  /**
   * Fetch recent trades. GET /v5/market/recent-trade
   */
  async fetchTrades(symbol, since = undefined, limit = 60, params = {}) {
    const data = await this._request('GET', '/v5/market/recent-trade', {
      category: this._defaultCategory,
      symbol: symbol.toUpperCase(),
      limit,
      ...params,
    }, false, 1);
    const result = this._unwrapResponse(data);
    return (result.list || []).map((t) => this._parseTrade(t, symbol));
  }

  /**
   * Fetch OHLCV / klines. GET /v5/market/kline
   */
  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = 200, params = {}) {
    const interval = this.timeframes[timeframe] || timeframe;
    const request = {
      category: this._defaultCategory,
      symbol: symbol.toUpperCase(),
      interval,
      limit,
      ...params,
    };
    if (since) request.start = since;

    const data = await this._request('GET', '/v5/market/kline', request, false, 1);
    const result = this._unwrapResponse(data);

    // Bybit returns newest first — reverse for chronological order
    const list = (result.list || []).reverse();
    return list.map((k) => ([
      parseInt(k[0], 10),   // timestamp
      parseFloat(k[1]),     // open
      parseFloat(k[2]),     // high
      parseFloat(k[3]),     // low
      parseFloat(k[4]),     // close
      parseFloat(k[5]),     // volume
    ]));
  }

  // ===========================================================================
  // TRADING — PRIVATE (8 endpoints)
  // ===========================================================================

  /**
   * Create a new order. POST /v5/order/create
   * Bybit uses Title case: side="Buy"/"Sell", orderType="Limit"/"Market"
   */
  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: params.category || this._defaultCategory,
      symbol: symbol.toUpperCase(),
      side: this._toTitleCase(side),
      orderType: this._toTitleCase(type),
      qty: String(amount),
      ...params,
    };
    // Remove our internal params
    delete request.category; // Already set above
    request.category = params.category || this._defaultCategory;

    if (price !== undefined && price !== null) {
      request.price = String(price);
    }

    // TimeInForce default for Limit orders
    if (request.orderType === 'Limit' && !request.timeInForce) {
      request.timeInForce = 'GTC';
    }

    const data = await this._request('POST', '/v5/order/create', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderCreateResult(result);
  }

  /**
   * Amend (modify) an order. POST /v5/order/amend
   */
  async amendOrder(id, symbol, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: this._defaultCategory,
      symbol: symbol.toUpperCase(),
      orderId: id,
      ...params,
    };
    const data = await this._request('POST', '/v5/order/amend', request, true, 1);
    return this._unwrapResponse(data);
  }

  /**
   * Cancel an order. POST /v5/order/cancel (NOTE: POST, not DELETE)
   */
  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder() requires symbol');
    const request = {
      category: this._defaultCategory,
      symbol: symbol.toUpperCase(),
      orderId: id,
      ...params,
    };
    const data = await this._request('POST', '/v5/order/cancel', request, true, 1);
    const result = this._unwrapResponse(data);
    return {
      id: result.orderId,
      symbol: symbol.toUpperCase(),
      status: 'CANCELED',
      info: result,
    };
  }

  /**
   * Cancel all orders. POST /v5/order/cancel-all
   */
  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: this._defaultCategory,
      ...params,
    };
    if (symbol) request.symbol = symbol.toUpperCase();
    const data = await this._request('POST', '/v5/order/cancel-all', request, true, 1);
    const result = this._unwrapResponse(data);
    return result;
  }

  /**
   * Fetch single order. GET /v5/order/realtime
   */
  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: this._defaultCategory,
      orderId: id,
      ...params,
    };
    if (symbol) request.symbol = symbol.toUpperCase();
    const data = await this._request('GET', '/v5/order/realtime', request, true, 1);
    const result = this._unwrapResponse(data);
    const list = result.list || [];
    if (list.length === 0) throw new OrderNotFound(this.id + ' order not found: ' + id);
    return this._parseOrder(list[0]);
  }

  /**
   * Fetch open orders. GET /v5/order/realtime
   */
  async fetchOpenOrders(symbol = undefined, since = undefined, limit = 50, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: this._defaultCategory,
      limit,
      ...params,
    };
    if (symbol) request.symbol = symbol.toUpperCase();
    const data = await this._request('GET', '/v5/order/realtime', request, true, 1);
    const result = this._unwrapResponse(data);
    return (result.list || []).map((o) => this._parseOrder(o));
  }

  /**
   * Fetch closed orders (history). GET /v5/order/history
   */
  async fetchClosedOrders(symbol = undefined, since = undefined, limit = 50, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: this._defaultCategory,
      limit,
      ...params,
    };
    if (symbol) request.symbol = symbol.toUpperCase();
    if (since) request.startTime = since;
    const data = await this._request('GET', '/v5/order/history', request, true, 1);
    const result = this._unwrapResponse(data);
    return (result.list || []).map((o) => this._parseOrder(o));
  }

  /**
   * Fetch user trade history. GET /v5/execution/list
   */
  async fetchMyTrades(symbol = undefined, since = undefined, limit = 50, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: this._defaultCategory,
      limit,
      ...params,
    };
    if (symbol) request.symbol = symbol.toUpperCase();
    if (since) request.startTime = since;
    const data = await this._request('GET', '/v5/execution/list', request, true, 1);
    const result = this._unwrapResponse(data);
    return (result.list || []).map((t) => this._parseMyTrade(t));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  /**
   * Fetch account balances. GET /v5/account/wallet-balance
   */
  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('GET', '/v5/account/wallet-balance', {
      accountType: this._accountType,
      ...params,
    }, true, 1);
    const result = this._unwrapResponse(data);

    const balance = {
      info: result,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    // Bybit nests coins inside result.list[0].coin[]
    const accounts = result.list || [];
    for (const account of accounts) {
      for (const coin of (account.coin || [])) {
        const free = parseFloat(coin.availableToWithdraw || coin.free || '0');
        const locked = parseFloat(coin.locked || '0');
        const total = parseFloat(coin.walletBalance || coin.equity || '0');
        if (total > 0 || free > 0) {
          balance[coin.coin] = {
            free,
            used: total - free > 0 ? total - free : locked,
            total,
          };
        }
      }
    }
    return balance;
  }

  /**
   * Fetch trading fee rates. GET /v5/account/fee-rate
   */
  async fetchTradingFees(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      category: this._defaultCategory,
      ...params,
    };
    if (symbol) request.symbol = symbol.toUpperCase();
    const data = await this._request('GET', '/v5/account/fee-rate', request, true, 1);
    const result = this._unwrapResponse(data);
    const list = result.list || [];
    if (list.length === 0) return {};

    const fees = {};
    for (const f of list) {
      fees[f.symbol] = {
        symbol: f.symbol,
        maker: parseFloat(f.makerFeeRate || '0'),
        taker: parseFloat(f.takerFeeRate || '0'),
      };
    }
    return symbol ? fees[symbol.toUpperCase()] : fees;
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
      pingInterval: 0, // Disable WsClient's native ping — Bybit uses app-level
    });
    this._wsClients.set(wsUrl, client);
    return client;
  }

  async _ensureWsConnected(url = undefined) {
    const wsUrl = url || this.urls.ws;
    const client = this._getWsClient(wsUrl);
    if (!client.connected) {
      await client.connect();
      this._startBybitPing(wsUrl, client);
    }
    return client;
  }

  /** Bybit app-level ping every 20s */
  _startBybitPing(wsUrl, client) {
    if (this._pingTimers.has(wsUrl)) return;
    const timer = setInterval(() => {
      if (client.connected) {
        client.send({ op: 'pong' });
      }
    }, 20000);
    this._pingTimers.set(wsUrl, timer);
  }

  async _subscribeStream(topic, callback, wsUrl = undefined) {
    const client = await this._ensureWsConnected(wsUrl);

    // Subscribe
    client.send({
      op: 'subscribe',
      args: [topic],
    });

    // Handle messages for this topic
    const handler = (data) => {
      // Respond to server ping
      if (data && data.op === 'ping') {
        client.send({ op: 'pong' });
        return;
      }
      // Match topic
      if (data && data.topic === topic) {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(topic, { handler, callback });
    return topic;
  }

  async _unsubscribeStream(topic, wsUrl = undefined) {
    const client = this._getWsClient(wsUrl);
    if (client.connected) {
      client.send({
        op: 'unsubscribe',
        args: [topic],
      });
    }
    const entry = this._wsHandlers.get(topic);
    if (entry) {
      client.removeListener('message', entry.handler);
      this._wsHandlers.delete(topic);
    }
  }

  /** Watch ticker. Topic: tickers.{SYMBOL} */
  async watchTicker(symbol, callback) {
    const topic = `tickers.${symbol.toUpperCase()}`;
    return this._subscribeStream(topic, (msg) => {
      callback(this._parseWsTicker(msg.data));
    });
  }

  /** Watch order book. Topic: orderbook.{depth}.{SYMBOL} */
  async watchOrderBook(symbol, callback, depth = 50) {
    const topic = `orderbook.${depth}.${symbol.toUpperCase()}`;
    return this._subscribeStream(topic, (msg) => {
      callback({
        symbol,
        type: msg.type, // 'snapshot' or 'delta'
        bids: (msg.data.b || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        asks: (msg.data.a || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        timestamp: safeInteger(msg, 'ts'),
        nonce: safeInteger(msg.data, 'u'),
      });
    });
  }

  /** Watch trades. Topic: publicTrade.{SYMBOL} */
  async watchTrades(symbol, callback) {
    const topic = `publicTrade.${symbol.toUpperCase()}`;
    return this._subscribeStream(topic, (msg) => {
      for (const t of (msg.data || [])) {
        callback({
          id: t.i,
          symbol: t.s,
          price: parseFloat(t.p),
          amount: parseFloat(t.v),
          cost: parseFloat(t.p) * parseFloat(t.v),
          side: t.S === 'Buy' ? 'buy' : 'sell',
          timestamp: parseInt(t.T, 10),
          datetime: iso8601(parseInt(t.T, 10)),
        });
      }
    });
  }

  /** Watch klines. Topic: kline.{interval}.{SYMBOL} */
  async watchKlines(symbol, interval, callback) {
    const tf = this.timeframes[interval] || interval;
    const topic = `kline.${tf}.${symbol.toUpperCase()}`;
    return this._subscribeStream(topic, (msg) => {
      for (const k of (msg.data || [])) {
        callback({
          symbol: symbol.toUpperCase(),
          interval: k.interval,
          timestamp: parseInt(k.start, 10),
          open: parseFloat(k.open),
          high: parseFloat(k.high),
          low: parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.volume),
          closed: k.confirm,
        });
      }
    });
  }

  /**
   * Authenticate private WebSocket.
   * Auth message: { op: "auth", args: [apiKey, expires, signature] }
   * signature = hmac("GET/realtime" + expires, secret)
   */
  async _authenticateWsPrivate() {
    if (this._wsPrivateAuthenticated) return;

    const client = await this._ensureWsConnected(this.urls.wsPrivate);
    const expires = Date.now() + 10000;
    const signStr = 'GET/realtime' + expires;
    const signature = hmacSHA256(signStr, this.secret);

    client.send({
      op: 'auth',
      args: [this.apiKey, expires, signature],
    });

    // Wait a moment for auth to be processed
    await sleep(500);
    this._wsPrivateAuthenticated = true;
  }

  /** Watch order updates (private). Topic: order */
  async watchOrders(callback) {
    this.checkRequiredCredentials();
    await this._authenticateWsPrivate();

    return this._subscribeStream('order', (msg) => {
      for (const o of (msg.data || [])) {
        callback(this._parseWsOrder(o));
      }
    }, this.urls.wsPrivate);
  }

  /** Watch balance updates (private). Topic: wallet */
  async watchBalance(callback) {
    this.checkRequiredCredentials();
    await this._authenticateWsPrivate();

    return this._subscribeStream('wallet', (msg) => {
      for (const account of (msg.data || [])) {
        const balances = {};
        for (const coin of (account.coin || [])) {
          balances[coin.coin] = {
            free: parseFloat(coin.availableToWithdraw || '0'),
            used: parseFloat(coin.locked || '0'),
            total: parseFloat(coin.walletBalance || '0'),
          };
        }
        callback({
          event: 'balance',
          accountType: account.accountType,
          timestamp: safeInteger(msg, 'creationTime'),
          balances,
        });
      }
    }, this.urls.wsPrivate);
  }

  /**
   * Close all WebSocket connections.
   */
  async closeAllWs() {
    for (const [url, client] of this._wsClients) {
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
  // PARSERS — Normalize Bybit responses to unified format
  // ===========================================================================

  _parseTicker(data) {
    const pctChange = safeFloat(data, 'price24hPcnt');
    const lastPrice = safeFloat(data, 'lastPrice');
    const prevPrice = safeFloat(data, 'prevPrice24h');
    const change = (lastPrice && prevPrice) ? lastPrice - prevPrice : undefined;

    return {
      symbol: safeString(data, 'symbol'),
      last: lastPrice,
      high: safeFloat(data, 'highPrice24h'),
      low: safeFloat(data, 'lowPrice24h'),
      open: prevPrice,
      close: lastPrice,
      bid: safeFloat(data, 'bid1Price'),
      bidVolume: safeFloat(data, 'bid1Size'),
      ask: safeFloat(data, 'ask1Price'),
      askVolume: safeFloat(data, 'ask1Size'),
      volume: safeFloat(data, 'volume24h'),
      quoteVolume: safeFloat(data, 'turnover24h'),
      change,
      percentage: pctChange ? pctChange * 100 : undefined,
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  _parseWsTicker(data) {
    return this._parseTicker(data);
  }

  _parseOrder(data) {
    const filled = safeFloat(data, 'cumExecQty') || 0;
    const amount = safeFloat(data, 'qty') || 0;
    const cost = safeFloat(data, 'cumExecValue') || 0;
    const average = safeFloat(data, 'avgPrice') || (filled > 0 ? cost / filled : 0);
    const rawStatus = safeString(data, 'orderStatus');

    return {
      id: safeString(data, 'orderId'),
      clientOrderId: safeString(data, 'orderLinkId'),
      symbol: safeString(data, 'symbol'),
      type: safeStringUpper(data, 'orderType'),
      side: safeStringUpper(data, 'side'),
      price: safeFloat(data, 'price') || 0,
      amount,
      filled,
      remaining: amount - filled,
      cost,
      average,
      status: this._normalizeStatus(rawStatus),
      timeInForce: safeString(data, 'timeInForce'),
      timestamp: safeInteger(data, 'createdTime'),
      datetime: iso8601(safeInteger(data, 'createdTime')),
      trades: [],
      info: data,
    };
  }

  _parseOrderCreateResult(data) {
    return {
      id: safeString(data, 'orderId'),
      clientOrderId: safeString(data, 'orderLinkId'),
      symbol: safeString(data, 'symbol') || undefined,
      status: 'NEW',
      info: data,
    };
  }

  _parseWsOrder(data) {
    const order = this._parseOrder(data);
    order.event = 'order';
    return order;
  }

  _parseTrade(data, symbol) {
    const ts = safeInteger(data, 'time') || parseInt(safeString(data, 'T') || '0', 10);
    return {
      id: safeString(data, 'execId') || safeString(data, 'i'),
      symbol: symbol || safeString(data, 'symbol') || safeString(data, 's'),
      price: safeFloat(data, 'price') || safeFloat(data, 'p'),
      amount: safeFloat(data, 'size') || safeFloat(data, 'v'),
      cost: (safeFloat(data, 'price') || 0) * (safeFloat(data, 'size') || 0),
      side: (safeString(data, 'side') || safeString(data, 'S') || '').toLowerCase(),
      timestamp: ts,
      datetime: iso8601(ts),
      isBlockTrade: safeValue(data, 'isBlockTrade'),
      info: data,
    };
  }

  _parseMyTrade(data) {
    const ts = safeInteger(data, 'execTime');
    return {
      id: safeString(data, 'execId'),
      orderId: safeString(data, 'orderId'),
      symbol: safeString(data, 'symbol'),
      price: safeFloat(data, 'execPrice'),
      amount: safeFloat(data, 'execQty'),
      cost: safeFloat(data, 'execValue'),
      fee: {
        cost: safeFloat(data, 'execFee'),
        currency: safeString(data, 'feeCurrency'),
      },
      timestamp: ts,
      datetime: iso8601(ts),
      side: (safeString(data, 'side') || '').toLowerCase(),
      isMaker: safeValue(data, 'isMaker'),
      info: data,
    };
  }
}

module.exports = Bybit;

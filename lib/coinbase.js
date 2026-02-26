'use strict';

const crypto = require('crypto');
const BaseExchange = require('./BaseExchange');
const { signJWT } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeStringLower, safeFloat2, safeString2,
  iso8601, parseDate,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Coinbase extends BaseExchange {

  describe() {
    return {
      id: 'coinbase',
      name: 'Coinbase',
      version: 'v3',
      rateLimit: 100,
      rateLimitCapacity: 30,
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
        api: 'https://api.coinbase.com',
        ws: 'wss://advanced-trade-ws.coinbase.com',
        wsPrivate: 'wss://advanced-trade-ws-user.coinbase.com',
        doc: 'https://docs.cdp.coinbase.com/advanced-trade/docs/welcome',
      },
      timeframes: {
        '1m': 'ONE_MINUTE',
        '5m': 'FIVE_MINUTE',
        '15m': 'FIFTEEN_MINUTE',
        '30m': 'THIRTY_MINUTE',
        '1h': 'ONE_HOUR',
        '2h': 'TWO_HOUR',
        '6h': 'SIX_HOUR',
        '1d': 'ONE_DAY',
      },
      fees: {
        trading: { maker: 0.004, taker: 0.006 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this._wsClients = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION — JWT / ES256 (ECDSA P-256)
  // ===========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const uri = method + ' api.coinbase.com' + path;
    const jwt = signJWT(this.apiKey, this.secret, uri, 'coinbase-cloud');

    const headers = {
      'Authorization': 'Bearer ' + jwt,
    };

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE HANDLING — Coinbase has no wrapper, errors via { error } or { errors }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object') {
      // Single error field
      if (data.error) {
        this._handleCoinbaseError(data.error, data.message || data.error_description || data.error);
      }
      // Array of errors
      if (data.errors && Array.isArray(data.errors) && data.errors.length > 0) {
        const err = data.errors[0];
        this._handleCoinbaseError(err.id || err.type || 'unknown', err.message || JSON.stringify(err));
      }
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    // Coinbase uses standard rate limiting but doesn't expose detailed headers
    // Client-side throttler handles limiting
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const errorId = parsed?.error || parsed?.errors?.[0]?.id || '';
    const msg = parsed?.message || parsed?.errors?.[0]?.message || body;

    if (errorId) {
      this._handleCoinbaseError(errorId, msg);
    }

    const full = this.id + ' HTTP ' + status + ': ' + msg;
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    if (status === 404) throw new ExchangeError(full);
    if (status === 500 || status === 503) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  _handleCoinbaseError(errorId, msg) {
    const full = this.id + ' ' + errorId + ': ' + msg;

    const errorMap = {
      // Authentication
      'authentication_error': AuthenticationError,
      'invalid_token': AuthenticationError,
      'expired_token': AuthenticationError,
      'UNAUTHORIZED': AuthenticationError,
      'PERMISSION_DENIED': AuthenticationError,

      // Rate limiting
      'rate_limit_exceeded': RateLimitExceeded,
      'RATE_LIMIT_EXCEEDED': RateLimitExceeded,

      // Insufficient funds
      'insufficient_funds': InsufficientFunds,
      'INSUFFICIENT_FUND': InsufficientFunds,

      // Invalid order
      'validation_error': InvalidOrder,
      'INVALID_LIMIT_PRICE_POST_ONLY': InvalidOrder,

      // Order not found
      'not_found': OrderNotFound,
      'NOT_FOUND': OrderNotFound,

      // Bad symbol / product
      'invalid_product_id': BadSymbol,
      'UNKNOWN_PRODUCT_ID': BadSymbol,

      // Bad request
      'invalid_request': BadRequest,
      'INVALID_ARGUMENT': BadRequest,

      // Exchange unavailable
      'internal_server_error': ExchangeNotAvailable,
      'INTERNAL': ExchangeNotAvailable,
    };

    const ErrorClass = errorMap[errorId] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Convert unified symbol to Coinbase format.
   * BTC/USD → BTC-USD
   */
  _toCoinbaseSymbol(symbol) {
    if (symbol.includes('-')) return symbol;
    return symbol.replace('/', '-');
  }

  /**
   * Convert Coinbase symbol to unified format.
   * BTC-USD → BTC/USD
   */
  _fromCoinbaseSymbol(productId) {
    if (!productId) return productId;
    if (productId.includes('/')) return productId;
    return productId.replace('-', '/');
  }

  /**
   * Generate unique client_order_id for orders.
   */
  _generateClientOrderId() {
    return crypto.randomUUID();
  }

  /**
   * Build order_configuration for Coinbase's nested order format.
   */
  _buildOrderConfig(type, side, amount, price) {
    if (type.toUpperCase() === 'LIMIT') {
      return {
        limit_limit_gtc: {
          base_size: String(amount),
          limit_price: String(price),
        },
      };
    }
    // Market order
    if (side.toUpperCase() === 'BUY') {
      return {
        market_market_ioc: {
          quote_size: String(amount),
        },
      };
    }
    // Market sell
    return {
      market_market_ioc: {
        base_size: String(amount),
      },
    };
  }

  /**
   * Normalize Coinbase order status to unified format.
   */
  _normalizeOrderStatus(status) {
    const map = {
      'OPEN': 'NEW',
      'PENDING': 'NEW',
      'FILLED': 'FILLED',
      'CANCELLED': 'CANCELED',
      'CANCELED': 'CANCELED',
      'EXPIRED': 'CANCELED',
      'FAILED': 'REJECTED',
    };
    return map[status] || (status ? status.toUpperCase() : status);
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    const data = await this._request('GET', '/api/v3/brokerage/time', {}, false, 1);
    const result = this._unwrapResponse(data);
    return safeInteger(result, 'epochMillis') || parseDate(result?.iso) || Date.now();
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (6 endpoints)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v3/brokerage/products', {}, false, 1);
    const result = this._unwrapResponse(data);
    const products = result?.products || [];

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const item of products) {
      const id = item.product_id;       // BTC-USD
      const base = item.base_currency_id;
      const quote = item.quote_currency_id;
      const symbol = base + '/' + quote;
      const status = item.status;
      const isDisabled = item.is_disabled;

      const market = {
        id,
        symbol,
        base,
        quote,
        status: isDisabled ? 'disabled' : (status || 'online'),
        active: !isDisabled,
        precision: {
          price: safeString(item, 'quote_increment') ? this._countDecimals(item.quote_increment) : 2,
          amount: safeString(item, 'base_increment') ? this._countDecimals(item.base_increment) : 8,
          base: safeString(item, 'base_increment') ? this._countDecimals(item.base_increment) : 8,
          quote: safeString(item, 'quote_increment') ? this._countDecimals(item.quote_increment) : 2,
        },
        limits: {
          price: {
            min: safeFloat(item, 'quote_increment'),
            max: safeFloat(item, 'quote_max_size') || undefined,
          },
          amount: {
            min: safeFloat(item, 'base_min_size'),
            max: safeFloat(item, 'base_max_size') || undefined,
          },
          cost: {
            min: safeFloat(item, 'quote_min_size'),
            max: safeFloat(item, 'quote_max_size') || undefined,
          },
        },
        stepSize: safeFloat(item, 'base_increment'),
        tickSize: safeFloat(item, 'quote_increment'),
        info: item,
      };

      this.markets[symbol] = market;
      this.marketsById[id] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  _countDecimals(str) {
    if (!str) return 0;
    const s = String(str);
    const parts = s.split('.');
    return parts.length > 1 ? parts[1].length : 0;
  }

  async fetchTicker(symbol, params = {}) {
    const productId = this._toCoinbaseSymbol(symbol);
    const data = await this._request('GET', '/api/v3/brokerage/products/' + productId, params, false, 1);
    const result = this._unwrapResponse(data);

    if (!result || !result.product_id) {
      throw new BadSymbol(this.id + ' symbol not found: ' + symbol);
    }
    return this._parseTicker(result, symbol);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    const data = await this._request('GET', '/api/v3/brokerage/products', params, false, 1);
    const result = this._unwrapResponse(data);
    const products = result?.products || [];
    const tickers = {};

    for (const p of products) {
      const sym = this._fromCoinbaseSymbol(p.product_id);
      if (!symbols || symbols.includes(sym)) {
        tickers[sym] = this._parseTicker(p, sym);
      }
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined, params = {}) {
    const productId = this._toCoinbaseSymbol(symbol);
    const request = { product_id: productId, ...params };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v3/brokerage/product_book', request, false, 1);
    const result = this._unwrapResponse(data);
    const pricebook = result?.pricebook || result || {};

    return {
      symbol,
      bids: (pricebook.bids || []).map((b) => [parseFloat(b.price), parseFloat(b.size)]),
      asks: (pricebook.asks || []).map((a) => [parseFloat(a.price), parseFloat(a.size)]),
      timestamp: pricebook.time ? parseDate(pricebook.time) : Date.now(),
      datetime: pricebook.time || iso8601(Date.now()),
      nonce: undefined,
    };
  }

  async fetchTrades(symbol, since = undefined, limit = undefined, params = {}) {
    const productId = this._toCoinbaseSymbol(symbol);
    const request = { ...params };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v3/brokerage/products/' + productId + '/ticker', request, false, 1);
    const result = this._unwrapResponse(data);
    const trades = result?.trades || [];

    return trades.map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = undefined, params = {}) {
    const productId = this._toCoinbaseSymbol(symbol);
    const granularity = this.timeframes[timeframe] || timeframe;
    const request = {
      granularity,
      ...params,
    };

    if (since) {
      request.start = String(Math.floor(since / 1000));
    }
    if (limit && since) {
      // Calculate end time based on since + limit * interval
      const intervalMs = this._timeframeToMs(timeframe);
      request.end = String(Math.floor((since + limit * intervalMs) / 1000));
    }

    const data = await this._request('GET', '/api/v3/brokerage/products/' + productId + '/candles', request, false, 1);
    const result = this._unwrapResponse(data);
    const candles = result?.candles || [];

    // Coinbase candles are objects: { start, low, high, open, close, volume } — all strings
    // Normalize to: [timestamp, open, high, low, close, volume]
    const list = candles.map((c) => this._parseCandle(c));

    // Coinbase returns newest first — reverse for chronological order
    list.reverse();

    if (limit && list.length > limit) {
      return list.slice(-limit);
    }
    return list;
  }

  _timeframeToMs(timeframe) {
    const map = {
      '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
      '1h': 3600000, '2h': 7200000, '6h': 21600000, '1d': 86400000,
    };
    return map[timeframe] || 3600000;
  }

  // ===========================================================================
  // TRADING — PRIVATE (7 endpoints)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const productId = this._toCoinbaseSymbol(symbol);
    const clientOrderId = params.client_order_id || params.clientOrderId || this._generateClientOrderId();
    const orderConfig = this._buildOrderConfig(type, side, amount, price);

    const request = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: side.toUpperCase(),
      order_configuration: orderConfig,
    };

    // Spread remaining params
    const skip = new Set(['client_order_id', 'clientOrderId']);
    for (const [k, v] of Object.entries(params)) {
      if (!skip.has(k) && !(k in request)) {
        request[k] = v;
      }
    }

    const data = await this._request('POST', '/api/v3/brokerage/orders', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderCreateResult(result, clientOrderId);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = {
      order_ids: [id],
    };

    const data = await this._request('POST', '/api/v3/brokerage/orders/batch_cancel', request, true, 1);
    const result = this._unwrapResponse(data);

    const results = result?.results || [];
    const first = results[0] || {};
    const success = first.success === true;

    return {
      id,
      symbol,
      status: success ? 'CANCELED' : 'FAILED',
      info: result,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    // First, fetch all open orders
    const openOrders = await this.fetchOpenOrders(symbol, undefined, undefined, params);
    if (!openOrders || openOrders.length === 0) {
      return { cancelledOrderIds: [], info: {} };
    }

    const orderIds = openOrders.map((o) => o.id);
    const request = { order_ids: orderIds };

    const data = await this._request('POST', '/api/v3/brokerage/orders/batch_cancel', request, true, 1);
    const result = this._unwrapResponse(data);

    const cancelled = (result?.results || [])
      .filter((r) => r.success === true)
      .map((r) => r.order_id);

    return {
      cancelledOrderIds: cancelled,
      info: result,
    };
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const path = '/api/v3/brokerage/orders/historical/' + id;
    const data = await this._request('GET', path, params, true, 1);
    const result = this._unwrapResponse(data);
    const order = result?.order || result;

    if (!order || !order.order_id) {
      throw new OrderNotFound(this.id + ' order not found: ' + id);
    }
    return this._parseOrder(order);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { order_status: 'OPEN', ...params };
    if (symbol) request.product_id = this._toCoinbaseSymbol(symbol);
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v3/brokerage/orders/historical', request, true, 1);
    const result = this._unwrapResponse(data);
    const orders = result?.orders || [];
    return orders.map((o) => this._parseOrder(o));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { order_status: 'FILLED', ...params };
    if (symbol) request.product_id = this._toCoinbaseSymbol(symbol);
    if (since) request.start_date = iso8601(since);
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v3/brokerage/orders/historical', request, true, 1);
    const result = this._unwrapResponse(data);
    const orders = result?.orders || [];
    return orders.map((o) => this._parseOrder(o));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.product_id = this._toCoinbaseSymbol(symbol);
    if (since) request.start_sequence_timestamp = iso8601(since);
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v3/brokerage/orders/historical/fills', request, true, 1);
    const result = this._unwrapResponse(data);
    const fills = result?.fills || [];
    return fills.map((t) => this._parseMyTrade(t));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('GET', '/api/v3/brokerage/accounts', params, true, 1);
    const result = this._unwrapResponse(data);

    const balance = {
      info: result,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    const accounts = result?.accounts || [];
    for (const item of accounts) {
      const currency = item.currency;
      const available = parseFloat(item.available_balance?.value || '0');
      const holds = parseFloat(item.hold?.value || '0');
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
    const data = await this._request('GET', '/api/v3/brokerage/transaction_summary', params, true, 1);
    const result = this._unwrapResponse(data);

    const feeTier = result?.fee_tier || {};
    const maker = safeFloat(feeTier, 'maker_fee_rate');
    const taker = safeFloat(feeTier, 'taker_fee_rate');

    if (symbol) {
      return {
        symbol,
        maker: maker || 0.004,
        taker: taker || 0.006,
        info: result,
      };
    }

    return {
      maker: maker || 0.004,
      taker: taker || 0.006,
      info: result,
    };
  }

  // ===========================================================================
  // WEBSOCKET — Coinbase Advanced Trade (Public + Private)
  // ===========================================================================

  _getWsClient(url) {
    if (this._wsClients.has(url)) {
      return this._wsClients.get(url);
    }
    const client = new WsClient({ url });
    this._wsClients.set(url, client);
    return client;
  }

  async _ensureWsConnected(url) {
    const client = this._getWsClient(url);
    if (!client.connected) {
      await client.connect();
    }
    return client;
  }

  _buildWsJWT() {
    if (!this.apiKey || !this.secret) return undefined;
    return signJWT(this.apiKey, this.secret, null, 'cdp');
  }

  async _subscribePublic(channel, productIds, callback) {
    const url = this.urls.ws;
    const client = await this._ensureWsConnected(url);

    const msg = {
      type: 'subscribe',
      product_ids: productIds,
      channel,
    };

    // Add JWT if credentials available
    const jwt = this._buildWsJWT();
    if (jwt) msg.jwt = jwt;

    client.send(msg);

    const key = channel + ':' + productIds.join(',');
    const handler = (data) => {
      if (data && data.channel === channel) {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async _subscribePrivate(channel, callback) {
    const url = this.urls.wsPrivate;
    const client = await this._ensureWsConnected(url);

    const jwt = this._buildWsJWT();
    if (!jwt) {
      throw new AuthenticationError(this.id + ' API credentials required for private WebSocket');
    }

    const msg = {
      type: 'subscribe',
      channel,
      jwt,
    };

    client.send(msg);

    const key = channel + ':private';
    const handler = (data) => {
      if (data && data.channel === channel) {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async watchTicker(symbol, callback) {
    const productId = this._toCoinbaseSymbol(symbol);
    return this._subscribePublic('ticker', [productId], (msg) => {
      const events = msg.events || [];
      for (const event of events) {
        const tickers = event.tickers || [];
        for (const t of tickers) {
          if (t.product_id === productId) {
            callback(this._parseWsTicker(t, symbol));
          }
        }
      }
    });
  }

  async watchOrderBook(symbol, callback, depth = undefined) {
    const productId = this._toCoinbaseSymbol(symbol);
    return this._subscribePublic('level2', [productId], (msg) => {
      const events = msg.events || [];
      for (const event of events) {
        const updates = event.updates || [];
        callback({
          symbol,
          type: event.type || 'update',
          bids: updates.filter((u) => u.side === 'bid').map((u) => [parseFloat(u.price_level), parseFloat(u.new_quantity)]),
          asks: updates.filter((u) => u.side === 'offer').map((u) => [parseFloat(u.price_level), parseFloat(u.new_quantity)]),
          timestamp: msg.timestamp ? parseDate(msg.timestamp) : Date.now(),
        });
      }
    });
  }

  async watchTrades(symbol, callback) {
    const productId = this._toCoinbaseSymbol(symbol);
    return this._subscribePublic('market_trades', [productId], (msg) => {
      const events = msg.events || [];
      for (const event of events) {
        const trades = event.trades || [];
        for (const t of trades) {
          const ts = t.time ? parseDate(t.time) : Date.now();
          callback({
            id: safeString(t, 'trade_id'),
            symbol,
            price: parseFloat(t.price),
            amount: parseFloat(t.size),
            cost: parseFloat(t.price) * parseFloat(t.size),
            side: safeStringLower(t, 'side'),
            timestamp: ts,
            datetime: iso8601(ts),
          });
        }
      }
    });
  }

  async watchKlines(symbol, interval, callback) {
    const productId = this._toCoinbaseSymbol(symbol);
    return this._subscribePublic('candles', [productId], (msg) => {
      const events = msg.events || [];
      for (const event of events) {
        const candles = event.candles || [];
        for (const c of candles) {
          const ts = parseInt(c.start, 10) * 1000;
          callback({
            symbol,
            interval,
            timestamp: ts,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            volume: parseFloat(c.volume),
            closed: false,
          });
        }
      }
    });
  }

  async watchBalance(callback) {
    this.checkRequiredCredentials();
    return this._subscribePrivate('user', (msg) => {
      const events = msg.events || [];
      for (const event of events) {
        if (event.type === 'snapshot' || event.type === 'update') {
          // Balance events come through the 'user' channel
          callback({
            event: 'balance',
            timestamp: msg.timestamp ? parseDate(msg.timestamp) : Date.now(),
            info: event,
          });
        }
      }
    });
  }

  async watchOrders(callback) {
    this.checkRequiredCredentials();
    return this._subscribePrivate('user', (msg) => {
      const events = msg.events || [];
      for (const event of events) {
        const orders = event.orders || [];
        for (const o of orders) {
          callback(this._parseWsOrder(o));
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
  }

  // ===========================================================================
  // PARSERS — Normalize Coinbase responses to unified format
  // ===========================================================================

  _parseTicker(data, symbol) {
    const last = safeFloat(data, 'price');
    const changePercent = safeFloat(data, 'price_percentage_change_24h');

    return {
      symbol,
      last,
      high: safeFloat(data, 'high_24h'),
      low: safeFloat(data, 'low_24h'),
      open: undefined,
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: safeFloat(data, 'bid_size'),
      ask: safeFloat(data, 'ask'),
      askVolume: safeFloat(data, 'ask_size'),
      volume: safeFloat(data, 'volume_24h'),
      quoteVolume: safeFloat(data, 'volume_percentage_change_24h'),
      change: undefined,
      percentage: changePercent,
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
      high: safeFloat(data, 'high_24_h'),
      low: safeFloat(data, 'low_24_h'),
      open: undefined,
      close: last,
      bid: safeFloat(data, 'best_bid'),
      bidVolume: safeFloat(data, 'best_bid_quantity'),
      ask: safeFloat(data, 'best_ask'),
      askVolume: safeFloat(data, 'best_ask_quantity'),
      volume: safeFloat(data, 'volume_24_h'),
      quoteVolume: undefined,
      change: undefined,
      percentage: safeFloat(data, 'price_percent_chg_24_h'),
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  _parseOrder(data) {
    const filledSize = safeFloat(data, 'filled_size') || 0;
    const filledValue = safeFloat(data, 'filled_value') || 0;
    const avgPrice = safeFloat(data, 'average_filled_price') || (filledSize > 0 ? filledValue / filledSize : 0);
    const totalFees = safeFloat(data, 'total_fees') || 0;

    // Parse order_configuration to get type, amount, price
    const config = data.order_configuration || {};
    let type = 'UNKNOWN';
    let amount = 0;
    let price = 0;

    if (config.limit_limit_gtc) {
      type = 'LIMIT';
      amount = safeFloat(config.limit_limit_gtc, 'base_size') || 0;
      price = safeFloat(config.limit_limit_gtc, 'limit_price') || 0;
    } else if (config.limit_limit_gtd) {
      type = 'LIMIT';
      amount = safeFloat(config.limit_limit_gtd, 'base_size') || 0;
      price = safeFloat(config.limit_limit_gtd, 'limit_price') || 0;
    } else if (config.limit_limit_fok) {
      type = 'LIMIT';
      amount = safeFloat(config.limit_limit_fok, 'base_size') || 0;
      price = safeFloat(config.limit_limit_fok, 'limit_price') || 0;
    } else if (config.market_market_ioc) {
      type = 'MARKET';
      amount = safeFloat(config.market_market_ioc, 'base_size') || safeFloat(config.market_market_ioc, 'quote_size') || 0;
    } else if (config.sor_limit_ioc) {
      type = 'LIMIT';
      amount = safeFloat(config.sor_limit_ioc, 'base_size') || 0;
      price = safeFloat(config.sor_limit_ioc, 'limit_price') || 0;
    } else if (config.stop_limit_stop_limit_gtc) {
      type = 'STOP_LIMIT';
      amount = safeFloat(config.stop_limit_stop_limit_gtc, 'base_size') || 0;
      price = safeFloat(config.stop_limit_stop_limit_gtc, 'limit_price') || 0;
    } else if (config.stop_limit_stop_limit_gtd) {
      type = 'STOP_LIMIT';
      amount = safeFloat(config.stop_limit_stop_limit_gtd, 'base_size') || 0;
      price = safeFloat(config.stop_limit_stop_limit_gtd, 'limit_price') || 0;
    }

    const remaining = amount > 0 ? amount - filledSize : 0;
    const ts = data.created_time ? parseDate(data.created_time) : undefined;

    return {
      id: safeString(data, 'order_id'),
      clientOrderId: safeString(data, 'client_order_id'),
      symbol: this._fromCoinbaseSymbol(data.product_id),
      type,
      side: safeStringUpper(data, 'side'),
      price,
      amount,
      filled: filledSize,
      remaining: Math.max(0, remaining),
      cost: filledValue,
      average: avgPrice,
      status: this._normalizeOrderStatus(data.status),
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      trades: [],
      fee: {
        cost: totalFees,
        currency: data.product_id ? data.product_id.split('-')[1] : undefined,
      },
      info: data,
    };
  }

  _parseWsOrder(data) {
    const filledSize = safeFloat(data, 'cumulative_quantity') || safeFloat(data, 'filled_size') || 0;
    const avgPrice = safeFloat(data, 'avg_price') || safeFloat(data, 'average_filled_price') || 0;
    const totalFees = safeFloat(data, 'total_fees') || 0;

    const ts = data.creation_time ? parseDate(data.creation_time) : Date.now();

    return {
      id: safeString(data, 'order_id'),
      clientOrderId: safeString(data, 'client_order_id'),
      symbol: this._fromCoinbaseSymbol(data.product_id),
      type: safeStringUpper(data, 'order_type'),
      side: safeStringUpper(data, 'order_side'),
      price: safeFloat(data, 'limit_price') || 0,
      amount: safeFloat(data, 'leaves_quantity') ? filledSize + safeFloat(data, 'leaves_quantity') : filledSize,
      filled: filledSize,
      remaining: safeFloat(data, 'leaves_quantity') || 0,
      cost: filledSize * avgPrice,
      average: avgPrice,
      status: this._normalizeOrderStatus(data.status),
      event: 'order',
      timestamp: ts,
      datetime: iso8601(ts),
      fee: {
        cost: totalFees,
        currency: data.product_id ? data.product_id.split('-')[1] : undefined,
      },
      info: data,
    };
  }

  _parseOrderCreateResult(data, clientOrderId) {
    // Coinbase returns { success, success_response, failure_response, order_configuration }
    if (data?.success === true || data?.success_response) {
      const resp = data.success_response || {};
      return {
        id: safeString(resp, 'order_id'),
        clientOrderId,
        symbol: this._fromCoinbaseSymbol(resp.product_id),
        status: 'NEW',
        info: data,
      };
    }

    // Failure case
    if (data?.failure_response) {
      const fail = data.failure_response;
      const reason = fail.error || fail.preview_failure_reason || 'unknown';
      throw new InvalidOrder(this.id + ' order failed: ' + reason);
    }

    // Fallback — assume success
    return {
      id: safeString(data, 'order_id'),
      clientOrderId,
      symbol: undefined,
      status: 'NEW',
      info: data,
    };
  }

  _parseTrade(data, symbol) {
    const ts = data.time ? parseDate(data.time) : Date.now();

    return {
      id: safeString(data, 'trade_id'),
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
    const ts = data.trade_time ? parseDate(data.trade_time) : undefined;

    return {
      id: safeString(data, 'entry_id'),
      tradeId: safeString(data, 'trade_id'),
      orderId: safeString(data, 'order_id'),
      symbol: this._fromCoinbaseSymbol(data.product_id),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'size'),
      cost: safeFloat(data, 'price') && safeFloat(data, 'size')
        ? safeFloat(data, 'price') * safeFloat(data, 'size')
        : undefined,
      fee: {
        cost: safeFloat(data, 'commission'),
        currency: data.product_id ? data.product_id.split('-')[1] : undefined,
      },
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      side: safeStringLower(data, 'side'),
      info: data,
    };
  }

  /**
   * Parse Coinbase candle object to unified array format.
   * Coinbase: { start, open, high, low, close, volume } (all strings)
   * Unified: [timestamp, open, high, low, close, volume]
   */
  _parseCandle(c) {
    return [
      parseInt(c.start, 10) * 1000,  // timestamp in ms
      parseFloat(c.open),
      parseFloat(c.high),
      parseFloat(c.low),
      parseFloat(c.close),
      parseFloat(c.volume),
    ];
  }
}

module.exports = Coinbase;

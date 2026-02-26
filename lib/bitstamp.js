'use strict';

const crypto = require('crypto');
const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
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

class Bitstamp extends BaseExchange {

  describe() {
    return {
      id: 'bitstamp',
      name: 'Bitstamp',
      version: 'v2',
      rateLimit: 600,
      rateLimitCapacity: 8000,
      rateLimitInterval: 600000,
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
        fetchClosedOrders: false,
        fetchMyTrades: true,
        fetchBalance: true,
        fetchTradingFees: true,
        // WebSocket
        watchTicker: false,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: false,
        watchBalance: false,
        watchOrders: true,
      },
      urls: {
        api: 'https://www.bitstamp.net',
        ws: 'wss://ws.bitstamp.net/',
        doc: 'https://www.bitstamp.net/api/',
      },
      timeframes: {
        '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
        '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
        '1d': 86400,
      },
      fees: {
        trading: { maker: 0.003, taker: 0.005 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsFormEncoded = true;
    this.postAsJson = false;
    this._wsClients = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA256 + UUID v4 nonce
  // ===========================================================================

  /**
   * Bitstamp V2 authentication.
   * Signature payload is CONDITIONAL:
   *   - Without body: "BITSTAMP " + apiKey + METHOD + host + path + nonce + timestamp + "v2"
   *   - With body:    "BITSTAMP " + apiKey + METHOD + host + path + contentType + nonce + timestamp + "v2" + body
   *
   * Headers: X-Auth, X-Auth-Signature, X-Auth-Nonce, X-Auth-Timestamp, X-Auth-Version
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const nonce = crypto.randomUUID();
    const timestamp = Date.now().toString();

    let payload = 'BITSTAMP ' + this.apiKey
      + method
      + 'www.bitstamp.net'
      + path;

    const hasBody = params && Object.keys(params).length > 0;
    if (hasBody) {
      const contentType = 'application/x-www-form-urlencoded';
      const body = new URLSearchParams(params).toString();
      payload += contentType + nonce + timestamp + 'v2' + body;
    } else {
      payload += nonce + timestamp + 'v2';
    }

    const signature = hmacSHA256(payload, this.secret);

    const headers = {
      'X-Auth': 'BITSTAMP ' + this.apiKey,
      'X-Auth-Signature': signature,
      'X-Auth-Nonce': nonce,
      'X-Auth-Timestamp': timestamp,
      'X-Auth-Version': 'v2',
    };

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE HANDLING — Bitstamp returns JSON objects, errors as { status: 'error' }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.status === 'error') {
        const code = data.code || '';
        const reason = data.reason || data.message || JSON.stringify(data);
        this._handleBitstampError(code, reason);
      }
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    // Bitstamp doesn't expose detailed rate limit headers
    // Client-side throttler handles limiting
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const code = parsed?.code || '';
    const reason = parsed?.reason || parsed?.message || body;

    if (code) {
      this._handleBitstampError(code, reason);
    }

    const full = this.id + ' HTTP ' + status + ': ' + reason;
    if (status === 400) throw new BadRequest(full);
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 404) throw new ExchangeError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    if (status === 500 || status === 503) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  _handleBitstampError(code, reason) {
    const full = this.id + ' ' + code + ': ' + reason;

    const errorMap = {
      // Authentication
      'API0002': AuthenticationError,   // Missing permission
      'API0004': AuthenticationError,   // Missing/invalid signature
      'API0005': AuthenticationError,   // Invalid API key
      'API0006': AuthenticationError,   // Invalid nonce
      'API0008': AuthenticationError,   // Invalid timestamp

      // Bad request / validation
      'API0001': BadRequest,            // General bad request
      'API0003': BadRequest,            // Missing required param
      'API0010': BadRequest,            // Invalid parameter
      'API0013': BadRequest,            // Invalid content type

      // Order errors
      'API0011': InvalidOrder,          // Invalid order
      'API0012': InvalidOrder,          // Invalid order type
      'API0018': OrderNotFound,         // Order not found

      // Insufficient funds
      'API0030': InsufficientFunds,     // Not enough balance

      // Rate limiting
      'API0025': RateLimitExceeded,     // Rate limit exceeded

      // Exchange unavailable
      'API0020': ExchangeNotAvailable,  // Service unavailable
    };

    const ErrorClass = errorMap[code] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Convert unified symbol to Bitstamp format.
   * BTC/USD → btcusd
   */
  _toBitstampSymbol(symbol) {
    if (!symbol.includes('/')) return symbol.toLowerCase();
    return symbol.replace('/', '').toLowerCase();
  }

  /**
   * Convert Bitstamp symbol to unified format.
   * btcusd → BTC/USD (via marketsById lookup)
   */
  _fromBitstampSymbol(bitstampSymbol) {
    if (!bitstampSymbol) return bitstampSymbol;
    if (bitstampSymbol.includes('/')) return bitstampSymbol;

    // Try marketsById lookup first
    const lower = bitstampSymbol.toLowerCase();
    if (this.marketsById[lower]) {
      return this.marketsById[lower].symbol;
    }

    // Fallback: parse the pair (assume 3+3 like btcusd)
    const s = bitstampSymbol.toUpperCase();
    if (s.length === 6) {
      return s.slice(0, 3) + '/' + s.slice(3);
    }
    if (s.length === 7) {
      return s.slice(0, 4) + '/' + s.slice(4);
    }
    if (s.length === 8) {
      return s.slice(0, 4) + '/' + s.slice(4);
    }
    return bitstampSymbol;
  }

  /**
   * Build the order endpoint path based on side and type.
   * Bitstamp: side is in the URL, not in the body!
   *   Limit buy:  /api/v2/buy/{pair}/
   *   Limit sell: /api/v2/sell/{pair}/
   *   Market buy: /api/v2/buy/market/{pair}/
   *   Market sell:/api/v2/sell/market/{pair}/
   */
  _buildOrderPath(side, type, pair) {
    const s = side.toLowerCase();
    if (type.toUpperCase() === 'MARKET') {
      return '/api/v2/' + s + '/market/' + pair + '/';
    }
    return '/api/v2/' + s + '/' + pair + '/';
  }

  /**
   * Normalize Bitstamp order status to unified format.
   */
  _normalizeOrderStatus(status) {
    if (!status) return status;
    const s = String(status);
    const map = {
      'Open': 'NEW',
      'Queue': 'NEW',
      'Finished': 'FILLED',
      'Canceled': 'CANCELED',
      'Cancelled': 'CANCELED',
    };
    return map[s] || s.toUpperCase();
  }

  /**
   * Parse Bitstamp order type (numeric).
   * 0 = buy, 1 = sell
   */
  _parseOrderSide(type) {
    const t = parseInt(type, 10);
    if (t === 0) return 'BUY';
    if (t === 1) return 'SELL';
    return undefined;
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    // Bitstamp has no dedicated server time endpoint
    return Date.now();
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (6 endpoints, all GET, unsigned)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v2/trading-pairs-info/', {}, false, 1);
    const pairs = Array.isArray(data) ? data : [];

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const item of pairs) {
      const name = item.name;            // "BTC/USD"
      const id = item.url_symbol;        // "btcusd"
      const parts = name.split('/');
      const base = parts[0] ? parts[0].trim() : '';
      const quote = parts[1] ? parts[1].trim() : '';
      const symbol = base + '/' + quote;
      const trading = item.trading;
      const active = trading === 'Enabled';

      // Parse minimum_order: "10.0 USD" → extract number
      let minCost;
      const minOrderStr = item.minimum_order || '';
      const minMatch = minOrderStr.match(/([\d.]+)/);
      if (minMatch) minCost = parseFloat(minMatch[1]);

      const market = {
        id,
        symbol,
        base,
        quote,
        active,
        precision: {
          price: safeInteger(item, 'counter_decimals') || 2,
          amount: safeInteger(item, 'base_decimals') || 8,
          base: safeInteger(item, 'base_decimals') || 8,
          quote: safeInteger(item, 'counter_decimals') || 2,
        },
        limits: {
          amount: {
            min: undefined,
            max: undefined,
          },
          price: {
            min: undefined,
            max: undefined,
          },
          cost: {
            min: minCost,
            max: undefined,
          },
        },
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
    const pair = this._toBitstampSymbol(symbol);
    const data = await this._request('GET', '/api/v2/ticker/' + pair + '/', params, false, 1);
    const result = this._unwrapResponse(data);
    return this._parseTicker(result, symbol);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    // Bitstamp has no all-tickers endpoint, so we need to load markets and fetch individually
    // However, there's a basic workaround: we iterate available symbols
    if (!this._marketsLoaded) {
      await this.loadMarkets();
    }

    const targetSymbols = symbols || this.symbols;
    const tickers = {};

    for (const sym of targetSymbols) {
      try {
        tickers[sym] = await this.fetchTicker(sym, params);
      } catch {
        // Skip symbols that fail
      }
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined, params = {}) {
    const pair = this._toBitstampSymbol(symbol);
    const data = await this._request('GET', '/api/v2/order_book/' + pair + '/', params, false, 1);
    const result = this._unwrapResponse(data);

    const bids = (result.bids || []).map((b) => [parseFloat(b[0]), parseFloat(b[1])]);
    const asks = (result.asks || []).map((a) => [parseFloat(a[0]), parseFloat(a[1])]);
    const ts = result.timestamp ? parseInt(result.timestamp, 10) * 1000 : Date.now();

    return {
      symbol,
      bids: limit ? bids.slice(0, limit) : bids,
      asks: limit ? asks.slice(0, limit) : asks,
      timestamp: ts,
      datetime: iso8601(ts),
      nonce: result.microtimestamp || undefined,
    };
  }

  async fetchTrades(symbol, since = undefined, limit = undefined, params = {}) {
    const pair = this._toBitstampSymbol(symbol);
    const request = { ...params };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v2/transactions/' + pair + '/', request, false, 1);
    const result = this._unwrapResponse(data);
    const trades = Array.isArray(result) ? result : [];

    return trades.map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = undefined, params = {}) {
    const pair = this._toBitstampSymbol(symbol);
    const step = this.timeframes[timeframe] || timeframe;
    const request = {
      step,
      ...params,
    };

    if (limit) request.limit = limit;
    if (since) request.start = Math.floor(since / 1000);

    const data = await this._request('GET', '/api/v2/ohlc/' + pair + '/', request, false, 1);
    const result = this._unwrapResponse(data);

    // Response: { data: { pair, ohlc: [...] } }
    const ohlcData = result?.data?.ohlc || [];

    return ohlcData.map((c) => this._parseCandle(c));
  }

  // ===========================================================================
  // TRADING — PRIVATE (7 endpoints, all POST, signed)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const pair = this._toBitstampSymbol(symbol);
    const path = this._buildOrderPath(side, type, pair);

    const request = {
      amount: String(amount),
      ...params,
    };

    if (type.toUpperCase() === 'LIMIT' && price !== undefined) {
      request.price = String(price);
    }

    const data = await this._request('POST', path, request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'id'),
      clientOrderId: undefined,
      symbol,
      type: type.toUpperCase(),
      side: side.toUpperCase(),
      price: safeFloat(result, 'price') || price,
      amount: safeFloat(result, 'amount') || amount,
      filled: 0,
      remaining: safeFloat(result, 'amount') || amount,
      cost: 0,
      average: 0,
      status: 'NEW',
      timestamp: result.datetime ? parseDate(result.datetime) : Date.now(),
      datetime: result.datetime || iso8601(Date.now()),
      trades: [],
      fee: undefined,
      info: result,
    };
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { id, ...params };
    const data = await this._request('POST', '/api/v2/cancel_order/', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'id') || String(id),
      symbol,
      status: 'CANCELED',
      info: result,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('POST', '/api/v2/cancel_all_orders/', params, true, 1);
    const result = this._unwrapResponse(data);

    return {
      info: result,
    };
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { id, ...params };
    const data = await this._request('POST', '/api/v2/order_status/', request, true, 1);
    const result = this._unwrapResponse(data);

    if (!result || (!result.id && !result.status)) {
      throw new OrderNotFound(this.id + ' order not found: ' + id);
    }

    return this._parseOrder(result);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    let path;
    if (symbol) {
      const pair = this._toBitstampSymbol(symbol);
      path = '/api/v2/open_orders/' + pair + '/';
    } else {
      path = '/api/v2/open_orders/all/';
    }

    const data = await this._request('POST', path, params, true, 1);
    const result = this._unwrapResponse(data);
    const orders = Array.isArray(result) ? result : [];

    return orders.map((o) => this._parseOrder(o));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    let path;
    if (symbol) {
      const pair = this._toBitstampSymbol(symbol);
      path = '/api/v2/user_transactions/' + pair + '/';
    } else {
      path = '/api/v2/user_transactions/';
    }

    const request = { ...params };
    if (limit) request.limit = limit;
    if (since) {
      // Bitstamp uses offset, not since timestamp directly
      // We pass since as a hint but offset=0 for now
      request.offset = 0;
    }
    request.sort = 'desc';

    const data = await this._request('POST', path, request, true, 1);
    const result = this._unwrapResponse(data);
    const transactions = Array.isArray(result) ? result : [];

    // Filter only trades (type = 2)
    const trades = transactions.filter((t) => parseInt(t.type, 10) === 2);

    return trades.map((t) => this._parseMyTrade(t, symbol));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('POST', '/api/v2/account_balances/', {}, true, 1);
    const result = this._unwrapResponse(data);
    const wallets = Array.isArray(result) ? result : [];

    const balance = {
      info: result,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    for (const item of wallets) {
      const currency = safeStringUpper(item, 'currency');
      if (!currency) continue;

      const available = safeFloat(item, 'available') || 0;
      const reserved = safeFloat(item, 'reserved') || 0;
      const total = safeFloat(item, 'balance') || (available + reserved);

      if (total > 0 || available > 0) {
        balance[currency] = {
          free: available,
          used: reserved,
          total,
        };
      }
    }

    return balance;
  }

  async fetchTradingFees(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('POST', '/api/v2/fees/trading/', {}, true, 1);
    const result = this._unwrapResponse(data);
    const fees = Array.isArray(result) ? result : [];

    if (symbol) {
      const pair = this._toBitstampSymbol(symbol);
      const found = fees.find((f) => f.currency_pair === pair || f.currency_pair === symbol);

      return {
        symbol,
        maker: found ? safeFloat(found, 'maker') : 0.003,
        taker: found ? safeFloat(found, 'taker') : 0.005,
        info: result,
      };
    }

    // Return first/default tier
    const defaultFee = fees[0] || {};
    return {
      maker: safeFloat(defaultFee, 'maker') || 0.003,
      taker: safeFloat(defaultFee, 'taker') || 0.005,
      info: result,
    };
  }

  // ===========================================================================
  // WEBSOCKET — Bitstamp (Public + Private)
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

  async _subscribePublic(channel, callback) {
    const url = this.urls.ws;
    const client = await this._ensureWsConnected(url);

    const msg = {
      event: 'bts:subscribe',
      data: { channel },
    };

    client.send(msg);

    const handler = (data) => {
      if (data && data.channel === channel) {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(channel, { handler, callback });
    return channel;
  }

  async _subscribePrivate(channel, callback) {
    this.checkRequiredCredentials();

    const url = this.urls.ws;
    const client = await this._ensureWsConnected(url);

    const nonce = crypto.randomUUID();
    const timestamp = Date.now().toString();
    const payload = 'BITSTAMP ' + this.apiKey
      + 'POST'
      + 'www.bitstamp.net'
      + '/api/v2/websockets_token/'
      + nonce + timestamp + 'v2';
    const signature = hmacSHA256(payload, this.secret);

    const msg = {
      event: 'bts:subscribe',
      data: {
        channel,
        auth: {
          key: this.apiKey,
          signature,
          nonce,
          timestamp,
          version: 'v2',
        },
      },
    };

    client.send(msg);

    const handler = (data) => {
      if (data && data.channel === channel) {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(channel, { handler, callback });
    return channel;
  }

  async watchOrderBook(symbol, callback, depth = undefined) {
    const pair = this._toBitstampSymbol(symbol);
    const channel = 'order_book_' + pair;

    return this._subscribePublic(channel, (msg) => {
      if (msg.event === 'data' && msg.data) {
        const d = msg.data;
        const ts = d.timestamp ? parseInt(d.timestamp, 10) * 1000 : Date.now();
        callback({
          symbol,
          bids: (d.bids || []).map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
          asks: (d.asks || []).map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
          timestamp: ts,
          datetime: iso8601(ts),
          nonce: d.microtimestamp || undefined,
        });
      }
    });
  }

  async watchTrades(symbol, callback) {
    const pair = this._toBitstampSymbol(symbol);
    const channel = 'live_trades_' + pair;

    return this._subscribePublic(channel, (msg) => {
      if (msg.event === 'trade' && msg.data) {
        const d = msg.data;
        const ts = d.timestamp ? parseInt(d.timestamp, 10) * 1000 : Date.now();
        const side = parseInt(d.type, 10) === 0 ? 'buy' : 'sell';
        callback({
          id: safeString(d, 'id'),
          symbol,
          price: safeFloat(d, 'price'),
          amount: safeFloat(d, 'amount'),
          cost: (safeFloat(d, 'price') || 0) * (safeFloat(d, 'amount') || 0),
          side,
          timestamp: ts,
          datetime: iso8601(ts),
          info: d,
        });
      }
    });
  }

  async watchOrders(callback, symbol = undefined) {
    if (!symbol) {
      throw new ExchangeError(this.id + ' watchOrders() requires a symbol for Bitstamp');
    }

    const pair = this._toBitstampSymbol(symbol);
    const channel = 'live_orders_' + pair;

    return this._subscribePrivate(channel, (msg) => {
      if (msg.data) {
        const d = msg.data;
        const eventType = msg.event || '';
        let status = 'NEW';
        if (eventType === 'order_deleted') status = 'CANCELED';
        if (eventType === 'order_changed') status = 'PARTIALLY_FILLED';

        const ts = d.datetime ? parseDate(d.datetime) : Date.now();
        callback({
          id: safeString(d, 'id'),
          symbol,
          price: safeFloat(d, 'price'),
          amount: safeFloat(d, 'amount'),
          side: parseInt(d.order_type, 10) === 0 ? 'BUY' : 'SELL',
          status,
          event: eventType,
          timestamp: ts,
          datetime: iso8601(ts),
          info: d,
        });
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
  // PARSERS — Normalize Bitstamp responses to unified format
  // ===========================================================================

  /**
   * Parse ticker from Bitstamp REST response.
   * Input: { high, last, timestamp, bid, vwap, volume, low, ask, open }
   */
  _parseTicker(data, symbol) {
    const last = safeFloat(data, 'last');
    const open = safeFloat(data, 'open');
    const change = (last !== undefined && open !== undefined) ? last - open : undefined;
    const percentage = (change !== undefined && open) ? (change / open) * 100 : undefined;
    const ts = data.timestamp ? parseInt(data.timestamp, 10) * 1000 : Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open,
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'volume'),
      quoteVolume: undefined,
      change,
      percentage,
      vwap: safeFloat(data, 'vwap'),
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  /**
   * Parse order from Bitstamp response.
   * Input: { id, datetime, type, price, amount, currency_pair, status, ... }
   * type: 0 = buy, 1 = sell
   */
  _parseOrder(data) {
    const id = safeString(data, 'id');
    const side = this._parseOrderSide(data.type);
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'amount') || 0;
    const ts = data.datetime ? parseDate(data.datetime) : undefined;

    // Try to get symbol from currency_pair
    let symbol;
    if (data.currency_pair) {
      symbol = data.currency_pair.includes('/') ? data.currency_pair : this._fromBitstampSymbol(data.currency_pair);
    }

    const statusStr = data.status || '';
    const status = this._normalizeOrderStatus(statusStr);

    return {
      id,
      clientOrderId: undefined,
      symbol,
      type: undefined,   // Bitstamp doesn't always return order type (limit/market)
      side,
      price,
      amount,
      filled: 0,
      remaining: amount,
      cost: 0,
      average: 0,
      status: status || 'NEW',
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      trades: [],
      fee: undefined,
      info: data,
    };
  }

  /**
   * Parse public trade.
   * Input: { date, tid, price, type, amount }
   * type: 0 = buy, 1 = sell
   */
  _parseTrade(data, symbol) {
    const ts = data.date ? parseInt(data.date, 10) * 1000 : Date.now();
    const side = parseInt(data.type, 10) === 0 ? 'buy' : 'sell';
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'amount') || 0;

    return {
      id: safeString(data, 'tid'),
      symbol,
      price,
      amount,
      cost: price * amount,
      side,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  /**
   * Parse user trade (from user_transactions).
   * Input: { id, datetime, type, usd, btc, btc_usd, fee, order_id, ... }
   * type: 2 = trade
   */
  _parseMyTrade(data, symbol) {
    const ts = data.datetime ? parseDate(data.datetime) : undefined;
    const fee = safeFloat(data, 'fee') || 0;

    return {
      id: safeString(data, 'id'),
      orderId: safeString(data, 'order_id'),
      symbol,
      price: undefined,   // Need to derive from currency fields
      amount: undefined,
      cost: undefined,
      fee: {
        cost: fee,
        currency: undefined,
      },
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      side: undefined,
      info: data,
    };
  }

  /**
   * Parse OHLCV candle.
   * Input: { timestamp, open, high, low, close, volume }
   * Output: [timestamp_ms, open, high, low, close, volume]
   * Standard OHLCV order — no reorder needed (unlike Bitfinex OCHLV).
   */
  _parseCandle(c) {
    return [
      parseInt(c.timestamp, 10) * 1000,
      parseFloat(c.open),
      parseFloat(c.high),
      parseFloat(c.low),
      parseFloat(c.close),
      parseFloat(c.volume),
    ];
  }
}

module.exports = Bitstamp;

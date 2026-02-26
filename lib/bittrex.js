'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA512Hex, sha512 } = require('./utils/crypto');
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

class Bittrex extends BaseExchange {

  describe() {
    return {
      id: 'bittrex',
      name: 'Bittrex',
      version: 'v3',
      rateLimit: 1000,
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
        fetchMyTrades: false,
        fetchBalance: true,
        fetchTradingFees: true,
        // WebSocket — SignalR V3 hub "c3" (public channels only)
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: false,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://api.bittrex.com',
        ws: 'wss://socket.bittrex.com/signalr',
        doc: 'https://bittrex.github.io/api/v3',
      },
      timeframes: {
        '1m': 'MINUTE_1',
        '5m': 'MINUTE_5',
        '1h': 'HOUR_1',
        '1d': 'DAY_1',
      },
      fees: {
        trading: { maker: 0.0035, taker: 0.0035 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this.postAsFormEncoded = false;
    this._wsClients = new Map();
    this._wsInvocationId = 0;
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA512 + SHA512 content hash
  // ===========================================================================

  /**
   * Bittrex V3 authentication.
   * Signature payload: timestamp + fullUrl + method + contentHash (concatenated, NO separators)
   *
   * Content hash: SHA512 hex of body (empty string for GET/DELETE)
   * Signature: HMAC-SHA512 hex of payload using secret
   * Headers: Api-Key, Api-Timestamp, Api-Content-Hash, Api-Signature
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = Date.now().toString();
    let url = this.urls.api + path;
    let contentHash;

    if (method === 'GET' || method === 'DELETE') {
      // GET/DELETE: params go in query string, body is empty
      const qs = new URLSearchParams(params).toString();
      if (qs) url += '?' + qs;
      contentHash = sha512('');
    } else {
      // POST/PUT: params go in JSON body
      const body = (params && Object.keys(params).length > 0) ? JSON.stringify(params) : '';
      contentHash = sha512(body);
    }

    const preSign = timestamp + url + method + contentHash;
    const signature = hmacSHA512Hex(preSign, this.secret);

    const headers = {
      'Api-Key': this.apiKey,
      'Api-Timestamp': timestamp,
      'Api-Content-Hash': contentHash,
      'Api-Signature': signature,
    };

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE HANDLING — Bittrex returns JSON, errors as { code }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.code) {
        const code = data.code;
        const detail = data.detail || data.data || '';
        this._handleBittrexError(code, detail);
      }
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    // Bittrex doesn't expose detailed rate limit headers
    // Client-side throttler handles limiting
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const code = parsed?.code || '';
    const detail = parsed?.detail || parsed?.data || body;

    if (code) {
      this._handleBittrexError(code, detail);
    }

    const full = this.id + ' HTTP ' + status + ': ' + (detail || body);
    if (status === 400) throw new BadRequest(full);
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 404) throw new ExchangeError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    if (status === 500 || status === 503) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  _handleBittrexError(code, detail) {
    const full = this.id + ' ' + code + ': ' + detail;

    const errorMap = {
      // Authentication
      'INVALID_SIGNATURE': AuthenticationError,
      'APIKEY_INVALID': AuthenticationError,
      'INVALID_CONTENT_HASH': AuthenticationError,
      'APIKEY_DISABLED': AuthenticationError,
      'UNAUTHORIZED_ACCESS': AuthenticationError,

      // Market / symbol
      'MARKET_DOES_NOT_EXIST': BadSymbol,
      'INVALID_MARKET': BadSymbol,

      // Order errors
      'MIN_TRADE_REQUIREMENT_NOT_MET': InvalidOrder,
      'DUST_TRADE_DISALLOWED_MIN_VALUE': InvalidOrder,
      'ORDER_NOT_OPEN': InvalidOrder,
      'INVALID_ORDER': InvalidOrder,
      'INVALID_ORDER_TYPE': InvalidOrder,
      'ORDER_NOT_FOUND': OrderNotFound,

      // Insufficient funds
      'INSUFFICIENT_FUNDS': InsufficientFunds,

      // Rate limiting
      'RATE_LIMIT_EXCEEDED': RateLimitExceeded,
      'TOO_MANY_REQUESTS': RateLimitExceeded,

      // Bad request
      'INVALID_PARAMETER': BadRequest,
      'BAD_REQUEST': BadRequest,

      // Exchange unavailable
      'SERVICE_UNAVAILABLE': ExchangeNotAvailable,
    };

    const ErrorClass = errorMap[code] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Convert unified symbol to Bittrex format.
   * BTC/USDT → BTC-USDT
   */
  _toBittrexSymbol(symbol) {
    if (!symbol.includes('/')) return symbol;
    return symbol.replace('/', '-');
  }

  /**
   * Convert Bittrex symbol to unified format.
   * BTC-USDT → BTC/USDT (via marketsById lookup)
   */
  _fromBittrexSymbol(bittrexSymbol) {
    if (!bittrexSymbol) return bittrexSymbol;
    if (bittrexSymbol.includes('/')) return bittrexSymbol;

    // Try marketsById lookup first
    if (this.marketsById[bittrexSymbol]) {
      return this.marketsById[bittrexSymbol].symbol;
    }

    // Fallback: replace hyphen with slash
    return bittrexSymbol.replace('-', '/');
  }

  /**
   * Map unified order direction to Bittrex format.
   * buy → BUY, sell → SELL
   */
  _toBittrexDirection(side) {
    return side.toUpperCase();
  }

  /**
   * Map Bittrex direction to unified format.
   * BUY → buy, SELL → sell
   */
  _fromBittrexDirection(direction) {
    if (!direction) return undefined;
    return direction.toLowerCase();
  }

  /**
   * Map unified order type to Bittrex format.
   * limit → LIMIT, market → MARKET
   */
  _toBittrexOrderType(type) {
    return type.toUpperCase();
  }

  /**
   * Normalize Bittrex order status to unified format.
   * OPEN → NEW, CLOSED → FILLED, CANCELLED → CANCELED
   */
  _normalizeOrderStatus(status) {
    if (!status) return status;
    const map = {
      'OPEN': 'NEW',
      'CLOSED': 'FILLED',
      'CANCELLED': 'CANCELED',
      'COMPLETED': 'FILLED',
    };
    return map[status.toUpperCase()] || status.toUpperCase();
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    const data = await this._request('GET', '/v3/ping', {}, false, 1);
    if (data && data.serverTime) {
      return data.serverTime;
    }
    return Date.now();
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (6 endpoints, all GET, unsigned)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/v3/markets', {}, false, 1);
    const pairs = Array.isArray(data) ? data : [];

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const item of pairs) {
      const id = item.symbol;                    // "BTC-USDT"
      const base = item.baseCurrencySymbol;      // "BTC"
      const quote = item.quoteCurrencySymbol;    // "USDT"
      const symbol = base + '/' + quote;
      const status = item.status;                // "ONLINE", "OFFLINE"
      const active = status === 'ONLINE';

      const market = {
        id,
        symbol,
        base,
        quote,
        active,
        precision: {
          price: safeInteger(item, 'precision') || 8,
          amount: safeInteger(item, 'precision') || 8,
          base: safeInteger(item, 'precision') || 8,
          quote: safeInteger(item, 'precision') || 8,
        },
        limits: {
          amount: {
            min: safeFloat(item, 'minTradeSize'),
            max: undefined,
          },
          price: {
            min: undefined,
            max: undefined,
          },
          cost: {
            min: undefined,
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
    const pair = this._toBittrexSymbol(symbol);

    // Fetch both ticker (bid/ask/last) and summary (high/low/volume) in parallel
    const [ticker, summary] = await Promise.all([
      this._request('GET', '/v3/markets/' + pair + '/ticker', params, false, 1),
      this._request('GET', '/v3/markets/' + pair + '/summary', params, false, 1),
    ]);

    this._unwrapResponse(ticker);
    this._unwrapResponse(summary);

    return this._parseTicker(ticker, summary, symbol);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    // Bittrex has bulk endpoints for all tickers and summaries
    const [tickers, summaries] = await Promise.all([
      this._request('GET', '/v3/markets/tickers', params, false, 1),
      this._request('GET', '/v3/markets/summaries', params, false, 1),
    ]);

    const tickerList = Array.isArray(tickers) ? tickers : [];
    const summaryList = Array.isArray(summaries) ? summaries : [];

    // Index summaries by symbol for fast lookup
    const summaryMap = {};
    for (const s of summaryList) {
      if (s.symbol) summaryMap[s.symbol] = s;
    }

    const result = {};
    for (const t of tickerList) {
      const bittrexSymbol = t.symbol;
      const unified = this._fromBittrexSymbol(bittrexSymbol);

      if (symbols && !symbols.includes(unified)) continue;

      const summary = summaryMap[bittrexSymbol] || {};
      result[unified] = this._parseTicker(t, summary, unified);
    }

    return result;
  }

  async fetchOrderBook(symbol, limit = undefined, params = {}) {
    const pair = this._toBittrexSymbol(symbol);
    const request = { ...params };
    if (limit) request.depth = limit;

    const data = await this._request('GET', '/v3/markets/' + pair + '/orderbook', request, false, 1);
    const result = this._unwrapResponse(data);

    // Response: { bid: [{ quantity, rate }], ask: [{ quantity, rate }] }
    const bids = (result.bid || []).map((b) => [parseFloat(b.rate), parseFloat(b.quantity)]);
    const asks = (result.ask || []).map((a) => [parseFloat(a.rate), parseFloat(a.quantity)]);
    const ts = Date.now();

    return {
      symbol,
      bids,
      asks,
      timestamp: ts,
      datetime: iso8601(ts),
      nonce: undefined,
    };
  }

  async fetchTrades(symbol, since = undefined, limit = undefined, params = {}) {
    const pair = this._toBittrexSymbol(symbol);

    const data = await this._request('GET', '/v3/markets/' + pair + '/trades', params, false, 1);
    const result = this._unwrapResponse(data);
    const trades = Array.isArray(result) ? result : [];

    const parsed = trades.map((t) => this._parseTrade(t, symbol));
    return limit ? parsed.slice(0, limit) : parsed;
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = undefined, params = {}) {
    const pair = this._toBittrexSymbol(symbol);
    const interval = this.timeframes[timeframe] || timeframe;

    // Bittrex uses /candles/TRADE/{interval}/recent for recent candles
    const path = '/v3/markets/' + pair + '/candles/TRADE/' + interval + '/recent';

    const data = await this._request('GET', path, params, false, 1);
    const result = this._unwrapResponse(data);
    const candles = Array.isArray(result) ? result : [];

    const parsed = candles.map((c) => this._parseCandle(c));

    // Apply limit if specified
    if (limit && parsed.length > limit) {
      return parsed.slice(parsed.length - limit);
    }
    return parsed;
  }

  // ===========================================================================
  // TRADING — PRIVATE (POST/GET/DELETE, signed)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const pair = this._toBittrexSymbol(symbol);
    const direction = this._toBittrexDirection(side);
    const orderType = this._toBittrexOrderType(type);

    const request = {
      marketSymbol: pair,
      direction,
      type: orderType,
      quantity: String(amount),
      ...params,
    };

    if (orderType === 'LIMIT' && price !== undefined) {
      request.limit = String(price);
      request.timeInForce = request.timeInForce || 'GOOD_TIL_CANCELLED';
    } else if (orderType === 'MARKET') {
      request.timeInForce = request.timeInForce || 'IMMEDIATE_OR_CANCEL';
    }

    const data = await this._request('POST', '/v3/orders', request, true, 1);
    const result = this._unwrapResponse(data);

    return this._parseOrder(result, symbol);
  }

  async createLimitOrder(symbol, side, amount, price, params = {}) {
    return this.createOrder(symbol, 'LIMIT', side, amount, price, params);
  }

  async createMarketOrder(symbol, side, amount, params = {}) {
    return this.createOrder(symbol, 'MARKET', side, amount, undefined, params);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('DELETE', '/v3/orders/' + id, params, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'id') || String(id),
      symbol: symbol || (result.marketSymbol ? this._fromBittrexSymbol(result.marketSymbol) : undefined),
      status: 'CANCELED',
      info: result,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { ...params };
    if (symbol) {
      request.marketSymbol = this._toBittrexSymbol(symbol);
    }

    const data = await this._request('DELETE', '/v3/orders/open', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      info: result,
    };
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/v3/orders/' + id, params, true, 1);
    const result = this._unwrapResponse(data);

    if (!result || (!result.id && !result.status)) {
      throw new OrderNotFound(this.id + ' order not found: ' + id);
    }

    return this._parseOrder(result, symbol);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { ...params };
    if (symbol) {
      request.marketSymbol = this._toBittrexSymbol(symbol);
    }

    const data = await this._request('GET', '/v3/orders/open', request, true, 1);
    const result = this._unwrapResponse(data);
    const orders = Array.isArray(result) ? result : [];

    return orders.map((o) => this._parseOrder(o));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { ...params };
    if (symbol) {
      request.marketSymbol = this._toBittrexSymbol(symbol);
    }
    if (limit) {
      request.pageSize = limit;
    }
    if (since) {
      request.startDate = iso8601(since);
    }

    const data = await this._request('GET', '/v3/orders/closed', request, true, 1);
    const result = this._unwrapResponse(data);
    const orders = Array.isArray(result) ? result : [];

    return orders.map((o) => this._parseOrder(o));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints, GET, signed)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/v3/account/balances', {}, true, 1);
    const result = this._unwrapResponse(data);
    const wallets = Array.isArray(result) ? result : [];

    const balance = {
      info: result,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    for (const item of wallets) {
      const currency = safeStringUpper(item, 'currencySymbol');
      if (!currency) continue;

      const total = safeFloat(item, 'total') || 0;
      const available = safeFloat(item, 'available') || 0;
      const used = total - available;

      if (total > 0 || available > 0) {
        balance[currency] = {
          free: available,
          used: used >= 0 ? used : 0,
          total,
        };
      }
    }

    return balance;
  }

  async fetchTradingFees(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/v3/account/fees/trading', {}, true, 1);
    const result = this._unwrapResponse(data);
    const fees = Array.isArray(result) ? result : [];

    if (symbol) {
      const pair = this._toBittrexSymbol(symbol);
      const found = fees.find((f) => f.marketSymbol === pair);

      return {
        symbol,
        maker: found ? safeFloat(found, 'makerRate') : 0.0035,
        taker: found ? safeFloat(found, 'takerRate') : 0.0035,
        info: result,
      };
    }

    // Return first/default tier
    const defaultFee = fees[0] || {};
    return {
      maker: safeFloat(defaultFee, 'makerRate') || 0.0035,
      taker: safeFloat(defaultFee, 'takerRate') || 0.0035,
      info: result,
    };
  }

  // ===========================================================================
  // WEBSOCKET — Bittrex V3 SignalR hub "c3" (Public channels)
  // ===========================================================================

  /**
   * Bittrex V3 WebSocket uses SignalR protocol over raw WebSocket.
   * URL: wss://socket.bittrex.com/signalr
   * Hub: "c3"
   * Subscribe: {"H":"c3","M":"Subscribe","A":[["channel_name"]],"I":1}
   * Unsubscribe: {"H":"c3","M":"Unsubscribe","A":[["channel_name"]],"I":2}
   *
   * Incoming messages: {"C":"...","M":[{"H":"C3","M":"method","A":["data"]}]}
   * Channels: ticker_{pair}, orderbook_{pair}_{depth}, trade_{pair}
   */

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

  /**
   * Subscribe to Bittrex channels via SignalR hub invocation.
   * Sends: {"H":"c3","M":"Subscribe","A":[["channel1","channel2"]],"I":id}
   * Handles incoming hub messages dispatching to callback(method, payload).
   */
  async _subscribeBittrex(channels, callback) {
    const url = this.urls.ws;
    const client = await this._ensureWsConnected(url);

    const id = ++this._wsInvocationId;
    const subMsg = {
      H: 'c3',
      M: 'Subscribe',
      A: [channels],
      I: id,
    };

    client.send(subMsg);

    const handler = (data) => {
      // SignalR hub message: { C: "cursor", M: [{ H: "C3", M: "method", A: ["data"] }] }
      if (data && data.M && Array.isArray(data.M)) {
        for (const m of data.M) {
          if (m.A && m.A.length > 0) {
            let payload;
            try {
              payload = typeof m.A[0] === 'string' ? JSON.parse(m.A[0]) : m.A[0];
            } catch {
              payload = m.A[0];
            }
            callback(m.M, payload);
          }
        }
      }
    };

    client.on('message', handler);
    const channelKey = channels.join(',');
    this._wsHandlers.set(channelKey, { handler, callback });
    return channelKey;
  }

  /**
   * Watch ticker via WebSocket.
   * Channel: ticker_{pair} (e.g., ticker_BTC-USDT)
   * Data: { symbol, lastTradeRate, bidRate, askRate }
   */
  async watchTicker(symbol, callback) {
    const pair = this._toBittrexSymbol(symbol);
    const channel = 'ticker_' + pair;

    return this._subscribeBittrex([channel], (method, data) => {
      if (method === 'ticker') {
        callback(this._parseWsTicker(data, symbol));
      }
    });
  }

  /**
   * Watch order book via WebSocket.
   * Channel: orderbook_{pair}_{depth} (e.g., orderbook_BTC-USDT_25)
   * Data: { marketSymbol, depth, sequence, bidDeltas: [{quantity,rate}], askDeltas: [{quantity,rate}] }
   */
  async watchOrderBook(symbol, callback, depth = 25) {
    const pair = this._toBittrexSymbol(symbol);
    const channel = 'orderbook_' + pair + '_' + depth;

    return this._subscribeBittrex([channel], (method, data) => {
      if (method === 'orderBook') {
        callback(this._parseWsOrderBook(data, symbol));
      }
    });
  }

  /**
   * Watch trades via WebSocket.
   * Channel: trade_{pair} (e.g., trade_BTC-USDT)
   * Data: { deltas: [{ id, executedAt, quantity, rate, takerSide }] }
   */
  async watchTrades(symbol, callback) {
    const pair = this._toBittrexSymbol(symbol);
    const channel = 'trade_' + pair;

    return this._subscribeBittrex([channel], (method, data) => {
      if (method === 'trade') {
        const trades = this._parseWsTrades(data, symbol);
        for (const trade of trades) {
          callback(trade);
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
  // PARSERS — Normalize Bittrex responses to unified format
  // ===========================================================================

  /**
   * Parse ticker from Bittrex REST response.
   * Combines ticker and summary data for complete unified ticker.
   * Ticker: { symbol, lastTradeRate, bidRate, askRate }
   * Summary: { symbol, high, low, volume, quoteVolume, percentChange, updatedAt }
   */
  _parseTicker(ticker, summary, symbol) {
    const last = safeFloat(ticker, 'lastTradeRate');
    const high = safeFloat(summary, 'high');
    const low = safeFloat(summary, 'low');
    const volume = safeFloat(summary, 'volume');
    const quoteVolume = safeFloat(summary, 'quoteVolume');
    const percentage = safeFloat(summary, 'percentChange');
    const ts = summary.updatedAt ? parseDate(summary.updatedAt) : Date.now();

    return {
      symbol,
      last,
      high,
      low,
      open: undefined,
      close: last,
      bid: safeFloat(ticker, 'bidRate'),
      bidVolume: undefined,
      ask: safeFloat(ticker, 'askRate'),
      askVolume: undefined,
      volume,
      quoteVolume,
      change: undefined,
      percentage,
      vwap: undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: { ticker, summary },
    };
  }

  /**
   * Parse order from Bittrex response.
   * Input: { id, marketSymbol, direction, type, quantity, limit, status,
   *          createdAt, closedAt, fillQuantity, proceeds, commission, timeInForce }
   */
  _parseOrder(data, fallbackSymbol) {
    const id = safeString(data, 'id');
    const direction = safeString(data, 'direction');
    const side = this._fromBittrexDirection(direction);
    const type = safeStringLower(data, 'type');
    const price = safeFloat(data, 'limit') || 0;
    const amount = safeFloat(data, 'quantity') || 0;
    const filled = safeFloat(data, 'fillQuantity') || 0;
    const remaining = amount - filled;
    const cost = safeFloat(data, 'proceeds') || 0;
    const average = filled > 0 ? cost / filled : 0;
    const feeCost = safeFloat(data, 'commission') || 0;

    const statusStr = safeString(data, 'status') || '';
    const status = this._normalizeOrderStatus(statusStr);

    let symbol = fallbackSymbol;
    if (data.marketSymbol) {
      symbol = this._fromBittrexSymbol(data.marketSymbol);
    }

    const ts = data.createdAt ? parseDate(data.createdAt) : undefined;

    return {
      id,
      clientOrderId: undefined,
      symbol,
      type,
      side,
      price,
      amount,
      filled,
      remaining: remaining >= 0 ? remaining : 0,
      cost,
      average,
      status: status || 'NEW',
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      trades: [],
      fee: feeCost > 0 ? { cost: feeCost, currency: undefined } : undefined,
      info: data,
    };
  }

  /**
   * Parse public trade.
   * Input: { id, executedAt, quantity, rate, takerSide }
   * takerSide: "BUY" / "SELL"
   */
  _parseTrade(data, symbol) {
    const ts = data.executedAt ? parseDate(data.executedAt) : Date.now();
    const side = data.takerSide ? data.takerSide.toLowerCase() : undefined;
    const price = safeFloat(data, 'rate') || 0;
    const amount = safeFloat(data, 'quantity') || 0;

    return {
      id: safeString(data, 'id'),
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
   * Parse OHLCV candle.
   * Input: { startsAt, open, high, low, close, volume, quoteVolume }
   * Output: [timestamp_ms, open, high, low, close, volume]
   */
  _parseCandle(c) {
    return [
      parseDate(c.startsAt),
      parseFloat(c.open),
      parseFloat(c.high),
      parseFloat(c.low),
      parseFloat(c.close),
      parseFloat(c.volume),
    ];
  }

  // ===========================================================================
  // WS PARSERS — Normalize Bittrex V3 SignalR WebSocket data
  // ===========================================================================

  /**
   * Parse WS ticker.
   * Input: { symbol, lastTradeRate, bidRate, askRate }
   */
  _parseWsTicker(data, symbol) {
    return {
      symbol,
      last: safeFloat(data, 'lastTradeRate'),
      bid: safeFloat(data, 'bidRate'),
      ask: safeFloat(data, 'askRate'),
      high: undefined,
      low: undefined,
      open: undefined,
      close: safeFloat(data, 'lastTradeRate'),
      volume: undefined,
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  /**
   * Parse WS order book delta.
   * Input: { marketSymbol, depth, sequence, bidDeltas: [{quantity,rate}], askDeltas: [{quantity,rate}] }
   */
  _parseWsOrderBook(data, symbol) {
    const bids = (data.bidDeltas || []).map((b) => [parseFloat(b.rate), parseFloat(b.quantity)]);
    const asks = (data.askDeltas || []).map((a) => [parseFloat(a.rate), parseFloat(a.quantity)]);
    const ts = Date.now();

    return {
      symbol,
      bids,
      asks,
      timestamp: ts,
      datetime: iso8601(ts),
      nonce: safeInteger(data, 'sequence'),
    };
  }

  /**
   * Parse WS trade deltas.
   * Input: { deltas: [{ id, executedAt, quantity, rate, takerSide }] }
   * Returns array of parsed trades.
   */
  _parseWsTrades(data, symbol) {
    const deltas = data.deltas || [data];
    return deltas.map((t) => {
      const ts = t.executedAt ? parseDate(t.executedAt) : Date.now();
      const price = safeFloat(t, 'rate') || 0;
      const amount = safeFloat(t, 'quantity') || 0;

      return {
        id: safeString(t, 'id'),
        symbol,
        price,
        amount,
        cost: price * amount,
        side: t.takerSide ? t.takerSide.toLowerCase() : undefined,
        timestamp: ts,
        datetime: iso8601(ts),
        info: t,
      };
    });
  }
}

module.exports = Bittrex;

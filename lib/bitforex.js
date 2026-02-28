'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeFloat2, safeString2,
  buildQuery, iso8601,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Bitforex extends BaseExchange {
  describe() {
    return {
      id: 'bitforex',
      name: 'Bitforex',
      version: 'v1',
      rateLimit: 100,
      rateLimitCapacity: 60,
      rateLimitInterval: 10000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: true,
        fetchTickers: false,
        fetchOrderBook: true,
        fetchTrades: true,
        fetchOHLCV: true,
        fetchTime: true,
        // Private
        createOrder: true,
        createLimitOrder: true,
        createMarketOrder: false,
        cancelOrder: true,
        cancelAllOrders: false,
        fetchOrder: true,
        fetchOpenOrders: false,
        fetchClosedOrders: false,
        fetchMyTrades: false,
        fetchBalance: true,
        fetchTradingFees: false,
        // WebSocket
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: true,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://api.bitforex.com',
        ws: 'wss://www.bitforex.com/mkapi/coinGroup1/ws',
        doc: 'https://github.com/githubdev2020/API_Doc_en/wiki',
      },
      timeframes: {
        '1m': '1min',
        '5m': '5min',
        '15m': '15min',
        '30m': '30min',
        '1h': '1hour',
        '1d': '1day',
        '1w': '1week',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(config = {}) {
    super(config);
    // Bitforex: POST params go in query string (default BaseExchange behavior)
    this.postAsJson = false;
    this.postAsFormEncoded = false;
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ---------------------------------------------------------------------------
  // Authentication — path-based HMAC-SHA256, all auth in query params
  // ---------------------------------------------------------------------------

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    params.accessKey = this.apiKey;
    params.nonce = Date.now();

    // buildQuery: sorted alphabetically + URL-encoded
    const sortedQS = buildQuery(params);

    // Signing string includes the endpoint path (unique to Bitforex!)
    const signingString = path + '?' + sortedQS;
    const signData = hmacSHA256(signingString, this.secret);

    // signData goes into params → sent as query string by BaseExchange
    params.signData = signData;

    // No special auth headers (unlike Binance X-MBX-APIKEY)
    return { params, headers: {} };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — coin-{quote}-{base} format
  // ---------------------------------------------------------------------------

  _toBitforexSymbol(symbol) {
    // 'BTC/USDT' → 'coin-usdt-btc'
    const parts = symbol.split('/');
    const base = parts[0].toLowerCase();
    const quote = parts[1].toLowerCase();
    return 'coin-' + quote + '-' + base;
  }

  _fromBitforexSymbol(bitforexSymbol) {
    // 'coin-usdt-btc' → 'BTC/USDT' (via marketsById lookup)
    if (this.marketsById && this.marketsById[bitforexSymbol]) {
      return this.marketsById[bitforexSymbol].symbol;
    }
    // Fallback: parse directly — coin-{quote}-{base}
    const parts = bitforexSymbol.split('-');
    if (parts.length === 3 && parts[0] === 'coin') {
      return parts[2].toUpperCase() + '/' + parts[1].toUpperCase();
    }
    return bitforexSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling — { success: true/false, data: {...}, time: 123 }
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object') {
      if (data.success === false) {
        const code = safeString(data, 'code') || 'unknown';
        const msg = safeString(data, 'msg') || 'Unknown error';
        this._handleBitforexError(code, msg);
      }
    }
    // Extract the actual payload from the wrapper
    return (data && data.data !== undefined) ? data.data : data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling — string error codes
  // ---------------------------------------------------------------------------

  _handleBitforexError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const errorMap = {
      '1003': BadRequest,
      '1004': AuthenticationError,
      '1005': AuthenticationError,
      '1015': RateLimitExceeded,
      '3002': InsufficientFunds,
      '4001': InvalidOrder,
      '4002': OrderNotFound,
      'MK101': BadSymbol,
      'MK102': BadRequest,
      'MK103': BadRequest,
      '10017': AuthenticationError,
      '10030': AuthenticationError,
    };
    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && parsed.success === false) {
      const code = safeString(parsed, 'code') || 'unknown';
      const msg = safeString(parsed, 'msg') || body;
      this._handleBitforexError(code, msg);
    }

    const full = this.id + ' HTTP ' + statusCode + ': ' + body;
    if (statusCode === 400) throw new BadRequest(full);
    if (statusCode === 401 || statusCode === 403) throw new AuthenticationError(full);
    if (statusCode === 404) throw new ExchangeError(full);
    if (statusCode === 429 || statusCode === 418) throw new RateLimitExceeded(full);
    if (statusCode >= 500) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  _parseTicker(data, symbol) {
    return {
      symbol,
      last: safeFloat(data, 'last'),
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: undefined,
      close: safeFloat(data, 'last'),
      bid: safeFloat(data, 'buy'),
      bidVolume: undefined,
      ask: safeFloat(data, 'sell'),
      askVolume: undefined,
      volume: safeFloat(data, 'vol'),
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      timestamp: safeInteger(data, 'ts') || Date.now(),
      datetime: iso8601(safeInteger(data, 'ts') || Date.now()),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const amount = safeFloat(data, 'orderAmount') || 0;
    const filled = safeFloat(data, 'dealAmount') || 0;
    const price = safeFloat(data, 'orderPrice') || 0;
    const avgPrice = safeFloat(data, 'avgPrice') || price;
    const tradeType = safeInteger(data, 'tradeType');

    return {
      id: safeString(data, 'orderId'),
      clientOrderId: undefined,
      symbol: fallbackSymbol,
      type: 'LIMIT',
      side: tradeType === 1 ? 'BUY' : 'SELL',
      price,
      amount,
      filled,
      remaining: amount - filled,
      cost: filled * avgPrice,
      average: avgPrice,
      status: this._normalizeOrderStatus(safeInteger(data, 'orderState')),
      timestamp: safeInteger(data, 'createTime'),
      datetime: iso8601(safeInteger(data, 'createTime')),
      info: data,
    };
  }

  _normalizeOrderStatus(state) {
    const map = {
      0: 'open',
      1: 'open',
      2: 'closed',
      3: 'canceled',
      4: 'canceled',
    };
    return map[state] !== undefined ? map[state] : 'open';
  }

  _parseTrade(data, symbol) {
    const p = safeFloat(data, 'price') || 0;
    const q = safeFloat(data, 'amount') || 0;
    const direction = safeInteger(data, 'direction');
    return {
      id: safeString(data, 'tid'),
      symbol,
      price: p,
      amount: q,
      cost: p * q,
      side: direction === 1 ? 'buy' : 'sell',
      timestamp: safeInteger(data, 'time'),
      datetime: iso8601(safeInteger(data, 'time')),
      info: data,
    };
  }

  _parseCandle(k) {
    return {
      timestamp: safeInteger(k, 'time'),
      open: safeFloat(k, 'open'),
      high: safeFloat(k, 'high'),
      low: safeFloat(k, 'low'),
      close: safeFloat(k, 'close'),
      volume: safeFloat(k, 'vol'),
    };
  }

  _parseOrderBook(data, symbol) {
    // Bitforex uses objects: {price, amount} — not arrays
    return {
      symbol,
      bids: (data.bids || []).map(entry => [entry.price, entry.amount]),
      asks: (data.asks || []).map(entry => [entry.price, entry.amount]),
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
      info: data,
    };
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data
  // ---------------------------------------------------------------------------

  async fetchTime() {
    const data = await this._request('GET', '/api/v1/time', {}, false, 1);
    const result = this._unwrapResponse(data);
    return result;
  }

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v1/market/symbols', {}, false, 10);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const s of (result || [])) {
      const id = s.symbol;
      const parts = id.split('-');
      if (parts.length !== 3 || parts[0] !== 'coin') continue;

      const base = parts[2].toUpperCase();
      const quote = parts[1].toUpperCase();
      const symbol = base + '/' + quote;

      const market = {
        id,
        symbol,
        base,
        quote,
        active: true,
        precision: {
          price: safeInteger(s, 'pricePrecision'),
          amount: safeInteger(s, 'amountPrecision'),
        },
        limits: {
          price: { min: safeFloat(s, 'minOrderPrice'), max: undefined },
          amount: { min: safeFloat(s, 'minOrderAmount'), max: undefined },
        },
        info: s,
      };

      this.markets[symbol] = market;
      this.marketsById[id] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol) {
    const params = { symbol: this._toBitforexSymbol(symbol) };
    const data = await this._request('GET', '/api/v1/market/ticker', params, false, 1);
    const result = this._unwrapResponse(data);
    return this._parseTicker(result, symbol);
  }

  async fetchOrderBook(symbol, limit = 10) {
    const params = { symbol: this._toBitforexSymbol(symbol), size: limit };
    const data = await this._request('GET', '/api/v1/market/depth', params, false, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderBook(result, symbol);
  }

  async fetchTrades(symbol, since = undefined, limit = 50) {
    const params = { symbol: this._toBitforexSymbol(symbol), size: limit };
    const data = await this._request('GET', '/api/v1/market/trades', params, false, 1);
    const result = this._unwrapResponse(data);
    return (Array.isArray(result) ? result : []).map(t => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1m', since = undefined, limit = 100) {
    const kType = this.timeframes[timeframe];
    if (!kType) throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);

    const params = {
      symbol: this._toBitforexSymbol(symbol),
      kType,
      size: limit,
    };
    const data = await this._request('GET', '/api/v1/market/kline', params, false, 1);
    const result = this._unwrapResponse(data);
    return (Array.isArray(result) ? result : []).map(k => this._parseCandle(k));
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    if (type && type.toUpperCase() === 'MARKET') {
      throw new InvalidOrder(this.id + ' does not support market orders — price is always required');
    }
    if (price === undefined || price === null) {
      throw new InvalidOrder(this.id + ' createOrder requires price (only limit orders supported)');
    }

    const tradeType = side.toUpperCase() === 'BUY' ? 1 : 2;
    const request = {
      symbol: this._toBitforexSymbol(symbol),
      tradeType,
      amount: String(amount),
      price: String(price),
      ...params,
    };

    const data = await this._request('POST', '/api/v1/trade/placeOrder', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'orderId'),
      symbol,
      type: 'LIMIT',
      side: side.toUpperCase(),
      price: parseFloat(price),
      amount: parseFloat(amount),
      filled: 0,
      remaining: parseFloat(amount),
      status: 'open',
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: result,
    };
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder requires symbol');

    const request = {
      symbol: this._toBitforexSymbol(symbol),
      orderId: id,
      ...params,
    };

    const data = await this._request('POST', '/api/v1/trade/cancelOrder', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id,
      symbol,
      status: 'canceled',
      info: result,
    };
  }

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('POST', '/api/v1/fund/allAccount', { ...params }, true, 5);
    const result = this._unwrapResponse(data);

    const balance = { info: result, timestamp: Date.now(), datetime: iso8601(Date.now()) };
    for (const b of (Array.isArray(result) ? result : [])) {
      const currency = safeString(b, 'currency');
      if (!currency) continue;
      const free = safeFloat(b, 'active') || 0;
      const used = safeFloat(b, 'frozen') || 0;
      if (free > 0 || used > 0) {
        balance[currency.toUpperCase()] = { free, used, total: free + used };
      }
    }
    return balance;
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder requires symbol');

    const request = {
      symbol: this._toBitforexSymbol(symbol),
      orderId: id,
      ...params,
    };

    const data = await this._request('POST', '/api/v1/trade/orderInfo', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrder(result, symbol);
  }

  // ---------------------------------------------------------------------------
  // WebSocket — plain text JSON, string ping "ping_p"
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 10000 });

    // Override _startPing: Bitforex uses string "ping_p" (not JSON, not binary)
    client._startPing = function () {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send('ping_p');
        }
      }, this.pingInterval);
    };

    // Override connect: plain text JSON, filter out "pong_p"
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);
      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          if (typeof this._resetPongTimer === 'function') this._resetPongTimer();
          const text = raw.toString();
          // Ignore pong responses
          if (text === 'pong_p') return;
          try {
            const data = JSON.parse(text);
            this.emit('message', data);
          } catch (e) {
            this.emit('error', e);
          }
        });
      }
    };

    this._wsClients.set(wsUrl, client);
    return client;
  }

  async _ensureWsConnected(url) {
    const client = this._getWsClient(url);
    if (!client.connected) {
      await client.connect();
    }
    return client;
  }

  async _subscribeBitforex(event, businessType, callback) {
    const client = await this._ensureWsConnected();

    // Bitforex subscribe format: JSON array
    const subMsg = [{
      type: 'subHq',
      event,
      param: { businessType, dType: 0 },
    }];
    client.send(subMsg);

    const channelId = event + ':' + businessType;
    const handler = (data) => {
      if (data && data.event === event) {
        const bt = data.param && data.param.businessType;
        if (bt === businessType) {
          callback(data);
        }
      }
    };
    client.on('message', handler);
    this._wsHandlers.set(channelId, { handler, callback });
    return channelId;
  }

  // ---------------------------------------------------------------------------
  // WS Watch Methods
  // ---------------------------------------------------------------------------

  async watchTicker(symbol, callback) {
    const bt = this._toBitforexSymbol(symbol);
    return this._subscribeBitforex('ticker', bt, (msg) => {
      if (msg.data) {
        callback(this._parseWsTicker(msg.data, symbol));
      }
    });
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    const bt = this._toBitforexSymbol(symbol);
    return this._subscribeBitforex('depth10', bt, (msg) => {
      if (msg.data) {
        callback(this._parseWsOrderBook(msg.data, symbol));
      }
    });
  }

  async watchTrades(symbol, callback) {
    const bt = this._toBitforexSymbol(symbol);
    return this._subscribeBitforex('trade', bt, (msg) => {
      if (msg.data) {
        const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
        callback(trades.map(t => this._parseWsTrade(t, symbol)));
      }
    });
  }

  async watchKlines(symbol, timeframe, callback) {
    const kType = this.timeframes[timeframe];
    if (!kType) throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);
    const bt = this._toBitforexSymbol(symbol);
    return this._subscribeBitforex('kline_' + kType, bt, (msg) => {
      if (msg.data) {
        callback(this._parseWsKline(msg.data, symbol));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsTicker(data, symbol) {
    return {
      symbol,
      last: safeFloat(data, 'last'),
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: undefined,
      close: safeFloat(data, 'last'),
      bid: safeFloat(data, 'buy'),
      ask: safeFloat(data, 'sell'),
      volume: safeFloat(data, 'vol'),
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  _parseWsOrderBook(data, symbol) {
    // Bitforex depth uses objects: {price, amount} — not arrays
    const bids = (data.bids || []).map(entry => [entry.price, entry.amount]);
    const asks = (data.asks || []).map(entry => [entry.price, entry.amount]);
    return {
      symbol,
      bids,
      asks,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
      info: data,
    };
  }

  _parseWsTrade(data, symbol) {
    const direction = safeInteger(data, 'direction');
    return {
      id: safeString(data, 'tid'),
      symbol,
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'amount'),
      side: direction === 1 ? 'buy' : 'sell',
      timestamp: safeInteger(data, 'time'),
      datetime: iso8601(safeInteger(data, 'time')),
      info: data,
    };
  }

  _parseWsKline(data, symbol) {
    return {
      symbol,
      timestamp: safeInteger(data, 'time'),
      open: safeFloat(data, 'open'),
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      close: safeFloat(data, 'close'),
      volume: safeFloat(data, 'vol'),
      info: data,
    };
  }

  // ---------------------------------------------------------------------------
  // Close WebSocket
  // ---------------------------------------------------------------------------

  async closeAllWs() {
    for (const [, client] of this._wsClients) {
      await client.close();
    }
    this._wsClients.clear();
    this._wsHandlers.clear();
  }
}

module.exports = Bitforex;

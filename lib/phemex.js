'use strict';

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

class Phemex extends BaseExchange {

  describe() {
    return {
      id: 'phemex',
      name: 'Phemex',
      version: 'v1',
      rateLimit: 100,
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
        api: 'https://api.phemex.com',
        ws: 'wss://phemex.com/ws',
        doc: 'https://phemex-docs.github.io/',
      },
      timeframes: {
        '1m': 60,
        '5m': 300,
        '15m': 900,
        '30m': 1800,
        '1h': 3600,
        '4h': 14400,
        '1d': 86400,
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this._wsClients = new Map();
    this._wsIdCounter = 1;
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA256 with Base64-decoded secret
  // ===========================================================================

  /**
   * Phemex authentication.
   *
   * Signing flow:
   * - GET/DELETE: message = path + queryString + expiry
   * - POST/PUT: message = path + expiry + body
   * - Secret key is Base64-decoded before use as HMAC key
   * - Expiry is Unix epoch in SECONDS (not milliseconds)
   * - Signature: HMAC-SHA256(message, base64decode(secret)).hex()
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const expiry = Math.floor(Date.now() / 1000) + 60;
    let message;
    let signedParams = params;

    if (method === 'GET' || method === 'DELETE') {
      // Sort params alphabetically for consistent signing
      const sorted = Object.keys(params).sort();
      const qs = sorted.map((k) => `${k}=${params[k]}`).join('&');
      message = path + qs + expiry;
    } else {
      // POST/PUT: sign path + expiry + JSON body
      const body = (params && Object.keys(params).length > 0)
        ? JSON.stringify(params) : '';
      message = path + expiry + body;
    }

    // Secret is Base64-encoded, decode before HMAC
    const decodedSecret = Buffer.from(this.secret, 'base64');
    const signature = hmacSHA256(message, decodedSecret);

    const headers = {
      'x-phemex-access-token': this.apiKey,
      'x-phemex-request-expiry': expiry.toString(),
      'x-phemex-request-signature': signature,
      'Content-Type': 'application/json',
    };

    return { params: signedParams, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // VALUE SCALING — Phemex uses 10^8 (Ep/Ev) for prices and quantities
  // ===========================================================================

  _scaleToEp(value) {
    return Math.round(value * 1e8);
  }

  _scaleFromEp(value) {
    if (value === undefined || value === null) return undefined;
    return value / 1e8;
  }

  // ===========================================================================
  // SYMBOL HELPERS
  // ===========================================================================

  /**
   * Convert unified symbol to Phemex format: BTC/USDT → sBTCUSDT
   */
  _toPhemexSymbol(symbol) {
    return 's' + symbol.replace('/', '');
  }

  /**
   * Convert Phemex symbol to unified format: sBTCUSDT → BTC/USDT
   */
  _fromPhemexSymbol(phemexSymbol) {
    if (this.marketsById && this.marketsById[phemexSymbol]) {
      return this.marketsById[phemexSymbol].symbol;
    }
    // Fallback: strip 's' prefix and try to find separator
    const raw = phemexSymbol.startsWith('s') ? phemexSymbol.slice(1) : phemexSymbol;
    // Common quote currencies to detect the split point
    const quotes = ['USDT', 'USDC', 'BTC', 'ETH', 'DAI', 'BUSD'];
    for (const quote of quotes) {
      if (raw.endsWith(quote) && raw.length > quote.length) {
        const base = raw.slice(0, raw.length - quote.length);
        return base + '/' + quote;
      }
    }
    return raw;
  }

  /**
   * Convert unified order side to Phemex PascalCase: buy → Buy, sell → Sell
   */
  _toPhemexSide(side) {
    return side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();
  }

  /**
   * Convert Phemex order side to unified: Buy → buy, Sell → sell
   */
  _fromPhemexSide(side) {
    return side ? side.toLowerCase() : side;
  }

  /**
   * Map unified order status to normalized status.
   */
  _normalizeOrderStatus(status) {
    const map = {
      'New': 'open',
      'PartiallyFilled': 'open',
      'Filled': 'closed',
      'Canceled': 'canceled',
      'Rejected': 'rejected',
      'Untriggered': 'open',
      'Triggered': 'open',
    };
    return map[status] || 'open';
  }

  // ===========================================================================
  // RESPONSE HANDLING
  // ===========================================================================

  /**
   * Unwrap Phemex response.
   * REST data: { code: 0, msg: '', data: ... }
   * Market data: { error: null, id: 0, result: { ... } }
   */
  _unwrapResponse(data) {
    // REST API format
    if (data && data.code !== undefined) {
      if (data.code !== 0) {
        this._handlePhemexError(data.code, data.msg || '');
      }
      return data.data;
    }
    // Market data format
    if (data && data.error !== undefined) {
      if (data.error !== null) {
        throw new ExchangeError(this.id + ' ' + JSON.stringify(data.error));
      }
      return data.result;
    }
    return data;
  }

  // ===========================================================================
  // PUBLIC — Market Data
  // ===========================================================================

  async fetchTime() {
    const response = await this._request('GET', '/public/time');
    const data = this._unwrapResponse(response);
    return safeInteger(data, 'serverTime') || Date.now();
  }

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const response = await this._request('GET', '/public/products');
    const data = this._unwrapResponse(response);
    const products = data.products || data || [];
    const markets = {};
    const marketsById = {};

    for (const p of products) {
      const type = safeString(p, 'type');
      const status = safeString(p, 'status');
      if (type !== 'Spot') continue;
      if (status !== 'Listed') continue;

      const id = safeString(p, 'symbol');
      if (!id) continue;
      const base = safeString(p, 'baseCurrency');
      const quote = safeString(p, 'quoteCurrency');
      if (!base || !quote) continue;
      const symbol = base + '/' + quote;

      const entry = {
        id,
        symbol,
        base,
        quote,
        active: true,
        precision: {
          price: safeInteger(p, 'pricePrecision', 8),
          amount: safeInteger(p, 'baseQtyPrecision', 8),
        },
        limits: {
          amount: { min: undefined },
          price: { min: undefined },
        },
        info: p,
      };

      markets[symbol] = entry;
      marketsById[id] = entry;
    }

    this.markets = markets;
    this.marketsById = marketsById;
    this.symbols = Object.keys(markets);
    this._marketsLoaded = true;
    return markets;
  }

  async fetchTicker(symbol) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const response = await this._request('GET', '/md/ticker/24hr', { symbol: phemexSymbol });
    const result = this._unwrapResponse(response);
    return this._parseTicker(result, symbol);
  }

  async fetchTickers(symbols = undefined) {
    const response = await this._request('GET', '/md/spot/ticker/24hr/all');
    const result = this._unwrapResponse(response);
    const tickers = result || [];
    const output = {};

    for (const item of (Array.isArray(tickers) ? tickers : [])) {
      const phemexSymbol = safeString(item, 'symbol');
      if (!phemexSymbol) continue;
      const unifiedSymbol = this._fromPhemexSymbol(phemexSymbol);
      if (symbols && !symbols.includes(unifiedSymbol)) continue;
      output[unifiedSymbol] = this._parseTicker(item, unifiedSymbol);
    }
    return output;
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol };
    const response = await this._request('GET', '/md/orderbook', params);
    const result = this._unwrapResponse(response);
    return this._parseOrderBook(result, symbol);
  }

  async fetchTrades(symbol, since = undefined, limit = undefined) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol };
    const response = await this._request('GET', '/md/trade', params);
    const result = this._unwrapResponse(response);
    const trades = result.trades || [];
    return trades.map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1m', since = undefined, limit = undefined) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const resolution = this.timeframes[timeframe];
    if (!resolution) {
      throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);
    }

    const params = { symbol: phemexSymbol, resolution };
    if (since) {
      params.from = Math.floor(since / 1000);
    }
    if (limit) {
      params.to = params.from ? params.from + (limit * resolution) : Math.floor(Date.now() / 1000);
    }

    const response = await this._request('GET', '/md/kline', params);
    const result = this._unwrapResponse(response);
    const rows = result.rows || [];
    return rows.map((r) => this._parseCandle(r));
  }

  // ===========================================================================
  // PRIVATE — Trading
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const phemexSide = this._toPhemexSide(side);

    const params = {
      symbol: phemexSymbol,
      side: phemexSide,
      ordType: type.charAt(0).toUpperCase() + type.slice(1).toLowerCase(), // Limit or Market
    };

    if (type === 'limit') {
      params.ordType = 'Limit';
      params.qtyType = 'ByBase';
      params.baseQtyEv = this._scaleToEp(amount);
      if (price !== undefined) {
        params.priceEp = this._scaleToEp(price);
      }
      params.timeInForce = 'GoodTillCancel';
    } else if (type === 'market') {
      params.ordType = 'Market';
      if (side === 'buy') {
        // Market buy: specify quote quantity
        params.qtyType = 'ByQuote';
        params.quoteQtyEv = this._scaleToEp(amount);
      } else {
        // Market sell: specify base quantity
        params.qtyType = 'ByBase';
        params.baseQtyEv = this._scaleToEp(amount);
      }
    }

    const response = await this._request('POST', '/spot/orders', params, true);
    const data = this._unwrapResponse(response);

    return {
      id: safeString(data, 'orderID'),
      clientOrderId: safeString(data, 'clOrdID'),
      symbol,
      type,
      side,
      amount: parseFloat(amount),
      price: price ? parseFloat(price) : undefined,
      status: 'open',
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: response,
    };
  }

  async createLimitOrder(symbol, side, amount, price, params = {}) {
    return this.createOrder(symbol, 'limit', side, amount, price, params);
  }

  async createMarketOrder(symbol, side, amount, params = {}) {
    return this.createOrder(symbol, 'market', side, amount, undefined, params);
  }

  async cancelOrder(id, symbol = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder requires symbol');
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol, orderID: id };
    const response = await this._request('DELETE', '/spot/orders', params, true);
    const data = this._unwrapResponse(response);

    return {
      id,
      symbol,
      info: response,
    };
  }

  async cancelAllOrders(symbol = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' cancelAllOrders requires symbol');
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol };
    const response = await this._request('DELETE', '/spot/orders/all', params, true);
    this._unwrapResponse(response);
    return response;
  }

  async fetchOrder(id, symbol = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder requires symbol');
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol, orderID: id };
    const response = await this._request('GET', '/spot/orders/active', params, true);
    const data = this._unwrapResponse(response);
    return this._parseOrder(data, symbol);
  }

  async fetchOpenOrders(symbol = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' fetchOpenOrders requires symbol');
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol };
    const response = await this._request('GET', '/spot/orders/active', params, true);
    const data = this._unwrapResponse(response);
    const orders = Array.isArray(data) ? data : (data.rows || []);
    return orders.map((o) => this._parseOrder(o, symbol));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = 50) {
    if (!symbol) throw new BadRequest(this.id + ' fetchClosedOrders requires symbol');
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol };
    if (limit) params.limit = limit;
    if (since) params.start = since;
    const response = await this._request('GET', '/spot/data/ordersHist', params, true);
    const data = this._unwrapResponse(response);
    const orders = Array.isArray(data) ? data : (data.rows || []);
    return orders.map((o) => this._parseOrder(o, symbol));
  }

  // ===========================================================================
  // PRIVATE — Account
  // ===========================================================================

  async fetchBalance() {
    const response = await this._request('GET', '/spot/wallets', {}, true);
    const data = this._unwrapResponse(response);
    const wallets = Array.isArray(data) ? data : [];
    const result = { info: response, timestamp: Date.now(), datetime: iso8601(Date.now()) };

    for (const wallet of wallets) {
      const currency = safeString(wallet, 'currency');
      if (!currency) continue;
      const code = currency.toUpperCase();
      const free = this._scaleFromEp(safeInteger(wallet, 'balanceEv', 0)) -
        this._scaleFromEp(safeInteger(wallet, 'lockedEv', 0));
      const used = this._scaleFromEp(safeInteger(wallet, 'lockedEv', 0));
      const total = this._scaleFromEp(safeInteger(wallet, 'balanceEv', 0));

      result[code] = { free, used, total };
    }

    return result;
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = 50) {
    if (!symbol) throw new BadRequest(this.id + ' fetchMyTrades requires symbol');
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const params = { symbol: phemexSymbol };
    if (limit) params.limit = limit;
    if (since) params.start = since;
    const response = await this._request('GET', '/spot/data/tradesHist', params, true);
    const data = this._unwrapResponse(response);
    const trades = Array.isArray(data) ? data : (data.rows || []);
    return trades.map((t) => this._parseHistTrade(t, symbol));
  }

  // ===========================================================================
  // PARSERS
  // ===========================================================================

  _parseTicker(data, symbol = undefined) {
    const phemexSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (phemexSymbol ? this._fromPhemexSymbol(phemexSymbol) : undefined);
    const timestamp = safeInteger(data, 'timestamp') || Date.now();

    return {
      symbol: resolvedSymbol,
      timestamp,
      datetime: iso8601(timestamp),
      high: this._scaleFromEp(safeInteger(data, 'highEp')) || safeFloat(data, 'high'),
      low: this._scaleFromEp(safeInteger(data, 'lowEp')) || safeFloat(data, 'low'),
      bid: this._scaleFromEp(safeInteger(data, 'bidEp')) || safeFloat(data, 'bid'),
      ask: this._scaleFromEp(safeInteger(data, 'askEp')) || safeFloat(data, 'ask'),
      last: this._scaleFromEp(safeInteger(data, 'lastEp')) || safeFloat(data, 'close') || safeFloat(data, 'last'),
      open: this._scaleFromEp(safeInteger(data, 'openEp')) || safeFloat(data, 'open'),
      close: this._scaleFromEp(safeInteger(data, 'lastEp')) || safeFloat(data, 'close'),
      change: undefined,
      percentage: undefined,
      baseVolume: this._scaleFromEp(safeInteger(data, 'volumeEv')) || safeFloat(data, 'volume'),
      quoteVolume: this._scaleFromEp(safeInteger(data, 'turnoverEv')) || safeFloat(data, 'turnover'),
      info: data,
    };
  }

  _parseOrder(data, symbol = undefined) {
    const phemexSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (phemexSymbol ? this._fromPhemexSymbol(phemexSymbol) : undefined);

    const statusRaw = safeString(data, 'ordStatus') || safeString(data, 'status');
    const status = this._normalizeOrderStatus(statusRaw);

    const side = this._fromPhemexSide(safeString(data, 'side'));
    const ordType = safeString(data, 'ordType') || safeString(data, 'orderType');
    const type = ordType ? ordType.toLowerCase() : undefined;

    const priceEp = safeInteger(data, 'priceEp');
    const price = priceEp ? this._scaleFromEp(priceEp) : safeFloat(data, 'price');

    const baseQtyEv = safeInteger(data, 'baseQtyEv') || safeInteger(data, 'orderQtyEv');
    const amount = baseQtyEv ? this._scaleFromEp(baseQtyEv) : safeFloat(data, 'orderQty');

    const cumBaseQtyEv = safeInteger(data, 'cumBaseQtyEv');
    const filled = cumBaseQtyEv ? this._scaleFromEp(cumBaseQtyEv) : safeFloat(data, 'cumQty');

    const avgPriceEp = safeInteger(data, 'avgPriceEp');
    const avgPrice = avgPriceEp ? this._scaleFromEp(avgPriceEp) : safeFloat(data, 'avgPrice');

    const remaining = (amount && filled !== undefined) ? amount - filled : undefined;
    const cost = (filled && avgPrice) ? filled * avgPrice : undefined;

    const createTime = safeInteger(data, 'createTimeNs')
      ? Math.floor(safeInteger(data, 'createTimeNs') / 1e6)
      : safeInteger(data, 'actionTimeNs')
        ? Math.floor(safeInteger(data, 'actionTimeNs') / 1e6)
        : safeInteger(data, 'timestamp');

    return {
      id: safeString(data, 'orderID') || safeString(data, 'orderId'),
      clientOrderId: safeString(data, 'clOrdID'),
      symbol: resolvedSymbol,
      type,
      side,
      amount,
      price,
      filled,
      remaining,
      cost,
      average: avgPrice,
      status,
      timestamp: createTime,
      datetime: iso8601(createTime),
      info: data,
    };
  }

  _parseTrade(data, symbol = undefined) {
    // Market data trade format: [timestamp, side, priceEp, qty]
    if (Array.isArray(data)) {
      const timestamp = data[0];
      const side = data[1] ? data[1].toLowerCase() : undefined;
      const price = this._scaleFromEp(data[2]);
      const amount = this._scaleFromEp(data[3]);

      return {
        id: undefined,
        symbol,
        timestamp,
        datetime: iso8601(timestamp),
        side,
        price,
        amount,
        cost: (price && amount) ? price * amount : undefined,
        info: data,
      };
    }

    // Object format (from hist API)
    return this._parseHistTrade(data, symbol);
  }

  _parseHistTrade(data, symbol = undefined) {
    const phemexSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (phemexSymbol ? this._fromPhemexSymbol(phemexSymbol) : undefined);

    const priceEp = safeInteger(data, 'priceEp');
    const price = priceEp ? this._scaleFromEp(priceEp) : safeFloat(data, 'price');
    const baseQtyEv = safeInteger(data, 'baseQtyEv') || safeInteger(data, 'qtyEv');
    const amount = baseQtyEv ? this._scaleFromEp(baseQtyEv) : safeFloat(data, 'qty');
    const timestamp = safeInteger(data, 'transactTimeNs')
      ? Math.floor(safeInteger(data, 'transactTimeNs') / 1e6)
      : safeInteger(data, 'timestamp');

    return {
      id: safeString(data, 'tradeId') || safeString(data, 'execID'),
      symbol: resolvedSymbol,
      timestamp,
      datetime: iso8601(timestamp),
      side: this._fromPhemexSide(safeString(data, 'side')),
      price,
      amount,
      cost: (price && amount) ? price * amount : undefined,
      info: data,
    };
  }

  _parseCandle(data) {
    // Phemex kline: [timestamp, interval, lastCloseEp, openEp, highEp, lowEp, closeEp, volumeEv, turnoverEv]
    if (!Array.isArray(data) || data.length < 7) return data;

    return [
      data[0] * 1000, // Convert seconds to ms
      this._scaleFromEp(data[3]), // open
      this._scaleFromEp(data[4]), // high
      this._scaleFromEp(data[5]), // low
      this._scaleFromEp(data[6]), // close
      this._scaleFromEp(data[7]), // volume
    ];
  }

  _parseOrderBook(data, symbol = undefined) {
    const book = data.book || data;
    const asks = (book.asks || []).map((entry) => [
      this._scaleFromEp(entry[0]),
      this._scaleFromEp(entry[1]),
    ]);
    const bids = (book.bids || []).map((entry) => [
      this._scaleFromEp(entry[0]),
      this._scaleFromEp(entry[1]),
    ]);

    const timestamp = safeInteger(data, 'timestamp') || Date.now();

    return {
      symbol,
      asks,
      bids,
      timestamp,
      datetime: iso8601(timestamp),
      nonce: safeInteger(data, 'sequence'),
      info: data,
    };
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handlePhemexError(code, msg) {
    const errorCode = parseInt(code, 10);
    const message = this.id + ' error ' + code + ': ' + msg;

    switch (errorCode) {
      case 10001:
      case 11033:
      case 11085:
        throw new InvalidOrder(message); // Duplicate order ID
      case 10002:
        throw new OrderNotFound(message);
      case 11001:
      case 11100:
      case 11105:
      case 11106:
        throw new InsufficientFunds(message);
      case 11027:
      case 11070:
        throw new BadSymbol(message);
      case 11034:
      case 11035:
      case 11036:
      case 11058:
        throw new InvalidOrder(message); // Invalid side/type/tif/qty
      case 11022:
        throw new AuthenticationError(message); // Banned
      default:
        throw new ExchangeError(message);
    }
  }

  _handleHttpError(statusCode, body) {
    const msg = this.id + ' HTTP ' + statusCode + ': ' + body;
    if (statusCode === 400) throw new BadRequest(msg);
    if (statusCode === 401) throw new AuthenticationError(msg);
    if (statusCode === 403) throw new AuthenticationError(msg);
    if (statusCode === 404) throw new ExchangeError(msg);
    if (statusCode === 429) throw new RateLimitExceeded(msg);
    if (statusCode >= 500) throw new ExchangeNotAvailable(msg);
    throw new ExchangeError(msg);
  }

  // ===========================================================================
  // WEBSOCKET — JSON-RPC style (public channels)
  // ===========================================================================

  _getWsClient(url) {
    if (this._wsClients.has(url)) {
      return this._wsClients.get(url);
    }
    const client = new WsClient(url, {
      pingInterval: 5000,
      reconnect: true,
    });

    // Phemex WS ping: client sends {"id": N, "method": "server.ping", "params": []}
    const self = this;
    const originalPing = client._sendPing;
    client._sendPing = function () {
      if (this.isConnected()) {
        this.send({
          id: self._wsIdCounter++,
          method: 'server.ping',
          params: [],
        });
      }
    };

    this._wsClients.set(url, client);
    return client;
  }

  async _ensureWsConnected(url) {
    const client = this._getWsClient(url);
    if (!client.isConnected()) {
      await client.connect();
    }
    return client;
  }

  async _subscribePhemex(channel, callback) {
    const url = this.urls.ws;
    const client = await this._ensureWsConnected(url);

    const subMsg = {
      id: this._wsIdCounter++,
      method: 'subscribe',
      params: [channel],
    };

    client.send(subMsg);

    const handler = (data) => {
      // Route messages to the correct handler based on channel topic
      if (data && !data.result && !data.id) {
        callback(data);
      }
    };
    client.on('message', handler);

    if (!this._wsHandlers) this._wsHandlers = new Map();
    this._wsHandlers.set(channel, { handler, callback });

    return channel;
  }

  async watchTicker(symbol, callback) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const channel = `spot.ticker.24hr.${phemexSymbol}`;
    return this._subscribePhemex(channel, (data) => {
      const ticker = this._parseWsTicker(data, symbol);
      callback(ticker);
    });
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const channel = `spot.book.${phemexSymbol}`;
    return this._subscribePhemex(channel, (data) => {
      const orderBook = this._parseWsOrderBook(data, symbol);
      callback(orderBook);
    });
  }

  async watchTrades(symbol, callback) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const channel = `spot.trade.${phemexSymbol}`;
    return this._subscribePhemex(channel, (data) => {
      const trades = this._parseWsTrades(data, symbol);
      callback(trades);
    });
  }

  async watchKlines(symbol, timeframe, callback) {
    const phemexSymbol = this._toPhemexSymbol(symbol);
    const resolution = this.timeframes[timeframe];
    if (!resolution) {
      throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);
    }
    const channel = `spot.kline.${resolution}.${phemexSymbol}`;
    return this._subscribePhemex(channel, (data) => {
      const kline = this._parseWsKline(data, symbol);
      callback(kline);
    });
  }

  closeAllWs() {
    for (const [url, client] of this._wsClients) {
      client.close();
    }
    this._wsClients.clear();
    if (this._wsHandlers) this._wsHandlers.clear();
  }

  // ===========================================================================
  // WS PARSERS
  // ===========================================================================

  _parseWsTicker(data, symbol = undefined) {
    const phemexSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (phemexSymbol ? this._fromPhemexSymbol(phemexSymbol) : undefined);
    const timestamp = safeInteger(data, 'timestamp') || Date.now();

    return {
      symbol: resolvedSymbol,
      timestamp,
      datetime: iso8601(timestamp),
      high: this._scaleFromEp(safeInteger(data, 'highEp')) || safeFloat(data, 'high'),
      low: this._scaleFromEp(safeInteger(data, 'lowEp')) || safeFloat(data, 'low'),
      bid: this._scaleFromEp(safeInteger(data, 'bidEp')) || safeFloat(data, 'bid'),
      ask: this._scaleFromEp(safeInteger(data, 'askEp')) || safeFloat(data, 'ask'),
      last: this._scaleFromEp(safeInteger(data, 'lastEp')) || safeFloat(data, 'last'),
      open: this._scaleFromEp(safeInteger(data, 'openEp')) || safeFloat(data, 'open'),
      close: this._scaleFromEp(safeInteger(data, 'lastEp')) || safeFloat(data, 'close'),
      baseVolume: this._scaleFromEp(safeInteger(data, 'volumeEv')) || safeFloat(data, 'volume'),
      quoteVolume: this._scaleFromEp(safeInteger(data, 'turnoverEv')) || safeFloat(data, 'turnover'),
      info: data,
    };
  }

  _parseWsOrderBook(data, symbol = undefined) {
    const book = data.book || data;
    const phemexSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (phemexSymbol ? this._fromPhemexSymbol(phemexSymbol) : undefined);
    const type = safeString(data, 'type'); // 'snapshot' or 'incremental'

    const asks = (book.asks || []).map((entry) => [
      this._scaleFromEp(entry[0]),
      this._scaleFromEp(entry[1]),
    ]);
    const bids = (book.bids || []).map((entry) => [
      this._scaleFromEp(entry[0]),
      this._scaleFromEp(entry[1]),
    ]);

    const timestamp = safeInteger(data, 'timestamp') || Date.now();

    return {
      symbol: resolvedSymbol,
      asks,
      bids,
      timestamp,
      datetime: iso8601(timestamp),
      nonce: safeInteger(data, 'sequence'),
      type,
      info: data,
    };
  }

  _parseWsTrades(data, symbol = undefined) {
    const phemexSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (phemexSymbol ? this._fromPhemexSymbol(phemexSymbol) : undefined);
    const trades = data.trades || [];

    return trades.map((t) => {
      if (Array.isArray(t)) {
        return {
          id: undefined,
          symbol: resolvedSymbol,
          timestamp: t[0],
          datetime: iso8601(t[0]),
          side: t[1] ? t[1].toLowerCase() : undefined,
          price: this._scaleFromEp(t[2]),
          amount: this._scaleFromEp(t[3]),
          info: t,
        };
      }
      return this._parseTrade(t, resolvedSymbol);
    });
  }

  _parseWsKline(data, symbol = undefined) {
    const phemexSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (phemexSymbol ? this._fromPhemexSymbol(phemexSymbol) : undefined);
    const klines = data.kline || [];

    return klines.map((k) => {
      if (Array.isArray(k)) {
        return this._parseCandle(k);
      }
      return {
        symbol: resolvedSymbol,
        timestamp: safeInteger(k, 'timestamp') ? safeInteger(k, 'timestamp') * 1000 : undefined,
        open: this._scaleFromEp(safeInteger(k, 'openEp')),
        high: this._scaleFromEp(safeInteger(k, 'highEp')),
        low: this._scaleFromEp(safeInteger(k, 'lowEp')),
        close: this._scaleFromEp(safeInteger(k, 'closeEp')),
        volume: this._scaleFromEp(safeInteger(k, 'volumeEv')),
        info: k,
      };
    });
  }
}

module.exports = Phemex;

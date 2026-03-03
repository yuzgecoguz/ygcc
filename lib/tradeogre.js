'use strict';

const BaseExchange = require('./BaseExchange');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, iso8601,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class TradeOgre extends BaseExchange {
  describe() {
    return {
      id: 'tradeogre',
      name: 'TradeOgre',
      version: 'v1',
      rateLimit: 500,
      rateLimitCapacity: 2,
      rateLimitInterval: 1000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: true,
        fetchTickers: false,
        fetchOrderBook: true,
        fetchTrades: false,
        fetchOHLCV: false,
        fetchTime: false,
        // Private
        createOrder: true,
        createLimitOrder: true,
        createMarketOrder: false,
        cancelOrder: true,
        cancelAllOrders: false,
        fetchOrder: false,
        fetchOpenOrders: true,
        fetchClosedOrders: false,
        fetchMyTrades: false,
        fetchBalance: true,
        fetchTradingFees: false,
        amendOrder: false,
        // WebSocket — NOT supported
        watchOrderBook: false,
        watchTicker: false,
        watchTrades: false,
        watchKlines: false,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://tradeogre.com/api/v1',
        doc: 'https://tradeogre.com/help/api',
      },
      timeframes: {},
      fees: {
        trading: { maker: 0.002, taker: 0.002 },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(config = {}) {
    super(config);
    this.postAsFormEncoded = true;
    // NO _wsClients — TradeOgre has no WebSocket API
  }

  // ---------------------------------------------------------------------------
  // Authentication — HTTP Basic Auth (simplest possible)
  // ---------------------------------------------------------------------------

  /**
   * TradeOgre uses HTTP Basic Auth:
   *   Authorization: Basic base64(apiKey:secret)
   * No HMAC, no signature computation.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const credentials = Buffer.from(this.apiKey + ':' + this.secret).toString('base64');

    return {
      params,
      headers: {
        'Authorization': 'Basic ' + credentials,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTC-USDT <-> BTC/USDT (hyphen)
  // ---------------------------------------------------------------------------

  _toTradeOgreSymbol(symbol) {
    // 'BTC/USDT' -> 'BTC-USDT'
    return symbol.replace('/', '-');
  }

  _fromTradeOgreSymbol(toSymbol) {
    // 'BTC-USDT' -> 'BTC/USDT'
    if (!toSymbol) return undefined;
    const idx = toSymbol.indexOf('-');
    if (idx > 0) {
      return toSymbol.substring(0, idx) + '/' + toSymbol.substring(idx + 1);
    }
    return toSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.success === false || data.success === 'false') {
        const msg = safeString(data, 'error') || 'Unknown error';
        this._handleTradeOgreError(msg);
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  _handleTradeOgreError(msg) {
    const full = this.id + ': ' + msg;
    const lower = (msg || '').toLowerCase();

    if (lower.includes('insufficient') || lower.includes('not enough') || lower.includes('balance')) {
      throw new InsufficientFunds(full);
    }
    if (lower.includes('not found') || lower.includes('no order') || lower.includes('invalid uuid')) {
      throw new OrderNotFound(full);
    }
    if (lower.includes('invalid market') || lower.includes('bad market') || lower.includes('unknown market')) {
      throw new BadSymbol(full);
    }
    if (lower.includes('invalid') || lower.includes('bad request')) {
      throw new BadRequest(full);
    }
    if (lower.includes('unauthorized') || lower.includes('auth') || lower.includes('api key')) {
      throw new AuthenticationError(full);
    }
    if (lower.includes('rate limit') || lower.includes('too many')) {
      throw new RateLimitExceeded(full);
    }
    if (lower.includes('maintenance') || lower.includes('unavailable')) {
      throw new ExchangeNotAvailable(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object') {
      if (parsed.success === false || parsed.success === 'false') {
        const msg = safeString(parsed, 'error') || body;
        this._handleTradeOgreError(msg);
      }
    }

    const full = this.id + ' HTTP ' + statusCode + ': ' + body;
    if (statusCode === 400) throw new BadRequest(full);
    if (statusCode === 401) throw new AuthenticationError(full);
    if (statusCode === 403) throw new AuthenticationError(full);
    if (statusCode === 404) throw new BadRequest(full);
    if (statusCode === 429) throw new RateLimitExceeded(full);
    if (statusCode >= 500) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  _parseTicker(data, symbol) {
    const last = safeFloat(data, 'price');
    const ts = Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: safeFloat(data, 'initialprice'),
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'volume'),
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'uuid');
    const marketId = safeString(data, 'market');
    const symbol = marketId ? this._fromTradeOgreSymbol(marketId) : fallbackSymbol;
    const side = (safeString(data, 'type') || '').toLowerCase();
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'quantity') || 0;
    const dateStr = safeString(data, 'date');
    const ts = dateStr ? new Date(dateStr).getTime() : Date.now();

    return {
      id: orderId,
      clientOrderId: undefined,
      symbol,
      type: 'limit',
      side,
      price,
      amount,
      filled: 0,
      remaining: amount,
      cost: price * amount,
      average: 0,
      status: 'open',
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrderStatus(status) {
    return 'open'; // TradeOgre only returns open orders
  }

  _parseBalance(balanceData) {
    const balance = {
      info: balanceData,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    if (balanceData && typeof balanceData === 'object' && !Array.isArray(balanceData)) {
      for (const [currency, data] of Object.entries(balanceData)) {
        const total = safeFloat(data, 'balance') || 0;
        const free = safeFloat(data, 'available') || 0;
        const used = total - free;
        if (total > 0 || free > 0) {
          balance[currency.toUpperCase()] = { free, used: used >= 0 ? used : 0, total };
        }
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data
  // ---------------------------------------------------------------------------

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/markets', {}, false, 5);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    // Response: [ { "BTC-USDT": { initialprice, price, ... } }, ... ]
    const marketList = Array.isArray(data) ? data : [];

    for (const entry of marketList) {
      const keys = Object.keys(entry);
      if (keys.length === 0) continue;

      const marketId = keys[0];
      const symbol = this._fromTradeOgreSymbol(marketId);
      if (!symbol) continue;

      const parts = symbol.split('/');
      if (parts.length !== 2) continue;

      const market = {
        id: marketId,
        symbol,
        base: parts[0],
        quote: parts[1],
        active: true,
        precision: { price: 8, amount: 8 },
        limits: {
          price: { min: undefined, max: undefined },
          amount: { min: undefined, max: undefined },
        },
        info: entry[marketId],
      };

      this.markets[symbol] = market;
      this.marketsById[marketId] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol) {
    const toSymbol = this._toTradeOgreSymbol(symbol);
    const data = await this._request('GET', '/ticker/' + toSymbol, {}, false, 1);

    if (data && data.success === false) {
      throw new BadSymbol(this.id + ' fetchTicker() symbol not found: ' + symbol);
    }

    return this._parseTicker(data, symbol);
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const toSymbol = this._toTradeOgreSymbol(symbol);
    const data = await this._request('GET', '/orders/' + toSymbol, {}, false, 1);
    this._unwrapResponse(data);

    const ts = Date.now();

    // buy/sell are objects: { price: quantity, ... }
    const buyObj = safeValue(data, 'buy', {});
    const sellObj = safeValue(data, 'sell', {});

    let bids = Object.entries(buyObj).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
    let asks = Object.entries(sellObj).map(([p, q]) => [parseFloat(p), parseFloat(q)]);

    // Sort: bids descending, asks ascending
    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);

    if (limit) {
      bids = bids.slice(0, limit);
      asks = asks.slice(0, limit);
    }

    return {
      symbol,
      bids,
      asks,
      timestamp: ts,
      datetime: iso8601(ts),
      nonce: undefined,
      info: data,
    };
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined) {
    this.checkRequiredCredentials();

    if (type !== 'limit') {
      throw new InvalidOrder(this.id + ' createOrder() only supports limit orders');
    }
    if (price === undefined || price === null) {
      throw new InvalidOrder(this.id + ' createOrder() requires a price for limit orders');
    }
    if (side !== 'buy' && side !== 'sell') {
      throw new InvalidOrder(this.id + ' createOrder() side must be "buy" or "sell"');
    }

    const toSymbol = this._toTradeOgreSymbol(symbol);
    const endpoint = side === 'buy' ? '/order/buy' : '/order/sell';

    const request = {
      market: toSymbol,
      quantity: String(amount),
      price: String(price),
    };

    const data = await this._request('POST', endpoint, request, true, 1);
    this._unwrapResponse(data);

    return {
      id: safeString(data, 'uuid'),
      symbol,
      type: 'limit',
      side,
      price: parseFloat(price),
      amount: parseFloat(amount),
      filled: 0,
      remaining: parseFloat(amount),
      status: 'open',
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  async cancelOrder(id, symbol = undefined) {
    this.checkRequiredCredentials();

    const request = { uuid: String(id) };
    const data = await this._request('POST', '/order/cancel', request, true, 1);
    this._unwrapResponse(data);

    return {
      id: String(id),
      symbol,
      status: 'canceled',
      info: data,
    };
  }

  async fetchBalance() {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/account/balances', {}, true, 1);
    this._unwrapResponse(data);

    // Response: { success: true, balances: { BTC: {balance, available}, ... } }
    const balances = safeValue(data, 'balances', {});
    return this._parseBalance(balances);
  }

  async fetchOpenOrders(symbol = undefined) {
    this.checkRequiredCredentials();

    const request = {};
    if (symbol) {
      request.market = this._toTradeOgreSymbol(symbol);
    }

    const data = await this._request('POST', '/account/orders', request, true, 1);

    // Response: array or {success:false, error:'...'}
    if (!Array.isArray(data)) {
      this._unwrapResponse(data);
      return [];
    }

    const orders = [];
    for (const o of data) {
      orders.push(this._parseOrder(o, symbol));
    }

    return orders;
  }

  // ---------------------------------------------------------------------------
  // No WebSocket — TradeOgre does not support WebSocket
  // ---------------------------------------------------------------------------

  // No watchOrderBook, no WS client, no WS parsers

  async closeAllWs() {
    // No-op: no WebSocket
  }
}

module.exports = TradeOgre;

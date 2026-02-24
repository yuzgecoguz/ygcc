'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeFloat2, safeString2,
  buildQueryRaw, iso8601, sleep,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Binance extends BaseExchange {

  describe() {
    return {
      id: 'binance',
      name: 'Binance',
      version: 'v3',
      rateLimit: 50,
      rateLimitCapacity: 6000,
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
        fetchOrder: true,
        fetchOpenOrders: true,
        fetchAllOrders: true,
        fetchMyTrades: true,
        fetchBalance: true,
        fetchTradingFees: true,
        // Advanced
        createOCO: true,
        createOTO: true,
        createOTOCO: true,
        cancelReplace: true,
        amendOrder: true,
        testOrder: true,
        // WebSocket
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
        watchBalance: true,
        watchOrders: true,
      },
      urls: {
        api: 'https://api.binance.com',
        ws: 'wss://stream.binance.com:9443/ws',
        wsCombined: 'wss://stream.binance.com:9443/stream',
        wsApi: 'wss://ws-api.binance.com:443/ws-api/v3',
        doc: 'https://developers.binance.com/docs/binance-spot-api-docs/rest-api',
        test: {
          api: 'https://testnet.binance.vision',
          ws: 'wss://testnet.binance.vision/ws',
        },
      },
      timeframes: {
        '1s': '1s', '1m': '1m', '3m': '3m', '5m': '5m',
        '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h',
        '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
        '1d': '1d', '3d': '3d', '1w': '1w', '1M': '1M',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this._recvWindow = this.options.recvWindow || 5000;
    this._wsClients = new Map();       // url → WsClient
    this._listenKey = null;
    this._listenKeyTimer = null;
    this._weightUsed = 0;
    this._orderCount10s = 0;

    // Use testnet if configured
    if (this.options.test || this.options.sandbox) {
      this.urls.api = this.urls.test.api;
      this.urls.ws = this.urls.test.ws;
    }
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA256
  // ===========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();
    params.timestamp = Date.now();
    params.recvWindow = this._recvWindow;

    // Build query string from all params
    const queryString = buildQueryRaw(params);
    const signature = hmacSHA256(queryString, this.secret);
    params.signature = signature;

    return {
      params,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  _handleResponseHeaders(headers) {
    const used = headers.get('x-mbx-used-weight-1m');
    if (used) {
      this._weightUsed = parseInt(used, 10);
      if (this.enableRateLimit && this._throttler) {
        this._throttler.updateFromHeader(this._weightUsed);
      }
      if (this._weightUsed > 4800) {
        this.emit('rateLimitWarning', { used: this._weightUsed, limit: 6000 });
      }
    }
    const orderCount = headers.get('x-mbx-order-count-10s');
    if (orderCount) this._orderCount10s = parseInt(orderCount, 10);
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const code = parsed?.code;
    const msg = parsed?.msg || body;
    const full = this.id + ' ' + (code || status) + ': ' + msg;

    const errorMap = {
      '-1002': AuthenticationError,
      '-1003': RateLimitExceeded,
      '-1013': InvalidOrder,
      '-1015': RateLimitExceeded,
      '-1021': AuthenticationError,
      '-1022': AuthenticationError,
      '-1100': BadRequest,
      '-1102': BadRequest,
      '-1105': BadRequest,
      '-1111': InvalidOrder,
      '-1114': InvalidOrder,
      '-1115': InvalidOrder,
      '-1116': InvalidOrder,
      '-1117': InvalidOrder,
      '-1121': BadSymbol,
      '-2010': InsufficientFunds,
      '-2011': InvalidOrder,
      '-2013': OrderNotFound,
      '-2014': AuthenticationError,
      '-2015': AuthenticationError,
    };

    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  /** Test connectivity — weight 1 */
  async ping() {
    return this._request('GET', '/api/v3/ping', {}, false, 1);
  }

  /** Get server time — weight 1 */
  async fetchTime() {
    const data = await this._request('GET', '/api/v3/time', {}, false, 1);
    return data.serverTime;
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (12 endpoints)
  // ===========================================================================

  /**
   * Load exchange info: symbols, filters, trading rules. Weight: 20
   * Results are cached — call with reload=true to refresh.
   */
  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v3/exchangeInfo', {}, false, 20);
    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const s of data.symbols) {
      const symbol = s.symbol;
      const base = s.baseAsset;
      const quote = s.quoteAsset;
      const status = s.status;

      // Parse filters
      const filters = {};
      for (const f of s.filters) {
        filters[f.filterType] = f;
      }

      const market = {
        id: symbol,
        symbol,
        base,
        quote,
        status,
        active: status === 'TRADING',
        precision: {
          base: s.baseAssetPrecision,
          quote: s.quotePrecision,
          price: s.quotePrecision,
          amount: s.baseAssetPrecision,
        },
        limits: {
          price: {
            min: safeFloat(filters.PRICE_FILTER, 'minPrice'),
            max: safeFloat(filters.PRICE_FILTER, 'maxPrice'),
          },
          amount: {
            min: safeFloat(filters.LOT_SIZE, 'minQty'),
            max: safeFloat(filters.LOT_SIZE, 'maxQty'),
          },
          cost: {
            min: safeFloat(filters.NOTIONAL || filters.MIN_NOTIONAL, 'minNotional'),
          },
        },
        stepSize: safeFloat(filters.LOT_SIZE, 'stepSize'),
        tickSize: safeFloat(filters.PRICE_FILTER, 'tickSize'),
        orderTypes: s.orderTypes,
        permissions: s.permissions,
        filters,
        info: s,
      };

      this.markets[symbol] = market;
      this.marketsById[symbol] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  /**
   * Fetch order book. Weight: 5 (limit≤100), 25 (≤500), 50 (≤1000), 250 (≤5000)
   */
  async fetchOrderBook(symbol, limit = 100, params = {}) {
    const weights = { 5: 1, 10: 1, 20: 1, 50: 1, 100: 5, 500: 25, 1000: 50, 5000: 250 };
    const weight = weights[limit] || 5;

    const data = await this._request('GET', '/api/v3/depth', {
      symbol: symbol.toUpperCase(),
      limit,
      ...params,
    }, false, weight);

    return {
      symbol,
      bids: data.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: data.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: data.lastUpdateId,
    };
  }

  /**
   * Fetch recent trades. Weight: 25
   */
  async fetchTrades(symbol, since = undefined, limit = 500, params = {}) {
    const request = { symbol: symbol.toUpperCase(), limit, ...params };
    const data = await this._request('GET', '/api/v3/trades', request, false, 25);
    return data.map((t) => this._parseTrade(t, symbol));
  }

  /**
   * Fetch historical trades. Weight: 25. Requires API key (no signature).
   */
  async fetchHistoricalTrades(symbol, fromId = undefined, limit = 500, params = {}) {
    const request = { symbol: symbol.toUpperCase(), limit, ...params };
    if (fromId !== undefined) request.fromId = fromId;
    // historicalTrades needs API key header but not signature
    const data = await this._request('GET', '/api/v3/historicalTrades', request, false, 25);
    return data.map((t) => this._parseTrade(t, symbol));
  }

  /**
   * Fetch aggregate trades. Weight: 4
   */
  async fetchAggTrades(symbol, startTime = undefined, endTime = undefined, limit = 500, params = {}) {
    const request = { symbol: symbol.toUpperCase(), limit, ...params };
    if (startTime) request.startTime = startTime;
    if (endTime) request.endTime = endTime;
    const data = await this._request('GET', '/api/v3/aggTrades', request, false, 4);
    return data.map((t) => ({
      id: t.a,
      price: parseFloat(t.p),
      amount: parseFloat(t.q),
      cost: parseFloat(t.p) * parseFloat(t.q),
      timestamp: t.T,
      datetime: iso8601(t.T),
      isBuyerMaker: t.m,
    }));
  }

  /**
   * Fetch OHLCV / klines. Weight: 2
   * @param {string} timeframe - '1m', '5m', '1h', '1d', etc.
   */
  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = 500, params = {}) {
    const interval = this.timeframes[timeframe] || timeframe;
    const request = { symbol: symbol.toUpperCase(), interval, limit, ...params };
    if (since) request.startTime = since;

    const data = await this._request('GET', '/api/v3/klines', request, false, 2);
    return data.map((k) => ([
      k[0],              // timestamp
      parseFloat(k[1]),  // open
      parseFloat(k[2]),  // high
      parseFloat(k[3]),  // low
      parseFloat(k[4]),  // close
      parseFloat(k[5]),  // volume
    ]));
  }

  /**
   * Fetch UI-optimized klines. Weight: 2
   */
  async fetchUIKlines(symbol, timeframe = '1h', limit = 500, params = {}) {
    const interval = this.timeframes[timeframe] || timeframe;
    const request = { symbol: symbol.toUpperCase(), interval, limit, ...params };
    const data = await this._request('GET', '/api/v3/uiKlines', request, false, 2);
    return data.map((k) => ([
      k[0], parseFloat(k[1]), parseFloat(k[2]),
      parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5]),
    ]));
  }

  /**
   * Fetch current average price. Weight: 2
   */
  async fetchAvgPrice(symbol) {
    const data = await this._request('GET', '/api/v3/avgPrice', {
      symbol: symbol.toUpperCase(),
    }, false, 2);
    return {
      symbol,
      price: parseFloat(data.price),
      mins: data.mins,
      closeTime: data.closeTime,
    };
  }

  /**
   * Fetch 24hr ticker. Weight: 2 (single) / 80 (all)
   */
  async fetchTicker(symbol, params = {}) {
    const data = await this._request('GET', '/api/v3/ticker/24hr', {
      symbol: symbol.toUpperCase(),
      ...params,
    }, false, 2);
    return this._parseTicker(data);
  }

  /**
   * Fetch all tickers. Weight: 80
   */
  async fetchTickers(symbols = undefined, params = {}) {
    const request = { ...params };
    if (symbols && symbols.length) {
      request.symbols = JSON.stringify(symbols.map((s) => s.toUpperCase()));
    }
    const weight = symbols ? symbols.length * 2 : 80;
    const data = await this._request('GET', '/api/v3/ticker/24hr', request, false, Math.min(weight, 80));
    const result = {};
    for (const t of data) {
      const ticker = this._parseTicker(t);
      result[ticker.symbol] = ticker;
    }
    return result;
  }

  /**
   * Fetch trading day ticker. Weight: 4 per symbol
   */
  async fetchTradingDayTicker(symbol, params = {}) {
    const data = await this._request('GET', '/api/v3/ticker/tradingDay', {
      symbol: symbol.toUpperCase(),
      ...params,
    }, false, 4);
    return this._parseTicker(data);
  }

  /**
   * Fetch symbol price only (lightweight). Weight: 2 (single), 4 (all)
   */
  async fetchPrice(symbol = undefined, params = {}) {
    const request = { ...params };
    if (symbol) request.symbol = symbol.toUpperCase();
    const weight = symbol ? 2 : 4;
    const data = await this._request('GET', '/api/v3/ticker/price', request, false, weight);
    if (Array.isArray(data)) {
      const result = {};
      for (const d of data) result[d.symbol] = parseFloat(d.price);
      return result;
    }
    return { symbol: data.symbol, price: parseFloat(data.price) };
  }

  /**
   * Fetch best bid/ask (book ticker). Weight: 2 (single), 4 (all)
   */
  async fetchBookTicker(symbol = undefined, params = {}) {
    const request = { ...params };
    if (symbol) request.symbol = symbol.toUpperCase();
    const weight = symbol ? 2 : 4;
    const data = await this._request('GET', '/api/v3/ticker/bookTicker', request, false, weight);
    if (Array.isArray(data)) {
      const result = {};
      for (const d of data) {
        result[d.symbol] = {
          symbol: d.symbol,
          bid: parseFloat(d.bidPrice),
          bidVolume: parseFloat(d.bidQty),
          ask: parseFloat(d.askPrice),
          askVolume: parseFloat(d.askQty),
        };
      }
      return result;
    }
    return {
      symbol: data.symbol,
      bid: parseFloat(data.bidPrice),
      bidVolume: parseFloat(data.bidQty),
      ask: parseFloat(data.askPrice),
      askVolume: parseFloat(data.askQty),
    };
  }

  /**
   * Fetch rolling window ticker. Weight: 4 per symbol
   */
  async fetchRollingTicker(symbol, windowSize = '1d', params = {}) {
    const data = await this._request('GET', '/api/v3/ticker', {
      symbol: symbol.toUpperCase(),
      windowSize,
      ...params,
    }, false, 4);
    return this._parseTicker(data);
  }

  // ===========================================================================
  // TRADING — PRIVATE (15 endpoints)
  // ===========================================================================

  /**
   * Create a new order. Weight: 1
   * @param {string} type - LIMIT, MARKET, STOP_LOSS, STOP_LOSS_LIMIT, TAKE_PROFIT, TAKE_PROFIT_LIMIT, LIMIT_MAKER
   * @param {string} side - BUY or SELL
   * @param {Object} params - Extra: timeInForce, quoteOrderQty, stopPrice, icebergQty, newOrderRespType, newClientOrderId
   */
  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      ...params,
    };

    // Quantity
    if (amount !== undefined && amount !== null) {
      request.quantity = String(amount);
    }

    // Price (required for LIMIT, STOP_LOSS_LIMIT, TAKE_PROFIT_LIMIT, LIMIT_MAKER)
    if (price !== undefined && price !== null) {
      request.price = String(price);
    }

    // TimeInForce default for LIMIT orders
    if (request.type === 'LIMIT' && !request.timeInForce) {
      request.timeInForce = 'GTC';
    }

    // Response type
    if (!request.newOrderRespType) {
      request.newOrderRespType = request.type === 'MARKET' ? 'FULL' : 'FULL';
    }

    const data = await this._request('POST', '/api/v3/order', request, true, 1);
    return this._parseOrder(data);
  }

  /**
   * Test new order (validates but does not place). Weight: 1 (or 20 with computeCommissionRates)
   */
  async testOrder(symbol, type, side, amount, price = undefined, params = {}) {
    const request = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      ...params,
    };
    if (amount) request.quantity = String(amount);
    if (price) request.price = String(price);
    if (request.type === 'LIMIT' && !request.timeInForce) request.timeInForce = 'GTC';

    const weight = params.computeCommissionRates ? 20 : 1;
    return this._request('POST', '/api/v3/order/test', request, true, weight);
  }

  /**
   * Cancel an order. Weight: 1
   */
  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder() requires symbol');
    const request = {
      symbol: symbol.toUpperCase(),
      orderId: id,
      ...params,
    };
    const data = await this._request('DELETE', '/api/v3/order', request, true, 1);
    return this._parseOrder(data);
  }

  /**
   * Cancel all open orders on a symbol. Weight: 1
   */
  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelAllOrders() requires symbol');
    const data = await this._request('DELETE', '/api/v3/openOrders', {
      symbol: symbol.toUpperCase(),
      ...params,
    }, true, 1);
    return Array.isArray(data) ? data.map((o) => this._parseOrder(o)) : data;
  }

  /**
   * Cancel and replace an order atomically. Weight: 1
   * @param {string} cancelReplaceMode - STOP_ON_FAILURE or ALLOW_FAILURE
   */
  async cancelReplace(symbol, side, type, cancelReplaceMode, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      cancelReplaceMode,
      ...params,
    };
    if (request.type === 'LIMIT' && !request.timeInForce) request.timeInForce = 'GTC';
    return this._request('POST', '/api/v3/order/cancelReplace', request, true, 1);
  }

  /**
   * Amend order (reduce quantity, keep price priority). Weight: 4
   */
  async amendOrder(id, symbol, newQty, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: symbol.toUpperCase(),
      orderId: id,
      newQty: String(newQty),
      ...params,
    };
    return this._request('PUT', '/api/v3/order/amend/keepPriority', request, true, 4);
  }

  /**
   * Create OCO (One-Cancels-Other) order list. Weight: 1
   */
  async createOCO(symbol, side, quantity, price, stopPrice, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      quantity: String(quantity),
      price: String(price),
      stopPrice: String(stopPrice),
      ...params,
    };
    const data = await this._request('POST', '/api/v3/orderList/oco', request, true, 1);
    return data;
  }

  /**
   * Create OTO (One-Triggers-Other) order list. Weight: 1
   */
  async createOTO(symbol, workingType, workingSide, workingPrice, workingQuantity,
                   pendingType, pendingSide, pendingQuantity, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: symbol.toUpperCase(),
      workingType: workingType.toUpperCase(),
      workingSide: workingSide.toUpperCase(),
      workingPrice: String(workingPrice),
      workingQuantity: String(workingQuantity),
      pendingType: pendingType.toUpperCase(),
      pendingSide: pendingSide.toUpperCase(),
      pendingQuantity: String(pendingQuantity),
      ...params,
    };
    return this._request('POST', '/api/v3/orderList/oto', request, true, 1);
  }

  /**
   * Create OTOCO (One-Triggers-OCO) order list. Weight: 1
   */
  async createOTOCO(symbol, workingType, workingSide, workingPrice, workingQuantity,
                     pendingSide, pendingQuantity, pendingAbovePrice, pendingBelowStopPrice, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: symbol.toUpperCase(),
      workingType: workingType.toUpperCase(),
      workingSide: workingSide.toUpperCase(),
      workingPrice: String(workingPrice),
      workingQuantity: String(workingQuantity),
      pendingSide: pendingSide.toUpperCase(),
      pendingQuantity: String(pendingQuantity),
      pendingAbovePrice: String(pendingAbovePrice),
      pendingBelowStopPrice: String(pendingBelowStopPrice),
      ...params,
    };
    return this._request('POST', '/api/v3/orderList/otoco', request, true, 1);
  }

  /**
   * Cancel an order list. Weight: 1
   */
  async cancelOrderList(symbol, orderListId, params = {}) {
    this.checkRequiredCredentials();
    return this._request('DELETE', '/api/v3/orderList', {
      symbol: symbol.toUpperCase(),
      orderListId,
      ...params,
    }, true, 1);
  }

  /**
   * Create order using Smart Order Routing (SOR). Weight: 1
   */
  async createSOROrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: String(amount),
      ...params,
    };
    if (price) request.price = String(price);
    if (request.type === 'LIMIT' && !request.timeInForce) request.timeInForce = 'GTC';
    return this._request('POST', '/api/v3/sor/order', request, true, 1);
  }

  /**
   * Test SOR order. Weight: 1
   */
  async testSOROrder(symbol, type, side, amount, price = undefined, params = {}) {
    const request = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: String(amount),
      ...params,
    };
    if (price) request.price = String(price);
    if (request.type === 'LIMIT' && !request.timeInForce) request.timeInForce = 'GTC';
    return this._request('POST', '/api/v3/sor/order/test', request, true, 1);
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (14 endpoints)
  // ===========================================================================

  /**
   * Fetch account balances. Weight: 20
   * Returns: { info, timestamp, BTC: { free, used, total }, ... }
   */
  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('GET', '/api/v3/account', {
      omitZeroBalances: true,
      ...params,
    }, true, 20);

    const result = {
      info: data,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    for (const b of data.balances) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      if (free > 0 || locked > 0) {
        result[b.asset] = {
          free,
          used: locked,
          total: free + locked,
        };
      }
    }
    return result;
  }

  /**
   * Fetch single order by ID. Weight: 4
   */
  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder() requires symbol');
    const data = await this._request('GET', '/api/v3/order', {
      symbol: symbol.toUpperCase(),
      orderId: id,
      ...params,
    }, true, 4);
    return this._parseOrder(data);
  }

  /**
   * Fetch open orders. Weight: 6 (with symbol), 80 (all)
   */
  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.symbol = symbol.toUpperCase();
    const weight = symbol ? 6 : 80;
    const data = await this._request('GET', '/api/v3/openOrders', request, true, weight);
    return data.map((o) => this._parseOrder(o));
  }

  /**
   * Fetch all orders (active, canceled, filled). Weight: 20
   */
  async fetchAllOrders(symbol, orderId = undefined, startTime = undefined, endTime = undefined, limit = 500, params = {}) {
    this.checkRequiredCredentials();
    const request = { symbol: symbol.toUpperCase(), limit, ...params };
    if (orderId) request.orderId = orderId;
    if (startTime) request.startTime = startTime;
    if (endTime) request.endTime = endTime;
    const data = await this._request('GET', '/api/v3/allOrders', request, true, 20);
    return data.map((o) => this._parseOrder(o));
  }

  /**
   * Fetch user's trade list. Weight: 20 (or 5 with orderId)
   */
  async fetchMyTrades(symbol = undefined, since = undefined, limit = 500, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchMyTrades() requires symbol');
    const request = { symbol: symbol.toUpperCase(), limit, ...params };
    if (since) request.startTime = since;
    const weight = request.orderId ? 5 : 20;
    const data = await this._request('GET', '/api/v3/myTrades', request, true, weight);
    return data.map((t) => this._parseMyTrade(t, symbol));
  }

  /**
   * Fetch unfilled order count. Weight: 40
   */
  async fetchOrderRateLimit(params = {}) {
    this.checkRequiredCredentials();
    return this._request('GET', '/api/v3/rateLimit/order', { ...params }, true, 40);
  }

  /**
   * Fetch commission rates for a symbol. Weight: 20
   */
  async fetchCommission(symbol, params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('GET', '/api/v3/account/commission', {
      symbol: symbol.toUpperCase(),
      ...params,
    }, true, 20);
    return {
      symbol: data.symbol,
      maker: parseFloat(data.standardCommission?.maker || '0'),
      taker: parseFloat(data.standardCommission?.taker || '0'),
      buyer: parseFloat(data.standardCommission?.buyer || '0'),
      seller: parseFloat(data.standardCommission?.seller || '0'),
    };
  }

  /**
   * Fetch order list details. Weight: 4
   */
  async fetchOrderList(orderListId, params = {}) {
    this.checkRequiredCredentials();
    return this._request('GET', '/api/v3/orderList', { orderListId, ...params }, true, 4);
  }

  /**
   * Fetch all order lists. Weight: 20
   */
  async fetchAllOrderLists(startTime = undefined, endTime = undefined, limit = 500, params = {}) {
    this.checkRequiredCredentials();
    const request = { limit, ...params };
    if (startTime) request.startTime = startTime;
    if (endTime) request.endTime = endTime;
    return this._request('GET', '/api/v3/allOrderList', request, true, 20);
  }

  /**
   * Fetch open order lists. Weight: 6
   */
  async fetchOpenOrderLists(params = {}) {
    this.checkRequiredCredentials();
    return this._request('GET', '/api/v3/openOrderList', { ...params }, true, 6);
  }

  /**
   * Fetch prevented matches (self-trade prevention). Weight: 2-20
   */
  async fetchPreventedMatches(symbol, orderId = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { symbol: symbol.toUpperCase(), ...params };
    if (orderId) request.orderId = orderId;
    return this._request('GET', '/api/v3/myPreventedMatches', request, true, 4);
  }

  /**
   * Fetch SOR allocations. Weight: 20
   */
  async fetchAllocations(symbol, startTime = undefined, endTime = undefined, limit = 500, params = {}) {
    this.checkRequiredCredentials();
    const request = { symbol: symbol.toUpperCase(), limit, ...params };
    if (startTime) request.startTime = startTime;
    if (endTime) request.endTime = endTime;
    return this._request('GET', '/api/v3/myAllocations', request, true, 20);
  }

  /**
   * Fetch order amendments. Weight: 4
   */
  async fetchOrderAmendments(symbol, orderId, params = {}) {
    this.checkRequiredCredentials();
    return this._request('GET', '/api/v3/order/amendments', {
      symbol: symbol.toUpperCase(),
      orderId,
      ...params,
    }, true, 4);
  }

  /**
   * Fetch user's relevant filters for a symbol. Weight: 40
   */
  async fetchMyFilters(symbol, params = {}) {
    this.checkRequiredCredentials();
    return this._request('GET', '/api/v3/myFilters', {
      symbol: symbol.toUpperCase(),
      ...params,
    }, true, 40);
  }

  // ===========================================================================
  // USER DATA STREAM (Listen Key management)
  // ===========================================================================

  /** Create a listen key for user data stream. Weight: 2 */
  async createListenKey() {
    const data = await this._request('POST', '/api/v3/userDataStream', {}, false, 2);
    // Manually add API key header since this doesn't need signature
    this._listenKey = data.listenKey;
    return data.listenKey;
  }

  /** Keep alive listen key. Must be called every 30 minutes. Weight: 2 */
  async keepAliveListenKey(listenKey = undefined) {
    const key = listenKey || this._listenKey;
    if (!key) throw new ExchangeError(this.id + ' no listenKey available');
    return this._request('PUT', '/api/v3/userDataStream', { listenKey: key }, false, 2);
  }

  /** Close listen key. Weight: 2 */
  async closeListenKey(listenKey = undefined) {
    const key = listenKey || this._listenKey;
    if (!key) return;
    await this._request('DELETE', '/api/v3/userDataStream', { listenKey: key }, false, 2);
    this._listenKey = null;
  }

  _startListenKeyKeepAlive() {
    if (this._listenKeyTimer) clearInterval(this._listenKeyTimer);
    // Keep alive every 25 minutes (Binance requires every 30 min)
    this._listenKeyTimer = setInterval(() => {
      this.keepAliveListenKey().catch((err) => {
        this.emit('error', err);
      });
    }, 25 * 60 * 1000);
  }

  // ===========================================================================
  // WEBSOCKET STREAMS (16 stream types + User Data)
  // ===========================================================================

  /**
   * Get or create a WebSocket client for the stream endpoint.
   */
  _getWsClient(url = undefined) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }
    const client = new WsClient({ url: wsUrl, pingInterval: 30000 });
    this._wsClients.set(wsUrl, client);
    return client;
  }

  async _ensureWsConnected(url = undefined) {
    const client = this._getWsClient(url);
    if (!client.connected) {
      await client.connect();
    }
    return client;
  }

  async _subscribeStream(streamName, callback) {
    const client = await this._ensureWsConnected();
    const id = Date.now();

    client.subscribe(streamName, {
      method: 'SUBSCRIBE',
      params: [streamName],
      id,
    });

    // Set up handler for this stream
    const handler = (data) => {
      // Individual stream: data is the payload directly
      // Combined stream: data has { stream, data } wrapper
      if (data.stream === streamName) {
        callback(data.data);
      } else if (data.e || data.bids || data.asks || data.s || data.b) {
        // Direct stream (no wrapper)
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(streamName, { handler, callback });
    return streamName;
  }

  async _unsubscribeStream(streamName) {
    const client = this._getWsClient();
    if (client.connected) {
      client.send({
        method: 'UNSUBSCRIBE',
        params: [streamName],
        id: Date.now(),
      });
    }
    const entry = this._wsHandlers.get(streamName);
    if (entry) {
      client.removeListener('message', entry.handler);
      this._wsHandlers.delete(streamName);
    }
  }

  /** Watch 24hr ticker. Stream: <symbol>@ticker */
  async watchTicker(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@ticker`;
    return this._subscribeStream(stream, (data) => {
      callback(this._parseWsTicker(data));
    });
  }

  /** Watch all tickers. Stream: !ticker@arr */
  async watchAllTickers(callback) {
    return this._subscribeStream('!ticker@arr', (data) => {
      if (Array.isArray(data)) {
        callback(data.map((t) => this._parseWsTicker(t)));
      }
    });
  }

  /** Watch book ticker (best bid/ask). Stream: <symbol>@bookTicker */
  async watchBookTicker(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@bookTicker`;
    return this._subscribeStream(stream, (data) => {
      callback({
        symbol: data.s,
        bid: parseFloat(data.b),
        bidVolume: parseFloat(data.B),
        ask: parseFloat(data.a),
        askVolume: parseFloat(data.A),
        timestamp: Date.now(),
      });
    });
  }

  /** Watch order book depth. Stream: <symbol>@depth<levels>@100ms */
  async watchOrderBook(symbol, callback, levels = 20) {
    const stream = `${symbol.toLowerCase()}@depth${levels}@100ms`;
    return this._subscribeStream(stream, (data) => {
      callback({
        symbol,
        bids: data.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        asks: data.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        timestamp: Date.now(),
      });
    });
  }

  /** Watch diff depth stream. Stream: <symbol>@depth@100ms */
  async watchDiffDepth(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@depth@100ms`;
    return this._subscribeStream(stream, (data) => {
      callback({
        symbol: data.s,
        firstUpdateId: data.U,
        lastUpdateId: data.u,
        bids: data.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        asks: data.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
        timestamp: data.E,
      });
    });
  }

  /** Watch trades. Stream: <symbol>@trade */
  async watchTrades(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@trade`;
    return this._subscribeStream(stream, (data) => {
      callback({
        id: data.t,
        symbol: data.s,
        price: parseFloat(data.p),
        amount: parseFloat(data.q),
        cost: parseFloat(data.p) * parseFloat(data.q),
        side: data.m ? 'sell' : 'buy',
        timestamp: data.T,
        datetime: iso8601(data.T),
      });
    });
  }

  /** Watch aggregate trades. Stream: <symbol>@aggTrade */
  async watchAggTrades(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@aggTrade`;
    return this._subscribeStream(stream, (data) => {
      callback({
        id: data.a,
        symbol: data.s,
        price: parseFloat(data.p),
        amount: parseFloat(data.q),
        side: data.m ? 'sell' : 'buy',
        timestamp: data.T,
      });
    });
  }

  /** Watch klines/candlesticks. Stream: <symbol>@kline_<interval> */
  async watchKlines(symbol, interval, callback) {
    const tf = this.timeframes[interval] || interval;
    const stream = `${symbol.toLowerCase()}@kline_${tf}`;
    return this._subscribeStream(stream, (data) => {
      const k = data.k;
      callback({
        symbol: k.s,
        interval: k.i,
        timestamp: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        closed: k.x,
      });
    });
  }

  /** Watch mini ticker. Stream: <symbol>@miniTicker */
  async watchMiniTicker(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@miniTicker`;
    return this._subscribeStream(stream, (data) => {
      callback({
        symbol: data.s,
        close: parseFloat(data.c),
        open: parseFloat(data.o),
        high: parseFloat(data.h),
        low: parseFloat(data.l),
        volume: parseFloat(data.v),
        quoteVolume: parseFloat(data.q),
        timestamp: data.E,
      });
    });
  }

  /** Watch all mini tickers. Stream: !miniTicker@arr */
  async watchAllMiniTickers(callback) {
    return this._subscribeStream('!miniTicker@arr', (data) => {
      if (Array.isArray(data)) {
        callback(data.map((t) => ({
          symbol: t.s,
          close: parseFloat(t.c),
          open: parseFloat(t.o),
          high: parseFloat(t.h),
          low: parseFloat(t.l),
          volume: parseFloat(t.v),
          quoteVolume: parseFloat(t.q),
          timestamp: t.E,
        })));
      }
    });
  }

  /** Watch average price. Stream: <symbol>@avgPrice */
  async watchAvgPrice(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@avgPrice`;
    return this._subscribeStream(stream, (data) => {
      callback({
        symbol: data.s,
        price: parseFloat(data.w),
        timestamp: data.E,
      });
    });
  }

  /**
   * Watch user balance updates (via User Data Stream).
   * Automatically manages listenKey creation and keep-alive.
   */
  async watchBalance(callback) {
    if (!this._listenKey) {
      await this.createListenKey();
      this._startListenKeyKeepAlive();
    }

    const wsUrl = this.urls.ws + '/' + this._listenKey;
    const client = await this._ensureWsConnected(wsUrl);

    client.on('message', (data) => {
      if (data.e === 'outboundAccountPosition') {
        const balances = {};
        for (const b of data.B) {
          balances[b.a] = {
            free: parseFloat(b.f),
            used: parseFloat(b.l),
            total: parseFloat(b.f) + parseFloat(b.l),
          };
        }
        callback({ event: 'balance', timestamp: data.E, balances });
      } else if (data.e === 'balanceUpdate') {
        callback({
          event: 'balanceUpdate',
          asset: data.a,
          delta: parseFloat(data.d),
          timestamp: data.E,
        });
      }
    });
  }

  /**
   * Watch order updates (via User Data Stream).
   */
  async watchOrders(callback) {
    if (!this._listenKey) {
      await this.createListenKey();
      this._startListenKeyKeepAlive();
    }

    const wsUrl = this.urls.ws + '/' + this._listenKey;
    const client = await this._ensureWsConnected(wsUrl);

    client.on('message', (data) => {
      if (data.e === 'executionReport') {
        callback(this._parseWsOrder(data));
      } else if (data.e === 'listStatus') {
        callback({
          event: 'orderList',
          symbol: data.s,
          orderListId: data.g,
          listStatusType: data.l,
          listOrderStatus: data.L,
          timestamp: data.E,
        });
      }
    });
  }

  /**
   * Close all WebSocket connections.
   */
  async closeAllWs() {
    for (const [, client] of this._wsClients) {
      await client.close();
    }
    this._wsClients.clear();
    this._wsHandlers.clear();
    if (this._listenKeyTimer) {
      clearInterval(this._listenKeyTimer);
      this._listenKeyTimer = null;
    }
    if (this._listenKey) {
      await this.closeListenKey().catch(() => {});
    }
  }

  // ===========================================================================
  // PARSERS — Normalize raw Binance responses to unified format
  // ===========================================================================

  _parseTicker(data) {
    return {
      symbol: safeString(data, 'symbol'),
      last: safeFloat(data, 'lastPrice'),
      high: safeFloat(data, 'highPrice'),
      low: safeFloat(data, 'lowPrice'),
      open: safeFloat(data, 'openPrice'),
      close: safeFloat(data, 'lastPrice'),
      bid: safeFloat(data, 'bidPrice'),
      bidVolume: safeFloat(data, 'bidQty'),
      ask: safeFloat(data, 'askPrice'),
      askVolume: safeFloat(data, 'askQty'),
      volume: safeFloat(data, 'volume'),
      quoteVolume: safeFloat(data, 'quoteVolume'),
      change: safeFloat(data, 'priceChange'),
      percentage: safeFloat(data, 'priceChangePercent'),
      vwap: safeFloat(data, 'weightedAvgPrice'),
      timestamp: safeInteger(data, 'closeTime'),
      datetime: iso8601(safeInteger(data, 'closeTime')),
      info: data,
    };
  }

  _parseWsTicker(data) {
    return {
      symbol: data.s,
      last: parseFloat(data.c),
      high: parseFloat(data.h),
      low: parseFloat(data.l),
      open: parseFloat(data.o),
      close: parseFloat(data.c),
      bid: parseFloat(data.b),
      bidVolume: parseFloat(data.B),
      ask: parseFloat(data.a),
      askVolume: parseFloat(data.A),
      volume: parseFloat(data.v),
      quoteVolume: parseFloat(data.q),
      change: parseFloat(data.p),
      percentage: parseFloat(data.P),
      timestamp: data.E,
      datetime: iso8601(data.E),
    };
  }

  _parseOrder(data) {
    const filled = safeFloat(data, 'executedQty') || 0;
    const amount = safeFloat(data, 'origQty') || 0;
    const price = safeFloat(data, 'price') || 0;
    const cost = safeFloat(data, 'cummulativeQuoteQty') || 0;
    const average = filled > 0 ? cost / filled : 0;

    return {
      id: safeString(data, 'orderId'),
      clientOrderId: safeString(data, 'clientOrderId'),
      symbol: safeString(data, 'symbol'),
      type: safeStringUpper(data, 'type'),
      side: safeStringUpper(data, 'side'),
      price,
      amount,
      filled,
      remaining: amount - filled,
      cost,
      average,
      status: safeString(data, 'status'),
      timeInForce: safeString(data, 'timeInForce'),
      timestamp: safeInteger(data, 'transactTime') || safeInteger(data, 'time'),
      datetime: iso8601(safeInteger(data, 'transactTime') || safeInteger(data, 'time')),
      trades: (data.fills || []).map((f) => ({
        price: parseFloat(f.price),
        amount: parseFloat(f.qty),
        commission: parseFloat(f.commission),
        commissionAsset: f.commissionAsset,
      })),
      info: data,
    };
  }

  _parseWsOrder(data) {
    const filled = parseFloat(data.z || '0');
    const amount = parseFloat(data.q || '0');
    const cost = parseFloat(data.Z || '0');
    const average = filled > 0 ? cost / filled : 0;

    return {
      event: 'order',
      id: String(data.i),
      clientOrderId: data.c,
      symbol: data.s,
      type: data.o,
      side: data.S,
      price: parseFloat(data.p),
      amount,
      filled,
      remaining: amount - filled,
      cost,
      average,
      status: data.X,
      executionType: data.x, // NEW, CANCELED, REPLACED, REJECTED, TRADE, EXPIRED
      timeInForce: data.f,
      lastPrice: parseFloat(data.L),
      lastQty: parseFloat(data.l),
      commission: parseFloat(data.n),
      commissionAsset: data.N,
      timestamp: data.T,
      datetime: iso8601(data.T),
      tradeId: data.t,
    };
  }

  _parseTrade(data, symbol) {
    return {
      id: safeString(data, 'id'),
      symbol: symbol || safeString(data, 'symbol'),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'qty'),
      cost: (safeFloat(data, 'price') || 0) * (safeFloat(data, 'qty') || 0),
      timestamp: safeInteger(data, 'time'),
      datetime: iso8601(safeInteger(data, 'time')),
      isBuyerMaker: safeValue(data, 'isBuyerMaker'),
      info: data,
    };
  }

  _parseMyTrade(data, symbol) {
    return {
      id: safeString(data, 'id'),
      orderId: safeString(data, 'orderId'),
      symbol: symbol || safeString(data, 'symbol'),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'qty'),
      cost: safeFloat(data, 'quoteQty'),
      fee: {
        cost: safeFloat(data, 'commission'),
        currency: safeString(data, 'commissionAsset'),
      },
      timestamp: safeInteger(data, 'time'),
      datetime: iso8601(safeInteger(data, 'time')),
      isBuyer: safeValue(data, 'isBuyer'),
      isMaker: safeValue(data, 'isMaker'),
      info: data,
    };
  }
}

module.exports = Binance;

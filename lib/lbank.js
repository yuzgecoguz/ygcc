'use strict';

const BaseExchange = require('./BaseExchange');
const { md5, hmacSHA256 } = require('./utils/crypto');
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

class LBank extends BaseExchange {

  describe() {
    return {
      id: 'lbank',
      name: 'LBank',
      version: 'v2',
      rateLimit: 50,
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
        // WebSocket — V3 JSON subscribe (public channels)
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: true,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://api.lbank.info',
        ws: 'wss://www.lbank.com/ws/V3/',
        doc: 'https://www.lbank.com/docs/',
      },
      timeframes: {
        '1m': 'minute1',
        '5m': 'minute5',
        '15m': 'minute15',
        '30m': 'minute30',
        '1h': 'hour1',
        '4h': 'hour4',
        '8h': 'hour8',
        '12h': 'hour12',
        '1d': 'day1',
        '1w': 'week1',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = false;
    this.postAsFormEncoded = false;
    this._wsClients = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION — MD5 + HMAC-SHA256 two-step signing
  // ===========================================================================

  /**
   * LBank V2 authentication.
   *
   * Signing flow:
   * 1. Build all params: api_key + endpoint params + echostr + signature_method + timestamp
   * 2. Sort alphabetically, join as key=val&key=val (NO URL encoding)
   * 3. MD5(joined_string) → uppercase hex
   * 4. HMAC-SHA256(md5_hash, secret) → hex signature
   * 5. Return: params (api_key + endpoint params + sign), headers (timestamp, signature_method, echostr)
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = Date.now().toString();
    const echostr = this._generateEchostr(32);

    // Build all params for signing
    const allParams = {
      api_key: this.apiKey,
      ...params,
      echostr,
      signature_method: 'HmacSHA256',
      timestamp,
    };

    // Sort alphabetically and join WITHOUT URL encoding
    const sorted = Object.keys(allParams).sort();
    const paramStr = sorted.map((k) => `${k}=${allParams[k]}`).join('&');

    // Step 1: MD5 → uppercase hex
    const md5Hash = md5(paramStr).toUpperCase();

    // Step 2: HMAC-SHA256 of MD5 hash with secret
    const sign = hmacSHA256(md5Hash, this.secret);

    // Params for URL query string: api_key + endpoint params + sign
    const queryParams = { api_key: this.apiKey, ...params, sign };

    // Headers: timestamp, signature_method, echostr
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'timestamp': timestamp,
      'signature_method': 'HmacSHA256',
      'echostr': echostr,
    };

    return { params: queryParams, headers };
  }

  /**
   * Generate random alphanumeric echostr for LBank auth.
   */
  _generateEchostr(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // SYMBOL HELPERS
  // ===========================================================================

  /**
   * Convert unified symbol to LBank format: BTC/USDT → btc_usdt
   */
  _toLBankSymbol(symbol) {
    return symbol.replace('/', '_').toLowerCase();
  }

  /**
   * Convert LBank symbol to unified format: btc_usdt → BTC/USDT
   */
  _fromLBankSymbol(lbankSymbol) {
    if (this.marketsById && this.marketsById[lbankSymbol]) {
      return this.marketsById[lbankSymbol].symbol;
    }
    const parts = lbankSymbol.split('_');
    return parts[0].toUpperCase() + '/' + parts[1].toUpperCase();
  }

  // ===========================================================================
  // PUBLIC — Market Data
  // ===========================================================================

  async fetchTime() {
    const response = await this._request('GET', '/v2/timestamp.do');
    return safeInteger(response, 'data');
  }

  async loadMarkets() {
    const response = await this._request('GET', '/v2/accuracy.do');
    const data = response.data || [];
    const markets = {};
    const marketsById = {};

    for (const m of data) {
      const id = safeString(m, 'symbol');
      if (!id) continue;
      const parts = id.split('_');
      const base = parts[0].toUpperCase();
      const quote = parts[1].toUpperCase();
      const symbol = base + '/' + quote;

      const entry = {
        id,
        symbol,
        base,
        quote,
        active: true,
        precision: {
          amount: safeInteger(m, 'quantityAccuracy', 8),
          price: safeInteger(m, 'priceAccuracy', 8),
        },
        limits: {
          amount: { min: safeFloat(m, 'minTranQua') },
        },
        info: m,
      };

      markets[symbol] = entry;
      marketsById[id] = entry;
    }

    this.markets = markets;
    this.marketsById = marketsById;
    return markets;
  }

  async fetchTicker(symbol) {
    const pair = this._toLBankSymbol(symbol);
    const response = await this._request('GET', '/v2/ticker/24hr.do', { symbol: pair });

    // Single ticker response wraps data in array or object
    const data = Array.isArray(response.data) ? response.data[0] : response.data;
    if (!data) {
      return this._parseTicker(response, symbol);
    }
    return this._parseTicker(data, symbol);
  }

  async fetchTickers(symbols = undefined) {
    const response = await this._request('GET', '/v2/ticker/24hr.do', { symbol: 'all' });
    const data = response.data || [];
    const result = {};

    for (const item of data) {
      const lbankSymbol = safeString(item, 'symbol');
      if (!lbankSymbol) continue;
      const unifiedSymbol = this._fromLBankSymbol(lbankSymbol);
      if (symbols && !symbols.includes(unifiedSymbol)) continue;
      result[unifiedSymbol] = this._parseTicker(item, unifiedSymbol);
    }
    return result;
  }

  async fetchOrderBook(symbol, limit = 60) {
    const pair = this._toLBankSymbol(symbol);
    const params = { symbol: pair, size: limit };
    const response = await this._request('GET', '/v2/depth.do', params);
    const data = response.data || response;

    const asks = (data.asks || []).map((entry) => [parseFloat(entry[0]), parseFloat(entry[1])]);
    const bids = (data.bids || []).map((entry) => [parseFloat(entry[0]), parseFloat(entry[1])]);

    return {
      symbol,
      asks,
      bids,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
    };
  }

  async fetchTrades(symbol, limit = 100) {
    const pair = this._toLBankSymbol(symbol);
    const params = { symbol: pair, size: limit };
    const response = await this._request('GET', '/v2/supplement/trades.do', params);
    const data = response.data || [];

    return data.map((trade) => this._parseTrade(trade, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1m', since = undefined, limit = 100) {
    const pair = this._toLBankSymbol(symbol);
    const interval = this.timeframes[timeframe];
    if (!interval) {
      throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);
    }

    const params = { symbol: pair, size: limit, type: interval };
    if (since) {
      params.time = Math.floor(since / 1000).toString();
    }

    const response = await this._request('GET', '/v2/kline.do', params);
    const data = response.data || [];

    return data.map((candle) => this._parseCandle(candle));
  }

  // ===========================================================================
  // PRIVATE — Trading
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined) {
    const pair = this._toLBankSymbol(symbol);
    let orderType;

    if (type === 'limit') {
      orderType = side; // 'buy' or 'sell'
    } else if (type === 'market') {
      orderType = side + '_market'; // 'buy_market' or 'sell_market'
    } else {
      orderType = side;
    }

    const params = {
      symbol: pair,
      type: orderType,
      amount: amount.toString(),
    };

    if (type === 'limit' && price !== undefined) {
      params.price = price.toString();
    }

    const response = await this._request('POST', '/v2/supplement/create_order.do', params, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    const data = response.data || response;
    return {
      id: safeString(data, 'order_id', safeString(data, 'orderId')),
      clientOrderId: safeString(data, 'custom_id'),
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

  async createLimitOrder(symbol, side, amount, price) {
    return this.createOrder(symbol, 'limit', side, amount, price);
  }

  async createMarketOrder(symbol, side, amount) {
    return this.createOrder(symbol, 'market', side, amount);
  }

  async cancelOrder(id, symbol) {
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder requires symbol');
    const pair = this._toLBankSymbol(symbol);
    const params = { symbol: pair, orderId: id };
    const response = await this._request('POST', '/v2/supplement/cancel_order.do', params, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    return {
      id,
      symbol,
      info: response,
    };
  }

  async cancelAllOrders(symbol) {
    if (!symbol) throw new BadRequest(this.id + ' cancelAllOrders requires symbol');
    const pair = this._toLBankSymbol(symbol);
    const params = { symbol: pair };
    const response = await this._request('POST', '/v2/supplement/cancel_order_by_symbol.do', params, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    return response;
  }

  async fetchOrder(id, symbol) {
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder requires symbol');
    const pair = this._toLBankSymbol(symbol);
    const params = { symbol: pair, orderId: id };
    const response = await this._request('POST', '/v2/spot/trade/orders_info.do', params, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    const data = response.data || response;
    return this._parseOrder(data, symbol);
  }

  async fetchOpenOrders(symbol = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' fetchOpenOrders requires symbol');
    const pair = this._toLBankSymbol(symbol);
    const params = { symbol: pair, current_page: '1', page_length: '100' };
    const response = await this._request('POST', '/v2/supplement/orders_info_no_deal.do', params, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    const data = response.data || {};
    const orders = data.orders || [];
    return orders.map((order) => this._parseOrder(order, symbol));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = 100) {
    if (!symbol) throw new BadRequest(this.id + ' fetchClosedOrders requires symbol');
    const pair = this._toLBankSymbol(symbol);
    const params = { symbol: pair, current_page: '1', page_length: String(limit) };
    if (since) params.start_time = since.toString();

    const response = await this._request('POST', '/v2/spot/trade/orders_info_history.do', params, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    const data = response.data || {};
    const orders = data.orders || [];
    return orders.map((order) => this._parseOrder(order, symbol));
  }

  // ===========================================================================
  // PRIVATE — Account
  // ===========================================================================

  async fetchBalance() {
    const response = await this._request('POST', '/v2/supplement/user_info.do', {}, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    const data = response.data || {};
    const result = { info: response, timestamp: Date.now(), datetime: iso8601(Date.now()) };

    // LBank returns { toBtc: {...}, freeze: {...}, asset: {...}, free: {...} }
    const free = data.free || {};
    const freeze = data.freeze || {};
    const asset = data.asset || {};

    for (const currency of Object.keys(free)) {
      const code = currency.toUpperCase();
      result[code] = {
        free: parseFloat(free[currency]) || 0,
        used: parseFloat(freeze[currency]) || 0,
        total: parseFloat(asset[currency]) || 0,
      };
    }

    return result;
  }

  async fetchTradingFees() {
    const response = await this._request('POST', '/v2/supplement/customer_trade_fee.do', {}, true);

    if (response.result === 'false' || response.result === false) {
      this._handleLBankError(response.error_code, response);
    }

    const data = response.data || [];
    const result = {};

    for (const item of (Array.isArray(data) ? data : [])) {
      const symbol = this._fromLBankSymbol(safeString(item, 'symbol', ''));
      result[symbol] = {
        maker: safeFloat(item, 'makerCommission'),
        taker: safeFloat(item, 'takerCommission'),
        info: item,
      };
    }

    return result;
  }

  // ===========================================================================
  // PARSERS
  // ===========================================================================

  _parseTicker(data, symbol = undefined) {
    const ticker = data.ticker || data;
    const timestamp = safeInteger(data, 'timestamp') || Date.now();
    const lbankSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (lbankSymbol ? this._fromLBankSymbol(lbankSymbol) : undefined);

    return {
      symbol: resolvedSymbol,
      timestamp,
      datetime: iso8601(timestamp),
      high: safeFloat(ticker, 'high'),
      low: safeFloat(ticker, 'low'),
      bid: safeFloat(ticker, 'bid'),
      ask: safeFloat(ticker, 'ask'),
      last: safeFloat(ticker, 'latest'),
      open: undefined,
      close: safeFloat(ticker, 'latest'),
      change: safeFloat(ticker, 'change'),
      percentage: safeFloat(ticker, 'change'),
      baseVolume: safeFloat(ticker, 'vol'),
      quoteVolume: safeFloat(ticker, 'turnover'),
      info: data,
    };
  }

  _parseOrder(data, symbol = undefined) {
    const lbankSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (lbankSymbol ? this._fromLBankSymbol(lbankSymbol) : undefined);

    // LBank status: -1=cancelled, 0=trading(open), 1=partially filled, 2=fully filled, 4=cancelling
    const statusRaw = safeInteger(data, 'status');
    let status;
    if (statusRaw === -1) status = 'canceled';
    else if (statusRaw === 0 || statusRaw === 1 || statusRaw === 4) status = 'open';
    else if (statusRaw === 2) status = 'closed';
    else status = 'open';

    const typeStr = safeString(data, 'type', '');
    const isMarket = typeStr.includes('market');
    const side = typeStr.includes('buy') ? 'buy' : 'sell';
    const type = isMarket ? 'market' : 'limit';

    const amount = safeFloat(data, 'amount');
    const price = safeFloat(data, 'price');
    const filled = safeFloat(data, 'deal_amount', safeFloat(data, 'dealAmount'));
    const avgPrice = safeFloat(data, 'avg_price', safeFloat(data, 'avgPrice'));
    const remaining = (amount && filled !== undefined) ? amount - filled : undefined;
    const cost = (filled && avgPrice) ? filled * avgPrice : undefined;
    const createTime = safeInteger(data, 'create_time', safeInteger(data, 'createTime'));

    return {
      id: safeString(data, 'order_id', safeString(data, 'orderId')),
      clientOrderId: safeString(data, 'custom_id', safeString(data, 'customId')),
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
    const timestamp = safeInteger(data, 'date_ms');
    const price = safeFloat(data, 'price');
    const amount = safeFloat(data, 'amount');
    const side = safeString(data, 'type'); // 'buy' or 'sell'
    const id = safeString(data, 'tid');

    return {
      id,
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

  _parseCandle(data) {
    // LBank candle: [timestamp, open, high, low, close, volume]
    if (!Array.isArray(data) || data.length < 6) return data;

    return [
      typeof data[0] === 'number' && data[0] < 1e12 ? data[0] * 1000 : data[0], // Convert seconds to ms if needed
      parseFloat(data[1]),  // open
      parseFloat(data[2]),  // high
      parseFloat(data[3]),  // low
      parseFloat(data[4]),  // close
      parseFloat(data[5]),  // volume
    ];
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleLBankError(errorCode, response) {
    const code = parseInt(errorCode, 10);
    const msg = this.id + ' error ' + errorCode + ': ' + JSON.stringify(response);

    switch (code) {
      case 10007:
        throw new AuthenticationError(msg);
      case 10008:
        throw new BadSymbol(msg);
      case 10014:
        throw new InsufficientFunds(msg);
      case 10022:
        throw new AuthenticationError(msg);
      case 10024:
        throw new InvalidOrder(msg);
      case 10033:
        throw new InvalidOrder(msg);
      case 10036:
        throw new InvalidOrder(msg);
      default:
        throw new ExchangeError(msg);
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
  // WEBSOCKET — V3 JSON subscribe (public channels)
  // ===========================================================================

  /**
   * Get or create a WS client for the given URL.
   */
  _getWsClient(url) {
    if (this._wsClients.has(url)) {
      return this._wsClients.get(url);
    }
    const client = new WsClient(url, {
      pingInterval: 15000,
      reconnect: true,
    });

    // Handle LBank ping: server sends {"ping":"uuid","action":"ping"}, echo back same
    client.on('message', (data) => {
      if (data && data.action === 'ping') {
        client.send(data);
      }
    });

    this._wsClients.set(url, client);
    return client;
  }

  /**
   * Ensure WS client is connected.
   */
  async _ensureWsConnected(url) {
    const client = this._getWsClient(url);
    if (!client.isConnected()) {
      await client.connect();
    }
    return client;
  }

  /**
   * Subscribe to an LBank WS channel.
   * @param {string} channel - 'depth', 'trade', 'tick', 'kbar'
   * @param {string} pair - LBank symbol e.g. 'btc_usdt'
   * @param {object} extra - Extra subscribe params (e.g. { depth: '50' } or { kbar: 'minute1' })
   * @param {function} callback - Callback(type, data)
   */
  async _subscribeLBank(channel, pair, extra, callback) {
    const url = this.urls.ws;
    const client = await this._ensureWsConnected(url);

    const subMsg = {
      action: 'subscribe',
      subscribe: channel,
      pair,
      ...extra,
    };

    client.send(subMsg);

    const handler = (data) => {
      if (data && data.type === channel && data.pair === pair) {
        callback(data);
      }
    };
    client.on('message', handler);

    const channelKey = `${channel}:${pair}`;
    if (!this._wsHandlers) this._wsHandlers = new Map();
    this._wsHandlers.set(channelKey, { handler, callback });

    return channelKey;
  }

  /**
   * Watch real-time ticker updates for a symbol.
   */
  async watchTicker(symbol, callback) {
    const pair = this._toLBankSymbol(symbol);
    return this._subscribeLBank('tick', pair, {}, (data) => {
      const ticker = this._parseWsTicker(data, symbol);
      callback(ticker);
    });
  }

  /**
   * Watch real-time order book updates for a symbol.
   */
  async watchOrderBook(symbol, callback, limit = 50) {
    const pair = this._toLBankSymbol(symbol);
    return this._subscribeLBank('depth', pair, { depth: String(limit) }, (data) => {
      const orderBook = this._parseWsOrderBook(data, symbol);
      callback(orderBook);
    });
  }

  /**
   * Watch real-time trade updates for a symbol.
   */
  async watchTrades(symbol, callback) {
    const pair = this._toLBankSymbol(symbol);
    return this._subscribeLBank('trade', pair, {}, (data) => {
      const trades = this._parseWsTrades(data, symbol);
      callback(trades);
    });
  }

  /**
   * Watch real-time kline/candlestick updates for a symbol.
   */
  async watchKlines(symbol, timeframe, callback) {
    const pair = this._toLBankSymbol(symbol);
    const interval = this.timeframes[timeframe];
    if (!interval) {
      throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);
    }
    return this._subscribeLBank('kbar', pair, { kbar: interval }, (data) => {
      const kline = this._parseWsKline(data, symbol);
      callback(kline);
    });
  }

  /**
   * Close all WebSocket connections.
   */
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
    const tick = data.tick || data;
    const lbankSymbol = safeString(data, 'pair');
    const resolvedSymbol = symbol || (lbankSymbol ? this._fromLBankSymbol(lbankSymbol) : undefined);

    return {
      symbol: resolvedSymbol,
      timestamp: safeInteger(data, 'TS', Date.now()),
      datetime: iso8601(safeInteger(data, 'TS', Date.now())),
      high: safeFloat(tick, 'high'),
      low: safeFloat(tick, 'low'),
      bid: safeFloat(tick, 'bid'),
      ask: safeFloat(tick, 'ask'),
      last: safeFloat(tick, 'latest', safeFloat(tick, 'close')),
      open: safeFloat(tick, 'open'),
      close: safeFloat(tick, 'latest', safeFloat(tick, 'close')),
      change: safeFloat(tick, 'change'),
      baseVolume: safeFloat(tick, 'vol'),
      quoteVolume: safeFloat(tick, 'turnover'),
      info: data,
    };
  }

  _parseWsOrderBook(data, symbol = undefined) {
    const depth = data.depth || data;
    const lbankSymbol = safeString(data, 'pair');
    const resolvedSymbol = symbol || (lbankSymbol ? this._fromLBankSymbol(lbankSymbol) : undefined);

    const asks = (depth.asks || []).map((entry) => [parseFloat(entry[0]), parseFloat(entry[1])]);
    const bids = (depth.bids || []).map((entry) => [parseFloat(entry[0]), parseFloat(entry[1])]);

    return {
      symbol: resolvedSymbol,
      asks,
      bids,
      timestamp: safeInteger(data, 'TS', Date.now()),
      datetime: iso8601(safeInteger(data, 'TS', Date.now())),
      nonce: undefined,
      info: data,
    };
  }

  _parseWsTrades(data, symbol = undefined) {
    const tradeData = data.trade || data;
    const lbankSymbol = safeString(data, 'pair');
    const resolvedSymbol = symbol || (lbankSymbol ? this._fromLBankSymbol(lbankSymbol) : undefined);

    if (Array.isArray(tradeData)) {
      return tradeData.map((t) => ({
        id: safeString(t, 'tid'),
        symbol: resolvedSymbol,
        timestamp: safeInteger(t, 'date_ms', safeInteger(t, 'TS')),
        datetime: iso8601(safeInteger(t, 'date_ms', safeInteger(t, 'TS'))),
        side: safeString(t, 'type', safeString(t, 'direction')),
        price: safeFloat(t, 'price'),
        amount: safeFloat(t, 'amount', safeFloat(t, 'volume')),
        info: t,
      }));
    }

    return [{
      id: safeString(tradeData, 'tid'),
      symbol: resolvedSymbol,
      timestamp: safeInteger(tradeData, 'date_ms', safeInteger(tradeData, 'TS')),
      datetime: iso8601(safeInteger(tradeData, 'date_ms', safeInteger(tradeData, 'TS'))),
      side: safeString(tradeData, 'type', safeString(tradeData, 'direction')),
      price: safeFloat(tradeData, 'price'),
      amount: safeFloat(tradeData, 'amount', safeFloat(tradeData, 'volume')),
      info: tradeData,
    }];
  }

  _parseWsKline(data, symbol = undefined) {
    const kbar = data.kbar || data;
    const lbankSymbol = safeString(data, 'pair');
    const resolvedSymbol = symbol || (lbankSymbol ? this._fromLBankSymbol(lbankSymbol) : undefined);

    if (Array.isArray(kbar)) {
      return this._parseCandle(kbar);
    }

    return {
      symbol: resolvedSymbol,
      timestamp: safeInteger(kbar, 'timestamp', safeInteger(kbar, 'TS')),
      open: safeFloat(kbar, 'open'),
      high: safeFloat(kbar, 'high'),
      low: safeFloat(kbar, 'low'),
      close: safeFloat(kbar, 'close'),
      volume: safeFloat(kbar, 'vol', safeFloat(kbar, 'volume')),
      info: data,
    };
  }
}

module.exports = LBank;

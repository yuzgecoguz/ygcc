'use strict';

const crypto = require('crypto');
const BaseExchange = require('./BaseExchange');
const { hmacSHA384Hex } = require('./utils/crypto');
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

class Bitfinex extends BaseExchange {

  describe() {
    return {
      id: 'bitfinex',
      name: 'Bitfinex',
      version: 'v2',
      rateLimit: 1000,
      rateLimitCapacity: 60,
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
        api: 'https://api.bitfinex.com',
        apiPublic: 'https://api-pub.bitfinex.com',
        ws: 'wss://api-pub.bitfinex.com/ws/2',
        doc: 'https://docs.bitfinex.com/',
      },
      timeframes: {
        '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
        '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
        '1d': '1D', '1w': '1W',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.002 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this._wsClients = new Map();
    this._wsChannelMap = new Map();     // chanId → { channel, symbol, key }
    this._wsPrivateAuthenticated = false;
    this._pingTimers = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION — HMAC-SHA384 Hex (Bitfinex V2)
  // ===========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const nonce = (Date.now() * 1000).toString();
    const body = JSON.stringify(params && Object.keys(params).length > 0 ? params : {});

    // Signature: /api/{path}{nonce}{body}
    const signaturePayload = '/api/' + path + nonce + body;
    const signature = hmacSHA384Hex(signaturePayload, this.secret);

    const headers = {
      'bfx-nonce': nonce,
      'bfx-apikey': this.apiKey,
      'bfx-signature': signature,
    };

    return { params, headers };
  }

  _getBaseUrl(signed) {
    return signed ? this.urls.api : this.urls.apiPublic;
  }

  // ===========================================================================
  // RESPONSE HANDLING — Bitfinex returns arrays, errors as ['error', code, msg]
  // ===========================================================================

  _unwrapResponse(data) {
    // Bitfinex error format: ['error', code, 'message']
    if (Array.isArray(data) && data[0] === 'error') {
      const code = data[1];
      const msg = data[2] || 'Unknown error';
      this._handleBitfinexError(code, msg);
    }
    return data;
  }

  _handleResponseHeaders(headers) {
    // Bitfinex rate limit info in headers
    if (headers && headers['x-ratelimit-remaining']) {
      const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
      if (remaining <= 1) {
        this.rateLimiter?.throttle(2);
      }
    }
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    let msg = body;

    // Bitfinex error format in response: ['error', code, 'message'] or { message: '...' }
    if (Array.isArray(parsed) && parsed[0] === 'error') {
      const code = parsed[1];
      msg = parsed[2] || body;
      this._handleBitfinexError(code, msg);
    }

    if (parsed && parsed.message) {
      msg = parsed.message;
    }

    const full = this.id + ' HTTP ' + status + ': ' + msg;
    if (status === 400) throw new BadRequest(full);
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 404) throw new ExchangeError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    if (status === 500 || status === 502 || status === 503) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  _handleBitfinexError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;

    const errorMap = {
      // Authentication errors
      10100: AuthenticationError,   // Authentication failed
      10111: AuthenticationError,   // Invalid API key
      10112: AuthenticationError,   // Invalid nonce (too small)
      10113: AuthenticationError,   // Invalid signature
      10114: AuthenticationError,   // Invalid nonce

      // Rate limiting
      11010: RateLimitExceeded,     // Rate limit reached

      // Request errors
      10001: ExchangeError,         // Generic error
      10020: BadRequest,            // Invalid request
      10300: BadSymbol,             // Symbol not found

      // Trading errors
      13000: InsufficientFunds,     // Not enough margin/balance

      // Maintenance
      20060: ExchangeNotAvailable,  // Maintenance mode
    };

    const ErrorClass = errorMap[code] || ExchangeError;
    throw new ErrorClass(full);
  }

  // ===========================================================================
  // HELPERS — Symbol conversion, amount sign logic
  // ===========================================================================

  /**
   * Convert unified symbol to Bitfinex format.
   * BTC/USD → tBTCUSD
   * BTC/USDT → tBTCUST
   */
  _toBitfinexSymbol(symbol) {
    if (symbol.startsWith('t')) return symbol;
    const [base, quote] = symbol.split('/');

    // Reverse special mappings for Bitfinex
    const bfxQuote = this._toShortCurrency(quote);
    const bfxBase = this._toShortCurrency(base);

    return 't' + bfxBase + bfxQuote;
  }

  /**
   * Convert Bitfinex symbol to unified format.
   * tBTCUSD → BTC/USD
   * tBTCUST → BTC/USDT
   */
  _fromBitfinexSymbol(symbol) {
    if (!symbol) return symbol;
    if (symbol.includes('/')) return symbol;

    // Strip 't' prefix
    let pair = symbol;
    if (pair.startsWith('t')) pair = pair.substring(1);

    // Handle colon-separated pairs (e.g., tTESTBTC:TESTUSD)
    if (pair.includes(':')) {
      const [base, quote] = pair.split(':');
      return this._fromShortCurrency(base) + '/' + this._fromShortCurrency(quote);
    }

    // Standard 6-char pairs (3+3)
    if (pair.length === 6) {
      const base = pair.substring(0, 3);
      const quote = pair.substring(3);
      return this._fromShortCurrency(base) + '/' + this._fromShortCurrency(quote);
    }

    // Longer pairs — try common splits
    if (pair.length > 6) {
      // Try to find known quote currencies at the end
      const knownQuotes = ['UST', 'USD', 'BTC', 'ETH', 'EUT', 'EUR', 'GBP', 'JPY', 'USTF0'];
      for (const q of knownQuotes) {
        if (pair.endsWith(q)) {
          const base = pair.substring(0, pair.length - q.length);
          if (base.length > 0) {
            return this._fromShortCurrency(base) + '/' + this._fromShortCurrency(q);
          }
        }
      }
    }

    return pair;
  }

  /**
   * Convert Bitfinex short currency to standard.
   * UST → USDT, EUT → EURT
   */
  _fromShortCurrency(currency) {
    const map = {
      'UST': 'USDT',
      'EUT': 'EURT',
    };
    return map[currency] || currency;
  }

  /**
   * Convert standard currency to Bitfinex short form.
   * USDT → UST, EURT → EUT
   */
  _toShortCurrency(currency) {
    const map = {
      'USDT': 'UST',
      'EURT': 'EUT',
    };
    return map[currency] || currency;
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    // Bitfinex V2 doesn't have a dedicated time endpoint
    // Use platform status and return current timestamp
    const data = await this._request('GET', '/v2/platform/status', {}, false, 1);
    this._unwrapResponse(data);
    return Date.now();
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (6 endpoints)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    // Fetch symbol details from V1 API (has precision + min/max size)
    const data = await this._request('GET', '/v1/symbols_details', {}, false, 1);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const list = Array.isArray(data) ? data : [];
    for (const item of list) {
      const pair = (item.pair || '').toLowerCase();
      if (!pair) continue;

      let base, quote;
      if (pair.includes(':')) {
        const parts = pair.split(':');
        base = this._fromShortCurrency(parts[0].toUpperCase());
        quote = this._fromShortCurrency(parts[1].toUpperCase());
      } else if (pair.length >= 6) {
        base = this._fromShortCurrency(pair.substring(0, 3).toUpperCase());
        quote = this._fromShortCurrency(pair.substring(3).toUpperCase());
      } else {
        continue;
      }

      const symbol = base + '/' + quote;
      const bfxSymbol = 't' + pair.toUpperCase();

      const market = {
        id: bfxSymbol,
        symbol,
        base,
        quote,
        status: 'tradable',
        active: true,
        precision: {
          price: safeInteger(item, 'price_precision') || 5,
          amount: 8,
          base: 8,
          quote: safeInteger(item, 'price_precision') || 5,
        },
        limits: {
          price: {
            min: undefined,
            max: undefined,
          },
          amount: {
            min: safeFloat(item, 'minimum_order_size'),
            max: safeFloat(item, 'maximum_order_size'),
          },
          cost: {
            min: undefined,
            max: undefined,
          },
        },
        margin: safeValue(item, 'margin') === true,
        info: item,
      };

      this.markets[symbol] = market;
      this.marketsById[bfxSymbol] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol, params = {}) {
    const bfxSymbol = this._toBitfinexSymbol(symbol);
    const data = await this._request('GET', '/v2/ticker/' + bfxSymbol, params, false, 1);
    this._unwrapResponse(data);

    if (!Array.isArray(data) || data.length < 10) {
      throw new BadSymbol(this.id + ' symbol not found: ' + symbol);
    }
    return this._parseTicker(data, symbol);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    const request = { symbols: 'ALL', ...params };
    if (symbols && symbols.length > 0) {
      request.symbols = symbols.map((s) => this._toBitfinexSymbol(s)).join(',');
    }

    const data = await this._request('GET', '/v2/tickers', request, false, 1);
    this._unwrapResponse(data);

    const tickers = {};
    const list = Array.isArray(data) ? data : [];
    for (const t of list) {
      if (!Array.isArray(t) || t.length < 11) continue;
      // Skip funding tickers (start with 'f')
      const bfxSym = t[0];
      if (typeof bfxSym === 'string' && bfxSym.startsWith('f')) continue;

      const sym = this._fromBitfinexSymbol(bfxSym);
      if (!symbols || symbols.includes(sym)) {
        tickers[sym] = this._parseTickerFromTickers(t);
      }
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = 25, params = {}) {
    const bfxSymbol = this._toBitfinexSymbol(symbol);
    const precision = params.precision || 'P0';
    const request = { len: String(limit) };

    const path = '/v2/book/' + bfxSymbol + '/' + precision;
    const data = await this._request('GET', path, request, false, 1);
    this._unwrapResponse(data);

    return this._parseOrderBook(data, symbol);
  }

  async fetchTrades(symbol, since = undefined, limit = undefined, params = {}) {
    const bfxSymbol = this._toBitfinexSymbol(symbol);
    const request = { ...params };
    if (limit) request.limit = limit;
    if (since) request.start = since;
    request.sort = -1; // newest first

    const path = '/v2/trades/' + bfxSymbol + '/hist';
    const data = await this._request('GET', path, request, false, 1);
    this._unwrapResponse(data);

    const list = Array.isArray(data) ? data : [];
    return list.map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = undefined, params = {}) {
    const bfxSymbol = this._toBitfinexSymbol(symbol);
    const tf = this.timeframes[timeframe] || timeframe;
    const key = 'trade:' + tf + ':' + bfxSymbol;

    const request = { ...params };
    if (limit) request.limit = limit;
    if (since) request.start = since;
    request.sort = 1; // chronological order

    const path = '/v2/candles/' + key + '/hist';
    const data = await this._request('GET', path, request, false, 1);
    this._unwrapResponse(data);

    const list = Array.isArray(data) ? data : [];
    return list.map((c) => this._parseCandle(c));
  }

  // ===========================================================================
  // TRADING — PRIVATE (7 endpoints)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const bfxSymbol = this._toBitfinexSymbol(symbol);

    // Bitfinex uses amount sign for side: positive = buy, negative = sell
    const signedAmount = side.toLowerCase() === 'buy'
      ? String(Math.abs(amount))
      : String(-Math.abs(amount));

    // Order type: 'EXCHANGE LIMIT' for spot limit, 'EXCHANGE MARKET' for spot market
    const orderType = this._buildOrderType(type);

    const request = {
      type: orderType,
      symbol: bfxSymbol,
      amount: signedAmount,
      ...params,
    };

    if (price !== undefined && price !== null && type.toLowerCase() === 'limit') {
      request.price = String(price);
    }

    const data = await this._request('POST', '/v2/auth/w/order/submit', request, true, 1);
    this._unwrapResponse(data);

    return this._parseOrderCreateResult(data);
  }

  async createLimitOrder(symbol, side, amount, price, params = {}) {
    return this.createOrder(symbol, 'limit', side, amount, price, params);
  }

  async createMarketOrder(symbol, side, amount, params = {}) {
    return this.createOrder(symbol, 'market', side, amount, undefined, params);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { id: parseInt(id, 10), ...params };
    const data = await this._request('POST', '/v2/auth/w/order/cancel', request, true, 1);
    this._unwrapResponse(data);

    return {
      id: String(id),
      symbol,
      status: 'CANCELED',
      info: data,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { all: 1, ...params };
    const data = await this._request('POST', '/v2/auth/w/order/cancel/multi', request, true, 1);
    this._unwrapResponse(data);

    return {
      info: data,
    };
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    // Try open orders first
    const openData = await this._request('POST', '/v2/auth/r/orders', {}, true, 1);
    this._unwrapResponse(openData);

    const openList = Array.isArray(openData) ? openData : [];
    for (const o of openList) {
      if (Array.isArray(o) && String(o[0]) === String(id)) {
        return this._parseOrder(o);
      }
    }

    // Try historical orders
    const histData = await this._request('POST', '/v2/auth/r/orders/hist', { id: [parseInt(id, 10)] }, true, 1);
    this._unwrapResponse(histData);

    const histList = Array.isArray(histData) ? histData : [];
    for (const o of histList) {
      if (Array.isArray(o) && String(o[0]) === String(id)) {
        return this._parseOrder(o);
      }
    }

    throw new OrderNotFound(this.id + ' order not found: ' + id);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    let path = '/v2/auth/r/orders';
    if (symbol) {
      path += '/' + this._toBitfinexSymbol(symbol);
    }

    const data = await this._request('POST', path, params, true, 1);
    this._unwrapResponse(data);

    const list = Array.isArray(data) ? data : [];
    return list.map((o) => this._parseOrder(o));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    let path = '/v2/auth/r/orders';
    if (symbol) {
      path += '/' + this._toBitfinexSymbol(symbol);
    }
    path += '/hist';

    const request = { ...params };
    if (since) request.start = since;
    if (limit) request.limit = limit;

    const data = await this._request('POST', path, request, true, 1);
    this._unwrapResponse(data);

    const list = Array.isArray(data) ? data : [];
    return list.map((o) => this._parseOrder(o));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    let path = '/v2/auth/r/trades';
    if (symbol) {
      path += '/' + this._toBitfinexSymbol(symbol);
    }
    path += '/hist';

    const request = { ...params };
    if (since) request.start = since;
    if (limit) request.limit = limit;

    const data = await this._request('POST', path, request, true, 1);
    this._unwrapResponse(data);

    const list = Array.isArray(data) ? data : [];
    return list.map((t) => this._parseMyTrade(t));
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('POST', '/v2/auth/r/wallets', params, true, 1);
    this._unwrapResponse(data);

    const balance = {
      info: data,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    const list = Array.isArray(data) ? data : [];
    for (const wallet of list) {
      if (!Array.isArray(wallet) || wallet.length < 5) continue;

      // [WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED_INTEREST, AVAILABLE_BALANCE]
      const walletType = wallet[0];
      const currency = wallet[1];
      const total = wallet[2] || 0;
      const available = wallet[4] !== null && wallet[4] !== undefined ? wallet[4] : total;

      // Only include exchange (spot) wallets
      if (walletType !== 'exchange') continue;

      const upperCurrency = this._fromShortCurrency(currency ? currency.toUpperCase() : currency);
      const used = total - available;

      if (total !== 0 || available !== 0) {
        balance[upperCurrency] = {
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

    const data = await this._request('POST', '/v2/auth/r/summary', params, true, 1);
    this._unwrapResponse(data);

    // Response format varies but includes fee info
    if (!data) return {};

    // Extract fees from summary
    let makerFee = this.fees.trading.maker;
    let takerFee = this.fees.trading.taker;

    if (Array.isArray(data)) {
      // Nested array structure
      for (const section of data) {
        if (Array.isArray(section)) {
          // Look for fee-related fields
          const makerVal = safeFloat(section, 'maker_fee');
          const takerVal = safeFloat(section, 'taker_fee');
          if (makerVal !== undefined) makerFee = makerVal;
          if (takerVal !== undefined) takerFee = takerVal;
        }
      }
    } else if (typeof data === 'object') {
      if (data.maker_fee !== undefined) makerFee = parseFloat(data.maker_fee);
      if (data.taker_fee !== undefined) takerFee = parseFloat(data.taker_fee);
    }

    return {
      maker: makerFee,
      taker: takerFee,
      info: data,
    };
  }

  // ===========================================================================
  // WEBSOCKET — Channel-based (Public + Private auth)
  // ===========================================================================

  _getWsClient(url) {
    if (this._wsClients.has(url)) {
      return this._wsClients.get(url);
    }
    const client = new WsClient({
      url,
      pingInterval: 0, // Bitfinex sends heartbeats
    });
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

  async _subscribePublic(channel, symbol, callback, extra = {}) {
    const wsUrl = this.urls.ws;
    const client = await this._ensureWsConnected(wsUrl);
    const bfxSymbol = this._toBitfinexSymbol(symbol);

    const subMsg = {
      event: 'subscribe',
      channel,
      symbol: bfxSymbol,
      ...extra,
    };
    client.send(subMsg);

    const key = channel + ':' + bfxSymbol;

    const handler = (data) => {
      // Handle subscription confirmation
      if (data && data.event === 'subscribed' && data.channel === channel) {
        this._wsChannelMap.set(data.chanId, { channel, symbol, key });
        return;
      }

      // Handle data messages [chanId, data]
      if (Array.isArray(data) && data.length >= 2) {
        const chanId = data[0];
        const payload = data[1];

        // Skip heartbeats
        if (payload === 'hb') return;

        const mapping = this._wsChannelMap.get(chanId);
        if (mapping && mapping.key === key) {
          callback(data);
        }
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async _subscribeCandles(symbol, timeframe, callback) {
    const wsUrl = this.urls.ws;
    const client = await this._ensureWsConnected(wsUrl);
    const bfxSymbol = this._toBitfinexSymbol(symbol);
    const tf = this.timeframes[timeframe] || timeframe;
    const candleKey = 'trade:' + tf + ':' + bfxSymbol;

    const subMsg = {
      event: 'subscribe',
      channel: 'candles',
      key: candleKey,
    };
    client.send(subMsg);

    const key = 'candles:' + candleKey;

    const handler = (data) => {
      if (data && data.event === 'subscribed' && data.channel === 'candles') {
        this._wsChannelMap.set(data.chanId, { channel: 'candles', symbol, key });
        return;
      }

      if (Array.isArray(data) && data.length >= 2) {
        const chanId = data[0];
        const payload = data[1];
        if (payload === 'hb') return;

        const mapping = this._wsChannelMap.get(chanId);
        if (mapping && mapping.key === key) {
          callback(data);
        }
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async _subscribePrivate(callback) {
    const wsUrl = this.urls.ws;
    const client = await this._ensureWsConnected(wsUrl);

    if (!this._wsPrivateAuthenticated) {
      this.checkRequiredCredentials();

      const nonce = (Date.now() * 1000).toString();
      const authPayload = 'AUTH' + nonce;
      const authSig = hmacSHA384Hex(authPayload, this.secret);

      const authMsg = {
        event: 'auth',
        apiKey: this.apiKey,
        authPayload,
        authSig,
        authNonce: nonce,
        dms: 4,
      };
      client.send(authMsg);
      this._wsPrivateAuthenticated = true;
    }

    const key = 'auth:private';

    const handler = (data) => {
      // Auth confirmation
      if (data && data.event === 'auth') {
        return;
      }

      // Private channel data: [0, TYPE, DATA]
      if (Array.isArray(data) && data[0] === 0 && data.length >= 3) {
        const type = data[1];
        const payload = data[2];

        // Skip heartbeats and info messages
        if (type === 'hb' || type === 'n') return;

        callback(type, payload);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async watchTicker(symbol, callback) {
    return this._subscribePublic('ticker', symbol, (data) => {
      // data: [chanId, [BID, BID_SIZE, ASK, ASK_SIZE, ...]]
      const payload = data[1];
      if (Array.isArray(payload) && payload.length >= 10) {
        callback(this._parseTicker(payload, symbol));
      }
    });
  }

  async watchOrderBook(symbol, callback) {
    return this._subscribePublic('book', symbol, (data) => {
      const payload = data[1];
      if (Array.isArray(payload)) {
        // Snapshot: [[PRICE, COUNT, AMOUNT], ...] or single update: [PRICE, COUNT, AMOUNT]
        if (Array.isArray(payload[0])) {
          // Snapshot
          callback(this._parseOrderBook(payload, symbol));
        } else if (payload.length === 3) {
          // Single update
          const [price, count, amount] = payload;
          const side = amount > 0 ? 'bids' : 'asks';
          callback({
            symbol,
            type: 'update',
            side,
            price: Math.abs(price),
            count,
            amount: Math.abs(amount),
            timestamp: Date.now(),
          });
        }
      }
    }, { prec: 'P0', len: '25' });
  }

  async watchTrades(symbol, callback) {
    return this._subscribePublic('trades', symbol, (data) => {
      const payload = data[1];
      // Trade execution: 'te' event or array
      if (data[1] === 'te' && Array.isArray(data[2])) {
        callback(this._parseTrade(data[2], symbol));
      } else if (Array.isArray(payload) && Array.isArray(payload[0])) {
        // Snapshot
        for (const t of payload) {
          callback(this._parseTrade(t, symbol));
        }
      }
    });
  }

  async watchKlines(symbol, interval, callback) {
    return this._subscribeCandles(symbol, interval, (data) => {
      const payload = data[1];
      if (Array.isArray(payload)) {
        if (Array.isArray(payload[0])) {
          // Snapshot of candles
          for (const c of payload) {
            const candle = this._parseCandle(c);
            callback({
              symbol,
              interval,
              timestamp: candle[0],
              open: candle[1],
              high: candle[2],
              low: candle[3],
              close: candle[4],
              volume: candle[5],
              closed: false,
            });
          }
        } else if (payload.length === 6) {
          // Single candle update
          const candle = this._parseCandle(payload);
          callback({
            symbol,
            interval,
            timestamp: candle[0],
            open: candle[1],
            high: candle[2],
            low: candle[3],
            close: candle[4],
            volume: candle[5],
            closed: false,
          });
        }
      }
    });
  }

  async watchBalance(callback) {
    return this._subscribePrivate((type, payload) => {
      // Wallet update: 'wu' = wallet update, 'ws' = wallet snapshot
      if ((type === 'wu' || type === 'ws') && Array.isArray(payload)) {
        const wallets = type === 'ws' ? payload : [payload];
        const balances = {};
        for (const w of wallets) {
          if (!Array.isArray(w) || w.length < 5) continue;
          if (w[0] !== 'exchange') continue;

          const currency = this._fromShortCurrency(w[1] ? w[1].toUpperCase() : '');
          const total = w[2] || 0;
          const available = w[4] !== null && w[4] !== undefined ? w[4] : total;
          balances[currency] = {
            free: available,
            used: Math.max(0, total - available),
            total,
          };
        }
        callback({
          event: 'balance',
          timestamp: Date.now(),
          balances,
        });
      }
    });
  }

  async watchOrders(callback) {
    return this._subscribePrivate((type, payload) => {
      // on=order new, ou=order update, oc=order cancel
      if ((type === 'on' || type === 'ou' || type === 'oc') && Array.isArray(payload)) {
        callback(this._parseOrder(payload));
      }
    });
  }

  async closeAllWs() {
    for (const [, client] of this._wsClients) {
      await client.close();
    }
    this._wsClients.clear();
    this._wsHandlers.clear();
    this._wsChannelMap.clear();
    this._wsPrivateAuthenticated = false;
    for (const [, timer] of this._pingTimers) {
      clearInterval(timer);
    }
    this._pingTimers.clear();
  }

  // ===========================================================================
  // PARSERS — Normalize Bitfinex arrays to unified format
  // ===========================================================================

  /**
   * Parse ticker from single ticker response.
   * Input: [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_PERC, LAST_PRICE, VOLUME, HIGH, LOW]
   */
  _parseTicker(data, symbol) {
    const bid = data[0];
    const bidVolume = data[1];
    const ask = data[2];
    const askVolume = data[3];
    const change = data[4];
    const changePerc = data[5];
    const last = data[6];
    const volume = data[7];
    const high = data[8];
    const low = data[9];

    return {
      symbol,
      last,
      high,
      low,
      open: last !== undefined && change !== undefined ? last - change : undefined,
      close: last,
      bid,
      bidVolume,
      ask,
      askVolume,
      volume,
      quoteVolume: undefined,
      change,
      percentage: changePerc !== undefined ? changePerc * 100 : undefined,
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  /**
   * Parse ticker from /tickers response (has extra SYMBOL at index 0).
   * Input: [SYMBOL, BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_PERC, LAST_PRICE, VOLUME, HIGH, LOW]
   */
  _parseTickerFromTickers(data) {
    const bfxSymbol = data[0];
    const symbol = this._fromBitfinexSymbol(bfxSymbol);

    const bid = data[1];
    const bidVolume = data[2];
    const ask = data[3];
    const askVolume = data[4];
    const change = data[5];
    const changePerc = data[6];
    const last = data[7];
    const volume = data[8];
    const high = data[9];
    const low = data[10];

    return {
      symbol,
      last,
      high,
      low,
      open: last !== undefined && change !== undefined ? last - change : undefined,
      close: last,
      bid,
      bidVolume,
      ask,
      askVolume,
      volume,
      quoteVolume: undefined,
      change,
      percentage: changePerc !== undefined ? changePerc * 100 : undefined,
      vwap: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  /**
   * Parse order from 32-element array.
   * [0]=ID, [1]=GID, [2]=CID, [3]=SYMBOL, [4]=MTS_CREATE, [5]=MTS_UPDATE,
   * [6]=AMOUNT(remaining), [7]=AMOUNT_ORIG, [8]=TYPE, [9]=TYPE_PREV,
   * [10]=MTS_TIF, [11]=_, [12]=FLAGS, [13]=STATUS,
   * [14]=_, [15]=_, [16]=PRICE, [17]=PRICE_AVG,
   * [18]=PRICE_TRAILING, [19]=PRICE_AUX_LIMIT
   */
  _parseOrder(data) {
    if (!Array.isArray(data) || data.length < 20) {
      return { info: data };
    }

    const id = data[0];
    const symbol = this._fromBitfinexSymbol(data[3]);
    const mtsCreate = data[4];
    const mtsUpdate = data[5];
    const remaining = data[6];
    const amountOrig = data[7];
    const orderType = data[8];
    const statusRaw = data[13];
    const price = data[16];
    const priceAvg = data[17];

    // Side: positive amount = buy, negative = sell
    const side = amountOrig > 0 ? 'buy' : 'sell';
    const absOrig = Math.abs(amountOrig || 0);
    const absRemaining = Math.abs(remaining || 0);
    const filled = absOrig - absRemaining;
    const cost = priceAvg ? filled * Math.abs(priceAvg) : 0;

    // Normalize status
    let status = 'NEW';
    if (typeof statusRaw === 'string') {
      const upper = statusRaw.toUpperCase();
      if (upper.includes('ACTIVE') || upper.includes('PARTIALLY FILLED')) {
        status = filled > 0 ? 'PARTIALLY_FILLED' : 'NEW';
      } else if (upper.includes('EXECUTED') || upper.includes('FILLED')) {
        status = 'FILLED';
      } else if (upper.includes('CANCELED') || upper.includes('CANCELLED')) {
        status = 'CANCELED';
      }
    }

    // Normalize type: 'EXCHANGE LIMIT' → 'LIMIT', 'EXCHANGE MARKET' → 'MARKET'
    let type = orderType;
    if (typeof type === 'string') {
      type = type.replace('EXCHANGE ', '').toUpperCase();
    }

    return {
      id: String(id),
      clientOrderId: data[2] ? String(data[2]) : undefined,
      symbol,
      type,
      side,
      price: price || 0,
      amount: absOrig,
      filled,
      remaining: absRemaining,
      cost,
      average: priceAvg || 0,
      status,
      timestamp: mtsCreate,
      datetime: mtsCreate ? iso8601(mtsCreate) : undefined,
      lastTradeTimestamp: mtsUpdate,
      trades: [],
      fee: {
        cost: undefined,
        currency: undefined,
      },
      info: data,
    };
  }

  /**
   * Parse order creation result from notification wrapper.
   * Input: [MTS, TYPE, MSG_ID, null, [ORDER_ARRAY], CODE, STATUS, TEXT]
   */
  _parseOrderCreateResult(data) {
    if (!Array.isArray(data)) {
      return { info: data };
    }

    // Notification format: data[4] contains the order array, data[6] is STATUS
    const orderData = data[4];
    const status = data[6];
    const text = data[7];

    if (status === 'ERROR' || status === 'FAILURE') {
      throw new InvalidOrder(this.id + ' order creation failed: ' + (text || status));
    }

    if (Array.isArray(orderData) && orderData.length >= 20) {
      const order = this._parseOrder(orderData);
      order.status = 'NEW';
      return order;
    }

    // Fallback: return basic info
    return {
      id: orderData ? String(orderData[0]) : undefined,
      status: 'NEW',
      info: data,
    };
  }

  /**
   * Parse public trade.
   * Input: [ID, MTS, AMOUNT, PRICE]
   * AMOUNT > 0 = buy, AMOUNT < 0 = sell
   */
  _parseTrade(data, symbol) {
    if (!Array.isArray(data) || data.length < 4) {
      return { info: data };
    }

    const id = data[0];
    const mts = data[1];
    const amount = data[2];
    const price = data[3];

    const side = amount > 0 ? 'buy' : 'sell';
    const absAmount = Math.abs(amount);

    return {
      id: String(id),
      symbol,
      price,
      amount: absAmount,
      cost: price * absAmount,
      side,
      timestamp: mts,
      datetime: iso8601(mts),
      info: data,
    };
  }

  /**
   * Parse private trade (fill).
   * Input: [ID, PAIR, MTS, ORDER_ID, EXEC_AMOUNT, EXEC_PRICE, ORDER_TYPE, ORDER_PRICE, MAKER, FEE, FEE_CURRENCY]
   */
  _parseMyTrade(data) {
    if (!Array.isArray(data) || data.length < 11) {
      return { info: data };
    }

    const id = data[0];
    const pair = data[1];
    const mts = data[2];
    const orderId = data[3];
    const execAmount = data[4];
    const execPrice = data[5];
    const maker = data[8];
    const fee = data[9];
    const feeCurrency = data[10];

    const side = execAmount > 0 ? 'buy' : 'sell';
    const absAmount = Math.abs(execAmount);
    const symbol = this._fromBitfinexSymbol(pair);

    return {
      id: String(id),
      orderId: String(orderId),
      symbol,
      price: execPrice,
      amount: absAmount,
      cost: execPrice * absAmount,
      fee: {
        cost: fee ? Math.abs(fee) : 0,
        currency: feeCurrency ? this._fromShortCurrency(feeCurrency.toUpperCase()) : undefined,
      },
      timestamp: mts,
      datetime: mts ? iso8601(mts) : undefined,
      side,
      isMaker: maker === 1,
      info: data,
    };
  }

  /**
   * Parse candle — reorder OCHLV → OHLCV.
   * Input:  [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
   * Output: [MTS, OPEN, HIGH, LOW, CLOSE, VOLUME]
   */
  _parseCandle(data) {
    if (!Array.isArray(data) || data.length < 6) {
      return data;
    }
    return [
      data[0],  // MTS (timestamp in ms)
      data[1],  // OPEN
      data[3],  // HIGH  (index 3 → position 2)
      data[4],  // LOW   (index 4 → position 3)
      data[2],  // CLOSE (index 2 → position 4)
      data[5],  // VOLUME
    ];
  }

  /**
   * Parse order book from array of [PRICE, COUNT, AMOUNT].
   * AMOUNT > 0 = bid, AMOUNT < 0 = ask
   */
  _parseOrderBook(data, symbol) {
    const bids = [];
    const asks = [];

    const list = Array.isArray(data) ? data : [];
    for (const entry of list) {
      if (!Array.isArray(entry) || entry.length < 3) continue;

      const price = entry[0];
      const count = entry[1];
      const amount = entry[2];

      if (count === 0) continue; // removed price level

      if (amount > 0) {
        bids.push([price, amount]);
      } else {
        asks.push([price, Math.abs(amount)]);
      }
    }

    // Sort: bids descending, asks ascending
    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);

    return {
      symbol,
      bids,
      asks,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
    };
  }

  /**
   * Build Bitfinex order type string.
   * 'limit' → 'EXCHANGE LIMIT', 'market' → 'EXCHANGE MARKET'
   */
  _buildOrderType(type) {
    const t = type.toUpperCase();
    if (t === 'LIMIT') return 'EXCHANGE LIMIT';
    if (t === 'MARKET') return 'EXCHANGE MARKET';
    if (t === 'STOP') return 'EXCHANGE STOP';
    if (t === 'STOP LIMIT' || t === 'STOP_LIMIT') return 'EXCHANGE STOP LIMIT';
    if (t === 'TRAILING STOP' || t === 'TRAILING_STOP') return 'EXCHANGE TRAILING STOP';
    if (t === 'FOK') return 'EXCHANGE FOK';
    if (t === 'IOC') return 'EXCHANGE IOC';
    // If already prefixed with EXCHANGE, return as-is
    if (t.startsWith('EXCHANGE')) return t;
    return 'EXCHANGE ' + t;
  }
}

module.exports = Bitfinex;

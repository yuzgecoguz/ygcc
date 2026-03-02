'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA512Hex } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, iso8601,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Exmo extends BaseExchange {
  describe() {
    return {
      id: 'exmo',
      name: 'EXMO',
      version: 'v1.1',
      rateLimit: 100,
      rateLimitCapacity: 10,
      rateLimitInterval: 1000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: true,
        fetchTickers: true,
        fetchOrderBook: true,
        fetchTrades: false,
        fetchOHLCV: false,
        fetchTime: false,
        // Private
        createOrder: true,
        createLimitOrder: true,
        createMarketOrder: true,
        cancelOrder: true,
        cancelAllOrders: false,
        fetchOrder: false,
        fetchOpenOrders: true,
        fetchClosedOrders: false,
        fetchMyTrades: false,
        fetchBalance: true,
        fetchTradingFees: false,
        amendOrder: false,
        // WebSocket
        watchOrderBook: true,
        watchTicker: false,
        watchTrades: false,
        watchKlines: false,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://api.exmo.com',
        ws: 'wss://ws-api.exmo.com/v1/public',
        doc: 'https://documenter.getpostman.com/view/10287440/SzYXWKPi',
      },
      timeframes: {},
      fees: {
        trading: { maker: 0.002, taker: 0.003 },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(config = {}) {
    super(config);
    this.postAsFormEncoded = true;
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ---------------------------------------------------------------------------
  // Authentication — HMAC-SHA512, form-encoded body with nonce
  // ---------------------------------------------------------------------------

  /**
   * EXMO auth: ALL private endpoints use POST with form-encoded body.
   * 1. Inject nonce (ms timestamp) into body params
   * 2. URL-encode the body params
   * 3. HMAC-SHA512(bodyStr, secret) → Sign header
   * 4. Set Key header to apiKey
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const nonce = String(Date.now());
    const body = { ...params, nonce };
    const bodyStr = new URLSearchParams(body).toString();
    const signature = hmacSHA512Hex(bodyStr, this.secret);

    return {
      params: body,
      headers: {
        'Key': this.apiKey,
        'Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTC_USD <-> BTC/USD
  // ---------------------------------------------------------------------------

  _toExmoSymbol(symbol) {
    // 'BTC/USD' → 'BTC_USD'
    return symbol.replace('/', '_');
  }

  _fromExmoSymbol(exmoSymbol) {
    // 'BTC_USD' → 'BTC/USD' (via marketsById lookup)
    if (this.marketsById && this.marketsById[exmoSymbol]) {
      return this.marketsById[exmoSymbol].symbol;
    }
    // Fallback: parse directly
    const parts = exmoSymbol.split('_');
    if (parts.length === 2) {
      return parts[0].toUpperCase() + '/' + parts[1].toUpperCase();
    }
    return exmoSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Check for explicit error: { result: false, error: "..." }
      if (data.result === false) {
        const msg = safeString(data, 'error') || 'Unknown error';
        this._handleExmoError(msg);
      }
      // Check for non-empty error string
      if (typeof data.error === 'string' && data.error.length > 0) {
        this._handleExmoError(data.error);
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  _handleExmoError(msg) {
    const full = this.id + ' ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    if (lowerMsg.includes('insufficient') || lowerMsg.includes('not enough') || lowerMsg.includes('balance')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('order_not_found')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid symbol') || lowerMsg.includes('unknown pair') || lowerMsg.includes('pair not found') || lowerMsg.includes('wrong pair')) {
      throw new BadSymbol(full);
    }
    if (lowerMsg.includes('invalid order') || lowerMsg.includes('order_invalid') || lowerMsg.includes('invalid quantity') || lowerMsg.includes('invalid price')) {
      throw new InvalidOrder(full);
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many')) {
      throw new RateLimitExceeded(full);
    }
    if (lowerMsg.includes('auth') || lowerMsg.includes('invalid key') || lowerMsg.includes('signature') || lowerMsg.includes('nonce')) {
      throw new AuthenticationError(full);
    }
    if (lowerMsg.includes('permission') || lowerMsg.includes('forbidden')) {
      throw new AuthenticationError(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.result === false || (typeof parsed.error === 'string' && parsed.error.length > 0)) {
        const msg = safeString(parsed, 'error') || body;
        this._handleExmoError(msg);
      }
    }

    const full = this.id + ' HTTP ' + statusCode + ': ' + body;
    if (statusCode === 400) throw new BadRequest(full);
    if (statusCode === 401) throw new AuthenticationError(full);
    if (statusCode === 403) throw new AuthenticationError(full);
    if (statusCode === 404) throw new BadRequest(full);
    if (statusCode === 429 || statusCode === 418) throw new RateLimitExceeded(full);
    if (statusCode >= 500) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  _parseTicker(pair, t) {
    const symbol = this._fromExmoSymbol(pair);
    const last = Number(t.last_trade);
    const ts = t.updated ? t.updated * 1000 : Date.now();

    return {
      symbol,
      last,
      high: Number(t.high) || undefined,
      low: Number(t.low) || undefined,
      open: undefined,
      close: last,
      bid: Number(t.buy_price) || undefined,
      bidVolume: undefined,
      ask: Number(t.sell_price) || undefined,
      askVolume: undefined,
      volume: Number(t.vol) || undefined,
      quoteVolume: Number(t.vol_curr) || undefined,
      change: undefined,
      percentage: undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: t,
    };
  }

  _parseOrder(o, fallbackSymbol) {
    const orderId = safeString(o, 'order_id') || safeString(o, 'id');
    const pair = safeString(o, 'pair');
    const symbol = pair ? this._fromExmoSymbol(pair) : fallbackSymbol;
    const type = safeStringUpper(o, 'order_type') || safeStringUpper(o, 'type') || 'LIMIT';
    const side = safeString(o, 'type') || safeString(o, 'side') || '';
    const price = safeFloat(o, 'price') || 0;
    const amount = safeFloat(o, 'quantity') || safeFloat(o, 'amount') || 0;
    const cost = safeFloat(o, 'amount') || 0;
    const ts = safeInteger(o, 'created') || safeInteger(o, 'timestamp') || Date.now();
    const timestamp = ts < 1e12 ? ts * 1000 : ts;

    return {
      id: orderId,
      clientOrderId: safeString(o, 'client_id'),
      symbol,
      type: type.toUpperCase(),
      side: side.toUpperCase(),
      price,
      amount,
      filled: 0,
      remaining: amount,
      cost,
      average: 0,
      status: 'open',
      timestamp,
      datetime: iso8601(timestamp),
      info: o,
    };
  }

  _parseOrderBook(pairData) {
    const asks = (pairData.ask || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.amount)];
    });
    const bids = (pairData.bid || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.amount)];
    });

    return {
      bids,
      asks,
      timestamp: undefined,
      nonce: undefined,
      info: pairData,
    };
  }

  _parseBalance(data) {
    const balance = {
      info: data,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    const balances = data.balances || {};
    const reserved = data.reserved || {};

    for (const currency of Object.keys(balances)) {
      const free = Number(balances[currency]) || 0;
      const used = Number(reserved[currency]) || 0;
      const total = free + used;

      if (free > 0 || used > 0) {
        balance[currency.toUpperCase()] = { free, used, total };
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data
  // ---------------------------------------------------------------------------

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/v1.1/pair_settings', {}, false, 5);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    // Response is object keyed by pair: { "BTC_USD": {...}, "ETH_USD": {...} }
    for (const [pair, s] of Object.entries(data)) {
      const parts = pair.split('_');
      if (parts.length < 2) continue;

      const base = parts[0].toUpperCase();
      const quote = parts[1].toUpperCase();
      const symbol = base + '/' + quote;

      const market = {
        id: pair,
        symbol,
        base,
        quote,
        active: true,
        precision: {
          price: safeInteger(s, 'price_precision') || 8,
          amount: 8,
        },
        limits: {
          price: {
            min: safeFloat(s, 'min_price'),
            max: safeFloat(s, 'max_price'),
          },
          amount: {
            min: safeFloat(s, 'min_quantity'),
            max: safeFloat(s, 'max_quantity'),
          },
          cost: {
            min: safeFloat(s, 'min_amount'),
            max: safeFloat(s, 'max_amount'),
          },
        },
        fees: {
          maker: safeFloat(s, 'commission_maker_percent')
            ? safeFloat(s, 'commission_maker_percent') / 100
            : undefined,
          taker: safeFloat(s, 'commission_taker_percent')
            ? safeFloat(s, 'commission_taker_percent') / 100
            : undefined,
        },
        info: s,
      };

      this.markets[symbol] = market;
      this.marketsById[pair] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  async fetchTicker(symbol) {
    const exmoSymbol = this._toExmoSymbol(symbol);
    const data = await this._request('GET', '/v1.1/ticker', {}, false, 1);

    const tickerData = data[exmoSymbol];
    if (!tickerData) {
      throw new BadSymbol(this.id + ' fetchTicker: unknown symbol ' + symbol);
    }
    return this._parseTicker(exmoSymbol, tickerData);
  }

  async fetchTickers(symbols = undefined) {
    const data = await this._request('GET', '/v1.1/ticker', {}, false, 1);

    const tickers = {};
    for (const [pair, tickerData] of Object.entries(data)) {
      const sym = this._fromExmoSymbol(pair);
      if (!symbols || symbols.includes(sym)) {
        tickers[sym] = this._parseTicker(pair, tickerData);
      }
    }

    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const exmoSymbol = this._toExmoSymbol(symbol);
    const params = { pair: exmoSymbol };
    if (limit) params.limit = limit;

    const data = await this._request('GET', '/v1.1/order_book', params, false, 1);

    const pairData = data[exmoSymbol];
    if (!pairData) {
      throw new BadSymbol(this.id + ' fetchOrderBook: unknown symbol ' + symbol);
    }

    const ob = this._parseOrderBook(pairData);
    return {
      symbol,
      bids: ob.bids,
      asks: ob.asks,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
      info: pairData,
    };
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account (all POST, signed)
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const exmoSymbol = this._toExmoSymbol(symbol);
    const isMarket = type && type.toUpperCase() === 'MARKET';

    const request = {
      pair: exmoSymbol,
      quantity: String(amount),
      type: side.toLowerCase(),
      ...params,
    };

    if (isMarket) {
      request.price = '0';
    } else {
      if (price === undefined || price === null) {
        throw new InvalidOrder(this.id + ' createOrder requires price for limit orders');
      }
      request.price = String(price);
    }

    const data = await this._request('POST', '/v1.1/order_create', request, true, 1);
    this._unwrapResponse(data);

    return {
      id: safeString(data, 'order_id') ? String(data.order_id) : undefined,
      symbol,
      type: type ? type.toUpperCase() : 'LIMIT',
      side: side.toUpperCase(),
      price: price !== undefined ? parseFloat(price) : 0,
      amount: parseFloat(amount),
      filled: 0,
      remaining: parseFloat(amount),
      status: 'open',
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = {
      order_id: String(id),
      ...params,
    };

    const data = await this._request('POST', '/v1.1/order_cancel', request, true, 1);
    this._unwrapResponse(data);

    return {
      id: String(id),
      symbol,
      status: 'canceled',
      info: data,
    };
  }

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('POST', '/v1.1/user_info', { ...params }, true, 1);
    this._unwrapResponse(data);

    return this._parseBalance(data);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('POST', '/v1.1/user_open_orders', { ...params }, true, 1);
    this._unwrapResponse(data);

    const orders = [];

    // Response is object keyed by pair: { "BTC_USD": [...], "ETH_USD": [...] }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [pair, pairOrders] of Object.entries(data)) {
        // Skip non-array values (e.g., result, error fields)
        if (!Array.isArray(pairOrders)) continue;

        const pairSymbol = this._fromExmoSymbol(pair);

        // Filter by symbol if specified
        if (symbol && pairSymbol !== symbol) continue;

        for (const o of pairOrders) {
          orders.push(this._parseOrder(o, pairSymbol));
        }
      }
    }

    return orders;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — plain JSON, client-initiated ping
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 30000 });

    // EXMO: client sends {"method":"ping"}, server responds {"method":"pong"}
    client._startPing = function () {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, this.pingInterval);
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

  async _subscribeExmo(topic, symbol, callback) {
    const client = await this._ensureWsConnected();

    // EXMO subscribe: {"method":"subscribe","topics":["spot/order_book_snapshots:BTC_USD"]}
    const subMsg = { method: 'subscribe', topics: [topic] };
    client.send(subMsg);

    const channelId = topic;
    const handler = (data) => {
      if (data && data.topic === topic) {
        callback(data);
      }
    };
    client.on('message', handler);
    this._wsHandlers.set(channelId, { handler, callback });
    return channelId;
  }

  // ---------------------------------------------------------------------------
  // WS Watch Methods
  // ---------------------------------------------------------------------------

  async watchOrderBook(symbol, callback, limit = undefined) {
    const exmoSymbol = this._toExmoSymbol(symbol);
    const topic = 'spot/order_book_snapshots:' + exmoSymbol;

    return this._subscribeExmo(topic, symbol, (msg) => {
      callback(this._parseWsOrderBook(msg, symbol));
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const event = data.event; // "snapshot" or "update"
    const isSnapshot = event === 'snapshot';
    const d = data.data || {};

    const asks = (d.ask || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.amount)];
    });
    const bids = (d.bid || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.amount)];
    });

    const ts = data.ts || Date.now();

    return {
      symbol,
      bids,
      asks,
      timestamp: ts,
      datetime: iso8601(ts),
      nonce: undefined,
      isSnapshot,
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

module.exports = Exmo;

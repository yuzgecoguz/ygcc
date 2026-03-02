'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256Base64 } = require('./utils/crypto');
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

class BtcTurk extends BaseExchange {
  describe() {
    return {
      id: 'btcturk',
      name: 'BtcTurk',
      version: 'v2',
      rateLimit: 200,
      rateLimitCapacity: 5,
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
        api: 'https://api.btcturk.com',
        ws: 'wss://ws-feed-pro.btcturk.com/',
        doc: 'https://docs.btcturk.com/',
      },
      timeframes: {},
      fees: {
        trading: { maker: 0.001, taker: 0.002 },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Constructor — 2 credentials: apiKey, secret
  // ---------------------------------------------------------------------------

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ---------------------------------------------------------------------------
  // Authentication — HMAC-SHA256 with Base64-decoded secret key
  // ---------------------------------------------------------------------------

  /**
   * BtcTurk uses HMAC-SHA256 with:
   *   message = apiKey + timestamp
   *   key     = Buffer.from(secret, 'base64')
   *   signature = HMAC-SHA256(message, key) → base64 output
   * Two credentials are required: apiKey, secret.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const stamp = String(Date.now());
    const message = this.apiKey + stamp;
    const key = Buffer.from(this.secret, 'base64');
    const signature = hmacSHA256Base64(message, key);

    return {
      params,
      headers: {
        'X-PCK': this.apiKey,
        'X-Stamp': stamp,
        'X-Signature': signature,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTCTRY <-> BTC/TRY (concatenated, no separator)
  // ---------------------------------------------------------------------------

  _toBtcTurkSymbol(symbol) {
    // 'BTC/TRY' -> 'BTCTRY'
    return symbol.replace('/', '');
  }

  _fromBtcTurkSymbol(btcturkSymbol) {
    // 'BTCTRY' -> 'BTC/TRY' (via marketsById lookup)
    if (this.marketsById && this.marketsById[btcturkSymbol]) {
      return this.marketsById[btcturkSymbol].symbol;
    }
    // Fallback: return raw symbol if no mapping found
    return btcturkSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling — { data: { ... }, success: true/false, code: 0 }
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Check for explicit failure
      if (data.success === false || (data.code !== undefined && data.code !== 0)) {
        const msg = safeString(data, 'message') || 'Unknown error';
        this._handleBtcTurkError(safeInteger(data, 'code') || 0, msg);
      }
      // Check for null data
      if (data.data === null && data.success !== undefined) {
        const msg = safeString(data, 'message') || 'Empty response';
        throw new ExchangeError(this.id + ' ' + msg);
      }
      // Unwrap data envelope
      if (data.data !== undefined) {
        return data.data;
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling — Exchange-level errors and HTTP status codes
  // ---------------------------------------------------------------------------

  _handleBtcTurkError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    // Map by message keywords
    if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('order_not_found')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid symbol') || lowerMsg.includes('market not found') || lowerMsg.includes('pair not found')) {
      throw new BadSymbol(full);
    }
    if (lowerMsg.includes('invalid order') || lowerMsg.includes('order_invalid')) {
      throw new InvalidOrder(full);
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many')) {
      throw new RateLimitExceeded(full);
    }
    if (lowerMsg.includes('auth') || lowerMsg.includes('permission') || lowerMsg.includes('sign') || lowerMsg.includes('credential')) {
      throw new AuthenticationError(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.success === false || (parsed.code !== undefined && parsed.code !== 0)) {
        const msg = safeString(parsed, 'message') || body;
        this._handleBtcTurkError(statusCode, msg);
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

  _parseTicker(data) {
    const pairSymbol = safeString(data, 'pair') || safeString(data, 'pairNormalized');
    const symbol = pairSymbol ? this._fromBtcTurkSymbol(safeString(data, 'pair')) : undefined;
    const last = safeFloat(data, 'last');
    const ts = safeInteger(data, 'timestamp') || Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: safeFloat(data, 'open'),
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'volume'),
      quoteVolume: undefined,
      change: safeFloat(data, 'daily'),
      percentage: safeFloat(data, 'dailyPercent'),
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'id');
    const pairSymbol = safeString(data, 'pairSymbol') || safeString(data, 'pairsymbol');
    const symbol = pairSymbol ? this._fromBtcTurkSymbol(pairSymbol) : fallbackSymbol;
    const side = safeStringUpper(data, 'type') || safeStringUpper(data, 'orderType');
    const type = safeStringUpper(data, 'method') || safeStringUpper(data, 'orderMethod') || 'LIMIT';
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'amount') || safeFloat(data, 'quantity') || 0;
    const filledAmount = safeFloat(data, 'filled_amount') || safeFloat(data, 'filledAmount') || 0;
    const status = safeString(data, 'status') || 'open';
    const ts = safeInteger(data, 'datetime') || safeInteger(data, 'time') || safeInteger(data, 'updateTime') || Date.now();

    return {
      id: orderId ? String(orderId) : undefined,
      clientOrderId: safeString(data, 'newOrderClientId'),
      symbol,
      type,
      side,
      price,
      amount,
      filled: filledAmount,
      remaining: amount > 0 ? amount - filledAmount : 0,
      cost: filledAmount * price,
      average: filledAmount > 0 ? (filledAmount * price) / filledAmount : 0,
      status,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrderBook(data, symbol) {
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.volume || entry.amount || entry.a)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.volume || entry.amount || entry.a)];
    });

    const ts = safeInteger(data, 'timestamp') || Date.now();

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

  _parseBalance(balanceData) {
    const balance = {
      info: balanceData,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    const items = Array.isArray(balanceData) ? balanceData : [];

    for (const b of items) {
      const currency = safeString(b, 'asset');
      if (!currency) continue;
      const free = safeFloat(b, 'free') || 0;
      const used = safeFloat(b, 'locked') || 0;
      const total = safeFloat(b, 'balance') || (free + used);
      if (free > 0 || total > 0) {
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

    const data = await this._request('GET', '/api/v2/server/exchangeinfo', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    // result = { symbols: [ { name: "BTCTRY", numerator: "BTC", denominator: "TRY", ... } ] }
    const symbolList = result.symbols || result;

    for (const s of symbolList) {
      const id = safeString(s, 'name');
      const base = safeString(s, 'numerator');
      const quote = safeString(s, 'denominator');
      if (!id || !base || !quote) continue;

      const symbol = base.toUpperCase() + '/' + quote.toUpperCase();

      // Parse filters for precision and limits
      const filters = s.filters || [];
      let pricePrecision = safeInteger(s, 'denominatorScale');
      let amountPrecision = safeInteger(s, 'numeratorScale');
      let minPrice, maxPrice, minAmount, maxAmount;

      for (const f of filters) {
        if (f.filterType === 'PRICE_FILTER') {
          minPrice = safeFloat(f, 'minPrice');
          maxPrice = safeFloat(f, 'maxPrice');
        }
        if (f.filterType === 'LOT_SIZE') {
          minAmount = safeFloat(f, 'minQuantity');
          maxAmount = safeFloat(f, 'maxQuantity');
        }
      }

      const market = {
        id,
        symbol,
        base: base.toUpperCase(),
        quote: quote.toUpperCase(),
        active: safeString(s, 'status') === 'TRADING',
        precision: {
          price: pricePrecision,
          amount: amountPrecision,
        },
        limits: {
          price: { min: minPrice, max: maxPrice },
          amount: { min: minAmount, max: maxAmount },
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
    const btcturkSymbol = this._toBtcTurkSymbol(symbol);
    const data = await this._request('GET', '/api/v2/ticker', {}, false, 1);
    const result = this._unwrapResponse(data);

    // result = [ { pair: "BTCTRY", ... }, ... ]
    const tickers = Array.isArray(result) ? result : [];
    const tickerData = tickers.find(t => t.pair === btcturkSymbol);

    if (!tickerData) {
      throw new BadSymbol(this.id + ' fetchTicker() symbol not found: ' + symbol);
    }

    const parsed = this._parseTicker(tickerData);
    parsed.symbol = symbol;
    return parsed;
  }

  async fetchTickers(symbols = undefined) {
    const data = await this._request('GET', '/api/v2/ticker', {}, false, 1);
    const result = this._unwrapResponse(data);

    const tickers = {};
    const tickerList = Array.isArray(result) ? result : [];

    for (const td of tickerList) {
      const pair = safeString(td, 'pair');
      if (!pair) continue;
      const sym = this._fromBtcTurkSymbol(pair);
      if (!symbols || symbols.includes(sym)) {
        const parsed = this._parseTicker(td);
        parsed.symbol = sym;
        tickers[sym] = parsed;
      }
    }

    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined, params = {}) {
    const btcturkSymbol = this._toBtcTurkSymbol(symbol);
    const request = { pairSymbol: btcturkSymbol, ...params };
    if (limit) {
      request.limit = limit;
    }

    const data = await this._request('GET', '/api/v2/orderbook', request, false, 1);
    const result = this._unwrapResponse(data);

    return this._parseOrderBook(result, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const btcturkSymbol = this._toBtcTurkSymbol(symbol);
    const orderType = side.toLowerCase(); // "buy" or "sell"
    const orderMethod = type.toLowerCase(); // "limit" or "market"

    const request = {
      quantity: parseFloat(amount),
      price: price !== undefined && price !== null ? parseFloat(price) : 0,
      stopPrice: 0,
      newOrderClientId: orderType + '_' + btcturkSymbol.toLowerCase() + '_' + Date.now(),
      orderMethod: orderMethod,
      orderType: orderType,
      pairSymbol: btcturkSymbol,
      ...params,
    };

    const data = await this._request('POST', '/api/v1/order', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'id') ? String(result.id) : safeString(data, 'id'),
      symbol,
      type: orderMethod.toUpperCase(),
      side: orderType.toUpperCase(),
      price: price !== undefined && price !== null ? parseFloat(price) : 0,
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

    // BtcTurk cancel: orderId as query param in DELETE request
    const request = { id: String(id), ...params };
    const data = await this._request('DELETE', '/api/v1/order', request, true, 1);
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

    const data = await this._request('GET', '/api/v1/users/balances', { ...params }, true, 1);
    const result = this._unwrapResponse(data);

    // result = [ { asset: "TRY", balance: "...", locked: "...", free: "..." }, ... ]
    const balanceData = Array.isArray(result) ? result : [];
    return this._parseBalance(balanceData);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { ...params };
    if (symbol) {
      request.pairSymbol = this._toBtcTurkSymbol(symbol);
    }

    const data = await this._request('GET', '/api/v1/openOrders', request, true, 1);
    const result = this._unwrapResponse(data);

    // result = { asks: [...], bids: [...] }
    const askOrders = result.asks || [];
    const bidOrders = result.bids || [];
    const allOrders = [...askOrders, ...bidOrders];

    const orders = [];
    for (const o of allOrders) {
      orders.push(this._parseOrder(o, symbol));
    }

    return orders;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — Native JSON array protocol
  // ---------------------------------------------------------------------------

  /**
   * BtcTurk WS uses a JSON array protocol:
   *   [type, payload]
   * - Subscribe to orderbook: [151, { type: 151, channel: "orderbook", event: "BTCTRY", join: true }]
   * - Orderbook update:       [422, { type: 422, CS: ..., channel: "orderbook", event: "BTCTRY", data: {...} }]
   * - Ping/pong:              server sends [991, ...], client responds [991, ...]
   */
  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 25000 });
    const exchange = this;

    // BtcTurk: server sends type 991 (ping), client responds type 991 (pong)
    // No client-initiated ping needed
    client._startPing = function () {
      // No-op: server-initiated ping handled in message handler
    };

    // Override connect for BtcTurk WS protocol
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      this.url = connectUrl || wsUrl;
      await originalConnect(this.url);

      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();

          try {
            const parsed = JSON.parse(text);

            // BtcTurk messages are arrays: [type, payload]
            if (Array.isArray(parsed) && parsed.length >= 2) {
              const msgType = parsed[0];
              const payload = parsed[1];

              // Ping: server sends 991, respond with 991
              if (msgType === 991) {
                if (this._ws && this._ws.readyState === 1) {
                  this._ws.send(JSON.stringify([991, { type: 991 }]));
                }
                return;
              }

              this.emit('message', parsed);
            }
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

  async _subscribeBtcTurk(channel, btcturkSymbol, callback) {
    const client = await this._ensureWsConnected();

    // BtcTurk subscribe: [151, { type: 151, channel: "orderbook", event: "BTCTRY", join: true }]
    const subMsg = [151, {
      type: 151,
      channel: channel,
      event: btcturkSymbol,
      join: true,
    }];
    if (client._ws && client._ws.readyState === 1) {
      client._ws.send(JSON.stringify(subMsg));
    }

    const channelId = channel + ':' + btcturkSymbol;
    const handler = (data) => {
      // data is array: [type, payload]
      if (Array.isArray(data) && data.length >= 2) {
        const payload = data[1];
        if (payload && payload.channel === channel && payload.event === btcturkSymbol) {
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

  async watchOrderBook(symbol, callback, limit = undefined) {
    const btcturkSymbol = this._toBtcTurkSymbol(symbol);
    return this._subscribeBtcTurk('orderbook', btcturkSymbol, (msg) => {
      // msg = [422, { type: 422, channel: "orderbook", event: "BTCTRY", data: { asks: [...], bids: [...] } }]
      const payload = msg[1];
      if (payload && payload.data) {
        callback(this._parseWsOrderBook(payload.data, symbol));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.volume || entry.a)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.volume || entry.a)];
    });

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

module.exports = BtcTurk;

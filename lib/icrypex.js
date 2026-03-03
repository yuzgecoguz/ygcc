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

class Icrypex extends BaseExchange {
  describe() {
    return {
      id: 'icrypex',
      name: 'iCrypex',
      version: 'v1',
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
        api: 'https://api.icrypex.com',
        ws: 'wss://istream.icrypex.com',
        doc: 'https://github.com/icrypex-com/apidoc',
      },
      timeframes: {},
      fees: {
        trading: { maker: 0.001, taker: 0.002 },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ---------------------------------------------------------------------------
  // Authentication — HMAC-SHA256 with Base64-decoded secret (same as BtcTurk)
  // ---------------------------------------------------------------------------

  /**
   * iCrypex uses HMAC-SHA256 with:
   *   message = apiKey + timestamp
   *   key     = Buffer.from(secret, 'base64')
   *   signature = HMAC-SHA256(message, key) → base64 output
   * Headers: ICX-API-KEY, ICX-SIGN, ICX-TS, ICX-NONCE
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = String(Date.now());
    const message = this.apiKey + timestamp;
    const key = Buffer.from(this.secret, 'base64');
    const signature = hmacSHA256Base64(message, key);

    return {
      params,
      headers: {
        'ICX-API-KEY': this.apiKey,
        'ICX-SIGN': signature,
        'ICX-TS': timestamp,
        'ICX-NONCE': '60000',
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTCUSDT <-> BTC/USDT (concatenated, no separator)
  // ---------------------------------------------------------------------------

  _toIcrypexSymbol(symbol) {
    // 'BTC/USDT' -> 'BTCUSDT'
    return symbol.replace('/', '');
  }

  _fromIcrypexSymbol(icrypexSymbol) {
    // 'BTCUSDT' -> 'BTC/USDT' (via marketsById lookup)
    if (this.marketsById && this.marketsById[icrypexSymbol]) {
      return this.marketsById[icrypexSymbol].symbol;
    }
    // Fallback: try common quote assets
    const quotes = ['USDT', 'USDC', 'BTC', 'ETH', 'TRY', 'EUR', 'BNB'];
    for (const q of quotes) {
      if (icrypexSymbol.endsWith(q) && icrypexSymbol.length > q.length) {
        return icrypexSymbol.slice(0, -q.length) + '/' + q;
      }
    }
    return icrypexSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.ok === false || data.success === false) {
        const msg = safeString(data, 'message') || safeString(data, 'error') || 'Unknown error';
        const code = safeString(data, 'code') || '0';
        this._handleIcrypexError(code, msg);
      }
      if (data.data !== undefined) {
        return data.data;
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  _handleIcrypexError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('order_not_found')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid symbol') || lowerMsg.includes('symbol not found') || lowerMsg.includes('pair')) {
      throw new BadSymbol(full);
    }
    if (lowerMsg.includes('invalid order') || lowerMsg.includes('quantity') || lowerMsg.includes('price')) {
      throw new InvalidOrder(full);
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many')) {
      throw new RateLimitExceeded(full);
    }
    if (lowerMsg.includes('auth') || lowerMsg.includes('permission') || lowerMsg.includes('sign') || lowerMsg.includes('key') || lowerMsg.includes('unauthorized')) {
      throw new AuthenticationError(full);
    }
    if (lowerMsg.includes('maintenance') || lowerMsg.includes('unavailable')) {
      throw new ExchangeNotAvailable(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object') {
      const msg = safeString(parsed, 'message') || safeString(parsed, 'error') || body;
      if (parsed.ok === false || parsed.success === false) {
        this._handleIcrypexError(statusCode, msg);
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
    const sym = safeString(data, 'symbol');
    const symbol = sym ? this._fromIcrypexSymbol(sym) : undefined;
    const last = safeFloat(data, 'last');
    const ts = Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: undefined,
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'qty') || safeFloat(data, 'volume'),
      quoteVolume: safeFloat(data, 'volume'),
      change: safeFloat(data, 'change'),
      percentage: undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'id') || safeString(data, 'orderId');
    const pairSymbol = safeString(data, 'symbol') || safeString(data, 'pairSymbol');
    const symbol = pairSymbol ? this._fromIcrypexSymbol(pairSymbol) : fallbackSymbol;
    const side = (safeString(data, 'side') || '').toLowerCase();
    const type = (safeString(data, 'type') || 'LIMIT').toLowerCase();
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'quantity') || safeFloat(data, 'amount') || 0;
    const leftQty = safeFloat(data, 'leftQuantity') || 0;
    const filled = amount > 0 ? amount - leftQty : 0;
    const rawStatus = safeString(data, 'status') || 'open';
    const status = this._parseOrderStatus(rawStatus);
    const ts = safeInteger(data, 'createdDate') || safeInteger(data, 'time') || Date.now();

    return {
      id: orderId ? String(orderId) : undefined,
      clientOrderId: safeString(data, 'clientId'),
      symbol,
      type,
      side,
      price,
      amount,
      filled,
      remaining: leftQty,
      cost: filled * price,
      average: filled > 0 ? price : 0,
      status,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrderStatus(status) {
    const s = String(status).toLowerCase();
    if (s === 'new' || s === 'open' || s === 'active') return 'open';
    if (s === 'partially_filled' || s === 'partial') return 'open';
    if (s === 'filled' || s === 'completed') return 'closed';
    if (s === 'canceled' || s === 'cancelled') return 'canceled';
    if (s === 'expired') return 'expired';
    if (s === 'rejected') return 'rejected';
    return s;
  }

  _parseOrderBook(data, symbol) {
    // iCrypex uses minified fields: p=price, q=quantity
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.p || entry.price), parseFloat(entry.q || entry.quantity)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.p || entry.price), parseFloat(entry.q || entry.quantity)];
    });

    const ts = Date.now();

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
      const free = safeFloat(b, 'available') || 0;
      const used = safeFloat(b, 'order') || safeFloat(b, 'blocked') || 0;
      const total = safeFloat(b, 'total') || (free + used);
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

    const data = await this._request('GET', '/v1/exchange/info', {}, false, 5);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    // Response: { assets: [...], pairs: [{symbol, baseAsset, quoteAsset, ...}] }
    const pairs = data.pairs || [];

    for (const s of pairs) {
      const id = safeString(s, 'symbol');
      const base = safeString(s, 'baseAsset');
      const quote = safeString(s, 'quoteAsset');
      if (!id || !base || !quote) continue;

      const symbol = base.toUpperCase() + '/' + quote.toUpperCase();

      const market = {
        id,
        symbol,
        base: base.toUpperCase(),
        quote: quote.toUpperCase(),
        active: true,
        precision: {
          price: safeInteger(s, 'pricePrecision'),
          amount: safeInteger(s, 'quantityPrecision'),
        },
        limits: {
          price: { min: safeFloat(s, 'minPrice'), max: safeFloat(s, 'maxPrice') },
          amount: { min: safeFloat(s, 'minQuantity'), max: safeFloat(s, 'maxQuantity') },
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
    const icrypexSymbol = this._toIcrypexSymbol(symbol);
    const data = await this._request('GET', '/v1/tickers', {}, false, 1);

    // Response: array of ticker objects
    const tickers = Array.isArray(data) ? data : [];
    const tickerData = tickers.find(t => t.symbol === icrypexSymbol);

    if (!tickerData) {
      throw new BadSymbol(this.id + ' fetchTicker() symbol not found: ' + symbol);
    }

    const parsed = this._parseTicker(tickerData);
    parsed.symbol = symbol;
    return parsed;
  }

  async fetchTickers(symbols = undefined) {
    const data = await this._request('GET', '/v1/tickers', {}, false, 1);

    const tickers = {};
    const tickerList = Array.isArray(data) ? data : [];

    for (const td of tickerList) {
      const sym = safeString(td, 'symbol');
      if (!sym) continue;
      const unified = this._fromIcrypexSymbol(sym);
      if (!symbols || symbols.includes(unified)) {
        const parsed = this._parseTicker(td);
        parsed.symbol = unified;
        tickers[unified] = parsed;
      }
    }

    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const icrypexSymbol = this._toIcrypexSymbol(symbol);
    const params = { symbol: icrypexSymbol };

    const data = await this._request('GET', '/v1/orderbook', params, false, 1);

    return this._parseOrderBook(data, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined) {
    this.checkRequiredCredentials();

    const icrypexSymbol = this._toIcrypexSymbol(symbol);

    const request = {
      symbol: icrypexSymbol,
      type: type.toUpperCase(),
      side: side.toUpperCase(),
      quantity: String(amount),
    };

    if (type.toLowerCase() === 'limit') {
      if (price === undefined || price === null) {
        throw new InvalidOrder(this.id + ' createOrder() requires a price for limit orders');
      }
      request.price = String(price);
    }

    const data = await this._request('POST', '/sapi/v1/orders', request, true, 1);

    return {
      id: safeString(data, 'id') || safeString(data, 'orderId'),
      symbol,
      type,
      side,
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

  async cancelOrder(id, symbol = undefined) {
    this.checkRequiredCredentials();

    // DELETE /sapi/v1/orders?orderId={id}
    const request = { orderId: String(id) };
    const data = await this._request('DELETE', '/sapi/v1/orders', request, true, 1);

    return {
      id: String(id),
      symbol,
      status: 'canceled',
      info: data,
    };
  }

  async fetchBalance() {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/sapi/v1/wallet', {}, true, 1);

    // Response: array of { asset, available, blocked, order, total }
    const balanceData = Array.isArray(data) ? data : [];
    return this._parseBalance(balanceData);
  }

  async fetchOpenOrders(symbol = undefined) {
    this.checkRequiredCredentials();

    const params = {};
    if (symbol) {
      params.symbol = this._toIcrypexSymbol(symbol);
    }

    const data = await this._request('GET', '/sapi/v1/orders', params, true, 1);

    // Response: { data: [{...}], ...} or array
    const result = data.data || data;
    const orderList = Array.isArray(result) ? result : [];
    const orders = [];
    for (const o of orderList) {
      orders.push(this._parseOrder(o, symbol));
    }

    return orders;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — Pipe-delimited protocol: "type|{json}"
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 30000 });
    const exchange = this;

    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      this.url = connectUrl || wsUrl;
      await originalConnect(this.url);

      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();

          // iCrypex uses pipe-delimited protocol: "type|{json}"
          const pipeIdx = text.indexOf('|');
          if (pipeIdx === -1) return;

          const msgType = text.substring(0, pipeIdx);
          const jsonStr = text.substring(pipeIdx + 1);

          try {
            const payload = JSON.parse(jsonStr);
            this.emit('message', { type: msgType, data: payload });
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

  async _subscribeIcrypex(channel, callback) {
    const client = await this._ensureWsConnected();

    // Subscribe: "subscribe|{"c":"orderbook@btcusdt","s":true}"
    const subMsg = 'subscribe|' + JSON.stringify({ c: channel, s: true });
    if (client._ws && client._ws.readyState === 1) {
      client._ws.send(subMsg);
    }

    const handler = (msg) => {
      if (msg && msg.type && msg.data) {
        // Check if this message is for our channel
        const msgChannel = msg.type;
        if (msgChannel === channel || msgChannel === 'orderbook' || (msg.data && msg.data.c === channel)) {
          callback(msg.data);
        }
      }
    };
    client.on('message', handler);
    this._wsHandlers.set(channel, { handler, callback });
    return channel;
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    const icrypexSymbol = this._toIcrypexSymbol(symbol).toLowerCase();
    const channel = 'orderbook@' + icrypexSymbol;

    return this._subscribeIcrypex(channel, (data) => {
      callback(this._parseWsOrderBook(data, symbol));
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    // Parse orderbook from WS — may contain changeSets or full snapshot
    const asks = (data.asks || data.a || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.p || entry.price), parseFloat(entry.q || entry.quantity)];
    });
    const bids = (data.bids || data.b || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.p || entry.price), parseFloat(entry.q || entry.quantity)];
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

module.exports = Icrypex;

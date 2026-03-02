'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA384Hex } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, iso8601,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
  NetworkError, RequestTimeout,
} = require('./utils/errors');

class Btse extends BaseExchange {
  describe() {
    return {
      id: 'btse',
      name: 'BTSE',
      version: 'v1',
      rateLimit: 100,
      rateLimitCapacity: 10,
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
        createMarketOrder: true,
        cancelOrder: true,
        cancelAllOrders: false,
        fetchOrder: false,
        fetchOpenOrders: true,
        fetchClosedOrders: false,
        fetchMyTrades: false,
        fetchBalance: true,
        fetchTradingFees: false,
        // Edit
        amendOrder: false,
        // WebSocket
        watchTicker: false,
        watchOrderBook: true,
        watchTrades: false,
        watchKlines: false,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://api.btse.com/spot',
        ws: 'wss://ws.btse.com/ws/spot',
        doc: 'https://docs.btse.com/',
      },
      timeframes: {},
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
    this.postAsJson = true;
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ---------------------------------------------------------------------------
  // Authentication — HMAC-SHA384 (path + nonce + body)
  // ---------------------------------------------------------------------------

  _sign(path, method, params) {
    this.checkRequiredCredentials();
    const nonce = String(Date.now());
    const bodyStr = (method === 'POST' || method === 'PUT') && Object.keys(params).length > 0
      ? JSON.stringify(params)
      : '';
    const signingString = path + nonce + bodyStr;
    const signature = hmacSHA384Hex(signingString, this.secret);
    return {
      params,
      headers: {
        'request-api': this.apiKey,
        'request-nonce': nonce,
        'request-sign': signature,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Request Override — DELETE with JSON body (for cancelOrder)
  // ---------------------------------------------------------------------------

  /**
   * BaseExchange._request() treats DELETE like GET (params → query string).
   * BTSE cancelOrder uses DELETE with a JSON body — we handle it entirely here.
   */
  async _request(method, path, params = {}, signed = false, weight = 1) {
    if (method === 'DELETE' && signed) {
      // Rate limiting
      if (this.enableRateLimit && this._throttler) {
        await this._throttler.consume(weight);
      }

      const signResult = this._sign(path, 'DELETE', { ...params });
      const url = this.urls.api + path;
      const headers = { ...signResult.headers, 'Content-Type': 'application/json' };

      const fetchOptions = {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(this.timeout),
      };

      if (Object.keys(params).length > 0) {
        fetchOptions.body = JSON.stringify(params);
      }

      if (this.verbose) console.log('DELETE', url);

      let response;
      try {
        response = await fetch(url, fetchOptions);
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw new RequestTimeout(this.id + ' request timed out (' + this.timeout + 'ms)');
        }
        throw new NetworkError(this.id + ' ' + err.message);
      }

      this._handleResponseHeaders(response.headers);

      if (response.status === 429 || response.status === 418) {
        const retryAfter = response.headers.get('Retry-After') || '60';
        throw new RateLimitExceeded(
          this.id + ' rate limited. Retry after ' + retryAfter + 's'
        );
      }

      const text = await response.text();
      if (!response.ok) {
        this._handleHttpError(response.status, text);
      }

      try { return JSON.parse(text); } catch { return text; }
    }

    // Non-DELETE: use standard BaseExchange flow
    return super._request(method, path, params, signed, weight);
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTC-USDT <-> BTC/USDT (hyphen-separated)
  // ---------------------------------------------------------------------------

  _toBtseSymbol(symbol) {
    // 'BTC/USDT' -> 'BTC-USDT'
    return symbol.replace('/', '-');
  }

  _fromBtseSymbol(btseSymbol) {
    // 'BTC-USDT' -> 'BTC/USDT'
    return btseSymbol.replace('-', '/');
  }

  // ---------------------------------------------------------------------------
  // Response Handling — BTSE returns arrays for most endpoints
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Check for error object: { status: <number>, message: "<error>" }
      if (data.status !== undefined && data.message) {
        const status = safeInteger(data, 'status');
        const msg = safeString(data, 'message') || 'Unknown error';
        if (status && status !== 0) {
          this._handleBtseError(status, msg);
        }
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling — Exchange error codes + HTTP status codes
  // ---------------------------------------------------------------------------

  _handleBtseError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    // Map by message keywords
    if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('order_not_found')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid symbol') || lowerMsg.includes('market not found') || lowerMsg.includes('symbol not found')) {
      throw new BadSymbol(full);
    }
    if (lowerMsg.includes('invalid order') || lowerMsg.includes('invalid price') || lowerMsg.includes('invalid size')) {
      throw new InvalidOrder(full);
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many')) {
      throw new RateLimitExceeded(full);
    }
    if (lowerMsg.includes('auth') || lowerMsg.includes('permission') || lowerMsg.includes('sign') || lowerMsg.includes('credential') || lowerMsg.includes('api key')) {
      throw new AuthenticationError(full);
    }
    if (lowerMsg.includes('unavailable') || lowerMsg.includes('maintenance')) {
      throw new ExchangeNotAvailable(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.status !== undefined && parsed.message) {
        const code = safeInteger(parsed, 'status') || statusCode;
        const msg = safeString(parsed, 'message') || body;
        this._handleBtseError(code, msg);
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

  _parseTicker(data, symbol) {
    return {
      symbol,
      last: safeFloat(data, 'lastPrice'),
      high: undefined,
      low: undefined,
      open: undefined,
      close: safeFloat(data, 'lastPrice'),
      bid: undefined,
      bidVolume: undefined,
      ask: undefined,
      askVolume: undefined,
      volume: undefined,
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      timestamp: undefined,
      datetime: undefined,
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'orderID') || safeString(data, 'clOrderID');
    const btseSymbol = safeString(data, 'symbol');
    const symbol = btseSymbol ? this._fromBtseSymbol(btseSymbol) : fallbackSymbol;
    const side = safeString(data, 'side') || 'BUY';
    const orderType = safeInteger(data, 'orderType');
    const type = orderType === 76 ? 'limit' : 'market';
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'size') || 0;
    const filledAmount = safeFloat(data, 'fillSize') || 0;
    const status = safeInteger(data, 'status');
    const ts = safeInteger(data, 'timestamp');

    return {
      id: orderId,
      clientOrderId: safeString(data, 'clOrderID'),
      symbol,
      type,
      side: side.toLowerCase(),
      price,
      amount,
      filled: filledAmount,
      remaining: amount > 0 ? amount - filledAmount : 0,
      cost: filledAmount * price,
      average: filledAmount > 0 ? (filledAmount * price) / filledAmount : 0,
      status: status !== undefined ? String(status) : 'open',
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrderBook(data, symbol) {
    const asks = (data.sellQuote || []).map(entry => {
      return [parseFloat(entry.price), parseFloat(entry.size)];
    });
    const bids = (data.buyQuote || []).map(entry => {
      return [parseFloat(entry.price), parseFloat(entry.size)];
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

  _parseBalance(data) {
    const balance = {
      info: data,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    const items = Array.isArray(data) ? data : [];

    for (const b of items) {
      const currency = safeString(b, 'currency');
      if (!currency) continue;
      const total = safeFloat(b, 'total') || 0;
      const free = safeFloat(b, 'available') || 0;
      const used = total - free;
      if (free > 0 || total > 0) {
        balance[currency] = { free, used: used >= 0 ? used : 0, total };
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data
  // ---------------------------------------------------------------------------

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v3.2/market_summary', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const pairs = Array.isArray(result) ? result : [];

    for (const s of pairs) {
      const id = safeString(s, 'symbol');
      if (!id) continue;

      const base = safeString(s, 'base');
      const quote = safeString(s, 'quote');
      if (!base || !quote) continue;

      const symbol = base + '/' + quote;
      const active = safeValue(s, 'status') === 'active';
      const tradeEnabled = safeValue(s, 'tradeEnabled') !== false;

      const market = {
        id,
        symbol,
        base,
        quote,
        active: active && tradeEnabled,
        precision: {
          price: undefined,
          amount: undefined,
        },
        limits: {
          price: { min: safeFloat(s, 'minPriceIncrement'), max: undefined },
          amount: { min: safeFloat(s, 'minOrderSize'), max: safeFloat(s, 'maxOrderSize') },
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
    const btseSymbol = this._toBtseSymbol(symbol);
    const data = await this._request('GET', '/api/v3.2/price', {}, false, 1);
    const result = this._unwrapResponse(data);

    const tickers = Array.isArray(result) ? result : [];
    const tickerData = tickers.find(t => t.symbol === btseSymbol);

    if (!tickerData) {
      throw new BadSymbol(this.id + ' fetchTicker symbol not found: ' + symbol);
    }

    return this._parseTicker(tickerData, symbol);
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const btseSymbol = this._toBtseSymbol(symbol);
    const data = await this._request('GET', '/api/v3.2/orderbook/L2', { symbol: btseSymbol }, false, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderBook(result, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const upperType = type.toUpperCase();
    const upperSide = side.toUpperCase();
    const btseSymbol = this._toBtseSymbol(symbol);

    if (upperType === 'LIMIT' && (price === undefined || price === null)) {
      throw new InvalidOrder(this.id + ' createOrder LIMIT requires price');
    }

    // BTSE order type: "76" for limit, "77" for market
    const orderType = upperType === 'LIMIT' ? '76' : '77';

    const request = {
      symbol: btseSymbol,
      side: upperSide,
      type: orderType,
      size: parseFloat(amount),
      ...params,
    };

    if (upperType === 'LIMIT') {
      request.price = parseFloat(price);
    }

    const data = await this._request('POST', '/api/v3.2/order', request, true, 1);
    const result = this._unwrapResponse(data);

    // Response is an array — parse the first element
    const orderData = Array.isArray(result) && result.length > 0 ? result[0] : result;

    return {
      id: safeString(orderData, 'orderID') || safeString(orderData, 'clOrderID'),
      clientOrderId: safeString(orderData, 'clOrderID'),
      symbol,
      type: upperType,
      side: upperSide,
      price: price !== undefined ? parseFloat(price) : undefined,
      amount: parseFloat(amount),
      filled: safeFloat(orderData, 'fillSize') || 0,
      remaining: parseFloat(amount) - (safeFloat(orderData, 'fillSize') || 0),
      status: 'open',
      timestamp: safeInteger(orderData, 'timestamp') || Date.now(),
      datetime: iso8601(safeInteger(orderData, 'timestamp') || Date.now()),
      info: orderData,
    };
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = {
      orderID: id,
      clOrderID: '',
      ...params,
    };

    if (symbol) {
      request.symbol = this._toBtseSymbol(symbol);
    }

    const data = await this._request('DELETE', '/api/v3.2/order', request, true, 1);
    this._unwrapResponse(data);

    return {
      id,
      symbol,
      status: 'canceled',
      info: data,
    };
  }

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/api/v3.2/user/wallet', { ...params }, true, 1);
    const result = this._unwrapResponse(data);

    return this._parseBalance(result);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { ...params };
    if (symbol) {
      request.symbol = this._toBtseSymbol(symbol);
    }

    const data = await this._request('GET', '/api/v3.2/user/open_orders', request, true, 1);
    const result = this._unwrapResponse(data);

    const orders = Array.isArray(result) ? result : [];
    return orders.map(o => this._parseOrder(o, symbol));
  }

  // ---------------------------------------------------------------------------
  // WebSocket — plain JSON with text ping/pong
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 0 });

    // BTSE: server sends text 'ping', client responds with text 'pong'
    // No client-initiated ping needed
    client._startPing = function () {
      this._stopPing();
    };

    // Override message handler to handle text ping/pong
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);
      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();

          // BTSE ping/pong: server sends 'ping', client responds 'pong'
          if (text === 'ping') {
            this._ws.send('pong');
            return;
          }

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

  async _wsAuthenticate(client) {
    const nonce = String(Date.now());
    const signingString = '/ws/spot' + nonce;
    const signature = hmacSHA384Hex(signingString, this.secret);

    const authMsg = {
      op: 'authKeyExpires',
      args: [this.apiKey, nonce, signature],
    };
    client.send(authMsg);
  }

  async _subscribeBtse(topic, callback) {
    const client = await this._ensureWsConnected();

    const subMsg = {
      op: 'subscribe',
      args: [topic],
    };
    client.send(subMsg);

    const handler = (data) => {
      if (data && data.topic === topic) {
        callback(data);
      }
    };
    client.on('message', handler);
    this._wsHandlers.set(topic, { handler, callback });
    return topic;
  }

  // ---------------------------------------------------------------------------
  // WS Watch Methods
  // ---------------------------------------------------------------------------

  async watchOrderBook(symbol, callback, limit = undefined) {
    const btseSymbol = this._toBtseSymbol(symbol);
    const topic = 'update:' + btseSymbol + '_0';

    return this._subscribeBtse(topic, (msg) => {
      if (msg.data) {
        callback(this._parseWsOrderBook(msg.data, symbol));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const asks = (data.sellQuote || []).map(entry =>
      [parseFloat(entry.price), parseFloat(entry.size)]
    );
    const bids = (data.buyQuote || []).map(entry =>
      [parseFloat(entry.price), parseFloat(entry.size)]
    );

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

module.exports = Btse;

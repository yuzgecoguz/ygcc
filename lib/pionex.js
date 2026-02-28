'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
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

class Pionex extends BaseExchange {
  describe() {
    return {
      id: 'pionex',
      name: 'Pionex',
      version: 'v1',
      rateLimit: 100,
      rateLimitCapacity: 10,
      rateLimitInterval: 1000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: false,
        fetchTickers: false,
        fetchOrderBook: false,
        fetchTrades: false,
        fetchOHLCV: false,
        fetchTime: false,
        // Private
        createOrder: true,
        createLimitOrder: true,
        createMarketOrder: true,
        cancelOrder: true,
        cancelAllOrders: true,
        fetchOrder: true,
        fetchOpenOrders: true,
        fetchClosedOrders: true,
        fetchMyTrades: true,
        fetchBalance: true,
        fetchTradingFees: false,
        // WebSocket
        watchTicker: false,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: false,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://api.pionex.com',
        ws: 'wss://ws.pionex.com/wsPub',
        doc: 'https://pionex-doc.gitbook.io/apidocs/',
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
  // Authentication — HMAC-SHA256 with header-based signing
  // ---------------------------------------------------------------------------

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const baseUrl = this._getBaseUrl();
    const timestamp = Date.now();
    let signingString;
    let url;

    if (method === 'GET') {
      // GET: all params (including timestamp) sorted alphabetically, raw QS
      params.timestamp = timestamp;
      const sortedKeys = Object.keys(params).sort();
      const rawQS = sortedKeys.map(k => k + '=' + params[k]).join('&');
      signingString = 'GET' + path + '?' + rawQS;
      url = baseUrl + path + '?' + rawQS;
      // Empty params — URL already contains everything
      return {
        params: {},
        headers: {
          'PIONEX-KEY': this.apiKey,
          'PIONEX-SIGNATURE': hmacSHA256(signingString, this.secret),
        },
        url,
      };
    }

    // POST and DELETE: timestamp only in query string, JSON body appended
    const bodyStr = Object.keys(params).length > 0 ? JSON.stringify(params) : '';
    signingString = method + path + '?timestamp=' + timestamp + bodyStr;
    url = baseUrl + path + '?timestamp=' + timestamp;

    if (method === 'DELETE') {
      // Empty params — _request override handles the JSON body
      return {
        params: {},
        headers: {
          'PIONEX-KEY': this.apiKey,
          'PIONEX-SIGNATURE': hmacSHA256(signingString, this.secret),
        },
        url,
      };
    }

    // POST: params stay for JSON body (postAsJson = true in BaseExchange)
    return {
      params,
      headers: {
        'PIONEX-KEY': this.apiKey,
        'PIONEX-SIGNATURE': hmacSHA256(signingString, this.secret),
      },
      url,
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Request Override — DELETE with JSON body
  // ---------------------------------------------------------------------------

  /**
   * BaseExchange._request() line 224 treats DELETE like GET (params → query string).
   * Pionex DELETE needs a JSON body — we handle it entirely here.
   */
  async _request(method, path, params = {}, signed = false, weight = 1) {
    if (method === 'DELETE' && signed) {
      // Rate limiting
      if (this.enableRateLimit && this._throttler) {
        await this._throttler.consume(weight);
      }

      // Sign with a COPY of params (don't mutate the original)
      const signResult = this._sign(path, 'DELETE', { ...params });
      const url = signResult.url;
      const headers = { ...signResult.headers, 'Content-Type': 'application/json' };

      const fetchOptions = {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(this.timeout),
      };

      // Use ORIGINAL params for the JSON body
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
      if (!response.ok) this._handleHttpError(response.status, text);

      try { return JSON.parse(text); } catch { return text; }
    }

    // All other methods delegate to BaseExchange
    return super._request(method, path, params, signed, weight);
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTC_USDT <-> BTC/USDT
  // ---------------------------------------------------------------------------

  _toPionexSymbol(symbol) {
    // 'BTC/USDT' → 'BTC_USDT'
    const parts = symbol.split('/');
    return parts[0] + '_' + parts[1];
  }

  _fromPionexSymbol(pionexSymbol) {
    // 'BTC_USDT' → 'BTC/USDT' (via marketsById lookup)
    if (this.marketsById && this.marketsById[pionexSymbol]) {
      return this.marketsById[pionexSymbol].symbol;
    }
    // Fallback: parse directly
    const parts = pionexSymbol.split('_');
    if (parts.length === 2) {
      return parts[0].toUpperCase() + '/' + parts[1].toUpperCase();
    }
    return pionexSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling — { result: true/false, data: {...}, code: "...", message: "..." }
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object') {
      if (data.result === false) {
        const code = safeString(data, 'code') || 'unknown';
        const msg = safeString(data, 'message') || 'Unknown error';
        this._handlePionexError(code, msg);
      }
    }
    // Extract the actual payload from the wrapper
    return (data && data.data !== undefined) ? data.data : data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling — string error codes
  // ---------------------------------------------------------------------------

  _handlePionexError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const errorMap = {
      'TRADE_INVALID_SYMBOL': BadSymbol,
      'TRADE_PARAMETER_ERROR': BadRequest,
      'PARAMETER_ERROR': BadRequest,
      'INVALID_SIGNATURE': AuthenticationError,
      'INVALID_API_KEY': AuthenticationError,
      'INVALID_TIMESTAMP': AuthenticationError,
      'INSUFFICIENT_BALANCE': InsufficientFunds,
      'TRADE_INSUFFICIENT_BALANCE': InsufficientFunds,
      'ORDER_NOT_FOUND': OrderNotFound,
      'TRADE_ORDER_NOT_FOUND': OrderNotFound,
      'RATE_LIMIT': RateLimitExceeded,
    };
    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && parsed.result === false) {
      const code = safeString(parsed, 'code') || 'unknown';
      const msg = safeString(parsed, 'message') || body;
      this._handlePionexError(code, msg);
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

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'orderId');
    const clientOrderId = safeString(data, 'clientOrderId');
    const pionexSymbol = safeString(data, 'symbol');
    const symbol = pionexSymbol ? this._fromPionexSymbol(pionexSymbol) : fallbackSymbol;
    const type = safeStringUpper(data, 'type') || 'LIMIT';
    const side = safeStringUpper(data, 'side') || 'BUY';
    const price = safeFloat(data, 'price') || 0;
    const size = safeFloat(data, 'size') || 0;
    const filledSize = safeFloat(data, 'filledSize') || 0;
    const filledAmount = safeFloat(data, 'filledAmount') || 0;
    const fee = safeFloat(data, 'fee') || 0;
    const feeCoin = safeString(data, 'feeCoin');
    const status = this._normalizeOrderStatus(safeString(data, 'status'));
    const ioc = safeValue(data, 'IOC');
    const ts = safeInteger(data, 'createTime') || safeInteger(data, 'updateTime');

    return {
      id: orderId,
      clientOrderId,
      symbol,
      type,
      side,
      price,
      amount: size,
      filled: filledSize,
      remaining: size - filledSize,
      cost: filledAmount,
      average: filledSize > 0 ? filledAmount / filledSize : 0,
      status,
      fee: fee > 0 ? { cost: fee, currency: feeCoin } : undefined,
      IOC: ioc,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _normalizeOrderStatus(status) {
    const map = {
      'OPEN': 'open',
      'CLOSED': 'closed',
      'CANCELED': 'canceled',
    };
    return map[status] !== undefined ? map[status] : (status ? status.toLowerCase() : 'open');
  }

  _parseMyTrade(data, fallbackSymbol) {
    const id = safeString(data, 'id');
    const orderId = safeString(data, 'orderId');
    const pionexSymbol = safeString(data, 'symbol');
    const symbol = pionexSymbol ? this._fromPionexSymbol(pionexSymbol) : fallbackSymbol;
    const side = safeStringUpper(data, 'side');
    const role = safeString(data, 'role');
    const price = safeFloat(data, 'price') || 0;
    const size = safeFloat(data, 'size') || 0;
    const fee = safeFloat(data, 'fee') || 0;
    const feeCoin = safeString(data, 'feeCoin');
    const ts = safeInteger(data, 'timestamp');

    return {
      id,
      orderId,
      symbol,
      side,
      price,
      amount: size,
      cost: price * size,
      fee: fee > 0 ? { cost: fee, currency: feeCoin } : undefined,
      role: role ? role.toLowerCase() : undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data (very limited!)
  // ---------------------------------------------------------------------------

  /**
   * Pionex has NO fetchTicker, fetchOrderBook, fetchTrades, fetchOHLCV, fetchTime.
   * Only loadMarkets is available for public REST.
   */

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v1/common/symbols', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const symbols = (result && result.symbols) ? result.symbols : (Array.isArray(result) ? result : []);

    for (const s of symbols) {
      // Filter: only SPOT and enabled
      if (s.enable !== true) continue;
      if (s.type && s.type !== 'SPOT') continue;

      const id = s.symbol;   // 'BTC_USDT'
      const base = safeString(s, 'baseCurrency') || id.split('_')[0];
      const quote = safeString(s, 'quoteCurrency') || id.split('_')[1];
      const symbol = base + '/' + quote;

      const market = {
        id,
        symbol,
        base,
        quote,
        active: true,
        type: 'spot',
        precision: {
          price: safeInteger(s, 'quotePrecision'),
          amount: safeInteger(s, 'basePrecision'),
        },
        limits: {
          price: { min: safeFloat(s, 'minPrice'), max: safeFloat(s, 'maxPrice') },
          amount: { min: safeFloat(s, 'minAmount'), max: safeFloat(s, 'maxAmount') },
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

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const upperType = type.toUpperCase();
    const upperSide = side.toUpperCase();
    const pionexSymbol = this._toPionexSymbol(symbol);

    const request = {
      symbol: pionexSymbol,
      side: upperSide,
      type: upperType,
      ...params,
    };

    if (upperType === 'LIMIT') {
      if (price === undefined || price === null) {
        throw new InvalidOrder(this.id + ' createOrder LIMIT requires price');
      }
      request.size = String(amount);
      request.price = String(price);
    } else if (upperType === 'MARKET') {
      // Pionex market order quirk: BUY uses amount (quote), SELL uses size (base)
      if (upperSide === 'BUY') {
        request.amount = String(amount);
      } else {
        request.size = String(amount);
      }
    }

    const data = await this._request('POST', '/api/v1/trade/order', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'orderId'),
      clientOrderId: safeString(result, 'clientOrderId'),
      symbol,
      type: upperType,
      side: upperSide,
      price: price !== undefined ? parseFloat(price) : undefined,
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
      orderId: id,
      symbol: this._toPionexSymbol(symbol),
      ...params,
    };

    const data = await this._request('DELETE', '/api/v1/trade/order', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id,
      symbol,
      status: 'canceled',
      info: result,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelAllOrders requires symbol');

    const request = {
      symbol: this._toPionexSymbol(symbol),
      ...params,
    };

    const data = await this._request('DELETE', '/api/v1/trade/allOrders', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      symbol,
      status: 'canceled',
      info: result,
    };
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder requires symbol');

    const request = {
      orderId: id,
      symbol: this._toPionexSymbol(symbol),
      ...params,
    };

    const data = await this._request('GET', '/api/v1/trade/order', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrder(result, symbol);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchOpenOrders requires symbol');

    const request = {
      symbol: this._toPionexSymbol(symbol),
      ...params,
    };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v1/trade/openOrders', request, true, 5);
    const result = this._unwrapResponse(data);

    const orders = (result && result.orders) ? result.orders : (Array.isArray(result) ? result : []);
    return orders.map(o => this._parseOrder(o, symbol));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchClosedOrders requires symbol');

    const request = {
      symbol: this._toPionexSymbol(symbol),
      ...params,
    };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v1/trade/allOrders', request, true, 5);
    const result = this._unwrapResponse(data);

    const orders = (result && result.orders) ? result.orders : (Array.isArray(result) ? result : []);
    return orders.map(o => this._parseOrder(o, symbol));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchMyTrades requires symbol');

    const request = {
      symbol: this._toPionexSymbol(symbol),
      ...params,
    };
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v1/trade/fills', request, true, 1);
    const result = this._unwrapResponse(data);

    const fills = (result && result.fills) ? result.fills : (Array.isArray(result) ? result : []);
    return fills.map(t => this._parseMyTrade(t, symbol));
  }

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/api/v1/account/balances', { ...params }, true, 1);
    const result = this._unwrapResponse(data);

    const balance = { info: result, timestamp: Date.now(), datetime: iso8601(Date.now()) };
    const balances = (result && result.balances) ? result.balances : (Array.isArray(result) ? result : []);

    for (const b of balances) {
      const currency = safeString(b, 'coin');
      if (!currency) continue;
      const free = safeFloat(b, 'free') || 0;
      const used = safeFloat(b, 'frozen') || 0;
      if (free > 0 || used > 0) {
        balance[currency] = { free, used, total: free + used };
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — server PING / client PONG, JSON messages
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 15000 });

    // Pionex: server sends PING → client responds with PONG
    // Disable default WebSocket protocol-level pings
    client._startPing = function () {
      this._stopPing();
    };

    // Override message handler for PING/PONG and SUBSCRIBED filtering
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);
      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();
          try {
            const data = JSON.parse(text);
            // Server PING → respond with PONG
            if (data.type === 'PING' || data.op === 'PING') {
              this.send({ op: 'PONG', timestamp: Date.now() });
              return;
            }
            // Filter out SUBSCRIBED confirmations
            if (data.type === 'SUBSCRIBED') return;
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

  async _subscribePionex(topic, symbol, callback, extra = {}) {
    const client = await this._ensureWsConnected();

    const subMsg = {
      op: 'SUBSCRIBE',
      topic,
      symbol,
      ...extra,
    };
    client.send(subMsg);

    const channelId = topic + ':' + symbol;
    const handler = (data) => {
      if (data && data.topic === topic && data.symbol === symbol) {
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

  async watchOrderBook(symbol, callback, limit = 100) {
    const pionexSymbol = this._toPionexSymbol(symbol);
    return this._subscribePionex('DEPTH', pionexSymbol, (msg) => {
      if (msg.data) {
        callback(this._parseWsOrderBook(msg.data, symbol));
      }
    }, { limit });
  }

  async watchTrades(symbol, callback) {
    const pionexSymbol = this._toPionexSymbol(symbol);
    return this._subscribePionex('TRADE', pionexSymbol, (msg) => {
      if (msg.data) {
        const trades = Array.isArray(msg.data) ? msg.data : [msg.data];
        callback(trades.map(t => this._parseWsTrade(t, symbol)));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const bids = (data.bids || []).map(entry =>
      Array.isArray(entry) ? [parseFloat(entry[0]), parseFloat(entry[1])] : [entry.price, entry.amount]
    );
    const asks = (data.asks || []).map(entry =>
      Array.isArray(entry) ? [parseFloat(entry[0]), parseFloat(entry[1])] : [entry.price, entry.amount]
    );

    return {
      symbol,
      bids,
      asks,
      timestamp: safeInteger(data, 'timestamp') || Date.now(),
      datetime: iso8601(safeInteger(data, 'timestamp') || Date.now()),
      nonce: undefined,
      info: data,
    };
  }

  _parseWsTrade(data, symbol) {
    return {
      id: safeString(data, 'id'),
      symbol,
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'size') || safeFloat(data, 'amount'),
      side: safeString(data, 'side') ? safeString(data, 'side').toLowerCase() : undefined,
      timestamp: safeInteger(data, 'timestamp'),
      datetime: iso8601(safeInteger(data, 'timestamp')),
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

module.exports = Pionex;

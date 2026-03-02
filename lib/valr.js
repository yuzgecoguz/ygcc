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
  NetworkError, RequestTimeout,
} = require('./utils/errors');

class Valr extends BaseExchange {
  describe() {
    return {
      id: 'valr',
      name: 'VALR',
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
        fetchOpenOrders: false,
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
        api: 'https://api.valr.com',
        ws: 'wss://api.valr.com/ws/trade',
        doc: 'https://docs.valr.com/',
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
  // Authentication — HMAC-SHA512 (timestamp + method + path + body)
  // ---------------------------------------------------------------------------

  _sign(path, method, params) {
    this.checkRequiredCredentials();
    const timestamp = String(Date.now());
    let body = '';
    if ((method === 'POST' || method === 'DELETE') && Object.keys(params).length > 0) {
      body = JSON.stringify(params);
    }
    const signingString = timestamp + method + path + body;
    const signature = hmacSHA512Hex(signingString, this.secret);
    return {
      params,
      headers: {
        'X-VALR-API-KEY': this.apiKey,
        'X-VALR-SIGNATURE': signature,
        'X-VALR-TIMESTAMP': timestamp,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Request Override — DELETE with JSON body + HTTP 202 acceptance
  // ---------------------------------------------------------------------------

  /**
   * BaseExchange._request() treats DELETE like GET (params to query string).
   * VALR DELETE needs a JSON body — we handle it entirely here.
   * VALR also returns HTTP 202 for accepted order operations (create/cancel).
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
      // VALR returns 202 for accepted orders and 200 for success — both are OK
      if (!response.ok && response.status !== 202) {
        this._handleHttpError(response.status, text);
      }

      try { return JSON.parse(text); } catch { return text; }
    }

    // Non-DELETE: use standard BaseExchange flow, but handle 202 as success
    return super._request(method, path, params, signed, weight);
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTCZAR <-> BTC/ZAR (concatenated, no separator)
  // ---------------------------------------------------------------------------

  _toValrSymbol(symbol) {
    // 'BTC/ZAR' -> 'BTCZAR'
    return symbol.replace('/', '');
  }

  _fromValrSymbol(valrSymbol) {
    // 'BTCZAR' -> 'BTC/ZAR' (via marketsById lookup — required since no separator)
    if (this.marketsById && this.marketsById[valrSymbol]) {
      return this.marketsById[valrSymbol].symbol;
    }
    // Fallback: return raw symbol (cannot reliably split without separator)
    return valrSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling — VALR returns plain JSON objects/arrays (no wrapper)
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Check for error fields in the response body
      if (data.code || data.message) {
        const code = safeString(data, 'code') || 'unknown';
        const msg = safeString(data, 'message') || 'Unknown error';
        this._handleValrError(code, msg);
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling — HTTP status codes + error body codes
  // ---------------------------------------------------------------------------

  _handleValrError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const errorMap = {
      'INVALID_PARAMETER': BadRequest,
      'BAD_REQUEST': BadRequest,
      'INVALID_API_KEY': AuthenticationError,
      'UNAUTHORIZED': AuthenticationError,
      'FORBIDDEN': AuthenticationError,
      'INSUFFICIENT_BALANCE': InsufficientFunds,
      'INSUFFICIENT_FUNDS': InsufficientFunds,
      'ORDER_NOT_FOUND': OrderNotFound,
      'INVALID_ORDER': InvalidOrder,
      'INVALID_PAIR': BadSymbol,
      'RATE_LIMIT_EXCEEDED': RateLimitExceeded,
      'SERVICE_UNAVAILABLE': ExchangeNotAvailable,
    };
    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.code || parsed.message) {
        const code = safeString(parsed, 'code') || 'unknown';
        const msg = safeString(parsed, 'message') || body;
        this._handleValrError(code, msg);
      }
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

  _parseTicker(data, symbol) {
    return {
      symbol,
      last: safeFloat(data, 'lastTradedPrice'),
      high: safeFloat(data, 'highPrice'),
      low: safeFloat(data, 'lowPrice'),
      open: safeFloat(data, 'previousClosePrice'),
      close: safeFloat(data, 'lastTradedPrice'),
      bid: safeFloat(data, 'bidPrice'),
      bidVolume: undefined,
      ask: safeFloat(data, 'askPrice'),
      askVolume: undefined,
      volume: safeFloat(data, 'baseVolume'),
      quoteVolume: safeFloat(data, 'quoteVolume'),
      change: safeFloat(data, 'changeFromPrevious'),
      percentage: undefined,
      timestamp: safeInteger(data, 'created') || Date.now(),
      datetime: iso8601(safeInteger(data, 'created') || Date.now()),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'id') || safeString(data, 'orderId');
    const valrSymbol = safeString(data, 'currencyPairSymbol') || safeString(data, 'pair');
    const symbol = valrSymbol ? this._fromValrSymbol(valrSymbol) : fallbackSymbol;
    const side = safeStringUpper(data, 'side') || 'BUY';
    const type = safeStringUpper(data, 'type') || 'LIMIT';
    const price = safeFloat(data, 'price') || safeFloat(data, 'originalPrice') || 0;
    const amount = safeFloat(data, 'quantity') || safeFloat(data, 'originalQuantity') || 0;
    const filledAmount = safeFloat(data, 'filledQuantity') || safeFloat(data, 'total') || 0;
    const status = safeString(data, 'orderStatusType') || 'open';
    const ts = safeInteger(data, 'orderCreatedAt') || safeInteger(data, 'createdAt');

    return {
      id: orderId,
      clientOrderId: safeString(data, 'customerOrderId'),
      symbol,
      type,
      side,
      price,
      amount,
      filled: filledAmount,
      remaining: amount > 0 ? amount - filledAmount : 0,
      cost: filledAmount * price,
      average: filledAmount > 0 ? (filledAmount * price) / filledAmount : 0,
      status: status ? status.toLowerCase() : 'open',
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrderBook(data, symbol) {
    const asks = (data.Asks || data.asks || []).map(entry => {
      return [parseFloat(entry.price), parseFloat(entry.quantity)];
    });
    const bids = (data.Bids || data.bids || []).map(entry => {
      return [parseFloat(entry.price), parseFloat(entry.quantity)];
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
  // Public REST API — Market Data
  // ---------------------------------------------------------------------------

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/v1/public/pairs', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const pairs = Array.isArray(result) ? result : [];

    for (const s of pairs) {
      const id = safeString(s, 'symbol');
      if (!id) continue;

      const base = safeString(s, 'baseCurrency');
      const quote = safeString(s, 'quoteCurrency');
      if (!base || !quote) continue;

      const symbol = base + '/' + quote;
      const active = safeValue(s, 'active') !== false;

      const market = {
        id,
        symbol,
        base,
        quote,
        active,
        precision: {
          price: safeInteger(s, 'quoteDecimalPlaces'),
          amount: safeInteger(s, 'baseDecimalPlaces'),
        },
        limits: {
          price: { min: safeFloat(s, 'minQuoteAmount'), max: safeFloat(s, 'maxQuoteAmount') },
          amount: { min: safeFloat(s, 'minBaseAmount'), max: safeFloat(s, 'maxBaseAmount') },
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
    const valrSymbol = this._toValrSymbol(symbol);
    const data = await this._request('GET', '/v1/public/' + valrSymbol + '/marketsummary', {}, false, 1);
    const result = this._unwrapResponse(data);
    return this._parseTicker(result, symbol);
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const valrSymbol = this._toValrSymbol(symbol);
    const data = await this._request('GET', '/v1/marketdata/' + valrSymbol + '/orderbook', {}, false, 1);
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
    const valrSymbol = this._toValrSymbol(symbol);

    let path;
    let request;

    if (upperType === 'LIMIT') {
      if (price === undefined || price === null) {
        throw new InvalidOrder(this.id + ' createOrder LIMIT requires price');
      }
      path = '/v1/orders/limit';
      request = {
        pair: valrSymbol,
        side: upperSide,
        quantity: String(amount),
        price: String(price),
        ...params,
      };
    } else if (upperType === 'MARKET') {
      path = '/v1/orders/market';
      request = {
        pair: valrSymbol,
        side: upperSide,
        ...params,
      };
      // VALR market orders: BUY uses quoteAmount, SELL uses baseAmount
      if (upperSide === 'BUY') {
        request.quoteAmount = String(amount);
      } else {
        request.baseAmount = String(amount);
      }
    } else {
      throw new InvalidOrder(this.id + ' createOrder unsupported order type: ' + type);
    }

    const data = await this._request('POST', path, request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'id') || safeString(data, 'id'),
      clientOrderId: safeString(result, 'customerOrderId'),
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

    const request = {
      orderId: id,
      ...params,
    };

    // VALR cancel: if symbol is provided, include pair in request
    if (symbol) {
      request.pair = this._toValrSymbol(symbol);
    }

    const data = await this._request('DELETE', '/v1/orders/order', request, true, 1);
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

    const data = await this._request('GET', '/v1/account/balances', { ...params }, true, 1);
    const result = this._unwrapResponse(data);

    const balance = { info: result, timestamp: Date.now(), datetime: iso8601(Date.now()) };
    const balances = Array.isArray(result) ? result : [];

    for (const b of balances) {
      const currency = safeString(b, 'currency');
      if (!currency) continue;
      const free = safeFloat(b, 'available') || 0;
      const used = safeFloat(b, 'reserved') || 0;
      if (free > 0 || used > 0) {
        balance[currency] = { free, used, total: free + used };
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — plain JSON, no compression, server-managed keepalive
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 0 });

    // VALR: no client-initiated ping needed (server handles keepalive)
    client._startPing = function () {
      this._stopPing();
    };

    // Override message handler to filter subscription confirmations
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);
      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();
          try {
            const data = JSON.parse(text);
            // Filter out subscription confirmations and keepalive pings
            if (data.type === 'SUBSCRIBED' || data.type === 'PING') return;
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

  async _subscribeValr(event, pair, callback) {
    const client = await this._ensureWsConnected();

    const subMsg = {
      type: 'SUBSCRIBE',
      subscriptions: [
        {
          event,
          pairs: [pair],
        },
      ],
    };
    client.send(subMsg);

    const channelId = event + ':' + pair;
    const handler = (data) => {
      if (data && data.type === event && data.currencyPairSymbol === pair) {
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
    const valrSymbol = this._toValrSymbol(symbol);
    return this._subscribeValr('AGGREGATED_ORDERBOOK_UPDATE', valrSymbol, (msg) => {
      if (msg.data) {
        callback(this._parseWsOrderBook(msg.data, symbol));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const bids = (data.Bids || data.bids || []).map(entry =>
      [parseFloat(entry.price), parseFloat(entry.quantity)]
    );
    const asks = (data.Asks || data.asks || []).map(entry =>
      [parseFloat(entry.price), parseFloat(entry.quantity)]
    );

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

module.exports = Valr;

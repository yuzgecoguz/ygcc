'use strict';

const zlib = require('zlib');
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
  RequestTimeout, NetworkError,
} = require('./utils/errors');

class WhiteBit extends BaseExchange {
  describe() {
    return {
      id: 'whitebit',
      name: 'WhiteBit',
      version: 'v4',
      rateLimit: 50,
      rateLimitCapacity: 20,
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
        fetchOpenOrders: false,
        fetchClosedOrders: false,
        fetchMyTrades: false,
        fetchBalance: true,
        fetchTradingFees: false,
        // WebSocket
        watchTicker: false,
        watchOrderBook: true,
        watchTrades: false,
        watchKlines: false,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://whitebit.com',
        ws: 'wss://internal.whitebit.com/stream-ws',
        doc: 'https://docs.whitebit.com/',
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
  // Authentication — Base64 payload + HMAC-SHA512
  // ---------------------------------------------------------------------------

  /**
   * WhiteBit auth: ALL private endpoints use POST.
   * Body includes "request" (path) and "nonce" (ms timestamp).
   * 1. Build body with request + nonce injected
   * 2. JSON.stringify → Base64 encode → X-TXC-PAYLOAD
   * 3. HMAC-SHA512(payload, secret) → X-TXC-SIGNATURE
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const nonce = Date.now();
    const body = { ...params, request: path, nonce };
    const bodyStr = JSON.stringify(body);
    const payload = Buffer.from(bodyStr).toString('base64');
    const signature = hmacSHA512Hex(payload, this.secret);

    return {
      params: body,
      headers: {
        'X-TXC-APIKEY': this.apiKey,
        'X-TXC-PAYLOAD': payload,
        'X-TXC-SIGNATURE': signature,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTC_USDT <-> BTC/USDT
  // ---------------------------------------------------------------------------

  _toWhiteBitSymbol(symbol) {
    // 'BTC/USDT' → 'BTC_USDT'
    const parts = symbol.split('/');
    return parts[0] + '_' + parts[1];
  }

  _fromWhiteBitSymbol(wbSymbol) {
    // 'BTC_USDT' → 'BTC/USDT' (via marketsById lookup)
    if (this.marketsById && this.marketsById[wbSymbol]) {
      return this.marketsById[wbSymbol].symbol;
    }
    // Fallback: parse directly
    const parts = wbSymbol.split('_');
    if (parts.length === 2) {
      return parts[0].toUpperCase() + '/' + parts[1].toUpperCase();
    }
    return wbSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Error: code !== 0 or success === false
      if (data.code !== undefined && data.code !== 0) {
        const code = data.code;
        const msg = safeString(data, 'message') || safeString(data, 'errors') || 'Unknown error';
        this._handleWhiteBitError(code, msg);
      }
      if (data.success === false) {
        const msg = safeString(data, 'message') || 'Unknown error';
        this._handleWhiteBitError('FAIL', msg);
      }
      // Unwrap result if present
      if (data.result !== undefined) return data.result;
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  _handleWhiteBitError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const codeStr = String(code);

    // Check message content for specific errors
    const msgLower = typeof msg === 'string' ? msg.toLowerCase() : '';

    if (msgLower.includes('not enough balance') || msgLower.includes('insufficient')) {
      throw new InsufficientFunds(full);
    }
    if (msgLower.includes('market is not available') || msgLower.includes('unknown market')) {
      throw new BadSymbol(full);
    }
    if (msgLower.includes('order not found')) {
      throw new OrderNotFound(full);
    }
    if (msgLower.includes('unauthorized') || msgLower.includes('invalid key') || msgLower.includes('signature')) {
      throw new AuthenticationError(full);
    }
    if (msgLower.includes('rate limit') || msgLower.includes('too many requests')) {
      throw new RateLimitExceeded(full);
    }
    if (msgLower.includes('validation failed') || msgLower.includes('invalid')) {
      throw new BadRequest(full);
    }

    const errorMap = {
      '30': BadRequest,        // Default validation error
      '31': BadSymbol,         // Market validation failure
      '1': BadRequest,         // Inner validation failed
      '2': BadRequest,         // Inner validation failed
    };
    const ErrorClass = errorMap[codeStr] || ExchangeError;
    throw new ErrorClass(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.code !== undefined && parsed.code !== 0) {
        const code = parsed.code;
        const msg = safeString(parsed, 'message') || body;
        this._handleWhiteBitError(code, msg);
      }
      if (parsed.errors) {
        const errKeys = Object.keys(parsed.errors);
        const errMsg = errKeys.length > 0 ? errKeys.map(k => k + ': ' + parsed.errors[k]).join('; ') : body;
        this._handleWhiteBitError(parsed.code || 'VALIDATION', errMsg);
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
    // data from /api/v4/public/ticker — keyed by market: { "BTC_USDT": {...} }
    return {
      symbol,
      last: safeFloat(data, 'last_price'),
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: safeFloat(data, 'open'),
      close: safeFloat(data, 'last_price'),
      bid: safeFloat(data, 'bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'base_volume'),
      quoteVolume: safeFloat(data, 'quote_volume'),
      change: safeFloat(data, 'change'),
      percentage: undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'orderId') || safeString(data, 'order_id');
    const wbSymbol = safeString(data, 'market');
    const symbol = wbSymbol ? this._fromWhiteBitSymbol(wbSymbol) : fallbackSymbol;
    const side = safeStringUpper(data, 'side') || 'BUY';
    const type = safeStringUpper(data, 'type') || 'LIMIT';
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'amount') || safeFloat(data, 'left') || 0;
    const dealStock = safeFloat(data, 'dealStock') || 0;
    const dealMoney = safeFloat(data, 'dealMoney') || 0;
    const left = safeFloat(data, 'left') || 0;
    const ts = safeFloat(data, 'timestamp');
    const timestamp = ts ? Math.round(ts * 1000) : Date.now();

    return {
      id: orderId,
      clientOrderId: safeString(data, 'clientOrderId'),
      symbol,
      type,
      side,
      price,
      amount,
      filled: dealStock,
      remaining: left,
      cost: dealMoney,
      average: dealStock > 0 ? dealMoney / dealStock : 0,
      status: 'open',
      timestamp,
      datetime: iso8601(timestamp),
      info: data,
    };
  }

  _parseOrderBook(data, symbol) {
    // /api/v4/public/orderbook/{market}
    // { asks: [[price, amount], ...], bids: [[price, amount], ...] }
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.amount)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.amount)];
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

    const data = await this._request('GET', '/api/v4/public/markets', {}, false, 5);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    // Response is array of market objects
    const pairs = Array.isArray(data) ? data : [];

    for (const s of pairs) {
      const id = safeString(s, 'name');
      if (!id) continue;

      const stock = safeString(s, 'stock');  // base currency
      const money = safeString(s, 'money');  // quote currency
      if (!stock || !money) continue;

      const base = stock.toUpperCase();
      const quote = money.toUpperCase();
      const symbol = base + '/' + quote;

      const market = {
        id,
        symbol,
        base,
        quote,
        active: true,
        precision: {
          price: safeInteger(s, 'moneyPrec'),
          amount: safeInteger(s, 'stockPrec'),
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

  async fetchTicker(symbol) {
    const wbSymbol = this._toWhiteBitSymbol(symbol);
    const data = await this._request('GET', '/api/v4/public/ticker', {}, false, 1);
    // Response is object keyed by market: { "BTC_USDT": {...}, ... }
    const tickerData = data[wbSymbol] || {};
    return this._parseTicker(tickerData, symbol);
  }

  async fetchTickers(symbols = undefined) {
    const data = await this._request('GET', '/api/v4/public/ticker', {}, false, 1);
    const tickers = {};
    for (const [wbSymbol, tickerData] of Object.entries(data)) {
      const symbol = this._fromWhiteBitSymbol(wbSymbol);
      if (!symbols || symbols.includes(symbol)) {
        tickers[symbol] = this._parseTicker(tickerData, symbol);
      }
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const wbSymbol = this._toWhiteBitSymbol(symbol);
    const params = {};
    if (limit) params.limit = limit;
    const data = await this._request('GET', '/api/v4/public/orderbook/' + wbSymbol, params, false, 1);
    return this._parseOrderBook(data, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account (all POST, signed)
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const wbSymbol = this._toWhiteBitSymbol(symbol);
    const isMarket = type && type.toUpperCase() === 'MARKET';

    let path;
    const request = {
      market: wbSymbol,
      side: side.toLowerCase(),
      amount: String(amount),
      ...params,
    };

    if (isMarket) {
      path = '/api/v4/order/market';
    } else {
      path = '/api/v4/order/limit';
      if (price === undefined || price === null) {
        throw new InvalidOrder(this.id + ' createOrder requires price for limit orders');
      }
      request.price = String(price);
    }

    const data = await this._request('POST', path, request, true, 1);
    return this._parseOrder(data, symbol);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = {
      orderId: parseInt(id),
      ...params,
    };

    if (symbol) {
      request.market = this._toWhiteBitSymbol(symbol);
    }

    const data = await this._request('POST', '/api/v4/order/cancel', request, true, 1);

    return {
      id: String(id),
      symbol,
      status: 'canceled',
      info: data,
    };
  }

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('POST', '/api/v4/trade-account/balance', { ...params }, true, 1);

    const balance = { info: data, timestamp: Date.now(), datetime: iso8601(Date.now()) };

    // Response is object keyed by currency: { "BTC": { available: "0.5", freeze: "0.1" }, ... }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [currency, b] of Object.entries(data)) {
        const free = safeFloat(b, 'available') || 0;
        const used = safeFloat(b, 'freeze') || 0;
        if (free > 0 || used > 0) {
          balance[currency.toUpperCase()] = { free, used, total: free + used };
        }
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — zlib-compressed binary, client-initiated PING
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 50000 });

    // WhiteBit: client sends {"method":"server.ping","id":0,"params":[]} every 50s
    client._startPing = function () {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send(JSON.stringify({ method: 'server.ping', id: 0, params: [] }));
        }
      }, this.pingInterval);
    };

    // Override connect: handle zlib-compressed binary messages
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);
      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          if (typeof this._resetPongTimer === 'function') this._resetPongTimer();

          // Binary data: zlib-compressed with Z_SYNC_FLUSH
          if (raw && raw.byteLength !== undefined && raw.byteLength > 0) {
            zlib.unzip(Buffer.from(raw), { finishFlush: zlib.constants.Z_SYNC_FLUSH }, (err, buffer) => {
              if (err) {
                this.emit('error', err);
                return;
              }
              try {
                const data = JSON.parse(buffer.toString());
                this.emit('message', data);
              } catch (e) {
                this.emit('error', e);
              }
            });
            return;
          }

          // Text data fallback
          try {
            const text = raw.toString();
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

  async _subscribeWhiteBit(channel, symbol, callback, subParams) {
    const client = await this._ensureWsConnected();

    // WhiteBit subscribe: {"method":"depth.subscribe","id":2,"params":["BTC_USDT",50,"0",true]}
    const subMsg = { method: channel + '.subscribe', id: 2, params: subParams };
    client.send(subMsg);

    const channelId = channel + ':' + symbol;
    const handler = (data) => {
      if (data && data.method === channel + '.update') {
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
    const wbSymbol = this._toWhiteBitSymbol(symbol);
    const depth = limit || 50;
    return this._subscribeWhiteBit('depth', wbSymbol, (msg) => {
      callback(this._parseWsOrderBook(msg, symbol));
    }, [wbSymbol, depth, '0', true]);
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    // data.params[0] = true/false (snapshot/update)
    // data.params[1] = {asks: [[price, amount]], bids: [[price, amount]]}
    // data.params[2] = symbol string
    const params = data.params || [];
    const isSnapshot = params[0] === true;
    const d = params[1] || {};

    const bids = (d.bids || []).map(entry =>
      [parseFloat(entry[0]), parseFloat(entry[1])]
    );
    const asks = (d.asks || []).map(entry =>
      [parseFloat(entry[0]), parseFloat(entry[1])]
    );

    return {
      symbol,
      bids,
      asks,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
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

module.exports = WhiteBit;

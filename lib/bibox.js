'use strict';

const zlib = require('zlib');
const BaseExchange = require('./BaseExchange');
const { hmacSHA256, hmacMD5 } = require('./utils/crypto');
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

class Bibox extends BaseExchange {
  describe() {
    return {
      id: 'bibox',
      name: 'Bibox',
      version: 'v1',
      rateLimit: 167,
      rateLimitCapacity: 30,
      rateLimitInterval: 5000,
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
        createMarketOrder: false,
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
        api: 'https://api.bibox.com',
        ws: 'wss://npush.bibox360.com/',
        doc: 'https://biboxcom.github.io/api/spot/v4/en/',
      },
      timeframes: {},
      fees: {
        trading: { maker: 0.002, taker: 0.002 },
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
  // Authentication — Dual: V3 HmacMD5 + V4 HmacSHA256
  // ---------------------------------------------------------------------------

  /**
   * Bibox uses two API versions with different auth:
   *   V3 (/v3/...) — HmacMD5: sign(timestamp + jsonBody), POST only
   *   V4 (/api/v4/...) — HmacSHA256: sign(queryString), GET only (for our endpoints)
   * Path prefix determines which auth to use.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    if (path.startsWith('/v3/')) {
      // -----------------------------------------------------------------------
      // V3 AUTH — HmacMD5, POST, lowercase headers
      // -----------------------------------------------------------------------
      const timestamp = String(Date.now());
      const bodyStr = JSON.stringify(params);
      const signingString = timestamp + bodyStr;
      const signature = hmacMD5(signingString, this.secret);

      return {
        params,
        headers: {
          'bibox-api-key': this.apiKey,
          'bibox-timestamp': timestamp,
          'bibox-api-sign': signature,
        },
      };
    }

    // -------------------------------------------------------------------------
    // V4 AUTH — HmacSHA256, GET, titlecase headers
    // -------------------------------------------------------------------------
    const qs = new URLSearchParams(params).toString();
    const signingString = qs;
    const signature = hmacSHA256(signingString, this.secret);
    const expireTime = String(Date.now() + 5000);

    return {
      params,
      headers: {
        'Bibox-Api-Key': this.apiKey,
        'Bibox-Expire-Time': expireTime,
        'Bibox-Api-Sign': signature,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTC_USDT <-> BTC/USDT
  // ---------------------------------------------------------------------------

  _toBiboxSymbol(symbol) {
    // 'BTC/USDT' → 'BTC_USDT'
    const parts = symbol.split('/');
    return parts[0] + '_' + parts[1];
  }

  _fromBiboxSymbol(biboxSymbol) {
    // 'BTC_USDT' → 'BTC/USDT' (via marketsById lookup)
    if (this.marketsById && this.marketsById[biboxSymbol]) {
      return this.marketsById[biboxSymbol].symbol;
    }
    // Fallback: parse directly
    const parts = biboxSymbol.split('_');
    if (parts.length === 2) {
      return parts[0].toUpperCase() + '/' + parts[1].toUpperCase();
    }
    return biboxSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling — dual format:
  //   V3: { state: 0, order_id: "..." } — state 0 = success
  //   V4: direct array or { result: [...] } — no wrapper for balance
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // V3 error: state !== 0
      if (data.state !== undefined && data.state !== 0) {
        const code = data.state;
        const msg = safeString(data, 'msg') || safeString(data, 'message') || 'Unknown error';
        this._handleBiboxError(code, msg);
      }
      // V4 error: error object
      if (data.error) {
        const code = data.error.code || 'unknown';
        const msg = data.error.msg || data.error.message || 'Unknown error';
        this._handleBiboxError(code, msg);
      }
      // V3/V4 result wrapper
      if (data.result !== undefined) return data.result;
    }
    // V4 direct array (e.g., balance) or scalar
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling — numeric error codes
  // ---------------------------------------------------------------------------

  _handleBiboxError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const errorMap = {
      // BadRequest — parameter issues
      '2034': BadRequest,
      '3000': BadRequest,
      '3002': BadRequest,
      // OrderNotFound
      '2040': OrderNotFound,
      '2064': OrderNotFound,
      // InsufficientFunds
      '2085': InsufficientFunds,
      '2086': InsufficientFunds,
      // RateLimitExceeded
      '2091': RateLimitExceeded,
      '3028': RateLimitExceeded,
      '3029': RateLimitExceeded,
      '-2101': RateLimitExceeded,
      '-2102': RateLimitExceeded,
      // AuthenticationError
      '3012': AuthenticationError,
      '3024': AuthenticationError,
      '3025': AuthenticationError,
      '3026': AuthenticationError,
      '3027': AuthenticationError,
      // BadSymbol
      '3016': BadSymbol,
      // ExchangeNotAvailable
      '4000': ExchangeNotAvailable,
      '4003': ExchangeNotAvailable,
    };
    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.state !== undefined && parsed.state !== 0) {
        const code = parsed.state;
        const msg = safeString(parsed, 'msg') || safeString(parsed, 'message') || body;
        this._handleBiboxError(code, msg);
      }
      if (parsed.error) {
        const code = parsed.error.code || 'unknown';
        const msg = parsed.error.msg || parsed.error.message || body;
        this._handleBiboxError(code, msg);
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
      last: safeFloat(data, 'last'),
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: undefined,
      close: safeFloat(data, 'last'),
      bid: safeFloat(data, 'buy'),
      bidVolume: safeFloat(data, 'buy_amount'),
      ask: safeFloat(data, 'sell'),
      askVolume: safeFloat(data, 'sell_amount'),
      volume: safeFloat(data, 'vol'),
      quoteVolume: undefined,
      change: undefined,
      percentage: safeFloat(data, 'percent'),
      timestamp: safeInteger(data, 'timestamp') || Date.now(),
      datetime: iso8601(safeInteger(data, 'timestamp') || Date.now()),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'order_id') || safeString(data, 'orderId');
    const biboxSymbol = safeString(data, 'pair') || safeString(data, 'symbol');
    const symbol = biboxSymbol ? this._fromBiboxSymbol(biboxSymbol) : fallbackSymbol;
    const orderSide = safeInteger(data, 'order_side');
    const side = orderSide === 1 ? 'BUY' : (orderSide === 2 ? 'SELL' : safeStringUpper(data, 'side'));
    const orderType = safeInteger(data, 'order_type');
    const type = orderType === 2 ? 'LIMIT' : (orderType === 1 ? 'MARKET' : 'LIMIT');
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'amount') || 0;
    const filledAmount = safeFloat(data, 'deal_amount') || safeFloat(data, 'filledAmount') || 0;
    const status = this._normalizeOrderStatus(safeInteger(data, 'status'));
    const ts = safeInteger(data, 'createdAt') || safeInteger(data, 'create_time');

    return {
      id: orderId,
      clientOrderId: safeString(data, 'client_oid'),
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

  _normalizeOrderStatus(status) {
    const map = {
      1: 'open',       // waiting
      2: 'open',       // partly traded
      3: 'closed',     // fully traded
      4: 'canceled',   // partly cancelled
      5: 'canceled',   // fully cancelled
      100: 'canceled', // failed
    };
    return map[status] !== undefined ? map[status] : 'open';
  }

  _parseOrderBook(data, symbol) {
    // V4 orderbook: asks and bids as arrays of {price, volume} objects
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.volume || entry.amount)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.volume || entry.amount)];
    });

    return {
      symbol,
      bids,
      asks,
      timestamp: safeInteger(data, 'update_time') || Date.now(),
      datetime: iso8601(safeInteger(data, 'update_time') || Date.now()),
      nonce: undefined,
      info: data,
    };
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data (V4)
  // ---------------------------------------------------------------------------

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v4/marketdata/pairs', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const pairs = Array.isArray(result) ? result : (result && result.result ? result.result : []);

    for (const s of pairs) {
      const id = safeString(s, 'pair') || safeString(s, 'symbol');
      if (!id) continue;

      const parts = id.split('_');
      if (parts.length !== 2) continue;

      const base = parts[0].toUpperCase();
      const quote = parts[1].toUpperCase();
      const symbol = base + '/' + quote;

      const market = {
        id,
        symbol,
        base,
        quote,
        active: true,
        precision: {
          price: safeInteger(s, 'decimal') || safeInteger(s, 'price_scale'),
          amount: safeInteger(s, 'amount_scale'),
        },
        limits: {
          price: { min: undefined, max: undefined },
          amount: { min: safeFloat(s, 'min_amount'), max: undefined },
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
    const params = { symbol: this._toBiboxSymbol(symbol) };
    const data = await this._request('GET', '/api/v4/marketdata/ticker', params, false, 1);
    const result = this._unwrapResponse(data);
    return this._parseTicker(result, symbol);
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const params = { symbol: this._toBiboxSymbol(symbol) };
    if (limit) params.size = limit;
    const data = await this._request('GET', '/api/v4/marketdata/order_book', params, false, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderBook(result, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading (V3) & Account (V4)
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    if (type && type.toUpperCase() === 'MARKET') {
      throw new InvalidOrder(this.id + ' does not support market orders — only limit orders');
    }
    if (price === undefined || price === null) {
      throw new InvalidOrder(this.id + ' createOrder requires price (only limit orders supported)');
    }

    const orderSide = side.toUpperCase() === 'BUY' ? 1 : 2;
    const request = {
      pair: this._toBiboxSymbol(symbol),
      order_side: orderSide,
      order_type: 2,  // LIMIT
      price: parseFloat(price),
      amount: parseFloat(amount),
      ...params,
    };

    const data = await this._request('POST', '/v3/spot/order/trade', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(data, 'order_id') || safeString(result, 'order_id'),
      symbol,
      type: 'LIMIT',
      side: side.toUpperCase(),
      price: parseFloat(price),
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
      order_id: id,
      ...params,
    };

    const data = await this._request('POST', '/v3/spot/order/cancel', request, true, 1);
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

    const data = await this._request('GET', '/api/v4/userdata/accounts', { ...params }, true, 1);
    const result = this._unwrapResponse(data);

    const balance = { info: result, timestamp: Date.now(), datetime: iso8601(Date.now()) };
    const balances = Array.isArray(result) ? result : [];

    for (const b of balances) {
      const currency = safeString(b, 's');
      if (!currency) continue;
      const free = safeFloat(b, 'a') || 0;
      const used = safeFloat(b, 'h') || 0;
      if (free > 0 || used > 0) {
        balance[currency.toUpperCase()] = { free, used, total: free + used };
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

    const client = new WsClient({ url: wsUrl, pingInterval: 10000 });

    // Bibox: client sends {"ping": timestamp} every 10s
    client._startPing = function () {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send(JSON.stringify({ ping: Date.now() }));
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

          // Binary data: first byte is marker, rest is zlib-compressed
          if (raw && raw.byteLength !== undefined && raw.byteLength > 1) {
            const sliced = raw.slice(1);
            zlib.unzip(sliced, (err, buffer) => {
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

  async _subscribeBibox(channel, symbol, callback) {
    const client = await this._ensureWsConnected();

    // Bibox subscribe: {"sub": "BTC_USDT_depth"}
    const subMsg = { sub: symbol + '_' + channel };
    client.send(subMsg);

    const channelId = channel + ':' + symbol;
    const handler = (data) => {
      // Depth data: { t: 0/1, d: { pair, asks, bids, ... } }
      if (data && data.d && data.d.pair === symbol) {
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
    const biboxSymbol = this._toBiboxSymbol(symbol);
    return this._subscribeBibox('depth', biboxSymbol, (msg) => {
      callback(this._parseWsOrderBook(msg, symbol));
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const d = data.d || data;
    const dataType = data.t;  // 0 = snapshot, 1 = incremental

    // Snapshot (t=0): full 20-level orderbook
    const bids = (d.bids || []).map(entry =>
      Array.isArray(entry) ? [parseFloat(entry[0]), parseFloat(entry[1])] : [parseFloat(entry.price), parseFloat(entry.volume)]
    );
    const asks = (d.asks || []).map(entry =>
      Array.isArray(entry) ? [parseFloat(entry[0]), parseFloat(entry[1])] : [parseFloat(entry.price), parseFloat(entry.volume)]
    );

    return {
      symbol,
      bids,
      asks,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
      dataType,  // 0 = snapshot, 1 = incremental
      add: d.add || undefined,  // incremental additions
      del: d.del || undefined,  // incremental deletions
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

module.exports = Bibox;

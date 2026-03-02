'use strict';

const crypto = require('crypto');
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

class Cointr extends BaseExchange {
  describe() {
    return {
      id: 'cointr',
      name: 'CoinTR',
      version: 'v1',
      rateLimit: 200,
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
        api: 'https://api.cointr.pro',
        ws: 'wss://stream.cointr.pro/ws',
        doc: 'https://docs.cointr.pro/',
      },
      requiredCredentials: ['apiKey', 'secret'],
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
    this._orderBooks = new Map();
  }

  // ---------------------------------------------------------------------------
  // Authentication — Double-layer HMAC-SHA256
  // ---------------------------------------------------------------------------

  /**
   * CoinTR uses a double-layer HMAC-SHA256 signing scheme:
   *  1. Derive a temporary key: hmacSHA256(floor(timestamp/30000), secret)
   *  2. Sign totalParams with the temp key
   *
   * For GET: params + timestamp go into query string, no body.
   * For POST: only timestamp in query string, params in JSON body.
   *
   * Returns { params, headers, _queryString } where _queryString is used
   * by the _request() override to inject into the URL for POST requests.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = String(Date.now());
    let queryString, bodyStr;

    if (method === 'GET') {
      const allParams = { ...params, timestamp };
      queryString = new URLSearchParams(allParams).toString();
      bodyStr = '';
    } else {
      queryString = 'timestamp=' + timestamp;
      bodyStr = Object.keys(params).length > 0 ? JSON.stringify(params) : '';
    }

    const totalParams = queryString + bodyStr;

    // Double HMAC: derive temp key from time window, then sign with it
    const tempKey = hmacSHA256(String(Math.floor(parseInt(timestamp) / 30000)), this.secret);
    const signature = hmacSHA256(totalParams, tempKey);

    const headers = {
      'X-COINTR-APIKEY': this.apiKey,
      'X-COINTR-SIGN': signature,
    };

    if (method === 'GET') {
      // For GET: include timestamp in params so BaseExchange builds the full query string
      return { params: { ...params, timestamp }, headers };
    } else {
      // For POST: params stay as JSON body, timestamp goes into _queryString
      return { params, headers, _queryString: 'timestamp=' + timestamp };
    }
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Request Override — Inject timestamp query string for signed POST requests
  // ---------------------------------------------------------------------------

  /**
   * BaseExchange._request() puts POST params into the JSON body when postAsJson=true,
   * but CoinTR needs `?timestamp=xxx` in the URL for signed POST requests.
   * We override _request() to handle this case.
   */
  async _request(method, path, params = {}, signed = false, weight = 1) {
    if (method === 'POST' && signed) {
      // Rate limiting
      if (this.enableRateLimit && this._throttler) {
        await this._throttler.consume(weight);
      }

      const signResult = this._sign(path, 'POST', { ...params });
      const baseUrl = this._getBaseUrl(signed);
      const url = baseUrl + path + '?' + signResult._queryString;
      const headers = { ...signResult.headers, 'Content-Type': 'application/json' };

      const fetchOptions = {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(this.timeout),
      };

      const bodyParams = signResult.params || params;
      if (Object.keys(bodyParams).length > 0) {
        fetchOptions.body = JSON.stringify(bodyParams);
      }

      if (this.verbose) console.log('POST', url);

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

    // Non-POST or unsigned: use standard BaseExchange flow
    return super._request(method, path, params, signed, weight);
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTCUSDT <-> BTC/USDT (concatenated, no separator)
  // ---------------------------------------------------------------------------

  _toCointrSymbol(symbol) {
    // 'BTC/USDT' -> 'BTCUSDT'
    return symbol.replace('/', '');
  }

  _fromCointrSymbol(cointrSymbol) {
    // 'BTCUSDT' -> 'BTC/USDT' (via marketsById lookup)
    if (this.marketsById && this.marketsById[cointrSymbol]) {
      return this.marketsById[cointrSymbol].symbol;
    }
    // Fallback: return raw symbol if no mapping found
    return cointrSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling — { code: "0", msg: "", data: ... }
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Check for error code
      if (data.code !== undefined && data.code !== '0') {
        const msg = safeString(data, 'msg') || 'Unknown error';
        const code = safeString(data, 'code') || 'unknown';
        this._handleCointrError(code, msg);
      }
      // Unwrap data envelope
      if (data.data !== undefined) {
        return data.data;
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling — Exchange error codes and HTTP status codes
  // ---------------------------------------------------------------------------

  _handleCointrError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    // Map by message keywords
    if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('order_not_found')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid symbol') || lowerMsg.includes('instrument') || lowerMsg.includes('market not found')) {
      throw new BadSymbol(full);
    }
    if (lowerMsg.includes('invalid order') || lowerMsg.includes('order_invalid') || lowerMsg.includes('order size') || lowerMsg.includes('price')) {
      throw new InvalidOrder(full);
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many') || lowerMsg.includes('frequency')) {
      throw new RateLimitExceeded(full);
    }
    if (lowerMsg.includes('auth') || lowerMsg.includes('permission') || lowerMsg.includes('sign') || lowerMsg.includes('credential') || lowerMsg.includes('api key')) {
      throw new AuthenticationError(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.code !== undefined && parsed.code !== '0') {
        const msg = safeString(parsed, 'msg') || body;
        const code = safeString(parsed, 'code') || String(statusCode);
        this._handleCointrError(code, msg);
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

  _parseTicker(data) {
    const instId = safeString(data, 'instId') || '';
    const symbol = this._fromCointrSymbol(instId);
    const ts = safeInteger(data, 'ts') || Date.now();

    return {
      symbol,
      last: safeFloat(data, 'last'),
      high: safeFloat(data, 'high24h'),
      low: safeFloat(data, 'low24h'),
      open: safeFloat(data, 'open24h'),
      close: safeFloat(data, 'last'),
      bid: safeFloat(data, 'bidPx'),
      bidVolume: safeFloat(data, 'bidSz'),
      ask: safeFloat(data, 'askPx'),
      askVolume: safeFloat(data, 'askSz'),
      volume: safeFloat(data, 'vol24h'),
      quoteVolume: safeFloat(data, 'volCcy24h'),
      change: undefined,
      percentage: undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'ordId');
    const clientOrderId = safeString(data, 'clOrdId');
    const instId = safeString(data, 'instId') || '';
    const symbol = instId ? this._fromCointrSymbol(instId) : fallbackSymbol;
    const side = safeString(data, 'side') || '';
    const ordType = safeString(data, 'ordType') || 'limit';
    const price = safeFloat(data, 'px') || 0;
    const amount = safeFloat(data, 'sz') || 0;
    const filledAmount = safeFloat(data, 'fillSz') || 0;
    const state = safeString(data, 'state') || '';
    const sCode = safeString(data, 'sCode');
    const sMsg = safeString(data, 'sMsg');
    const cTime = safeInteger(data, 'cTime') || Date.now();
    const uTime = safeInteger(data, 'uTime');

    // Map CoinTR state to unified status
    let status = 'open';
    if (state === 'live' || state === 'partially_filled') {
      status = 'open';
    } else if (state === 'filled') {
      status = 'closed';
    } else if (state === 'canceled' || state === 'cancelled') {
      status = 'canceled';
    }

    // For createOrder response, sCode indicates success/failure
    if (sCode !== undefined && sCode !== '0' && sMsg) {
      status = 'rejected';
    }

    return {
      id: orderId,
      clientOrderId,
      symbol,
      type: ordType.toUpperCase(),
      side: side.toUpperCase(),
      price,
      amount,
      filled: filledAmount,
      remaining: amount > 0 ? amount - filledAmount : 0,
      cost: filledAmount * price,
      average: filledAmount > 0 ? (filledAmount * price) / filledAmount : 0,
      status,
      timestamp: cTime,
      datetime: iso8601(cTime),
      info: data,
    };
  }

  _parseOrderBook(data, symbol) {
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.px), parseFloat(entry.size || entry.sz)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.px), parseFloat(entry.size || entry.sz)];
    });

    const ts = safeInteger(data, 'ts') || Date.now();

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
      const currency = safeString(b, 'ccy');
      if (!currency) continue;
      const free = safeFloat(b, 'availBal') || 0;
      const used = safeFloat(b, 'frozenBal') || 0;
      const total = safeFloat(b, 'bal') || 0;
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

    const data = await this._request('GET', '/v1/spot/public/instruments', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const instruments = Array.isArray(result) ? result : [];

    for (const s of instruments) {
      const instId = safeString(s, 'instId');
      const base = safeString(s, 'baseCcy');
      const quote = safeString(s, 'quoteCcy');
      if (!instId || !base || !quote) continue;

      const state = safeString(s, 'state');
      const symbol = base.toUpperCase() + '/' + quote.toUpperCase();

      const market = {
        id: instId,
        symbol,
        base: base.toUpperCase(),
        quote: quote.toUpperCase(),
        active: state === 'live',
        precision: {
          price: this._countDecimals(safeString(s, 'tickSz') || '0.01'),
          amount: this._countDecimals(safeString(s, 'lotSz') || '0.00001'),
        },
        limits: {
          amount: {
            min: safeFloat(s, 'minSz'),
            max: safeFloat(s, 'maxSz'),
          },
          price: { min: undefined, max: undefined },
        },
        info: s,
      };

      this.markets[symbol] = market;
      this.marketsById[instId] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  /**
   * Count decimal places in a tick/lot size string (e.g. "0.01" -> 2)
   */
  _countDecimals(str) {
    if (!str || str.indexOf('.') === -1) return 0;
    return str.split('.')[1].length;
  }

  async fetchTicker(symbol) {
    const cointrSymbol = this._toCointrSymbol(symbol);
    const data = await this._request('GET', '/v1/spot/market/tickers', {}, false, 1);
    const result = this._unwrapResponse(data);

    const tickers = Array.isArray(result) ? result : [];
    const tickerData = tickers.find(t => t.instId === cointrSymbol);

    if (!tickerData) {
      throw new BadSymbol(this.id + ' fetchTicker: symbol not found: ' + symbol);
    }

    return this._parseTicker(tickerData);
  }

  async fetchTickers(symbols = undefined) {
    const data = await this._request('GET', '/v1/spot/market/tickers', {}, false, 1);
    const result = this._unwrapResponse(data);

    const tickers = {};
    const tickerList = Array.isArray(result) ? result : [];

    for (const td of tickerList) {
      const instId = safeString(td, 'instId') || '';
      const sym = this._fromCointrSymbol(instId);
      if (!symbols || symbols.includes(sym)) {
        tickers[sym] = this._parseTicker(td);
      }
    }

    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined, params = {}) {
    const cointrSymbol = this._toCointrSymbol(symbol);
    const requestParams = { instId: cointrSymbol, ...params };

    const data = await this._request('GET', '/v1/spot/market/depths', requestParams, false, 1);
    const result = this._unwrapResponse(data);

    return this._parseOrderBook(result, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const orderType = (type || 'limit').toLowerCase();
    const orderSide = (side || '').toLowerCase();
    const clOrdId = crypto.randomUUID();

    if (orderSide !== 'buy' && orderSide !== 'sell') {
      throw new InvalidOrder(this.id + ' createOrder requires side to be "buy" or "sell"');
    }

    const request = {
      instId: this._toCointrSymbol(symbol),
      side: orderSide,
      ordType: orderType,
      sz: String(amount),
      clOrdId,
      ...params,
    };

    // Include price for limit orders, omit for market orders
    if (orderType === 'limit') {
      if (price === undefined || price === null) {
        throw new InvalidOrder(this.id + ' createOrder requires price for limit orders');
      }
      request.px = String(price);
    }

    const data = await this._request('POST', '/v1/spot/trade/order', request, true, 1);
    const result = this._unwrapResponse(data);

    // Check sub-code for order-level errors
    const sCode = safeString(result, 'sCode');
    const sMsg = safeString(result, 'sMsg');
    if (sCode !== undefined && sCode !== '0' && sMsg) {
      this._handleCointrError(sCode, sMsg);
    }

    return {
      id: safeString(result, 'ordId'),
      clientOrderId: safeString(result, 'clOrdId') || clOrdId,
      symbol,
      type: orderType.toUpperCase(),
      side: orderSide.toUpperCase(),
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

    if (!symbol) {
      throw new BadRequest(this.id + ' cancelOrder requires symbol argument');
    }

    const request = {
      instId: this._toCointrSymbol(symbol),
      ordId: String(id),
      ...params,
    };

    const data = await this._request('POST', '/v1/spot/trade/cancel-order', request, true, 1);
    const result = this._unwrapResponse(data);

    // Check sub-code for order-level errors
    const sCode = safeString(result, 'sCode');
    const sMsg = safeString(result, 'sMsg');
    if (sCode !== undefined && sCode !== '0' && sMsg) {
      this._handleCointrError(sCode, sMsg);
    }

    return {
      id: safeString(result, 'ordId') || String(id),
      clientOrderId: safeString(result, 'clOrdId'),
      symbol,
      status: 'canceled',
      info: result,
    };
  }

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/v1/spot/asset/balance', { ...params }, true, 1);
    const result = this._unwrapResponse(data);

    return this._parseBalance(result);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();

    const request = { ...params };
    if (symbol) {
      request.instId = this._toCointrSymbol(symbol);
    }

    const data = await this._request('GET', '/v1/spot/trade/orders-active', request, true, 1);
    const result = this._unwrapResponse(data);

    const orders = Array.isArray(result) ? result : [];
    return orders.map(o => this._parseOrder(o, symbol));
  }

  // ---------------------------------------------------------------------------
  // WebSocket — Native WebSocket with ping/pong text frames
  // ---------------------------------------------------------------------------

  /**
   * CoinTR WebSocket:
   * - Connect to wss://stream.cointr.pro/ws
   * - Subscribe: { op: "subscribe", args: [{ channel: "books", instId: "BTCUSDT" }] }
   * - Ping: send text 'ping' every ~15s, server responds 'pong'
   * - Orderbook: action "snapshot" for full book, "update" for incremental
   */
  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 15000 });
    const exchange = this;

    // Override default ping to send text 'ping' instead of WebSocket ping frame
    client._startPing = function () {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send('ping');
          this._pongTimer = setTimeout(() => {
            if (this._ws) this._ws.terminate();
          }, this.pongTimeout);
        }
      }, this.pingInterval);
    };

    // Override connect to handle text ping/pong and raw message parsing
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);

      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();

          // Text pong response — reset pong timer
          if (text === 'pong') {
            this._resetPongTimer();
            return;
          }

          // Parse JSON messages
          try {
            const data = JSON.parse(text);
            this.emit('message', data);
          } catch (err) {
            this.emit('error', err);
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

  async _subscribeCointr(channel, instId, callback) {
    const client = await this._ensureWsConnected();

    const subMsg = {
      op: 'subscribe',
      args: [{ channel, instId }],
    };

    client.subscribe(channel + ':' + instId, subMsg);

    const channelId = channel + ':' + instId;
    const handler = (data) => {
      if (data && data.arg && data.arg.channel === channel && data.arg.instId === instId) {
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
    const cointrSymbol = this._toCointrSymbol(symbol);

    return this._subscribeCointr('books', cointrSymbol, (msg) => {
      const action = msg.action;
      const data = msg.data;

      if (!data) return;

      if (action === 'snapshot') {
        // Full orderbook snapshot — replace stored book
        const book = this._parseOrderBook(data, symbol);
        this._orderBooks.set(symbol, book);
        callback(book);
      } else if (action === 'update') {
        // Incremental update — apply to stored book
        const existing = this._orderBooks.get(symbol);
        if (existing) {
          this._applyOrderBookUpdate(existing, data);
          existing.timestamp = safeInteger(data, 'ts') || Date.now();
          existing.datetime = iso8601(existing.timestamp);
          existing.info = data;
          callback(existing);
        } else {
          // No snapshot yet — treat update as snapshot
          const book = this._parseOrderBook(data, symbol);
          this._orderBooks.set(symbol, book);
          callback(book);
        }
      }
    });
  }

  /**
   * Apply incremental orderbook update to existing book.
   * Entries with amount "0" are removed, others are inserted/updated.
   */
  _applyOrderBookUpdate(book, updateData) {
    const updateAsks = (updateData.asks || []).map(e =>
      Array.isArray(e) ? [parseFloat(e[0]), parseFloat(e[1])] : [parseFloat(e.px), parseFloat(e.sz)]
    );
    const updateBids = (updateData.bids || []).map(e =>
      Array.isArray(e) ? [parseFloat(e[0]), parseFloat(e[1])] : [parseFloat(e.px), parseFloat(e.sz)]
    );

    // Apply ask updates
    for (const [price, amount] of updateAsks) {
      if (amount === 0) {
        book.asks = book.asks.filter(a => a[0] !== price);
      } else {
        const idx = book.asks.findIndex(a => a[0] === price);
        if (idx >= 0) {
          book.asks[idx] = [price, amount];
        } else {
          book.asks.push([price, amount]);
        }
      }
    }
    // Sort asks ascending by price
    book.asks.sort((a, b) => a[0] - b[0]);

    // Apply bid updates
    for (const [price, amount] of updateBids) {
      if (amount === 0) {
        book.bids = book.bids.filter(b => b[0] !== price);
      } else {
        const idx = book.bids.findIndex(b => b[0] === price);
        if (idx >= 0) {
          book.bids[idx] = [price, amount];
        } else {
          book.bids.push([price, amount]);
        }
      }
    }
    // Sort bids descending by price
    book.bids.sort((a, b) => b[0] - a[0]);
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
    this._orderBooks.clear();
  }
}

module.exports = Cointr;

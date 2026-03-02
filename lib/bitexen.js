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
} = require('./utils/errors');

class Bitexen extends BaseExchange {
  describe() {
    return {
      id: 'bitexen',
      name: 'Bitexen',
      version: 'v1',
      rateLimit: 200,
      rateLimitCapacity: 5,
      rateLimitInterval: 1000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: true,
        fetchTickers: true,
        fetchOrderBook: false,
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
        amendOrder: false,
        // WebSocket
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: false,
        watchKlines: false,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://www.bitexen.com',
        ws: 'wss://www.bitexen.com/v2/socket.io/',
        doc: 'https://docs.bitexen.com/',
      },
      timeframes: {},
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Constructor — 4 credentials: apiKey, secret, passphrase, uid
  // ---------------------------------------------------------------------------

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this.passphrase = config.passphrase || config.password || '';
    this.uid = config.uid || config.username || '';
    this._wsClients = new Map();
    this._wsHandlers = new Map();
    this._wsSid = null; // Socket.IO session ID
  }

  // ---------------------------------------------------------------------------
  // Authentication — HMAC-SHA256 (uppercased signature)
  // ---------------------------------------------------------------------------

  /**
   * Bitexen uses HMAC-SHA256 with a signing string composed of:
   *   apiKey + uid + passphrase + timestamp + body
   * The resulting signature is uppercased.
   * Four credentials are required: apiKey, secret, passphrase, uid.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = String(Date.now());
    const bodyStr = (method === 'POST' && Object.keys(params).length > 0)
      ? JSON.stringify(params)
      : '';
    const signingString = this.apiKey + this.uid + this.passphrase + timestamp + bodyStr;
    const signature = hmacSHA256(signingString, this.secret).toUpperCase();

    return {
      params,
      headers: {
        'ACCESS-KEY': this.apiKey,
        'ACCESS-USER': this.uid,
        'ACCESS-PASSPHRASE': this.passphrase,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-SIGN': signature,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // checkRequiredCredentials — requires passphrase and uid
  // ---------------------------------------------------------------------------

  checkRequiredCredentials() {
    super.checkRequiredCredentials();
    if (!this.passphrase) {
      throw new ExchangeError(this.id + ' requires passphrase');
    }
    if (!this.uid) {
      throw new ExchangeError(this.id + ' requires uid (username)');
    }
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTCTRY <-> BTC/TRY (concatenated, no separator)
  // ---------------------------------------------------------------------------

  _toBitexenSymbol(symbol) {
    // 'BTC/TRY' -> 'BTCTRY'
    return symbol.replace('/', '');
  }

  _fromBitexenSymbol(bitexenSymbol) {
    // 'BTCTRY' -> 'BTC/TRY' (via marketsById lookup)
    if (this.marketsById && this.marketsById[bitexenSymbol]) {
      return this.marketsById[bitexenSymbol].symbol;
    }
    // Fallback: return raw symbol if no mapping found
    return bitexenSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling — { data: { ... } } or { status: "error", message: "..." }
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Check for error status
      if (data.status === 'error') {
        const msg = safeString(data, 'message') || 'Unknown error';
        throw new ExchangeError(this.id + ' ' + msg);
      }
      // Check for null data
      if (data.data === null && data.status !== undefined) {
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
  // Error Handling — HTTP status codes and response body
  // ---------------------------------------------------------------------------

  _handleBitexenError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    // Map by message keywords
    if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('order_not_found')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid symbol') || lowerMsg.includes('market not found') || lowerMsg.includes('market_not_found')) {
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
      if (parsed.status === 'error') {
        const msg = safeString(parsed, 'message') || body;
        this._handleBitexenError(statusCode, msg);
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
    const last = safeFloat(data, 'last_price');
    const change = safeFloat(data, 'change_24h');
    const ts = Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'high_24h') || undefined,
      low: safeFloat(data, 'low_24h') || undefined,
      open: undefined,
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'volume_24h'),
      quoteVolume: undefined,
      change: undefined,
      percentage: change,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'order_number') || safeString(data, 'id');
    const marketCode = safeString(data, 'market_code');
    const symbol = marketCode ? this._fromBitexenSymbol(marketCode) : fallbackSymbol;
    const buySell = safeString(data, 'buy_sell');
    const side = buySell === 'B' ? 'BUY' : (buySell === 'S' ? 'SELL' : safeStringUpper(data, 'side'));
    const type = safeStringUpper(data, 'order_type') || 'LIMIT';
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'volume') || safeFloat(data, 'amount') || 0;
    const filledAmount = safeFloat(data, 'filled_volume') || safeFloat(data, 'filled_amount') || 0;
    const status = safeString(data, 'status') || 'open';
    const ts = safeInteger(data, 'created_at') || safeInteger(data, 'timestamp') || Date.now();

    return {
      id: orderId,
      clientOrderId: safeString(data, 'client_order_id'),
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

  _parseBalance(balanceInfo) {
    const balance = {
      info: balanceInfo,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    const items = Array.isArray(balanceInfo) ? balanceInfo : [];

    for (const b of items) {
      const currency = safeString(b, 'currency_code');
      if (!currency) continue;
      const free = safeFloat(b, 'available_balance') || 0;
      const total = safeFloat(b, 'total_balance') || safeFloat(b, 'balance') || 0;
      const used = total - free;
      if (free > 0 || total > 0) {
        balance[currency.toUpperCase()] = { free, used: used >= 0 ? used : 0, total };
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data
  // ---------------------------------------------------------------------------

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v1/market_info/', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    // result = { market_info: { BTCTRY: {...}, ETHTRY: {...} } }
    const marketInfo = result.market_info || result;

    for (const [id, s] of Object.entries(marketInfo)) {
      const base = safeString(s, 'base_currency') || safeString(s, 'base');
      const quote = safeString(s, 'counter_currency') || safeString(s, 'quote') || safeString(s, 'counter');
      if (!base || !quote) continue;

      const symbol = base.toUpperCase() + '/' + quote.toUpperCase();

      const market = {
        id,
        symbol,
        base: base.toUpperCase(),
        quote: quote.toUpperCase(),
        active: safeValue(s, 'is_active') !== false,
        precision: {
          price: safeInteger(s, 'price_precision') || safeInteger(s, 'decimal_places'),
          amount: safeInteger(s, 'amount_precision') || safeInteger(s, 'decimal_places'),
        },
        limits: {
          price: { min: safeFloat(s, 'minimum_order_val'), max: undefined },
          amount: { min: safeFloat(s, 'minimum_order_val'), max: undefined },
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
    const bitexenSymbol = this._toBitexenSymbol(symbol);
    const data = await this._request('GET', '/api/v1/ticker/', {}, false, 1);
    const result = this._unwrapResponse(data);

    // result = { ticker: { BTCTRY: {...}, ... } }
    const tickers = result.ticker || result;
    const tickerData = tickers[bitexenSymbol] || {};
    return this._parseTicker(tickerData, symbol);
  }

  async fetchTickers(symbols = undefined) {
    const data = await this._request('GET', '/api/v1/ticker/', {}, false, 1);
    const result = this._unwrapResponse(data);

    const tickers = {};
    const tickerData = result.ticker || result;

    for (const [bxSymbol, td] of Object.entries(tickerData)) {
      const sym = this._fromBitexenSymbol(bxSymbol);
      if (!symbols || symbols.includes(sym)) {
        tickers[sym] = this._parseTicker(td, sym);
      }
    }

    return tickers;
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    if (type && type.toUpperCase() === 'MARKET') {
      throw new InvalidOrder(this.id + ' does not support market orders — only limit orders');
    }
    if (price === undefined || price === null) {
      throw new InvalidOrder(this.id + ' createOrder requires price (only limit orders supported)');
    }

    const request = {
      volume: parseFloat(amount),
      price: parseFloat(price),
      order_type: 'limit',
      market_code: this._toBitexenSymbol(symbol),
      buy_sell: side.toUpperCase().slice(0, 1),  // "B" or "S"
      account_name: this.uid,
      ...params,
    };

    const data = await this._request('POST', '/api/v1/orders/', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'order_number') || safeString(result, 'id') || safeString(data, 'order_number'),
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
      info: result,
    };
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();

    // Bitexen cancel: orderId in URL path, POST with empty body
    const path = '/api/v1/cancel_order/' + id + '/';
    const data = await this._request('POST', path, { ...params }, true, 1);
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

    const data = await this._request('GET', '/api/v1/balance/', { ...params }, true, 1);
    const result = this._unwrapResponse(data);

    // result = { balance_info: [...] } or result = [...]
    const balanceInfo = result.balance_info || (Array.isArray(result) ? result : []);
    return this._parseBalance(balanceInfo);
  }

  // ---------------------------------------------------------------------------
  // WebSocket — Socket.IO v2 (Engine.IO v3)
  // ---------------------------------------------------------------------------

  /**
   * Bitexen uses Socket.IO v2 which requires:
   * 1. HTTP GET to get SID (polling transport handshake)
   * 2. WS connect with SID
   * 3. Upgrade handshake (2probe/3probe/5)
   * 4. Subscribe via 42["s_m","BTCTRY"] string format
   * 5. Server sends 2 (ping), client responds 3 (pong) for keepalive
   */
  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 25000 });
    const exchange = this;

    // Bitexen: server sends '2' (ping), client responds '3' (pong)
    // No client-initiated ping needed
    client._startPing = function () {
      // No-op: server-initiated ping handled in message handler
    };

    // Override connect for Socket.IO handshake
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      // Step 1: Get SID via polling transport
      try {
        const pollUrl = 'https://www.bitexen.com/v2/socket.io/?EIO=3&transport=polling&t=' + Date.now();
        const resp = await fetch(pollUrl, { signal: AbortSignal.timeout(10000) });
        const text = await resp.text();
        // Response format: "97:0{...}" — find the JSON part
        const jsonStart = text.indexOf('{');
        if (jsonStart !== -1) {
          const jsonEnd = text.lastIndexOf('}');
          const sidData = JSON.parse(text.substring(jsonStart, jsonEnd + 1));
          exchange._wsSid = sidData.sid;
        }
      } catch (e) {
        // If SID fetch fails, try without SID
      }

      // Step 2: Build WS URL with SID
      let wsConnUrl = 'wss://www.bitexen.com/v2/socket.io/?EIO=3&transport=websocket';
      if (exchange._wsSid) {
        wsConnUrl += '&sid=' + exchange._wsSid;
      }
      this.url = wsConnUrl;

      await originalConnect(wsConnUrl);

      if (this._ws) {
        // Step 3: Upgrade handshake
        this._ws.send('2probe');

        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();

          // Engine.IO ping: respond with pong
          if (text === '2') {
            this._ws.send('3');
            return;
          }
          // Probe response
          if (text === '3probe') {
            this._ws.send('5');
            return;
          }
          // Socket.IO message (42[...])
          if (text.startsWith('42')) {
            try {
              const data = JSON.parse(text.slice(2));
              this.emit('message', data);
            } catch (e) {
              this.emit('error', e);
            }
            return;
          }
          // Other Engine.IO messages (0=open, 40=connect ack) — ignored
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

  async _subscribeBitexen(channel, symbol, callback) {
    const client = await this._ensureWsConnected();

    // Bitexen subscribe: send raw string '42["s_m","BTCTRY"]' or '42["s_ob","BTCTRY"]'
    const subMsg = '42["' + channel + '","' + symbol + '"]';
    if (client._ws && client._ws.readyState === 1) {
      client._ws.send(subMsg);
    }

    const channelId = channel + ':' + symbol;
    const handler = (data) => {
      // data is array: ["event_name", eventData]
      if (Array.isArray(data) && data[0] && data.length >= 2) {
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

  async watchTicker(symbol, callback) {
    const bxSymbol = this._toBitexenSymbol(symbol);
    return this._subscribeBitexen('s_m', bxSymbol, (msg) => {
      // msg = ["s_m", { last_price: "...", ... }]
      if (msg[1]) {
        callback(this._parseTicker(msg[1], symbol));
      }
    });
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    const bxSymbol = this._toBitexenSymbol(symbol);
    return this._subscribeBitexen('s_ob', bxSymbol, (msg) => {
      // msg = ["s_ob", { asks: [...], bids: [...] }]
      if (msg[1]) {
        callback(this._parseWsOrderBook(msg[1], symbol));
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

module.exports = Bitexen;

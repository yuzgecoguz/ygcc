'use strict';

const BaseExchange = require('./BaseExchange');
const { krakenSign } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeStringLower, safeFloat2, safeString2,
  iso8601, sleep,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Kraken extends BaseExchange {

  describe() {
    return {
      id: 'kraken',
      name: 'Kraken',
      version: '0',
      rateLimit: 100,
      rateLimitCapacity: 15,
      rateLimitInterval: 3000,
      has: {
        // Public
        loadMarkets: true,
        fetchTicker: true,
        fetchTickers: true,
        fetchOrderBook: true,
        fetchTrades: true,
        fetchOHLCV: true,
        fetchTime: true,
        // Private
        createOrder: true,
        createLimitOrder: true,
        createMarketOrder: true,
        cancelOrder: true,
        cancelAllOrders: true,
        amendOrder: false,
        fetchOrder: true,
        fetchOpenOrders: true,
        fetchClosedOrders: true,
        fetchMyTrades: true,
        fetchBalance: true,
        fetchTradingFees: true,
        // WebSocket
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: true,
        watchBalance: true,
        watchOrders: true,
      },
      urls: {
        api: 'https://api.kraken.com',
        ws: 'wss://ws.kraken.com/v2',
        wsPrivate: 'wss://ws-auth.kraken.com/v2',
        doc: 'https://docs.kraken.com/api/',
      },
      timeframes: {
        '1m': 1, '5m': 5, '15m': 15, '30m': 30,
        '1h': 60, '4h': 240, '1d': 1440, '1w': 10080, '15d': 21600,
      },
      fees: {
        trading: { maker: 0.0016, taker: 0.0026 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsFormEncoded = true;
    this.postAsJson = false;
    this._wsClients = new Map();
    this._wsPrivateAuthenticated = false;
    this._wsToken = null;
    this._pingTimers = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION — SHA256 + HMAC-SHA512 (Kraken two-step signing)
  // ===========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();

    // Kraken nonce: microseconds
    const nonce = String(Date.now() * 1000);
    params.nonce = nonce;

    // Body as form-urlencoded string
    const body = new URLSearchParams(params).toString();

    // Two-step: SHA256(nonce + body) → HMAC-SHA512(path + hash, base64_decoded_secret)
    const signature = krakenSign(path, nonce, body, this.secret);

    const headers = {
      'API-Key': this.apiKey,
      'API-Sign': signature,
    };

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // RESPONSE ENVELOPE — Kraken wraps everything in { error: [], result: {} }
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object') {
      if (data.error && Array.isArray(data.error) && data.error.length > 0) {
        this._handleKrakenError(data.error);
      }
      if ('result' in data) {
        return data.result;
      }
    }
    return data;
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleResponseHeaders(headers) {
    // Kraken does not expose rate limit headers; throttler handles client-side
  }

  _handleHttpError(status, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && parsed.error && parsed.error.length > 0) {
      this._handleKrakenError(parsed.error);
    }

    const msg = parsed?.error?.[0] || body;
    const full = this.id + ' HTTP ' + status + ': ' + msg;
    if (status === 401 || status === 403) throw new AuthenticationError(full);
    if (status === 429) throw new RateLimitExceeded(full);
    if (status === 503 || status === 520 || status === 522) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  _handleKrakenError(errors) {
    const msg = errors.join(', ');
    const full = this.id + ' ' + msg;

    for (const err of errors) {
      // Authentication errors
      if (err.includes('EAPI:Invalid key') || err.includes('EAPI:Invalid signature')
        || err.includes('EAPI:Invalid nonce')) {
        throw new AuthenticationError(full);
      }

      // Rate limit
      if (err.includes('EAPI:Rate limit') || err.includes('EGeneral:Temporary lockout')) {
        throw new RateLimitExceeded(full);
      }

      // Insufficient funds
      if (err.includes('EOrder:Insufficient funds') || err.includes('EFunding:Insufficient')) {
        throw new InsufficientFunds(full);
      }

      // Invalid order
      if (err.includes('EOrder:') && !err.includes('Unknown order')) {
        throw new InvalidOrder(full);
      }

      // Order not found
      if (err.includes('EOrder:Unknown order')) {
        throw new OrderNotFound(full);
      }

      // Bad symbol
      if (err.includes('EQuery:Unknown asset pair') || err.includes('EGeneral:Invalid arguments:pair')) {
        throw new BadSymbol(full);
      }

      // Bad request
      if (err.includes('EGeneral:Invalid arguments') || err.includes('EQuery:')) {
        throw new BadRequest(full);
      }

      // Exchange unavailable
      if (err.includes('EService:Unavailable') || err.includes('EService:Busy')) {
        throw new ExchangeNotAvailable(full);
      }
    }

    throw new ExchangeError(full);
  }

  // ===========================================================================
  // HELPERS — Symbol Conversion
  // ===========================================================================

  /**
   * Normalize Kraken status to unified format.
   */
  _normalizeStatus(status) {
    const map = {
      'pending': 'NEW',
      'open': 'NEW',
      'closed': 'FILLED',
      'canceled': 'CANCELED',
      'expired': 'EXPIRED',
    };
    return map[status] || (status ? status.toUpperCase() : status);
  }

  /**
   * Parse Kraken AssetPairs response into normalized markets.
   * Kraken uses weird prefix/suffix for symbols:
   *   XXBTZUSD → base=XBT, quote=USD → symbol BTC/USD
   *   XETHZEUR → base=ETH, quote=EUR → symbol ETH/EUR
   *   ADAUSD   → base=ADA, quote=USD → symbol ADA/USD
   */
  _parseMarketSymbol(pairKey, pair) {
    // Use wsname if available (cleanest: "BTC/USD", "ETH/EUR")
    if (pair.wsname) {
      return pair.wsname;
    }
    // Fallback to altname
    if (pair.altname) {
      // altname is like "BTCUSD" — we need to split it
      const base = pair.base || '';
      const quote = pair.quote || '';
      return this._cleanCurrency(base) + '/' + this._cleanCurrency(quote);
    }
    return pairKey;
  }

  /**
   * Clean Kraken currency codes (remove X/Z prefix).
   * XBT → BTC, XXBT → BTC, ZUSD → USD, XETH → ETH
   */
  _cleanCurrency(code) {
    if (!code) return code;
    // XBT → BTC
    if (code === 'XBT' || code === 'XXBT') return 'BTC';
    if (code === 'XDAO') return 'DAO';
    // Remove X/Z prefix if length > 3
    if (code.length === 4 && (code[0] === 'X' || code[0] === 'Z')) {
      return code.slice(1);
    }
    return code;
  }

  // ===========================================================================
  // GENERAL ENDPOINTS
  // ===========================================================================

  async fetchTime() {
    const data = await this._request('GET', '/0/public/Time', {}, false, 1);
    const result = this._unwrapResponse(data);
    return result.unixtime * 1000;
  }

  // ===========================================================================
  // MARKET DATA — PUBLIC (7 endpoints)
  // ===========================================================================

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/0/public/AssetPairs', {}, false, 1);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const [pairKey, pair] of Object.entries(result || {})) {
      const symbol = this._parseMarketSymbol(pairKey, pair);
      const base = this._cleanCurrency(pair.base || '');
      const quote = this._cleanCurrency(pair.quote || '');

      const market = {
        id: pairKey,
        symbol,
        base,
        quote,
        altname: pair.altname,
        wsname: pair.wsname,
        status: pair.status || 'online',
        active: (pair.status || 'online') === 'online',
        precision: {
          price: pair.pair_decimals || 5,
          amount: pair.lot_decimals || 8,
          base: pair.lot_decimals || 8,
          quote: pair.pair_decimals || 5,
        },
        limits: {
          price: { min: undefined, max: undefined },
          amount: {
            min: safeFloat(pair, 'ordermin'),
            max: undefined,
          },
          cost: {
            min: safeFloat(pair, 'costmin'),
            max: undefined,
          },
        },
        fees: {
          maker: pair.fees_maker ? pair.fees_maker[0]?.[1] / 100 : undefined,
          taker: pair.fees ? pair.fees[0]?.[1] / 100 : undefined,
        },
        info: pair,
      };

      this.markets[symbol] = market;
      this.marketsById[pairKey] = market;
      // Also index by altname for easy lookup
      if (pair.altname) this.marketsById[pair.altname] = market;
      this.symbols.push(symbol);
    }

    this._marketsLoaded = true;
    return this.markets;
  }

  /**
   * Get the Kraken pair ID from a unified symbol.
   * BTC/USD → look up in markets for the id (e.g., XXBTZUSD)
   */
  _getMarketId(symbol) {
    if (this._marketsLoaded && this.markets[symbol]) {
      return this.markets[symbol].id;
    }
    // If not loaded, pass through (user may pass raw Kraken pair)
    return symbol.replace('/', '');
  }

  async fetchTicker(symbol, params = {}) {
    const pair = this._getMarketId(symbol);
    const data = await this._request('GET', '/0/public/Ticker', { pair, ...params }, false, 1);
    const result = this._unwrapResponse(data);

    // Result is keyed by pair ID
    const keys = Object.keys(result || {});
    if (keys.length === 0) {
      throw new BadSymbol(this.id + ' symbol not found: ' + symbol);
    }
    return this._parseTicker(result[keys[0]], symbol);
  }

  async fetchTickers(symbols = undefined, params = {}) {
    let pairStr;
    if (symbols && symbols.length > 0) {
      pairStr = symbols.map((s) => this._getMarketId(s)).join(',');
    }

    const request = { ...params };
    if (pairStr) request.pair = pairStr;

    const data = await this._request('GET', '/0/public/Ticker', request, false, 1);
    const result = this._unwrapResponse(data);

    const tickers = {};
    for (const [pairKey, tickerData] of Object.entries(result || {})) {
      // Resolve symbol from marketsById
      const market = this.marketsById[pairKey];
      const sym = market ? market.symbol : pairKey;
      tickers[sym] = this._parseTicker(tickerData, sym);
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = 20, params = {}) {
    const pair = this._getMarketId(symbol);
    const request = { pair, ...params };
    if (limit) request.count = limit;

    const data = await this._request('GET', '/0/public/Depth', request, false, 1);
    const result = this._unwrapResponse(data);

    const keys = Object.keys(result || {});
    if (keys.length === 0) {
      throw new BadSymbol(this.id + ' no order book data for: ' + symbol);
    }
    const book = result[keys[0]];

    return {
      symbol,
      bids: (book.bids || []).map(([p, q, t]) => [parseFloat(p), parseFloat(q)]),
      asks: (book.asks || []).map(([p, q, t]) => [parseFloat(p), parseFloat(q)]),
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
    };
  }

  async fetchTrades(symbol, since = undefined, limit = undefined, params = {}) {
    const pair = this._getMarketId(symbol);
    const request = { pair, ...params };
    if (since) request.since = String(since);
    if (limit) request.count = limit;

    const data = await this._request('GET', '/0/public/Trades', request, false, 1);
    const result = this._unwrapResponse(data);

    // Result: { XXBTZUSD: [[price, vol, time, side, type, misc, id], ...], last: "..." }
    const keys = Object.keys(result || {}).filter((k) => k !== 'last');
    if (keys.length === 0) return [];
    const trades = result[keys[0]] || [];
    return trades.map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = undefined, params = {}) {
    const pair = this._getMarketId(symbol);
    const interval = this.timeframes[timeframe] || timeframe;
    const request = { pair, interval, ...params };
    if (since) request.since = String(Math.floor(since / 1000));

    const data = await this._request('GET', '/0/public/OHLC', request, false, 1);
    const result = this._unwrapResponse(data);

    // Result: { XXBTZUSD: [[time, open, high, low, close, vwap, volume, count], ...], last: ... }
    const keys = Object.keys(result || {}).filter((k) => k !== 'last');
    if (keys.length === 0) return [];
    const candles = result[keys[0]] || [];

    let list = candles.map((k) => ([
      k[0] * 1000,        // timestamp (kraken returns seconds)
      parseFloat(k[1]),    // open
      parseFloat(k[2]),    // high
      parseFloat(k[3]),    // low
      parseFloat(k[4]),    // close
      parseFloat(k[6]),    // volume (index 6, 5 is vwap)
    ]));

    if (limit && list.length > limit) {
      list = list.slice(-limit);
    }
    return list;
  }

  // ===========================================================================
  // TRADING — PRIVATE (7 endpoints)
  // NOTE: ALL Kraken private endpoints are POST (even queries)
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();

    const pair = this._getMarketId(symbol);
    const request = {
      pair,
      type: side.toLowerCase(),          // "buy" or "sell"
      ordertype: type.toLowerCase(),     // "market" or "limit"
      volume: String(amount),
    };

    if (price !== undefined && price !== null) {
      request.price = String(price);
    }

    if (params.clientOrderId) {
      request.userref = params.clientOrderId;
    }

    // Spread remaining params
    const skip = new Set(['clientOrderId']);
    for (const [k, v] of Object.entries(params)) {
      if (!skip.has(k) && !(k in request)) {
        request[k] = v;
      }
    }

    const data = await this._request('POST', '/0/private/AddOrder', request, true, 1);
    const result = this._unwrapResponse(data);
    return this._parseOrderCreateResult(result);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { txid: id, ...params };
    const data = await this._request('POST', '/0/private/CancelOrder', request, true, 1);
    const result = this._unwrapResponse(data);
    return {
      id,
      symbol,
      status: 'CANCELED',
      count: result.count || 0,
      info: result,
    };
  }

  async cancelAllOrders(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('POST', '/0/private/CancelAll', params, true, 1);
    const result = this._unwrapResponse(data);
    return {
      count: result.count || 0,
      info: result,
    };
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { txid: id, ...params };
    const data = await this._request('POST', '/0/private/QueryOrders', request, true, 1);
    const result = this._unwrapResponse(data);

    const keys = Object.keys(result || {});
    if (keys.length === 0) {
      throw new OrderNotFound(this.id + ' order not found: ' + id);
    }
    return this._parseOrder(result[keys[0]], keys[0]);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };

    const data = await this._request('POST', '/0/private/OpenOrders', request, true, 1);
    const result = this._unwrapResponse(data);

    const open = result.open || result;
    const orders = [];
    for (const [txid, order] of Object.entries(open || {})) {
      const parsed = this._parseOrder(order, txid);
      if (!symbol || parsed.symbol === symbol) {
        orders.push(parsed);
      }
    }
    return orders;
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (since) request.start = String(Math.floor(since / 1000));
    if (limit) request.ofs = 0;

    const data = await this._request('POST', '/0/private/ClosedOrders', request, true, 1);
    const result = this._unwrapResponse(data);

    const closed = result.closed || result;
    const orders = [];
    for (const [txid, order] of Object.entries(closed || {})) {
      const parsed = this._parseOrder(order, txid);
      if (!symbol || parsed.symbol === symbol) {
        orders.push(parsed);
      }
    }

    if (limit && orders.length > limit) {
      return orders.slice(0, limit);
    }
    return orders;
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (since) request.start = String(Math.floor(since / 1000));

    const data = await this._request('POST', '/0/private/TradesHistory', request, true, 1);
    const result = this._unwrapResponse(data);

    const trades = result.trades || result;
    const list = [];
    for (const [tradeId, trade] of Object.entries(trades || {})) {
      const parsed = this._parseMyTrade(trade, tradeId);
      if (!symbol || parsed.symbol === symbol) {
        list.push(parsed);
      }
    }

    if (limit && list.length > limit) {
      return list.slice(0, limit);
    }
    return list;
  }

  // ===========================================================================
  // ACCOUNT — PRIVATE (2 endpoints)
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('POST', '/0/private/Balance', params, true, 1);
    const result = this._unwrapResponse(data);

    const balance = {
      info: result,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    for (const [code, amount] of Object.entries(result || {})) {
      const currency = this._cleanCurrency(code);
      const total = parseFloat(amount);
      if (total > 0) {
        balance[currency] = {
          free: total,
          used: 0,
          total,
        };
      }
    }

    return balance;
  }

  async fetchTradingFees(symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) {
      request.pair = this._getMarketId(symbol);
    }

    const data = await this._request('POST', '/0/private/TradeVolume', request, true, 1);
    const result = this._unwrapResponse(data);

    const fees = {};
    const feesData = result.fees || {};
    for (const [pairKey, feeInfo] of Object.entries(feesData)) {
      const market = this.marketsById[pairKey];
      const sym = market ? market.symbol : pairKey;
      fees[sym] = {
        symbol: sym,
        maker: safeFloat(feeInfo, 'fee') ? safeFloat(feeInfo, 'fee') / 100 : undefined,
        taker: safeFloat(feeInfo, 'fee') ? safeFloat(feeInfo, 'fee') / 100 : undefined,
      };
    }

    const makerFees = result.fees_maker || {};
    for (const [pairKey, feeInfo] of Object.entries(makerFees)) {
      const market = this.marketsById[pairKey];
      const sym = market ? market.symbol : pairKey;
      if (fees[sym]) {
        fees[sym].maker = safeFloat(feeInfo, 'fee') ? safeFloat(feeInfo, 'fee') / 100 : fees[sym].maker;
      }
    }

    return symbol ? (fees[symbol] || {}) : fees;
  }

  // ===========================================================================
  // WEBSOCKET V2 — Public (4) + Private (2)
  // ===========================================================================

  _getWsClient(url = undefined) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }
    const client = new WsClient({
      url: wsUrl,
      pingInterval: 0, // Disable native ping — Kraken V2 uses app-level
    });
    this._wsClients.set(wsUrl, client);
    return client;
  }

  async _ensureWsConnected(url = undefined) {
    const wsUrl = url || this.urls.ws;
    const client = this._getWsClient(wsUrl);
    if (!client.connected) {
      await client.connect();
      this._startKrakenPing(wsUrl, client);
    }
    return client;
  }

  _startKrakenPing(wsUrl, client) {
    if (this._pingTimers.has(wsUrl)) return;
    const timer = setInterval(() => {
      if (client.connected) {
        client.send({ method: 'ping' });
      }
    }, 30000);
    this._pingTimers.set(wsUrl, timer);
  }

  async _subscribePublic(channel, params, callback) {
    const client = await this._ensureWsConnected(this.urls.ws);

    client.send({
      method: 'subscribe',
      params: { channel, ...params },
    });

    const key = JSON.stringify({ channel, ...params });

    const handler = (data) => {
      if (data && data.channel === channel) {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async _getWsToken() {
    if (this._wsToken) return this._wsToken;
    this.checkRequiredCredentials();
    const data = await this._request('POST', '/0/private/GetWebSocketsToken', {}, true, 1);
    const result = this._unwrapResponse(data);
    this._wsToken = result.token;
    return this._wsToken;
  }

  async _subscribePrivate(channel, params, callback) {
    const token = await this._getWsToken();
    const client = await this._ensureWsConnected(this.urls.wsPrivate);

    client.send({
      method: 'subscribe',
      params: { channel, token, ...params },
    });

    const key = JSON.stringify({ channel, ...params, _private: true });

    const handler = (data) => {
      if (data && data.channel === channel) {
        callback(data);
      }
    };

    client.on('message', handler);
    this._wsHandlers.set(key, { handler, callback });
    return key;
  }

  async watchTicker(symbol, callback) {
    const wsSymbol = this._getWsSymbol(symbol);
    return this._subscribePublic('ticker', { symbol: [wsSymbol] }, (msg) => {
      if (msg.data) {
        for (const t of msg.data) {
          callback(this._parseWsTicker(t, symbol));
        }
      }
    });
  }

  async watchOrderBook(symbol, callback, depth = 10) {
    const wsSymbol = this._getWsSymbol(symbol);
    return this._subscribePublic('book', { symbol: [wsSymbol], depth }, (msg) => {
      if (msg.data) {
        for (const d of msg.data) {
          callback({
            symbol,
            type: msg.type || 'snapshot',
            bids: (d.bids || []).map((b) => [parseFloat(b.price), parseFloat(b.qty)]),
            asks: (d.asks || []).map((a) => [parseFloat(a.price), parseFloat(a.qty)]),
            timestamp: Date.now(),
            nonce: undefined,
          });
        }
      }
    });
  }

  async watchTrades(symbol, callback) {
    const wsSymbol = this._getWsSymbol(symbol);
    return this._subscribePublic('trade', { symbol: [wsSymbol] }, (msg) => {
      if (msg.data) {
        for (const t of msg.data) {
          const ts = t.timestamp ? new Date(t.timestamp).getTime() : Date.now();
          callback({
            id: safeString(t, 'trade_id'),
            symbol,
            price: parseFloat(t.price),
            amount: parseFloat(t.qty),
            cost: parseFloat(t.price) * parseFloat(t.qty),
            side: t.side,
            timestamp: ts,
            datetime: iso8601(ts),
          });
        }
      }
    });
  }

  async watchKlines(symbol, interval, callback) {
    const wsSymbol = this._getWsSymbol(symbol);
    const krakenInterval = this.timeframes[interval] || interval;
    return this._subscribePublic('ohlc', { symbol: [wsSymbol], interval: krakenInterval }, (msg) => {
      if (msg.data) {
        for (const k of msg.data) {
          const ts = k.timestamp ? new Date(k.timestamp).getTime() : Date.now();
          callback({
            symbol,
            interval: krakenInterval,
            timestamp: ts,
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
            volume: parseFloat(k.volume),
            closed: false,
          });
        }
      }
    });
  }

  async watchBalance(callback) {
    this.checkRequiredCredentials();
    return this._subscribePrivate('balances', {}, (msg) => {
      if (msg.data) {
        const balances = {};
        for (const d of msg.data) {
          const currency = d.asset || d.currency;
          balances[currency] = {
            free: parseFloat(d.balance || '0'),
            used: parseFloat(d.hold_trade || '0'),
            total: parseFloat(d.balance || '0'),
          };
        }
        callback({
          event: 'balance',
          timestamp: Date.now(),
          balances,
        });
      }
    });
  }

  async watchOrders(callback) {
    this.checkRequiredCredentials();
    return this._subscribePrivate('executions', { snap_orders: true }, (msg) => {
      if (msg.data) {
        for (const o of msg.data) {
          callback(this._parseWsOrder(o));
        }
      }
    });
  }

  /**
   * Get WebSocket symbol format.
   * Kraken WS V2 uses "BTC/USD" format (wsname from markets).
   */
  _getWsSymbol(symbol) {
    if (this._marketsLoaded && this.markets[symbol] && this.markets[symbol].wsname) {
      return this.markets[symbol].wsname;
    }
    // Already in correct format if it has a /
    return symbol;
  }

  async closeAllWs() {
    for (const [, client] of this._wsClients) {
      await client.close();
    }
    this._wsClients.clear();
    this._wsHandlers.clear();
    this._wsPrivateAuthenticated = false;
    this._wsToken = null;
    for (const [, timer] of this._pingTimers) {
      clearInterval(timer);
    }
    this._pingTimers.clear();
  }

  // ===========================================================================
  // PARSERS — Normalize Kraken responses to unified format
  // ===========================================================================

  /**
   * Parse REST ticker. Kraken ticker format:
   * { a: [ask, wholeLotVol, lotVol], b: [bid, wholeLotVol, lotVol],
   *   c: [last, lotVol], v: [today, last24h], p: [vwap_today, vwap_24h],
   *   t: [trades_today, trades_24h], l: [low_today, low_24h],
   *   h: [high_today, high_24h], o: today_open }
   */
  _parseTicker(data, symbol) {
    const last = parseFloat(data.c?.[0]) || undefined;
    const open = parseFloat(data.o) || undefined;
    const change = (last && open) ? last - open : undefined;
    const percentage = (change && open) ? (change / open) * 100 : undefined;

    return {
      symbol,
      last,
      high: parseFloat(data.h?.[1]) || undefined,
      low: parseFloat(data.l?.[1]) || undefined,
      open,
      close: last,
      bid: parseFloat(data.b?.[0]) || undefined,
      bidVolume: undefined,
      ask: parseFloat(data.a?.[0]) || undefined,
      askVolume: undefined,
      volume: parseFloat(data.v?.[1]) || undefined,
      quoteVolume: undefined,
      change,
      percentage,
      vwap: parseFloat(data.p?.[1]) || undefined,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  /**
   * Parse WS V2 ticker (different format from REST).
   */
  _parseWsTicker(data, symbol) {
    const last = safeFloat(data, 'last');
    const open = safeFloat(data, 'open');
    const change = (last && open) ? last - open : undefined;
    const percentage = (change && open) ? (change / open) * 100 : undefined;

    return {
      symbol: symbol || data.symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open,
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: safeFloat(data, 'bid_qty'),
      ask: safeFloat(data, 'ask'),
      askVolume: safeFloat(data, 'ask_qty'),
      volume: safeFloat(data, 'volume'),
      quoteVolume: undefined,
      change,
      percentage,
      vwap: safeFloat(data, 'vwap'),
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: data,
    };
  }

  /**
   * Parse REST order. Kraken order format:
   * { refid, userref, status, opentm, closetm, starttm, expiretm,
   *   descr: { pair, type, ordertype, price, price2, leverage, order, close },
   *   vol, vol_exec, cost, fee, price, stopprice, limitprice, misc, oflags }
   */
  _parseOrder(data, txid) {
    const descr = data.descr || {};
    const vol = parseFloat(data.vol || '0');
    const volExec = parseFloat(data.vol_exec || '0');
    const cost = parseFloat(data.cost || '0');
    const fee = parseFloat(data.fee || '0');
    const avgPrice = volExec > 0 ? cost / volExec : 0;
    const rawStatus = data.status;

    // Resolve symbol from descr.pair
    let symbol = descr.pair || undefined;
    if (symbol && this.marketsById[symbol]) {
      symbol = this.marketsById[symbol].symbol;
    }

    const ts = data.opentm ? Math.floor(parseFloat(data.opentm) * 1000) : undefined;

    return {
      id: txid || safeString(data, 'txid'),
      clientOrderId: safeString(data, 'userref'),
      symbol,
      type: (descr.ordertype || '').toUpperCase(),
      side: (descr.type || '').toUpperCase(),
      price: parseFloat(descr.price || '0') || 0,
      amount: vol,
      filled: volExec,
      remaining: vol - volExec,
      cost,
      average: avgPrice,
      status: this._normalizeStatus(rawStatus),
      timeInForce: undefined,
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      trades: [],
      fee: {
        cost: fee,
        currency: undefined,
      },
      info: data,
    };
  }

  /**
   * Parse WS V2 order (executions channel).
   */
  _parseWsOrder(data) {
    const vol = parseFloat(data.order_qty || '0');
    const filled = parseFloat(data.cum_qty || data.filled_qty || '0');
    const cost = parseFloat(data.cum_cost || '0');
    const avgPrice = filled > 0 ? cost / filled : 0;
    const ts = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();

    return {
      id: safeString(data, 'order_id'),
      clientOrderId: safeString(data, 'cl_ord_id') || safeString(data, 'userref'),
      symbol: safeString(data, 'symbol'),
      type: safeStringUpper(data, 'order_type'),
      side: safeStringUpper(data, 'side'),
      price: safeFloat(data, 'limit_price') || 0,
      amount: vol,
      filled,
      remaining: vol - filled,
      cost,
      average: avgPrice,
      status: data.exec_type === 'filled' ? 'FILLED'
        : data.exec_type === 'canceled' ? 'CANCELED'
        : data.exec_type === 'new' ? 'NEW'
        : data.exec_type === 'partial' ? 'PARTIALLY_FILLED'
        : data.exec_type === 'expired' ? 'EXPIRED'
        : safeStringUpper(data, 'exec_type'),
      event: 'order',
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  /**
   * Parse AddOrder result. Result format:
   * { descr: { order: "..." }, txid: ["TXID1"] }
   */
  _parseOrderCreateResult(data) {
    const txids = data.txid || [];
    return {
      id: txids[0] || undefined,
      clientOrderId: undefined,
      description: data.descr?.order || undefined,
      symbol: undefined,
      status: 'NEW',
      info: data,
    };
  }

  /**
   * Parse public trade. Kraken trade format:
   * [price, volume, time, side("b"/"s"), type("l"/"m"), misc, tradeId]
   */
  _parseTrade(data, symbol) {
    const ts = Math.floor(parseFloat(data[2]) * 1000);
    return {
      id: safeString(data, 6),
      symbol,
      price: parseFloat(data[0]),
      amount: parseFloat(data[1]),
      cost: parseFloat(data[0]) * parseFloat(data[1]),
      side: data[3] === 'b' ? 'buy' : 'sell',
      type: data[4] === 'l' ? 'limit' : 'market',
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  /**
   * Parse private trade (TradesHistory). Kraken format:
   * { ordertxid, pair, time, type, ordertype, price, cost, fee, vol, misc, ... }
   */
  _parseMyTrade(data, tradeId) {
    const ts = data.time ? Math.floor(parseFloat(data.time) * 1000) : undefined;
    let symbol = data.pair;
    if (symbol && this.marketsById[symbol]) {
      symbol = this.marketsById[symbol].symbol;
    }

    return {
      id: tradeId,
      orderId: safeString(data, 'ordertxid'),
      symbol,
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'vol'),
      cost: safeFloat(data, 'cost'),
      fee: {
        cost: safeFloat(data, 'fee'),
        currency: undefined,
      },
      timestamp: ts,
      datetime: ts ? iso8601(ts) : undefined,
      side: safeStringLower(data, 'type'),
      type: safeStringLower(data, 'ordertype'),
      isMaker: safeString(data, 'maker') === 'true',
      info: data,
    };
  }
}

module.exports = Kraken;

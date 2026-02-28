'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const zlib = require('zlib');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeFloat2, safeString2,
  buildQueryRaw, iso8601,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class Bitrue extends BaseExchange {
  describe() {
    return {
      id: 'bitrue',
      name: 'Bitrue',
      version: 'v1',
      rateLimit: 50,
      rateLimitCapacity: 1200,
      rateLimitInterval: 60000,
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
        cancelAllOrders: false,
        fetchOrder: true,
        fetchOpenOrders: true,
        fetchClosedOrders: true,
        fetchMyTrades: true,
        fetchBalance: true,
        fetchTradingFees: false,
        // WebSocket
        watchTicker: true,
        watchOrderBook: true,
        watchTrades: true,
        watchKlines: true,
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://openapi.bitrue.com',
        ws: 'wss://ws.bitrue.com/kline-api/ws',
        doc: 'https://github.com/Bitrue/bitrue-official-api-docs',
      },
      timeframes: {
        '1m': '1min',
        '5m': '5min',
        '15m': '15min',
        '30m': '30min',
        '1h': '60min',
        '1d': '1day',
        '1w': '1week',
        '1M': '1month',
      },
      fees: {
        trading: { maker: 0.001, taker: 0.001 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.postAsJson = true;
    this._recvWindow = (this.options && this.options.recvWindow) || 5000;
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ===========================================================================
  // Authentication — HMAC-SHA256 (Binance-style)
  // ===========================================================================

  _sign(path, method, params) {
    this.checkRequiredCredentials();
    const timestamp = Date.now();

    params.timestamp = timestamp;
    params.recvWindow = this._recvWindow;

    // Build query string for signing (same as Binance — raw, no encoding)
    const queryString = buildQueryRaw(params);
    const signature = hmacSHA256(queryString, this.secret);

    const headers = { 'X-MBX-APIKEY': this.apiKey };

    if (method === 'GET' || method === 'DELETE') {
      // Signature goes into params → BaseExchange appends all as query string
      params.signature = signature;
      return { params, headers };
    }

    // POST: signature in URL query, params stay for JSON body
    const baseUrl = this._getBaseUrl();
    const url = baseUrl + path + '?signature=' + signature;
    return { params, headers, url };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  _handleResponseHeaders(headers) {
    const used = headers.get('x-mbx-used-weight-1m');
    if (used) {
      this._weightUsed = parseInt(used, 10);
      if (this.enableRateLimit && this._throttler) {
        this._throttler.updateFromHeader(this._weightUsed);
      }
    }
  }

  // ===========================================================================
  // Symbol Helpers
  // ===========================================================================

  _toBitrueSymbol(symbol) {
    return symbol.replace('/', '');
  }

  _fromBitrueSymbol(bitrueSymbol) {
    if (this.marketsById && this.marketsById[bitrueSymbol]) {
      return this.marketsById[bitrueSymbol].symbol;
    }
    return bitrueSymbol;
  }

  // ===========================================================================
  // Order Status Mapping
  // ===========================================================================

  _normalizeOrderStatus(status) {
    const map = {
      'NEW': 'open',
      'PARTIALLY_FILLED': 'open',
      'FILLED': 'closed',
      'CANCELED': 'canceled',
      'PENDING_CANCEL': 'canceling',
      'REJECTED': 'rejected',
      'EXPIRED': 'expired',
    };
    return map[status] || 'open';
  }

  // ===========================================================================
  // Response Handling
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && data.code !== undefined && data.code < 0) {
      const code = data.code;
      const msg = data.msg || 'Unknown error';
      this._handleBitrueError(code, msg);
    }
    return data;
  }

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  _handleBitrueError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const errorMap = {
      '-1000': ExchangeError,
      '-1001': ExchangeNotAvailable,
      '-1002': AuthenticationError,
      '-1003': RateLimitExceeded,
      '-1004': ExchangeError,
      '-1005': ExchangeError,
      '-1013': InvalidOrder,
      '-1014': InvalidOrder,
      '-1015': AuthenticationError,
      '-1020': InvalidOrder,
      '-1021': AuthenticationError,
      '-1022': AuthenticationError,
      '-1100': BadRequest,
      '-1101': BadRequest,
      '-1121': BadSymbol,
      '-1128': AuthenticationError,
      '-2010': InvalidOrder,
      '-2011': OrderNotFound,
      '-2013': OrderNotFound,
      '-2015': InsufficientFunds,
    };
    const ErrorClass = errorMap[String(code)] || ExchangeError;
    throw new ErrorClass(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const code = parsed ? parsed.code : undefined;
    const msg = parsed ? (parsed.msg || body) : body;

    if (code !== undefined && code < 0) {
      this._handleBitrueError(code, msg);
    }

    const full = this.id + ' HTTP ' + statusCode + ': ' + msg;

    if (statusCode === 400) throw new BadRequest(full);
    if (statusCode === 401 || statusCode === 403) throw new AuthenticationError(full);
    if (statusCode === 404) throw new ExchangeError(full);
    if (statusCode === 429 || statusCode === 418) throw new RateLimitExceeded(full);
    if (statusCode >= 500) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  // ===========================================================================
  // Parsers
  // ===========================================================================

  _parseTicker(data, symbol) {
    const sym = symbol || this._fromBitrueSymbol(safeString(data, 'symbol'));
    return {
      symbol: sym,
      last: safeFloat(data, 'lastPrice'),
      high: safeFloat(data, 'highPrice'),
      low: safeFloat(data, 'lowPrice'),
      open: safeFloat(data, 'openPrice'),
      close: safeFloat(data, 'lastPrice'),
      bid: safeFloat(data, 'bidPrice'),
      bidVolume: safeFloat(data, 'bidQty'),
      ask: safeFloat(data, 'askPrice'),
      askVolume: safeFloat(data, 'askQty'),
      volume: safeFloat(data, 'volume'),
      quoteVolume: safeFloat2(data, 'quoteVolume', 'quoteAssetVolume'),
      change: safeFloat(data, 'priceChange'),
      percentage: safeFloat(data, 'priceChangePercent'),
      timestamp: safeInteger(data, 'closeTime'),
      datetime: iso8601(safeInteger(data, 'closeTime')),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const filled = safeFloat(data, 'executedQty') || 0;
    const amount = safeFloat(data, 'origQty') || safeFloat(data, 'quantity') || 0;
    const price = safeFloat(data, 'price') || 0;
    const rawSymbol = safeString(data, 'symbol');
    const sym = fallbackSymbol || (rawSymbol ? this._fromBitrueSymbol(rawSymbol) : undefined);

    return {
      id: safeString(data, 'orderId') || safeString(data, 'orderIdStr'),
      clientOrderId: safeString(data, 'clientOrderId'),
      symbol: sym,
      type: safeStringUpper(data, 'type'),
      side: safeStringUpper(data, 'side'),
      price,
      amount,
      filled,
      remaining: amount - filled,
      cost: filled * (safeFloat(data, 'avgPrice') || price),
      average: safeFloat(data, 'avgPrice'),
      status: this._normalizeOrderStatus(safeString(data, 'status')),
      timestamp: safeInteger(data, 'time') || safeInteger(data, 'transactTime') || safeInteger(data, 'updateTime'),
      datetime: iso8601(safeInteger(data, 'time') || safeInteger(data, 'transactTime') || safeInteger(data, 'updateTime')),
      info: data,
    };
  }

  _parseTrade(data, symbol) {
    const p = safeFloat(data, 'price') || 0;
    const q = safeFloat(data, 'qty') || safeFloat(data, 'quantity') || 0;
    return {
      id: safeString(data, 'id') || safeString(data, 'tradeId'),
      symbol: symbol || this._fromBitrueSymbol(safeString(data, 'symbol')),
      price: p,
      amount: q,
      cost: p * q,
      side: safeValue(data, 'isBuyerMaker') === true ? 'sell' : 'buy',
      timestamp: safeInteger(data, 'time'),
      datetime: iso8601(safeInteger(data, 'time')),
      fee: {
        cost: safeFloat(data, 'commission'),
        currency: safeString(data, 'commissionAsset'),
      },
      info: data,
    };
  }

  _parseCandle(k) {
    // Bitrue returns Binance-format kline arrays
    // [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, count, ...]
    if (Array.isArray(k)) {
      return {
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      };
    }
    return {
      timestamp: safeInteger(k, 'openTime') || safeInteger(k, 'id'),
      open: safeFloat(k, 'open'),
      high: safeFloat(k, 'high'),
      low: safeFloat(k, 'low'),
      close: safeFloat(k, 'close'),
      volume: safeFloat(k, 'volume') || safeFloat(k, 'vol'),
    };
  }

  _parseOrderBook(data, symbol) {
    return {
      symbol,
      bids: (data.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: (data.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: data.lastUpdateId,
      info: data,
    };
  }

  // ===========================================================================
  // Public API — Market Data
  // ===========================================================================

  async fetchTime() {
    const data = await this._request('GET', '/api/v1/time', {}, false, 1);
    return data.serverTime;
  }

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v1/exchangeInfo', {}, false, 1);
    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const s of (data.symbols || [])) {
      const id = s.symbol;
      const base = s.baseAsset;
      const quote = s.quoteAsset;
      const symbol = base + '/' + quote;
      const status = s.status;

      const filters = {};
      for (const f of (s.filters || [])) {
        filters[f.filterType] = f;
      }

      const market = {
        id,
        symbol,
        base,
        quote,
        status,
        active: status === 'TRADING',
        precision: {
          base: s.baseAssetPrecision,
          quote: s.quotePrecision || s.quoteAssetPrecision,
          price: s.quotePrecision || s.quoteAssetPrecision,
          amount: s.baseAssetPrecision,
        },
        limits: {
          price: {
            min: safeFloat(filters.PRICE_FILTER || {}, 'minPrice'),
            max: safeFloat(filters.PRICE_FILTER || {}, 'maxPrice'),
          },
          amount: {
            min: safeFloat(filters.LOT_SIZE || {}, 'minQty'),
            max: safeFloat(filters.LOT_SIZE || {}, 'maxQty'),
          },
          cost: {
            min: safeFloat(filters.NOTIONAL || filters.MIN_NOTIONAL || {}, 'minNotional'),
          },
        },
        stepSize: safeFloat(filters.LOT_SIZE || {}, 'stepSize'),
        tickSize: safeFloat(filters.PRICE_FILTER || {}, 'tickSize'),
        orderTypes: s.orderTypes || [],
        filters,
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
    const params = { symbol: this._toBitrueSymbol(symbol) };
    const data = await this._request('GET', '/api/v1/ticker/24hr', params, false, 1);
    this._unwrapResponse(data);
    return this._parseTicker(data, symbol);
  }

  async fetchTickers(symbols = undefined) {
    const data = await this._request('GET', '/api/v1/ticker/24hr', {}, false, 40);
    const tickers = Array.isArray(data) ? data : [data];
    const result = {};
    for (const raw of tickers) {
      const rawSymbol = safeString(raw, 'symbol');
      const sym = this._fromBitrueSymbol(rawSymbol);
      if (!symbols || symbols.includes(sym)) {
        result[sym] = this._parseTicker(raw, sym);
      }
    }
    return result;
  }

  async fetchOrderBook(symbol, limit = 100) {
    const params = { symbol: this._toBitrueSymbol(symbol), limit };
    const data = await this._request('GET', '/api/v1/depth', params, false, limit <= 100 ? 1 : 10);
    this._unwrapResponse(data);
    return this._parseOrderBook(data, symbol);
  }

  async fetchTrades(symbol, since = undefined, limit = 500) {
    const params = { symbol: this._toBitrueSymbol(symbol), limit };
    const data = await this._request('GET', '/api/v1/trades', params, false, 1);
    return (Array.isArray(data) ? data : []).map(t => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1m', since = undefined, limit = 500, params = {}) {
    const interval = this.timeframes[timeframe];
    if (!interval) throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);

    const request = {
      symbol: this._toBitrueSymbol(symbol),
      interval: timeframe,
      limit,
      ...params,
    };
    if (since) request.startTime = since;

    const data = await this._request('GET', '/api/v1/klines', request, false, 1);
    return (Array.isArray(data) ? data : []).map(k => this._parseCandle(k));
  }

  // ===========================================================================
  // Private API — Trading
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = {
      symbol: this._toBitrueSymbol(symbol),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: String(amount),
      ...params,
    };

    if (price !== undefined && price !== null) {
      request.price = String(price);
    }

    // Bitrue uses GTT (not GTC) as timeInForce
    if (request.type === 'LIMIT' && !request.timeInForce) {
      request.timeInForce = 'GTT';
    }

    const data = await this._request('POST', '/api/v1/order', request, true, 1);
    this._unwrapResponse(data);
    return this._parseOrder(data, symbol);
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder requires symbol');
    const request = {
      symbol: this._toBitrueSymbol(symbol),
      orderId: id,
      ...params,
    };
    const data = await this._request('DELETE', '/api/v1/order', request, true, 1);
    this._unwrapResponse(data);
    return this._parseOrder(data, symbol);
  }

  // ===========================================================================
  // Private API — Account
  // ===========================================================================

  async fetchBalance(params = {}) {
    this.checkRequiredCredentials();
    const data = await this._request('GET', '/api/v1/account', { ...params }, true, 5);
    this._unwrapResponse(data);

    const result = { info: data, timestamp: Date.now(), datetime: iso8601(Date.now()) };
    for (const b of (data.balances || [])) {
      const free = parseFloat(b.free) || 0;
      const locked = parseFloat(b.locked) || 0;
      if (free > 0 || locked > 0) {
        result[b.asset] = { free, used: locked, total: free + locked };
      }
    }
    return result;
  }

  async fetchOrder(id, symbol = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchOrder requires symbol');
    const request = {
      symbol: this._toBitrueSymbol(symbol),
      orderId: id,
      ...params,
    };
    const data = await this._request('GET', '/api/v1/order', request, true, 1);
    this._unwrapResponse(data);
    return this._parseOrder(data, symbol);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    const request = { ...params };
    if (symbol) request.symbol = this._toBitrueSymbol(symbol);
    if (limit) request.limit = limit;

    const data = await this._request('GET', '/api/v1/openOrders', request, true, 1);
    const orders = Array.isArray(data) ? data : (data && data.orders ? data.orders : []);
    return orders.map(o => this._parseOrder(o, symbol));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchClosedOrders requires symbol');
    const request = {
      symbol: this._toBitrueSymbol(symbol),
      ...params,
    };
    if (limit) request.limit = limit;
    if (since) request.startTime = since;

    const data = await this._request('GET', '/api/v1/allOrders', request, true, 5);
    const orders = Array.isArray(data) ? data : [];
    return orders.map(o => this._parseOrder(o, symbol));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined, params = {}) {
    this.checkRequiredCredentials();
    if (!symbol) throw new BadRequest(this.id + ' fetchMyTrades requires symbol');
    const request = {
      symbol: this._toBitrueSymbol(symbol),
      ...params,
    };
    if (limit) request.limit = limit;
    if (since) request.startTime = since;

    const data = await this._request('GET', '/api/v1/myTrades', request, true, 5);
    const trades = Array.isArray(data) ? data : [];
    return trades.map(t => this._parseTrade(t, symbol));
  }

  // ===========================================================================
  // WebSocket — gzip/zlib compressed, Huobi-style subscribe
  // ===========================================================================

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 20000 });

    // Override connect to add zlib decompression
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);

      // Replace message handler with zlib decompression
      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          this._resetPondTimer && this._resetPondTimer();

          // Decompress with zlib.unzip (Bitrue uses gzip compression)
          zlib.unzip(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }, (err, buffer) => {
            if (err) {
              // Fallback: try plain text parse
              try {
                const data = JSON.parse(raw.toString());
                if (data.ping !== undefined) {
                  this.send({ pong: data.ping });
                  return;
                }
                this.emit('message', data);
              } catch (e) {
                this.emit('error', e);
              }
              return;
            }
            try {
              const data = JSON.parse(buffer.toString());

              // Handle JSON ping: {"ping": timestamp}
              if (data.ping !== undefined) {
                this.send({ pong: data.ping });
                return;
              }

              this.emit('message', data);
            } catch (e) {
              this.emit('error', e);
            }
          });
        });
      }
    };

    // Override _startPing — send JSON {"ping": ts}
    client._startPing = function () {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) {
          this.send({ ping: Date.now() });
        }
      }, this.pingInterval);
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

  async _subscribeBitrue(channel, cbId, callback) {
    const client = await this._ensureWsConnected();

    const subMsg = {
      event: 'sub',
      params: { channel, cb_id: cbId },
    };
    client.send(subMsg);

    const handler = (data) => {
      if (data && data.channel === channel) {
        callback(data);
      }
    };
    client.on('message', handler);
    this._wsHandlers.set(channel, { handler, callback });
    return channel;
  }

  // WS parsers

  _parseWsTicker(tick, symbol) {
    return {
      symbol,
      last: safeFloat(tick, 'close'),
      high: safeFloat(tick, 'high'),
      low: safeFloat(tick, 'low'),
      open: safeFloat(tick, 'open'),
      close: safeFloat(tick, 'close'),
      bid: safeFloat(tick, 'bid') || undefined,
      ask: safeFloat(tick, 'ask') || undefined,
      volume: safeFloat(tick, 'vol'),
      quoteVolume: safeFloat(tick, 'amount'),
      change: safeFloat(tick, 'change'),
      percentage: safeFloat(tick, 'rose'),
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: tick,
    };
  }

  _parseWsOrderBook(tick, symbol) {
    // CRITICAL: Bitrue uses "buys" not "bids"
    const bids = (tick.buys || []).map(entry => [parseFloat(entry[0]), parseFloat(entry[1])]);
    const asks = (tick.asks || []).map(entry => [parseFloat(entry[0]), parseFloat(entry[1])]);

    return {
      symbol,
      bids,
      asks,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      nonce: undefined,
      info: tick,
    };
  }

  _parseWsTrade(data, symbol) {
    return {
      id: safeString(data, 'id'),
      symbol,
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'amount') || safeFloat(data, 'vol'),
      side: safeString(data, 'side'),
      timestamp: safeInteger(data, 'ts'),
      datetime: iso8601(safeInteger(data, 'ts')),
      info: data,
    };
  }

  _parseWsKline(tick, symbol) {
    return {
      symbol,
      timestamp: safeInteger(tick, 'id') || safeInteger(tick, 'ts'),
      open: safeFloat(tick, 'open'),
      high: safeFloat(tick, 'high'),
      low: safeFloat(tick, 'low'),
      close: safeFloat(tick, 'close'),
      volume: safeFloat(tick, 'vol'),
      info: tick,
    };
  }

  // WS watch methods

  async watchTicker(symbol, callback) {
    const sym = this._toBitrueSymbol(symbol).toLowerCase();
    const channel = `market_${sym}_ticker`;
    return this._subscribeBitrue(channel, sym, (data) => {
      if (data.tick) {
        callback(this._parseWsTicker(data.tick, symbol));
      }
    });
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    const sym = this._toBitrueSymbol(symbol).toLowerCase();
    const channel = `market_${sym}_depth_step0`;
    return this._subscribeBitrue(channel, sym, (data) => {
      if (data.tick) {
        callback(this._parseWsOrderBook(data.tick, symbol));
      }
    });
  }

  async watchTrades(symbol, callback) {
    const sym = this._toBitrueSymbol(symbol).toLowerCase();
    const channel = `market_${sym}_trade_ticker`;
    return this._subscribeBitrue(channel, sym, (data) => {
      if (data.tick && data.tick.data) {
        const trades = data.tick.data.map(t => this._parseWsTrade(t, symbol));
        callback(trades);
      }
    });
  }

  async watchKlines(symbol, timeframe, callback) {
    const sym = this._toBitrueSymbol(symbol).toLowerCase();
    const period = this.timeframes[timeframe];
    if (!period) throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);
    const channel = `market_${sym}_kline_${period}`;
    return this._subscribeBitrue(channel, sym, (data) => {
      if (data.tick) {
        callback(this._parseWsKline(data.tick, symbol));
      }
    });
  }

  async closeAllWs() {
    for (const [, client] of this._wsClients) {
      await client.close();
    }
    this._wsClients.clear();
    this._wsHandlers.clear();
  }
}

module.exports = Bitrue;

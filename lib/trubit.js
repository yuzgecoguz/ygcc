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

class Trubit extends BaseExchange {
  describe() {
    return {
      id: 'trubit',
      name: 'Trubit',
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
        api: 'https://api-spot.trubit.com',
        ws: 'wss://ws.trubit.com/openapi/quote/ws/v1',
        doc: 'https://docs-api.trubit.com/trubit-pro/spot/rest-api',
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
    // Trubit: params go as query string (same as JBEX)
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ---------------------------------------------------------------------------
  // Authentication — HMAC-SHA256, Binance-compatible (identical to JBEX)
  // ---------------------------------------------------------------------------

  /**
   * Trubit uses Binance-compatible signing (same as JBEX):
   *   signature = hmacSHA256(queryString, secret)
   * Header: X-BH-APIKEY
   * Signature appended as query param.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = String(Date.now());
    params.timestamp = timestamp;

    const sortedKeys = Object.keys(params).sort();
    const sortedParams = {};
    for (const k of sortedKeys) {
      sortedParams[k] = params[k];
    }

    const queryString = new URLSearchParams(sortedParams).toString();
    const signature = hmacSHA256(queryString, this.secret);
    params.signature = signature;

    return {
      params,
      headers: {
        'X-BH-APIKEY': this.apiKey,
      },
    };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — BTCUSDT <-> BTC/USDT (concatenated)
  // ---------------------------------------------------------------------------

  _toTrubitSymbol(symbol) {
    // 'BTC/USDT' -> 'BTCUSDT'
    return symbol.replace('/', '');
  }

  _fromTrubitSymbol(trubitSymbol) {
    // 'BTCUSDT' -> 'BTC/USDT' (via marketsById lookup)
    if (this.marketsById && this.marketsById[trubitSymbol]) {
      return this.marketsById[trubitSymbol].symbol;
    }
    const quotes = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'BUSD', 'MXN', 'EUR'];
    for (const q of quotes) {
      if (trubitSymbol.endsWith(q) && trubitSymbol.length > q.length) {
        return trubitSymbol.slice(0, -q.length) + '/' + q;
      }
    }
    return trubitSymbol;
  }

  // ---------------------------------------------------------------------------
  // Response Handling
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const code = safeString(data, 'code');
      if (code && parseInt(code, 10) < 0) {
        const msg = safeString(data, 'msg') || 'Unknown error';
        this._handleTrubitError(code, msg);
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  _handleTrubitError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const numCode = parseInt(code, 10);

    if (numCode === -1002 || numCode === -1022 || numCode === -2014 || numCode === -2015) {
      throw new AuthenticationError(full);
    }
    if (numCode === -1003 || numCode === -1015) {
      throw new RateLimitExceeded(full);
    }
    if (numCode === -1013 || numCode === -1014 || numCode === -2010 || numCode === -1112) {
      throw new InvalidOrder(full);
    }
    if (numCode === -2011 || numCode === -2013) {
      throw new OrderNotFound(full);
    }
    if (numCode === -1121) {
      throw new BadSymbol(full);
    }
    if (numCode === -1001 || numCode === -1006 || numCode === -1016) {
      throw new ExchangeNotAvailable(full);
    }
    if (numCode >= -1130 && numCode <= -1100) {
      throw new BadRequest(full);
    }
    if (numCode === -10000) {
      throw new ExchangeError(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object') {
      const code = safeString(parsed, 'code');
      if (code && parseInt(code, 10) < 0) {
        const msg = safeString(parsed, 'msg') || body;
        this._handleTrubitError(code, msg);
      }
    }

    const full = this.id + ' HTTP ' + statusCode + ': ' + body;
    if (statusCode === 400) throw new BadRequest(full);
    if (statusCode === 401) throw new AuthenticationError(full);
    if (statusCode === 403) throw new AuthenticationError(full);
    if (statusCode === 404) throw new BadRequest(full);
    if (statusCode === 418 || statusCode === 429) throw new RateLimitExceeded(full);
    if (statusCode >= 500) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  _parseTicker(data) {
    const sym = safeString(data, 'symbol');
    const symbol = sym ? this._fromTrubitSymbol(sym) : undefined;
    const last = safeFloat(data, 'lastPrice');
    const ts = safeInteger(data, 'time') || Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'highPrice'),
      low: safeFloat(data, 'lowPrice'),
      open: safeFloat(data, 'openPrice'),
      close: last,
      bid: safeFloat(data, 'bidPrice'),
      bidVolume: safeFloat(data, 'bidQty'),
      ask: safeFloat(data, 'askPrice'),
      askVolume: safeFloat(data, 'askQty'),
      volume: safeFloat(data, 'volume'),
      quoteVolume: safeFloat(data, 'quoteVolume'),
      change: safeFloat(data, 'priceChange'),
      percentage: safeFloat(data, 'priceChangePercent'),
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'orderId');
    const trubitSym = safeString(data, 'symbol');
    const symbol = trubitSym ? this._fromTrubitSymbol(trubitSym) : fallbackSymbol;
    const side = (safeString(data, 'side') || '').toLowerCase();
    const type = (safeString(data, 'type') || 'LIMIT').toLowerCase();
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'origQty') || 0;
    const filled = safeFloat(data, 'executedQty') || 0;
    const remaining = amount > 0 ? amount - filled : 0;
    const rawStatus = safeString(data, 'status') || '';
    const status = this._parseOrderStatus(rawStatus);
    const ts = safeInteger(data, 'time') || safeInteger(data, 'transactTime') || Date.now();

    return {
      id: orderId ? String(orderId) : undefined,
      clientOrderId: safeString(data, 'clientOrderId'),
      symbol,
      type,
      side,
      price,
      amount,
      filled,
      remaining,
      cost: filled * price,
      average: filled > 0 ? price : 0,
      status,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrderStatus(status) {
    const statuses = {
      'NEW': 'open',
      'PARTIALLY_FILLED': 'open',
      'FILLED': 'closed',
      'CANCELED': 'canceled',
      'PENDING_CANCEL': 'canceled',
      'REJECTED': 'rejected',
    };
    return statuses[status] || status.toLowerCase();
  }

  _parseOrderBook(data, symbol) {
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.qty)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price), parseFloat(entry.qty)];
    });

    const ts = safeInteger(data, 'time') || Date.now();

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
      const free = safeFloat(b, 'free') || 0;
      const used = safeFloat(b, 'locked') || 0;
      const total = free + used;
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

    const data = await this._request('GET', '/openapi/v1/brokerInfo', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const symbolList = result.symbols || [];

    for (const s of symbolList) {
      const id = safeString(s, 'symbol');
      const base = safeString(s, 'baseAsset');
      const quote = safeString(s, 'quoteAsset');
      if (!id || !base || !quote) continue;

      const symbol = base.toUpperCase() + '/' + quote.toUpperCase();

      const filters = s.filters || [];
      let tickSize, stepSize, minQty, maxQty, minPrice, maxPrice;
      for (const f of filters) {
        if (f.filterType === 'PRICE_FILTER') {
          minPrice = safeFloat(f, 'minPrice');
          maxPrice = safeFloat(f, 'maxPrice');
          tickSize = safeFloat(f, 'tickSize');
        }
        if (f.filterType === 'LOT_SIZE') {
          minQty = safeFloat(f, 'minQty');
          maxQty = safeFloat(f, 'maxQty');
          stepSize = safeFloat(f, 'stepSize');
        }
      }

      const market = {
        id,
        symbol,
        base: base.toUpperCase(),
        quote: quote.toUpperCase(),
        active: true,
        precision: { price: tickSize, amount: stepSize },
        limits: {
          price: { min: minPrice, max: maxPrice },
          amount: { min: minQty, max: maxQty },
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
    const trubitSymbol = this._toTrubitSymbol(symbol);
    const data = await this._request('GET', '/openapi/quote/v1/ticker/24hr', { symbol: trubitSymbol }, false, 1);
    const result = this._unwrapResponse(data);

    const tickerData = Array.isArray(result) ? result.find(t => t.symbol === trubitSymbol) : result;
    if (!tickerData) {
      throw new BadSymbol(this.id + ' fetchTicker() symbol not found: ' + symbol);
    }

    const parsed = this._parseTicker(tickerData);
    parsed.symbol = symbol;
    return parsed;
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const trubitSymbol = this._toTrubitSymbol(symbol);
    const params = { symbol: trubitSymbol };
    if (limit) params.limit = limit;

    const data = await this._request('GET', '/openapi/quote/v1/depth', params, false, 1);
    const result = this._unwrapResponse(data);

    return this._parseOrderBook(result, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined) {
    this.checkRequiredCredentials();

    const trubitSymbol = this._toTrubitSymbol(symbol);

    const params = {
      symbol: trubitSymbol,
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: String(amount),
    };

    if (type.toLowerCase() === 'limit') {
      if (price === undefined || price === null) {
        throw new InvalidOrder(this.id + ' createOrder() requires a price for limit orders');
      }
      params.price = String(price);
      params.timeInForce = 'GTC';
    }

    const data = await this._request('POST', '/openapi/v1/order', params, true, 1);
    const result = this._unwrapResponse(data);

    return this._parseOrder(result, symbol);
  }

  async cancelOrder(id, symbol = undefined) {
    this.checkRequiredCredentials();

    const params = { orderId: String(id) };
    const data = await this._request('DELETE', '/openapi/v1/order', params, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: String(id),
      symbol,
      status: 'canceled',
      info: result,
    };
  }

  async fetchBalance() {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/openapi/v1/account', {}, true, 1);
    const result = this._unwrapResponse(data);

    const balanceData = result.balances || [];
    return this._parseBalance(balanceData);
  }

  async fetchOpenOrders(symbol = undefined) {
    this.checkRequiredCredentials();

    const params = {};
    if (symbol) {
      params.symbol = this._toTrubitSymbol(symbol);
    }

    const data = await this._request('GET', '/openapi/v1/openOrders', params, true, 1);
    const result = this._unwrapResponse(data);

    const orderList = Array.isArray(result) ? result : [];
    const orders = [];
    for (const o of orderList) {
      orders.push(this._parseOrder(o, symbol));
    }

    return orders;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — Binance-compatible depth subscription (same as JBEX)
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 30000 });

    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      this.url = connectUrl || wsUrl;
      await originalConnect(this.url);

      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          const text = raw.toString();

          try {
            const parsed = JSON.parse(text);

            // Handle ping: { ping: timestamp }
            if (parsed.ping) {
              if (this._ws && this._ws.readyState === 1) {
                this._ws.send(JSON.stringify({ pong: parsed.ping }));
              }
              return;
            }

            this.emit('message', parsed);
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

  async watchOrderBook(symbol, callback, limit = undefined) {
    const trubitSymbol = this._toTrubitSymbol(symbol);
    const client = await this._ensureWsConnected();

    const subMsg = {
      symbol: trubitSymbol,
      topic: 'depth',
      event: 'sub',
      params: { binary: 'false' },
    };

    if (client._ws && client._ws.readyState === 1) {
      client._ws.send(JSON.stringify(subMsg));
    }

    const channelId = 'depth:' + trubitSymbol;
    const handler = (msg) => {
      if (msg && msg.topic === 'depth' && msg.data) {
        const msgSymbol = safeString(msg, 'symbol') || safeString(msg.data, 's');
        if (!msgSymbol || msgSymbol === trubitSymbol) {
          callback(this._parseWsOrderBook(msg.data, symbol));
        }
      }
    };
    client.on('message', handler);
    this._wsHandlers.set(channelId, { handler, callback });
    return channelId;
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const asks = (data.a || data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry[0]), parseFloat(entry[1])];
    });
    const bids = (data.b || data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry[0]), parseFloat(entry[1])];
    });

    const ts = safeInteger(data, 't') || Date.now();

    return {
      symbol,
      bids,
      asks,
      timestamp: ts,
      datetime: iso8601(ts),
      nonce: safeString(data, 'v'),
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

module.exports = Trubit;

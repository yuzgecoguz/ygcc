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
} = require('./utils/errors');

class PointPay extends BaseExchange {
  describe() {
    return {
      id: 'pointpay',
      name: 'PointPay',
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
        createMarketOrder: false,
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
        api: 'https://api.pointpay.io',
        ws: 'wss://exchange.pointpay.io/ws',
        doc: 'https://pointpay.gitbook.io/base/exchange-api-documentation',
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
  // Authentication — HMAC-SHA512, payload-based signing
  // ---------------------------------------------------------------------------

  /**
   * PointPay uses payload-based signing:
   *   body = { ...params, request: path, nonce: timestamp }
   *   payload = base64(JSON.stringify(body))
   *   signature = hmacSHA512Hex(payload, secret)
   * Headers: X-TXC-APIKEY, X-TXC-PAYLOAD, X-TXC-SIGNATURE
   * All private endpoints use POST.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const nonce = String(Date.now());
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
  // Symbol Conversion — BTC_USDT <-> BTC/USDT (underscore)
  // ---------------------------------------------------------------------------

  _toPointPaySymbol(symbol) {
    // 'BTC/USDT' -> 'BTC_USDT'
    return symbol.replace('/', '_');
  }

  _fromPointPaySymbol(ppSymbol) {
    // 'BTC_USDT' -> 'BTC/USDT'
    return ppSymbol.replace('_', '/');
  }

  // ---------------------------------------------------------------------------
  // Response Handling
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.success === false || data.error) {
        const msg = safeString(data, 'message') || safeString(data, 'error') || 'Unknown error';
        const code = safeString(data, 'code') || '0';
        this._handlePointPayError(code, msg);
      }
      if (data.result !== undefined) {
        return data.result;
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  _handlePointPayError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance') || lowerMsg.includes('not enough')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('not exist')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid market') || lowerMsg.includes('market not found') || lowerMsg.includes('symbol')) {
      throw new BadSymbol(full);
    }
    if (lowerMsg.includes('invalid order') || lowerMsg.includes('amount') || lowerMsg.includes('price too') || lowerMsg.includes('min amount')) {
      throw new InvalidOrder(full);
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many') || lowerMsg.includes('frequent')) {
      throw new RateLimitExceeded(full);
    }
    if (lowerMsg.includes('auth') || lowerMsg.includes('nonce') || lowerMsg.includes('sign') || lowerMsg.includes('key') || lowerMsg.includes('unauthorized')) {
      throw new AuthenticationError(full);
    }
    if (lowerMsg.includes('maintenance') || lowerMsg.includes('unavailable') || lowerMsg.includes('service')) {
      throw new ExchangeNotAvailable(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object') {
      if (parsed.success === false || parsed.error) {
        const msg = safeString(parsed, 'message') || safeString(parsed, 'error') || body;
        this._handlePointPayError(statusCode, msg);
      }
    }

    const full = this.id + ' HTTP ' + statusCode + ': ' + body;
    if (statusCode === 400) throw new BadRequest(full);
    if (statusCode === 401) throw new AuthenticationError(full);
    if (statusCode === 403) throw new AuthenticationError(full);
    if (statusCode === 404) throw new BadRequest(full);
    if (statusCode === 429) throw new RateLimitExceeded(full);
    if (statusCode >= 500) throw new ExchangeNotAvailable(full);
    throw new ExchangeError(full);
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  _parseTicker(data, symbol) {
    const last = safeFloat(data, 'last');
    const ts = Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: safeFloat(data, 'open'),
      close: last,
      bid: safeFloat(data, 'bid'),
      bidVolume: undefined,
      ask: safeFloat(data, 'ask'),
      askVolume: undefined,
      volume: safeFloat(data, 'volume'),
      quoteVolume: safeFloat(data, 'deal'),
      change: safeFloat(data, 'change'),
      percentage: undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'orderId') || safeString(data, 'id');
    const marketId = safeString(data, 'market');
    const symbol = marketId ? this._fromPointPaySymbol(marketId) : fallbackSymbol;
    const side = (safeString(data, 'side') || '').toLowerCase();
    const type = (safeString(data, 'type') || 'limit').toLowerCase();
    const price = safeFloat(data, 'price') || 0;
    const amount = safeFloat(data, 'amount') || 0;
    const left = safeFloat(data, 'left') || 0;
    const filled = amount > 0 ? amount - left : 0;
    const dealMoney = safeFloat(data, 'dealMoney') || 0;
    const status = left > 0 ? 'open' : 'closed';
    const ts = safeInteger(data, 'timestamp') || Date.now();

    return {
      id: orderId ? String(orderId) : undefined,
      clientOrderId: undefined,
      symbol,
      type,
      side,
      price,
      amount,
      filled,
      remaining: left,
      cost: dealMoney,
      average: filled > 0 ? dealMoney / filled : 0,
      status,
      timestamp: ts * 1000 < Date.now() * 100 ? ts * 1000 : ts,
      datetime: iso8601(ts * 1000 < Date.now() * 100 ? ts * 1000 : ts),
      info: data,
    };
  }

  _parseOrderBook(buyData, sellData, symbol) {
    const bids = (buyData || []).map(entry => {
      return [parseFloat(entry.price || entry[0]), parseFloat(entry.amount || entry.left || entry[1])];
    });
    const asks = (sellData || []).map(entry => {
      return [parseFloat(entry.price || entry[0]), parseFloat(entry.amount || entry.left || entry[1])];
    });

    const ts = Date.now();

    return {
      symbol,
      bids,
      asks,
      timestamp: ts,
      datetime: iso8601(ts),
      nonce: undefined,
      info: { buy: buyData, sell: sellData },
    };
  }

  _parseBalance(balanceData) {
    const balance = {
      info: balanceData,
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
    };

    if (balanceData && typeof balanceData === 'object' && !Array.isArray(balanceData)) {
      for (const [currency, data] of Object.entries(balanceData)) {
        const free = safeFloat(data, 'available') || 0;
        const used = safeFloat(data, 'freeze') || 0;
        const total = free + used;
        if (free > 0 || total > 0) {
          balance[currency.toUpperCase()] = { free, used, total };
        }
      }
    }

    return balance;
  }

  // ---------------------------------------------------------------------------
  // Public REST API — Market Data
  // ---------------------------------------------------------------------------

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const data = await this._request('GET', '/api/v1/public/markets', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    // result = [ { name: 'BTC_USDT', stock: 'BTC', money: 'USDT', ... } ]
    const marketList = Array.isArray(result) ? result : [];

    for (const s of marketList) {
      const id = safeString(s, 'name');
      const base = safeString(s, 'stock');
      const quote = safeString(s, 'money');
      if (!id || !base || !quote) continue;

      const symbol = base.toUpperCase() + '/' + quote.toUpperCase();

      const market = {
        id,
        symbol,
        base: base.toUpperCase(),
        quote: quote.toUpperCase(),
        active: true,
        precision: {
          price: safeInteger(s, 'moneyPrec'),
          amount: safeInteger(s, 'stockPrec'),
        },
        limits: {
          price: { min: undefined, max: undefined },
          amount: { min: safeFloat(s, 'minAmount'), max: undefined },
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
    const ppSymbol = this._toPointPaySymbol(symbol);
    const data = await this._request('GET', '/api/v1/public/ticker', { market: ppSymbol }, false, 1);
    const result = this._unwrapResponse(data);

    return this._parseTicker(result, symbol);
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const ppSymbol = this._toPointPaySymbol(symbol);
    const queryLimit = limit || 100;

    // PointPay requires separate requests for buy and sell sides
    const [buyData, sellData] = await Promise.all([
      this._request('GET', '/api/v1/public/book', { market: ppSymbol, side: 'buy', limit: queryLimit }, false, 1),
      this._request('GET', '/api/v1/public/book', { market: ppSymbol, side: 'sell', limit: queryLimit }, false, 1),
    ]);

    const buyResult = this._unwrapResponse(buyData);
    const sellResult = this._unwrapResponse(sellData);

    const buyOrders = Array.isArray(buyResult) ? buyResult : (buyResult.orders || []);
    const sellOrders = Array.isArray(sellResult) ? sellResult : (sellResult.orders || []);

    return this._parseOrderBook(buyOrders, sellOrders, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account (all use POST)
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined) {
    this.checkRequiredCredentials();

    if (type !== 'limit') {
      throw new InvalidOrder(this.id + ' createOrder() only supports limit orders');
    }
    if (price === undefined || price === null) {
      throw new InvalidOrder(this.id + ' createOrder() requires a price for limit orders');
    }

    const ppSymbol = this._toPointPaySymbol(symbol);

    const request = {
      market: ppSymbol,
      side: side.toLowerCase(),
      amount: String(amount),
      price: String(price),
    };

    const data = await this._request('POST', '/api/v1/order/new', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'orderId') || safeString(result, 'id'),
      symbol,
      type: 'limit',
      side,
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

  async cancelOrder(id, symbol = undefined) {
    this.checkRequiredCredentials();

    const request = {
      orderId: Number(id),
    };
    if (symbol) {
      request.market = this._toPointPaySymbol(symbol);
    }

    const data = await this._request('POST', '/api/v1/order/cancel', request, true, 1);
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

    const data = await this._request('POST', '/api/v1/account/balances', {}, true, 1);
    const result = this._unwrapResponse(data);

    // result = { BTC: { available: '1.5', freeze: '0.5' }, USDT: {...} }
    return this._parseBalance(result);
  }

  async fetchOpenOrders(symbol = undefined) {
    this.checkRequiredCredentials();

    const request = {};
    if (symbol) {
      request.market = this._toPointPaySymbol(symbol);
    }

    const data = await this._request('POST', '/api/v1/orders', request, true, 1);
    const result = this._unwrapResponse(data);

    const orderList = Array.isArray(result) ? result : [];
    const orders = [];
    for (const o of orderList) {
      orders.push(this._parseOrder(o, symbol));
    }

    return orders;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — method/params/id protocol
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

            // Handle server.ping: respond with server.pong
            if (parsed.method === 'server.ping') {
              if (this._ws && this._ws.readyState === 1) {
                this._ws.send(JSON.stringify({
                  method: 'server.pong',
                  params: [],
                  id: null,
                }));
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
    const ppSymbol = this._toPointPaySymbol(symbol);
    const client = await this._ensureWsConnected();

    // Subscribe: {"method":"depth.subscribe","params":["BTC_USDT",100,"0"],"id":1}
    const subMsg = {
      method: 'depth.subscribe',
      params: [ppSymbol, limit || 100, '0'],
      id: Date.now(),
    };

    if (client._ws && client._ws.readyState === 1) {
      client._ws.send(JSON.stringify(subMsg));
    }

    const channelId = 'depth:' + ppSymbol;
    const handler = (msg) => {
      // Updates: {"method":"depth.update","params":[true,{asks:[],bids:[]},market],"id":null}
      if (msg && msg.method === 'depth.update' && Array.isArray(msg.params) && msg.params.length >= 3) {
        const marketName = msg.params[2];
        if (marketName === ppSymbol) {
          const isSnapshot = msg.params[0];
          const depthData = msg.params[1];
          callback(this._parseWsOrderBook(depthData, symbol));
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

module.exports = PointPay;

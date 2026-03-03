'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256Base64 } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const zlib = require('zlib');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, iso8601,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class HotCoin extends BaseExchange {
  describe() {
    return {
      id: 'hotcoin',
      name: 'HotCoin',
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
        api: 'https://api.hotcoinfin.com',
        ws: 'wss://wss.hotcoinfin.com/trade/multiple',
        doc: 'https://hotcoinex.github.io/en/spot/introduction.html',
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
  // Authentication — Huobi-style HMAC-SHA256 → Base64, auth in query string
  // ---------------------------------------------------------------------------

  /**
   * HotCoin uses Huobi-style signing:
   *   preSign = METHOD\nhost\npath\nsortedQueryString
   *   signature = hmacSHA256Base64(preSign, secret)
   * Auth params go in query string (NOT headers).
   * Two credentials: apiKey (AccessKeyId), secret.
   */
  _sign(path, method, params) {
    this.checkRequiredCredentials();

    const timestamp = new Date().toISOString().slice(0, 23) + 'Z';

    const authParams = {
      AccessKeyId: this.apiKey,
      SignatureMethod: 'HmacSHA256',
      SignatureVersion: '2',
      Timestamp: timestamp,
    };

    // For GET: auth params + trade params all go into query string
    // For POST: auth params in query string, trade params in JSON body
    let signParams;
    if (method === 'GET') {
      signParams = { ...authParams, ...params };
    } else {
      signParams = { ...authParams };
    }

    // Sort by key alphabetically
    const sortedKeys = Object.keys(signParams).sort();
    const sortedParts = sortedKeys.map(k =>
      encodeURIComponent(k) + '=' + encodeURIComponent(signParams[k])
    );
    const sortedQuery = sortedParts.join('&');

    // Build presign string: METHOD\nhost\npath\nsortedQuery
    const preSign = method + '\n' + 'api.hotcoinfin.com' + '\n' + path + '\n' + sortedQuery;
    const signature = hmacSHA256Base64(preSign, this.secret);

    if (method === 'GET') {
      // For GET: merge everything into params (BaseExchange builds query string)
      const allParams = { ...signParams, Signature: signature };
      return { params: allParams, headers: {} };
    } else {
      // For POST: auth params + signature go into _authQuery, trade params stay in body
      const authQuery = sortedQuery + '&Signature=' + encodeURIComponent(signature);
      return { params, headers: {}, _authQuery: authQuery };
    }
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ---------------------------------------------------------------------------
  // Request Override — POST with auth in query string, params in JSON body
  // ---------------------------------------------------------------------------

  /**
   * HotCoin puts auth params in the URL query string for ALL signed requests,
   * while POST trade params go in the JSON body. BaseExchange can't do this
   * natively, so we override _request() for signed POST.
   */
  async _request(method, path, params = {}, signed = false, weight = 1) {
    if (method === 'POST' && signed) {
      if (this.enableRateLimit && this._throttler) {
        await this._throttler.consume(weight);
      }

      const signResult = this._sign(path, 'POST', { ...params });
      const baseUrl = this._getBaseUrl();
      const url = baseUrl + path + '?' + signResult._authQuery;

      const headers = { 'Content-Type': 'application/json' };
      const fetchOptions = {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(this.timeout),
      };

      if (Object.keys(signResult.params).length > 0) {
        fetchOptions.body = JSON.stringify(signResult.params);
      }

      const response = await fetch(url, fetchOptions);
      const text = await response.text();

      if (!response.ok) {
        this._handleHttpError(response.status, text);
      }

      let data;
      try { data = JSON.parse(text); } catch { data = text; }

      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const code = safeString(data, 'code') || safeString(data, 'status');
        if (code && code !== '200' && code !== '0') {
          const msg = safeString(data, 'msg') || safeString(data, 'message') || 'Unknown error';
          this._handleHotCoinError(code, msg);
        }
      }

      return data;
    }

    // For non-POST or non-signed, use BaseExchange default
    return super._request(method, path, params, signed, weight);
  }

  // ---------------------------------------------------------------------------
  // Symbol Conversion — btc_usdt <-> BTC/USDT (lowercase underscore)
  // ---------------------------------------------------------------------------

  _toHotCoinSymbol(symbol) {
    // 'BTC/USDT' -> 'btc_usdt'
    return symbol.replace('/', '_').toLowerCase();
  }

  _fromHotCoinSymbol(hotcoinSymbol) {
    // 'btc_usdt' -> 'BTC/USDT'
    const parts = hotcoinSymbol.split('_');
    if (parts.length === 2) {
      return parts[0].toUpperCase() + '/' + parts[1].toUpperCase();
    }
    return hotcoinSymbol.toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // Response Handling
  // ---------------------------------------------------------------------------

  _unwrapResponse(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const code = safeString(data, 'code') || safeString(data, 'status');
      if (code && code !== '200' && code !== '0') {
        const msg = safeString(data, 'msg') || safeString(data, 'message') || 'Unknown error';
        this._handleHotCoinError(code, msg);
      }
      if (data.data !== undefined) {
        return data.data;
      }
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  _handleHotCoinError(code, msg) {
    const full = this.id + ' ' + code + ': ' + msg;
    const lowerMsg = (msg || '').toLowerCase();

    if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance not enough')) {
      throw new InsufficientFunds(full);
    }
    if (lowerMsg.includes('order not found') || lowerMsg.includes('order does not exist')) {
      throw new OrderNotFound(full);
    }
    if (lowerMsg.includes('invalid symbol') || lowerMsg.includes('symbol not found') || lowerMsg.includes('pair')) {
      throw new BadSymbol(full);
    }
    if (lowerMsg.includes('invalid order') || lowerMsg.includes('amount') || lowerMsg.includes('price')) {
      throw new InvalidOrder(full);
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many') || lowerMsg.includes('frequent')) {
      throw new RateLimitExceeded(full);
    }
    if (lowerMsg.includes('auth') || lowerMsg.includes('permission') || lowerMsg.includes('sign') || lowerMsg.includes('key')) {
      throw new AuthenticationError(full);
    }
    if (lowerMsg.includes('maintenance') || lowerMsg.includes('unavailable')) {
      throw new ExchangeNotAvailable(full);
    }

    throw new ExchangeError(full);
  }

  _handleHttpError(statusCode, body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    if (parsed && typeof parsed === 'object') {
      const code = safeString(parsed, 'code') || safeString(parsed, 'status');
      if (code && code !== '200') {
        const msg = safeString(parsed, 'msg') || safeString(parsed, 'message') || body;
        this._handleHotCoinError(statusCode, msg);
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
    const ts = safeInteger(data, 'time') || Date.now();

    return {
      symbol,
      last,
      high: safeFloat(data, 'high'),
      low: safeFloat(data, 'low'),
      open: safeFloat(data, 'open'),
      close: last,
      bid: safeFloat(data, 'buy'),
      bidVolume: undefined,
      ask: safeFloat(data, 'sell'),
      askVolume: undefined,
      volume: safeFloat(data, 'vol'),
      quoteVolume: undefined,
      change: undefined,
      percentage: undefined,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol) {
    const orderId = safeString(data, 'id') || safeString(data, 'orderId');
    const marketId = safeString(data, 'symbol');
    const symbol = marketId ? this._fromHotCoinSymbol(marketId) : fallbackSymbol;
    const rawSide = safeString(data, 'type') || safeString(data, 'side') || '';
    const side = rawSide.toLowerCase().includes('buy') ? 'buy' : 'sell';
    const matchType = safeString(data, 'matchType') || safeString(data, 'orderType') || '0';
    const type = matchType === '1' ? 'market' : 'limit';
    const price = safeFloat(data, 'price') || safeFloat(data, 'tradePrice') || 0;
    const amount = safeFloat(data, 'amount') || safeFloat(data, 'tradeAmount') || 0;
    const leftAmount = safeFloat(data, 'leftAmount') || safeFloat(data, 'left') || 0;
    const filled = amount > 0 ? amount - leftAmount : 0;
    const rawStatus = safeString(data, 'status') || '';
    const status = this._parseOrderStatus(rawStatus);
    const ts = safeInteger(data, 'createTime') || safeInteger(data, 'time') || Date.now();

    return {
      id: orderId ? String(orderId) : undefined,
      clientOrderId: safeString(data, 'clientOrderId'),
      symbol,
      type,
      side,
      price,
      amount,
      filled,
      remaining: leftAmount,
      cost: filled * price,
      average: filled > 0 ? price : 0,
      status,
      timestamp: ts,
      datetime: iso8601(ts),
      info: data,
    };
  }

  _parseOrderStatus(status) {
    const s = String(status).toLowerCase();
    if (s === '0' || s === 'pending' || s === 'open' || s === 'new') return 'open';
    if (s === '1' || s === 'partial' || s === 'partially_filled') return 'open';
    if (s === '2' || s === 'filled' || s === 'completed') return 'closed';
    if (s === '3' || s === 'canceled' || s === 'cancelled') return 'canceled';
    if (s === '4' || s === 'expired') return 'expired';
    return s;
  }

  _parseOrderBook(data, symbol) {
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.amount || entry.a)];
    });
    const bids = (data.bids || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.amount || entry.a)];
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
      const currency = safeString(b, 'symbol') || safeString(b, 'currency');
      if (!currency) continue;
      const free = safeFloat(b, 'normal') || safeFloat(b, 'available') || 0;
      const used = safeFloat(b, 'lock') || safeFloat(b, 'frozen') || 0;
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

    const data = await this._request('GET', '/v1/common/symbols', {}, false, 5);
    const result = this._unwrapResponse(data);

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    const symbolList = Array.isArray(result) ? result : (result.list || []);

    for (const s of symbolList) {
      const baseCurrency = safeString(s, 'baseCurrency') || safeString(s, 'base_currency');
      const quoteCurrency = safeString(s, 'quoteCurrency') || safeString(s, 'quote_currency');
      const id = safeString(s, 'symbol') || (baseCurrency + '_' + quoteCurrency).toLowerCase();
      if (!baseCurrency || !quoteCurrency) continue;

      const symbol = baseCurrency.toUpperCase() + '/' + quoteCurrency.toUpperCase();

      const market = {
        id,
        symbol,
        base: baseCurrency.toUpperCase(),
        quote: quoteCurrency.toUpperCase(),
        active: true,
        precision: {
          price: safeInteger(s, 'pricePrecision') || safeInteger(s, 'price_precision'),
          amount: safeInteger(s, 'amountPrecision') || safeInteger(s, 'amount_precision'),
        },
        limits: {
          price: { min: safeFloat(s, 'minPrice'), max: safeFloat(s, 'maxPrice') },
          amount: { min: safeFloat(s, 'minAmount') || safeFloat(s, 'limitVolumeMin'), max: safeFloat(s, 'maxAmount') },
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
    const hotcoinSymbol = this._toHotCoinSymbol(symbol);
    const data = await this._request('GET', '/v1/market/ticker', { symbol: hotcoinSymbol }, false, 1);
    const result = this._unwrapResponse(data);

    const tickerData = result.ticker || result;
    return this._parseTicker(tickerData, symbol);
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const hotcoinSymbol = this._toHotCoinSymbol(symbol);
    const params = { symbol: hotcoinSymbol, step: '0' };
    if (limit) params.limit = limit;

    const data = await this._request('GET', '/v1/depth', params, false, 1);
    const result = this._unwrapResponse(data);

    return this._parseOrderBook(result, symbol);
  }

  // ---------------------------------------------------------------------------
  // Private REST API — Trading & Account
  // ---------------------------------------------------------------------------

  async createOrder(symbol, type, side, amount, price = undefined) {
    this.checkRequiredCredentials();

    const hotcoinSymbol = this._toHotCoinSymbol(symbol);

    const request = {
      symbol: hotcoinSymbol,
      type: side.toLowerCase(),
      tradeAmount: String(amount),
      tradePrice: price !== undefined && price !== null ? String(price) : '0',
      matchType: type === 'market' ? '1' : '0',
    };

    const data = await this._request('POST', '/v1/order/place', request, true, 1);
    const result = this._unwrapResponse(data);

    return {
      id: safeString(result, 'id') || safeString(result, 'orderId'),
      symbol,
      type,
      side,
      price: price !== undefined ? parseFloat(price) : 0,
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

    const request = { id: String(id) };
    const data = await this._request('POST', '/v1/order/cancel', request, true, 1);
    this._unwrapResponse(data);

    return {
      id: String(id),
      symbol,
      status: 'canceled',
      info: data,
    };
  }

  async fetchBalance() {
    this.checkRequiredCredentials();

    const data = await this._request('GET', '/v1/balance', {}, true, 1);
    const result = this._unwrapResponse(data);

    const balanceData = Array.isArray(result) ? result : (result.list || []);
    return this._parseBalance(balanceData);
  }

  async fetchOpenOrders(symbol = undefined) {
    this.checkRequiredCredentials();

    const request = { type: '0', page: '1', count: '100' };
    if (symbol) {
      request.symbol = this._toHotCoinSymbol(symbol);
    }

    const data = await this._request('GET', '/v1/order/entrust', request, true, 1);
    const result = this._unwrapResponse(data);

    const orderList = Array.isArray(result) ? result : (result.list || result.entrust || []);
    const orders = [];
    for (const o of orderList) {
      orders.push(this._parseOrder(o, symbol));
    }

    return orders;
  }

  // ---------------------------------------------------------------------------
  // WebSocket — GZIP compressed, Huobi-style sub/ping
  // ---------------------------------------------------------------------------

  _getWsClient(url) {
    const wsUrl = url || this.urls.ws;
    if (this._wsClients.has(wsUrl)) {
      return this._wsClients.get(wsUrl);
    }

    const client = new WsClient({ url: wsUrl, pingInterval: 5000 });
    const exchange = this;

    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      this.url = connectUrl || wsUrl;
      await originalConnect(this.url);

      if (this._ws) {
        this._ws.removeAllListeners('message');
        this._ws.on('message', (raw) => {
          let text;
          try {
            // HotCoin sends GZIP compressed messages
            if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
              text = zlib.gunzipSync(raw).toString('utf-8');
            } else {
              text = raw.toString();
            }
          } catch (e) {
            // Not gzipped, use raw
            text = raw.toString();
          }

          try {
            const parsed = JSON.parse(text);

            // Handle ping: server sends { ping: timestamp }, respond with { pong: timestamp }
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

  async _subscribeHotCoin(topic, hotcoinSymbol, callback) {
    const client = await this._ensureWsConnected();

    const sub = 'market.' + hotcoinSymbol + '.' + topic;
    const subMsg = { sub, id: topic + '_' + hotcoinSymbol + '_' + Date.now() };

    if (client._ws && client._ws.readyState === 1) {
      client._ws.send(JSON.stringify(subMsg));
    }

    const channelId = sub;
    const handler = (data) => {
      if (data && data.ch === sub) {
        callback(data);
      }
    };
    client.on('message', handler);
    this._wsHandlers.set(channelId, { handler, callback });
    return channelId;
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    const hotcoinSymbol = this._toHotCoinSymbol(symbol);
    return this._subscribeHotCoin('trade.depth', hotcoinSymbol, (msg) => {
      if (msg && msg.tick) {
        callback(this._parseWsOrderBook(msg.tick, symbol));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WS Parsers
  // ---------------------------------------------------------------------------

  _parseWsOrderBook(data, symbol) {
    const asks = (data.asks || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.amount || entry.a)];
    });
    const bids = (data.bids || data.buys || []).map(entry => {
      if (Array.isArray(entry)) return [parseFloat(entry[0]), parseFloat(entry[1])];
      return [parseFloat(entry.price || entry.p), parseFloat(entry.amount || entry.a)];
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

module.exports = HotCoin;

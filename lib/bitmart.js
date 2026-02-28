'use strict';

const BaseExchange = require('./BaseExchange');
const { hmacSHA256 } = require('./utils/crypto');
const WsClient = require('./utils/ws');
const zlib = require('zlib');
const {
  safeFloat, safeString, safeInteger, safeValue,
  safeStringUpper, safeStringLower, safeFloat2, safeString2,
  iso8601, parseDate,
} = require('./utils/helpers');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('./utils/errors');

class BitMart extends BaseExchange {
  describe() {
    return {
      id: 'bitmart',
      name: 'BitMart',
      version: 'v3',
      rateLimit: 50,
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
        watchBalance: false,
        watchOrders: false,
      },
      urls: {
        api: 'https://api-cloud.bitmart.com',
        ws: 'wss://ws-manager-compress.bitmart.com/api?protocol=1.1',
        doc: 'https://developer-pro.bitmart.com/',
      },
      timeframes: {
        '1m': 1,
        '5m': 5,
        '15m': 15,
        '30m': 30,
        '1h': 60,
        '4h': 240,
        '1d': 1440,
        '1w': 10080,
        '1M': 43200,
      },
      fees: {
        trading: { maker: 0.0025, taker: 0.0025 },
      },
    };
  }

  constructor(config = {}) {
    super(config);
    this.memo = config.memo || config.passphrase || '';
    this.postAsJson = true;
    this._wsClients = new Map();
    this._wsHandlers = new Map();
  }

  // ===========================================================================
  // AUTHENTICATION
  // ===========================================================================

  checkRequiredCredentials() {
    if (!this.apiKey) throw new ExchangeError(this.id + ' apiKey required');
    if (!this.secret) throw new ExchangeError(this.id + ' secret required');
    if (!this.memo) throw new ExchangeError(this.id + ' memo required');
  }

  _sign(path, method, params) {
    this.checkRequiredCredentials();
    const timestamp = Date.now().toString();

    if (method === 'GET' || method === 'DELETE') {
      // KEYED auth: only X-BM-KEY + X-BM-TIMESTAMP (no signature)
      const headers = {
        'X-BM-KEY': this.apiKey,
        'X-BM-TIMESTAMP': timestamp,
        'Content-Type': 'application/json',
      };
      return { params, headers };
    }

    // SIGNED auth: full HMAC-SHA256 signature with memo
    const body = (params && Object.keys(params).length > 0)
      ? JSON.stringify(params) : '';
    const signPayload = timestamp + '#' + this.memo + '#' + body;
    const signature = hmacSHA256(signPayload, this.secret);

    const headers = {
      'X-BM-KEY': this.apiKey,
      'X-BM-SIGN': signature,
      'X-BM-TIMESTAMP': timestamp,
      'Content-Type': 'application/json',
    };

    return { params, headers };
  }

  _getBaseUrl() {
    return this.urls.api;
  }

  // ===========================================================================
  // SYMBOL HELPERS
  // ===========================================================================

  _toBitMartSymbol(symbol) {
    // BTC/USDT → BTC_USDT
    return symbol.replace('/', '_');
  }

  _fromBitMartSymbol(bitmartSymbol) {
    // BTC_USDT → BTC/USDT
    if (this.marketsById && this.marketsById[bitmartSymbol]) {
      return this.marketsById[bitmartSymbol].symbol;
    }
    const parts = bitmartSymbol.split('_');
    if (parts.length >= 2) {
      return parts[0] + '/' + parts[1];
    }
    return bitmartSymbol;
  }

  // ===========================================================================
  // RESPONSE HANDLING
  // ===========================================================================

  _unwrapResponse(data) {
    if (data && data.code !== undefined) {
      if (data.code !== 1000) {
        this._handleBitMartError(data.code, data.message || '');
      }
      return data.data;
    }
    return data;
  }

  _handleResponseHeaders(headers) {
    if (!headers || !headers.get) return;
    const remaining = headers.get('x-bm-ratelimit-remaining');
    const limit = headers.get('x-bm-ratelimit-limit');
    if (remaining !== null && limit !== null && this._throttler) {
      const used = parseInt(limit, 10) - parseInt(remaining, 10);
      if (!isNaN(used)) {
        this._throttler.updateFromHeader(used);
      }
    }
  }

  // ===========================================================================
  // ORDER STATUS MAPPING
  // ===========================================================================

  _normalizeOrderStatus(status) {
    const statusStr = String(status);
    const map = {
      '1': 'failed',
      '2': 'open',
      '3': 'failed',
      '4': 'open',
      '5': 'open',
      '6': 'closed',
      '7': 'canceling',
      '8': 'canceled',
    };
    return map[statusStr] || 'open';
  }

  // ===========================================================================
  // PUBLIC API — MARKET DATA
  // ===========================================================================

  async fetchTime() {
    const response = await this._request('GET', '/system/time');
    const data = this._unwrapResponse(response);
    return safeInteger(data, 'server_time');
  }

  async loadMarkets(reload = false) {
    if (this._marketsLoaded && !reload) return this.markets;

    const response = await this._request('GET', '/spot/v1/symbols/details');
    const data = this._unwrapResponse(response);
    const symbols = data.symbols || [];

    this.markets = {};
    this.marketsById = {};
    this.symbols = [];

    for (const s of symbols) {
      const id = safeString(s, 'symbol');
      const base = safeString(s, 'base_currency');
      const quote = safeString(s, 'quote_currency');
      const symbol = base + '/' + quote;
      const status = safeString(s, 'trade_status');

      const market = {
        id,
        symbol,
        base,
        quote,
        active: status === 'trading',
        precision: {
          price: safeInteger(s, 'price_max_precision') || 8,
          amount: 8,
        },
        limits: {
          amount: {
            min: safeFloat(s, 'base_min_size'),
          },
          price: {
            min: safeFloat(s, 'quote_increment'),
          },
          cost: {
            min: safeFloat(s, 'min_buy_amount'),
          },
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
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const response = await this._request('GET', '/spot/quotation/v3/ticker', {
      symbol: bitmartSymbol,
    });
    const data = this._unwrapResponse(response);
    return this._parseTicker(data, symbol);
  }

  async fetchTickers(symbols = undefined) {
    const response = await this._request('GET', '/spot/quotation/v3/tickers');
    const data = this._unwrapResponse(response);
    const tickers = [];

    for (const t of data) {
      const bitmartSymbol = safeString(t, 'symbol');
      const resolvedSymbol = this._fromBitMartSymbol(bitmartSymbol);
      if (symbols && !symbols.includes(resolvedSymbol)) continue;
      tickers.push(this._parseTicker(t, resolvedSymbol));
    }
    return tickers;
  }

  async fetchOrderBook(symbol, limit = undefined) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const params = { symbol: bitmartSymbol };
    if (limit) params.limit = limit;

    const response = await this._request('GET', '/spot/quotation/v3/books', params);
    const data = this._unwrapResponse(response);
    return this._parseOrderBook(data, symbol);
  }

  async fetchTrades(symbol, since = undefined, limit = undefined) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const params = { symbol: bitmartSymbol };
    if (limit) params.limit = Math.min(limit, 50);

    const response = await this._request('GET', '/spot/quotation/v3/trades', params);
    const data = this._unwrapResponse(response);
    const trades = Array.isArray(data) ? data : [];

    return trades.map((t) => this._parseTrade(t, symbol));
  }

  async fetchOHLCV(symbol, timeframe = '1m', since = undefined, limit = undefined) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const step = this.timeframes[timeframe];
    if (!step) throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);

    const params = { symbol: bitmartSymbol, step };
    if (since) params.after = since;
    if (limit) params.limit = limit;

    const response = await this._request('GET', '/spot/quotation/v3/lite-klines', params);
    const data = this._unwrapResponse(response);
    const klines = Array.isArray(data) ? data : [];

    return klines.map((k) => this._parseCandle(k));
  }

  // ===========================================================================
  // PRIVATE API — TRADING
  // ===========================================================================

  async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const orderParams = {
      symbol: bitmartSymbol,
      side: side.toLowerCase(),
      type: type.toLowerCase(),
      size: amount.toString(),
    };

    if ((type.toLowerCase() === 'limit' || type.toLowerCase() === 'limit_maker') && price !== undefined) {
      orderParams.price = price.toString();
    }

    if (params.client_order_id) {
      orderParams.client_order_id = params.client_order_id;
    }

    const response = await this._request('POST', '/spot/v2/submit_order', orderParams, true);
    const data = this._unwrapResponse(response);

    return {
      id: safeString(data, 'order_id'),
      clientOrderId: safeString(data, 'client_order_id') || params.client_order_id,
      symbol,
      type: type.toLowerCase(),
      side: side.toLowerCase(),
      amount: parseFloat(amount),
      price: price ? parseFloat(price) : undefined,
      status: 'open',
      timestamp: Date.now(),
      datetime: iso8601(Date.now()),
      info: response,
    };
  }

  async cancelOrder(id, symbol = undefined, params = {}) {
    if (!symbol) throw new BadRequest(this.id + ' cancelOrder requires symbol');
    const bitmartSymbol = this._toBitMartSymbol(symbol);

    const cancelParams = { symbol: bitmartSymbol };
    if (params.client_order_id) {
      cancelParams.client_order_id = params.client_order_id;
    } else {
      cancelParams.order_id = id.toString();
    }

    const response = await this._request('POST', '/spot/v3/cancel_order', cancelParams, true);
    const data = this._unwrapResponse(response);

    return {
      id: id.toString(),
      symbol,
      status: 'canceled',
      info: response,
    };
  }

  async cancelAllOrders(symbol = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' cancelAllOrders requires symbol');
    const bitmartSymbol = this._toBitMartSymbol(symbol);

    const response = await this._request('POST', '/spot/v4/cancel_all', {
      symbol: bitmartSymbol,
    }, true);
    this._unwrapResponse(response);

    return { symbol, info: response };
  }

  // ===========================================================================
  // PRIVATE API — ACCOUNT
  // ===========================================================================

  async fetchBalance() {
    const response = await this._request('GET', '/spot/v1/wallet', {}, true);
    const data = this._unwrapResponse(response);
    const wallets = data.wallet || [];

    const result = { timestamp: Date.now(), info: response };

    for (const w of wallets) {
      const currency = safeString(w, 'id') || safeString(w, 'currency');
      const free = safeFloat(w, 'available') || 0;
      const frozen = safeFloat(w, 'frozen') || 0;
      result[currency] = {
        free,
        used: frozen,
        total: free + frozen,
      };
    }

    return result;
  }

  async fetchOrder(id, symbol = undefined) {
    const params = { orderId: id.toString() };
    const response = await this._request('GET', '/spot/v4/query/order', params, true);
    const data = this._unwrapResponse(response);
    return this._parseOrder(data, symbol);
  }

  async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' fetchOpenOrders requires symbol');
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const params = { symbol: bitmartSymbol };
    if (limit) params.limit = limit;

    const response = await this._request('GET', '/spot/v4/query/open-orders', params, true);
    const data = this._unwrapResponse(response);
    const orders = data.orders || [];

    return orders.map((o) => this._parseOrder(o, symbol));
  }

  async fetchClosedOrders(symbol = undefined, since = undefined, limit = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' fetchClosedOrders requires symbol');
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const params = { symbol: bitmartSymbol };
    if (limit) params.limit = limit;

    const response = await this._request('GET', '/spot/v4/query/history-orders', params, true);
    const data = this._unwrapResponse(response);
    const orders = data.orders || [];

    return orders.map((o) => this._parseOrder(o, symbol));
  }

  async fetchMyTrades(symbol = undefined, since = undefined, limit = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' fetchMyTrades requires symbol');
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const params = { symbol: bitmartSymbol };
    if (limit) params.limit = limit;

    const response = await this._request('GET', '/spot/v4/query/trades', params, true);
    const data = this._unwrapResponse(response);
    const trades = data.trades || [];

    return trades.map((t) => this._parseTrade(t, symbol));
  }

  async fetchTradingFees(symbol = undefined) {
    if (!symbol) throw new BadRequest(this.id + ' fetchTradingFees requires symbol');
    const bitmartSymbol = this._toBitMartSymbol(symbol);

    const response = await this._request('GET', '/spot/v1/trade_fee', {
      symbol: bitmartSymbol,
    }, true);
    const data = this._unwrapResponse(response);

    return {
      symbol,
      maker: safeFloat(data, 'maker_fee_rate') || safeFloat(data, 'maker'),
      taker: safeFloat(data, 'taker_fee_rate') || safeFloat(data, 'taker'),
      info: response,
    };
  }

  // ===========================================================================
  // PARSERS
  // ===========================================================================

  _parseTicker(data, symbol = undefined) {
    const bitmartSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (bitmartSymbol ? this._fromBitMartSymbol(bitmartSymbol) : undefined);
    const timestamp = safeInteger(data, 'ts') || Date.now();

    const last = safeFloat(data, 'last');
    const open = safeFloat(data, 'open_24h') || safeFloat(data, 'open');
    const high = safeFloat(data, 'high_24h') || safeFloat(data, 'high');
    const low = safeFloat(data, 'low_24h') || safeFloat(data, 'low');
    const change = (last !== undefined && open !== undefined) ? last - open : undefined;
    const percentage = (change !== undefined && open) ? (change / open) * 100 : undefined;

    return {
      symbol: resolvedSymbol,
      timestamp,
      datetime: iso8601(timestamp),
      high,
      low,
      bid: safeFloat(data, 'best_bid') || safeFloat(data, 'bid_px'),
      bidVolume: safeFloat(data, 'best_bid_size') || safeFloat(data, 'bid_sz'),
      ask: safeFloat(data, 'best_ask') || safeFloat(data, 'ask_px'),
      askVolume: safeFloat(data, 'best_ask_size') || safeFloat(data, 'ask_sz'),
      open,
      close: last,
      last,
      change,
      percentage,
      baseVolume: safeFloat(data, 'base_volume_24h') || safeFloat(data, 'v_24h'),
      quoteVolume: safeFloat(data, 'quote_volume_24h') || safeFloat(data, 'qv_24h'),
      info: data,
    };
  }

  _parseOrder(data, fallbackSymbol = undefined) {
    const bitmartSymbol = safeString(data, 'symbol');
    const symbol = fallbackSymbol || (bitmartSymbol ? this._fromBitMartSymbol(bitmartSymbol) : undefined);
    const timestamp = safeInteger(data, 'create_time') || safeInteger(data, 'created_time');

    const price = safeFloat(data, 'price');
    const amount = safeFloat(data, 'size') || safeFloat(data, 'order_size');
    const filled = safeFloat(data, 'filled_size') || safeFloat(data, 'deal_size') || 0;
    const remaining = amount ? amount - filled : undefined;
    const average = safeFloat(data, 'price_avg') || safeFloat(data, 'deal_price');
    const cost = average && filled ? average * filled : safeFloat(data, 'deal_funds');
    const status = this._normalizeOrderStatus(
      safeString(data, 'order_state') || safeString(data, 'state') || safeString(data, 'status')
    );

    return {
      id: safeString(data, 'order_id') || safeString(data, 'orderId'),
      clientOrderId: safeString(data, 'client_order_id'),
      symbol,
      type: safeStringLower(data, 'type') || safeStringLower(data, 'order_type'),
      side: safeStringLower(data, 'side'),
      price,
      amount,
      filled,
      remaining,
      cost,
      average,
      status,
      timestamp,
      datetime: timestamp ? iso8601(timestamp) : undefined,
      info: data,
    };
  }

  _parseTrade(data, symbol = undefined) {
    const bitmartSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (bitmartSymbol ? this._fromBitMartSymbol(bitmartSymbol) : undefined);
    const timestamp = safeInteger(data, 'create_time') ||
                       safeInteger(data, 'timestamp') ||
                       safeInteger(data, 's_t');

    return {
      id: safeString(data, 'trade_id') || safeString(data, 'tradeId') || safeString(data, 'order_id'),
      symbol: resolvedSymbol,
      timestamp,
      datetime: timestamp ? iso8601(timestamp) : undefined,
      side: safeStringLower(data, 'side') || safeStringLower(data, 'type'),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'size') || safeFloat(data, 'count') || safeFloat(data, 'amount'),
      cost: safeFloat(data, 'funds') || safeFloat(data, 'deal_funds'),
      fee: safeFloat(data, 'fee') || safeFloat(data, 'fees'),
      info: data,
    };
  }

  _parseCandle(data) {
    // BitMart v3 kline: array or object format
    if (Array.isArray(data)) {
      return {
        timestamp: parseInt(data[0], 10),
        open: parseFloat(data[1]),
        high: parseFloat(data[2]),
        low: parseFloat(data[3]),
        close: parseFloat(data[4]),
        volume: parseFloat(data[5]),
      };
    }
    return {
      timestamp: safeInteger(data, 'timestamp') || safeInteger(data, 't'),
      open: safeFloat(data, 'open') || safeFloat(data, 'o'),
      high: safeFloat(data, 'high') || safeFloat(data, 'h'),
      low: safeFloat(data, 'low') || safeFloat(data, 'l'),
      close: safeFloat(data, 'close') || safeFloat(data, 'c'),
      volume: safeFloat(data, 'volume') || safeFloat(data, 'v'),
    };
  }

  _parseOrderBook(data, symbol = undefined) {
    const asks = (data.asks || []).map((entry) => {
      if (Array.isArray(entry)) {
        return [parseFloat(entry[0]), parseFloat(entry[1])];
      }
      return [safeFloat(entry, 'price'), safeFloat(entry, 'amount')];
    });

    const bids = (data.bids || []).map((entry) => {
      if (Array.isArray(entry)) {
        return [parseFloat(entry[0]), parseFloat(entry[1])];
      }
      return [safeFloat(entry, 'price'), safeFloat(entry, 'amount')];
    });

    const timestamp = safeInteger(data, 'ts') || safeInteger(data, 'timestamp') || Date.now();

    return {
      symbol,
      asks,
      bids,
      timestamp,
      datetime: iso8601(timestamp),
      nonce: safeInteger(data, 'sequence'),
      info: data,
    };
  }

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  _handleBitMartError(code, msg) {
    const errorCode = parseInt(code, 10);
    const message = this.id + ' error ' + code + ': ' + msg;

    // Auth errors: 30001-30012
    if (errorCode >= 30001 && errorCode <= 30012) throw new AuthenticationError(message);

    // Rate limit
    if (errorCode === 30013) throw new RateLimitExceeded(message);

    // Service unavailable
    if (errorCode === 30014) throw new ExchangeNotAvailable(message);

    // Service maintenance
    if (errorCode === 30016) throw new ExchangeNotAvailable(message);

    // Account restrictions
    if (errorCode === 30017) throw new RateLimitExceeded(message);

    // Symbol / trading param errors
    if (errorCode >= 50000 && errorCode <= 50004) throw new InvalidOrder(message);
    if (errorCode === 50005) throw new OrderNotFound(message);
    if (errorCode >= 50006 && errorCode <= 50029) throw new InvalidOrder(message);
    if (errorCode >= 50030 && errorCode <= 50032) throw new OrderNotFound(message);

    // Balance errors
    if (errorCode === 60008) throw new InsufficientFunds(message);

    throw new ExchangeError(message);
  }

  _handleHttpError(statusCode, body) {
    const msg = this.id + ' HTTP ' + statusCode + ': ' + body;
    if (statusCode === 400) throw new BadRequest(msg);
    if (statusCode === 401) throw new AuthenticationError(msg);
    if (statusCode === 403) throw new AuthenticationError(msg);
    if (statusCode === 404) throw new ExchangeError(msg);
    if (statusCode === 429) throw new RateLimitExceeded(msg);
    if (statusCode >= 500) throw new ExchangeNotAvailable(msg);
    throw new ExchangeError(msg);
  }

  // ===========================================================================
  // WEBSOCKET — zlib compressed, text ping/pong
  // ===========================================================================

  _wsKlineChannel(timeframe) {
    const map = {
      '1m': 'kline1m',
      '5m': 'kline5m',
      '15m': 'kline15m',
      '30m': 'kline30m',
      '1h': 'kline1h',
      '4h': 'kline4h',
      '1d': 'kline1d',
      '1w': 'kline1w',
      '1M': 'kline1M',
    };
    return map[timeframe];
  }

  _getWsClient(url) {
    if (this._wsClients.has(url)) {
      return this._wsClients.get(url);
    }

    const client = new WsClient({ url, pingInterval: 15000 });

    // Override connect to add zlib decompression for BitMart
    const originalConnect = client.connect.bind(client);
    client.connect = async function (connectUrl) {
      await originalConnect(connectUrl);

      // Replace default message handler with zlib-aware handler
      this._ws.removeAllListeners('message');
      this._ws.on('message', (raw) => {
        this._resetPongTimer();

        // Check for text 'pong' response
        if (typeof raw === 'string' || (Buffer.isBuffer(raw) && raw.length < 10)) {
          const str = raw.toString();
          if (str === 'pong') return;
          // Try plain JSON parse for text messages
          try {
            const data = JSON.parse(str);
            this.emit('message', data);
          } catch (e) {
            // Not JSON, ignore
          }
          return;
        }

        // Decompress zlib data
        zlib.inflate(raw, (err, buffer) => {
          if (err) {
            // Fallback: try raw parse
            try {
              const data = JSON.parse(raw.toString());
              this.emit('message', data);
            } catch (e) {
              this.emit('error', e);
            }
            return;
          }
          try {
            const data = JSON.parse(buffer.toString());
            this.emit('message', data);
          } catch (e) {
            this.emit('error', e);
          }
        });
      });
    };

    // Override ping to send text 'ping' (not WebSocket ping frame)
    client._startPing = function () {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send('ping');
        }
      }, this.pingInterval);
    };

    this._wsClients.set(url, client);
    return client;
  }

  async _ensureWsConnected(url) {
    const client = this._getWsClient(url);
    if (!client.connected) {
      await client.connect();
    }
    return client;
  }

  async _subscribeBitMart(channel, callback) {
    const url = this.urls.ws;
    const client = await this._ensureWsConnected(url);

    const subMsg = {
      op: 'subscribe',
      args: [channel],
    };

    client.send(subMsg);

    const handler = (data) => {
      // Route by table field
      if (data && data.table) {
        callback(data);
      }
    };
    client.on('message', handler);

    this._wsHandlers.set(channel, { handler, callback });
    return channel;
  }

  async watchTicker(symbol, callback) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const channel = `spot/ticker:${bitmartSymbol}`;
    return this._subscribeBitMart(channel, (data) => {
      if (data.table === 'spot/ticker' && data.data) {
        for (const t of data.data) {
          const ticker = this._parseWsTicker(t, symbol);
          callback(ticker);
        }
      }
    });
  }

  async watchOrderBook(symbol, callback, limit = undefined) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const depth = limit && limit <= 5 ? 5 : 20;
    const channel = `spot/depth${depth}:${bitmartSymbol}`;
    return this._subscribeBitMart(channel, (data) => {
      const table = data.table || '';
      if (table.startsWith('spot/depth') && data.data) {
        for (const ob of data.data) {
          const orderBook = this._parseWsOrderBook(ob, symbol);
          callback(orderBook);
        }
      }
    });
  }

  async watchTrades(symbol, callback) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const channel = `spot/trade:${bitmartSymbol}`;
    return this._subscribeBitMart(channel, (data) => {
      if (data.table === 'spot/trade' && data.data) {
        const trades = data.data.map((t) => this._parseWsTrade(t, symbol));
        callback(trades);
      }
    });
  }

  async watchKlines(symbol, timeframe, callback) {
    const bitmartSymbol = this._toBitMartSymbol(symbol);
    const klineChannel = this._wsKlineChannel(timeframe);
    if (!klineChannel) {
      throw new BadRequest(this.id + ' unsupported timeframe: ' + timeframe);
    }
    const channel = `spot/${klineChannel}:${bitmartSymbol}`;
    return this._subscribeBitMart(channel, (data) => {
      const table = data.table || '';
      if (table.startsWith('spot/kline') && data.data) {
        const klines = data.data.map((k) => this._parseWsKline(k, symbol));
        callback(klines);
      }
    });
  }

  closeAllWs() {
    for (const [url, client] of this._wsClients) {
      client.close();
    }
    this._wsClients.clear();
    this._wsHandlers.clear();
  }

  // ===========================================================================
  // WS PARSERS
  // ===========================================================================

  _parseWsTicker(data, symbol = undefined) {
    const bitmartSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (bitmartSymbol ? this._fromBitMartSymbol(bitmartSymbol) : undefined);
    const timestamp = safeInteger(data, 'ms_t') || safeInteger(data, 's_t') || Date.now();

    const last = safeFloat(data, 'last');
    const open = safeFloat(data, 'open_24h') || safeFloat(data, 'open');

    return {
      symbol: resolvedSymbol,
      timestamp,
      datetime: iso8601(timestamp),
      high: safeFloat(data, 'high_24h') || safeFloat(data, 'high'),
      low: safeFloat(data, 'low_24h') || safeFloat(data, 'low'),
      bid: safeFloat(data, 'best_bid') || safeFloat(data, 'bid_px'),
      ask: safeFloat(data, 'best_ask') || safeFloat(data, 'ask_px'),
      last,
      open,
      close: last,
      baseVolume: safeFloat(data, 'base_volume_24h') || safeFloat(data, 'v_24h'),
      quoteVolume: safeFloat(data, 'quote_volume_24h') || safeFloat(data, 'qv_24h'),
      info: data,
    };
  }

  _parseWsOrderBook(data, symbol = undefined) {
    const asks = (data.asks || []).map((entry) => {
      if (Array.isArray(entry)) {
        return [parseFloat(entry[0]), parseFloat(entry[1])];
      }
      return [safeFloat(entry, 'price'), safeFloat(entry, 'amount')];
    });

    const bids = (data.bids || []).map((entry) => {
      if (Array.isArray(entry)) {
        return [parseFloat(entry[0]), parseFloat(entry[1])];
      }
      return [safeFloat(entry, 'price'), safeFloat(entry, 'amount')];
    });

    const timestamp = safeInteger(data, 'ms_t') || safeInteger(data, 's_t') || Date.now();

    return {
      symbol,
      asks,
      bids,
      timestamp,
      datetime: iso8601(timestamp),
      nonce: undefined,
      info: data,
    };
  }

  _parseWsTrade(data, symbol = undefined) {
    const bitmartSymbol = safeString(data, 'symbol');
    const resolvedSymbol = symbol || (bitmartSymbol ? this._fromBitMartSymbol(bitmartSymbol) : undefined);
    const timestamp = safeInteger(data, 's_t') || safeInteger(data, 'timestamp');

    return {
      id: safeString(data, 'trade_id'),
      symbol: resolvedSymbol,
      timestamp,
      datetime: timestamp ? iso8601(timestamp) : undefined,
      side: safeStringLower(data, 'side') || safeStringLower(data, 'type'),
      price: safeFloat(data, 'price'),
      amount: safeFloat(data, 'size') || safeFloat(data, 'count'),
      info: data,
    };
  }

  _parseWsKline(data, symbol = undefined) {
    const timestamp = safeInteger(data, 'candle_type') ? undefined :
      (safeInteger(data, 's_t') || safeInteger(data, 'timestamp'));

    return {
      symbol,
      timestamp,
      open: safeFloat(data, 'open') || safeFloat(data, 'o'),
      high: safeFloat(data, 'high') || safeFloat(data, 'h'),
      low: safeFloat(data, 'low') || safeFloat(data, 'l'),
      close: safeFloat(data, 'close') || safeFloat(data, 'c'),
      volume: safeFloat(data, 'volume') || safeFloat(data, 'v'),
      info: data,
    };
  }
}

module.exports = BitMart;

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// 1. Module Exports
// =====================================================================

describe('Module Exports', () => {
  const lib = require('../');

  it('exports Binance class', () => {
    assert.ok(lib.Binance);
    assert.ok(lib.binance); // lowercase alias
    assert.strictEqual(lib.Binance, lib.binance);
  });

  it('exports BaseExchange', () => {
    assert.ok(lib.BaseExchange);
  });

  it('exports error classes', () => {
    assert.ok(lib.ExchangeError);
    assert.ok(lib.AuthenticationError);
    assert.ok(lib.RateLimitExceeded);
    assert.ok(lib.InsufficientFunds);
    assert.ok(lib.InvalidOrder);
    assert.ok(lib.OrderNotFound);
    assert.ok(lib.NetworkError);
    assert.ok(lib.BadSymbol);
    assert.ok(lib.BadRequest);
    assert.ok(lib.RequestTimeout);
  });

  it('exports exchange list and version', () => {
    assert.ok(Array.isArray(lib.exchanges));
    assert.ok(lib.exchanges.includes('binance'));
    assert.ok(lib.version);
  });
});

// =====================================================================
// 2. Binance Instantiation & describe()
// =====================================================================

describe('Binance Constructor', () => {
  const { Binance } = require('../');

  it('creates instance with default config', () => {
    const ex = new Binance();
    assert.strictEqual(ex.id, 'binance');
    assert.strictEqual(ex.name, 'Binance');
    assert.strictEqual(ex.version, 'v3');
    assert.ok(ex.enableRateLimit);
    assert.strictEqual(ex.apiKey, '');
    assert.strictEqual(ex.secret, '');
  });

  it('creates instance with custom config', () => {
    const ex = new Binance({
      apiKey: 'test-key',
      secret: 'test-secret',
      timeout: 10000,
      enableRateLimit: false,
    });
    assert.strictEqual(ex.apiKey, 'test-key');
    assert.strictEqual(ex.secret, 'test-secret');
    assert.strictEqual(ex.timeout, 10000);
    assert.strictEqual(ex.enableRateLimit, false);
  });

  it('has correct URLs', () => {
    const ex = new Binance();
    assert.strictEqual(ex.urls.api, 'https://api.binance.com');
    assert.ok(ex.urls.ws.includes('stream.binance.com'));
    assert.ok(ex.urls.test.api.includes('testnet'));
  });

  it('switches to testnet with sandbox option', () => {
    const ex = new Binance({ options: { sandbox: true } });
    assert.strictEqual(ex.urls.api, 'https://testnet.binance.vision');
  });

  it('has capability flags', () => {
    const ex = new Binance();
    assert.strictEqual(ex.has.loadMarkets, true);
    assert.strictEqual(ex.has.fetchTicker, true);
    assert.strictEqual(ex.has.createOrder, true);
    assert.strictEqual(ex.has.fetchBalance, true);
    assert.strictEqual(ex.has.watchTicker, true);
    assert.strictEqual(ex.has.createOCO, true);
  });

  it('has timeframes', () => {
    const ex = new Binance();
    assert.strictEqual(ex.timeframes['1m'], '1m');
    assert.strictEqual(ex.timeframes['1h'], '1h');
    assert.strictEqual(ex.timeframes['1d'], '1d');
    assert.strictEqual(ex.timeframes['1w'], '1w');
  });

  it('has fee structure', () => {
    const ex = new Binance();
    assert.strictEqual(ex.fees.trading.maker, 0.001);
    assert.strictEqual(ex.fees.trading.taker, 0.001);
  });
});

// =====================================================================
// 3. BaseExchange — Abstract Guard
// =====================================================================

describe('BaseExchange', () => {
  const { BaseExchange } = require('../');

  it('cannot be instantiated directly', () => {
    assert.throws(() => new BaseExchange(), /abstract/i);
  });
});

// =====================================================================
// 4. Authentication — _sign()
// =====================================================================

describe('Binance Authentication', () => {
  const { Binance, AuthenticationError } = require('../');

  it('_sign() produces HMAC-SHA256 signature', () => {
    const ex = new Binance({ apiKey: 'mykey', secret: 'mysecret' });

    // Mock Date.now for reproducibility
    const origDateNow = Date.now;
    Date.now = () => 1700000000000;

    try {
      const result = ex._sign('/api/v3/order', 'POST', { symbol: 'BTCUSDT' });

      assert.ok(result.params.timestamp);
      assert.ok(result.params.recvWindow);
      assert.ok(result.params.signature);
      assert.strictEqual(result.params.signature.length, 64); // SHA256 hex = 64 chars
      assert.strictEqual(result.headers['X-MBX-APIKEY'], 'mykey');
    } finally {
      Date.now = origDateNow;
    }
  });

  it('_sign() throws without credentials', () => {
    const ex = new Binance();
    assert.throws(() => ex._sign('/test', 'GET', {}), /apiKey required/);
  });

  it('checkRequiredCredentials throws without apiKey', () => {
    const ex = new Binance();
    assert.throws(() => ex.checkRequiredCredentials(), /apiKey required/);
  });

  it('checkRequiredCredentials throws without secret', () => {
    const ex = new Binance({ apiKey: 'key' });
    assert.throws(() => ex.checkRequiredCredentials(), /secret required/);
  });

  it('checkRequiredCredentials passes with both', () => {
    const ex = new Binance({ apiKey: 'key', secret: 'sec' });
    assert.doesNotThrow(() => ex.checkRequiredCredentials());
  });
});

// =====================================================================
// 5. Parsers — Ticker, Order, Trade
// =====================================================================

describe('Binance Parsers', () => {
  const { Binance } = require('../');
  let ex;

  beforeEach(() => {
    ex = new Binance({ apiKey: 'k', secret: 's' });
  });

  describe('_parseTicker()', () => {
    it('parses 24hr ticker data', () => {
      const raw = {
        symbol: 'BTCUSDT',
        lastPrice: '97500.00',
        highPrice: '98200.00',
        lowPrice: '96800.00',
        openPrice: '97000.00',
        bidPrice: '97499.50',
        bidQty: '1.5',
        askPrice: '97500.50',
        askQty: '0.8',
        volume: '12345.678',
        quoteVolume: '1204567890.12',
        priceChange: '500.00',
        priceChangePercent: '0.515',
        weightedAvgPrice: '97150.00',
        closeTime: 1700000000000,
      };

      const ticker = ex._parseTicker(raw);
      assert.strictEqual(ticker.symbol, 'BTCUSDT');
      assert.strictEqual(ticker.last, 97500);
      assert.strictEqual(ticker.high, 98200);
      assert.strictEqual(ticker.low, 96800);
      assert.strictEqual(ticker.bid, 97499.5);
      assert.strictEqual(ticker.ask, 97500.5);
      assert.strictEqual(ticker.volume, 12345.678);
      assert.strictEqual(ticker.change, 500);
      assert.strictEqual(ticker.percentage, 0.515);
      assert.ok(ticker.datetime);
      assert.deepStrictEqual(ticker.info, raw);
    });
  });

  describe('_parseWsTicker()', () => {
    it('parses WebSocket ticker', () => {
      const ws = {
        s: 'ETHUSDT', c: '3500.00', h: '3600.00', l: '3400.00',
        o: '3450.00', b: '3499.90', B: '100', a: '3500.10',
        A: '50', v: '500000', q: '1750000000', p: '50.00',
        P: '1.449', E: 1700000000000,
      };

      const ticker = ex._parseWsTicker(ws);
      assert.strictEqual(ticker.symbol, 'ETHUSDT');
      assert.strictEqual(ticker.last, 3500);
      assert.strictEqual(ticker.bid, 3499.9);
      assert.strictEqual(ticker.ask, 3500.1);
      assert.strictEqual(ticker.volume, 500000);
    });
  });

  describe('_parseOrder()', () => {
    it('parses REST order response', () => {
      const raw = {
        orderId: 12345678,
        clientOrderId: 'myOrder1',
        symbol: 'BTCUSDT',
        type: 'LIMIT',
        side: 'BUY',
        price: '95000.00',
        origQty: '0.01',
        executedQty: '0.005',
        cummulativeQuoteQty: '475.00',
        status: 'PARTIALLY_FILLED',
        timeInForce: 'GTC',
        transactTime: 1700000000000,
        fills: [
          { price: '95000.00', qty: '0.005', commission: '0.000005', commissionAsset: 'BTC' },
        ],
      };

      const order = ex._parseOrder(raw);
      assert.strictEqual(order.id, '12345678');
      assert.strictEqual(order.clientOrderId, 'myOrder1');
      assert.strictEqual(order.symbol, 'BTCUSDT');
      assert.strictEqual(order.type, 'LIMIT');
      assert.strictEqual(order.side, 'BUY');
      assert.strictEqual(order.price, 95000);
      assert.strictEqual(order.amount, 0.01);
      assert.strictEqual(order.filled, 0.005);
      assert.strictEqual(order.remaining, 0.005);
      assert.strictEqual(order.cost, 475);
      assert.strictEqual(order.average, 95000); // 475 / 0.005
      assert.strictEqual(order.status, 'PARTIALLY_FILLED');
      assert.strictEqual(order.trades.length, 1);
      assert.strictEqual(order.trades[0].commission, 0.000005);
    });

    it('handles fully filled order', () => {
      const raw = {
        orderId: 999,
        symbol: 'ETHUSDT',
        type: 'MARKET',
        side: 'SELL',
        price: '0.00',
        origQty: '1.00',
        executedQty: '1.00',
        cummulativeQuoteQty: '3500.00',
        status: 'FILLED',
        transactTime: 1700000000000,
        fills: [],
      };

      const order = ex._parseOrder(raw);
      assert.strictEqual(order.filled, 1);
      assert.strictEqual(order.remaining, 0);
      assert.strictEqual(order.average, 3500);
      assert.strictEqual(order.status, 'FILLED');
    });
  });

  describe('_parseWsOrder()', () => {
    it('parses WebSocket execution report', () => {
      const data = {
        e: 'executionReport', s: 'BTCUSDT', i: 12345,
        c: 'clientId', o: 'LIMIT', S: 'BUY', p: '95000.00',
        q: '0.01', z: '0.01', Z: '950.00', X: 'FILLED',
        x: 'TRADE', f: 'GTC', L: '95000.00', l: '0.01',
        n: '0.00001', N: 'BTC', T: 1700000000000, t: 555,
      };

      const order = ex._parseWsOrder(data);
      assert.strictEqual(order.event, 'order');
      assert.strictEqual(order.id, '12345');
      assert.strictEqual(order.symbol, 'BTCUSDT');
      assert.strictEqual(order.status, 'FILLED');
      assert.strictEqual(order.executionType, 'TRADE');
      assert.strictEqual(order.filled, 0.01);
      assert.strictEqual(order.average, 95000);
      assert.strictEqual(order.tradeId, 555);
    });
  });

  describe('_parseTrade()', () => {
    it('parses public trade data', () => {
      const raw = {
        id: 100, price: '97500.00', qty: '0.01',
        time: 1700000000000, isBuyerMaker: false,
      };

      const trade = ex._parseTrade(raw, 'BTCUSDT');
      assert.strictEqual(trade.id, '100');
      assert.strictEqual(trade.symbol, 'BTCUSDT');
      assert.strictEqual(trade.price, 97500);
      assert.strictEqual(trade.amount, 0.01);
      assert.strictEqual(trade.cost, 975);
      assert.strictEqual(trade.isBuyerMaker, false);
    });
  });

  describe('_parseMyTrade()', () => {
    it('parses private trade (myTrades) data', () => {
      const raw = {
        id: 200, orderId: 12345, symbol: 'BTCUSDT',
        price: '97500.00', qty: '0.01', quoteQty: '975.00',
        commission: '0.000005', commissionAsset: 'BTC',
        time: 1700000000000, isBuyer: true, isMaker: false,
      };

      const trade = ex._parseMyTrade(raw, 'BTCUSDT');
      assert.strictEqual(trade.id, '200');
      assert.strictEqual(trade.orderId, '12345');
      assert.strictEqual(trade.fee.cost, 0.000005);
      assert.strictEqual(trade.fee.currency, 'BTC');
      assert.strictEqual(trade.isBuyer, true);
      assert.strictEqual(trade.isMaker, false);
    });
  });
});

// =====================================================================
// 6. Error Mapping — _handleHttpError()
// =====================================================================

describe('Binance Error Mapping', () => {
  const {
    Binance, AuthenticationError, RateLimitExceeded,
    InsufficientFunds, OrderNotFound, BadSymbol,
    InvalidOrder, ExchangeError,
  } = require('../');

  let ex;
  beforeEach(() => { ex = new Binance(); });

  it('maps -1002 to AuthenticationError', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: -1002, msg: 'bad key' })),
      AuthenticationError
    );
  });

  it('maps -1022 to AuthenticationError (invalid signature)', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: -1022, msg: 'Invalid signature' })),
      AuthenticationError
    );
  });

  it('maps -1003 to RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleHttpError(429, JSON.stringify({ code: -1003, msg: 'Too many requests' })),
      RateLimitExceeded
    );
  });

  it('maps -2010 to InsufficientFunds', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: -2010, msg: 'Account has insufficient balance' })),
      InsufficientFunds
    );
  });

  it('maps -2013 to OrderNotFound', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: -2013, msg: 'Order does not exist' })),
      OrderNotFound
    );
  });

  it('maps -1121 to BadSymbol', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: -1121, msg: 'Invalid symbol' })),
      BadSymbol
    );
  });

  it('maps -1013 to InvalidOrder', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: -1013, msg: 'Filter failure' })),
      InvalidOrder
    );
  });

  it('falls back to ExchangeError for unknown codes', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ code: -9999, msg: 'Unknown error' })),
      ExchangeError
    );
  });

  it('handles non-JSON body', () => {
    assert.throws(
      () => ex._handleHttpError(500, 'Internal Server Error'),
      ExchangeError
    );
  });
});

// =====================================================================
// 7. Rate Limit Header Handling
// =====================================================================

describe('Binance Rate Limit Header Handling', () => {
  const { Binance } = require('../');

  it('updates weight from response headers', () => {
    const ex = new Binance();
    const headers = new Map();
    headers.set('x-mbx-used-weight-1m', '1234');
    headers.set('x-mbx-order-count-10s', '5');
    // Mock headers.get
    const mockHeaders = { get: (key) => headers.get(key) };

    ex._handleResponseHeaders(mockHeaders);
    assert.strictEqual(ex._weightUsed, 1234);
    assert.strictEqual(ex._orderCount10s, 5);
  });

  it('emits rateLimitWarning when weight > 4800', () => {
    const ex = new Binance();
    let warned = false;
    ex.on('rateLimitWarning', (data) => {
      warned = true;
      assert.strictEqual(data.used, 5500);
      assert.strictEqual(data.limit, 6000);
    });

    const mockHeaders = { get: (key) => key === 'x-mbx-used-weight-1m' ? '5500' : null };
    ex._handleResponseHeaders(mockHeaders);
    assert.ok(warned, 'should have emitted rateLimitWarning');
  });
});

// =====================================================================
// 8. Mocked API Calls — loadMarkets, fetchBalance, etc.
// =====================================================================

describe('Binance API Methods (mocked)', () => {
  const { Binance } = require('../');
  let ex;

  beforeEach(() => {
    ex = new Binance({ apiKey: 'testkey', secret: 'testsecret' });
  });

  describe('loadMarkets()', () => {
    it('parses exchangeInfo into unified market format', async () => {
      // Mock _request
      ex._request = async () => ({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            baseAssetPrecision: 8,
            quotePrecision: 8,
            orderTypes: ['LIMIT', 'MARKET'],
            permissions: ['SPOT'],
            filters: [
              { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000.00', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', minQty: '0.00001', maxQty: '9000.00', stepSize: '0.00001' },
              { filterType: 'NOTIONAL', minNotional: '5.00' },
            ],
          },
          {
            symbol: 'ETHUSDT',
            baseAsset: 'ETH',
            quoteAsset: 'USDT',
            status: 'TRADING',
            baseAssetPrecision: 8,
            quotePrecision: 8,
            orderTypes: ['LIMIT', 'MARKET'],
            permissions: ['SPOT'],
            filters: [
              { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '100000.00', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100000.00', stepSize: '0.0001' },
              { filterType: 'MIN_NOTIONAL', minNotional: '5.00' },
            ],
          },
        ],
      });

      const markets = await ex.loadMarkets();

      assert.ok(markets.BTCUSDT);
      assert.ok(markets.ETHUSDT);
      assert.strictEqual(ex.symbols.length, 2);
      assert.ok(ex._marketsLoaded);

      const btc = markets.BTCUSDT;
      assert.strictEqual(btc.base, 'BTC');
      assert.strictEqual(btc.quote, 'USDT');
      assert.strictEqual(btc.active, true);
      assert.strictEqual(btc.tickSize, 0.01);
      assert.strictEqual(btc.stepSize, 0.00001);
      assert.strictEqual(btc.limits.price.min, 0.01);
      assert.strictEqual(btc.limits.amount.min, 0.00001);
      assert.strictEqual(btc.limits.cost.min, 5);
    });

    it('returns cached markets on second call', async () => {
      let callCount = 0;
      ex._request = async () => {
        callCount++;
        return { symbols: [] };
      };

      await ex.loadMarkets();
      await ex.loadMarkets();
      assert.strictEqual(callCount, 1, 'should only fetch once');
    });

    it('reloads when forced', async () => {
      let callCount = 0;
      ex._request = async () => {
        callCount++;
        return { symbols: [] };
      };

      await ex.loadMarkets();
      await ex.loadMarkets(true);
      assert.strictEqual(callCount, 2, 'should fetch twice with reload=true');
    });
  });

  describe('fetchOrderBook()', () => {
    it('returns unified order book', async () => {
      ex._request = async (method, path, params) => {
        assert.strictEqual(method, 'GET');
        assert.strictEqual(path, '/api/v3/depth');
        assert.strictEqual(params.symbol, 'BTCUSDT');
        return {
          lastUpdateId: 123456789,
          bids: [['97500.00', '1.5'], ['97499.00', '2.0']],
          asks: [['97501.00', '0.8'], ['97502.00', '1.2']],
        };
      };

      const book = await ex.fetchOrderBook('BTCUSDT', 5);
      assert.strictEqual(book.symbol, 'BTCUSDT');
      assert.strictEqual(book.nonce, 123456789);
      assert.strictEqual(book.bids[0][0], 97500);
      assert.strictEqual(book.bids[0][1], 1.5);
      assert.strictEqual(book.asks[0][0], 97501);
      assert.ok(book.timestamp);
      assert.ok(book.datetime);
    });
  });

  describe('fetchBalance()', () => {
    it('returns unified balance format', async () => {
      ex._request = async (method, path, params, signed) => {
        assert.strictEqual(signed, true);
        return {
          balances: [
            { asset: 'BTC', free: '0.50000000', locked: '0.10000000' },
            { asset: 'USDT', free: '5000.00', locked: '1000.00' },
            { asset: 'ETH', free: '0.00000000', locked: '0.00000000' },
          ],
        };
      };

      const balance = await ex.fetchBalance();
      assert.ok(balance.BTC);
      assert.strictEqual(balance.BTC.free, 0.5);
      assert.strictEqual(balance.BTC.used, 0.1);
      assert.strictEqual(balance.BTC.total, 0.6);
      assert.strictEqual(balance.USDT.free, 5000);
      assert.strictEqual(balance.USDT.total, 6000);
      // ETH should be excluded (zero balance)
      assert.strictEqual(balance.ETH, undefined);
      assert.ok(balance.timestamp);
    });
  });

  describe('createOrder()', () => {
    it('builds correct request for LIMIT order', async () => {
      let capturedRequest;
      ex._request = async (method, path, params) => {
        capturedRequest = { method, path, params };
        return {
          orderId: 99999,
          clientOrderId: 'test1',
          symbol: 'BTCUSDT',
          type: 'LIMIT',
          side: 'BUY',
          price: '95000.00',
          origQty: '0.001',
          executedQty: '0.000',
          cummulativeQuoteQty: '0.00',
          status: 'NEW',
          timeInForce: 'GTC',
          transactTime: 1700000000000,
          fills: [],
        };
      };

      const order = await ex.createOrder('btcusdt', 'LIMIT', 'BUY', 0.001, 95000);
      assert.strictEqual(capturedRequest.method, 'POST');
      assert.strictEqual(capturedRequest.path, '/api/v3/order');
      assert.strictEqual(capturedRequest.params.symbol, 'BTCUSDT');
      assert.strictEqual(capturedRequest.params.side, 'BUY');
      assert.strictEqual(capturedRequest.params.type, 'LIMIT');
      assert.strictEqual(capturedRequest.params.quantity, '0.001');
      assert.strictEqual(capturedRequest.params.price, '95000');
      assert.strictEqual(capturedRequest.params.timeInForce, 'GTC');

      assert.strictEqual(order.id, '99999');
      assert.strictEqual(order.status, 'NEW');
    });

    it('builds correct request for MARKET order', async () => {
      let capturedParams;
      ex._request = async (method, path, params) => {
        capturedParams = params;
        return {
          orderId: 100000, symbol: 'BTCUSDT', type: 'MARKET', side: 'SELL',
          price: '0.00', origQty: '0.01', executedQty: '0.01',
          cummulativeQuoteQty: '975.00', status: 'FILLED',
          transactTime: 1700000000000, fills: [],
        };
      };

      await ex.createMarketOrder('BTCUSDT', 'SELL', 0.01);
      assert.strictEqual(capturedParams.type, 'MARKET');
      assert.ok(!capturedParams.timeInForce); // No timeInForce for MARKET
    });
  });

  describe('cancelOrder()', () => {
    it('sends DELETE with correct params', async () => {
      let capturedRequest;
      ex._request = async (method, path, params) => {
        capturedRequest = { method, path, params };
        return {
          orderId: 123, symbol: 'BTCUSDT', status: 'CANCELED',
          type: 'LIMIT', side: 'BUY', price: '95000.00',
          origQty: '0.001', executedQty: '0.000',
          cummulativeQuoteQty: '0.00',
        };
      };

      const result = await ex.cancelOrder(123, 'BTCUSDT');
      assert.strictEqual(capturedRequest.method, 'DELETE');
      assert.strictEqual(capturedRequest.params.orderId, 123);
      assert.strictEqual(result.status, 'CANCELED');
    });

    it('throws without symbol', async () => {
      await assert.rejects(() => ex.cancelOrder(123), /requires symbol/);
    });
  });

  describe('fetchTicker()', () => {
    it('returns parsed ticker', async () => {
      ex._request = async () => ({
        symbol: 'BTCUSDT', lastPrice: '97500.00', highPrice: '98000.00',
        lowPrice: '97000.00', openPrice: '97200.00', bidPrice: '97499.00',
        bidQty: '1.0', askPrice: '97501.00', askQty: '0.5',
        volume: '10000.00', quoteVolume: '975000000.00',
        priceChange: '300.00', priceChangePercent: '0.308',
        weightedAvgPrice: '97250.00', closeTime: 1700000000000,
      });

      const ticker = await ex.fetchTicker('BTCUSDT');
      assert.strictEqual(ticker.symbol, 'BTCUSDT');
      assert.strictEqual(ticker.last, 97500);
      assert.strictEqual(ticker.bid, 97499);
      assert.strictEqual(ticker.ask, 97501);
    });
  });

  describe('fetchOHLCV()', () => {
    it('returns OHLCV arrays', async () => {
      ex._request = async () => [
        [1700000000000, '97000.00', '97500.00', '96800.00', '97200.00', '100.00',
         1700003600000, '9720000.00', 500, '50.00', '4860000.00', '0'],
      ];

      const candles = await ex.fetchOHLCV('BTCUSDT', '1h', undefined, 1);
      assert.strictEqual(candles.length, 1);
      assert.strictEqual(candles[0][0], 1700000000000); // timestamp
      assert.strictEqual(candles[0][1], 97000);          // open
      assert.strictEqual(candles[0][2], 97500);          // high
      assert.strictEqual(candles[0][3], 96800);          // low
      assert.strictEqual(candles[0][4], 97200);          // close
      assert.strictEqual(candles[0][5], 100);             // volume
    });
  });

  describe('fetchMyTrades()', () => {
    it('returns parsed trades', async () => {
      ex._request = async () => [
        {
          id: 1, orderId: 100, symbol: 'BTCUSDT',
          price: '97500.00', qty: '0.01', quoteQty: '975.00',
          commission: '0.000005', commissionAsset: 'BTC',
          time: 1700000000000, isBuyer: true, isMaker: false,
        },
      ];

      const trades = await ex.fetchMyTrades('BTCUSDT', undefined, 1);
      assert.strictEqual(trades.length, 1);
      assert.strictEqual(trades[0].price, 97500);
      assert.strictEqual(trades[0].fee.cost, 0.000005);
      assert.strictEqual(trades[0].fee.currency, 'BTC');
    });

    it('throws without symbol', async () => {
      await assert.rejects(() => ex.fetchMyTrades(), /requires symbol/);
    });
  });

  describe('fetchTrades()', () => {
    it('returns parsed public trades', async () => {
      ex._request = async () => [
        { id: 500, price: '97500.00', qty: '0.5', time: 1700000000000, isBuyerMaker: true },
      ];

      const trades = await ex.fetchTrades('BTCUSDT', undefined, 1);
      assert.strictEqual(trades.length, 1);
      assert.strictEqual(trades[0].price, 97500);
      assert.strictEqual(trades[0].amount, 0.5);
      assert.strictEqual(trades[0].cost, 48750);
    });
  });
});

// =====================================================================
// 9. Utility Functions
// =====================================================================

describe('Utility Functions', () => {
  const {
    safeFloat, safeString, safeInteger, safeValue,
    safeStringUpper, safeFloat2, buildQuery, buildQueryRaw,
    iso8601, parseDate, deepMerge, sleep,
  } = require('../lib/utils/helpers');

  describe('safeFloat()', () => {
    it('extracts float from string value', () => {
      assert.strictEqual(safeFloat({ price: '97500.50' }, 'price'), 97500.5);
    });
    it('returns default for missing key', () => {
      assert.strictEqual(safeFloat({ price: '1' }, 'missing', 0), 0);
    });
    it('returns default for null obj', () => {
      assert.strictEqual(safeFloat(null, 'key', 5), 5);
    });
    it('returns default for NaN', () => {
      assert.strictEqual(safeFloat({ x: 'abc' }, 'x', 0), 0);
    });
  });

  describe('safeString()', () => {
    it('extracts string', () => {
      assert.strictEqual(safeString({ symbol: 'BTCUSDT' }, 'symbol'), 'BTCUSDT');
    });
    it('converts number to string', () => {
      assert.strictEqual(safeString({ id: 123 }, 'id'), '123');
    });
  });

  describe('safeInteger()', () => {
    it('extracts integer from string', () => {
      assert.strictEqual(safeInteger({ time: '1700000000000' }, 'time'), 1700000000000);
    });
  });

  describe('safeStringUpper()', () => {
    it('uppercases result', () => {
      assert.strictEqual(safeStringUpper({ side: 'buy' }, 'side'), 'BUY');
    });
  });

  describe('safeFloat2()', () => {
    it('tries first key then fallback', () => {
      assert.strictEqual(safeFloat2({ price2: '100' }, 'price1', 'price2'), 100);
      assert.strictEqual(safeFloat2({ price1: '50' }, 'price1', 'price2'), 50);
    });
  });

  describe('buildQuery()', () => {
    it('builds sorted URL-encoded query string', () => {
      const qs = buildQuery({ b: 'hello world', a: '1' });
      assert.strictEqual(qs, 'a=1&b=hello%20world');
    });
  });

  describe('buildQueryRaw()', () => {
    it('builds raw query string (no encoding)', () => {
      const qs = buildQueryRaw({ symbol: 'BTCUSDT', side: 'BUY' });
      assert.ok(qs.includes('symbol=BTCUSDT'));
      assert.ok(qs.includes('side=BUY'));
    });
  });

  describe('iso8601()', () => {
    it('converts timestamp to ISO string', () => {
      assert.strictEqual(iso8601(1700000000000), '2023-11-14T22:13:20.000Z');
    });
    it('returns undefined for null', () => {
      assert.strictEqual(iso8601(null), undefined);
    });
  });

  describe('parseDate()', () => {
    it('parses date string to timestamp', () => {
      const ts = parseDate('2023-11-14T22:13:20.000Z');
      assert.strictEqual(ts, 1700000000000);
    });
    it('returns undefined for invalid date', () => {
      assert.strictEqual(parseDate('not-a-date'), undefined);
    });
  });

  describe('deepMerge()', () => {
    it('merges nested objects', () => {
      const result = deepMerge(
        { a: 1, b: { c: 2, d: 3 } },
        { b: { c: 5, e: 6 }, f: 7 }
      );
      assert.strictEqual(result.a, 1);
      assert.strictEqual(result.b.c, 5);
      assert.strictEqual(result.b.d, 3);
      assert.strictEqual(result.b.e, 6);
      assert.strictEqual(result.f, 7);
    });
  });

  describe('sleep()', () => {
    it('resolves after delay', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 40, `expected >= 40ms, got ${elapsed}ms`);
    });
  });
});

// =====================================================================
// 10. Crypto Utilities
// =====================================================================

describe('Crypto Utilities', () => {
  const { hmacSHA256, sha256 } = require('../lib/utils/crypto');

  it('hmacSHA256 produces correct hex digest', () => {
    const sig = hmacSHA256('test-data', 'test-secret');
    assert.strictEqual(sig.length, 64);
    assert.match(sig, /^[0-9a-f]{64}$/);
  });

  it('hmacSHA256 is deterministic', () => {
    const sig1 = hmacSHA256('data', 'key');
    const sig2 = hmacSHA256('data', 'key');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signature', () => {
    const sig1 = hmacSHA256('data1', 'key');
    const sig2 = hmacSHA256('data2', 'key');
    assert.notStrictEqual(sig1, sig2);
  });

  it('sha256 produces correct hex digest', () => {
    const hash = sha256('hello');
    assert.strictEqual(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

// =====================================================================
// 11. Throttler (Rate Limiter)
// =====================================================================

describe('Throttler', () => {
  const Throttler = require('../lib/utils/throttler');

  it('initializes with full capacity', () => {
    const t = new Throttler({ capacity: 100 });
    const status = t.getStatus();
    assert.strictEqual(status.capacity, 100);
    assert.ok(status.available >= 99); // Allow tiny drift
  });

  it('tryConsume reduces tokens', () => {
    const t = new Throttler({ capacity: 100 });
    assert.ok(t.tryConsume(10));
    const status = t.getStatus();
    assert.ok(status.available <= 90);
  });

  it('tryConsume returns false when insufficient', () => {
    const t = new Throttler({ capacity: 10 });
    assert.ok(t.tryConsume(5));
    assert.ok(t.tryConsume(5));
    assert.ok(!t.tryConsume(5)); // Only ~0 left
  });

  it('updateFromHeader syncs tokens', () => {
    const t = new Throttler({ capacity: 6000 });
    t.updateFromHeader(4500);
    const status = t.getStatus();
    assert.ok(status.available <= 1500);
  });

  it('consume waits when tokens insufficient', async () => {
    const t = new Throttler({ capacity: 10, refillRate: 10, refillInterval: 100 });
    t.tryConsume(10); // Drain tokens
    const start = Date.now();
    await t.consume(5); // Should wait for refill
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 30, `expected wait, got ${elapsed}ms`);
  });
});

// =====================================================================
// 12. Error Classes
// =====================================================================

describe('Error Classes', () => {
  const {
    ExchangeError, AuthenticationError, RateLimitExceeded,
    NetworkError, RequestTimeout, InsufficientFunds,
  } = require('../lib/utils/errors');

  it('error hierarchy is correct', () => {
    const e = new AuthenticationError('bad key');
    assert.ok(e instanceof AuthenticationError);
    assert.ok(e instanceof ExchangeError);
    assert.ok(e instanceof Error);
    assert.strictEqual(e.name, 'AuthenticationError');
    assert.strictEqual(e.message, 'bad key');
  });

  it('RequestTimeout extends NetworkError', () => {
    const e = new RequestTimeout('timed out');
    assert.ok(e instanceof RequestTimeout);
    assert.ok(e instanceof NetworkError);
    assert.ok(e instanceof ExchangeError);
  });

  it('InsufficientFunds extends ExchangeError', () => {
    const e = new InsufficientFunds('not enough');
    assert.ok(e instanceof InsufficientFunds);
    assert.ok(e instanceof ExchangeError);
  });

  it('RateLimitExceeded extends ExchangeError', () => {
    const e = new RateLimitExceeded('too fast');
    assert.ok(e instanceof RateLimitExceeded);
    assert.ok(e instanceof ExchangeError);
  });
});

// =====================================================================
// 13. Market Lookup
// =====================================================================

describe('Binance market() lookup', () => {
  const { Binance, ExchangeError } = require('../');

  it('throws if markets not loaded', () => {
    const ex = new Binance();
    assert.throws(() => ex.market('BTCUSDT'), /markets not loaded/);
  });

  it('throws for unknown symbol', async () => {
    const ex = new Binance();
    ex._request = async () => ({ symbols: [] });
    await ex.loadMarkets();
    assert.throws(() => ex.market('FAKECOIN'), /unknown symbol/);
  });

  it('returns market for valid symbol', async () => {
    const ex = new Binance();
    ex._request = async () => ({
      symbols: [{
        symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
        status: 'TRADING', baseAssetPrecision: 8, quotePrecision: 8,
        orderTypes: ['LIMIT'], permissions: ['SPOT'], filters: [],
      }],
    });
    await ex.loadMarkets();
    const m = ex.market('BTCUSDT');
    assert.strictEqual(m.base, 'BTC');
    assert.strictEqual(m.quote, 'USDT');
  });
});

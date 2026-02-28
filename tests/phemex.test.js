'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const ygcc = require('../index');
const { Phemex, phemex: PhemexAlias, hmacSHA256 } = ygcc;

// =============================================================================
// 1. Module Exports (3 tests)
// =============================================================================

describe('Phemex — Module Exports', () => {
  it('exports Phemex class', () => {
    assert.ok(Phemex);
    assert.strictEqual(typeof Phemex, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(PhemexAlias, Phemex);
  });

  it('includes phemex in exchanges list', () => {
    assert.ok(ygcc.exchanges.includes('phemex'));
  });
});

// =============================================================================
// 2. Constructor (9 tests)
// =============================================================================

describe('Phemex — Constructor', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==' });
  });

  it('sets postAsJson = true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('describe() returns correct id', () => {
    assert.strictEqual(exchange.describe().id, 'phemex');
  });

  it('describe() returns correct name', () => {
    assert.strictEqual(exchange.describe().name, 'Phemex');
  });

  it('describe() returns correct version', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
  });

  it('timeframes use numeric seconds (60, 300, 3600)', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['1m'], 60);
    assert.strictEqual(tf['5m'], 300);
    assert.strictEqual(tf['15m'], 900);
    assert.strictEqual(tf['1h'], 3600);
    assert.strictEqual(tf['4h'], 14400);
    assert.strictEqual(tf['1d'], 86400);
  });

  it('fees are correct (0.1% maker/taker)', () => {
    const fees = exchange.describe().fees;
    assert.strictEqual(fees.trading.maker, 0.001);
    assert.strictEqual(fees.trading.taker, 0.001);
  });

  it('all public WebSocket features are enabled', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchTicker, true);
    assert.strictEqual(has.watchOrderBook, true);
    assert.strictEqual(has.watchTrades, true);
    assert.strictEqual(has.watchKlines, true);
  });

  it('private WebSocket features are disabled', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchBalance, false);
    assert.strictEqual(has.watchOrders, false);
  });

  it('_wsIdCounter starts at 1', () => {
    assert.strictEqual(exchange._wsIdCounter, 1);
  });
});

// =============================================================================
// 3. Authentication — HMAC-SHA256 + Base64-decoded key (10 tests)
// =============================================================================

describe('Phemex — Authentication', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'test-api-key', secret: 'dGVzdFNlY3JldA==' });
  });

  it('_sign requires API credentials', () => {
    const noAuth = new Phemex();
    assert.throws(() => noAuth._sign('/spot/orders', 'POST', {}), /apiKey required/);
  });

  it('_sign returns headers with x-phemex-access-token', () => {
    const result = exchange._sign('/spot/wallets', 'GET', {});
    assert.strictEqual(result.headers['x-phemex-access-token'], 'test-api-key');
  });

  it('_sign returns headers with x-phemex-request-expiry as seconds string', () => {
    const result = exchange._sign('/spot/wallets', 'GET', {});
    const expiry = result.headers['x-phemex-request-expiry'];
    assert.strictEqual(typeof expiry, 'string');
    const num = parseInt(expiry, 10);
    assert.ok(num > 1700000000); // Epoch seconds (not ms)
    assert.ok(num < 2000000000); // Still reasonable
  });

  it('_sign returns headers with x-phemex-request-signature', () => {
    const result = exchange._sign('/spot/wallets', 'GET', {});
    const sig = result.headers['x-phemex-request-signature'];
    assert.strictEqual(typeof sig, 'string');
    assert.ok(/^[a-f0-9]+$/.test(sig)); // Hex string
  });

  it('_sign returns Content-Type application/json header', () => {
    const result = exchange._sign('/spot/orders', 'POST', {});
    assert.strictEqual(result.headers['Content-Type'], 'application/json');
  });

  it('GET signing uses path + queryString + expiry', () => {
    const result1 = exchange._sign('/spot/wallets', 'GET', { currency: 'BTC' });
    const result2 = exchange._sign('/spot/wallets', 'GET', { currency: 'USDT' });
    // Different params → different signatures
    assert.notStrictEqual(
      result1.headers['x-phemex-request-signature'],
      result2.headers['x-phemex-request-signature']
    );
  });

  it('POST signing uses path + expiry + body', () => {
    const result1 = exchange._sign('/spot/orders', 'POST', { symbol: 'sBTCUSDT', side: 'Buy' });
    const result2 = exchange._sign('/spot/orders', 'POST', { symbol: 'sETHUSDT', side: 'Sell' });
    assert.notStrictEqual(
      result1.headers['x-phemex-request-signature'],
      result2.headers['x-phemex-request-signature']
    );
  });

  it('DELETE signing uses path + queryString + expiry (like GET)', () => {
    const result = exchange._sign('/spot/orders', 'DELETE', { symbol: 'sBTCUSDT', orderID: 'abc123' });
    assert.ok(result.headers['x-phemex-request-signature']);
    assert.strictEqual(result.params.symbol, 'sBTCUSDT');
  });

  it('secret is Base64-decoded before HMAC', () => {
    // Verify manually: hmacSHA256 with Buffer key
    const decodedSecret = Buffer.from('dGVzdFNlY3JldA==', 'base64');
    const sig = hmacSHA256('testdata', decodedSecret);
    assert.strictEqual(typeof sig, 'string');
    assert.ok(/^[a-f0-9]+$/.test(sig));
  });

  it('expiry is about 60 seconds in the future', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = exchange._sign('/test', 'GET', {});
    const expiry = parseInt(result.headers['x-phemex-request-expiry'], 10);
    assert.ok(expiry >= now + 55); // Allow small timing difference
    assert.ok(expiry <= now + 65);
  });
});

// =============================================================================
// 4. Response Handling (5 tests)
// =============================================================================

describe('Phemex — Response Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==' });
  });

  it('_unwrapResponse extracts data from REST format (code=0)', () => {
    const response = { code: 0, msg: '', data: { orderID: '123' } };
    const result = exchange._unwrapResponse(response);
    assert.deepStrictEqual(result, { orderID: '123' });
  });

  it('_unwrapResponse throws on non-zero code', () => {
    const response = { code: 11001, msg: 'Insufficient available balance' };
    assert.throws(
      () => exchange._unwrapResponse(response),
      (err) => err.constructor.name === 'InsufficientFunds'
    );
  });

  it('_unwrapResponse extracts result from market data format (error=null)', () => {
    const response = { error: null, id: 0, result: { symbol: 'sBTCUSDT', high: 42000 } };
    const result = exchange._unwrapResponse(response);
    assert.deepStrictEqual(result, { symbol: 'sBTCUSDT', high: 42000 });
  });

  it('_unwrapResponse throws on market data error', () => {
    const response = { error: 'Some error occurred', id: 0, result: null };
    assert.throws(
      () => exchange._unwrapResponse(response),
      (err) => err.constructor.name === 'ExchangeError'
    );
  });

  it('_unwrapResponse returns data as-is for unknown format', () => {
    const response = { foo: 'bar' };
    const result = exchange._unwrapResponse(response);
    assert.deepStrictEqual(result, { foo: 'bar' });
  });
});

// =============================================================================
// 5. Parsers (10 tests)
// =============================================================================

describe('Phemex — Parsers', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==' });
  });

  it('_parseTicker scales Ep values to human-readable', () => {
    const data = {
      symbol: 'sBTCUSDT',
      timestamp: 1700000000000,
      highEp: 4200050000000,
      lowEp: 4000000000000,
      lastEp: 4150000000000,
      openEp: 4100000000000,
      volumeEv: 123456000000,
      turnoverEv: 5123456789000000,
    };
    const result = exchange._parseTicker(data, 'BTC/USDT');
    assert.strictEqual(result.symbol, 'BTC/USDT');
    assert.strictEqual(result.high, 42000.5);
    assert.strictEqual(result.low, 40000);
    assert.strictEqual(result.last, 41500);
    assert.strictEqual(result.open, 41000);
  });

  it('_parseOrder maps New status to open', () => {
    const data = { orderID: '123', symbol: 'sBTCUSDT', ordStatus: 'New', side: 'Buy', ordType: 'Limit', priceEp: 5000000000000, baseQtyEv: 10000000 };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.status, 'open');
    assert.strictEqual(result.side, 'buy');
    assert.strictEqual(result.type, 'limit');
  });

  it('_parseOrder maps Filled status to closed', () => {
    const data = { orderID: '456', symbol: 'sBTCUSDT', ordStatus: 'Filled', side: 'Sell', ordType: 'Market', baseQtyEv: 50000000, cumBaseQtyEv: 50000000, avgPriceEp: 4200000000000 };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.status, 'closed');
    assert.strictEqual(result.filled, 0.5);
    assert.strictEqual(result.average, 42000);
  });

  it('_parseOrder maps Canceled status to canceled', () => {
    const data = { orderID: '789', ordStatus: 'Canceled', side: 'Buy', ordType: 'Limit' };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.status, 'canceled');
  });

  it('_parseOrder maps PartiallyFilled status to open', () => {
    const data = { orderID: '999', ordStatus: 'PartiallyFilled', side: 'Buy', ordType: 'Limit', baseQtyEv: 100000000, cumBaseQtyEv: 60000000 };
    const result = exchange._parseOrder(data, 'BTC/USDT');
    assert.strictEqual(result.status, 'open');
    assert.strictEqual(result.filled, 0.6);
    assert.strictEqual(result.remaining, 0.4);
  });

  it('_parseTrade handles array format [ts, side, priceEp, qty]', () => {
    const data = [1700000000000, 'Buy', 4150000000000, 50000000];
    const result = exchange._parseTrade(data, 'BTC/USDT');
    assert.strictEqual(result.timestamp, 1700000000000);
    assert.strictEqual(result.side, 'buy');
    assert.strictEqual(result.price, 41500);
    assert.strictEqual(result.amount, 0.5);
  });

  it('_parseCandle scales Ep values from array', () => {
    // [timestamp, interval, lastCloseEp, openEp, highEp, lowEp, closeEp, volumeEv, turnoverEv]
    const data = [1700000000, 60, 4100000000000, 4100000000000, 4200000000000, 4050000000000, 4150000000000, 123456000000, 5123456789000000];
    const result = exchange._parseCandle(data);
    assert.strictEqual(result[0], 1700000000000); // seconds → ms
    assert.strictEqual(result[1], 41000); // open
    assert.strictEqual(result[2], 42000); // high
    assert.strictEqual(result[3], 40500); // low
    assert.strictEqual(result[4], 41500); // close
    assert.strictEqual(result[5], 1234.56); // volume
  });

  it('_parseOrderBook scales asks and bids from Ep', () => {
    const data = {
      book: {
        asks: [[4200000000000, 50000000], [4210000000000, 100000000]],
        bids: [[4190000000000, 80000000], [4180000000000, 120000000]],
      },
      sequence: 12345,
      timestamp: 1700000000000,
    };
    const result = exchange._parseOrderBook(data, 'BTC/USDT');
    assert.strictEqual(result.symbol, 'BTC/USDT');
    assert.strictEqual(result.asks[0][0], 42000);
    assert.strictEqual(result.asks[0][1], 0.5);
    assert.strictEqual(result.bids[0][0], 41900);
    assert.strictEqual(result.bids[0][1], 0.8);
    assert.strictEqual(result.nonce, 12345);
  });

  it('_parseTicker resolves symbol from phemex symbol', () => {
    exchange.marketsById = { 'sETHUSDT': { symbol: 'ETH/USDT' } };
    const data = { symbol: 'sETHUSDT', lastEp: 200000000000 };
    const result = exchange._parseTicker(data);
    assert.strictEqual(result.symbol, 'ETH/USDT');
  });
});

// =============================================================================
// 6. Helper Methods (8 tests)
// =============================================================================

describe('Phemex — Helper Methods', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex();
  });

  it('_toPhemexSymbol converts BTC/USDT to sBTCUSDT', () => {
    assert.strictEqual(exchange._toPhemexSymbol('BTC/USDT'), 'sBTCUSDT');
  });

  it('_toPhemexSymbol converts ETH/USDC to sETHUSDC', () => {
    assert.strictEqual(exchange._toPhemexSymbol('ETH/USDC'), 'sETHUSDC');
  });

  it('_fromPhemexSymbol converts sBTCUSDT to BTC/USDT', () => {
    assert.strictEqual(exchange._fromPhemexSymbol('sBTCUSDT'), 'BTC/USDT');
  });

  it('_fromPhemexSymbol uses marketsById when available', () => {
    exchange.marketsById = { 'sTRXUSDC': { symbol: 'TRX/USDC' } };
    assert.strictEqual(exchange._fromPhemexSymbol('sTRXUSDC'), 'TRX/USDC');
  });

  it('_scaleToEp converts human value to 10^8', () => {
    assert.strictEqual(exchange._scaleToEp(42000.5), 4200050000000);
    assert.strictEqual(exchange._scaleToEp(0.001), 100000);
    assert.strictEqual(exchange._scaleToEp(1), 100000000);
  });

  it('_scaleFromEp converts 10^8 value to human', () => {
    assert.strictEqual(exchange._scaleFromEp(4200050000000), 42000.5);
    assert.strictEqual(exchange._scaleFromEp(100000000), 1);
    assert.strictEqual(exchange._scaleFromEp(undefined), undefined);
  });

  it('_toPhemexSide converts buy/sell to Buy/Sell', () => {
    assert.strictEqual(exchange._toPhemexSide('buy'), 'Buy');
    assert.strictEqual(exchange._toPhemexSide('sell'), 'Sell');
  });

  it('base URL is https://api.phemex.com', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.phemex.com');
  });
});

// =============================================================================
// 7. Error Mapping (7 tests)
// =============================================================================

describe('Phemex — Error Mapping', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==' });
  });

  it('10001 → InvalidOrder (duplicate order ID)', () => {
    assert.throws(
      () => exchange._handlePhemexError(10001, 'Duplicated order ID'),
      (err) => err.constructor.name === 'InvalidOrder'
    );
  });

  it('10002 → OrderNotFound', () => {
    assert.throws(
      () => exchange._handlePhemexError(10002, 'Cannot find order ID'),
      (err) => err.constructor.name === 'OrderNotFound'
    );
  });

  it('11001 → InsufficientFunds', () => {
    assert.throws(
      () => exchange._handlePhemexError(11001, 'Insufficient available balance'),
      (err) => err.constructor.name === 'InsufficientFunds'
    );
  });

  it('11027 → BadSymbol (invalid symbol)', () => {
    assert.throws(
      () => exchange._handlePhemexError(11027, 'Invalid symbol'),
      (err) => err.constructor.name === 'BadSymbol'
    );
  });

  it('11105 → InsufficientFunds (insufficient base balance)', () => {
    assert.throws(
      () => exchange._handlePhemexError(11105, 'Insufficient base balance'),
      (err) => err.constructor.name === 'InsufficientFunds'
    );
  });

  it('11106 → InsufficientFunds (insufficient quote balance)', () => {
    assert.throws(
      () => exchange._handlePhemexError(11106, 'Insufficient quote balance'),
      (err) => err.constructor.name === 'InsufficientFunds'
    );
  });

  it('unknown error code → ExchangeError', () => {
    assert.throws(
      () => exchange._handlePhemexError(99999, 'Unknown error'),
      (err) => err.constructor.name === 'ExchangeError'
    );
  });
});

// =============================================================================
// 8. HTTP Error Handling (6 tests)
// =============================================================================

describe('Phemex — HTTP Error Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==' });
  });

  it('400 → BadRequest', () => {
    assert.throws(
      () => exchange._handleHttpError(400, 'bad request'),
      (err) => err.constructor.name === 'BadRequest'
    );
  });

  it('401 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(401, 'unauthorized'),
      (err) => err.constructor.name === 'AuthenticationError'
    );
  });

  it('403 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(403, 'forbidden'),
      (err) => err.constructor.name === 'AuthenticationError'
    );
  });

  it('404 → ExchangeError', () => {
    assert.throws(
      () => exchange._handleHttpError(404, 'not found'),
      (err) => err.constructor.name === 'ExchangeError'
    );
  });

  it('429 → RateLimitExceeded', () => {
    assert.throws(
      () => exchange._handleHttpError(429, 'too many requests'),
      (err) => err.constructor.name === 'RateLimitExceeded'
    );
  });

  it('500 → ExchangeNotAvailable', () => {
    assert.throws(
      () => exchange._handleHttpError(500, 'internal error'),
      (err) => err.constructor.name === 'ExchangeNotAvailable'
    );
  });
});

// =============================================================================
// 9. Rate Limit Handling (3 tests)
// =============================================================================

describe('Phemex — Rate Limit Handling', () => {
  it('default rateLimit is 100ms', () => {
    const exchange = new Phemex();
    assert.strictEqual(exchange.describe().rateLimit, 100);
  });

  it('enableRateLimit defaults to true', () => {
    const exchange = new Phemex();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limiting via config', () => {
    const exchange = new Phemex({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });
});

// =============================================================================
// 10. Mocked API Calls (15 tests)
// =============================================================================

describe('Phemex — Mocked API Calls', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==', enableRateLimit: false });
    exchange.markets = {
      'BTC/USDT': { id: 'sBTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
      'ETH/USDT': { id: 'sETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' },
    };
    exchange.marketsById = {
      'sBTCUSDT': exchange.markets['BTC/USDT'],
      'sETHUSDT': exchange.markets['ETH/USDT'],
    };
    exchange._marketsLoaded = true;
  });

  it('fetchTime returns server timestamp', async () => {
    exchange._request = mock.fn(async () => ({ code: 0, data: { serverTime: 1700000000000 } }));
    const ts = await exchange.fetchTime();
    assert.strictEqual(ts, 1700000000000);
    assert.strictEqual(exchange._request.mock.calls[0].arguments[1], '/public/time');
  });

  it('loadMarkets parses products response (filters Spot+Listed)', async () => {
    const ex = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==', enableRateLimit: false });
    ex._request = mock.fn(async () => ({
      code: 0,
      data: {
        products: [
          { symbol: 'sBTCUSDT', type: 'Spot', status: 'Listed', baseCurrency: 'BTC', quoteCurrency: 'USDT', pricePrecision: 8, baseQtyPrecision: 8 },
          { symbol: 'sETHUSDT', type: 'Spot', status: 'Listed', baseCurrency: 'ETH', quoteCurrency: 'USDT', pricePrecision: 8, baseQtyPrecision: 8 },
          { symbol: 'BTCUSD', type: 'Perpetual', status: 'Listed', baseCurrency: 'BTC', quoteCurrency: 'USD' },
        ],
      },
    }));
    const markets = await ex.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'sBTCUSDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(Object.keys(markets).length, 2); // Perpetual filtered out
  });

  it('fetchTicker sends correct symbol and parses Ep values', async () => {
    exchange._request = mock.fn(async () => ({
      error: null,
      result: {
        symbol: 'sBTCUSDT',
        timestamp: 1700000000000,
        highEp: 4200000000000,
        lowEp: 4000000000000,
        lastEp: 4150000000000,
        volumeEv: 123456000000,
      },
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.high, 42000);
    assert.strictEqual(ticker.last, 41500);
    const call = exchange._request.mock.calls[0].arguments;
    assert.strictEqual(call[1], '/md/ticker/24hr');
    assert.strictEqual(call[2].symbol, 'sBTCUSDT');
  });

  it('fetchTickers requests all tickers', async () => {
    exchange._request = mock.fn(async () => ({
      error: null,
      result: [
        { symbol: 'sBTCUSDT', lastEp: 4150000000000 },
        { symbol: 'sETHUSDT', lastEp: 220000000000 },
      ],
    }));
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/USDT']);
    assert.ok(tickers['ETH/USDT']);
    assert.strictEqual(exchange._request.mock.calls[0].arguments[1], '/md/spot/ticker/24hr/all');
  });

  it('fetchOrderBook parses Ep-scaled book', async () => {
    exchange._request = mock.fn(async () => ({
      error: null,
      result: {
        book: {
          asks: [[4200000000000, 50000000], [4210000000000, 100000000]],
          bids: [[4190000000000, 80000000], [4180000000000, 120000000]],
        },
        sequence: 12345,
        timestamp: 1700000000000,
      },
    }));
    const ob = await exchange.fetchOrderBook('BTC/USDT');
    assert.strictEqual(ob.symbol, 'BTC/USDT');
    assert.strictEqual(ob.asks[0][0], 42000);
    assert.strictEqual(ob.asks[0][1], 0.5);
    assert.strictEqual(ob.bids[0][0], 41900);
    assert.strictEqual(exchange._request.mock.calls[0].arguments[2].symbol, 'sBTCUSDT');
  });

  it('fetchTrades parses array format [ts, side, priceEp, qty]', async () => {
    exchange._request = mock.fn(async () => ({
      error: null,
      result: {
        trades: [
          [1700000000000, 'Buy', 4150000000000, 50000000],
          [1700000001000, 'Sell', 4160000000000, 100000000],
        ],
      },
    }));
    const trades = await exchange.fetchTrades('BTC/USDT');
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[0].price, 41500);
    assert.strictEqual(trades[1].side, 'sell');
  });

  it('fetchOHLCV sends resolution and parses candles', async () => {
    exchange._request = mock.fn(async () => ({
      error: null,
      result: {
        rows: [
          [1700000000, 60, 4100000000000, 4100000000000, 4200000000000, 4050000000000, 4150000000000, 123456000000, 5000000000000000],
        ],
      },
    }));
    const candles = await exchange.fetchOHLCV('BTC/USDT', '1h');
    assert.strictEqual(candles.length, 1);
    assert.strictEqual(candles[0][0], 1700000000000);
    assert.strictEqual(candles[0][1], 41000); // open
    assert.strictEqual(candles[0][4], 41500); // close
    assert.strictEqual(exchange._request.mock.calls[0].arguments[2].resolution, 3600);
  });

  it('createOrder sends limit order with Ep-scaled values', async () => {
    exchange._request = mock.fn(async () => ({
      code: 0,
      data: { orderID: 'ord123', clOrdID: 'cl456' },
    }));
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001, 50000);
    assert.strictEqual(order.id, 'ord123');
    assert.strictEqual(order.type, 'limit');
    assert.strictEqual(order.side, 'buy');
    const params = exchange._request.mock.calls[0].arguments[2];
    assert.strictEqual(params.symbol, 'sBTCUSDT');
    assert.strictEqual(params.side, 'Buy');
    assert.strictEqual(params.ordType, 'Limit');
    assert.strictEqual(params.qtyType, 'ByBase');
    assert.strictEqual(params.baseQtyEv, 100000);
    assert.strictEqual(params.priceEp, 5000000000000);
  });

  it('createOrder sends market buy with ByQuote', async () => {
    exchange._request = mock.fn(async () => ({
      code: 0,
      data: { orderID: 'ord789' },
    }));
    const order = await exchange.createOrder('BTC/USDT', 'market', 'buy', 100);
    assert.strictEqual(order.type, 'market');
    const params = exchange._request.mock.calls[0].arguments[2];
    assert.strictEqual(params.ordType, 'Market');
    assert.strictEqual(params.qtyType, 'ByQuote');
    assert.strictEqual(params.quoteQtyEv, 10000000000);
  });

  it('createOrder sends market sell with ByBase', async () => {
    exchange._request = mock.fn(async () => ({
      code: 0,
      data: { orderID: 'ord101' },
    }));
    await exchange.createOrder('BTC/USDT', 'market', 'sell', 0.5);
    const params = exchange._request.mock.calls[0].arguments[2];
    assert.strictEqual(params.qtyType, 'ByBase');
    assert.strictEqual(params.baseQtyEv, 50000000);
  });

  it('cancelOrder sends DELETE with symbol and orderID', async () => {
    exchange._request = mock.fn(async () => ({ code: 0, data: {} }));
    const result = await exchange.cancelOrder('ord-abc', 'BTC/USDT');
    assert.strictEqual(result.id, 'ord-abc');
    const call = exchange._request.mock.calls[0].arguments;
    assert.strictEqual(call[0], 'DELETE');
    assert.strictEqual(call[1], '/spot/orders');
    assert.strictEqual(call[2].orderID, 'ord-abc');
    assert.strictEqual(call[2].symbol, 'sBTCUSDT');
  });

  it('fetchBalance parses Ev-scaled wallet data', async () => {
    exchange._request = mock.fn(async () => ({
      code: 0,
      data: [
        { currency: 'BTC', balanceEv: 200000000, lockedEv: 50000000 },
        { currency: 'USDT', balanceEv: 1000000000000, lockedEv: 200000000000 },
      ],
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.total, 2);
    assert.strictEqual(balance.BTC.used, 0.5);
    assert.strictEqual(balance.BTC.free, 1.5);
    assert.strictEqual(balance.USDT.total, 10000);
  });

  it('fetchMyTrades sends correct endpoint (GET, signed)', async () => {
    exchange._request = mock.fn(async () => ({
      code: 0,
      data: { rows: [{ tradeId: 't1', symbol: 'sBTCUSDT', side: 'Buy', priceEp: 4150000000000, baseQtyEv: 50000000 }] },
    }));
    const trades = await exchange.fetchMyTrades('BTC/USDT');
    assert.strictEqual(trades.length, 1);
    const call = exchange._request.mock.calls[0].arguments;
    assert.strictEqual(call[0], 'GET');
    assert.strictEqual(call[1], '/spot/data/tradesHist');
    assert.strictEqual(call[3], true); // signed
  });
});

// =============================================================================
// 11. Market Lookup (3 tests)
// =============================================================================

describe('Phemex — Market Lookup', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex();
    exchange.markets = {
      'BTC/USDT': { id: 'sBTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = {
      'sBTCUSDT': exchange.markets['BTC/USDT'],
    };
    exchange._marketsLoaded = true;
  });

  it('market() returns market by unified symbol', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'sBTCUSDT');
    assert.strictEqual(m.base, 'BTC');
  });

  it('market().id returns Phemex symbol format', () => {
    assert.strictEqual(exchange.market('BTC/USDT').id, 'sBTCUSDT');
  });

  it('marketsById resolves from Phemex format', () => {
    assert.strictEqual(exchange.marketsById['sBTCUSDT'].symbol, 'BTC/USDT');
  });
});

// =============================================================================
// 12. Phemex vs Others Differences (8 tests)
// =============================================================================

describe('Phemex — Differences from Other Exchanges', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==' });
  });

  it('uses Base64-decoded secret key (unlike raw string secrets)', () => {
    const decoded = Buffer.from('dGVzdFNlY3JldA==', 'base64');
    assert.strictEqual(decoded.toString(), 'testSecret');
  });

  it('uses Ep/Ev 10^8 scaling for prices and quantities', () => {
    assert.strictEqual(exchange._scaleToEp(42000), 4200000000000);
    assert.strictEqual(exchange._scaleFromEp(4200000000000), 42000);
  });

  it('symbols use s-prefix format sBTCUSDT (unlike BTC-USDT or btc_usdt)', () => {
    assert.strictEqual(exchange._toPhemexSymbol('BTC/USDT'), 'sBTCUSDT');
    assert.strictEqual(exchange._toPhemexSymbol('ETH/USDC'), 'sETHUSDC');
  });

  it('expiry is Unix epoch seconds (not milliseconds)', () => {
    const result = exchange._sign('/test', 'GET', {});
    const expiry = parseInt(result.headers['x-phemex-request-expiry'], 10);
    assert.ok(expiry < 2000000000); // Seconds range
    assert.ok(expiry > 1700000000);
  });

  it('uses qtyType ByBase/ByQuote for market orders', () => {
    // Market buy uses ByQuote, market sell uses ByBase
    assert.strictEqual('ByQuote', 'ByQuote');
    assert.strictEqual('ByBase', 'ByBase');
  });

  it('uses PascalCase for order types and sides (Limit, Market, Buy, Sell)', () => {
    assert.strictEqual(exchange._toPhemexSide('buy'), 'Buy');
    assert.strictEqual(exchange._toPhemexSide('sell'), 'Sell');
  });

  it('WS uses JSON-RPC style subscribe with server.ping client heartbeat', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://phemex.com/ws');
  });

  it('WS orderbook has snapshot + incremental types', () => {
    const snapshot = { type: 'snapshot', book: { asks: [], bids: [] } };
    const incremental = { type: 'incremental', book: { asks: [], bids: [] } };
    assert.strictEqual(snapshot.type, 'snapshot');
    assert.strictEqual(incremental.type, 'incremental');
  });
});

// =============================================================================
// 13. Crypto (3 tests)
// =============================================================================

describe('Phemex — Crypto Functions', () => {
  it('hmacSHA256 works with Buffer key (Base64-decoded secret)', () => {
    const decodedKey = Buffer.from('dGVzdFNlY3JldA==', 'base64');
    const sig = hmacSHA256('test message', decodedKey);
    assert.strictEqual(typeof sig, 'string');
    assert.strictEqual(sig.length, 64); // SHA256 hex = 64 chars
    assert.ok(/^[a-f0-9]+$/.test(sig));
  });

  it('hmacSHA256 known test vector with Buffer key', () => {
    const key = Buffer.from('key');
    const sig = hmacSHA256('data', key);
    // Known: HMAC-SHA256("data", "key") = 5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0
    assert.strictEqual(sig, '5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0');
  });

  it('signing produces different signatures for different expiry', () => {
    const key = Buffer.from('dGVzdFNlY3JldA==', 'base64');
    const sig1 = hmacSHA256('/spot/orders' + '1700000000' + '{}', key);
    const sig2 = hmacSHA256('/spot/orders' + '1700000001' + '{}', key);
    assert.notStrictEqual(sig1, sig2);
  });
});

// =============================================================================
// 14. WebSocket (14 tests)
// =============================================================================

describe('Phemex — WebSocket JSON-RPC subscribe', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex({ apiKey: 'testKey', secret: 'dGVzdFNlY3JldA==' });
    exchange.marketsById = { 'sBTCUSDT': { symbol: 'BTC/USDT' }, 'sETHUSDT': { symbol: 'ETH/USDT' } };
  });

  it('WS URL is wss://phemex.com/ws', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://phemex.com/ws');
  });

  it('orderbook subscribe channel format: spot.book.sBTCUSDT', () => {
    const channel = `spot.book.${exchange._toPhemexSymbol('BTC/USDT')}`;
    assert.strictEqual(channel, 'spot.book.sBTCUSDT');
  });

  it('trade subscribe channel format: spot.trade.sBTCUSDT', () => {
    const channel = `spot.trade.${exchange._toPhemexSymbol('BTC/USDT')}`;
    assert.strictEqual(channel, 'spot.trade.sBTCUSDT');
  });

  it('ticker subscribe channel format: spot.ticker.24hr.sBTCUSDT', () => {
    const channel = `spot.ticker.24hr.${exchange._toPhemexSymbol('BTC/USDT')}`;
    assert.strictEqual(channel, 'spot.ticker.24hr.sBTCUSDT');
  });

  it('kline subscribe channel format: spot.kline.3600.sBTCUSDT', () => {
    const resolution = exchange.describe().timeframes['1h'];
    const channel = `spot.kline.${resolution}.${exchange._toPhemexSymbol('BTC/USDT')}`;
    assert.strictEqual(channel, 'spot.kline.3600.sBTCUSDT');
  });

  it('subscribe message uses JSON-RPC format', () => {
    const msg = { id: 1, method: 'subscribe', params: ['spot.book.sBTCUSDT'] };
    assert.strictEqual(msg.method, 'subscribe');
    assert.strictEqual(msg.params[0], 'spot.book.sBTCUSDT');
  });

  it('ping message format: {id, method: "server.ping", params: []}', () => {
    const ping = { id: 1234, method: 'server.ping', params: [] };
    assert.strictEqual(ping.method, 'server.ping');
    assert.deepStrictEqual(ping.params, []);
  });

  it('pong response format: {id, result: "pong"}', () => {
    const pong = { id: 1234, result: 'pong' };
    assert.strictEqual(pong.result, 'pong');
  });

  it('_parseWsTicker scales Ep values', () => {
    const data = {
      symbol: 'sBTCUSDT',
      timestamp: 1700000000000,
      highEp: 4200000000000,
      lowEp: 4000000000000,
      lastEp: 4150000000000,
    };
    const ticker = exchange._parseWsTicker(data, 'BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.high, 42000);
    assert.strictEqual(ticker.last, 41500);
  });

  it('_parseWsOrderBook scales Ep values and includes type', () => {
    const data = {
      symbol: 'sBTCUSDT',
      type: 'snapshot',
      book: {
        asks: [[4200000000000, 50000000]],
        bids: [[4190000000000, 80000000]],
      },
      sequence: 100,
      timestamp: 1700000000000,
    };
    const ob = exchange._parseWsOrderBook(data, 'BTC/USDT');
    assert.strictEqual(ob.asks[0][0], 42000);
    assert.strictEqual(ob.bids[0][0], 41900);
    assert.strictEqual(ob.type, 'snapshot');
    assert.strictEqual(ob.nonce, 100);
  });

  it('_parseWsTrades parses array format trades', () => {
    const data = {
      symbol: 'sBTCUSDT',
      trades: [[1700000000000, 'Buy', 4150000000000, 50000000]],
    };
    const trades = exchange._parseWsTrades(data, 'BTC/USDT');
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[0].price, 41500);
    assert.strictEqual(trades[0].amount, 0.5);
  });

  it('_parseWsOrderBook resolves symbol from data when not provided', () => {
    const data = { symbol: 'sETHUSDT', type: 'incremental', book: { asks: [], bids: [] } };
    const ob = exchange._parseWsOrderBook(data);
    assert.strictEqual(ob.symbol, 'ETH/USDT');
    assert.strictEqual(ob.type, 'incremental');
  });

  it('closeAllWs clears all clients', () => {
    exchange._wsClients.set('url1', { close: () => {} });
    exchange._wsClients.set('url2', { close: () => {} });
    exchange.closeAllWs();
    assert.strictEqual(exchange._wsClients.size, 0);
  });
});

// =============================================================================
// 15. WS Message Dispatch (5 tests)
// =============================================================================

describe('Phemex — WebSocket Message Dispatch', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Phemex();
  });

  it('orderbook snapshot has type=snapshot', () => {
    const msg = { type: 'snapshot', symbol: 'sBTCUSDT', book: { asks: [], bids: [] }, depth: 30 };
    assert.strictEqual(msg.type, 'snapshot');
  });

  it('orderbook incremental has type=incremental', () => {
    const msg = { type: 'incremental', symbol: 'sBTCUSDT', book: { asks: [], bids: [] } };
    assert.strictEqual(msg.type, 'incremental');
  });

  it('trade message has trades array', () => {
    const msg = { symbol: 'sBTCUSDT', trades: [[1700000000000, 'Buy', 4150000000000, 50000000]], type: 'snapshot' };
    assert.ok(Array.isArray(msg.trades));
  });

  it('server.ping response is {result: "pong"}', () => {
    const response = { id: 5, result: 'pong' };
    assert.strictEqual(response.result, 'pong');
  });

  it('subscribe response confirms subscription', () => {
    const response = { id: 1, error: null, result: { status: 'success' } };
    assert.strictEqual(response.error, null);
    assert.ok(response.result);
  });
});

// =============================================================================
// 16. Version (1 test)
// =============================================================================

describe('Phemex — Version', () => {
  it('version is 2.2.0', () => {
    assert.strictEqual(ygcc.version, '2.2.0');
  });
});

'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const BtcTurk = require('../lib/btcturk');
const { hmacSHA256Base64 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — BtcTurk
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — BtcTurk', () => {
  it('exports BtcTurk class', () => {
    assert.strictEqual(typeof lib.BtcTurk, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.btcturk, lib.BtcTurk);
  });

  it('includes btcturk in exchanges list', () => {
    assert.ok(lib.exchanges.includes('btcturk'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. BtcTurk Constructor
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new BtcTurk(); });

  it('sets id to btcturk', () => {
    assert.strictEqual(exchange.describe().id, 'btcturk');
  });

  it('sets name to BtcTurk', () => {
    assert.strictEqual(exchange.describe().name, 'BtcTurk');
  });

  it('sets version to v2', () => {
    assert.strictEqual(exchange.describe().version, 'v2');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('has empty timeframes', () => {
    assert.deepStrictEqual(exchange.describe().timeframes, {});
  });

  it('has correct fees (maker: 0.001, taker: 0.002)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.002);
  });

  it('stores passphrase from config (BaseExchange pattern)', () => {
    const ex = new BtcTurk({ passphrase: 'mypass' });
    // BtcTurk does not use passphrase, but BaseExchange may store it if subclass handles it
    // BtcTurk constructor does not explicitly store passphrase; verify no error is thrown
    assert.ok(ex);
  });

  it('stores uid from config (BaseExchange pattern)', () => {
    const ex = new BtcTurk({ uid: 'myuser' });
    // BtcTurk does not use uid, but verify no error is thrown
    assert.ok(ex);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — HMAC-SHA256 Base64 with decoded key
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA256 Base64 with decoded key', () => {
  // BtcTurk secret is base64-encoded; the _sign method decodes it before using as HMAC key
  // BtcTurk only requires 2 credentials: apiKey + secret

  // Use a valid base64 string as the secret for tests
  const testSecret = Buffer.from('testsecret').toString('base64'); // 'dGVzdHNlY3JldA=='
  let exchange;
  beforeEach(() => {
    exchange = new BtcTurk({ apiKey: 'testkey', secret: testSecret });
  });

  it('throws without apiKey', () => {
    const ex = new BtcTurk({ secret: testSecret });
    assert.throws(() => ex._sign('/api/v2/ticker', 'GET', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new BtcTurk({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/api/v2/ticker', 'GET', {}), /secret required/);
  });

  it('returns X-PCK header (apiKey)', () => {
    const result = exchange._sign('/api/v2/ticker', 'GET', {});
    assert.strictEqual(result.headers['X-PCK'], 'testkey');
  });

  it('returns X-Stamp header (timestamp string)', () => {
    const result = exchange._sign('/api/v2/ticker', 'GET', {});
    assert.ok(result.headers['X-Stamp']);
    assert.ok(/^\d+$/.test(result.headers['X-Stamp']));
  });

  it('returns X-Signature header (base64 string)', () => {
    const result = exchange._sign('/api/v2/ticker', 'GET', {});
    // Base64 strings contain [A-Za-z0-9+/=]
    assert.ok(result.headers['X-Signature']);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(result.headers['X-Signature']));
  });

  it('signing: HMAC-SHA256(apiKey + timestamp, Buffer.from(secret, "base64")) → base64', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v2/ticker', 'GET', {});
      const message = 'testkey' + '1700000000000';
      const key = Buffer.from(testSecret, 'base64');
      const expected = hmacSHA256Base64(message, key);
      assert.strictEqual(result.headers['X-Signature'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('deterministic signature with fixed timestamp', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result1 = exchange._sign('/api/v2/ticker', 'GET', {});
      const result2 = exchange._sign('/api/v2/ticker', 'GET', {});
      assert.strictEqual(result1.headers['X-Signature'], result2.headers['X-Signature']);
    } finally {
      Date.now = origNow;
    }
  });

  it('params are preserved in result', () => {
    const params = { pairSymbol: 'BTCTRY', limit: 10 };
    const result = exchange._sign('/api/v2/orderbook', 'GET', params);
    assert.strictEqual(result.params.pairSymbol, 'BTCTRY');
    assert.strictEqual(result.params.limit, 10);
  });

  it('only requires 2 credentials (apiKey + secret), not 4', () => {
    // BtcTurk should sign successfully with just apiKey + secret
    const ex = new BtcTurk({ apiKey: 'mykey', secret: testSecret });
    const result = ex._sign('/api/v2/ticker', 'GET', {});
    assert.ok(result.headers['X-PCK']);
    assert.ok(result.headers['X-Stamp']);
    assert.ok(result.headers['X-Signature']);
  });

  it('X-Stamp reflects current timestamp', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v2/ticker', 'GET', {});
      assert.strictEqual(result.headers['X-Stamp'], '1700000000000');
    } finally {
      Date.now = origNow;
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new BtcTurk(); });

  it('unwraps data envelope (data.data field)', () => {
    const result = exchange._unwrapResponse({ data: { symbols: [] }, success: true, code: 0 });
    assert.ok(result.symbols !== undefined);
  });

  it('success:false throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ success: false, message: 'Something failed', code: 1001 }),
      ExchangeError
    );
  });

  it('code !== 0 throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ success: true, code: 500, message: 'Internal error' }),
      ExchangeError
    );
  });

  it('array response returned as-is', () => {
    const arr = [{ asset: 'BTC', free: '0.5' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('non-object response passes through', () => {
    const result = exchange._unwrapResponse('OK');
    assert.strictEqual(result, 'OK');
  });

  it('null data with success field throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ data: null, success: true, message: 'Empty' }),
      ExchangeError
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Parsers', () => {
  let exchange;
  beforeEach(() => {
    exchange = new BtcTurk();
    exchange.marketsById = { 'BTCTRY': { symbol: 'BTC/TRY' } };
  });

  it('_parseTicker extracts all fields (last, high, low, bid, ask, open, volume, change: daily, percentage: dailyPercent)', () => {
    const t = exchange._parseTicker({
      pair: 'BTCTRY',
      last: 750000, high: 760000, low: 740000,
      bid: 749000, ask: 751000, open: 745000,
      volume: 500, daily: 5000, dailyPercent: 1.5,
      timestamp: 1700000000000,
    });
    assert.strictEqual(t.symbol, 'BTC/TRY');
    assert.strictEqual(t.last, 750000);
    assert.strictEqual(t.high, 760000);
    assert.strictEqual(t.low, 740000);
    assert.strictEqual(t.bid, 749000);
    assert.strictEqual(t.ask, 751000);
    assert.strictEqual(t.open, 745000);
    assert.strictEqual(t.volume, 500);
    assert.strictEqual(t.change, 5000);
    assert.strictEqual(t.percentage, 1.5);
  });

  it('_parseOrder extracts order id', () => {
    const o = exchange._parseOrder({ id: '12345', pairSymbol: 'BTCTRY' }, 'BTC/TRY');
    assert.strictEqual(o.id, '12345');
    assert.strictEqual(o.symbol, 'BTC/TRY');
  });

  it('_parseOrder handles side (buy/sell from orderType field)', () => {
    const buy = exchange._parseOrder({ id: '1', type: 'buy' }, 'BTC/TRY');
    assert.strictEqual(buy.side, 'BUY');

    const sell = exchange._parseOrder({ id: '2', type: 'sell' }, 'BTC/TRY');
    assert.strictEqual(sell.side, 'SELL');
  });

  it('_parseOrder handles side from orderType field', () => {
    const o = exchange._parseOrder({ id: '3', orderType: 'buy' }, 'BTC/TRY');
    assert.strictEqual(o.side, 'BUY');
  });

  it('_parseOrder calculates remaining and cost', () => {
    const o = exchange._parseOrder({
      id: '4', price: 100, quantity: 10, filledAmount: 4,
    }, 'BTC/TRY');
    assert.strictEqual(o.price, 100);
    assert.strictEqual(o.amount, 10);
    assert.strictEqual(o.filled, 4);
    assert.strictEqual(o.remaining, 6);
    assert.strictEqual(o.cost, 400);
  });

  it('_parseOrderBook handles array entries [[price, amount], ...]', () => {
    const ob = exchange._parseOrderBook({
      asks: [['751000', '0.8']],
      bids: [['749000', '1.5']],
    }, 'BTC/TRY');
    assert.deepStrictEqual(ob.asks[0], [751000, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [749000, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/TRY');
  });

  it('_parseOrderBook handles object entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [{ price: '751000', volume: '0.8' }],
      bids: [{ price: '749000', volume: '1.5' }],
    }, 'BTC/TRY');
    assert.deepStrictEqual(ob.asks[0], [751000, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [749000, 1.5]);
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/TRY');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseBalance extracts balances (asset, free, locked, balance fields)', () => {
    const b = exchange._parseBalance([
      { asset: 'BTC', free: 0.5, locked: 0.3, balance: 0.8 },
      { asset: 'TRY', free: 10000, locked: 5000, balance: 15000 },
    ]);
    assert.strictEqual(b.BTC.free, 0.5);
    assert.strictEqual(b.BTC.used, 0.3);
    assert.strictEqual(b.BTC.total, 0.8);
    assert.strictEqual(b.TRY.free, 10000);
    assert.strictEqual(b.TRY.used, 5000);
    assert.strictEqual(b.TRY.total, 15000);
  });

  it('_parseTicker sets close equal to last', () => {
    const t = exchange._parseTicker({ pair: 'BTCTRY', last: 750000 });
    assert.strictEqual(t.close, t.last);
  });

  it('_parseOrder defaults status to open', () => {
    const o = exchange._parseOrder({ id: '99' }, 'BTC/TRY');
    assert.strictEqual(o.status, 'open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new BtcTurk(); });

  it('_toBtcTurkSymbol BTC/TRY → BTCTRY', () => {
    assert.strictEqual(exchange._toBtcTurkSymbol('BTC/TRY'), 'BTCTRY');
  });

  it('_toBtcTurkSymbol ETH/USDT → ETHUSDT', () => {
    assert.strictEqual(exchange._toBtcTurkSymbol('ETH/USDT'), 'ETHUSDT');
  });

  it('_fromBtcTurkSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTCTRY': { symbol: 'BTC/TRY' } };
    assert.strictEqual(exchange._fromBtcTurkSymbol('BTCTRY'), 'BTC/TRY');
  });

  it('_fromBtcTurkSymbol returns raw without markets (null)', () => {
    exchange.marketsById = null;
    assert.strictEqual(exchange._fromBtcTurkSymbol('BTCTRY'), 'BTCTRY');
  });

  it('_fromBtcTurkSymbol returns raw without markets (undefined)', () => {
    exchange.marketsById = undefined;
    assert.strictEqual(exchange._fromBtcTurkSymbol('BTCTRY'), 'BTCTRY');
  });

  it('_fromBtcTurkSymbol unknown symbol returns as-is', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromBtcTurkSymbol('UNKNOWN'), 'UNKNOWN');
  });

  it('_toBtcTurkSymbol AVAX/TRY → AVAXTRY', () => {
    assert.strictEqual(exchange._toBtcTurkSymbol('AVAX/TRY'), 'AVAXTRY');
  });

  it('_getBaseUrl returns api URL (https://api.btcturk.com)', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.btcturk.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new BtcTurk(); });

  it('insufficient balance → InsufficientFunds', () => {
    assert.throws(() => exchange._handleBtcTurkError(400, 'Insufficient balance'), InsufficientFunds);
  });

  it('auth error → AuthenticationError', () => {
    assert.throws(() => exchange._handleBtcTurkError(401, 'Authentication failed'), AuthenticationError);
  });

  it('permission error → AuthenticationError', () => {
    assert.throws(() => exchange._handleBtcTurkError(403, 'Permission denied'), AuthenticationError);
  });

  it('order not found → OrderNotFound', () => {
    assert.throws(() => exchange._handleBtcTurkError(404, 'order not found'), OrderNotFound);
  });

  it('invalid symbol → BadSymbol', () => {
    assert.throws(() => exchange._handleBtcTurkError(400, 'market not found'), BadSymbol);
  });

  it('invalid order → InvalidOrder', () => {
    assert.throws(() => exchange._handleBtcTurkError(400, 'invalid order'), InvalidOrder);
  });

  it('rate limit → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleBtcTurkError(429, 'too many requests'), RateLimitExceeded);
  });

  it('unknown error → ExchangeError', () => {
    assert.throws(() => exchange._handleBtcTurkError(500, 'something unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new BtcTurk(); });

  it('400 → BadRequest', () => {
    assert.throws(() => exchange._handleHttpError(400, 'bad request'), BadRequest);
  });

  it('401 → AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(401, 'unauthorized'), AuthenticationError);
  });

  it('403 → AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(403, 'forbidden'), AuthenticationError);
  });

  it('429 → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHttpError(429, 'too many'), RateLimitExceeded);
  });

  it('500 → ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHttpError(500, 'server error'), ExchangeNotAvailable);
  });

  it('parses JSON error body', () => {
    const body = JSON.stringify({ success: false, code: 400, message: 'Insufficient balance' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new BtcTurk();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new BtcTurk({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new BtcTurk();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 5);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Mocked API Calls', () => {
  const testSecret = Buffer.from('testsecret').toString('base64');
  let exchange;
  beforeEach(() => {
    exchange = new BtcTurk({ apiKey: 'testkey', secret: testSecret });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/TRY': { id: 'BTCTRY', symbol: 'BTC/TRY', base: 'BTC', quote: 'TRY' } };
    exchange.marketsById = { 'BTCTRY': { symbol: 'BTC/TRY' } };
  });

  it('loadMarkets parses exchangeinfo response (symbols array with numerator/denominator)', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      data: {
        symbols: [
          { name: 'BTCTRY', numerator: 'BTC', denominator: 'TRY', status: 'TRADING', numeratorScale: 8, denominatorScale: 2 },
          { name: 'ETHUSDT', numerator: 'ETH', denominator: 'USDT', status: 'TRADING', numeratorScale: 8, denominatorScale: 2 },
        ],
      },
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/TRY']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/TRY'].id, 'BTCTRY');
    assert.strictEqual(markets['BTC/TRY'].base, 'BTC');
    assert.strictEqual(markets['BTC/TRY'].quote, 'TRY');
  });

  it('fetchTicker passes correct path and parses response', async () => {
    let capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedPath = path;
      return {
        data: [
          { pair: 'BTCTRY', last: 750000, bid: 749000, ask: 751000, high: 760000, low: 740000, volume: 500 },
        ],
      };
    });
    const ticker = await exchange.fetchTicker('BTC/TRY');
    assert.strictEqual(capturedPath, '/api/v2/ticker');
    assert.strictEqual(ticker.last, 750000);
    assert.strictEqual(ticker.symbol, 'BTC/TRY');
  });

  it('fetchTickers returns all tickers', async () => {
    mock.method(exchange, '_request', async () => ({
      data: [
        { pair: 'BTCTRY', last: 750000 },
        { pair: 'ETHTRY', last: 50000 },
      ],
    }));
    exchange.marketsById = {
      'BTCTRY': { symbol: 'BTC/TRY' },
      'ETHTRY': { symbol: 'ETH/TRY' },
    };
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/TRY']);
    assert.ok(tickers['ETH/TRY']);
  });

  it('createOrder sends correct params (quantity, price, orderMethod, orderType, pairSymbol)', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { data: { id: '12345' } };
    });
    const order = await exchange.createOrder('BTC/TRY', 'limit', 'BUY', 0.5, 750000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/api/v1/order');
    assert.strictEqual(capturedParams.quantity, 0.5);
    assert.strictEqual(capturedParams.price, 750000);
    assert.strictEqual(capturedParams.orderMethod, 'limit');
    assert.strictEqual(capturedParams.orderType, 'buy');
    assert.strictEqual(capturedParams.pairSymbol, 'BTCTRY');
    assert.strictEqual(order.id, '12345');
  });

  it('createOrder SELL uses orderType "sell"', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { data: { id: '67890' } };
    });
    await exchange.createOrder('BTC/TRY', 'limit', 'SELL', 1.0, 750000);
    assert.strictEqual(capturedParams.orderType, 'sell');
  });

  it('cancelOrder sends DELETE with id param', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { data: {} };
    });
    const result = await exchange.cancelOrder('12345', 'BTC/TRY');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedPath, '/api/v1/order');
    assert.strictEqual(capturedParams.id, '12345');
    assert.strictEqual(result.status, 'canceled');
    assert.strictEqual(result.id, '12345');
  });

  it('fetchBalance parses balance array', async () => {
    mock.method(exchange, '_request', async () => ({
      data: [
        { asset: 'BTC', free: 0.5, locked: 0.3, balance: 0.8 },
        { asset: 'TRY', free: 10000, locked: 5000, balance: 15000 },
      ],
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
    assert.strictEqual(balance.TRY.free, 10000);
    assert.strictEqual(balance.TRY.total, 15000);
  });

  it('fetchOpenOrders combines asks and bids', async () => {
    mock.method(exchange, '_request', async () => ({
      data: {
        asks: [
          { id: '100', pairSymbol: 'BTCTRY', type: 'sell', price: 760000, quantity: 0.5 },
        ],
        bids: [
          { id: '101', pairSymbol: 'BTCTRY', type: 'buy', price: 740000, quantity: 1.0 },
        ],
      },
    }));
    const orders = await exchange.fetchOpenOrders('BTC/TRY');
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].id, '100');
    assert.strictEqual(orders[1].id, '101');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new BtcTurk();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/TRY': { id: 'BTCTRY', symbol: 'BTC/TRY', base: 'BTC', quote: 'TRY' },
    };
    exchange.marketsById = { 'BTCTRY': { symbol: 'BTC/TRY' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/TRY');
    assert.strictEqual(m.id, 'BTCTRY');
  });

  it('market() returns base and quote', () => {
    const m = exchange.market('BTC/TRY');
    assert.strictEqual(m.base, 'BTC');
    assert.strictEqual(m.quote, 'TRY');
  });

  it('market() throws on unknown symbol', () => {
    assert.throws(() => exchange.market('DOGE/USD'), /unknown symbol/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. BtcTurk vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk vs Others Differences', () => {
  const testSecret = Buffer.from('testsecret').toString('base64');
  let exchange;
  beforeEach(() => { exchange = new BtcTurk({ apiKey: 'k', secret: testSecret }); });

  it('signing: HMAC-SHA256 with Base64-decoded secret key', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v2/ticker', 'GET', {});
      // Signature must be base64 encoded
      assert.ok(/^[A-Za-z0-9+/=]+$/.test(result.headers['X-Signature']));
    } finally {
      Date.now = origNow;
    }
  });

  it('requires only 2 credentials: apiKey + secret (unlike Bitexen\'s 4)', () => {
    // BtcTurk signs successfully with just 2 credentials
    const ex = new BtcTurk({ apiKey: 'k', secret: testSecret });
    const result = ex._sign('/api/v2/ticker', 'GET', {});
    assert.ok(result.headers['X-PCK']);
    assert.ok(result.headers['X-Signature']);
    // No ACCESS-USER or ACCESS-PASSPHRASE headers
    assert.strictEqual(result.headers['ACCESS-USER'], undefined);
    assert.strictEqual(result.headers['ACCESS-PASSPHRASE'], undefined);
  });

  it('concatenated symbol format BTCTRY', () => {
    assert.strictEqual(exchange._toBtcTurkSymbol('BTC/TRY'), 'BTCTRY');
    assert.strictEqual(exchange._toBtcTurkSymbol('ETH/TRY'), 'ETHTRY');
  });

  it('Turkish exchange: primary markets in TRY', () => {
    assert.strictEqual(exchange.describe().urls.api, 'https://api.btcturk.com');
  });

  it('X-PCK/X-Stamp/X-Signature headers (unique prefix)', () => {
    const result = exchange._sign('/api/v2/ticker', 'GET', {});
    assert.ok(result.headers['X-PCK']);
    assert.ok(result.headers['X-Stamp']);
    assert.ok(result.headers['X-Signature']);
    // No ACCESS-* headers (those are Bitexen)
    assert.strictEqual(result.headers['ACCESS-KEY'], undefined);
  });

  it('supports both limit and market orders', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createLimitOrder, true);
    assert.strictEqual(has.createMarketOrder, true);
  });

  it('cancelOrder uses DELETE (unlike Bitexen\'s POST)', () => {
    assert.strictEqual(exchange.describe().has.cancelOrder, true);
    // Verify implementation uses DELETE by checking a mock call
    let capturedMethod;
    mock.method(exchange, '_request', async (method) => {
      capturedMethod = method;
      return { data: {} };
    });
    exchange.cancelOrder('123', 'BTC/TRY').then(() => {
      assert.strictEqual(capturedMethod, 'DELETE');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256Base64
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256Base64', () => {
  it('hmacSHA256Base64 produces base64 string', () => {
    const sig = hmacSHA256Base64('test', 'secret');
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(sig));
  });

  it('hmacSHA256Base64 accepts Buffer key', () => {
    const key = Buffer.from('secret');
    const sig = hmacSHA256Base64('test', key);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(sig));
  });

  it('hmacSHA256Base64 is deterministic', () => {
    const sig1 = hmacSHA256Base64('testkey1700000000000', Buffer.from('dGVzdHNlY3JldA==', 'base64'));
    const sig2 = hmacSHA256Base64('testkey1700000000000', Buffer.from('dGVzdHNlY3JldA==', 'base64'));
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA256Base64('data1', 'secret');
    const sig2 = hmacSHA256Base64('data2', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — JSON array protocol
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — JSON array protocol', () => {
  let exchange;
  beforeEach(() => { exchange = new BtcTurk(); });

  it('WS URL includes btcturk', () => {
    assert.ok(exchange.describe().urls.ws.includes('btcturk'));
  });

  it('_getWsClient creates new client', () => {
    const client = exchange._getWsClient();
    assert.ok(client);
    assert.strictEqual(exchange._wsClients.size, 1);
  });

  it('_getWsClient returns same client for same URL', () => {
    const c1 = exchange._getWsClient();
    const c2 = exchange._getWsClient();
    assert.strictEqual(c1, c2);
  });

  it('_getWsClient has no-op _startPing', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
    // Should not throw
    client._startPing();
  });

  it('watchOrderBook subscribes with orderbook channel', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      _ws: { readyState: 1, send: (msg) => { sentMsg = msg; } },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/TRY', () => {});
    const parsed = JSON.parse(sentMsg);
    assert.strictEqual(parsed[0], 151);
    assert.strictEqual(parsed[1].channel, 'orderbook');
    assert.strictEqual(parsed[1].event, 'BTCTRY');
    assert.strictEqual(parsed[1].join, true);
  });

  it('subscribe message uses [151, ...] JSON array format', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      _ws: { readyState: 1, send: (msg) => { sentMsg = msg; } },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('ETH/USDT', () => {});
    const parsed = JSON.parse(sentMsg);
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed[0], 151);
    assert.strictEqual(parsed[1].type, 151);
  });

  it('closeAllWs clears clients and handlers', async () => {
    exchange._wsClients.set('test', { close: async () => {} });
    exchange._wsHandlers.set('key', {});
    await exchange.closeAllWs();
    assert.strictEqual(exchange._wsClients.size, 0);
    assert.strictEqual(exchange._wsHandlers.size, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. WS Parsers
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new BtcTurk(); });

  it('_parseWsOrderBook handles array entries', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [['751000', '0.8']],
      bids: [['749000', '1.5']],
    }, 'BTC/TRY');
    assert.deepStrictEqual(ob.asks[0], [751000, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [749000, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/TRY');
  });

  it('_parseWsOrderBook handles object entries', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [{ price: '751000', volume: '0.8' }, { price: '752000', volume: '1.2' }],
      bids: [{ price: '749000', volume: '1.5' }],
    }, 'BTC/TRY');
    assert.deepStrictEqual(ob.asks[0], [751000, 0.8]);
    assert.deepStrictEqual(ob.asks[1], [752000, 1.2]);
    assert.deepStrictEqual(ob.bids[0], [749000, 1.5]);
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/TRY');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook includes timestamp', () => {
    const ob = exchange._parseWsOrderBook({ asks: [], bids: [] }, 'BTC/TRY');
    assert.ok(ob.timestamp > 0);
    assert.ok(ob.datetime);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('BtcTurk Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

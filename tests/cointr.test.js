'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Cointr = require('../lib/cointr');
const { hmacSHA256 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Cointr
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Cointr', () => {
  it('exports Cointr class', () => {
    assert.strictEqual(typeof lib.Cointr, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.cointr, lib.Cointr);
  });

  it('includes cointr in exchanges list', () => {
    assert.ok(lib.exchanges.includes('cointr'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Cointr Constructor
// ═══════════════════════════════════════════════════════════════
describe('Cointr Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('sets id to cointr', () => {
    assert.strictEqual(exchange.describe().id, 'cointr');
  });

  it('sets name to CoinTR', () => {
    assert.strictEqual(exchange.describe().name, 'CoinTR');
  });

  it('sets version to v1', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('has empty timeframes', () => {
    assert.deepStrictEqual(exchange.describe().timeframes, {});
  });

  it('has correct fees (0.1% maker/taker)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.001);
  });

  it('stores apiKey from config', () => {
    const ex = new Cointr({ apiKey: 'mykey' });
    assert.strictEqual(ex.apiKey, 'mykey');
  });

  it('stores secret from config', () => {
    const ex = new Cointr({ secret: 'mysecret' });
    assert.strictEqual(ex.secret, 'mysecret');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — Double-layer HMAC-SHA256
// ═══════════════════════════════════════════════════════════════
describe('Authentication — Double-layer HMAC-SHA256', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Cointr({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Cointr({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/v1/spot/trade/order', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Cointr({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/v1/spot/trade/order', 'POST', {}), /secret required/);
  });

  it('returns X-COINTR-APIKEY header', () => {
    const result = exchange._sign('/v1/spot/trade/order', 'POST', {});
    assert.strictEqual(result.headers['X-COINTR-APIKEY'], 'testkey');
  });

  it('returns X-COINTR-SIGN header (64-char hex)', () => {
    const result = exchange._sign('/v1/spot/trade/order', 'POST', { sz: '1' });
    assert.ok(/^[0-9a-f]{64}$/.test(result.headers['X-COINTR-SIGN']));
  });

  it('POST signing: double HMAC-SHA256 with deterministic output', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { instId: 'BTCUSDT', side: 'buy', ordType: 'limit', sz: '0.5', px: '30000' };
      const result = exchange._sign('/v1/spot/trade/order', 'POST', params);

      const timestamp = '1700000000000';
      const queryString = 'timestamp=' + timestamp;
      const bodyStr = JSON.stringify(params);
      const totalParams = queryString + bodyStr;

      const tempKey = hmacSHA256(String(Math.floor(1700000000000 / 30000)), 'testsecret');
      const expected = hmacSHA256(totalParams, tempKey);

      assert.strictEqual(result.headers['X-COINTR-SIGN'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('GET signing: params include timestamp in query string', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { instId: 'BTCUSDT' };
      const result = exchange._sign('/v1/spot/market/tickers', 'GET', params);

      // For GET, params should include timestamp
      assert.strictEqual(result.params.timestamp, '1700000000000');
      assert.strictEqual(result.params.instId, 'BTCUSDT');
    } finally {
      Date.now = origNow;
    }
  });

  it('GET signing: double HMAC-SHA256 with deterministic output', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { instId: 'BTCUSDT' };
      const result = exchange._sign('/v1/spot/market/tickers', 'GET', params);

      const allParams = { ...params, timestamp: '1700000000000' };
      const queryString = new URLSearchParams(allParams).toString();
      const bodyStr = '';
      const totalParams = queryString + bodyStr;

      const tempKey = hmacSHA256(String(Math.floor(1700000000000 / 30000)), 'testsecret');
      const expected = hmacSHA256(totalParams, tempKey);

      assert.strictEqual(result.headers['X-COINTR-SIGN'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('POST: params do not include timestamp (it goes in _queryString)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { instId: 'BTCUSDT', side: 'buy' };
      const result = exchange._sign('/v1/spot/trade/order', 'POST', params);

      // POST params should NOT include timestamp
      assert.strictEqual(result.params.timestamp, undefined);
      // timestamp goes in _queryString
      assert.strictEqual(result._queryString, 'timestamp=1700000000000');
    } finally {
      Date.now = origNow;
    }
  });

  it('POST with empty params: bodyStr is empty string', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/v1/spot/trade/order', 'POST', {});

      const queryString = 'timestamp=1700000000000';
      const bodyStr = '';
      const totalParams = queryString + bodyStr;

      const tempKey = hmacSHA256(String(Math.floor(1700000000000 / 30000)), 'testsecret');
      const expected = hmacSHA256(totalParams, tempKey);

      assert.strictEqual(result.headers['X-COINTR-SIGN'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('only requires 2 credentials (apiKey, secret)', () => {
    const desc = exchange.describe();
    assert.deepStrictEqual(desc.requiredCredentials, ['apiKey', 'secret']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Cointr Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('unwraps data.data envelope', () => {
    const result = exchange._unwrapResponse({ code: '0', msg: '', data: { ordId: '123' } });
    assert.strictEqual(result.ordId, '123');
  });

  it('code !== "0" throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: '50000', msg: 'Unknown error' }),
      ExchangeError
    );
  });

  it('array data passes through', () => {
    const arr = [{ ccy: 'BTC', availBal: '0.5' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('handles msg field for error messages', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: '50001', msg: 'Insufficient balance' }),
      InsufficientFunds
    );
  });

  it('code "0" with data returns unwrapped data', () => {
    const result = exchange._unwrapResponse({ code: '0', msg: 'success', data: [{ instId: 'BTCUSDT' }] });
    assert.ok(Array.isArray(result));
    assert.strictEqual(result[0].instId, 'BTCUSDT');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Cointr Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('_parseTicker extracts all fields', () => {
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
    const t = exchange._parseTicker({
      instId: 'BTCUSDT', last: '30000', high24h: '31000', low24h: '29000',
      bidPx: '29900', askPx: '30100', open24h: '29500',
      vol24h: '1500', volCcy24h: '45000000', ts: 1700000000000,
    });
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 30000);
    assert.strictEqual(t.high, 31000);
    assert.strictEqual(t.low, 29000);
    assert.strictEqual(t.bid, 29900);
    assert.strictEqual(t.ask, 30100);
    assert.strictEqual(t.open, 29500);
    assert.strictEqual(t.volume, 1500);
    assert.strictEqual(t.quoteVolume, 45000000);
    assert.strictEqual(t.timestamp, 1700000000000);
  });

  it('_parseOrder extracts ordId', () => {
    const o = exchange._parseOrder({ ordId: 'ORD123', instId: 'BTCUSDT' }, 'BTC/USDT');
    assert.strictEqual(o.id, 'ORD123');
  });

  it('_parseOrder maps side buy/sell', () => {
    const buy = exchange._parseOrder({ ordId: '1', side: 'buy' }, 'BTC/USDT');
    assert.strictEqual(buy.side, 'BUY');
    const sell = exchange._parseOrder({ ordId: '2', side: 'sell' }, 'BTC/USDT');
    assert.strictEqual(sell.side, 'SELL');
  });

  it('_parseOrder maps ordType limit/market', () => {
    const limit = exchange._parseOrder({ ordId: '1', ordType: 'limit' }, 'BTC/USDT');
    assert.strictEqual(limit.type, 'LIMIT');
    const market = exchange._parseOrder({ ordId: '2', ordType: 'market' }, 'BTC/USDT');
    assert.strictEqual(market.type, 'MARKET');
  });

  it('_parseOrder maps state to status', () => {
    const live = exchange._parseOrder({ ordId: '1', state: 'live' }, 'BTC/USDT');
    assert.strictEqual(live.status, 'open');
    const partial = exchange._parseOrder({ ordId: '2', state: 'partially_filled' }, 'BTC/USDT');
    assert.strictEqual(partial.status, 'open');
    const filled = exchange._parseOrder({ ordId: '3', state: 'filled' }, 'BTC/USDT');
    assert.strictEqual(filled.status, 'closed');
    const canceled = exchange._parseOrder({ ordId: '4', state: 'canceled' }, 'BTC/USDT');
    assert.strictEqual(canceled.status, 'canceled');
  });

  it('_parseOrderBook handles array entries [[price, amount], ...]', () => {
    const ob = exchange._parseOrderBook({
      asks: [['30100', '0.8'], ['30200', '1.2']],
      bids: [['29900', '1.5'], ['29800', '2.0']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseBalance extracts ccy, availBal, frozenBal, bal', () => {
    const b = exchange._parseBalance([
      { ccy: 'BTC', availBal: '0.5', frozenBal: '0.3', bal: '0.8' },
      { ccy: 'USDT', availBal: '10000', frozenBal: '5000', bal: '15000' },
    ]);
    assert.strictEqual(b.BTC.free, 0.5);
    assert.strictEqual(b.BTC.used, 0.3);
    assert.strictEqual(b.BTC.total, 0.8);
    assert.strictEqual(b.USDT.free, 10000);
    assert.strictEqual(b.USDT.used, 5000);
    assert.strictEqual(b.USDT.total, 15000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Cointr Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('_toCointrSymbol BTC/USDT -> BTCUSDT', () => {
    assert.strictEqual(exchange._toCointrSymbol('BTC/USDT'), 'BTCUSDT');
  });

  it('_toCointrSymbol ETH/USDT -> ETHUSDT', () => {
    assert.strictEqual(exchange._toCointrSymbol('ETH/USDT'), 'ETHUSDT');
  });

  it('_toCointrSymbol AVAX/USDT -> AVAXUSDT', () => {
    assert.strictEqual(exchange._toCointrSymbol('AVAX/USDT'), 'AVAXUSDT');
  });

  it('_fromCointrSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromCointrSymbol('BTCUSDT'), 'BTC/USDT');
  });

  it('_fromCointrSymbol returns raw without markets', () => {
    assert.strictEqual(exchange._fromCointrSymbol('BTCUSDT'), 'BTCUSDT');
  });

  it('_fromCointrSymbol unknown symbol returns as-is', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromCointrSymbol('UNKNOWN'), 'UNKNOWN');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.cointr.pro');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Cointr Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('insufficient -> InsufficientFunds', () => {
    assert.throws(() => exchange._handleCointrError('50001', 'Insufficient balance'), InsufficientFunds);
  });

  it('auth -> AuthenticationError', () => {
    assert.throws(() => exchange._handleCointrError('40001', 'Authentication failed'), AuthenticationError);
  });

  it('permission -> AuthenticationError', () => {
    assert.throws(() => exchange._handleCointrError('40003', 'Permission denied'), AuthenticationError);
  });

  it('order not found -> OrderNotFound', () => {
    assert.throws(() => exchange._handleCointrError('51001', 'Order not found'), OrderNotFound);
  });

  it('symbol/instrument -> BadSymbol', () => {
    assert.throws(() => exchange._handleCointrError('51002', 'Invalid instrument'), BadSymbol);
  });

  it('invalid order -> InvalidOrder', () => {
    assert.throws(() => exchange._handleCointrError('51003', 'Invalid order size'), InvalidOrder);
  });

  it('rate limit -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleCointrError('50011', 'Rate limit exceeded'), RateLimitExceeded);
  });

  it('unknown -> ExchangeError', () => {
    assert.throws(() => exchange._handleCointrError('99999', 'Something unknown happened'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Cointr HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('400 -> BadRequest', () => {
    assert.throws(() => exchange._handleHttpError(400, 'bad request'), BadRequest);
  });

  it('401 -> AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(401, 'unauthorized'), AuthenticationError);
  });

  it('403 -> AuthenticationError', () => {
    assert.throws(() => exchange._handleHttpError(403, 'forbidden'), AuthenticationError);
  });

  it('429 -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleHttpError(429, 'too many requests'), RateLimitExceeded);
  });

  it('500 -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHttpError(500, 'server error'), ExchangeNotAvailable);
  });

  it('parses JSON error body', () => {
    const body = JSON.stringify({ code: '50001', msg: 'Insufficient balance' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Cointr Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Cointr();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Cointr({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Cointr();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Cointr Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Cointr({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses instruments response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      code: '0',
      msg: '',
      data: [
        { instId: 'BTCUSDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', tickSz: '0.01', lotSz: '0.00001' },
        { instId: 'ETHUSDT', baseCcy: 'ETH', quoteCcy: 'USDT', state: 'live', tickSz: '0.01', lotSz: '0.0001' },
      ],
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTCUSDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
  });

  it('fetchTicker parses tickers response (finds by instId)', async () => {
    mock.method(exchange, '_request', async () => ({
      code: '0',
      data: [
        { instId: 'BTCUSDT', last: '30000', high24h: '31000', low24h: '29000', bidPx: '29900', askPx: '30100' },
        { instId: 'ETHUSDT', last: '2000' },
      ],
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 30000);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('fetchTickers returns all tickers', async () => {
    exchange.marketsById = {
      'BTCUSDT': { symbol: 'BTC/USDT' },
      'ETHUSDT': { symbol: 'ETH/USDT' },
    };
    mock.method(exchange, '_request', async () => ({
      code: '0',
      data: [
        { instId: 'BTCUSDT', last: '30000' },
        { instId: 'ETHUSDT', last: '2000' },
      ],
    }));
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/USDT']);
    assert.ok(tickers['ETH/USDT']);
  });

  it('createOrder sends correct params (instId, side, ordType, sz, px, clOrdId)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '0', data: { ordId: 'ORD123', sCode: '0', clOrdId: 'test-uuid' } };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5, 30000);
    assert.strictEqual(capturedParams.instId, 'BTCUSDT');
    assert.strictEqual(capturedParams.side, 'buy');
    assert.strictEqual(capturedParams.ordType, 'limit');
    assert.strictEqual(capturedParams.sz, '0.5');
    assert.strictEqual(capturedParams.px, '30000');
    assert.ok(capturedParams.clOrdId);
    assert.strictEqual(order.id, 'ORD123');
  });

  it('createOrder auto-generates clOrdId (UUID format)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '0', data: { ordId: 'ORD456', sCode: '0' } };
    });
    await exchange.createOrder('BTC/USDT', 'limit', 'buy', 1.0, 30000);
    // clOrdId should be a UUID: xxxxxxxx-xxxx-...
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(capturedParams.clOrdId));
  });

  it('createOrder market type omits px', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '0', data: { ordId: 'ORD789', sCode: '0' } };
    });
    await exchange.createOrder('BTC/USDT', 'market', 'buy', 0.5);
    assert.strictEqual(capturedParams.ordType, 'market');
    assert.strictEqual(capturedParams.px, undefined);
  });

  it('cancelOrder sends instId + ordId', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { code: '0', data: { ordId: '12345', sCode: '0' } };
    });
    const result = await exchange.cancelOrder('12345', 'BTC/USDT');
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/v1/spot/trade/cancel-order');
    assert.strictEqual(capturedParams.instId, 'BTCUSDT');
    assert.strictEqual(capturedParams.ordId, '12345');
    assert.strictEqual(result.status, 'canceled');
    assert.strictEqual(result.id, '12345');
  });

  it('fetchBalance parses balance response', async () => {
    mock.method(exchange, '_request', async () => ({
      code: '0',
      data: [
        { ccy: 'BTC', availBal: '0.5', frozenBal: '0.3', bal: '0.8' },
        { ccy: 'USDT', availBal: '10000', frozenBal: '5000', bal: '15000' },
      ],
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
    assert.strictEqual(balance.USDT.free, 10000);
    assert.strictEqual(balance.USDT.total, 15000);
  });

  it('fetchOpenOrders parses orders-active response', async () => {
    mock.method(exchange, '_request', async () => ({
      code: '0',
      data: [
        { ordId: 'ORD1', instId: 'BTCUSDT', side: 'buy', ordType: 'limit', sz: '0.5', px: '30000', state: 'live' },
        { ordId: 'ORD2', instId: 'BTCUSDT', side: 'sell', ordType: 'limit', sz: '1.0', px: '35000', state: 'partially_filled' },
      ],
    }));
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].id, 'ORD1');
    assert.strictEqual(orders[0].status, 'open');
    assert.strictEqual(orders[1].id, 'ORD2');
    assert.strictEqual(orders[1].status, 'open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Cointr Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Cointr();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTCUSDT');
  });

  it('market() returns base and quote', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.base, 'BTC');
    assert.strictEqual(m.quote, 'USDT');
  });

  it('market() throws on unknown symbol', () => {
    assert.throws(() => exchange.market('DOGE/USD'), /unknown symbol/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. CoinTR vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('CoinTR vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr({ apiKey: 'k', secret: 's' }); });

  it('double-layer HMAC-SHA256 signing (unique)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/v1/spot/trade/order', 'POST', { sz: '1' });
      // Signature must be 64-char lowercase hex (double HMAC)
      assert.ok(/^[0-9a-f]{64}$/.test(result.headers['X-COINTR-SIGN']));
    } finally {
      Date.now = origNow;
    }
  });

  it('concatenated symbol format BTCUSDT (no separator)', () => {
    assert.strictEqual(exchange._toCointrSymbol('BTC/USDT'), 'BTCUSDT');
    assert.strictEqual(exchange._toCointrSymbol('ETH/USDT'), 'ETHUSDT');
  });

  it('X-COINTR-APIKEY/X-COINTR-SIGN headers', () => {
    const result = exchange._sign('/v1/spot/trade/order', 'POST', {});
    assert.ok(result.headers['X-COINTR-APIKEY']);
    assert.ok(result.headers['X-COINTR-SIGN']);
    // Only two auth headers (no USER/PASSPHRASE unlike Bitexen)
    assert.strictEqual(Object.keys(result.headers).length, 2);
  });

  it('mandatory clOrdId (auto-generated UUID)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '0', data: { ordId: 'ORD1', sCode: '0' } };
    });
    await exchange.createOrder('BTC/USDT', 'limit', 'buy', 1.0, 30000);
    assert.ok(capturedParams.clOrdId);
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(capturedParams.clOrdId));
  });

  it('timestamp in query string for all signed requests', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      // GET: timestamp in params
      const getResult = exchange._sign('/v1/spot/asset/balance', 'GET', {});
      assert.strictEqual(getResult.params.timestamp, '1700000000000');

      // POST: timestamp in _queryString
      const postResult = exchange._sign('/v1/spot/trade/order', 'POST', { sz: '1' });
      assert.strictEqual(postResult._queryString, 'timestamp=1700000000000');
    } finally {
      Date.now = origNow;
    }
  });

  it('code "0" means success (string, not number)', () => {
    // Should NOT throw when code is '0'
    const result = exchange._unwrapResponse({ code: '0', msg: '', data: { ok: true } });
    assert.strictEqual(result.ok, true);

    // Should throw when code is non-'0' string
    assert.throws(
      () => exchange._unwrapResponse({ code: '50000', msg: 'Error' }),
      ExchangeError
    );
  });

  it('OKX-like API style (instId, ordType, sz, px fields)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { code: '0', data: { ordId: 'ORD1', sCode: '0' } };
    });
    await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5, 30000);
    // OKX-style field names
    assert.ok('instId' in capturedParams);
    assert.ok('ordType' in capturedParams);
    assert.ok('sz' in capturedParams);
    assert.ok('px' in capturedParams);
    assert.ok('clOrdId' in capturedParams);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256 double-layer
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256 double-layer for Cointr', () => {
  it('hmacSHA256 produces 64-char hex string', () => {
    const sig = hmacSHA256('test', 'secret');
    assert.strictEqual(sig.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(sig));
  });

  it('hmacSHA256 is deterministic', () => {
    const sig1 = hmacSHA256('timestamp=1700000000000{"sz":"1"}', 'tempkey');
    const sig2 = hmacSHA256('timestamp=1700000000000{"sz":"1"}', 'tempkey');
    assert.strictEqual(sig1, sig2);
  });

  it('double hmacSHA256 chain produces expected result', () => {
    // Simulate CoinTR's double-layer signing
    const timestamp = '1700000000000';
    const secret = 'testsecret';

    const tempKey = hmacSHA256(String(Math.floor(parseInt(timestamp) / 30000)), secret);
    assert.strictEqual(tempKey.length, 64);

    const totalParams = 'timestamp=' + timestamp + '{"instId":"BTCUSDT"}';
    const signature = hmacSHA256(totalParams, tempKey);
    assert.strictEqual(signature.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(signature));

    // Verify deterministic
    const signature2 = hmacSHA256(totalParams, tempKey);
    assert.strictEqual(signature, signature2);
  });

  it('different data produces different signatures', () => {
    const tempKey = hmacSHA256('56666', 'secret');
    const sig1 = hmacSHA256('timestamp=1700000000000{"side":"buy"}', tempKey);
    const sig2 = hmacSHA256('timestamp=1700000000000{"side":"sell"}', tempKey);
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — op/subscribe/args
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — op/subscribe/args', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('WS URL includes cointr', () => {
    assert.ok(exchange.describe().urls.ws.includes('cointr'));
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

  it('watchOrderBook subscribes with books channel and instId', async () => {
    let subscribedMsg;
    const fakeClient = {
      connected: true,
      subscribe: (id, msg) => { subscribedMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    assert.ok(subscribedMsg);
    assert.strictEqual(subscribedMsg.op, 'subscribe');
    assert.strictEqual(subscribedMsg.args[0].channel, 'books');
    assert.strictEqual(subscribedMsg.args[0].instId, 'BTCUSDT');
  });

  it('_getWsClient has overridden _startPing for text ping', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
    // Should not throw
    client._startPing();
    // Clean up interval
    if (client._pingTimer) clearInterval(client._pingTimer);
  });

  it('closeAllWs clears clients and handlers', async () => {
    exchange._wsClients.set('test', { close: async () => {} });
    exchange._wsHandlers.set('key', {});
    exchange._orderBooks.set('BTC/USDT', {});
    await exchange.closeAllWs();
    assert.strictEqual(exchange._wsClients.size, 0);
    assert.strictEqual(exchange._wsHandlers.size, 0);
    assert.strictEqual(exchange._orderBooks.size, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. WS Parsers
// ═══════════════════════════════════════════════════════════════
describe('Cointr WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Cointr(); });

  it('_parseOrderBook handles snapshot with array entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [['30100', '0.8'], ['30200', '1.2']],
      bids: [['29900', '1.5'], ['29800', '2.0']],
      ts: 1700000000000,
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
    assert.strictEqual(ob.timestamp, 1700000000000);
  });

  it('_parseOrderBook handles object entries with px/sz', () => {
    const ob = exchange._parseOrderBook({
      asks: [{ px: '30100', sz: '0.8' }],
      bids: [{ px: '29900', sz: '1.5' }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_applyOrderBookUpdate applies incremental updates', () => {
    const book = {
      symbol: 'BTC/USDT',
      asks: [[30100, 0.8], [30200, 1.2]],
      bids: [[29900, 1.5], [29800, 2.0]],
    };

    // Update: modify an ask, remove a bid (amount=0), add new entry
    exchange._applyOrderBookUpdate(book, {
      asks: [['30100', '1.0'], ['30300', '0.5']],
      bids: [['29800', '0']],
    });

    // 30100 updated to 1.0
    assert.deepStrictEqual(book.asks[0], [30100, 1.0]);
    // 30300 added
    assert.ok(book.asks.find(a => a[0] === 30300));
    // 29800 removed (amount 0)
    assert.ok(!book.bids.find(b => b[0] === 29800));
    // 29900 still present
    assert.ok(book.bids.find(b => b[0] === 29900));
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Cointr Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

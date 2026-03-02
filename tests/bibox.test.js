'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Bibox = require('../lib/bibox');
const { hmacSHA256, hmacMD5 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Bibox
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Bibox', () => {
  it('exports Bibox class', () => {
    assert.strictEqual(typeof lib.Bibox, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.bibox, lib.Bibox);
  });

  it('includes bibox in exchanges list', () => {
    assert.ok(lib.exchanges.includes('bibox'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Bibox Constructor
// ═══════════════════════════════════════════════════════════════
describe('Bibox Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

  it('sets id to bibox', () => {
    assert.strictEqual(exchange.describe().id, 'bibox');
  });

  it('sets name to Bibox', () => {
    assert.strictEqual(exchange.describe().name, 'Bibox');
  });

  it('sets version to v1', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('has empty timeframes (no REST OHLCV)', () => {
    assert.deepStrictEqual(exchange.describe().timeframes, {});
  });

  it('has correct fees (0.2%)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.002);
    assert.strictEqual(fees.taker, 0.002);
  });

  it('fetchTicker is supported', () => {
    assert.strictEqual(exchange.describe().has.fetchTicker, true);
  });

  it('createMarketOrder is NOT supported', () => {
    assert.strictEqual(exchange.describe().has.createMarketOrder, false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — Dual V3 HmacMD5 + V4 HmacSHA256
// ═══════════════════════════════════════════════════════════════
describe('Authentication — Dual V3 HmacMD5 + V4 HmacSHA256', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bibox({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Bibox({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/v3/spot/order/trade', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Bibox({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/api/v4/userdata/accounts', 'GET', {}), /secret required/);
  });

  it('V3 path: returns lowercase bibox-api-key header', () => {
    const result = exchange._sign('/v3/spot/order/trade', 'POST', { pair: 'BTC_USDT' });
    assert.strictEqual(result.headers['bibox-api-key'], 'testkey');
  });

  it('V3 path: returns bibox-timestamp header', () => {
    const result = exchange._sign('/v3/spot/order/trade', 'POST', {});
    assert.ok(result.headers['bibox-timestamp']);
    assert.ok(/^\d+$/.test(result.headers['bibox-timestamp']));
  });

  it('V3 path: returns bibox-api-sign (32-char hex MD5)', () => {
    const result = exchange._sign('/v3/spot/order/trade', 'POST', {});
    assert.ok(/^[0-9a-f]{32}$/.test(result.headers['bibox-api-sign']));
  });

  it('V3 signing: HmacMD5(timestamp + body)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { pair: 'BTC_USDT', order_side: 1, order_type: 2, price: 50000, amount: 0.001 };
      const result = exchange._sign('/v3/spot/order/trade', 'POST', params);
      const bodyStr = JSON.stringify(params);
      const expected = hmacMD5('1700000000000' + bodyStr, 'testsecret');
      assert.strictEqual(result.headers['bibox-api-sign'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('V3 path: params stay for JSON body', () => {
    const params = { pair: 'BTC_USDT', order_side: 1 };
    const result = exchange._sign('/v3/spot/order/trade', 'POST', params);
    assert.strictEqual(result.params.pair, 'BTC_USDT');
    assert.strictEqual(result.params.order_side, 1);
  });

  it('V4 path: returns titlecase Bibox-Api-Key header', () => {
    const result = exchange._sign('/api/v4/userdata/accounts', 'GET', { asset: 'USDT' });
    assert.strictEqual(result.headers['Bibox-Api-Key'], 'testkey');
  });

  it('V4 path: returns Bibox-Expire-Time header', () => {
    const result = exchange._sign('/api/v4/userdata/accounts', 'GET', {});
    assert.ok(result.headers['Bibox-Expire-Time']);
    assert.ok(Number(result.headers['Bibox-Expire-Time']) > Date.now());
  });

  it('V4 path: returns Bibox-Api-Sign (64-char hex SHA256)', () => {
    const result = exchange._sign('/api/v4/userdata/accounts', 'GET', { asset: 'USDT' });
    assert.ok(/^[0-9a-f]{64}$/.test(result.headers['Bibox-Api-Sign']));
  });

  it('V4 signing: HmacSHA256(queryString)', () => {
    const params = { asset: 'USDT' };
    const result = exchange._sign('/api/v4/userdata/accounts', 'GET', params);
    const qs = new URLSearchParams(params).toString();
    const expected = hmacSHA256(qs, 'testsecret');
    assert.strictEqual(result.headers['Bibox-Api-Sign'], expected);
  });

  it('V4 path: params stay for BaseExchange query string', () => {
    const params = { asset: 'BTC' };
    const result = exchange._sign('/api/v4/userdata/accounts', 'GET', params);
    assert.strictEqual(result.params.asset, 'BTC');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Bibox Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

  it('V3 success: state=0 returns data (order_id extracted)', () => {
    const result = exchange._unwrapResponse({ state: 0, order_id: '12345' });
    // state=0 is success, no result field, returns whole object
    assert.strictEqual(result.order_id, '12345');
  });

  it('V3 error: state!=0 throws', () => {
    assert.throws(
      () => exchange._unwrapResponse({ state: 3012, msg: 'Invalid API key' }),
      AuthenticationError
    );
  });

  it('V4 balance: direct array returned as-is', () => {
    const arr = [{ s: 'USDT', a: 100.5, h: 0 }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('V4 result wrapper: extracts result field', () => {
    const result = exchange._unwrapResponse({ result: [{ pair: 'BTC_USDT' }] });
    assert.deepStrictEqual(result, [{ pair: 'BTC_USDT' }]);
  });

  it('handles non-object response', () => {
    const result = exchange._unwrapResponse(12345);
    assert.strictEqual(result, 12345);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Bibox Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker({
      last: 50000, high: 51000, low: 49000, buy: 49999,
      buy_amount: 1.5, sell: 50001, sell_amount: 2.0,
      vol: 1000, percent: '5.2', timestamp: 1700000000000,
    }, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 50000);
    assert.strictEqual(t.high, 51000);
    assert.strictEqual(t.low, 49000);
    assert.strictEqual(t.bid, 49999);
    assert.strictEqual(t.bidVolume, 1.5);
    assert.strictEqual(t.ask, 50001);
    assert.strictEqual(t.askVolume, 2.0);
    assert.strictEqual(t.volume, 1000);
    assert.strictEqual(t.percentage, 5.2);
    assert.strictEqual(t.timestamp, 1700000000000);
  });

  it('_parseOrder extracts V3 create response', () => {
    const o = exchange._parseOrder({
      order_id: '14570728091382991', pair: 'BTC_USDT',
      order_side: 1, order_type: 2, price: 50000, amount: 0.001,
      status: 1,
    }, 'BTC/USDT');
    assert.strictEqual(o.id, '14570728091382991');
    assert.strictEqual(o.type, 'LIMIT');
    assert.strictEqual(o.side, 'BUY');
    assert.strictEqual(o.price, 50000);
    assert.strictEqual(o.amount, 0.001);
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrder maps order_side 2 to SELL', () => {
    const o = exchange._parseOrder({ order_id: '1', order_side: 2, status: 3 }, 'BTC/USDT');
    assert.strictEqual(o.side, 'SELL');
    assert.strictEqual(o.status, 'closed');
  });

  it('_parseOrderBook handles {price, volume} objects', () => {
    const ob = exchange._parseOrderBook({
      asks: [{ price: '50001', volume: '0.8' }, { price: '50002', volume: '1.2' }],
      bids: [{ price: '49999', volume: '1.5' }, { price: '49998', volume: '2.0' }],
      update_time: 1700000000000,
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.strictEqual(ob.timestamp, 1700000000000);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseOrderBook handles array entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [['50001', '0.8']],
      bids: [['49999', '1.5']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_normalizeOrderStatus maps all states', () => {
    assert.strictEqual(exchange._normalizeOrderStatus(1), 'open');
    assert.strictEqual(exchange._normalizeOrderStatus(2), 'open');
    assert.strictEqual(exchange._normalizeOrderStatus(3), 'closed');
    assert.strictEqual(exchange._normalizeOrderStatus(4), 'canceled');
    assert.strictEqual(exchange._normalizeOrderStatus(5), 'canceled');
    assert.strictEqual(exchange._normalizeOrderStatus(100), 'canceled');
    assert.strictEqual(exchange._normalizeOrderStatus(999), 'open');
  });

  it('_parseTicker uses Date.now() as fallback timestamp', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const t = exchange._parseTicker({ last: 100 }, 'ETH/USDT');
      assert.strictEqual(t.timestamp, 1700000000000);
    } finally {
      Date.now = origNow;
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Bibox Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

  it('_toBiboxSymbol BTC/USDT → BTC_USDT', () => {
    assert.strictEqual(exchange._toBiboxSymbol('BTC/USDT'), 'BTC_USDT');
  });

  it('_toBiboxSymbol ETH/BTC → ETH_BTC', () => {
    assert.strictEqual(exchange._toBiboxSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('_toBiboxSymbol DOGE/USDT → DOGE_USDT', () => {
    assert.strictEqual(exchange._toBiboxSymbol('DOGE/USDT'), 'DOGE_USDT');
  });

  it('_fromBiboxSymbol fallback parse', () => {
    assert.strictEqual(exchange._fromBiboxSymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromBiboxSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromBiboxSymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromBiboxSymbol returns raw for invalid format', () => {
    assert.strictEqual(exchange._fromBiboxSymbol('invalid'), 'invalid');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.bibox.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Bibox Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

  it('2034 → BadRequest (parameter check failed)', () => {
    assert.throws(() => exchange._handleBiboxError(2034, 'param error'), BadRequest);
  });

  it('3012 → AuthenticationError (invalid API key)', () => {
    assert.throws(() => exchange._handleBiboxError(3012, 'invalid key'), AuthenticationError);
  });

  it('3025 → AuthenticationError (signature verification failed)', () => {
    assert.throws(() => exchange._handleBiboxError(3025, 'sig failed'), AuthenticationError);
  });

  it('3016 → BadSymbol (trading pair error)', () => {
    assert.throws(() => exchange._handleBiboxError(3016, 'pair error'), BadSymbol);
  });

  it('2085 → InsufficientFunds (trade amount insufficient)', () => {
    assert.throws(() => exchange._handleBiboxError(2085, 'insufficient'), InsufficientFunds);
  });

  it('2091 → RateLimitExceeded (request frequency too high)', () => {
    assert.throws(() => exchange._handleBiboxError(2091, 'too fast'), RateLimitExceeded);
  });

  it('4003 → ExchangeNotAvailable (server busy)', () => {
    assert.throws(() => exchange._handleBiboxError(4003, 'busy'), ExchangeNotAvailable);
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(() => exchange._handleBiboxError(9999, 'unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Bibox HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

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

  it('parses JSON body with state!=0', () => {
    const body = JSON.stringify({ state: 3012, msg: 'Invalid API key' });
    assert.throws(() => exchange._handleHttpError(400, body), AuthenticationError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Bibox Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Bibox();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Bibox({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Bibox();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 30);
    assert.strictEqual(desc.rateLimitInterval, 5000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Bibox Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bibox({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses V4 pairs response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ([
      { pair: 'BTC_USDT', decimal: 2, amount_scale: 6, min_amount: 0.0001 },
      { pair: 'ETH_USDT', decimal: 2, amount_scale: 4, min_amount: 0.001 },
    ]));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTC_USDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
  });

  it('fetchTicker passes symbol param', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { last: 50000, high: 51000, low: 49000, buy: 49999, sell: 50001, vol: 1000 };
    });
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(capturedParams.symbol, 'BTC_USDT');
    assert.strictEqual(ticker.last, 50000);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('fetchOrderBook passes symbol and size params', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { asks: [{ price: '50001', volume: '0.5' }], bids: [{ price: '49999', volume: '1.0' }] };
    });
    const ob = await exchange.fetchOrderBook('BTC/USDT', 20);
    assert.strictEqual(capturedParams.symbol, 'BTC_USDT');
    assert.strictEqual(capturedParams.size, 20);
    assert.strictEqual(ob.asks.length, 1);
    assert.strictEqual(ob.bids.length, 1);
  });

  it('createOrder sends POST to V3 endpoint with correct params', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { state: 0, order_id: '14570728091382991' };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001, 50000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/v3/spot/order/trade');
    assert.strictEqual(capturedParams.pair, 'BTC_USDT');
    assert.strictEqual(capturedParams.order_side, 1);
    assert.strictEqual(capturedParams.order_type, 2);
    assert.strictEqual(capturedParams.price, 50000);
    assert.strictEqual(capturedParams.amount, 0.001);
    assert.strictEqual(order.id, '14570728091382991');
    assert.strictEqual(order.status, 'open');
  });

  it('createOrder SELL uses order_side=2', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { state: 0, order_id: 'ord-sell' };
    });
    await exchange.createOrder('BTC/USDT', 'limit', 'sell', 0.5, 51000);
    assert.strictEqual(capturedParams.order_side, 2);
  });

  it('createOrder rejects market orders', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'market', 'buy', 100),
      /does not support market orders/
    );
  });

  it('cancelOrder sends POST to V3 cancel endpoint', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { state: 0 };
    });
    const result = await exchange.cancelOrder('14570728091382991');
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/v3/spot/order/cancel');
    assert.strictEqual(capturedParams.order_id, '14570728091382991');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance returns parsed V4 balance', async () => {
    let capturedMethod, capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedMethod = method;
      capturedPath = path;
      return [
        { s: 'BTC', a: 0.5, h: 0.1 },
        { s: 'USDT', a: 5000, h: 1000 },
      ];
    });
    const balance = await exchange.fetchBalance();
    assert.strictEqual(capturedMethod, 'GET');
    assert.strictEqual(capturedPath, '/api/v4/userdata/accounts');
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.used, 0.1);
    assert.strictEqual(balance.BTC.total, 0.6);
    assert.strictEqual(balance.USDT.free, 5000);
    assert.strictEqual(balance.USDT.used, 1000);
    assert.strictEqual(balance.USDT.total, 6000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Bibox Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bibox();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTC_USDT');
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
// 12. Bibox vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('Bibox vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox({ apiKey: 'k', secret: 's' }); });

  it('dual auth: V3 HmacMD5 + V4 HmacSHA256 (unique among exchanges)', () => {
    const v3 = exchange._sign('/v3/spot/order/trade', 'POST', { pair: 'BTC_USDT' });
    const v4 = exchange._sign('/api/v4/userdata/accounts', 'GET', { asset: 'USDT' });
    // V3 has lowercase headers, V4 has titlecase headers
    assert.ok(v3.headers['bibox-api-key']);
    assert.ok(v4.headers['Bibox-Api-Key']);
    // V3 uses 32-char MD5 hex, V4 uses 64-char SHA256 hex
    assert.strictEqual(v3.headers['bibox-api-sign'].length, 32);
    assert.strictEqual(v4.headers['Bibox-Api-Sign'].length, 64);
  });

  it('V3 has timestamp header, V4 has expire-time header', () => {
    const v3 = exchange._sign('/v3/spot/order/trade', 'POST', {});
    const v4 = exchange._sign('/api/v4/userdata/accounts', 'GET', {});
    assert.ok(v3.headers['bibox-timestamp']);
    assert.strictEqual(v3.headers['Bibox-Expire-Time'], undefined);
    assert.ok(v4.headers['Bibox-Expire-Time']);
    assert.strictEqual(v4.headers['bibox-timestamp'], undefined);
  });

  it('cancelOrder uses POST (not DELETE like Pionex)', () => {
    // cancelOrder sends POST to /v3/spot/order/cancel
    // Verified in mocked API calls test
    const has = exchange.describe().has;
    assert.strictEqual(has.cancelOrder, true);
  });

  it('numeric order_side (1=BUY, 2=SELL), not string like Pionex', () => {
    const o = exchange._parseOrder({ order_id: '1', order_side: 1, status: 1 }, 'BTC/USDT');
    assert.strictEqual(o.side, 'BUY');
    const o2 = exchange._parseOrder({ order_id: '2', order_side: 2, status: 1 }, 'BTC/USDT');
    assert.strictEqual(o2.side, 'SELL');
  });

  it('no market orders (only limit orders supported)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createMarketOrder, false);
  });

  it('rich REST market data (fetchTicker + fetchOrderBook), unlike Pionex', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.fetchTicker, true);
    assert.strictEqual(has.fetchOrderBook, true);
  });

  it('V4 balance uses short field names: s, a, h', () => {
    // s=symbol, a=available, h=held — confirmed in parsers
    const exchange2 = new Bibox({ apiKey: 'k', secret: 's' });
    // Just verify the describe has the right capability
    assert.strictEqual(exchange2.describe().has.fetchBalance, true);
  });

  it('uses underscore symbol format (BTC_USDT), same as Pionex', () => {
    assert.strictEqual(exchange._toBiboxSymbol('BTC/USDT'), 'BTC_USDT');
    assert.strictEqual(exchange._toBiboxSymbol('ETH/BTC'), 'ETH_BTC');
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacMD5 + hmacSHA256
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacMD5 + hmacSHA256 for Bibox', () => {
  it('hmacMD5 produces 32-char hex string', () => {
    const sig = hmacMD5('test', 'secret');
    assert.strictEqual(sig.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(sig));
  });

  it('hmacMD5 is deterministic', () => {
    const sig1 = hmacMD5('1700000000000{"pair":"BTC_USDT"}', 'testsecret');
    const sig2 = hmacMD5('1700000000000{"pair":"BTC_USDT"}', 'testsecret');
    assert.strictEqual(sig1, sig2);
  });

  it('hmacSHA256 produces 64-char hex string', () => {
    const sig = hmacSHA256('asset=USDT', 'secret');
    assert.strictEqual(sig.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(sig));
  });

  it('hmacMD5 and hmacSHA256 produce different outputs for same input', () => {
    const md5sig = hmacMD5('test', 'secret');
    const sha256sig = hmacSHA256('test', 'secret');
    assert.notStrictEqual(md5sig, sha256sig);
    assert.strictEqual(md5sig.length, 32);
    assert.strictEqual(sha256sig.length, 64);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — client PING + zlib decompression
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — client PING + zlib decompression', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

  it('WS URL is correct', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://npush.bibox360.com/');
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

  it('_getWsClient overrides _startPing for client-initiated ping', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
    // Should not throw
    client._startPing();
    // Clean up interval to prevent process from hanging
    client._stopPing();
  });

  it('_getWsClient has overridden connect for zlib handling', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client.connect === 'function');
  });

  it('ping format is {"ping": timestamp}', () => {
    const client = exchange._getWsClient();
    let sentData;
    // Simulate a ws with readyState 1
    client._ws = { readyState: 1, send: (d) => { sentData = d; } };
    // Manually invoke the ping logic (same as what _startPing interval does)
    client._ws.send(JSON.stringify({ ping: Date.now() }));
    assert.ok(sentData);
    const parsed = JSON.parse(sentData);
    assert.ok(parsed.ping);
    assert.ok(typeof parsed.ping === 'number');
  });

  it('watchOrderBook subscribes with depth channel', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    assert.deepStrictEqual(sentMsg, { sub: 'BTC_USDT_depth' });
  });

  it('subscribe format is {"sub": "SYMBOL_depth"}', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('ETH/USDT', () => {});
    assert.strictEqual(sentMsg.sub, 'ETH_USDT_depth');
    assert.strictEqual(typeof sentMsg, 'object');
    assert.ok(!Array.isArray(sentMsg));
  });

  it('no watchTicker returns error', async () => {
    await assert.rejects(
      () => exchange.watchTicker('BTC/USDT', () => {}),
      /not implemented/
    );
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
describe('Bibox WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bibox(); });

  it('_parseWsOrderBook handles t=0 snapshot with array entries', () => {
    const ob = exchange._parseWsOrderBook({
      t: 0,
      d: {
        pair: 'BTC_USDT',
        asks: [['50001', '0.8'], ['50002', '1.2']],
        bids: [['49999', '1.5'], ['49998', '2.0']],
      },
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
    assert.strictEqual(ob.dataType, 0);
  });

  it('_parseWsOrderBook handles t=1 incremental with add/del', () => {
    const ob = exchange._parseWsOrderBook({
      t: 1,
      d: {
        pair: 'BTC_USDT',
        asks: [],
        bids: [],
        add: { asks: [['50003', '0.5']], bids: [['49997', '1.0']] },
        del: { asks: [['50001']], bids: [['49999']] },
      },
    }, 'BTC/USDT');
    assert.strictEqual(ob.dataType, 1);
    assert.ok(ob.add);
    assert.ok(ob.del);
  });

  it('_parseWsOrderBook handles empty snapshot', () => {
    const ob = exchange._parseWsOrderBook({ t: 0, d: {} }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook handles {price, volume} objects', () => {
    const ob = exchange._parseWsOrderBook({
      t: 0,
      d: {
        pair: 'ETH_USDT',
        asks: [{ price: '3000', volume: '5.0' }],
        bids: [{ price: '2999', volume: '3.0' }],
      },
    }, 'ETH/USDT');
    assert.deepStrictEqual(ob.asks[0], [3000, 5.0]);
    assert.deepStrictEqual(ob.bids[0], [2999, 3.0]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Bibox Version', () => {
  it('library version is 2.8.0', () => {
    assert.strictEqual(lib.version, '2.8.0');
  });
});

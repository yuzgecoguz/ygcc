'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Pionex = require('../lib/pionex');
const { hmacSHA256 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Pionex
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Pionex', () => {
  it('exports Pionex class', () => {
    assert.strictEqual(typeof lib.Pionex, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.pionex, lib.Pionex);
  });

  it('includes pionex in exchanges list', () => {
    assert.ok(lib.exchanges.includes('pionex'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Pionex Constructor
// ═══════════════════════════════════════════════════════════════
describe('Pionex Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

  it('sets id to pionex', () => {
    assert.strictEqual(exchange.describe().id, 'pionex');
  });

  it('sets name to Pionex', () => {
    assert.strictEqual(exchange.describe().name, 'Pionex');
  });

  it('sets version to v1', () => {
    assert.strictEqual(exchange.describe().version, 'v1');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('has empty timeframes (no OHLCV support)', () => {
    assert.deepStrictEqual(exchange.describe().timeframes, {});
  });

  it('has correct fees', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.001);
  });

  it('fetchTicker is not supported', () => {
    assert.strictEqual(exchange.describe().has.fetchTicker, false);
  });

  it('createMarketOrder is supported', () => {
    assert.strictEqual(exchange.describe().has.createMarketOrder, true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — HMAC-SHA256 header-based
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA256 header-based', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Pionex({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Pionex({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/api/v1/trade/order', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Pionex({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/api/v1/trade/order', 'POST', {}), /secret required/);
  });

  it('GET: returns PIONEX-KEY header', () => {
    const result = exchange._sign('/api/v1/account/balances', 'GET', {});
    assert.strictEqual(result.headers['PIONEX-KEY'], 'testkey');
  });

  it('GET: returns PIONEX-SIGNATURE header (64-char hex)', () => {
    const result = exchange._sign('/api/v1/account/balances', 'GET', {});
    assert.ok(/^[0-9a-f]{64}$/.test(result.headers['PIONEX-SIGNATURE']));
  });

  it('GET: empties params (URL contains everything)', () => {
    const params = { orderId: '123' };
    const result = exchange._sign('/api/v1/trade/order', 'GET', params);
    assert.deepStrictEqual(result.params, {});
  });

  it('GET: URL includes all sorted params', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { symbol: 'BTC_USDT', orderId: '123' };
      const result = exchange._sign('/api/v1/trade/order', 'GET', params);
      // sorted: orderId, symbol, timestamp
      assert.ok(result.url.includes('orderId=123'));
      assert.ok(result.url.includes('symbol=BTC_USDT'));
      assert.ok(result.url.includes('timestamp=1700000000000'));
      // Verify sort order in URL
      const qs = result.url.split('?')[1];
      assert.ok(qs.indexOf('orderId') < qs.indexOf('symbol'));
      assert.ok(qs.indexOf('symbol') < qs.indexOf('timestamp'));
    } finally {
      Date.now = origNow;
    }
  });

  it('GET: signing string format is GET + path + ? + sortedRawQS', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = {};
      const result = exchange._sign('/api/v1/account/balances', 'GET', params);
      // Manually compute expected signature
      const expected = hmacSHA256('GET/api/v1/account/balances?timestamp=1700000000000', 'testsecret');
      assert.strictEqual(result.headers['PIONEX-SIGNATURE'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('POST: returns PIONEX-KEY and PIONEX-SIGNATURE headers', () => {
    const result = exchange._sign('/api/v1/trade/order', 'POST', { symbol: 'BTC_USDT', side: 'BUY' });
    assert.strictEqual(result.headers['PIONEX-KEY'], 'testkey');
    assert.ok(/^[0-9a-f]{64}$/.test(result.headers['PIONEX-SIGNATURE']));
  });

  it('POST: URL has timestamp in query string', () => {
    const result = exchange._sign('/api/v1/trade/order', 'POST', { symbol: 'BTC_USDT' });
    assert.ok(result.url.includes('?timestamp='));
  });

  it('POST: params stay for JSON body', () => {
    const params = { symbol: 'BTC_USDT', side: 'BUY' };
    const result = exchange._sign('/api/v1/trade/order', 'POST', params);
    assert.strictEqual(result.params.symbol, 'BTC_USDT');
    assert.strictEqual(result.params.side, 'BUY');
  });

  it('POST: signing string includes JSON body', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { symbol: 'BTC_USDT', side: 'BUY', type: 'MARKET', amount: '100' };
      const result = exchange._sign('/api/v1/trade/order', 'POST', params);
      const bodyStr = JSON.stringify(params);
      const expected = hmacSHA256('POST/api/v1/trade/order?timestamp=1700000000000' + bodyStr, 'testsecret');
      assert.strictEqual(result.headers['PIONEX-SIGNATURE'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('DELETE: empties params (body handled by _request override)', () => {
    const params = { orderId: '123', symbol: 'BTC_USDT' };
    const result = exchange._sign('/api/v1/trade/order', 'DELETE', params);
    assert.deepStrictEqual(result.params, {});
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Pionex Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

  it('extracts data field on success', () => {
    const result = exchange._unwrapResponse({ result: true, data: { orderId: '123' }, timestamp: 1234567890 });
    assert.deepStrictEqual(result, { orderId: '123' });
  });

  it('passes through array data', () => {
    const result = exchange._unwrapResponse({ result: true, data: [1, 2, 3] });
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('throws on result=false', () => {
    assert.throws(
      () => exchange._unwrapResponse({ result: false, code: 'TRADE_INVALID_SYMBOL', message: 'invalid' }),
      BadSymbol
    );
  });

  it('handles missing data field — returns whole object as fallback', () => {
    const input = { result: true };
    const result = exchange._unwrapResponse(input);
    assert.strictEqual(result, input);
  });

  it('handles non-object response', () => {
    const result = exchange._unwrapResponse(12345);
    assert.strictEqual(result, 12345);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Pionex Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

  it('_parseOrder extracts all fields', () => {
    const o = exchange._parseOrder({
      orderId: 'ord-1', clientOrderId: 'client-1', symbol: 'BTC_USDT',
      type: 'LIMIT', side: 'BUY', price: 50000, size: 0.5,
      filledSize: 0.2, filledAmount: 10000, fee: 5, feeCoin: 'USDT',
      status: 'OPEN', createTime: 1700000000000,
    }, 'BTC/USDT');
    assert.strictEqual(o.id, 'ord-1');
    assert.strictEqual(o.clientOrderId, 'client-1');
    assert.strictEqual(o.type, 'LIMIT');
    assert.strictEqual(o.side, 'BUY');
    assert.strictEqual(o.price, 50000);
    assert.strictEqual(o.amount, 0.5);
    assert.strictEqual(o.filled, 0.2);
    assert.strictEqual(o.remaining, 0.3);
    assert.strictEqual(o.cost, 10000);
    assert.strictEqual(o.average, 50000);
    assert.strictEqual(o.status, 'open');
    assert.deepStrictEqual(o.fee, { cost: 5, currency: 'USDT' });
  });

  it('_parseOrder resolves symbol via marketsById', () => {
    exchange.marketsById = { 'ETH_USDT': { symbol: 'ETH/USDT' } };
    const o = exchange._parseOrder({ orderId: '1', symbol: 'ETH_USDT', status: 'CLOSED' }, undefined);
    assert.strictEqual(o.symbol, 'ETH/USDT');
    assert.strictEqual(o.status, 'closed');
  });

  it('_parseOrder uses fallbackSymbol when no symbol in data', () => {
    const o = exchange._parseOrder({ orderId: '1', status: 'CANCELED' }, 'BTC/USDT');
    assert.strictEqual(o.symbol, 'BTC/USDT');
    assert.strictEqual(o.status, 'canceled');
  });

  it('_parseOrder omits fee when fee=0', () => {
    const o = exchange._parseOrder({ orderId: '1', fee: 0, status: 'OPEN' }, 'BTC/USDT');
    assert.strictEqual(o.fee, undefined);
  });

  it('_normalizeOrderStatus maps all states', () => {
    assert.strictEqual(exchange._normalizeOrderStatus('OPEN'), 'open');
    assert.strictEqual(exchange._normalizeOrderStatus('CLOSED'), 'closed');
    assert.strictEqual(exchange._normalizeOrderStatus('CANCELED'), 'canceled');
    assert.strictEqual(exchange._normalizeOrderStatus('UNKNOWN'), 'unknown');
  });

  it('_parseMyTrade extracts fields with role', () => {
    const t = exchange._parseMyTrade({
      id: 'fill-1', orderId: 'ord-1', symbol: 'BTC_USDT',
      side: 'BUY', price: 50000, size: 0.1, fee: 2.5,
      feeCoin: 'USDT', role: 'TAKER', timestamp: 1700000000000,
    }, 'BTC/USDT');
    assert.strictEqual(t.id, 'fill-1');
    assert.strictEqual(t.orderId, 'ord-1');
    assert.strictEqual(t.side, 'BUY');
    assert.strictEqual(t.price, 50000);
    assert.strictEqual(t.amount, 0.1);
    assert.strictEqual(t.cost, 5000);
    assert.deepStrictEqual(t.fee, { cost: 2.5, currency: 'USDT' });
    assert.strictEqual(t.role, 'taker');
  });

  it('_parseMyTrade role MAKER → maker', () => {
    const t = exchange._parseMyTrade({ id: '1', role: 'MAKER', price: 100, size: 1 }, 'BTC/USDT');
    assert.strictEqual(t.role, 'maker');
  });

  it('_parseMyTrade omits fee when fee=0', () => {
    const t = exchange._parseMyTrade({ id: '1', fee: 0, price: 100, size: 1 }, 'BTC/USDT');
    assert.strictEqual(t.fee, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Pionex Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

  it('_toPionexSymbol BTC/USDT → BTC_USDT', () => {
    assert.strictEqual(exchange._toPionexSymbol('BTC/USDT'), 'BTC_USDT');
  });

  it('_toPionexSymbol ETH/BTC → ETH_BTC', () => {
    assert.strictEqual(exchange._toPionexSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('_toPionexSymbol DOGE/USDT → DOGE_USDT', () => {
    assert.strictEqual(exchange._toPionexSymbol('DOGE/USDT'), 'DOGE_USDT');
  });

  it('_fromPionexSymbol fallback parse', () => {
    assert.strictEqual(exchange._fromPionexSymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromPionexSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromPionexSymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromPionexSymbol returns raw for invalid format', () => {
    assert.strictEqual(exchange._fromPionexSymbol('invalid'), 'invalid');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.pionex.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Pionex Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

  it('TRADE_INVALID_SYMBOL → BadSymbol', () => {
    assert.throws(() => exchange._handlePionexError('TRADE_INVALID_SYMBOL', 'bad symbol'), BadSymbol);
  });

  it('TRADE_PARAMETER_ERROR → BadRequest', () => {
    assert.throws(() => exchange._handlePionexError('TRADE_PARAMETER_ERROR', 'param error'), BadRequest);
  });

  it('PARAMETER_ERROR → BadRequest', () => {
    assert.throws(() => exchange._handlePionexError('PARAMETER_ERROR', 'param error'), BadRequest);
  });

  it('INVALID_API_KEY → AuthenticationError', () => {
    assert.throws(() => exchange._handlePionexError('INVALID_API_KEY', 'bad key'), AuthenticationError);
  });

  it('INSUFFICIENT_BALANCE → InsufficientFunds', () => {
    assert.throws(() => exchange._handlePionexError('INSUFFICIENT_BALANCE', 'no funds'), InsufficientFunds);
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(() => exchange._handlePionexError('UNKNOWN_CODE', 'unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Pionex HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

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

  it('parses JSON body with result=false', () => {
    const body = JSON.stringify({ result: false, code: 'INSUFFICIENT_BALANCE', message: 'no funds' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Pionex Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Pionex();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Pionex({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Pionex();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Pionex Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Pionex({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets filters SPOT+enabled', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      result: true,
      data: {
        symbols: [
          { symbol: 'BTC_USDT', baseCurrency: 'BTC', quoteCurrency: 'USDT', enable: true, type: 'SPOT', basePrecision: 6, quotePrecision: 2 },
          { symbol: 'ETH_USDT', baseCurrency: 'ETH', quoteCurrency: 'USDT', enable: false, type: 'SPOT', basePrecision: 4, quotePrecision: 2 },
          { symbol: 'BTC_USDT_PERP', baseCurrency: 'BTC', quoteCurrency: 'USDT', enable: true, type: 'PERP', basePrecision: 6, quotePrecision: 2 },
        ],
      },
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.strictEqual(markets['ETH/USDT'], undefined); // disabled
    assert.strictEqual(markets['BTC/USDT_PERP'], undefined); // not SPOT
    assert.strictEqual(markets['BTC/USDT'].id, 'BTC_USDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
  });

  it('createOrder LIMIT sends correct params', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { result: true, data: { orderId: 'ord-123' } };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001, 50000);
    assert.strictEqual(capturedParams.symbol, 'BTC_USDT');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.type, 'LIMIT');
    assert.strictEqual(capturedParams.size, '0.001');
    assert.strictEqual(capturedParams.price, '50000');
    assert.strictEqual(order.id, 'ord-123');
  });

  it('createOrder MARKET BUY uses amount (quote currency)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { result: true, data: { orderId: 'ord-456' } };
    });
    await exchange.createOrder('BTC/USDT', 'market', 'buy', 100);
    assert.strictEqual(capturedParams.type, 'MARKET');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.amount, '100');
    assert.strictEqual(capturedParams.size, undefined);
  });

  it('createOrder MARKET SELL uses size (base currency)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { result: true, data: { orderId: 'ord-789' } };
    });
    await exchange.createOrder('BTC/USDT', 'market', 'sell', 0.001);
    assert.strictEqual(capturedParams.type, 'MARKET');
    assert.strictEqual(capturedParams.side, 'SELL');
    assert.strictEqual(capturedParams.size, '0.001');
    assert.strictEqual(capturedParams.amount, undefined);
  });

  it('createOrder LIMIT throws without price', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001),
      /LIMIT requires price/
    );
  });

  it('cancelOrder sends DELETE with orderId and symbol', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { result: true, data: {} };
    });
    const result = await exchange.cancelOrder('ord-123', 'BTC/USDT');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedPath, '/api/v1/trade/order');
    assert.strictEqual(capturedParams.orderId, 'ord-123');
    assert.strictEqual(capturedParams.symbol, 'BTC_USDT');
    assert.strictEqual(result.status, 'canceled');
  });

  it('cancelAllOrders sends DELETE with symbol', async () => {
    let capturedMethod, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedParams = params;
      return { result: true, data: {} };
    });
    await exchange.cancelAllOrders('BTC/USDT');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedParams.symbol, 'BTC_USDT');
  });

  it('fetchBalance returns parsed balances with coin/free/frozen', async () => {
    mock.method(exchange, '_request', async () => ({
      result: true,
      data: {
        balances: [
          { coin: 'BTC', free: '0.5', frozen: '0.1' },
          { coin: 'USDT', free: '5000', frozen: '1000' },
        ],
      },
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.used, 0.1);
    assert.strictEqual(balance.BTC.total, 0.6);
    assert.strictEqual(balance.USDT.free, 5000);
    assert.strictEqual(balance.USDT.used, 1000);
  });

  it('fetchOrder returns parsed order', async () => {
    mock.method(exchange, '_request', async () => ({
      result: true,
      data: { orderId: 'ord-1', symbol: 'BTC_USDT', side: 'BUY', type: 'LIMIT', price: 50000, size: 0.5, filledSize: 0.2, filledAmount: 10000, status: 'OPEN' },
    }));
    const order = await exchange.fetchOrder('ord-1', 'BTC/USDT');
    assert.strictEqual(order.id, 'ord-1');
    assert.strictEqual(order.status, 'open');
    assert.strictEqual(order.filled, 0.2);
  });

  it('fetchOpenOrders returns array of parsed orders', async () => {
    mock.method(exchange, '_request', async () => ({
      result: true,
      data: { orders: [
        { orderId: 'ord-1', side: 'BUY', status: 'OPEN', price: 50000, size: 0.1 },
        { orderId: 'ord-2', side: 'SELL', status: 'OPEN', price: 51000, size: 0.2 },
      ] },
    }));
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].id, 'ord-1');
    assert.strictEqual(orders[1].id, 'ord-2');
  });

  it('fetchMyTrades returns parsed fills', async () => {
    mock.method(exchange, '_request', async () => ({
      result: true,
      data: { fills: [
        { id: 'fill-1', orderId: 'ord-1', side: 'BUY', price: 50000, size: 0.1, fee: 2.5, feeCoin: 'USDT', role: 'TAKER', timestamp: 1700000000000 },
      ] },
    }));
    const trades = await exchange.fetchMyTrades('BTC/USDT');
    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].id, 'fill-1');
    assert.strictEqual(trades[0].role, 'taker');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Pionex Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Pionex();
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
// 12. Pionex vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('Pionex vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex({ apiKey: 'k', secret: 's' }); });

  it('no REST market data (fetchTicker, fetchOrderBook, fetchTrades, fetchOHLCV all false)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.fetchTicker, false);
    assert.strictEqual(has.fetchOrderBook, false);
    assert.strictEqual(has.fetchTrades, false);
    assert.strictEqual(has.fetchOHLCV, false);
    assert.strictEqual(has.fetchTime, false);
  });

  it('auth in headers (PIONEX-KEY + PIONEX-SIGNATURE), not in query params', () => {
    const result = exchange._sign('/api/v1/account/balances', 'GET', {});
    assert.ok(result.headers['PIONEX-KEY']);
    assert.ok(result.headers['PIONEX-SIGNATURE']);
    // params emptied (no accessKey/signData in params)
    assert.strictEqual(result.params.accessKey, undefined);
    assert.strictEqual(result.params.signData, undefined);
  });

  it('HTTP method included in signing string (unlike Binance)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const p1 = {};
      const p2 = { symbol: 'BTC_USDT' };
      const r1 = exchange._sign('/api/v1/account/balances', 'GET', p1);
      const r2 = exchange._sign('/api/v1/trade/order', 'POST', p2);
      // Different methods → different signatures (even ignoring different paths/params)
      assert.notStrictEqual(r1.headers['PIONEX-SIGNATURE'], r2.headers['PIONEX-SIGNATURE']);
    } finally {
      Date.now = origNow;
    }
  });

  it('DELETE uses JSON body (not query string params)', () => {
    const params = { orderId: '123', symbol: 'BTC_USDT' };
    const result = exchange._sign('/api/v1/trade/order', 'DELETE', params);
    // params emptied — body handled by _request override
    assert.deepStrictEqual(result.params, {});
    // URL only has timestamp
    assert.ok(result.url.includes('?timestamp='));
    assert.ok(!result.url.includes('orderId'));
  });

  it('market order field divergence: BUY=amount, SELL=size', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createMarketOrder, true);
    // This is tested in mocked API calls, but verify has flag here
  });

  it('uses underscore symbol format (BTC_USDT)', () => {
    assert.strictEqual(exchange._toPionexSymbol('BTC/USDT'), 'BTC_USDT');
    assert.strictEqual(exchange._toPionexSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('postAsJson is true (unlike Bitforex which uses query string POST)', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('strong private API: cancelAllOrders, fetchOpenOrders, fetchClosedOrders, fetchMyTrades', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.cancelAllOrders, true);
    assert.strictEqual(has.fetchOpenOrders, true);
    assert.strictEqual(has.fetchClosedOrders, true);
    assert.strictEqual(has.fetchMyTrades, true);
  });

  it('no watchTicker or watchKlines (only watchOrderBook + watchTrades)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchTicker, false);
    assert.strictEqual(has.watchKlines, false);
    assert.strictEqual(has.watchOrderBook, true);
    assert.strictEqual(has.watchTrades, true);
  });

  it('string error codes (TRADE_INVALID_SYMBOL, not numeric)', () => {
    assert.throws(() => exchange._handlePionexError('TRADE_INVALID_SYMBOL', 'msg'), BadSymbol);
    assert.throws(() => exchange._handlePionexError('PARAMETER_ERROR', 'msg'), BadRequest);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256 for Pionex', () => {
  it('produces 64-char hex string', () => {
    const sig = hmacSHA256('test', 'secret');
    assert.strictEqual(sig.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(sig));
  });

  it('known test vector with method+path+query signing', () => {
    const signingString = 'GET/api/v1/account/balances?timestamp=1700000000000';
    const sig = hmacSHA256(signingString, 'testsecret');
    assert.strictEqual(sig.length, 64);
    // Same inputs always produce same output
    assert.strictEqual(hmacSHA256(signingString, 'testsecret'), sig);
  });

  it('different data produces different signature', () => {
    const sig1 = hmacSHA256('GET/path1?ts=1', 'secret');
    const sig2 = hmacSHA256('POST/path1?ts=1', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — server PING / client PONG
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — server PING / client PONG', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

  it('WS URL is correct', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://ws.pionex.com/wsPub');
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

  it('_getWsClient has overridden _startPing (no-op)', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
    // Should not throw
    client._startPing();
  });

  it('_getWsClient has overridden connect', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client.connect === 'function');
  });

  it('watchOrderBook subscribes with DEPTH topic', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    assert.strictEqual(sentMsg.op, 'SUBSCRIBE');
    assert.strictEqual(sentMsg.topic, 'DEPTH');
    assert.strictEqual(sentMsg.symbol, 'BTC_USDT');
    assert.strictEqual(sentMsg.limit, 100);
  });

  it('watchTrades subscribes with TRADE topic', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTrades('BTC/USDT', () => {});
    assert.strictEqual(sentMsg.op, 'SUBSCRIBE');
    assert.strictEqual(sentMsg.topic, 'TRADE');
    assert.strictEqual(sentMsg.symbol, 'BTC_USDT');
  });

  it('subscribe format is JSON object with op SUBSCRIBE', async () => {
    let sentMsg;
    const fakeClient = { connected: true, send: (msg) => { sentMsg = msg; }, on: () => {} };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('ETH/USDT', () => {}, 50);
    assert.strictEqual(typeof sentMsg, 'object');
    assert.ok(!Array.isArray(sentMsg));
    assert.strictEqual(sentMsg.op, 'SUBSCRIBE');
    assert.strictEqual(sentMsg.topic, 'DEPTH');
    assert.strictEqual(sentMsg.symbol, 'ETH_USDT');
    assert.strictEqual(sentMsg.limit, 50);
  });

  it('no watchTicker method returns error', async () => {
    // watchTicker is not implemented (inherited from BaseExchange which throws)
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
describe('Pionex WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Pionex(); });

  it('_parseWsOrderBook handles array entries [price, size]', () => {
    const ob = exchange._parseWsOrderBook({
      bids: [['49999', '1.5'], ['49998', '2.0']],
      asks: [['50001', '0.8'], ['50002', '1.2']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseWsOrderBook handles object entries {price, amount}', () => {
    const ob = exchange._parseWsOrderBook({
      bids: [{ price: 49999, amount: 1.5 }],
      asks: [{ price: 50001, amount: 0.8 }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids[0], [49999, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [50001, 0.8]);
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsTrade extracts fields', () => {
    const t = exchange._parseWsTrade({
      id: 't1', price: '50000', size: '0.1', side: 'BUY', timestamp: 1700000000000,
    }, 'BTC/USDT');
    assert.strictEqual(t.id, 't1');
    assert.strictEqual(t.price, 50000);
    assert.strictEqual(t.amount, 0.1);
    assert.strictEqual(t.side, 'buy');
    assert.strictEqual(t.timestamp, 1700000000000);
  });

  it('_parseWsTrade uses amount fallback when no size', () => {
    const t = exchange._parseWsTrade({
      id: 't2', price: '100', amount: '5', side: 'SELL',
    }, 'ETH/USDT');
    assert.strictEqual(t.amount, 5);
    assert.strictEqual(t.side, 'sell');
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Pionex Version', () => {
  it('library version is 2.5.0', () => {
    assert.strictEqual(lib.version, '2.5.0');
  });
});

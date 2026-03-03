'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const PointPay = require('../lib/pointpay');
const { hmacSHA512Hex } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — PointPay
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — PointPay', () => {
  it('exports PointPay class', () => {
    assert.strictEqual(typeof lib.PointPay, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.pointpay, lib.PointPay);
  });

  it('includes pointpay in exchanges list', () => {
    assert.ok(lib.exchanges.includes('pointpay'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. PointPay Constructor
// ═══════════════════════════════════════════════════════════════
describe('PointPay Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

  it('sets id to pointpay', () => {
    assert.strictEqual(exchange.describe().id, 'pointpay');
  });

  it('sets name to PointPay', () => {
    assert.strictEqual(exchange.describe().name, 'PointPay');
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
    const ex = new PointPay({ apiKey: 'mykey' });
    assert.strictEqual(ex.apiKey, 'mykey');
  });

  it('stores secret from config', () => {
    const ex = new PointPay({ secret: 'mysecret' });
    assert.strictEqual(ex.secret, 'mysecret');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — HMAC-SHA512 payload-based signing
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA512 payload-based signing', () => {
  let exchange;
  beforeEach(() => {
    exchange = new PointPay({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new PointPay({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/api/v1/account/balances', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new PointPay({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/api/v1/account/balances', 'POST', {}), /secret required/);
  });

  it('returns X-TXC-APIKEY header', () => {
    const result = exchange._sign('/api/v1/account/balances', 'POST', {});
    assert.strictEqual(result.headers['X-TXC-APIKEY'], 'testkey');
  });

  it('returns X-TXC-PAYLOAD header (base64)', () => {
    const result = exchange._sign('/api/v1/account/balances', 'POST', {});
    assert.ok(result.headers['X-TXC-PAYLOAD']);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(result.headers['X-TXC-PAYLOAD']));
  });

  it('returns X-TXC-SIGNATURE header (128-char hex)', () => {
    const result = exchange._sign('/api/v1/account/balances', 'POST', {});
    assert.ok(result.headers['X-TXC-SIGNATURE']);
    assert.ok(/^[0-9a-f]{128}$/.test(result.headers['X-TXC-SIGNATURE']));
  });

  it('payload = base64(JSON.stringify(body))', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { market: 'BTC_USDT' };
      const result = exchange._sign('/api/v1/orders', 'POST', params);

      const expectedBody = { market: 'BTC_USDT', request: '/api/v1/orders', nonce: '1700000000000' };
      const expectedPayload = Buffer.from(JSON.stringify(expectedBody)).toString('base64');

      assert.strictEqual(result.headers['X-TXC-PAYLOAD'], expectedPayload);
    } finally {
      Date.now = origNow;
    }
  });

  it('signature = hmacSHA512Hex(payload, secret)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v1/account/balances', 'POST', {});

      const body = { request: '/api/v1/account/balances', nonce: '1700000000000' };
      const payload = Buffer.from(JSON.stringify(body)).toString('base64');
      const expectedSig = hmacSHA512Hex(payload, 'testsecret');

      assert.strictEqual(result.headers['X-TXC-SIGNATURE'], expectedSig);
    } finally {
      Date.now = origNow;
    }
  });

  it('params include request path and nonce in body', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v1/orders', 'POST', { market: 'BTC_USDT' });

      assert.strictEqual(result.params.request, '/api/v1/orders');
      assert.strictEqual(result.params.nonce, '1700000000000');
      assert.strictEqual(result.params.market, 'BTC_USDT');
    } finally {
      Date.now = origNow;
    }
  });

  it('has exactly 3 auth headers', () => {
    const result = exchange._sign('/api/v1/account/balances', 'POST', {});
    assert.strictEqual(Object.keys(result.headers).length, 3);
  });

  it('works with both apiKey and secret provided', () => {
    const result = exchange._sign('/api/v1/account/balances', 'POST', {});
    assert.ok(result.headers['X-TXC-SIGNATURE']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('PointPay Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

  it('unwraps data.result envelope', () => {
    const result = exchange._unwrapResponse({ success: true, result: { id: '123' } });
    assert.strictEqual(result.id, '123');
  });

  it('success=false throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ success: false, message: 'Error' }),
      ExchangeError
    );
  });

  it('error field throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ error: 'Something failed' }),
      ExchangeError
    );
  });

  it('array data passes through', () => {
    const arr = [{ name: 'BTC_USDT' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('object without result passes through', () => {
    const obj = { name: 'BTC_USDT', stock: 'BTC' };
    const result = exchange._unwrapResponse(obj);
    assert.strictEqual(result.name, 'BTC_USDT');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('PointPay Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker({
      last: '30000', high: '31000', low: '29000', open: '29500',
      bid: '29900', ask: '30100', volume: '1500', deal: '45000000', change: '500',
    }, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 30000);
    assert.strictEqual(t.high, 31000);
    assert.strictEqual(t.low, 29000);
    assert.strictEqual(t.open, 29500);
    assert.strictEqual(t.bid, 29900);
    assert.strictEqual(t.ask, 30100);
    assert.strictEqual(t.volume, 1500);
    assert.strictEqual(t.quoteVolume, 45000000);
    assert.strictEqual(t.change, 500);
  });

  it('_parseOrder extracts orderId and maps fields', () => {
    const o = exchange._parseOrder({
      orderId: 'ORD123', market: 'BTC_USDT', side: 'buy', type: 'limit',
      price: '30000', amount: '0.5', left: '0.3', dealMoney: '6000',
    }, 'BTC/USDT');
    assert.strictEqual(o.id, 'ORD123');
    assert.strictEqual(o.symbol, 'BTC/USDT');
    assert.strictEqual(o.side, 'buy');
    assert.strictEqual(o.price, 30000);
    assert.strictEqual(o.amount, 0.5);
    assert.strictEqual(o.filled, 0.2);
    assert.strictEqual(o.remaining, 0.3);
    assert.strictEqual(o.cost, 6000);
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrder: fully filled order → closed', () => {
    const o = exchange._parseOrder({
      orderId: 'ORD456', amount: '1.0', left: '0',
    }, 'BTC/USDT');
    assert.strictEqual(o.status, 'closed');
    assert.strictEqual(o.filled, 1.0);
  });

  it('_parseOrderBook handles separate buy/sell data', () => {
    const ob = exchange._parseOrderBook(
      [{ price: '29900', amount: '1.5' }, { price: '29800', amount: '2.0' }],
      [{ price: '30100', amount: '0.8' }, { price: '30200', amount: '1.2' }],
      'BTC/USDT'
    );
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseOrderBook handles empty arrays', () => {
    const ob = exchange._parseOrderBook([], [], 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseBalance extracts currency with available/freeze', () => {
    const b = exchange._parseBalance({
      BTC: { available: '0.5', freeze: '0.3' },
      USDT: { available: '10000', freeze: '5000' },
    });
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
describe('PointPay Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

  it('_toPointPaySymbol BTC/USDT -> BTC_USDT', () => {
    assert.strictEqual(exchange._toPointPaySymbol('BTC/USDT'), 'BTC_USDT');
  });

  it('_toPointPaySymbol ETH/BTC -> ETH_BTC', () => {
    assert.strictEqual(exchange._toPointPaySymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('_fromPointPaySymbol BTC_USDT -> BTC/USDT', () => {
    assert.strictEqual(exchange._fromPointPaySymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromPointPaySymbol ETH_BTC -> ETH/BTC', () => {
    assert.strictEqual(exchange._fromPointPaySymbol('ETH_BTC'), 'ETH/BTC');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.pointpay.io');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('PointPay Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

  it('insufficient -> InsufficientFunds', () => {
    assert.throws(() => exchange._handlePointPayError('1001', 'Insufficient balance'), InsufficientFunds);
  });

  it('not enough -> InsufficientFunds', () => {
    assert.throws(() => exchange._handlePointPayError('1001', 'Not enough funds'), InsufficientFunds);
  });

  it('order not found -> OrderNotFound', () => {
    assert.throws(() => exchange._handlePointPayError('1002', 'Order not found'), OrderNotFound);
  });

  it('invalid market -> BadSymbol', () => {
    assert.throws(() => exchange._handlePointPayError('1003', 'Invalid market'), BadSymbol);
  });

  it('invalid order -> InvalidOrder', () => {
    assert.throws(() => exchange._handlePointPayError('1004', 'Invalid order amount'), InvalidOrder);
  });

  it('rate limit -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handlePointPayError('1005', 'Too many requests'), RateLimitExceeded);
  });

  it('auth -> AuthenticationError', () => {
    assert.throws(() => exchange._handlePointPayError('1006', 'Unauthorized access'), AuthenticationError);
  });

  it('maintenance -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handlePointPayError('1007', 'Service unavailable'), ExchangeNotAvailable);
  });

  it('unknown -> ExchangeError', () => {
    assert.throws(() => exchange._handlePointPayError('9999', 'Something happened'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('PointPay HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

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
    const body = JSON.stringify({ success: false, message: 'Insufficient balance' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('PointPay Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new PointPay();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new PointPay({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new PointPay();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('PointPay Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new PointPay({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTC_USDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses markets response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      success: true,
      result: [
        { name: 'BTC_USDT', stock: 'BTC', money: 'USDT', moneyPrec: 2, stockPrec: 6, minAmount: '0.0001' },
        { name: 'ETH_USDT', stock: 'ETH', money: 'USDT', moneyPrec: 2, stockPrec: 4 },
      ],
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTC_USDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
  });

  it('fetchTicker parses ticker response', async () => {
    mock.method(exchange, '_request', async () => ({
      success: true,
      result: { last: '30000', high: '31000', low: '29000', bid: '29900', ask: '30100', volume: '1500' },
    }));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 30000);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('fetchOrderBook calls two endpoints (buy+sell)', async () => {
    let callCount = 0;
    mock.method(exchange, '_request', async (method, path, params) => {
      callCount++;
      if (params.side === 'buy') {
        return { success: true, result: [{ price: '29900', amount: '1.5' }] };
      }
      return { success: true, result: [{ price: '30100', amount: '0.8' }] };
    });
    const ob = await exchange.fetchOrderBook('BTC/USDT');
    assert.strictEqual(callCount, 2);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
  });

  it('createOrder sends correct params (limit only)', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { success: true, result: { orderId: 'ORD123' } };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5, 30000);
    assert.strictEqual(capturedParams.market, 'BTC_USDT');
    assert.strictEqual(capturedParams.side, 'buy');
    assert.strictEqual(capturedParams.amount, '0.5');
    assert.strictEqual(capturedParams.price, '30000');
    assert.strictEqual(order.id, 'ORD123');
  });

  it('createOrder rejects market orders', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'market', 'buy', 0.5),
      InvalidOrder
    );
  });

  it('createOrder rejects limit without price', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5),
      InvalidOrder
    );
  });

  it('cancelOrder sends orderId as number', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { success: true, result: {} };
    });
    const result = await exchange.cancelOrder('12345', 'BTC/USDT');
    assert.strictEqual(capturedParams.orderId, 12345);
    assert.strictEqual(capturedParams.market, 'BTC_USDT');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance parses balances response (all private = POST)', async () => {
    let capturedMethod;
    mock.method(exchange, '_request', async (method) => {
      capturedMethod = method;
      return { success: true, result: { BTC: { available: '0.5', freeze: '0.3' }, USDT: { available: '10000', freeze: '5000' } } };
    });
    const balance = await exchange.fetchBalance();
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
  });

  it('fetchOpenOrders parses orders response', async () => {
    mock.method(exchange, '_request', async () => ({
      success: true,
      result: [
        { orderId: 'ORD1', market: 'BTC_USDT', side: 'buy', price: '30000', amount: '0.5', left: '0.3' },
      ],
    }));
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].id, 'ORD1');
    assert.strictEqual(orders[0].status, 'open');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('PointPay Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new PointPay();
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

  it('market() throws on unknown symbol', () => {
    assert.throws(() => exchange.market('DOGE/USD'), /unknown symbol/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. PointPay vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('PointPay vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay({ apiKey: 'k', secret: 's' }); });

  it('payload-based signing: base64(body) → hmacSHA512Hex', () => {
    const result = exchange._sign('/api/v1/account/balances', 'POST', {});
    assert.ok(result.headers['X-TXC-PAYLOAD']);
    assert.ok(/^[0-9a-f]{128}$/.test(result.headers['X-TXC-SIGNATURE']));
  });

  it('all private endpoints use POST (like EXMO)', async () => {
    let capturedMethod;
    mock.method(exchange, '_request', async (method) => {
      capturedMethod = method;
      return { success: true, result: {} };
    });
    await exchange.fetchBalance();
    assert.strictEqual(capturedMethod, 'POST');
  });

  it('only supports limit orders (no market)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createLimitOrder, true);
    assert.strictEqual(has.createMarketOrder, false);
  });

  it('underscore symbol format BTC_USDT', () => {
    assert.strictEqual(exchange._toPointPaySymbol('BTC/USDT'), 'BTC_USDT');
  });

  it('X-TXC-* headers (unique to PointPay)', () => {
    const result = exchange._sign('/api/v1/orders', 'POST', {});
    assert.ok(result.headers['X-TXC-APIKEY']);
    assert.ok(result.headers['X-TXC-PAYLOAD']);
    assert.ok(result.headers['X-TXC-SIGNATURE']);
  });

  it('request path and nonce included in signed body', () => {
    const result = exchange._sign('/api/v1/orders', 'POST', { market: 'BTC_USDT' });
    assert.strictEqual(result.params.request, '/api/v1/orders');
    assert.ok(result.params.nonce);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA512Hex for payload signing
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA512Hex for PointPay', () => {
  it('hmacSHA512Hex produces 128-char hex string', () => {
    const sig = hmacSHA512Hex('test', 'secret');
    assert.strictEqual(sig.length, 128);
    assert.ok(/^[0-9a-f]{128}$/.test(sig));
  });

  it('hmacSHA512Hex is deterministic', () => {
    const payload = Buffer.from('{"request":"/api/v1/account/balances","nonce":"123"}').toString('base64');
    const sig1 = hmacSHA512Hex(payload, 'secret');
    const sig2 = hmacSHA512Hex(payload, 'secret');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA512Hex('payload1', 'secret');
    const sig2 = hmacSHA512Hex('payload2', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });

  it('different secrets produce different signatures', () => {
    const sig1 = hmacSHA512Hex('same_payload', 'secret1');
    const sig2 = hmacSHA512Hex('same_payload', 'secret2');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — method/params/id protocol
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — method/params/id protocol', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

  it('WS URL includes pointpay', () => {
    assert.ok(exchange.describe().urls.ws.includes('pointpay'));
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

  it('watchOrderBook subscribes with depth.subscribe method', async () => {
    let sentMsg;
    const fakeWs = { readyState: 1, send: (msg) => { sentMsg = msg; }, removeAllListeners: () => {}, on: () => {} };
    const fakeClient = {
      connected: true,
      _ws: fakeWs,
      on: () => {},
      connect: async () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    const parsed = JSON.parse(sentMsg);
    assert.strictEqual(parsed.method, 'depth.subscribe');
    assert.strictEqual(parsed.params[0], 'BTC_USDT');
    assert.strictEqual(parsed.params[1], 100);
    assert.strictEqual(parsed.params[2], '0');
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
describe('PointPay WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new PointPay(); });

  it('_parseWsOrderBook handles array entries', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [['30100', '0.8'], ['30200', '1.2']],
      bids: [['29900', '1.5'], ['29800', '2.0']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook includes timestamp', () => {
    const ob = exchange._parseWsOrderBook({ asks: [], bids: [] }, 'BTC/USDT');
    assert.ok(ob.timestamp > 0);
    assert.ok(ob.datetime);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('PointPay Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

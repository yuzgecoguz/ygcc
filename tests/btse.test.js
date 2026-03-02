'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Btse = require('../lib/btse');
const { hmacSHA384Hex } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Btse
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Btse', () => {
  it('exports Btse class', () => {
    assert.strictEqual(typeof lib.Btse, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.btse, lib.Btse);
  });

  it('includes btse in exchanges list', () => {
    assert.ok(lib.exchanges.includes('btse'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Btse Constructor
// ═══════════════════════════════════════════════════════════════
describe('Btse Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

  it('sets id to btse', () => {
    assert.strictEqual(exchange.describe().id, 'btse');
  });

  it('sets name to BTSE', () => {
    assert.strictEqual(exchange.describe().name, 'BTSE');
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

  it('has correct fees (0.1%)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.001);
  });

  it('initializes _wsClients as empty Map', () => {
    assert.ok(exchange._wsClients instanceof Map);
    assert.strictEqual(exchange._wsClients.size, 0);
  });

  it('initializes _wsHandlers as empty Map', () => {
    assert.ok(exchange._wsHandlers instanceof Map);
    assert.strictEqual(exchange._wsHandlers.size, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — HMAC-SHA384
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA384', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Btse({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Btse({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/api/v3.2/order', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Btse({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/api/v3.2/order', 'POST', {}), /secret required/);
  });

  it('returns request-api header (apiKey)', () => {
    const result = exchange._sign('/api/v3.2/order', 'POST', { size: 1 });
    assert.strictEqual(result.headers['request-api'], 'testkey');
  });

  it('returns request-nonce header (timestamp string)', () => {
    const result = exchange._sign('/api/v3.2/order', 'POST', {});
    assert.ok(result.headers['request-nonce']);
    assert.ok(/^\d+$/.test(result.headers['request-nonce']));
  });

  it('returns request-sign header (hex string)', () => {
    const result = exchange._sign('/api/v3.2/order', 'POST', { size: 1 });
    // HMAC-SHA384 produces 96-char hex
    assert.ok(/^[0-9a-f]{96}$/.test(result.headers['request-sign']));
  });

  it('POST signing: HMAC-SHA384(path + nonce + body, secret) produces deterministic hex', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { symbol: 'BTC-USDT', side: 'BUY', type: '76', size: 0.5, price: 30000 };
      const result = exchange._sign('/api/v3.2/order', 'POST', params);
      const bodyStr = JSON.stringify(params);
      const signingString = '/api/v3.2/order' + '1700000000000' + bodyStr;
      const expected = hmacSHA384Hex(signingString, 'testsecret');
      assert.strictEqual(result.headers['request-sign'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('GET signing: body is empty string', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v3.2/user/wallet', 'GET', {});
      const signingString = '/api/v3.2/user/wallet' + '1700000000000';
      const expected = hmacSHA384Hex(signingString, 'testsecret');
      assert.strictEqual(result.headers['request-sign'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('POST with empty params: body is empty string', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v3.2/order', 'POST', {});
      const signingString = '/api/v3.2/order' + '1700000000000';
      const expected = hmacSHA384Hex(signingString, 'testsecret');
      assert.strictEqual(result.headers['request-sign'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('params are preserved in result', () => {
    const params = { size: 1, price: 500 };
    const result = exchange._sign('/api/v3.2/order', 'POST', params);
    assert.strictEqual(result.params.size, 1);
    assert.strictEqual(result.params.price, 500);
  });

  it('only requires 2 credentials (apiKey, secret)', () => {
    // Should not throw — only apiKey + secret needed (no passphrase, no uid)
    const ex = new Btse({ apiKey: 'k', secret: 's' });
    const result = ex._sign('/api/v3.2/order', 'POST', {});
    assert.ok(result.headers['request-api']);
    assert.ok(result.headers['request-sign']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Btse Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

  it('array response returned as-is', () => {
    const arr = [{ symbol: 'BTC-USDT', lastPrice: '30000' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('status error throws ExchangeError via _handleBtseError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ status: 400, message: 'Something failed' }),
      ExchangeError
    );
  });

  it('status 0 does not throw (success)', () => {
    const result = exchange._unwrapResponse({ status: 0, message: 'OK', data: { foo: 1 } });
    assert.ok(result);
    assert.strictEqual(result.data.foo, 1);
  });

  it('non-object response passes through', () => {
    const result = exchange._unwrapResponse('OK');
    assert.strictEqual(result, 'OK');
  });

  it('object without status/message passes through', () => {
    const obj = { sellQuote: [], buyQuote: [] };
    const result = exchange._unwrapResponse(obj);
    assert.deepStrictEqual(result, obj);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Btse Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

  it('_parseTicker extracts lastPrice', () => {
    const t = exchange._parseTicker({ lastPrice: '30000.50' }, 'BTC/USDT');
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 30000.50);
    assert.strictEqual(t.close, 30000.50);
  });

  it('_parseTicker returns undefined for missing fields', () => {
    const t = exchange._parseTicker({ lastPrice: '30000' }, 'BTC/USDT');
    assert.strictEqual(t.high, undefined);
    assert.strictEqual(t.low, undefined);
    assert.strictEqual(t.bid, undefined);
    assert.strictEqual(t.ask, undefined);
    assert.strictEqual(t.volume, undefined);
    assert.strictEqual(t.percentage, undefined);
  });

  it('_parseOrder extracts orderID', () => {
    const o = exchange._parseOrder({ orderID: 'abc-123', symbol: 'BTC-USDT' }, 'BTC/USDT');
    assert.strictEqual(o.id, 'abc-123');
    assert.strictEqual(o.symbol, 'BTC/USDT');
  });

  it('_parseOrder maps orderType 76 to limit', () => {
    const o = exchange._parseOrder({ orderID: '1', orderType: 76 }, 'BTC/USDT');
    assert.strictEqual(o.type, 'limit');
  });

  it('_parseOrder maps orderType 77 to market', () => {
    const o = exchange._parseOrder({ orderID: '2', orderType: 77 }, 'BTC/USDT');
    assert.strictEqual(o.type, 'market');
  });

  it('_parseOrder maps side BUY to buy (lowercase)', () => {
    const o = exchange._parseOrder({ orderID: '3', side: 'BUY' }, 'BTC/USDT');
    assert.strictEqual(o.side, 'buy');
  });

  it('_parseOrder maps side SELL to sell (lowercase)', () => {
    const o = exchange._parseOrder({ orderID: '4', side: 'SELL' }, 'BTC/USDT');
    assert.strictEqual(o.side, 'sell');
  });

  it('_parseOrder calculates remaining and cost', () => {
    const o = exchange._parseOrder({
      orderID: '5', price: '100', size: '10', fillSize: '4',
    }, 'BTC/USDT');
    assert.strictEqual(o.price, 100);
    assert.strictEqual(o.amount, 10);
    assert.strictEqual(o.filled, 4);
    assert.strictEqual(o.remaining, 6);
    assert.strictEqual(o.cost, 400);
  });

  it('_parseOrderBook maps sellQuote/buyQuote to asks/bids', () => {
    const ob = exchange._parseOrderBook({
      sellQuote: [{ price: '30100', size: '0.8' }],
      buyQuote: [{ price: '29900', size: '1.5' }],
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

  it('_parseBalance extracts currency, total, available', () => {
    const b = exchange._parseBalance([
      { currency: 'BTC', available: '0.5', total: '0.8' },
      { currency: 'USDT', available: '10000', total: '15000' },
    ]);
    assert.strictEqual(b.BTC.free, 0.5);
    assert.strictEqual(b.BTC.total, 0.8);
    assert.ok(Math.abs(b.BTC.used - 0.3) < 1e-10);
    assert.strictEqual(b.USDT.free, 10000);
    assert.strictEqual(b.USDT.total, 15000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Btse Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

  it('_toBtseSymbol BTC/USDT -> BTC-USDT', () => {
    assert.strictEqual(exchange._toBtseSymbol('BTC/USDT'), 'BTC-USDT');
  });

  it('_toBtseSymbol ETH/USDT -> ETH-USDT', () => {
    assert.strictEqual(exchange._toBtseSymbol('ETH/USDT'), 'ETH-USDT');
  });

  it('_toBtseSymbol SOL/BTC -> SOL-BTC', () => {
    assert.strictEqual(exchange._toBtseSymbol('SOL/BTC'), 'SOL-BTC');
  });

  it('_fromBtseSymbol BTC-USDT -> BTC/USDT', () => {
    assert.strictEqual(exchange._fromBtseSymbol('BTC-USDT'), 'BTC/USDT');
  });

  it('_fromBtseSymbol ETH-BTC -> ETH/BTC', () => {
    assert.strictEqual(exchange._fromBtseSymbol('ETH-BTC'), 'ETH/BTC');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.btse.com/spot');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Btse Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

  it('insufficient -> InsufficientFunds', () => {
    assert.throws(() => exchange._handleBtseError(400, 'Insufficient balance'), InsufficientFunds);
  });

  it('balance -> InsufficientFunds', () => {
    assert.throws(() => exchange._handleBtseError(400, 'Not enough balance'), InsufficientFunds);
  });

  it('auth -> AuthenticationError', () => {
    assert.throws(() => exchange._handleBtseError(401, 'Authentication failed'), AuthenticationError);
  });

  it('permission -> AuthenticationError', () => {
    assert.throws(() => exchange._handleBtseError(403, 'Permission denied'), AuthenticationError);
  });

  it('order not found -> OrderNotFound', () => {
    assert.throws(() => exchange._handleBtseError(404, 'order not found'), OrderNotFound);
  });

  it('symbol -> BadSymbol', () => {
    assert.throws(() => exchange._handleBtseError(400, 'invalid symbol XYZ'), BadSymbol);
  });

  it('invalid order -> InvalidOrder', () => {
    assert.throws(() => exchange._handleBtseError(400, 'invalid order size'), InvalidOrder);
  });

  it('rate limit -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleBtseError(429, 'rate limit exceeded'), RateLimitExceeded);
  });

  it('unknown -> ExchangeError', () => {
    assert.throws(() => exchange._handleBtseError(500, 'something unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Btse HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

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
    assert.throws(() => exchange._handleHttpError(429, 'too many'), RateLimitExceeded);
  });

  it('500 -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleHttpError(500, 'server error'), ExchangeNotAvailable);
  });

  it('parses JSON error body', () => {
    const body = JSON.stringify({ status: 400, message: 'Insufficient balance' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Btse Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Btse();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Btse({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Btse();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Btse Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Btse({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTC-USDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses market_summary response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ([
      { symbol: 'BTC-USDT', base: 'BTC', quote: 'USDT', status: 'active', tradeEnabled: true },
      { symbol: 'ETH-USDT', base: 'ETH', quote: 'USDT', status: 'active', tradeEnabled: true },
    ]));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTC-USDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
  });

  it('fetchTicker parses price response', async () => {
    mock.method(exchange, '_request', async () => ([
      { symbol: 'BTC-USDT', lastPrice: '30000.50' },
      { symbol: 'ETH-USDT', lastPrice: '2000' },
    ]));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 30000.50);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('createOrder sends correct params (symbol, side BUY, type "76", size, price)', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return [{ orderID: 'order-123', clOrderID: 'cl-123' }];
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'BUY', 0.5, 30000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/api/v3.2/order');
    assert.strictEqual(capturedParams.symbol, 'BTC-USDT');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.type, '76');
    assert.strictEqual(capturedParams.size, 0.5);
    assert.strictEqual(capturedParams.price, 30000);
    assert.strictEqual(order.id, 'order-123');
  });

  it('createOrder SELL with market type uses "77"', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return [{ orderID: 'order-456' }];
    });
    await exchange.createOrder('BTC/USDT', 'market', 'SELL', 1.0);
    assert.strictEqual(capturedParams.side, 'SELL');
    assert.strictEqual(capturedParams.type, '77');
  });

  it('createOrder LIMIT without price throws InvalidOrder', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'limit', 'BUY', 0.5),
      InvalidOrder
    );
  });

  it('cancelOrder sends DELETE with orderID in body', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return {};
    });
    const result = await exchange.cancelOrder('order-789', 'BTC/USDT');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedPath, '/api/v3.2/order');
    assert.strictEqual(capturedParams.orderID, 'order-789');
    assert.strictEqual(capturedParams.symbol, 'BTC-USDT');
    assert.strictEqual(result.status, 'canceled');
    assert.strictEqual(result.id, 'order-789');
  });

  it('fetchBalance parses wallet response', async () => {
    mock.method(exchange, '_request', async () => ([
      { currency: 'BTC', available: '0.5', total: '0.8' },
      { currency: 'USDT', available: '10000', total: '15000' },
    ]));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
    assert.strictEqual(balance.USDT.free, 10000);
    assert.strictEqual(balance.USDT.total, 15000);
  });

  it('fetchOpenOrders parses open_orders response', async () => {
    mock.method(exchange, '_request', async () => ([
      { orderID: 'o1', symbol: 'BTC-USDT', side: 'BUY', orderType: 76, price: '30000', size: '0.5', fillSize: '0' },
      { orderID: 'o2', symbol: 'BTC-USDT', side: 'SELL', orderType: 77, price: '0', size: '1.0', fillSize: '0.2' },
    ]));
    const orders = await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].id, 'o1');
    assert.strictEqual(orders[0].type, 'limit');
    assert.strictEqual(orders[0].side, 'buy');
    assert.strictEqual(orders[1].id, 'o2');
    assert.strictEqual(orders[1].type, 'market');
    assert.strictEqual(orders[1].side, 'sell');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Btse Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Btse();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' },
    };
    exchange.marketsById = { 'BTC-USDT': { symbol: 'BTC/USDT' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTC-USDT');
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
// 12. Btse vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('Btse vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse({ apiKey: 'k', secret: 's' }); });

  it('HMAC-SHA384 signing (unique among exchanges — like Bitfinex)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v3.2/order', 'POST', { size: 1 });
      // HMAC-SHA384 produces 96-char hex (384 bits / 4 = 96 hex chars)
      assert.ok(/^[0-9a-f]{96}$/.test(result.headers['request-sign']));
    } finally {
      Date.now = origNow;
    }
  });

  it('hyphen-separated symbols BTC-USDT', () => {
    assert.strictEqual(exchange._toBtseSymbol('BTC/USDT'), 'BTC-USDT');
    assert.strictEqual(exchange._toBtseSymbol('ETH/BTC'), 'ETH-BTC');
  });

  it('request-api/request-nonce/request-sign headers', () => {
    const result = exchange._sign('/api/v3.2/order', 'POST', {});
    assert.ok(result.headers['request-api']);
    assert.ok(result.headers['request-nonce']);
    assert.ok(result.headers['request-sign']);
  });

  it('DELETE with JSON body for cancelOrder (like VALR)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.cancelOrder, true);
    // cancelOrder uses DELETE method — tested in mocked API calls section
  });

  it('order type uses numeric codes "76"/"77"', async () => {
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return [{ orderID: 'x' }];
    });
    await exchange.createOrder('BTC/USDT', 'limit', 'BUY', 1, 30000);
    assert.strictEqual(capturedParams.type, '76');
    mock.restoreAll();
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return [{ orderID: 'y' }];
    });
    await exchange.createOrder('BTC/USDT', 'market', 'BUY', 1);
    assert.strictEqual(capturedParams.type, '77');
  });

  it('side is UPPERCASE (BUY/SELL)', async () => {
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return [{ orderID: 'z' }];
    });
    await exchange.createOrder('BTC/USDT', 'market', 'buy', 1);
    assert.strictEqual(capturedParams.side, 'BUY');
  });

  it('fetchTickers not supported (has: false)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.fetchTickers, false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA384Hex
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA384Hex', () => {
  it('hmacSHA384Hex produces hex string (96 chars)', () => {
    const sig = hmacSHA384Hex('test', 'secret');
    assert.strictEqual(sig.length, 96);
    assert.ok(/^[0-9a-f]{96}$/.test(sig));
  });

  it('hmacSHA384Hex is deterministic', () => {
    const sig1 = hmacSHA384Hex('/api/v3.2/order1700000000000{"size":1}', 'testsecret');
    const sig2 = hmacSHA384Hex('/api/v3.2/order1700000000000{"size":1}', 'testsecret');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA384Hex('POST', 'secret');
    const sig2 = hmacSHA384Hex('GET', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });

  it('hmacSHA384Hex matches expected hex pattern', () => {
    const sig = hmacSHA384Hex('some data', 'some key');
    // SHA384 = 384 bits = 48 bytes = 96 hex chars, lowercase
    assert.ok(/^[0-9a-f]+$/.test(sig));
    assert.strictEqual(sig.length, 96);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — ping/pong text
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — ping/pong text', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

  it('WS URL includes btse', () => {
    assert.ok(exchange.describe().urls.ws.includes('btse'));
  });

  it('WS URL is correct wss endpoint', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://ws.btse.com/ws/spot');
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

  it('watchOrderBook subscribes with update: topic and _0 suffix', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});
    assert.ok(sentMsg);
    assert.strictEqual(sentMsg.op, 'subscribe');
    assert.ok(sentMsg.args[0].includes('update:'));
    assert.ok(sentMsg.args[0].includes('BTC-USDT_0'));
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
describe('Btse WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Btse(); });

  it('_parseWsOrderBook handles sellQuote/buyQuote format', () => {
    const ob = exchange._parseWsOrderBook({
      sellQuote: [
        { price: '30100', size: '0.8' },
        { price: '30200', size: '1.2' },
      ],
      buyQuote: [
        { price: '29900', size: '1.5' },
      ],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.asks[1], [30200, 1.2]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook includes timestamp', () => {
    const ob = exchange._parseWsOrderBook({ sellQuote: [], buyQuote: [] }, 'BTC/USDT');
    assert.ok(ob.timestamp > 0);
    assert.ok(ob.datetime);
  });

  it('_parseWsOrderBook uses data timestamp when available', () => {
    const ob = exchange._parseWsOrderBook({
      sellQuote: [],
      buyQuote: [],
      timestamp: 1700000000000,
    }, 'BTC/USDT');
    assert.strictEqual(ob.timestamp, 1700000000000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Btse Version', () => {
  it('library version is 2.8.0', () => {
    assert.strictEqual(lib.version, '2.8.0');
  });
});

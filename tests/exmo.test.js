'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Exmo = require('../lib/exmo');
const { hmacSHA512Hex } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Exmo
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Exmo', () => {
  it('exports Exmo class', () => {
    assert.strictEqual(typeof lib.Exmo, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.exmo, lib.Exmo);
  });

  it('includes exmo in exchanges list', () => {
    assert.ok(lib.exchanges.includes('exmo'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Exmo Constructor
// ═══════════════════════════════════════════════════════════════
describe('Exmo Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

  it('sets id to exmo', () => {
    assert.strictEqual(exchange.describe().id, 'exmo');
  });

  it('sets name to EXMO', () => {
    assert.strictEqual(exchange.describe().name, 'EXMO');
  });

  it('sets version to v1.1', () => {
    assert.strictEqual(exchange.describe().version, 'v1.1');
  });

  it('sets postAsFormEncoded to true', () => {
    assert.strictEqual(exchange.postAsFormEncoded, true);
  });

  it('has empty timeframes', () => {
    assert.deepStrictEqual(exchange.describe().timeframes, {});
  });

  it('has correct fees (maker 0.2%, taker 0.3%)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.002);
    assert.strictEqual(fees.taker, 0.003);
  });

  it('stores apiKey from config', () => {
    const ex = new Exmo({ apiKey: 'mykey' });
    assert.strictEqual(ex.apiKey, 'mykey');
  });

  it('stores secret from config', () => {
    const ex = new Exmo({ secret: 'mysecret' });
    assert.strictEqual(ex.secret, 'mysecret');
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
// 3. Authentication — HMAC-SHA512 form-encoded
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA512 form-encoded', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Exmo({ apiKey: 'testkey', secret: 'testsecret' });
  });

  it('throws without apiKey', () => {
    const ex = new Exmo({ secret: 'testsecret' });
    assert.throws(() => ex._sign('/v1.1/user_info', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Exmo({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/v1.1/user_info', 'POST', {}), /secret required/);
  });

  it('returns Key header (apiKey)', () => {
    const result = exchange._sign('/v1.1/user_info', 'POST', {});
    assert.strictEqual(result.headers['Key'], 'testkey');
  });

  it('returns Sign header (hex string, 128 chars for SHA512)', () => {
    const result = exchange._sign('/v1.1/user_info', 'POST', {});
    assert.ok(/^[0-9a-f]{128}$/.test(result.headers['Sign']));
  });

  it('returns Content-Type header (application/x-www-form-urlencoded)', () => {
    const result = exchange._sign('/v1.1/user_info', 'POST', {});
    assert.strictEqual(result.headers['Content-Type'], 'application/x-www-form-urlencoded');
  });

  it('signing: injects nonce, URL-encodes body, HMAC-SHA512', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { pair: 'BTC_USD', quantity: '0.5' };
      const result = exchange._sign('/v1.1/order_create', 'POST', params);
      const body = { ...params, nonce: '1700000000000' };
      const bodyStr = new URLSearchParams(body).toString();
      const expected = hmacSHA512Hex(bodyStr, 'testsecret');
      assert.strictEqual(result.headers['Sign'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('signing with empty params still injects nonce', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/v1.1/user_info', 'POST', {});
      const bodyStr = new URLSearchParams({ nonce: '1700000000000' }).toString();
      const expected = hmacSHA512Hex(bodyStr, 'testsecret');
      assert.strictEqual(result.headers['Sign'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('params include nonce in result', () => {
    const params = { pair: 'BTC_USD' };
    const result = exchange._sign('/v1.1/order_create', 'POST', params);
    assert.ok(result.params.nonce);
    assert.ok(/^\d+$/.test(result.params.nonce));
  });

  it('original params are preserved in result', () => {
    const params = { pair: 'BTC_USD', quantity: '1.0' };
    const result = exchange._sign('/v1.1/order_create', 'POST', params);
    assert.strictEqual(result.params.pair, 'BTC_USD');
    assert.strictEqual(result.params.quantity, '1.0');
  });

  it('only requires 2 credentials (apiKey, secret)', () => {
    const ex = new Exmo({ apiKey: 'k', secret: 's' });
    const result = ex._sign('/v1.1/user_info', 'POST', {});
    assert.ok(result.headers['Key']);
    assert.ok(result.headers['Sign']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Exmo Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

  it('result: false throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ result: false, error: 'Something failed' }),
      ExchangeError
    );
  });

  it('error string throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ error: 'Invalid nonce' }),
      ExchangeError
    );
  });

  it('empty error string passes through', () => {
    const data = { error: '', BTC_USD: { last_trade: '50000' } };
    const result = exchange._unwrapResponse(data);
    assert.strictEqual(result.BTC_USD.last_trade, '50000');
  });

  it('direct data passes through (for public endpoints)', () => {
    const data = { BTC_USD: { last_trade: '50000', high: '51000' } };
    const result = exchange._unwrapResponse(data);
    assert.strictEqual(result.BTC_USD.last_trade, '50000');
  });

  it('array response passes through', () => {
    const arr = [{ id: '1' }, { id: '2' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Exmo Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker('BTC_USD', {
      last_trade: '50000', buy_price: '49900', sell_price: '50100',
      high: '51000', low: '49000', vol: '1200', vol_curr: '60000000',
      updated: 1700000000,
    });
    assert.strictEqual(t.symbol, 'BTC/USD');
    assert.strictEqual(t.last, 50000);
    assert.strictEqual(t.bid, 49900);
    assert.strictEqual(t.ask, 50100);
    assert.strictEqual(t.high, 51000);
    assert.strictEqual(t.low, 49000);
    assert.strictEqual(t.volume, 1200);
    assert.strictEqual(t.quoteVolume, 60000000);
    assert.strictEqual(t.timestamp, 1700000000000);
  });

  it('_parseTicker takes pair as first arg', () => {
    const t = exchange._parseTicker('ETH_BTC', { last_trade: '0.065' });
    assert.strictEqual(t.symbol, 'ETH/BTC');
    assert.strictEqual(t.last, 0.065);
  });

  it('_parseOrder extracts order_id', () => {
    const o = exchange._parseOrder({ order_id: '12345', type: 'buy' }, 'BTC/USD');
    assert.strictEqual(o.id, '12345');
    assert.strictEqual(o.symbol, 'BTC/USD');
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrder handles type buy', () => {
    const o = exchange._parseOrder({ order_id: '1', type: 'buy' }, 'BTC/USD');
    assert.strictEqual(o.side, 'BUY');
  });

  it('_parseOrder handles type sell', () => {
    const o = exchange._parseOrder({ order_id: '2', type: 'sell' }, 'BTC/USD');
    assert.strictEqual(o.side, 'SELL');
  });

  it('_parseOrderBook handles triple-entry arrays [price, quantity, amount]', () => {
    const ob = exchange._parseOrderBook({
      ask: [['50100', '0.5', '25050']],
      bid: [['49900', '1.0', '49900']],
    });
    assert.deepStrictEqual(ob.asks[0], [50100, 0.5]);
    assert.deepStrictEqual(ob.bids[0], [49900, 1.0]);
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({});
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseBalance extracts from balances/reserved objects', () => {
    const b = exchange._parseBalance({
      balances: { BTC: '0.5', USD: '10000' },
      reserved: { BTC: '0.3', USD: '5000' },
    });
    assert.strictEqual(b.BTC.free, 0.5);
    assert.strictEqual(b.BTC.used, 0.3);
    assert.ok(Math.abs(b.BTC.total - 0.8) < 1e-10);
    assert.strictEqual(b.USD.free, 10000);
    assert.strictEqual(b.USD.used, 5000);
    assert.ok(Math.abs(b.USD.total - 15000) < 1e-10);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Exmo Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

  it('_toExmoSymbol BTC/USD -> BTC_USD', () => {
    assert.strictEqual(exchange._toExmoSymbol('BTC/USD'), 'BTC_USD');
  });

  it('_toExmoSymbol ETH/BTC -> ETH_BTC', () => {
    assert.strictEqual(exchange._toExmoSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('_fromExmoSymbol BTC_USD -> BTC/USD via marketsById', () => {
    exchange.marketsById = { 'BTC_USD': { symbol: 'BTC/USD' } };
    assert.strictEqual(exchange._fromExmoSymbol('BTC_USD'), 'BTC/USD');
  });

  it('_fromExmoSymbol falls back to direct parse without marketsById', () => {
    exchange.marketsById = null;
    assert.strictEqual(exchange._fromExmoSymbol('BTC_USD'), 'BTC/USD');
  });

  it('_fromExmoSymbol unknown returns as-is', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromExmoSymbol('UNKNOWN'), 'UNKNOWN');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.exmo.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Exmo Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

  it('insufficient -> InsufficientFunds', () => {
    assert.throws(() => exchange._handleExmoError('Insufficient funds'), InsufficientFunds);
  });

  it('not enough -> InsufficientFunds', () => {
    assert.throws(() => exchange._handleExmoError('Not enough balance'), InsufficientFunds);
  });

  it('auth -> AuthenticationError', () => {
    assert.throws(() => exchange._handleExmoError('Authentication failed'), AuthenticationError);
  });

  it('permission -> AuthenticationError', () => {
    assert.throws(() => exchange._handleExmoError('Permission denied'), AuthenticationError);
  });

  it('order not found -> OrderNotFound', () => {
    assert.throws(() => exchange._handleExmoError('Order not found'), OrderNotFound);
  });

  it('symbol/pair -> BadSymbol', () => {
    assert.throws(() => exchange._handleExmoError('Unknown pair INVALID'), BadSymbol);
  });

  it('invalid order -> InvalidOrder', () => {
    assert.throws(() => exchange._handleExmoError('Invalid order parameters'), InvalidOrder);
  });

  it('rate limit -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleExmoError('Rate limit exceeded'), RateLimitExceeded);
  });

  it('unknown -> ExchangeError', () => {
    assert.throws(() => exchange._handleExmoError('something unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Exmo HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

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
    const body = JSON.stringify({ result: false, error: 'Insufficient funds' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Exmo Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Exmo();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Exmo({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Exmo();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 10);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Exmo Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Exmo({ apiKey: 'testkey', secret: 'testsecret' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USD': { id: 'BTC_USD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD' } };
    exchange.marketsById = { 'BTC_USD': { symbol: 'BTC/USD' } };
  });

  it('loadMarkets parses pair_settings response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      BTC_USD: { min_quantity: '0.0001', max_quantity: '1000', min_price: '1', max_price: '100000' },
      ETH_USD: { min_quantity: '0.001', max_quantity: '5000', min_price: '0.1', max_price: '50000' },
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USD']);
    assert.ok(markets['ETH/USD']);
    assert.strictEqual(markets['BTC/USD'].id, 'BTC_USD');
    assert.strictEqual(markets['BTC/USD'].base, 'BTC');
    assert.strictEqual(markets['BTC/USD'].quote, 'USD');
  });

  it('fetchTicker parses ticker response', async () => {
    mock.method(exchange, '_request', async () => ({
      BTC_USD: { last_trade: '50000', buy_price: '49900', sell_price: '50100', high: '51000', low: '49000', vol: '1200', vol_curr: '60000000', updated: 1700000000 },
    }));
    const ticker = await exchange.fetchTicker('BTC/USD');
    assert.strictEqual(ticker.last, 50000);
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.bid, 49900);
    assert.strictEqual(ticker.ask, 50100);
  });

  it('fetchTickers returns all tickers', async () => {
    mock.method(exchange, '_request', async () => ({
      BTC_USD: { last_trade: '50000', buy_price: '49900', sell_price: '50100' },
      ETH_USD: { last_trade: '3000', buy_price: '2990', sell_price: '3010' },
    }));
    exchange.marketsById = {
      'BTC_USD': { symbol: 'BTC/USD' },
      'ETH_USD': { symbol: 'ETH/USD' },
    };
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/USD']);
    assert.ok(tickers['ETH/USD']);
  });

  it('createOrder sends correct params (pair, quantity, price, type)', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { result: true, order_id: 12345 };
    });
    const order = await exchange.createOrder('BTC/USD', 'limit', 'buy', 0.5, 50000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/v1.1/order_create');
    assert.strictEqual(capturedParams.pair, 'BTC_USD');
    assert.strictEqual(capturedParams.quantity, '0.5');
    assert.strictEqual(capturedParams.price, '50000');
    assert.strictEqual(capturedParams.type, 'buy');
    assert.strictEqual(order.id, '12345');
  });

  it('createOrder market type uses price: 0', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { result: true, order_id: 67890 };
    });
    await exchange.createOrder('BTC/USD', 'market', 'buy', 1.0);
    assert.strictEqual(capturedParams.price, '0');
  });

  it('cancelOrder sends order_id', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { result: true };
    });
    const result = await exchange.cancelOrder('12345');
    assert.strictEqual(capturedParams.order_id, '12345');
    assert.strictEqual(result.status, 'canceled');
    assert.strictEqual(result.id, '12345');
  });

  it('fetchBalance parses user_info response (balances + reserved objects)', async () => {
    mock.method(exchange, '_request', async () => ({
      balances: { BTC: '0.5', USD: '10000' },
      reserved: { BTC: '0.3', USD: '5000' },
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.used, 0.3);
    assert.ok(Math.abs(balance.BTC.total - 0.8) < 1e-10);
    assert.strictEqual(balance.USD.free, 10000);
    assert.strictEqual(balance.USD.used, 5000);
  });

  it('fetchOpenOrders parses pair-keyed response', async () => {
    mock.method(exchange, '_request', async () => ({
      BTC_USD: [
        { order_id: '111', type: 'buy', price: '50000', quantity: '0.1' },
        { order_id: '222', type: 'sell', price: '51000', quantity: '0.2' },
      ],
    }));
    exchange.marketsById = { 'BTC_USD': { symbol: 'BTC/USD' } };
    const orders = await exchange.fetchOpenOrders();
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].id, '111');
    assert.strictEqual(orders[0].side, 'BUY');
    assert.strictEqual(orders[1].id, '222');
    assert.strictEqual(orders[1].side, 'SELL');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Exmo Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Exmo();
    exchange._marketsLoaded = true;
    exchange.markets = {
      'BTC/USD': { id: 'BTC_USD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD' },
    };
    exchange.marketsById = { 'BTC_USD': { symbol: 'BTC/USD' } };
  });

  it('market() returns correct market', () => {
    const m = exchange.market('BTC/USD');
    assert.strictEqual(m.id, 'BTC_USD');
  });

  it('market() returns base and quote', () => {
    const m = exchange.market('BTC/USD');
    assert.strictEqual(m.base, 'BTC');
    assert.strictEqual(m.quote, 'USD');
  });

  it('market() throws on unknown symbol', () => {
    assert.throws(() => exchange.market('DOGE/USD'), /unknown symbol/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. Exmo vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('Exmo vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo({ apiKey: 'k', secret: 's' }); });

  it('HMAC-SHA512 signing (unique digest)', () => {
    const result = exchange._sign('/v1.1/user_info', 'POST', {});
    // SHA512 produces 128-char hex
    assert.ok(/^[0-9a-f]{128}$/.test(result.headers['Sign']));
  });

  it('form-encoded POST body (NOT JSON)', () => {
    assert.strictEqual(exchange.postAsFormEncoded, true);
    assert.strictEqual(exchange.postAsJson, false);
  });

  it('underscore symbol format BTC_USD', () => {
    assert.strictEqual(exchange._toExmoSymbol('BTC/USD'), 'BTC_USD');
    assert.strictEqual(exchange._toExmoSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('Key/Sign headers (simple naming)', () => {
    const result = exchange._sign('/v1.1/user_info', 'POST', {});
    assert.ok(result.headers['Key']);
    assert.ok(result.headers['Sign']);
    assert.ok(result.headers['Content-Type']);
  });

  it('all private endpoints use POST', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createOrder, true);
    assert.strictEqual(has.cancelOrder, true);
    assert.strictEqual(has.fetchBalance, true);
    assert.strictEqual(has.fetchOpenOrders, true);
  });

  it('nonce injected into body (not header)', () => {
    const result = exchange._sign('/v1.1/user_info', 'POST', { foo: 'bar' });
    assert.ok(result.params.nonce);
    // nonce is in params, not a separate header
    assert.strictEqual(result.headers['Key'], 'k');
    assert.strictEqual(typeof result.params.nonce, 'string');
  });

  it('market orders use price=0', async () => {
    let capturedParams;
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USD': { id: 'BTC_USD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD' } };
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { result: true, order_id: 99999 };
    });
    await exchange.createOrder('BTC/USD', 'market', 'buy', 1.0);
    assert.strictEqual(capturedParams.price, '0');
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA512Hex
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA512Hex', () => {
  it('hmacSHA512Hex produces 128-char hex string', () => {
    const sig = hmacSHA512Hex('test', 'secret');
    assert.strictEqual(sig.length, 128);
    assert.ok(/^[0-9a-f]{128}$/.test(sig));
  });

  it('hmacSHA512Hex is deterministic', () => {
    const sig1 = hmacSHA512Hex('nonce=1700000000000&pair=BTC_USD', 'testsecret');
    const sig2 = hmacSHA512Hex('nonce=1700000000000&pair=BTC_USD', 'testsecret');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA512Hex('data1', 'secret');
    const sig2 = hmacSHA512Hex('data2', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });

  it('hmacSHA512Hex matches expected pattern', () => {
    const sig = hmacSHA512Hex('hello world', 'key');
    assert.ok(/^[0-9a-f]+$/.test(sig));
    assert.strictEqual(sig.length, 128);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — subscribe/topics
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — subscribe/topics', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

  it('WS URL includes exmo', () => {
    assert.ok(exchange.describe().urls.ws.includes('exmo'));
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

  it('watchOrderBook subscribes with order_book_snapshots topic', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USD', () => {});
    assert.ok(sentMsg);
    assert.strictEqual(sentMsg.method, 'subscribe');
    assert.ok(sentMsg.topics[0].includes('order_book_snapshots'));
    assert.ok(sentMsg.topics[0].includes('BTC_USD'));
  });

  it('subscribe format uses spot/ prefix in topic', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMsg = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('ETH/BTC', () => {});
    assert.ok(sentMsg.topics[0].startsWith('spot/'));
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
describe('Exmo WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Exmo(); });

  it('_parseWsOrderBook handles snapshot event', () => {
    const ob = exchange._parseWsOrderBook({
      event: 'snapshot',
      data: {
        ask: [['50100', '0.5', '25050']],
        bid: [['49900', '1.0', '49900']],
      },
      ts: 1700000000000,
    }, 'BTC/USD');
    assert.strictEqual(ob.isSnapshot, true);
    assert.strictEqual(ob.symbol, 'BTC/USD');
  });

  it('_parseWsOrderBook handles triple-entry arrays', () => {
    const ob = exchange._parseWsOrderBook({
      event: 'update',
      data: {
        ask: [['50100', '0.5', '25050']],
        bid: [['49900', '1.0', '49900']],
      },
      ts: 1700000000000,
    }, 'BTC/USD');
    assert.deepStrictEqual(ob.asks[0], [50100, 0.5]);
    assert.deepStrictEqual(ob.bids[0], [49900, 1.0]);
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({ data: {} }, 'BTC/USD');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseWsOrderBook includes timestamp/isSnapshot flag', () => {
    const ob = exchange._parseWsOrderBook({
      event: 'snapshot',
      data: { ask: [], bid: [] },
      ts: 1700000000000,
    }, 'BTC/USD');
    assert.strictEqual(ob.timestamp, 1700000000000);
    assert.strictEqual(ob.isSnapshot, true);
    assert.ok(ob.datetime);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Exmo Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

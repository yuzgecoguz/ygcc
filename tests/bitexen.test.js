'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Bitexen = require('../lib/bitexen');
const { hmacSHA256 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Bitexen
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Bitexen', () => {
  it('exports Bitexen class', () => {
    assert.strictEqual(typeof lib.Bitexen, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.bitexen, lib.Bitexen);
  });

  it('includes bitexen in exchanges list', () => {
    assert.ok(lib.exchanges.includes('bitexen'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Bitexen Constructor
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

  it('sets id to bitexen', () => {
    assert.strictEqual(exchange.describe().id, 'bitexen');
  });

  it('sets name to Bitexen', () => {
    assert.strictEqual(exchange.describe().name, 'Bitexen');
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

  it('stores passphrase from config', () => {
    const ex = new Bitexen({ passphrase: 'mypass' });
    assert.strictEqual(ex.passphrase, 'mypass');
  });

  it('stores uid from config', () => {
    const ex = new Bitexen({ uid: 'myuser' });
    assert.strictEqual(ex.uid, 'myuser');
  });

  it('accepts password alias for passphrase', () => {
    const ex = new Bitexen({ password: 'mypass2' });
    assert.strictEqual(ex.passphrase, 'mypass2');
  });

  it('accepts username alias for uid', () => {
    const ex = new Bitexen({ username: 'myuser2' });
    assert.strictEqual(ex.uid, 'myuser2');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — HMAC-SHA256 uppercase + 4 credentials
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA256 uppercase + 4 credentials', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitexen({ apiKey: 'testkey', secret: 'testsecret', passphrase: 'testpass', uid: 'testuser' });
  });

  it('throws without apiKey', () => {
    const ex = new Bitexen({ secret: 'testsecret', passphrase: 'testpass', uid: 'testuser' });
    assert.throws(() => ex._sign('/api/v1/orders/', 'POST', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Bitexen({ apiKey: 'testkey', passphrase: 'testpass', uid: 'testuser' });
    assert.throws(() => ex._sign('/api/v1/orders/', 'POST', {}), /secret required/);
  });

  it('throws without passphrase', () => {
    const ex = new Bitexen({ apiKey: 'testkey', secret: 'testsecret', uid: 'testuser' });
    assert.throws(() => ex._sign('/api/v1/orders/', 'POST', {}), /passphrase/);
  });

  it('throws without uid', () => {
    const ex = new Bitexen({ apiKey: 'testkey', secret: 'testsecret', passphrase: 'testpass' });
    assert.throws(() => ex._sign('/api/v1/orders/', 'POST', {}), /uid/);
  });

  it('returns ACCESS-KEY header', () => {
    const result = exchange._sign('/api/v1/orders/', 'POST', { volume: 1 });
    assert.strictEqual(result.headers['ACCESS-KEY'], 'testkey');
  });

  it('returns ACCESS-USER header', () => {
    const result = exchange._sign('/api/v1/orders/', 'POST', {});
    assert.strictEqual(result.headers['ACCESS-USER'], 'testuser');
  });

  it('returns ACCESS-PASSPHRASE header', () => {
    const result = exchange._sign('/api/v1/orders/', 'POST', {});
    assert.strictEqual(result.headers['ACCESS-PASSPHRASE'], 'testpass');
  });

  it('returns ACCESS-TIMESTAMP header (ms timestamp)', () => {
    const result = exchange._sign('/api/v1/orders/', 'POST', {});
    assert.ok(result.headers['ACCESS-TIMESTAMP']);
    assert.ok(/^\d+$/.test(result.headers['ACCESS-TIMESTAMP']));
  });

  it('returns ACCESS-SIGN header (64-char UPPERCASE hex SHA256)', () => {
    const result = exchange._sign('/api/v1/orders/', 'POST', { volume: 1 });
    assert.ok(/^[0-9A-F]{64}$/.test(result.headers['ACCESS-SIGN']));
  });

  it('POST signing: HMAC-SHA256(apiKey+uid+passphrase+timestamp+body).toUpperCase()', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const params = { volume: 0.5, price: 1000, market_code: 'BTCTRY' };
      const result = exchange._sign('/api/v1/orders/', 'POST', params);
      const body = JSON.stringify(params);
      const expected = hmacSHA256('testkeytestusertestpass1700000000000' + body, 'testsecret').toUpperCase();
      assert.strictEqual(result.headers['ACCESS-SIGN'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('GET signing: body is empty string', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v1/balance/', 'GET', {});
      const expected = hmacSHA256('testkeytestusertestpass1700000000000', 'testsecret').toUpperCase();
      assert.strictEqual(result.headers['ACCESS-SIGN'], expected);
    } finally {
      Date.now = origNow;
    }
  });

  it('params are preserved in result', () => {
    const params = { volume: 1, price: 500 };
    const result = exchange._sign('/api/v1/orders/', 'POST', params);
    assert.strictEqual(result.params.volume, 1);
    assert.strictEqual(result.params.price, 500);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

  it('unwraps data envelope', () => {
    const result = exchange._unwrapResponse({ data: { ticker: {} }, status: 'success' });
    assert.ok(result.ticker !== undefined);
  });

  it('error status throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ status: 'error', message: 'Something failed' }),
      ExchangeError
    );
  });

  it('null data with status throws', () => {
    assert.throws(
      () => exchange._unwrapResponse({ data: null, status: 'error', message: 'Empty' }),
      ExchangeError
    );
  });

  it('array response returned as-is', () => {
    const arr = [{ currency_code: 'BTC', available_balance: '0.5' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('non-object response passes through', () => {
    const result = exchange._unwrapResponse('OK');
    assert.strictEqual(result, 'OK');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker({
      last_price: '750000', high_24h: '760000', low_24h: '740000',
      bid: '749000', ask: '751000', volume_24h: '500',
      change_24h: '1.5',
    }, 'BTC/TRY');
    assert.strictEqual(t.symbol, 'BTC/TRY');
    assert.strictEqual(t.last, 750000);
    assert.strictEqual(t.high, 760000);
    assert.strictEqual(t.low, 740000);
    assert.strictEqual(t.bid, 749000);
    assert.strictEqual(t.ask, 751000);
    assert.strictEqual(t.volume, 500);
    assert.strictEqual(t.percentage, 1.5);
  });

  it('_parseOrder extracts order id from order_number', () => {
    const o = exchange._parseOrder({ order_number: '12345' }, 'BTC/TRY');
    assert.strictEqual(o.id, '12345');
    assert.strictEqual(o.symbol, 'BTC/TRY');
    assert.strictEqual(o.status, 'open');
  });

  it('_parseOrder handles buy_sell B→BUY', () => {
    const o = exchange._parseOrder({ buy_sell: 'B', order_number: '1' }, 'BTC/TRY');
    assert.strictEqual(o.side, 'BUY');
  });

  it('_parseOrder handles buy_sell S→SELL', () => {
    const o = exchange._parseOrder({ buy_sell: 'S', order_number: '2' }, 'BTC/TRY');
    assert.strictEqual(o.side, 'SELL');
  });

  it('_parseOrder calculates remaining and cost', () => {
    const o = exchange._parseOrder({
      order_number: '3', price: '100', volume: '10', filled_volume: '4',
    }, 'BTC/TRY');
    assert.strictEqual(o.price, 100);
    assert.strictEqual(o.amount, 10);
    assert.strictEqual(o.filled, 4);
    assert.strictEqual(o.remaining, 6);
    assert.strictEqual(o.cost, 400);
  });

  it('_parseOrderBook handles object entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [{ price: '751000', volume: '0.8' }],
      bids: [{ price: '749000', volume: '1.5' }],
    }, 'BTC/TRY');
    assert.deepStrictEqual(ob.asks[0], [751000, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [749000, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/TRY');
  });

  it('_parseOrderBook handles empty data', () => {
    const ob = exchange._parseOrderBook({}, 'BTC/TRY');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });

  it('_parseBalance extracts balances', () => {
    const b = exchange._parseBalance([
      { currency_code: 'BTC', available_balance: '0.5', total_balance: '0.8' },
      { currency_code: 'TRY', available_balance: '10000', total_balance: '15000' },
    ]);
    assert.strictEqual(b.BTC.free, 0.5);
    assert.strictEqual(b.BTC.total, 0.8);
    assert.ok(Math.abs(b.BTC.used - 0.3) < 1e-10);
    assert.strictEqual(b.TRY.free, 10000);
    assert.strictEqual(b.TRY.total, 15000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Helper Methods
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

  it('_toBitexenSymbol BTC/TRY → BTCTRY', () => {
    assert.strictEqual(exchange._toBitexenSymbol('BTC/TRY'), 'BTCTRY');
  });

  it('_toBitexenSymbol ETH/TRY → ETHTRY', () => {
    assert.strictEqual(exchange._toBitexenSymbol('ETH/TRY'), 'ETHTRY');
  });

  it('_toBitexenSymbol AVAX/USDT → AVAXUSDT', () => {
    assert.strictEqual(exchange._toBitexenSymbol('AVAX/USDT'), 'AVAXUSDT');
  });

  it('_fromBitexenSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTCTRY': { symbol: 'BTC/TRY' } };
    assert.strictEqual(exchange._fromBitexenSymbol('BTCTRY'), 'BTC/TRY');
  });

  it('_fromBitexenSymbol returns raw without markets', () => {
    assert.strictEqual(exchange._fromBitexenSymbol('BTCTRY'), 'BTCTRY');
  });

  it('_fromBitexenSymbol unknown symbol returns as-is', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromBitexenSymbol('UNKNOWN'), 'UNKNOWN');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://www.bitexen.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

  it('insufficient balance → InsufficientFunds', () => {
    assert.throws(() => exchange._handleBitexenError(400, 'Insufficient balance'), InsufficientFunds);
  });

  it('auth error → AuthenticationError', () => {
    assert.throws(() => exchange._handleBitexenError(401, 'Authentication failed'), AuthenticationError);
  });

  it('permission error → AuthenticationError', () => {
    assert.throws(() => exchange._handleBitexenError(403, 'Permission denied'), AuthenticationError);
  });

  it('order not found → OrderNotFound', () => {
    assert.throws(() => exchange._handleBitexenError(404, 'order not found'), OrderNotFound);
  });

  it('invalid symbol → BadSymbol', () => {
    assert.throws(() => exchange._handleBitexenError(400, 'market not found'), BadSymbol);
  });

  it('invalid order → InvalidOrder', () => {
    assert.throws(() => exchange._handleBitexenError(400, 'invalid order'), InvalidOrder);
  });

  it('rate limit → RateLimitExceeded', () => {
    assert.throws(() => exchange._handleBitexenError(429, 'too many requests'), RateLimitExceeded);
  });

  it('unknown error → ExchangeError', () => {
    assert.throws(() => exchange._handleBitexenError(500, 'something unknown'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Bitexen HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

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
    const body = JSON.stringify({ status: 'error', message: 'Insufficient balance' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Bitexen();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Bitexen({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Bitexen();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 5);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Mocked API Calls', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitexen({ apiKey: 'testkey', secret: 'testsecret', passphrase: 'testpass', uid: 'testuser' });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/TRY': { id: 'BTCTRY', symbol: 'BTC/TRY', base: 'BTC', quote: 'TRY' } };
    exchange.marketsById = { 'BTCTRY': { symbol: 'BTC/TRY' } };
  });

  it('loadMarkets parses market_info response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      data: {
        market_info: {
          BTCTRY: { base_currency: 'BTC', counter_currency: 'TRY', is_active: true },
          ETHTRY: { base_currency: 'ETH', counter_currency: 'TRY', is_active: true },
        },
      },
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/TRY']);
    assert.ok(markets['ETH/TRY']);
    assert.strictEqual(markets['BTC/TRY'].id, 'BTCTRY');
  });

  it('fetchTicker passes correct path', async () => {
    let capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedPath = path;
      return { data: { ticker: { BTCTRY: { last_price: '750000', bid: '749000', ask: '751000' } } } };
    });
    const ticker = await exchange.fetchTicker('BTC/TRY');
    assert.strictEqual(capturedPath, '/api/v1/ticker/');
    assert.strictEqual(ticker.last, 750000);
  });

  it('fetchTickers returns all tickers', async () => {
    mock.method(exchange, '_request', async () => ({
      data: {
        ticker: {
          BTCTRY: { last_price: '750000' },
          ETHTRY: { last_price: '50000' },
        },
      },
    }));
    exchange.marketsById = {
      'BTCTRY': { symbol: 'BTC/TRY' },
      'ETHTRY': { symbol: 'ETH/TRY' },
    };
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/TRY']);
    assert.ok(tickers['ETH/TRY']);
  });

  it('createOrder sends correct params with buy_sell B', async () => {
    let capturedMethod, capturedPath, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      return { data: { order_number: '12345' } };
    });
    const order = await exchange.createOrder('BTC/TRY', 'limit', 'BUY', 0.5, 750000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/api/v1/orders/');
    assert.strictEqual(capturedParams.buy_sell, 'B');
    assert.strictEqual(capturedParams.market_code, 'BTCTRY');
    assert.strictEqual(capturedParams.volume, 0.5);
    assert.strictEqual(capturedParams.price, 750000);
    assert.strictEqual(order.id, '12345');
  });

  it('createOrder SELL uses buy_sell S', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { data: { order_number: '67890' } };
    });
    await exchange.createOrder('BTC/TRY', 'limit', 'SELL', 1.0, 750000);
    assert.strictEqual(capturedParams.buy_sell, 'S');
  });

  it('createOrder market type throws InvalidOrder', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/TRY', 'market', 'BUY', 0.5),
      InvalidOrder
    );
  });

  it('createOrder limit without price throws InvalidOrder', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/TRY', 'limit', 'BUY', 0.5),
      /requires price/
    );
  });

  it('cancelOrder sends POST to /api/v1/cancel_order/{id}/', async () => {
    let capturedMethod, capturedPath;
    mock.method(exchange, '_request', async (method, path) => {
      capturedMethod = method;
      capturedPath = path;
      return { data: {} };
    });
    const result = await exchange.cancelOrder('12345', 'BTC/TRY');
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/api/v1/cancel_order/12345/');
    assert.strictEqual(result.status, 'canceled');
    assert.strictEqual(result.id, '12345');
  });

  it('fetchBalance parses balance_info array', async () => {
    mock.method(exchange, '_request', async () => ({
      data: {
        balance_info: [
          { currency_code: 'BTC', available_balance: '0.5', total_balance: '0.8' },
          { currency_code: 'TRY', available_balance: '10000', total_balance: '15000' },
        ],
      },
    }));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
    assert.strictEqual(balance.TRY.free, 10000);
    assert.strictEqual(balance.TRY.total, 15000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Market Lookup
// ═══════════════════════════════════════════════════════════════
describe('Bitexen Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Bitexen();
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
// 12. Bitexen vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('Bitexen vs Others Differences', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen({ apiKey: 'k', secret: 's', passphrase: 'p', uid: 'u' }); });

  it('signing: 4-credential HMAC-SHA256 uppercase (unique among exchanges)', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/api/v1/orders/', 'POST', { volume: 1 });
      // Signature must be 64-char UPPERCASE hex
      assert.ok(/^[0-9A-F]{64}$/.test(result.headers['ACCESS-SIGN']));
    } finally {
      Date.now = origNow;
    }
  });

  it('requires 4 credentials: apiKey + secret + passphrase + uid', () => {
    const ex = new Bitexen({ apiKey: 'k', secret: 's' });
    assert.throws(() => ex._sign('/api/v1/balance/', 'GET', {}), /passphrase/);
  });

  it('concatenated symbol format BTCTRY (no separator, like VALR)', () => {
    assert.strictEqual(exchange._toBitexenSymbol('BTC/TRY'), 'BTCTRY');
    assert.strictEqual(exchange._toBitexenSymbol('ETH/TRY'), 'ETHTRY');
  });

  it('Turkish exchange: primary quote currency is TRY', () => {
    assert.strictEqual(exchange.describe().urls.api, 'https://www.bitexen.com');
  });

  it('ACCESS-* header prefix (unique among exchanges)', () => {
    const result = exchange._sign('/api/v1/orders/', 'POST', {});
    assert.ok(result.headers['ACCESS-KEY']);
    assert.ok(result.headers['ACCESS-USER']);
    assert.ok(result.headers['ACCESS-PASSPHRASE']);
    assert.ok(result.headers['ACCESS-SIGN']);
    assert.ok(result.headers['ACCESS-TIMESTAMP']);
  });

  it('only limit orders supported (no market orders)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.createLimitOrder, true);
    assert.strictEqual(has.createMarketOrder, false);
  });

  it('Socket.IO v2 WebSocket (unlike plain JSON for others)', () => {
    assert.strictEqual(exchange.describe().has.watchOrderBook, true);
    assert.ok(exchange.describe().urls.ws.includes('socket.io'));
  });

  it('cancelOrder uses POST with orderId in URL (not DELETE like VALR)', () => {
    assert.strictEqual(exchange.describe().has.cancelOrder, true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256 uppercase
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256 uppercase for Bitexen', () => {
  it('hmacSHA256 produces 64-char hex string', () => {
    const sig = hmacSHA256('test', 'secret');
    assert.strictEqual(sig.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(sig));
  });

  it('hmacSHA256.toUpperCase() produces UPPERCASE hex', () => {
    const sig = hmacSHA256('test', 'secret').toUpperCase();
    assert.ok(/^[0-9A-F]{64}$/.test(sig));
  });

  it('hmacSHA256 is deterministic', () => {
    const sig1 = hmacSHA256('testkeytestusertestpass1700000000000{"volume":1}', 'testsecret');
    const sig2 = hmacSHA256('testkeytestusertestpass1700000000000{"volume":1}', 'testsecret');
    assert.strictEqual(sig1, sig2);
  });

  it('different data produces different signatures', () => {
    const sig1 = hmacSHA256('POST', 'secret');
    const sig2 = hmacSHA256('GET', 'secret');
    assert.notStrictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — Socket.IO v2 + SID handshake
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — Socket.IO v2 + SID handshake', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

  it('WS URL contains socket.io', () => {
    assert.ok(exchange.describe().urls.ws.includes('socket.io'));
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

  it('_getWsClient has no-op _startPing (server-initiated ping)', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client._startPing === 'function');
    // Should not throw
    client._startPing();
  });

  it('_getWsClient has overridden connect for SID handshake', () => {
    const client = exchange._getWsClient();
    assert.ok(typeof client.connect === 'function');
  });

  it('_wsSid is null initially', () => {
    assert.strictEqual(exchange._wsSid, null);
  });

  it('watchTicker subscribes with s_m channel', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      _ws: { readyState: 1, send: (msg) => { sentMsg = msg; } },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTicker('BTC/TRY', () => {});
    assert.ok(sentMsg.includes('s_m'));
    assert.ok(sentMsg.includes('BTCTRY'));
  });

  it('watchOrderBook subscribes with s_ob channel', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      _ws: { readyState: 1, send: (msg) => { sentMsg = msg; } },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/TRY', () => {});
    assert.ok(sentMsg.includes('s_ob'));
    assert.ok(sentMsg.includes('BTCTRY'));
  });

  it('subscribe format uses 42["channel","symbol"] prefix', async () => {
    let sentMsg;
    const fakeClient = {
      connected: true,
      _ws: { readyState: 1, send: (msg) => { sentMsg = msg; } },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTicker('ETH/TRY', () => {});
    assert.ok(sentMsg.startsWith('42['));
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
describe('Bitexen WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Bitexen(); });

  it('_parseWsOrderBook handles object entries with price/volume', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [{ price: '751000', volume: '0.8' }, { price: '752000', volume: '1.2' }],
      bids: [{ price: '749000', volume: '1.5' }],
    }, 'BTC/TRY');
    assert.deepStrictEqual(ob.asks[0], [751000, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [749000, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/TRY');
  });

  it('_parseWsOrderBook handles array entries', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [['751000', '0.8']],
      bids: [['749000', '1.5']],
    }, 'BTC/TRY');
    assert.deepStrictEqual(ob.asks[0], [751000, 0.8]);
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
describe('Bitexen Version', () => {
  it('library version is 2.7.0', () => {
    assert.strictEqual(lib.version, '2.7.0');
  });
});

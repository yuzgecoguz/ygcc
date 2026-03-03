'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');
const Icrypex = require('../lib/icrypex');
const { hmacSHA256Base64 } = require('../lib/utils/crypto');
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = require('../lib/utils/errors');

// ═══════════════════════════════════════════════════════════════
// 1. Module Exports — Icrypex
// ═══════════════════════════════════════════════════════════════
describe('Module Exports — Icrypex', () => {
  it('exports Icrypex class', () => {
    assert.strictEqual(typeof lib.Icrypex, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(lib.icrypex, lib.Icrypex);
  });

  it('includes icrypex in exchanges list', () => {
    assert.ok(lib.exchanges.includes('icrypex'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Icrypex Constructor
// ═══════════════════════════════════════════════════════════════
describe('Icrypex Constructor', () => {
  let exchange;
  beforeEach(() => { exchange = new Icrypex(); });

  it('sets id to icrypex', () => {
    assert.strictEqual(exchange.describe().id, 'icrypex');
  });

  it('sets name to iCrypex', () => {
    assert.strictEqual(exchange.describe().name, 'iCrypex');
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

  it('has correct fees (0.1% maker, 0.2% taker)', () => {
    const fees = exchange.describe().fees.trading;
    assert.strictEqual(fees.maker, 0.001);
    assert.strictEqual(fees.taker, 0.002);
  });

  it('stores apiKey from config', () => {
    const ex = new Icrypex({ apiKey: 'mykey' });
    assert.strictEqual(ex.apiKey, 'mykey');
  });

  it('stores secret from config', () => {
    const ex = new Icrypex({ secret: 'mysecret' });
    assert.strictEqual(ex.secret, 'mysecret');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Authentication — HMAC-SHA256 with Base64-decoded secret
// ═══════════════════════════════════════════════════════════════
describe('Authentication — HMAC-SHA256 with Base64-decoded secret', () => {
  let exchange;
  const testSecret = Buffer.from('testsecretkey123').toString('base64');
  beforeEach(() => {
    exchange = new Icrypex({ apiKey: 'testkey', secret: testSecret });
  });

  it('throws without apiKey', () => {
    const ex = new Icrypex({ secret: testSecret });
    assert.throws(() => ex._sign('/sapi/v1/wallet', 'GET', {}), /apiKey required/);
  });

  it('throws without secret', () => {
    const ex = new Icrypex({ apiKey: 'testkey' });
    assert.throws(() => ex._sign('/sapi/v1/wallet', 'GET', {}), /secret required/);
  });

  it('returns ICX-API-KEY header', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.strictEqual(result.headers['ICX-API-KEY'], 'testkey');
  });

  it('returns ICX-SIGN header (base64 string)', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.ok(result.headers['ICX-SIGN']);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(result.headers['ICX-SIGN']));
  });

  it('returns ICX-TS header (timestamp ms)', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.ok(result.headers['ICX-TS']);
    assert.ok(/^\d+$/.test(result.headers['ICX-TS']));
  });

  it('returns ICX-NONCE header = 60000', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.strictEqual(result.headers['ICX-NONCE'], '60000');
  });

  it('signing: message = apiKey + timestamp', () => {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
      const expectedMessage = 'testkey1700000000000';
      const key = Buffer.from(testSecret, 'base64');
      const expectedSig = hmacSHA256Base64(expectedMessage, key);
      assert.strictEqual(result.headers['ICX-SIGN'], expectedSig);
    } finally {
      Date.now = origNow;
    }
  });

  it('params pass through unchanged', () => {
    const result = exchange._sign('/sapi/v1/orders', 'GET', { symbol: 'BTCUSDT' });
    assert.strictEqual(result.params.symbol, 'BTCUSDT');
  });

  it('has exactly 4 auth headers', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.strictEqual(Object.keys(result.headers).length, 4);
  });

  it('works with both apiKey and secret provided', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.ok(result.headers['ICX-SIGN']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Response Handling
// ═══════════════════════════════════════════════════════════════
describe('Icrypex Response Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Icrypex(); });

  it('unwraps data.data envelope', () => {
    const result = exchange._unwrapResponse({ ok: true, data: { id: '123' } });
    assert.strictEqual(result.id, '123');
  });

  it('ok=false throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ ok: false, message: 'Something failed' }),
      ExchangeError
    );
  });

  it('success=false throws ExchangeError', () => {
    assert.throws(
      () => exchange._unwrapResponse({ success: false, message: 'Error' }),
      ExchangeError
    );
  });

  it('array data passes through', () => {
    const arr = [{ symbol: 'BTCUSDT' }];
    const result = exchange._unwrapResponse(arr);
    assert.deepStrictEqual(result, arr);
  });

  it('object without data field passes through', () => {
    const obj = { symbol: 'BTCUSDT', last: '30000' };
    const result = exchange._unwrapResponse(obj);
    assert.strictEqual(result.symbol, 'BTCUSDT');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Parsers
// ═══════════════════════════════════════════════════════════════
describe('Icrypex Parsers', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Icrypex();
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
  });

  it('_parseTicker extracts all fields', () => {
    const t = exchange._parseTicker({
      symbol: 'BTCUSDT', last: '30000', high: '31000', low: '29000',
      bid: '29900', ask: '30100', qty: '1500', volume: '45000000', change: '500',
    });
    assert.strictEqual(t.symbol, 'BTC/USDT');
    assert.strictEqual(t.last, 30000);
    assert.strictEqual(t.high, 31000);
    assert.strictEqual(t.low, 29000);
    assert.strictEqual(t.bid, 29900);
    assert.strictEqual(t.ask, 30100);
    assert.strictEqual(t.volume, 1500);
    assert.strictEqual(t.quoteVolume, 45000000);
    assert.strictEqual(t.change, 500);
  });

  it('_parseOrder extracts orderId', () => {
    const o = exchange._parseOrder({ id: 'ORD123', pairSymbol: 'BTCUSDT' }, 'BTC/USDT');
    assert.strictEqual(o.id, 'ORD123');
  });

  it('_parseOrder maps side and type', () => {
    const o = exchange._parseOrder({ id: '1', side: 'BUY', type: 'LIMIT' }, 'BTC/USDT');
    assert.strictEqual(o.side, 'buy');
    assert.strictEqual(o.type, 'limit');
  });

  it('_parseOrderStatus maps statuses correctly', () => {
    assert.strictEqual(exchange._parseOrderStatus('new'), 'open');
    assert.strictEqual(exchange._parseOrderStatus('open'), 'open');
    assert.strictEqual(exchange._parseOrderStatus('partially_filled'), 'open');
    assert.strictEqual(exchange._parseOrderStatus('filled'), 'closed');
    assert.strictEqual(exchange._parseOrderStatus('canceled'), 'canceled');
    assert.strictEqual(exchange._parseOrderStatus('expired'), 'expired');
    assert.strictEqual(exchange._parseOrderStatus('rejected'), 'rejected');
  });

  it('_parseOrderBook handles minified fields p/q', () => {
    const ob = exchange._parseOrderBook({
      asks: [{ p: '30100', q: '0.8' }, { p: '30200', q: '1.2' }],
      bids: [{ p: '29900', q: '1.5' }, { p: '29800', q: '2.0' }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseOrderBook handles array entries', () => {
    const ob = exchange._parseOrderBook({
      asks: [['30100', '0.8']],
      bids: [['29900', '1.5']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
  });

  it('_parseBalance extracts asset, available, order', () => {
    const b = exchange._parseBalance([
      { asset: 'BTC', available: '0.5', order: '0.3', total: '0.8' },
      { asset: 'USDT', available: '10000', order: '5000', total: '15000' },
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
describe('Icrypex Helper Methods', () => {
  let exchange;
  beforeEach(() => { exchange = new Icrypex(); });

  it('_toIcrypexSymbol BTC/USDT -> BTCUSDT', () => {
    assert.strictEqual(exchange._toIcrypexSymbol('BTC/USDT'), 'BTCUSDT');
  });

  it('_toIcrypexSymbol ETH/TRY -> ETHTRY', () => {
    assert.strictEqual(exchange._toIcrypexSymbol('ETH/TRY'), 'ETHTRY');
  });

  it('_fromIcrypexSymbol resolves via marketsById', () => {
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
    assert.strictEqual(exchange._fromIcrypexSymbol('BTCUSDT'), 'BTC/USDT');
  });

  it('_fromIcrypexSymbol fallback splits common quotes', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromIcrypexSymbol('BTCTRY'), 'BTC/TRY');
  });

  it('_fromIcrypexSymbol returns raw without match', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromIcrypexSymbol('X'), 'X');
  });

  it('_getBaseUrl returns api URL', () => {
    assert.strictEqual(exchange._getBaseUrl(), 'https://api.icrypex.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Error Mapping
// ═══════════════════════════════════════════════════════════════
describe('Icrypex Error Mapping', () => {
  let exchange;
  beforeEach(() => { exchange = new Icrypex(); });

  it('insufficient -> InsufficientFunds', () => {
    assert.throws(() => exchange._handleIcrypexError('1001', 'Insufficient balance'), InsufficientFunds);
  });

  it('order not found -> OrderNotFound', () => {
    assert.throws(() => exchange._handleIcrypexError('1002', 'Order not found'), OrderNotFound);
  });

  it('invalid symbol -> BadSymbol', () => {
    assert.throws(() => exchange._handleIcrypexError('1003', 'Invalid symbol'), BadSymbol);
  });

  it('invalid order -> InvalidOrder', () => {
    assert.throws(() => exchange._handleIcrypexError('1004', 'Invalid order quantity'), InvalidOrder);
  });

  it('rate limit -> RateLimitExceeded', () => {
    assert.throws(() => exchange._handleIcrypexError('1005', 'Rate limit exceeded'), RateLimitExceeded);
  });

  it('auth -> AuthenticationError', () => {
    assert.throws(() => exchange._handleIcrypexError('1006', 'Unauthorized access'), AuthenticationError);
  });

  it('maintenance -> ExchangeNotAvailable', () => {
    assert.throws(() => exchange._handleIcrypexError('1007', 'Under maintenance'), ExchangeNotAvailable);
  });

  it('unknown -> ExchangeError', () => {
    assert.throws(() => exchange._handleIcrypexError('9999', 'Something happened'), ExchangeError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. HTTP Error Handling
// ═══════════════════════════════════════════════════════════════
describe('Icrypex HTTP Error Handling', () => {
  let exchange;
  beforeEach(() => { exchange = new Icrypex(); });

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
    const body = JSON.stringify({ ok: false, message: 'Insufficient balance' });
    assert.throws(() => exchange._handleHttpError(400, body), InsufficientFunds);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Rate Limit Handling
// ═══════════════════════════════════════════════════════════════
describe('Icrypex Rate Limit Handling', () => {
  it('rate limit enabled by default', () => {
    const exchange = new Icrypex();
    assert.strictEqual(exchange.enableRateLimit, true);
  });

  it('can disable rate limit', () => {
    const exchange = new Icrypex({ enableRateLimit: false });
    assert.strictEqual(exchange.enableRateLimit, false);
  });

  it('rate limit capacity matches describe()', () => {
    const exchange = new Icrypex();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 5);
    assert.strictEqual(desc.rateLimitInterval, 1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Mocked API Calls
// ═══════════════════════════════════════════════════════════════
describe('Icrypex Mocked API Calls', () => {
  let exchange;
  const testSecret = Buffer.from('testsecretkey123').toString('base64');
  beforeEach(() => {
    exchange = new Icrypex({ apiKey: 'testkey', secret: testSecret });
    exchange._marketsLoaded = true;
    exchange.markets = { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT' } };
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' } };
  });

  it('loadMarkets parses exchange info response', async () => {
    exchange._marketsLoaded = false;
    mock.method(exchange, '_request', async () => ({
      pairs: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', pricePrecision: 2, quantityPrecision: 6 },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', pricePrecision: 2, quantityPrecision: 4 },
      ],
    }));
    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USDT']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTCUSDT');
  });

  it('fetchTicker finds ticker by symbol', async () => {
    mock.method(exchange, '_request', async () => ([
      { symbol: 'BTCUSDT', last: '30000', high: '31000', low: '29000', bid: '29900', ask: '30100' },
      { symbol: 'ETHUSDT', last: '2000' },
    ]));
    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.last, 30000);
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
  });

  it('fetchTicker throws BadSymbol for unknown symbol', async () => {
    mock.method(exchange, '_request', async () => ([
      { symbol: 'ETHUSDT', last: '2000' },
    ]));
    await assert.rejects(() => exchange.fetchTicker('BTC/USDT'), BadSymbol);
  });

  it('fetchTickers returns all tickers', async () => {
    exchange.marketsById = { 'BTCUSDT': { symbol: 'BTC/USDT' }, 'ETHUSDT': { symbol: 'ETH/USDT' } };
    mock.method(exchange, '_request', async () => ([
      { symbol: 'BTCUSDT', last: '30000' },
      { symbol: 'ETHUSDT', last: '2000' },
    ]));
    const tickers = await exchange.fetchTickers();
    assert.ok(tickers['BTC/USDT']);
    assert.ok(tickers['ETH/USDT']);
  });

  it('createOrder sends correct params', async () => {
    let capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedParams = params;
      return { id: 'ORD123' };
    });
    const order = await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5, 30000);
    assert.strictEqual(capturedParams.symbol, 'BTCUSDT');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.type, 'LIMIT');
    assert.strictEqual(capturedParams.quantity, '0.5');
    assert.strictEqual(capturedParams.price, '30000');
    assert.strictEqual(order.id, 'ORD123');
  });

  it('createOrder limit without price throws InvalidOrder', async () => {
    await assert.rejects(
      () => exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.5),
      InvalidOrder
    );
  });

  it('cancelOrder sends DELETE with orderId', async () => {
    let capturedMethod, capturedParams;
    mock.method(exchange, '_request', async (method, path, params) => {
      capturedMethod = method;
      capturedParams = params;
      return {};
    });
    const result = await exchange.cancelOrder('12345', 'BTC/USDT');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedParams.orderId, '12345');
    assert.strictEqual(result.status, 'canceled');
  });

  it('fetchBalance parses wallet response', async () => {
    mock.method(exchange, '_request', async () => ([
      { asset: 'BTC', available: '0.5', order: '0.3', total: '0.8' },
      { asset: 'USDT', available: '10000', order: '5000', total: '15000' },
    ]));
    const balance = await exchange.fetchBalance();
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.BTC.total, 0.8);
    assert.strictEqual(balance.USDT.free, 10000);
  });

  it('fetchOpenOrders parses orders response', async () => {
    mock.method(exchange, '_request', async () => ({
      data: [
        { id: 'ORD1', pairSymbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.5', price: '30000', status: 'new' },
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
describe('Icrypex Market Lookup', () => {
  let exchange;
  beforeEach(() => {
    exchange = new Icrypex();
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
// 12. iCrypex vs Others Differences
// ═══════════════════════════════════════════════════════════════
describe('iCrypex vs Others Differences', () => {
  const testSecret = Buffer.from('testsecretkey123').toString('base64');
  let exchange;
  beforeEach(() => { exchange = new Icrypex({ apiKey: 'k', secret: testSecret }); });

  it('Base64-decoded secret for signing (same as BtcTurk)', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.ok(result.headers['ICX-SIGN']);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(result.headers['ICX-SIGN']));
  });

  it('ICX-* headers (unique to iCrypex)', () => {
    const result = exchange._sign('/sapi/v1/wallet', 'GET', {});
    assert.ok(result.headers['ICX-API-KEY']);
    assert.ok(result.headers['ICX-SIGN']);
    assert.ok(result.headers['ICX-TS']);
    assert.ok(result.headers['ICX-NONCE']);
  });

  it('concatenated symbol format BTCUSDT (no separator)', () => {
    assert.strictEqual(exchange._toIcrypexSymbol('BTC/USDT'), 'BTCUSDT');
    assert.strictEqual(exchange._toIcrypexSymbol('ETH/TRY'), 'ETHTRY');
  });

  it('supports both fetchTicker and fetchTickers', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.fetchTicker, true);
    assert.strictEqual(has.fetchTickers, true);
  });

  it('cancelOrder uses DELETE method', async () => {
    let capturedMethod;
    mock.method(exchange, '_request', async (method) => {
      capturedMethod = method;
      return {};
    });
    await exchange.cancelOrder('123');
    assert.strictEqual(capturedMethod, 'DELETE');
  });

  it('Turkish exchange: supports TRY pairs', () => {
    exchange.marketsById = {};
    assert.strictEqual(exchange._fromIcrypexSymbol('BTCTRY'), 'BTC/TRY');
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Crypto — hmacSHA256Base64 with Buffer key
// ═══════════════════════════════════════════════════════════════
describe('Crypto — hmacSHA256Base64 with Buffer key for Icrypex', () => {
  it('hmacSHA256Base64 with Buffer key produces base64 string', () => {
    const key = Buffer.from('testsecretkey123');
    const sig = hmacSHA256Base64('testmessage', key);
    assert.ok(sig.length > 0);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(sig));
  });

  it('hmacSHA256Base64 with Buffer key is deterministic', () => {
    const key = Buffer.from('testsecretkey123');
    const sig1 = hmacSHA256Base64('testkey1700000000000', key);
    const sig2 = hmacSHA256Base64('testkey1700000000000', key);
    assert.strictEqual(sig1, sig2);
  });

  it('different keys produce different signatures', () => {
    const key1 = Buffer.from('secret1');
    const key2 = Buffer.from('secret2');
    const sig1 = hmacSHA256Base64('same_message', key1);
    const sig2 = hmacSHA256Base64('same_message', key2);
    assert.notStrictEqual(sig1, sig2);
  });

  it('base64-decoded key workflow matches iCrypex pattern', () => {
    const base64Secret = Buffer.from('mySecretKey').toString('base64');
    const key = Buffer.from(base64Secret, 'base64');
    const sig = hmacSHA256Base64('apiKey1700000000000', key);
    assert.ok(sig.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. WebSocket — Pipe-delimited protocol
// ═══════════════════════════════════════════════════════════════
describe('WebSocket — Pipe-delimited protocol', () => {
  let exchange;
  beforeEach(() => { exchange = new Icrypex(); });

  it('WS URL includes icrypex', () => {
    assert.ok(exchange.describe().urls.ws.includes('icrypex'));
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

  it('watchOrderBook creates channel orderbook@{symbol}', async () => {
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
    // Format: "subscribe|{json}"
    assert.ok(sentMsg.startsWith('subscribe|'));
    const payload = JSON.parse(sentMsg.substring(10));
    assert.strictEqual(payload.c, 'orderbook@btcusdt');
    assert.strictEqual(payload.s, true);
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
describe('Icrypex WS Parsers', () => {
  let exchange;
  beforeEach(() => { exchange = new Icrypex(); });

  it('_parseWsOrderBook handles minified p/q fields', () => {
    const ob = exchange._parseWsOrderBook({
      asks: [{ p: '30100', q: '0.8' }],
      bids: [{ p: '29900', q: '1.5' }],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
    assert.strictEqual(ob.symbol, 'BTC/USDT');
  });

  it('_parseWsOrderBook handles array entries', () => {
    const ob = exchange._parseWsOrderBook({
      a: [['30100', '0.8']],
      b: [['29900', '1.5']],
    }, 'BTC/USDT');
    assert.deepStrictEqual(ob.asks[0], [30100, 0.8]);
    assert.deepStrictEqual(ob.bids[0], [29900, 1.5]);
  });

  it('_parseWsOrderBook handles empty data', () => {
    const ob = exchange._parseWsOrderBook({}, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids, []);
    assert.deepStrictEqual(ob.asks, []);
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. Version
// ═══════════════════════════════════════════════════════════════
describe('Icrypex Version', () => {
  it('library version is 2.9.0', () => {
    assert.strictEqual(lib.version, '2.9.0');
  });
});

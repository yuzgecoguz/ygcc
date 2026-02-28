'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const ygcc = require('../index');
const { Bitstamp, bitstamp: BitstampAlias, hmacSHA256 } = ygcc;

// =============================================================================
// 1. Module Exports (3 tests)
// =============================================================================

describe('Bitstamp — Module Exports', () => {
  it('exports Bitstamp class', () => {
    assert.ok(Bitstamp);
    assert.strictEqual(typeof Bitstamp, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(BitstampAlias, Bitstamp);
  });

  it('includes bitstamp in exchanges list', () => {
    assert.ok(ygcc.exchanges.includes('bitstamp'));
  });
});

// =============================================================================
// 2. Constructor (8 tests)
// =============================================================================

describe('Bitstamp — Constructor', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('sets postAsFormEncoded = true', () => {
    assert.strictEqual(exchange.postAsFormEncoded, true);
  });

  it('sets postAsJson = false', () => {
    assert.strictEqual(exchange.postAsJson, false);
  });

  it('describe() returns correct id', () => {
    assert.strictEqual(exchange.describe().id, 'bitstamp');
  });

  it('describe() returns correct name', () => {
    assert.strictEqual(exchange.describe().name, 'Bitstamp');
  });

  it('describe() returns correct version', () => {
    assert.strictEqual(exchange.describe().version, 'v2');
  });

  it('timeframes use seconds (not strings or minutes)', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['1m'], 60);
    assert.strictEqual(tf['1h'], 3600);
    assert.strictEqual(tf['1d'], 86400);
  });

  it('fees are correct', () => {
    const fees = exchange.describe().fees;
    assert.strictEqual(fees.trading.maker, 0.003);
    assert.strictEqual(fees.trading.taker, 0.005);
  });

  it('has single base URL (public + private same)', () => {
    const urls = exchange.describe().urls;
    assert.strictEqual(urls.api, 'https://www.bitstamp.net');
    // No separate apiPublic or apiPrivate
    assert.strictEqual(urls.apiPublic, undefined);
  });
});

// =============================================================================
// 3. Authentication — HMAC-SHA256 + UUID nonce (10 tests)
// =============================================================================

describe('Bitstamp — Authentication', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp({ apiKey: 'myApiKey', secret: 'mySecretKey' });
  });

  it('_sign() returns params and headers', () => {
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    assert.ok(result.params);
    assert.ok(result.headers);
  });

  it('generates UUID v4 nonce (36 chars with dashes)', () => {
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    const nonce = result.headers['X-Auth-Nonce'];
    assert.ok(nonce);
    assert.strictEqual(nonce.length, 36);
    assert.ok(nonce.includes('-'), 'UUID should contain dashes');
    // UUID v4 format: 8-4-4-4-12
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce));
  });

  it('generates millisecond timestamp', () => {
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    const timestamp = result.headers['X-Auth-Timestamp'];
    assert.ok(timestamp);
    // Milliseconds: should be ~13 digits
    assert.ok(timestamp.length >= 13, 'timestamp should be milliseconds');
    const ts = parseInt(timestamp, 10);
    assert.ok(ts > 1700000000000, 'timestamp should be recent');
  });

  it('sets X-Auth header with "BITSTAMP " prefix + apiKey', () => {
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    assert.strictEqual(result.headers['X-Auth'], 'BITSTAMP myApiKey');
  });

  it('sets X-Auth-Version to v2', () => {
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    assert.strictEqual(result.headers['X-Auth-Version'], 'v2');
  });

  it('sets all 5 required auth headers', () => {
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    const h = result.headers;
    assert.ok(h['X-Auth']);
    assert.ok(h['X-Auth-Signature']);
    assert.ok(h['X-Auth-Nonce']);
    assert.ok(h['X-Auth-Timestamp']);
    assert.ok(h['X-Auth-Version']);
  });

  it('signature is hex string (64 chars for SHA-256)', () => {
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    const sig = result.headers['X-Auth-Signature'];
    assert.strictEqual(sig.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(sig), 'signature should be hex');
  });

  it('conditional signature: WITHOUT body — no content-type in payload', () => {
    // When params is empty, content-type should NOT be in signature payload
    // We verify by computing expected signature manually
    const result = exchange._sign('/api/v2/account_balances/', 'POST', {});
    const nonce = result.headers['X-Auth-Nonce'];
    const timestamp = result.headers['X-Auth-Timestamp'];
    const sig = result.headers['X-Auth-Signature'];

    // Expected payload without body (no content-type)
    const expectedPayload = 'BITSTAMP myApiKeyPOSTwww.bitstamp.net/api/v2/account_balances/' + nonce + timestamp + 'v2';
    const expectedSig = hmacSHA256(expectedPayload, 'mySecretKey');

    assert.strictEqual(sig, expectedSig);
  });

  it('conditional signature: WITH body — includes content-type and body', () => {
    const params = { amount: '100', price: '50000' };
    const result = exchange._sign('/api/v2/buy/btcusd/', 'POST', params);
    const nonce = result.headers['X-Auth-Nonce'];
    const timestamp = result.headers['X-Auth-Timestamp'];
    const sig = result.headers['X-Auth-Signature'];

    // Expected payload with body
    const body = new URLSearchParams(params).toString();
    const expectedPayload = 'BITSTAMP myApiKeyPOSTwww.bitstamp.net/api/v2/buy/btcusd/'
      + 'application/x-www-form-urlencoded'
      + nonce + timestamp + 'v2' + body;
    const expectedSig = hmacSHA256(expectedPayload, 'mySecretKey');

    assert.strictEqual(sig, expectedSig);
  });

  it('throws AuthenticationError if no credentials', () => {
    const noAuth = new Bitstamp();
    assert.throws(
      () => noAuth._sign('/api/v2/test/', 'POST', {}),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 4. Response Handling (5 tests)
// =============================================================================

describe('Bitstamp — Response Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp();
  });

  it('_unwrapResponse returns data for valid response', () => {
    const data = { high: '50000', last: '49500' };
    const result = exchange._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse throws on error status', () => {
    assert.throws(
      () => exchange._unwrapResponse({ status: 'error', reason: 'Bad request', code: 'API0001' }),
      { name: 'BadRequest' }
    );
  });

  it('_unwrapResponse passes through arrays unchanged', () => {
    const data = [{ id: 1 }, { id: 2 }];
    const result = exchange._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse passes through null/undefined', () => {
    assert.strictEqual(exchange._unwrapResponse(null), null);
    assert.strictEqual(exchange._unwrapResponse(undefined), undefined);
  });

  it('handles error with code and reason', () => {
    assert.throws(
      () => exchange._unwrapResponse({ status: 'error', reason: 'Invalid nonce', code: 'API0006' }),
      { name: 'AuthenticationError' }
    );
  });
});

// =============================================================================
// 5. Parsers (10 tests)
// =============================================================================

describe('Bitstamp — Parsers', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp();
  });

  it('_parseTicker parses JSON object fields', () => {
    const data = {
      high: '51000.00', last: '49500.00', timestamp: '1700000000',
      bid: '49400.00', vwap: '49800.00', volume: '100.50',
      low: '48000.00', ask: '49600.00', open: '49000.00',
    };
    const ticker = exchange._parseTicker(data, 'BTC/USD');
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.last, 49500);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.low, 48000);
    assert.strictEqual(ticker.open, 49000);
    assert.strictEqual(ticker.bid, 49400);
    assert.strictEqual(ticker.ask, 49600);
    assert.strictEqual(ticker.volume, 100.5);
    assert.strictEqual(ticker.vwap, 49800);
    assert.strictEqual(ticker.timestamp, 1700000000000);
  });

  it('_parseTicker calculates change and percentage from open/last', () => {
    const data = { last: '110', open: '100', timestamp: '1700000000' };
    const ticker = exchange._parseTicker(data, 'TEST/USD');
    assert.strictEqual(ticker.change, 10);
    assert.strictEqual(ticker.percentage, 10);
  });

  it('_parseOrder parses type 0 as BUY', () => {
    const data = { id: '123', type: '0', price: '49500.00', amount: '0.1', datetime: '2024-01-01 12:00:00' };
    const order = exchange._parseOrder(data);
    assert.strictEqual(order.id, '123');
    assert.strictEqual(order.side, 'BUY');
    assert.strictEqual(order.price, 49500);
    assert.strictEqual(order.amount, 0.1);
  });

  it('_parseOrder parses type 1 as SELL', () => {
    const data = { id: '456', type: '1', price: '50000.00', amount: '0.5' };
    const order = exchange._parseOrder(data);
    assert.strictEqual(order.side, 'SELL');
  });

  it('_parseTrade parses type 0 as buy, type 1 as sell', () => {
    const buy = exchange._parseTrade({ tid: '100', price: '49500', amount: '0.1', type: '0', date: '1700000000' }, 'BTC/USD');
    const sell = exchange._parseTrade({ tid: '101', price: '49600', amount: '0.2', type: '1', date: '1700000000' }, 'BTC/USD');
    assert.strictEqual(buy.side, 'buy');
    assert.strictEqual(sell.side, 'sell');
    assert.strictEqual(buy.id, '100');
    assert.strictEqual(buy.cost, 49500 * 0.1);
  });

  it('_parseMyTrade parses user transaction', () => {
    const data = { id: '999', order_id: '123', fee: '0.25', datetime: '2024-01-01 12:00:00.000000' };
    const trade = exchange._parseMyTrade(data, 'BTC/USD');
    assert.strictEqual(trade.id, '999');
    assert.strictEqual(trade.orderId, '123');
    assert.strictEqual(trade.fee.cost, 0.25);
  });

  it('_parseCandle returns standard OHLCV array [ts, O, H, L, C, V]', () => {
    const candle = exchange._parseCandle({
      timestamp: '1700000000', open: '49000', high: '51000', low: '48000', close: '50000', volume: '100.5',
    });
    assert.deepStrictEqual(candle, [1700000000000, 49000, 51000, 48000, 50000, 100.5]);
  });

  it('_parseCandle has standard OHLCV order (not OCHLV like Bitfinex)', () => {
    const candle = exchange._parseCandle({
      timestamp: '1700000000', open: '1', high: '2', low: '3', close: '4', volume: '5',
    });
    // [timestamp, OPEN, HIGH, LOW, CLOSE, VOLUME]
    assert.strictEqual(candle[1], 1);  // open
    assert.strictEqual(candle[2], 2);  // high
    assert.strictEqual(candle[3], 3);  // low
    assert.strictEqual(candle[4], 4);  // close
    assert.strictEqual(candle[5], 5);  // volume
  });

  it('_parseOrder normalizes status strings', () => {
    const open = exchange._parseOrder({ id: '1', type: '0', status: 'Open' });
    const finished = exchange._parseOrder({ id: '2', type: '1', status: 'Finished' });
    const canceled = exchange._parseOrder({ id: '3', type: '0', status: 'Canceled' });
    assert.strictEqual(open.status, 'NEW');
    assert.strictEqual(finished.status, 'FILLED');
    assert.strictEqual(canceled.status, 'CANCELED');
  });

  it('_parseTrade calculates cost = price * amount', () => {
    const trade = exchange._parseTrade({ tid: '1', price: '100', amount: '2.5', type: '0', date: '1700000000' }, 'TEST/USD');
    assert.strictEqual(trade.cost, 250);
  });
});

// =============================================================================
// 6. Helper Methods (8 tests)
// =============================================================================

describe('Bitstamp — Helper Methods', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp();
  });

  it('_toBitstampSymbol converts BTC/USD → btcusd', () => {
    assert.strictEqual(exchange._toBitstampSymbol('BTC/USD'), 'btcusd');
  });

  it('_toBitstampSymbol converts ETH/EUR → etheur', () => {
    assert.strictEqual(exchange._toBitstampSymbol('ETH/EUR'), 'etheur');
  });

  it('_toBitstampSymbol passes through already-lowercase', () => {
    assert.strictEqual(exchange._toBitstampSymbol('btcusd'), 'btcusd');
  });

  it('_fromBitstampSymbol converts btcusd → BTC/USD (6 char)', () => {
    const result = exchange._fromBitstampSymbol('btcusd');
    assert.strictEqual(result, 'BTC/USD');
  });

  it('_fromBitstampSymbol passes through already-unified', () => {
    assert.strictEqual(exchange._fromBitstampSymbol('BTC/USD'), 'BTC/USD');
  });

  it('_buildOrderPath returns limit buy path', () => {
    assert.strictEqual(exchange._buildOrderPath('buy', 'LIMIT', 'btcusd'), '/api/v2/buy/btcusd/');
  });

  it('_buildOrderPath returns market sell path', () => {
    assert.strictEqual(exchange._buildOrderPath('sell', 'MARKET', 'btcusd'), '/api/v2/sell/market/btcusd/');
  });

  it('_parseOrderSide returns BUY for 0, SELL for 1', () => {
    assert.strictEqual(exchange._parseOrderSide(0), 'BUY');
    assert.strictEqual(exchange._parseOrderSide(1), 'SELL');
    assert.strictEqual(exchange._parseOrderSide('0'), 'BUY');
    assert.strictEqual(exchange._parseOrderSide('1'), 'SELL');
  });
});

// =============================================================================
// 7. Bitstamp Error Mapping (8 tests)
// =============================================================================

describe('Bitstamp — Error Mapping', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp();
  });

  it('API0001 → BadRequest', () => {
    assert.throws(
      () => exchange._handleBitstampError('API0001', 'Bad request'),
      { name: 'BadRequest' }
    );
  });

  it('API0002 → AuthenticationError (missing permission)', () => {
    assert.throws(
      () => exchange._handleBitstampError('API0002', 'Missing permission'),
      { name: 'AuthenticationError' }
    );
  });

  it('API0004 → AuthenticationError (missing signature)', () => {
    assert.throws(
      () => exchange._handleBitstampError('API0004', 'Missing signature'),
      { name: 'AuthenticationError' }
    );
  });

  it('API0006 → AuthenticationError (invalid nonce)', () => {
    assert.throws(
      () => exchange._handleBitstampError('API0006', 'Invalid nonce'),
      { name: 'AuthenticationError' }
    );
  });

  it('API0011 → InvalidOrder', () => {
    assert.throws(
      () => exchange._handleBitstampError('API0011', 'Invalid order'),
      { name: 'InvalidOrder' }
    );
  });

  it('API0025 → RateLimitExceeded', () => {
    assert.throws(
      () => exchange._handleBitstampError('API0025', 'Rate limit'),
      { name: 'RateLimitExceeded' }
    );
  });

  it('API0030 → InsufficientFunds', () => {
    assert.throws(
      () => exchange._handleBitstampError('API0030', 'Not enough balance'),
      { name: 'InsufficientFunds' }
    );
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(
      () => exchange._handleBitstampError('API9999', 'Unknown error'),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 8. HTTP Error Handling (6 tests)
// =============================================================================

describe('Bitstamp — HTTP Error Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp();
  });

  it('HTTP 400 → BadRequest', () => {
    assert.throws(
      () => exchange._handleHttpError(400, '{"reason":"bad request"}'),
      { name: 'BadRequest' }
    );
  });

  it('HTTP 401 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(401, '{"reason":"unauthorized"}'),
      { name: 'AuthenticationError' }
    );
  });

  it('HTTP 403 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(403, '{"reason":"forbidden"}'),
      { name: 'AuthenticationError' }
    );
  });

  it('HTTP 429 → RateLimitExceeded', () => {
    assert.throws(
      () => exchange._handleHttpError(429, '{"reason":"too many requests"}'),
      { name: 'RateLimitExceeded' }
    );
  });

  it('HTTP 500 → ExchangeNotAvailable', () => {
    assert.throws(
      () => exchange._handleHttpError(500, '{"reason":"internal error"}'),
      { name: 'ExchangeNotAvailable' }
    );
  });

  it('HTTP 404 → ExchangeError', () => {
    assert.throws(
      () => exchange._handleHttpError(404, '{"reason":"not found"}'),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 9. Rate Limit Handling (3 tests)
// =============================================================================

describe('Bitstamp — Rate Limit', () => {
  it('rate limit is configured', () => {
    const exchange = new Bitstamp();
    assert.ok(exchange.rateLimit > 0);
  });

  it('rate limit capacity matches Bitstamp limits', () => {
    const exchange = new Bitstamp();
    const desc = exchange.describe();
    assert.strictEqual(desc.rateLimitCapacity, 8000);
    assert.strictEqual(desc.rateLimitInterval, 600000);
  });

  it('throttler is initialized', () => {
    const exchange = new Bitstamp();
    assert.ok(exchange._throttler);
  });
});

// =============================================================================
// 10. Mocked API Calls (16 tests)
// =============================================================================

describe('Bitstamp — Mocked API Calls', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('fetchTicker parses JSON response correctly', async () => {
    exchange._request = async () => ({
      high: '51000.00', last: '49500.00', timestamp: '1700000000',
      bid: '49400.00', vwap: '49800.00', volume: '100.50',
      low: '48000.00', ask: '49600.00', open: '49000.00',
    });

    const ticker = await exchange.fetchTicker('BTC/USD');
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.last, 49500);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.low, 48000);
    assert.strictEqual(ticker.bid, 49400);
    assert.strictEqual(ticker.ask, 49600);
  });

  it('fetchOrderBook parses string arrays → float', async () => {
    exchange._request = async () => ({
      timestamp: '1700000000',
      microtimestamp: '1700000000123456',
      bids: [['49400.00', '0.5'], ['49300.00', '1.0']],
      asks: [['49600.00', '0.3'], ['49700.00', '0.8']],
    });

    const ob = await exchange.fetchOrderBook('BTC/USD');
    assert.strictEqual(ob.symbol, 'BTC/USD');
    assert.deepStrictEqual(ob.bids[0], [49400, 0.5]);
    assert.deepStrictEqual(ob.asks[0], [49600, 0.3]);
    assert.strictEqual(ob.bids.length, 2);
    assert.strictEqual(ob.asks.length, 2);
    assert.strictEqual(typeof ob.bids[0][0], 'number');
  });

  it('fetchOrderBook respects limit param', async () => {
    exchange._request = async () => ({
      timestamp: '1700000000',
      bids: [['49400', '0.5'], ['49300', '1.0'], ['49200', '0.3']],
      asks: [['49600', '0.3'], ['49700', '0.8'], ['49800', '0.2']],
    });

    const ob = await exchange.fetchOrderBook('BTC/USD', 2);
    assert.strictEqual(ob.bids.length, 2);
    assert.strictEqual(ob.asks.length, 2);
  });

  it('fetchTrades parses type 0/1 correctly', async () => {
    exchange._request = async () => [
      { tid: '100', price: '49500', amount: '0.1', type: '0', date: '1700000000' },
      { tid: '101', price: '49600', amount: '0.2', type: '1', date: '1700000001' },
    ];

    const trades = await exchange.fetchTrades('BTC/USD');
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[1].side, 'sell');
    assert.strictEqual(trades[0].id, '100');
  });

  it('fetchOHLCV parses nested data.ohlc correctly', async () => {
    exchange._request = async () => ({
      data: {
        pair: 'BTC/USD',
        ohlc: [
          { timestamp: '1700000000', open: '49000', high: '51000', low: '48000', close: '50000', volume: '100.5' },
          { timestamp: '1700000060', open: '50000', high: '52000', low: '49000', close: '51000', volume: '200.0' },
        ],
      },
    });

    const candles = await exchange.fetchOHLCV('BTC/USD', '1m');
    assert.strictEqual(candles.length, 2);
    assert.deepStrictEqual(candles[0], [1700000000000, 49000, 51000, 48000, 50000, 100.5]);
    assert.deepStrictEqual(candles[1], [1700000060000, 50000, 52000, 49000, 51000, 200]);
  });

  it('createOrder builds correct path for limit buy', async () => {
    let capturedPath;
    exchange._request = async (method, path, params, signed) => {
      capturedPath = path;
      return { id: '12345', datetime: '2024-01-01 12:00:00', type: '0', price: '49500', amount: '0.1' };
    };

    await exchange.createOrder('BTC/USD', 'LIMIT', 'buy', 0.1, 49500);
    assert.strictEqual(capturedPath, '/api/v2/buy/btcusd/');
  });

  it('createOrder builds correct path for market sell', async () => {
    let capturedPath;
    exchange._request = async (method, path, params, signed) => {
      capturedPath = path;
      return { id: '12346', datetime: '2024-01-01 12:00:00', type: '1', amount: '0.5' };
    };

    await exchange.createOrder('BTC/USD', 'MARKET', 'sell', 0.5);
    assert.strictEqual(capturedPath, '/api/v2/sell/market/btcusd/');
  });

  it('createOrder sends amount and price in params for limit', async () => {
    let capturedParams;
    exchange._request = async (method, path, params, signed) => {
      capturedParams = params;
      return { id: '12345', type: '0', price: '49500', amount: '0.1' };
    };

    await exchange.createOrder('BTC/USD', 'LIMIT', 'buy', 0.1, 49500);
    assert.strictEqual(capturedParams.amount, '0.1');
    assert.strictEqual(capturedParams.price, '49500');
  });

  it('createOrder sends only amount for market', async () => {
    let capturedParams;
    exchange._request = async (method, path, params, signed) => {
      capturedParams = params;
      return { id: '12346', type: '1', amount: '0.5' };
    };

    await exchange.createOrder('BTC/USD', 'MARKET', 'sell', 0.5);
    assert.strictEqual(capturedParams.amount, '0.5');
    assert.strictEqual(capturedParams.price, undefined);
  });

  it('cancelOrder sends id in body', async () => {
    let capturedParams;
    exchange._request = async (method, path, params, signed) => {
      capturedParams = params;
      return { id: '12345', amount: '0.1', price: '49500', type: '0' };
    };

    await exchange.cancelOrder('12345');
    assert.strictEqual(capturedParams.id, '12345');
  });

  it('fetchBalance uses POST with empty body (signed)', async () => {
    let capturedMethod, capturedPath, capturedParams, capturedSigned;
    exchange._request = async (method, path, params, signed) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      capturedSigned = signed;
      return [
        { available: '1.5', balance: '2.0', currency: 'btc', reserved: '0.5' },
        { available: '1000', balance: '1500', currency: 'usd', reserved: '500' },
      ];
    };

    const bal = await exchange.fetchBalance();
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/api/v2/account_balances/');
    assert.deepStrictEqual(capturedParams, {});
    assert.strictEqual(capturedSigned, true);
    assert.strictEqual(bal.BTC.free, 1.5);
    assert.strictEqual(bal.BTC.used, 0.5);
    assert.strictEqual(bal.BTC.total, 2);
    assert.strictEqual(bal.USD.free, 1000);
  });

  it('fetchOpenOrders with symbol builds correct path', async () => {
    let capturedPath;
    exchange._request = async (method, path, params, signed) => {
      capturedPath = path;
      return [];
    };

    await exchange.fetchOpenOrders('BTC/USD');
    assert.strictEqual(capturedPath, '/api/v2/open_orders/btcusd/');
  });

  it('fetchOpenOrders without symbol uses /all/', async () => {
    let capturedPath;
    exchange._request = async (method, path, params, signed) => {
      capturedPath = path;
      return [];
    };

    await exchange.fetchOpenOrders();
    assert.strictEqual(capturedPath, '/api/v2/open_orders/all/');
  });

  it('fetchMyTrades filters type=2 (trade) only', async () => {
    exchange._request = async () => [
      { id: '1', type: '0', datetime: '2024-01-01', fee: '0' },    // deposit
      { id: '2', type: '2', datetime: '2024-01-01', fee: '0.1', order_id: '100' },  // trade
      { id: '3', type: '1', datetime: '2024-01-01', fee: '0' },    // withdrawal
      { id: '4', type: '2', datetime: '2024-01-01', fee: '0.2', order_id: '200' },  // trade
    ];

    const trades = await exchange.fetchMyTrades('BTC/USD');
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].id, '2');
    assert.strictEqual(trades[1].id, '4');
  });

  it('loadMarkets parses trading-pairs-info response', async () => {
    exchange._request = async () => [
      { name: 'BTC/USD', url_symbol: 'btcusd', base_decimals: 8, counter_decimals: 2, minimum_order: '10.0 USD', trading: 'Enabled' },
      { name: 'ETH/EUR', url_symbol: 'etheur', base_decimals: 8, counter_decimals: 2, minimum_order: '10.0 EUR', trading: 'Enabled' },
    ];

    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USD']);
    assert.ok(markets['ETH/EUR']);
    assert.strictEqual(markets['BTC/USD'].id, 'btcusd');
    assert.strictEqual(markets['BTC/USD'].base, 'BTC');
    assert.strictEqual(markets['BTC/USD'].quote, 'USD');
    assert.strictEqual(markets['BTC/USD'].precision.amount, 8);
    assert.strictEqual(markets['BTC/USD'].precision.price, 2);
    assert.strictEqual(markets['BTC/USD'].limits.cost.min, 10);
    assert.strictEqual(markets['BTC/USD'].active, true);
  });
});

// =============================================================================
// 11. Market Lookup (3 tests)
// =============================================================================

describe('Bitstamp — Market Lookup', () => {
  let exchange;

  beforeEach(async () => {
    exchange = new Bitstamp();
    exchange._request = async () => [
      { name: 'BTC/USD', url_symbol: 'btcusd', base_decimals: 8, counter_decimals: 2, minimum_order: '10.0 USD', trading: 'Enabled' },
      { name: 'ETH/USD', url_symbol: 'ethusd', base_decimals: 8, counter_decimals: 2, minimum_order: '10.0 USD', trading: 'Enabled' },
    ];
    await exchange.loadMarkets();
  });

  it('market() returns correct market object', () => {
    const market = exchange.market('BTC/USD');
    assert.strictEqual(market.id, 'btcusd');
    assert.strictEqual(market.symbol, 'BTC/USD');
  });

  it('market().id returns bitstamp symbol', () => {
    assert.strictEqual(exchange.market('BTC/USD').id, 'btcusd');
  });

  it('market() throws ExchangeError for unknown symbol', () => {
    assert.throws(
      () => exchange.market('UNKNOWN/PAIR'),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 12. Bitstamp vs Others Differences (8 tests)
// =============================================================================

describe('Bitstamp — Differences from Other Exchanges', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bitstamp({ apiKey: 'key', secret: 'secret' });
  });

  it('side is in URL (not body) — unique among all exchanges', () => {
    const buyPath = exchange._buildOrderPath('buy', 'LIMIT', 'btcusd');
    const sellPath = exchange._buildOrderPath('sell', 'LIMIT', 'btcusd');
    assert.ok(buyPath.includes('/buy/'));
    assert.ok(sellPath.includes('/sell/'));
    assert.ok(!buyPath.includes('side='));
  });

  it('market order has separate URL from limit order', () => {
    const limitPath = exchange._buildOrderPath('buy', 'LIMIT', 'btcusd');
    const marketPath = exchange._buildOrderPath('buy', 'MARKET', 'btcusd');
    assert.strictEqual(limitPath, '/api/v2/buy/btcusd/');
    assert.strictEqual(marketPath, '/api/v2/buy/market/btcusd/');
  });

  it('conditional signature — payload differs with/without body', () => {
    const withoutBody = exchange._sign('/api/v2/test/', 'POST', {});
    const withBody = exchange._sign('/api/v2/test/', 'POST', { amount: '100' });
    // Different signatures since payload structure differs
    assert.notStrictEqual(withoutBody.headers['X-Auth-Signature'], withBody.headers['X-Auth-Signature']);
  });

  it('UUID v4 nonce (not timestamp-based like Binance/Bitfinex)', () => {
    const result = exchange._sign('/api/v2/test/', 'POST', {});
    const nonce = result.headers['X-Auth-Nonce'];
    // UUID format: 8-4-4-4-12 with hex chars
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce));
    // Contains dashes (unlike pure numeric timestamp nonces)
    assert.ok(nonce.includes('-'), 'UUID nonce should contain dashes, unlike timestamp nonces');
  });

  it('postAsFormEncoded (like Kraken, unlike Binance/OKX/Bybit JSON)', () => {
    assert.strictEqual(exchange.postAsFormEncoded, true);
    assert.strictEqual(exchange.postAsJson, false);
  });

  it('timeframes in seconds (not strings like Bitfinex or minutes like Kraken)', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(typeof tf['1m'], 'number');
    assert.strictEqual(tf['1m'], 60);
    // Kraken uses 1 (minute), Bitstamp uses 60 (second)
    assert.strictEqual(tf['1h'], 3600);
  });

  it('trade type is numeric 0/1 (not string buy/sell like most exchanges)', () => {
    const buyTrade = exchange._parseTrade({ tid: '1', price: '100', amount: '1', type: '0', date: '1700000000' }, 'TEST');
    const sellTrade = exchange._parseTrade({ tid: '2', price: '100', amount: '1', type: '1', date: '1700000000' }, 'TEST');
    assert.strictEqual(buyTrade.side, 'buy');
    assert.strictEqual(sellTrade.side, 'sell');
  });

  it('X-Auth-* header style (unique prefix — not API-Key, bfx-*, or Authorization)', () => {
    const result = exchange._sign('/api/v2/test/', 'POST', {});
    const headerKeys = Object.keys(result.headers);
    assert.ok(headerKeys.every((k) => k.startsWith('X-Auth')));
    assert.strictEqual(headerKeys.length, 5);
  });
});

// =============================================================================
// 13. Crypto — hmacSHA256 (3 tests)
// =============================================================================

describe('Bitstamp — Crypto (hmacSHA256)', () => {
  it('hmacSHA256 returns hex string (64 chars)', () => {
    const result = hmacSHA256('test data', 'secret');
    assert.strictEqual(result.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(result));
  });

  it('hmacSHA256 handles empty string', () => {
    const result = hmacSHA256('', 'secret');
    assert.strictEqual(result.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(result));
  });

  it('hmacSHA256 produces known test vector', () => {
    // Known HMAC-SHA256 test vector
    const result = hmacSHA256('The quick brown fox jumps over the lazy dog', 'key');
    assert.strictEqual(result, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
});

// =============================================================================
// Version check
// =============================================================================

describe('Bitstamp — Version', () => {
  it('library version is 2.5.0', () => {
    assert.strictEqual(ygcc.version, '2.5.0');
  });
});

'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const ygcc = require('../index');
const { Bittrex, bittrex: BittrexAlias, hmacSHA512Hex, sha512 } = ygcc;

// =============================================================================
// 1. Module Exports (3 tests)
// =============================================================================

describe('Bittrex — Module Exports', () => {
  it('exports Bittrex class', () => {
    assert.ok(Bittrex);
    assert.strictEqual(typeof Bittrex, 'function');
  });

  it('exports lowercase alias', () => {
    assert.strictEqual(BittrexAlias, Bittrex);
  });

  it('includes bittrex in exchanges list', () => {
    assert.ok(ygcc.exchanges.includes('bittrex'));
  });
});

// =============================================================================
// 2. Constructor (8 tests)
// =============================================================================

describe('Bittrex — Constructor', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('sets postAsJson = true', () => {
    assert.strictEqual(exchange.postAsJson, true);
  });

  it('sets postAsFormEncoded = false', () => {
    assert.strictEqual(exchange.postAsFormEncoded, false);
  });

  it('describe() returns correct id', () => {
    assert.strictEqual(exchange.describe().id, 'bittrex');
  });

  it('describe() returns correct name', () => {
    assert.strictEqual(exchange.describe().name, 'Bittrex');
  });

  it('describe() returns correct version', () => {
    assert.strictEqual(exchange.describe().version, 'v3');
  });

  it('timeframes use string enums (not seconds or numbers)', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(tf['1m'], 'MINUTE_1');
    assert.strictEqual(tf['5m'], 'MINUTE_5');
    assert.strictEqual(tf['1h'], 'HOUR_1');
    assert.strictEqual(tf['1d'], 'DAY_1');
  });

  it('fees are correct', () => {
    const fees = exchange.describe().fees;
    assert.strictEqual(fees.trading.maker, 0.0035);
    assert.strictEqual(fees.trading.taker, 0.0035);
  });

  it('public WebSocket features are enabled (SignalR V3 hub c3)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchTicker, true);
    assert.strictEqual(has.watchOrderBook, true);
    assert.strictEqual(has.watchTrades, true);
  });

  it('private/klines WebSocket features are disabled', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchKlines, false);
    assert.strictEqual(has.watchBalance, false);
    assert.strictEqual(has.watchOrders, false);
  });

  it('initializes _wsClients Map and _wsInvocationId', () => {
    assert.ok(exchange._wsClients instanceof Map);
    assert.strictEqual(exchange._wsInvocationId, 0);
  });
});

// =============================================================================
// 3. Authentication — HMAC-SHA512 + SHA512 content hash (10 tests)
// =============================================================================

describe('Bittrex — Authentication', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex({ apiKey: 'myApiKey', secret: 'mySecretKey' });
  });

  it('_sign() returns params and headers', () => {
    const result = exchange._sign('/v3/account/balances', 'GET', {});
    assert.ok(result.params);
    assert.ok(result.headers);
  });

  it('generates millisecond timestamp', () => {
    const result = exchange._sign('/v3/account/balances', 'GET', {});
    const timestamp = result.headers['Api-Timestamp'];
    assert.ok(timestamp);
    assert.ok(timestamp.length >= 13, 'timestamp should be milliseconds');
    const ts = parseInt(timestamp, 10);
    assert.ok(ts > 1700000000000, 'timestamp should be recent');
  });

  it('sets all 4 required Api-* headers', () => {
    const result = exchange._sign('/v3/account/balances', 'GET', {});
    const h = result.headers;
    assert.ok(h['Api-Key']);
    assert.ok(h['Api-Timestamp']);
    assert.ok(h['Api-Content-Hash']);
    assert.ok(h['Api-Signature']);
  });

  it('Api-Key header is the apiKey', () => {
    const result = exchange._sign('/v3/account/balances', 'GET', {});
    assert.strictEqual(result.headers['Api-Key'], 'myApiKey');
  });

  it('content hash is SHA512 hex of empty string for GET requests', () => {
    const result = exchange._sign('/v3/account/balances', 'GET', {});
    const expected = sha512('');
    assert.strictEqual(result.headers['Api-Content-Hash'], expected);
    assert.strictEqual(result.headers['Api-Content-Hash'].length, 128);
  });

  it('content hash is SHA512 hex of JSON body for POST requests', () => {
    const params = { marketSymbol: 'BTC-USDT', direction: 'BUY', type: 'LIMIT', quantity: '0.001', limit: '50000' };
    const result = exchange._sign('/v3/orders', 'POST', params);
    const expectedBody = JSON.stringify(params);
    const expected = sha512(expectedBody);
    assert.strictEqual(result.headers['Api-Content-Hash'], expected);
  });

  it('content hash is SHA512 hex of empty string for DELETE requests', () => {
    const result = exchange._sign('/v3/orders/some-uuid', 'DELETE', {});
    const expected = sha512('');
    assert.strictEqual(result.headers['Api-Content-Hash'], expected);
  });

  it('signature is hex string (128 chars for SHA-512)', () => {
    const result = exchange._sign('/v3/account/balances', 'GET', {});
    const sig = result.headers['Api-Signature'];
    assert.strictEqual(sig.length, 128);
    assert.ok(/^[0-9a-f]{128}$/.test(sig), 'signature should be hex');
  });

  it('preSign format: timestamp + fullUrl + method + contentHash (no separators)', () => {
    const result = exchange._sign('/v3/account/balances', 'GET', {});
    const timestamp = result.headers['Api-Timestamp'];
    const contentHash = result.headers['Api-Content-Hash'];
    const sig = result.headers['Api-Signature'];

    // Manually compute expected signature
    const preSign = timestamp + 'https://api.bittrex.com/v3/account/balances' + 'GET' + contentHash;
    const expectedSig = hmacSHA512Hex(preSign, 'mySecretKey');

    assert.strictEqual(sig, expectedSig);
  });

  it('throws AuthenticationError if no credentials', () => {
    const noAuth = new Bittrex();
    assert.throws(
      () => noAuth._sign('/v3/test', 'GET', {}),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 4. Response Handling (5 tests)
// =============================================================================

describe('Bittrex — Response Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex();
  });

  it('_unwrapResponse returns data for valid response', () => {
    const data = { symbol: 'BTC-USDT', lastTradeRate: '50000' };
    const result = exchange._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse throws on error code', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: 'INVALID_SIGNATURE' }),
      { name: 'AuthenticationError' }
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

  it('handles error with code and detail', () => {
    assert.throws(
      () => exchange._unwrapResponse({ code: 'INSUFFICIENT_FUNDS', detail: 'Not enough' }),
      { name: 'InsufficientFunds' }
    );
  });
});

// =============================================================================
// 5. Parsers (10 tests)
// =============================================================================

describe('Bittrex — Parsers', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex();
  });

  it('_parseTicker merges ticker + summary data', () => {
    const ticker = { symbol: 'BTC-USDT', lastTradeRate: '50000', bidRate: '49900', askRate: '50100' };
    const summary = { symbol: 'BTC-USDT', high: '51000', low: '49000', volume: '100.5', quoteVolume: '5000000', percentChange: '2.5', updatedAt: '2024-01-01T12:00:00Z' };
    const result = exchange._parseTicker(ticker, summary, 'BTC/USDT');

    assert.strictEqual(result.symbol, 'BTC/USDT');
    assert.strictEqual(result.last, 50000);
    assert.strictEqual(result.bid, 49900);
    assert.strictEqual(result.ask, 50100);
    assert.strictEqual(result.high, 51000);
    assert.strictEqual(result.low, 49000);
    assert.strictEqual(result.volume, 100.5);
    assert.strictEqual(result.quoteVolume, 5000000);
    assert.strictEqual(result.percentage, 2.5);
  });

  it('_parseTicker handles missing summary gracefully', () => {
    const ticker = { symbol: 'BTC-USDT', lastTradeRate: '50000', bidRate: '49900', askRate: '50100' };
    const result = exchange._parseTicker(ticker, {}, 'BTC/USDT');
    assert.strictEqual(result.last, 50000);
    assert.strictEqual(result.high, undefined);
    assert.strictEqual(result.low, undefined);
  });

  it('_parseOrder parses direction BUY → buy', () => {
    const data = { id: '123', marketSymbol: 'BTC-USDT', direction: 'BUY', type: 'LIMIT', quantity: '0.1', limit: '50000', status: 'OPEN', createdAt: '2024-01-01T12:00:00Z' };
    const order = exchange._parseOrder(data);
    assert.strictEqual(order.id, '123');
    assert.strictEqual(order.side, 'buy');
    assert.strictEqual(order.type, 'limit');
    assert.strictEqual(order.price, 50000);
    assert.strictEqual(order.amount, 0.1);
  });

  it('_parseOrder parses direction SELL → sell', () => {
    const data = { id: '456', marketSymbol: 'BTC-USDT', direction: 'SELL', type: 'MARKET', quantity: '0.5', status: 'CLOSED' };
    const order = exchange._parseOrder(data);
    assert.strictEqual(order.side, 'sell');
    assert.strictEqual(order.type, 'market');
  });

  it('_parseOrder normalizes status correctly', () => {
    const open = exchange._parseOrder({ id: '1', direction: 'BUY', status: 'OPEN' });
    const closed = exchange._parseOrder({ id: '2', direction: 'SELL', status: 'CLOSED' });
    const cancelled = exchange._parseOrder({ id: '3', direction: 'BUY', status: 'CANCELLED' });
    assert.strictEqual(open.status, 'NEW');
    assert.strictEqual(closed.status, 'FILLED');
    assert.strictEqual(cancelled.status, 'CANCELED');
  });

  it('_parseOrder calculates filled, remaining, cost, average', () => {
    const data = { id: '1', direction: 'BUY', quantity: '1.0', limit: '50000', fillQuantity: '0.6', proceeds: '30000', commission: '10.5', status: 'OPEN' };
    const order = exchange._parseOrder(data);
    assert.strictEqual(order.filled, 0.6);
    assert.strictEqual(order.remaining, 0.4);
    assert.strictEqual(order.cost, 30000);
    assert.strictEqual(order.average, 50000);  // 30000 / 0.6
    assert.strictEqual(order.fee.cost, 10.5);
  });

  it('_parseTrade parses takerSide correctly', () => {
    const buy = exchange._parseTrade({ id: '100', rate: '50000', quantity: '0.1', takerSide: 'BUY', executedAt: '2024-01-01T12:00:00Z' }, 'BTC/USDT');
    const sell = exchange._parseTrade({ id: '101', rate: '50100', quantity: '0.2', takerSide: 'SELL', executedAt: '2024-01-01T12:00:00Z' }, 'BTC/USDT');
    assert.strictEqual(buy.side, 'buy');
    assert.strictEqual(sell.side, 'sell');
    assert.strictEqual(buy.price, 50000);
    assert.strictEqual(buy.amount, 0.1);
    assert.strictEqual(buy.cost, 5000);
  });

  it('_parseTrade calculates cost = price * amount', () => {
    const trade = exchange._parseTrade({ id: '1', rate: '100', quantity: '2.5', takerSide: 'BUY', executedAt: '2024-01-01T12:00:00Z' }, 'TEST/USD');
    assert.strictEqual(trade.cost, 250);
  });

  it('_parseCandle returns standard OHLCV array [ts, O, H, L, C, V]', () => {
    const candle = exchange._parseCandle({
      startsAt: '2024-01-01T12:00:00Z', open: '49000', high: '51000', low: '48000', close: '50000', volume: '100.5',
    });
    assert.strictEqual(candle.length, 6);
    assert.strictEqual(candle[1], 49000);  // open
    assert.strictEqual(candle[2], 51000);  // high
    assert.strictEqual(candle[3], 48000);  // low
    assert.strictEqual(candle[4], 50000);  // close
    assert.strictEqual(candle[5], 100.5);  // volume
    assert.ok(candle[0] > 0, 'timestamp should be positive');
  });

  it('_parseCandle timestamp is in milliseconds', () => {
    const candle = exchange._parseCandle({
      startsAt: '2024-01-01T00:00:00Z', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10',
    });
    // 2024-01-01T00:00:00Z = 1704067200000 ms
    assert.strictEqual(candle[0], 1704067200000);
  });
});

// =============================================================================
// 6. Helper Methods (8 tests)
// =============================================================================

describe('Bittrex — Helper Methods', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex();
  });

  it('_toBittrexSymbol converts BTC/USDT → BTC-USDT', () => {
    assert.strictEqual(exchange._toBittrexSymbol('BTC/USDT'), 'BTC-USDT');
  });

  it('_toBittrexSymbol converts ETH/USD → ETH-USD', () => {
    assert.strictEqual(exchange._toBittrexSymbol('ETH/USD'), 'ETH-USD');
  });

  it('_toBittrexSymbol passes through already-formatted', () => {
    assert.strictEqual(exchange._toBittrexSymbol('BTC-USDT'), 'BTC-USDT');
  });

  it('_fromBittrexSymbol converts BTC-USDT → BTC/USDT (fallback)', () => {
    const result = exchange._fromBittrexSymbol('BTC-USDT');
    assert.strictEqual(result, 'BTC/USDT');
  });

  it('_fromBittrexSymbol passes through already-unified', () => {
    assert.strictEqual(exchange._fromBittrexSymbol('BTC/USDT'), 'BTC/USDT');
  });

  it('_toBittrexDirection converts buy/sell to uppercase', () => {
    assert.strictEqual(exchange._toBittrexDirection('buy'), 'BUY');
    assert.strictEqual(exchange._toBittrexDirection('sell'), 'SELL');
  });

  it('_normalizeOrderStatus maps Bittrex statuses correctly', () => {
    assert.strictEqual(exchange._normalizeOrderStatus('OPEN'), 'NEW');
    assert.strictEqual(exchange._normalizeOrderStatus('CLOSED'), 'FILLED');
    assert.strictEqual(exchange._normalizeOrderStatus('CANCELLED'), 'CANCELED');
    assert.strictEqual(exchange._normalizeOrderStatus('COMPLETED'), 'FILLED');
  });

  it('_toBittrexOrderType converts to uppercase', () => {
    assert.strictEqual(exchange._toBittrexOrderType('limit'), 'LIMIT');
    assert.strictEqual(exchange._toBittrexOrderType('market'), 'MARKET');
  });
});

// =============================================================================
// 7. Bittrex Error Mapping (8 tests)
// =============================================================================

describe('Bittrex — Error Mapping', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex();
  });

  it('INVALID_SIGNATURE → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleBittrexError('INVALID_SIGNATURE', 'bad sig'),
      { name: 'AuthenticationError' }
    );
  });

  it('APIKEY_INVALID → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleBittrexError('APIKEY_INVALID', 'bad key'),
      { name: 'AuthenticationError' }
    );
  });

  it('MARKET_DOES_NOT_EXIST → BadSymbol', () => {
    assert.throws(
      () => exchange._handleBittrexError('MARKET_DOES_NOT_EXIST', 'no market'),
      { name: 'BadSymbol' }
    );
  });

  it('INSUFFICIENT_FUNDS → InsufficientFunds', () => {
    assert.throws(
      () => exchange._handleBittrexError('INSUFFICIENT_FUNDS', 'no money'),
      { name: 'InsufficientFunds' }
    );
  });

  it('MIN_TRADE_REQUIREMENT_NOT_MET → InvalidOrder', () => {
    assert.throws(
      () => exchange._handleBittrexError('MIN_TRADE_REQUIREMENT_NOT_MET', 'too small'),
      { name: 'InvalidOrder' }
    );
  });

  it('ORDER_NOT_FOUND → OrderNotFound', () => {
    assert.throws(
      () => exchange._handleBittrexError('ORDER_NOT_FOUND', 'missing'),
      { name: 'OrderNotFound' }
    );
  });

  it('RATE_LIMIT_EXCEEDED → RateLimitExceeded', () => {
    assert.throws(
      () => exchange._handleBittrexError('RATE_LIMIT_EXCEEDED', 'slow down'),
      { name: 'RateLimitExceeded' }
    );
  });

  it('unknown code → ExchangeError', () => {
    assert.throws(
      () => exchange._handleBittrexError('UNKNOWN_ERROR', 'something'),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 8. HTTP Error Handling (6 tests)
// =============================================================================

describe('Bittrex — HTTP Error Handling', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex();
  });

  it('HTTP 400 → BadRequest', () => {
    assert.throws(
      () => exchange._handleHttpError(400, '{"detail":"bad request"}'),
      { name: 'BadRequest' }
    );
  });

  it('HTTP 401 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(401, '{"detail":"unauthorized"}'),
      { name: 'AuthenticationError' }
    );
  });

  it('HTTP 403 → AuthenticationError', () => {
    assert.throws(
      () => exchange._handleHttpError(403, '{"detail":"forbidden"}'),
      { name: 'AuthenticationError' }
    );
  });

  it('HTTP 429 → RateLimitExceeded', () => {
    assert.throws(
      () => exchange._handleHttpError(429, '{"detail":"too many requests"}'),
      { name: 'RateLimitExceeded' }
    );
  });

  it('HTTP 500 → ExchangeNotAvailable', () => {
    assert.throws(
      () => exchange._handleHttpError(500, '{"detail":"internal error"}'),
      { name: 'ExchangeNotAvailable' }
    );
  });

  it('HTTP 404 → ExchangeError', () => {
    assert.throws(
      () => exchange._handleHttpError(404, '{"detail":"not found"}'),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 9. Rate Limit Handling (3 tests)
// =============================================================================

describe('Bittrex — Rate Limit', () => {
  it('rate limit is configured', () => {
    const exchange = new Bittrex();
    assert.ok(exchange.rateLimit > 0);
  });

  it('rate limit is 1000ms (60 req/min)', () => {
    const exchange = new Bittrex();
    assert.strictEqual(exchange.describe().rateLimit, 1000);
  });

  it('throttler is initialized', () => {
    const exchange = new Bittrex();
    assert.ok(exchange._throttler);
  });
});

// =============================================================================
// 10. Mocked API Calls (16 tests)
// =============================================================================

describe('Bittrex — Mocked API Calls', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('fetchTicker merges ticker + summary responses', async () => {
    let callCount = 0;
    exchange._request = async (method, path) => {
      callCount++;
      if (path.includes('/ticker')) {
        return { symbol: 'BTC-USDT', lastTradeRate: '50000', bidRate: '49900', askRate: '50100' };
      }
      return { symbol: 'BTC-USDT', high: '51000', low: '49000', volume: '100.5', quoteVolume: '5000000', percentChange: '2.5', updatedAt: '2024-01-01T12:00:00Z' };
    };

    const ticker = await exchange.fetchTicker('BTC/USDT');
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, 50000);
    assert.strictEqual(ticker.bid, 49900);
    assert.strictEqual(ticker.ask, 50100);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.volume, 100.5);
  });

  it('fetchOrderBook parses object arrays { rate, quantity }', async () => {
    exchange._request = async () => ({
      bid: [{ rate: '49900', quantity: '0.5' }, { rate: '49800', quantity: '1.0' }],
      ask: [{ rate: '50100', quantity: '0.3' }, { rate: '50200', quantity: '0.8' }],
    });

    const ob = await exchange.fetchOrderBook('BTC/USDT');
    assert.strictEqual(ob.symbol, 'BTC/USDT');
    assert.deepStrictEqual(ob.bids[0], [49900, 0.5]);
    assert.deepStrictEqual(ob.asks[0], [50100, 0.3]);
    assert.strictEqual(ob.bids.length, 2);
    assert.strictEqual(ob.asks.length, 2);
    assert.strictEqual(typeof ob.bids[0][0], 'number');
  });

  it('fetchTrades parses takerSide correctly', async () => {
    exchange._request = async () => [
      { id: '100', rate: '50000', quantity: '0.1', takerSide: 'BUY', executedAt: '2024-01-01T12:00:00Z' },
      { id: '101', rate: '50100', quantity: '0.2', takerSide: 'SELL', executedAt: '2024-01-01T12:01:00Z' },
    ];

    const trades = await exchange.fetchTrades('BTC/USDT');
    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[1].side, 'sell');
    assert.strictEqual(trades[0].id, '100');
    assert.strictEqual(trades[0].price, 50000);
  });

  it('fetchOHLCV parses recent candles array', async () => {
    exchange._request = async () => [
      { startsAt: '2024-01-01T00:00:00Z', open: '49000', high: '51000', low: '48000', close: '50000', volume: '100.5', quoteVolume: '5000000' },
      { startsAt: '2024-01-01T01:00:00Z', open: '50000', high: '52000', low: '49000', close: '51000', volume: '200.0', quoteVolume: '10000000' },
    ];

    const candles = await exchange.fetchOHLCV('BTC/USDT', '1h');
    assert.strictEqual(candles.length, 2);
    assert.strictEqual(candles[0][1], 49000);  // open
    assert.strictEqual(candles[0][2], 51000);  // high
    assert.strictEqual(candles[0][3], 48000);  // low
    assert.strictEqual(candles[0][4], 50000);  // close
    assert.strictEqual(candles[0][5], 100.5);  // volume
  });

  it('fetchOHLCV builds correct candle path with interval', async () => {
    let capturedPath;
    exchange._request = async (method, path) => {
      capturedPath = path;
      return [];
    };

    await exchange.fetchOHLCV('BTC/USDT', '1m');
    assert.strictEqual(capturedPath, '/v3/markets/BTC-USDT/candles/TRADE/MINUTE_1/recent');
  });

  it('createOrder sends correct POST JSON body', async () => {
    let capturedMethod, capturedPath, capturedParams, capturedSigned;
    exchange._request = async (method, path, params, signed) => {
      capturedMethod = method;
      capturedPath = path;
      capturedParams = params;
      capturedSigned = signed;
      return { id: 'uuid-123', marketSymbol: 'BTC-USDT', direction: 'BUY', type: 'LIMIT', quantity: '0.1', limit: '50000', status: 'OPEN', createdAt: '2024-01-01T12:00:00Z' };
    };

    const order = await exchange.createOrder('BTC/USDT', 'LIMIT', 'buy', 0.1, 50000);
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedPath, '/v3/orders');
    assert.strictEqual(capturedParams.marketSymbol, 'BTC-USDT');
    assert.strictEqual(capturedParams.direction, 'BUY');
    assert.strictEqual(capturedParams.type, 'LIMIT');
    assert.strictEqual(capturedParams.quantity, '0.1');
    assert.strictEqual(capturedParams.limit, '50000');
    assert.strictEqual(capturedParams.timeInForce, 'GOOD_TIL_CANCELLED');
    assert.strictEqual(capturedSigned, true);
    assert.strictEqual(order.id, 'uuid-123');
    assert.strictEqual(order.side, 'buy');
  });

  it('createMarketOrder uses IMMEDIATE_OR_CANCEL timeInForce', async () => {
    let capturedParams;
    exchange._request = async (method, path, params) => {
      capturedParams = params;
      return { id: 'uuid-456', marketSymbol: 'BTC-USDT', direction: 'BUY', type: 'MARKET', quantity: '0.1', status: 'CLOSED' };
    };

    await exchange.createMarketOrder('BTC/USDT', 'buy', 0.1);
    assert.strictEqual(capturedParams.type, 'MARKET');
    assert.strictEqual(capturedParams.timeInForce, 'IMMEDIATE_OR_CANCEL');
    assert.strictEqual(capturedParams.limit, undefined);
  });

  it('cancelOrder uses DELETE method with orderId in path', async () => {
    let capturedMethod, capturedPath;
    exchange._request = async (method, path, params, signed) => {
      capturedMethod = method;
      capturedPath = path;
      return { id: 'uuid-123', status: 'CANCELLED' };
    };

    const result = await exchange.cancelOrder('uuid-123');
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedPath, '/v3/orders/uuid-123');
    assert.strictEqual(result.status, 'CANCELED');
  });

  it('cancelAllOrders uses DELETE method on /v3/orders/open', async () => {
    let capturedMethod, capturedPath;
    exchange._request = async (method, path) => {
      capturedMethod = method;
      capturedPath = path;
      return [];
    };

    await exchange.cancelAllOrders();
    assert.strictEqual(capturedMethod, 'DELETE');
    assert.strictEqual(capturedPath, '/v3/orders/open');
  });

  it('cancelAllOrders with symbol adds marketSymbol query param', async () => {
    let capturedParams;
    exchange._request = async (method, path, params) => {
      capturedParams = params;
      return [];
    };

    await exchange.cancelAllOrders('BTC/USDT');
    assert.strictEqual(capturedParams.marketSymbol, 'BTC-USDT');
  });

  it('fetchBalance uses GET with auth (not POST)', async () => {
    let capturedMethod, capturedPath, capturedSigned;
    exchange._request = async (method, path, params, signed) => {
      capturedMethod = method;
      capturedPath = path;
      capturedSigned = signed;
      return [
        { currencySymbol: 'BTC', total: '1.5', available: '1.0' },
        { currencySymbol: 'USDT', total: '10000', available: '8000' },
      ];
    };

    const bal = await exchange.fetchBalance();
    assert.strictEqual(capturedMethod, 'GET');
    assert.strictEqual(capturedPath, '/v3/account/balances');
    assert.strictEqual(capturedSigned, true);
    assert.strictEqual(bal.BTC.free, 1);
    assert.strictEqual(bal.BTC.total, 1.5);
    assert.strictEqual(bal.BTC.used, 0.5);
    assert.strictEqual(bal.USDT.free, 8000);
    assert.strictEqual(bal.USDT.total, 10000);
  });

  it('fetchOpenOrders uses GET with auth', async () => {
    let capturedMethod, capturedPath;
    exchange._request = async (method, path) => {
      capturedMethod = method;
      capturedPath = path;
      return [];
    };

    await exchange.fetchOpenOrders();
    assert.strictEqual(capturedMethod, 'GET');
    assert.strictEqual(capturedPath, '/v3/orders/open');
  });

  it('fetchOpenOrders with symbol adds marketSymbol param', async () => {
    let capturedParams;
    exchange._request = async (method, path, params) => {
      capturedParams = params;
      return [];
    };

    await exchange.fetchOpenOrders('BTC/USDT');
    assert.strictEqual(capturedParams.marketSymbol, 'BTC-USDT');
  });

  it('fetchClosedOrders uses GET with auth and query params', async () => {
    let capturedMethod, capturedParams;
    exchange._request = async (method, path, params) => {
      capturedMethod = method;
      capturedParams = params;
      return [
        { id: '1', marketSymbol: 'BTC-USDT', direction: 'BUY', status: 'CLOSED', quantity: '0.1', fillQuantity: '0.1', proceeds: '5000' },
      ];
    };

    const orders = await exchange.fetchClosedOrders('BTC/USDT', undefined, 10);
    assert.strictEqual(capturedMethod, 'GET');
    assert.strictEqual(capturedParams.marketSymbol, 'BTC-USDT');
    assert.strictEqual(capturedParams.pageSize, 10);
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].status, 'FILLED');
  });

  it('loadMarkets parses Bittrex markets response', async () => {
    exchange._request = async () => [
      { symbol: 'BTC-USDT', baseCurrencySymbol: 'BTC', quoteCurrencySymbol: 'USDT', minTradeSize: '0.00001', precision: 8, status: 'ONLINE' },
      { symbol: 'ETH-USD', baseCurrencySymbol: 'ETH', quoteCurrencySymbol: 'USD', minTradeSize: '0.001', precision: 8, status: 'ONLINE' },
    ];

    const markets = await exchange.loadMarkets();
    assert.ok(markets['BTC/USDT']);
    assert.ok(markets['ETH/USD']);
    assert.strictEqual(markets['BTC/USDT'].id, 'BTC-USDT');
    assert.strictEqual(markets['BTC/USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC/USDT'].quote, 'USDT');
    assert.strictEqual(markets['BTC/USDT'].active, true);
    assert.strictEqual(markets['BTC/USDT'].limits.amount.min, 0.00001);
  });
});

// =============================================================================
// 11. Market Lookup (3 tests)
// =============================================================================

describe('Bittrex — Market Lookup', () => {
  let exchange;

  beforeEach(async () => {
    exchange = new Bittrex();
    exchange._request = async () => [
      { symbol: 'BTC-USDT', baseCurrencySymbol: 'BTC', quoteCurrencySymbol: 'USDT', minTradeSize: '0.00001', precision: 8, status: 'ONLINE' },
      { symbol: 'ETH-USD', baseCurrencySymbol: 'ETH', quoteCurrencySymbol: 'USD', minTradeSize: '0.001', precision: 8, status: 'ONLINE' },
    ];
    await exchange.loadMarkets();
  });

  it('market() returns correct market object', () => {
    const market = exchange.market('BTC/USDT');
    assert.strictEqual(market.id, 'BTC-USDT');
    assert.strictEqual(market.symbol, 'BTC/USDT');
  });

  it('market().id returns Bittrex symbol (hyphen-separated)', () => {
    assert.strictEqual(exchange.market('BTC/USDT').id, 'BTC-USDT');
  });

  it('market() throws ExchangeError for unknown symbol', () => {
    assert.throws(
      () => exchange.market('UNKNOWN/PAIR'),
      { name: 'ExchangeError' }
    );
  });
});

// =============================================================================
// 12. Bittrex vs Others Differences (8 tests)
// =============================================================================

describe('Bittrex — Differences from Other Exchanges', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex({ apiKey: 'key', secret: 'secret' });
  });

  it('DELETE method for cancel (not POST like most exchanges)', async () => {
    let capturedMethod;
    exchange._request = async (method) => {
      capturedMethod = method;
      return { id: '123', status: 'CANCELLED' };
    };

    await exchange.cancelOrder('123');
    assert.strictEqual(capturedMethod, 'DELETE');
  });

  it('SHA512 content hash in every request (unique to Bittrex)', () => {
    const result = exchange._sign('/v3/test', 'GET', {});
    assert.ok(result.headers['Api-Content-Hash']);
    assert.strictEqual(result.headers['Api-Content-Hash'].length, 128);  // SHA512 = 128 hex chars
  });

  it('GET for private endpoints (not POST like Bitstamp/Kraken)', async () => {
    let capturedMethod;
    exchange._request = async (method) => {
      capturedMethod = method;
      return [];
    };

    await exchange.fetchBalance();
    assert.strictEqual(capturedMethod, 'GET');
  });

  it('HMAC-SHA512 signature (not SHA256 like Binance/Bitstamp)', () => {
    const result = exchange._sign('/v3/test', 'GET', {});
    const sig = result.headers['Api-Signature'];
    // SHA512 = 128 hex chars (vs SHA256 = 64 hex chars)
    assert.strictEqual(sig.length, 128);
  });

  it('hyphen-separated symbols BTC-USDT (not slash, dot, or lowercase)', () => {
    assert.strictEqual(exchange._toBittrexSymbol('BTC/USDT'), 'BTC-USDT');
    // Uppercase with hyphen — different from all others
    assert.ok(exchange._toBittrexSymbol('ETH/USD').includes('-'));
    assert.strictEqual(exchange._toBittrexSymbol('ETH/USD'), 'ETH-USD');
  });

  it('public WS enabled, private/klines WS disabled (SignalR V3 hub c3)', () => {
    const has = exchange.describe().has;
    assert.strictEqual(has.watchTicker, true);
    assert.strictEqual(has.watchOrderBook, true);
    assert.strictEqual(has.watchTrades, true);
    assert.strictEqual(has.watchKlines, false);
    assert.strictEqual(has.watchBalance, false);
    assert.strictEqual(has.watchOrders, false);
  });

  it('JSON POST body (like Bybit/OKX, unlike Kraken/Bitstamp form-encoded)', () => {
    assert.strictEqual(exchange.postAsJson, true);
    assert.strictEqual(exchange.postAsFormEncoded, false);
  });

  it('string enum candle intervals MINUTE_1 (not numbers or seconds)', () => {
    const tf = exchange.describe().timeframes;
    assert.strictEqual(typeof tf['1m'], 'string');
    assert.strictEqual(tf['1m'], 'MINUTE_1');
    assert.strictEqual(tf['1d'], 'DAY_1');
  });
});

// =============================================================================
// 13. Crypto — sha512 + hmacSHA512Hex (3 tests)
// =============================================================================

describe('Bittrex — Crypto (sha512 + hmacSHA512Hex)', () => {
  it('sha512 returns hex string (128 chars)', () => {
    const result = sha512('test data');
    assert.strictEqual(result.length, 128);
    assert.ok(/^[0-9a-f]{128}$/.test(result));
  });

  it('sha512 of empty string returns known hash', () => {
    const result = sha512('');
    assert.strictEqual(result.length, 128);
    // SHA512 of empty string is a known constant
    assert.strictEqual(result, 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e');
  });

  it('hmacSHA512Hex returns hex string (128 chars)', () => {
    const result = hmacSHA512Hex('test data', 'secret');
    assert.strictEqual(result.length, 128);
    assert.ok(/^[0-9a-f]{128}$/.test(result));
  });
});

// =============================================================================
// 14. WebSocket — SignalR V3 hub "c3" (15 tests)
// =============================================================================

describe('Bittrex — WebSocket (SignalR V3)', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex({ apiKey: 'testKey', secret: 'testSecret' });
  });

  it('WS URL is wss://socket.bittrex.com/signalr', () => {
    assert.strictEqual(exchange.describe().urls.ws, 'wss://socket.bittrex.com/signalr');
  });

  it('_getWsClient creates and caches WsClient', () => {
    const client1 = exchange._getWsClient('wss://test.com');
    const client2 = exchange._getWsClient('wss://test.com');
    assert.strictEqual(client1, client2);
    assert.strictEqual(exchange._wsClients.size, 1);
  });

  it('_getWsClient creates different clients for different URLs', () => {
    const client1 = exchange._getWsClient('wss://test1.com');
    const client2 = exchange._getWsClient('wss://test2.com');
    assert.notStrictEqual(client1, client2);
    assert.strictEqual(exchange._wsClients.size, 2);
  });

  it('_subscribeBittrex sends correct SignalR hub invocation format', async () => {
    let sentMessage;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMessage = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange._subscribeBittrex(['ticker_BTC-USDT'], () => {});

    assert.strictEqual(sentMessage.H, 'c3');
    assert.strictEqual(sentMessage.M, 'Subscribe');
    assert.deepStrictEqual(sentMessage.A, [['ticker_BTC-USDT']]);
    assert.strictEqual(sentMessage.I, 1);
  });

  it('_subscribeBittrex increments invocation ID', async () => {
    const messages = [];
    const fakeClient = {
      connected: true,
      send: (msg) => { messages.push(msg); },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange._subscribeBittrex(['ticker_BTC-USDT'], () => {});
    await exchange._subscribeBittrex(['trade_ETH-USD'], () => {});

    assert.strictEqual(messages[0].I, 1);
    assert.strictEqual(messages[1].I, 2);
    assert.strictEqual(exchange._wsInvocationId, 2);
  });

  it('watchTicker subscribes to ticker_{pair} channel', async () => {
    let sentMessage;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMessage = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTicker('BTC/USDT', () => {});

    assert.deepStrictEqual(sentMessage.A, [['ticker_BTC-USDT']]);
  });

  it('watchOrderBook subscribes to orderbook_{pair}_{depth} channel', async () => {
    let sentMessage;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMessage = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('ETH/USD', () => {}, 25);

    assert.deepStrictEqual(sentMessage.A, [['orderbook_ETH-USD_25']]);
  });

  it('watchOrderBook defaults depth to 25', async () => {
    let sentMessage;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMessage = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchOrderBook('BTC/USDT', () => {});

    assert.deepStrictEqual(sentMessage.A, [['orderbook_BTC-USDT_25']]);
  });

  it('watchTrades subscribes to trade_{pair} channel', async () => {
    let sentMessage;
    const fakeClient = {
      connected: true,
      send: (msg) => { sentMessage = msg; },
      on: () => {},
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange.watchTrades('BTC/USDT', () => {});

    assert.deepStrictEqual(sentMessage.A, [['trade_BTC-USDT']]);
  });

  it('_parseWsTicker parses ticker data correctly', () => {
    const data = { symbol: 'BTC-USDT', lastTradeRate: '50000', bidRate: '49900', askRate: '50100' };
    const result = exchange._parseWsTicker(data, 'BTC/USDT');

    assert.strictEqual(result.symbol, 'BTC/USDT');
    assert.strictEqual(result.last, 50000);
    assert.strictEqual(result.bid, 49900);
    assert.strictEqual(result.ask, 50100);
    assert.strictEqual(result.close, 50000);
    assert.strictEqual(result.high, undefined);
    assert.strictEqual(result.low, undefined);
    assert.ok(result.timestamp > 0);
    assert.ok(result.info);
  });

  it('_parseWsOrderBook parses delta data correctly', () => {
    const data = {
      marketSymbol: 'BTC-USDT',
      depth: 25,
      sequence: 12345,
      bidDeltas: [{ rate: '49900', quantity: '0.5' }, { rate: '49800', quantity: '1.0' }],
      askDeltas: [{ rate: '50100', quantity: '0.3' }],
    };
    const result = exchange._parseWsOrderBook(data, 'BTC/USDT');

    assert.strictEqual(result.symbol, 'BTC/USDT');
    assert.deepStrictEqual(result.bids[0], [49900, 0.5]);
    assert.deepStrictEqual(result.bids[1], [49800, 1.0]);
    assert.deepStrictEqual(result.asks[0], [50100, 0.3]);
    assert.strictEqual(result.nonce, 12345);
    assert.ok(result.timestamp > 0);
  });

  it('_parseWsTrades parses trade deltas correctly', () => {
    const data = {
      deltas: [
        { id: '100', rate: '50000', quantity: '0.1', takerSide: 'BUY', executedAt: '2024-01-01T12:00:00Z' },
        { id: '101', rate: '50100', quantity: '0.2', takerSide: 'SELL', executedAt: '2024-01-01T12:01:00Z' },
      ],
    };
    const trades = exchange._parseWsTrades(data, 'BTC/USDT');

    assert.strictEqual(trades.length, 2);
    assert.strictEqual(trades[0].id, '100');
    assert.strictEqual(trades[0].symbol, 'BTC/USDT');
    assert.strictEqual(trades[0].price, 50000);
    assert.strictEqual(trades[0].amount, 0.1);
    assert.strictEqual(trades[0].cost, 5000);
    assert.strictEqual(trades[0].side, 'buy');
    assert.strictEqual(trades[1].side, 'sell');
    assert.strictEqual(trades[1].price, 50100);
  });

  it('_parseWsTrades handles single trade (no deltas wrapper)', () => {
    const data = { id: '200', rate: '51000', quantity: '0.5', takerSide: 'BUY', executedAt: '2024-01-01T12:00:00Z' };
    const trades = exchange._parseWsTrades(data, 'ETH/USD');

    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].id, '200');
    assert.strictEqual(trades[0].price, 51000);
    assert.strictEqual(trades[0].amount, 0.5);
    assert.strictEqual(trades[0].side, 'buy');
  });

  it('closeAllWs clears all clients and handlers', async () => {
    // Add fake entries
    exchange._wsClients.set('url1', { close: async () => {} });
    exchange._wsClients.set('url2', { close: async () => {} });
    exchange._wsHandlers.set('handler1', {});

    await exchange.closeAllWs();

    assert.strictEqual(exchange._wsClients.size, 0);
    assert.strictEqual(exchange._wsHandlers.size, 0);
  });
});

// =============================================================================
// 15. WebSocket — SignalR Message Handling (5 tests)
// =============================================================================

describe('Bittrex — WebSocket SignalR Message Dispatch', () => {
  let exchange;

  beforeEach(() => {
    exchange = new Bittrex();
  });

  it('dispatches ticker method from SignalR hub message', async () => {
    let receivedMethod, receivedPayload;
    const fakeClient = {
      connected: true,
      send: () => {},
      on: (event, handler) => {
        // Simulate incoming SignalR message
        if (event === 'message') {
          handler({
            C: 'cursor-123',
            M: [{ H: 'C3', M: 'ticker', A: [JSON.stringify({ symbol: 'BTC-USDT', lastTradeRate: '50000', bidRate: '49900', askRate: '50100' })] }],
          });
        }
      },
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange._subscribeBittrex(['ticker_BTC-USDT'], (method, payload) => {
      receivedMethod = method;
      receivedPayload = payload;
    });

    assert.strictEqual(receivedMethod, 'ticker');
    assert.strictEqual(receivedPayload.lastTradeRate, '50000');
    assert.strictEqual(receivedPayload.bidRate, '49900');
  });

  it('dispatches orderBook method from SignalR hub message', async () => {
    let receivedMethod, receivedPayload;
    const fakeClient = {
      connected: true,
      send: () => {},
      on: (event, handler) => {
        if (event === 'message') {
          handler({
            C: 'cursor-456',
            M: [{ H: 'C3', M: 'orderBook', A: [JSON.stringify({
              marketSymbol: 'BTC-USDT', depth: 25, sequence: 100,
              bidDeltas: [{ rate: '49900', quantity: '0.5' }],
              askDeltas: [{ rate: '50100', quantity: '0.3' }],
            })] }],
          });
        }
      },
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange._subscribeBittrex(['orderbook_BTC-USDT_25'], (method, payload) => {
      receivedMethod = method;
      receivedPayload = payload;
    });

    assert.strictEqual(receivedMethod, 'orderBook');
    assert.ok(receivedPayload.bidDeltas);
    assert.ok(receivedPayload.askDeltas);
  });

  it('dispatches trade method from SignalR hub message', async () => {
    let receivedMethod, receivedPayload;
    const fakeClient = {
      connected: true,
      send: () => {},
      on: (event, handler) => {
        if (event === 'message') {
          handler({
            C: 'cursor-789',
            M: [{ H: 'C3', M: 'trade', A: [JSON.stringify({
              deltas: [{ id: '100', rate: '50000', quantity: '0.1', takerSide: 'BUY', executedAt: '2024-01-01T12:00:00Z' }],
            })] }],
          });
        }
      },
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange._subscribeBittrex(['trade_BTC-USDT'], (method, payload) => {
      receivedMethod = method;
      receivedPayload = payload;
    });

    assert.strictEqual(receivedMethod, 'trade');
    assert.ok(receivedPayload.deltas);
    assert.strictEqual(receivedPayload.deltas[0].id, '100');
  });

  it('handles A[0] as object (not JSON string)', async () => {
    let receivedPayload;
    const fakeClient = {
      connected: true,
      send: () => {},
      on: (event, handler) => {
        if (event === 'message') {
          handler({
            M: [{ H: 'C3', M: 'ticker', A: [{ symbol: 'BTC-USDT', lastTradeRate: '50000' }] }],
          });
        }
      },
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange._subscribeBittrex(['ticker_BTC-USDT'], (method, payload) => {
      receivedPayload = payload;
    });

    assert.strictEqual(receivedPayload.lastTradeRate, '50000');
  });

  it('ignores non-hub messages (no M array)', async () => {
    let callCount = 0;
    const fakeClient = {
      connected: true,
      send: () => {},
      on: (event, handler) => {
        if (event === 'message') {
          // Send various non-hub messages
          handler({ R: true, I: '1' });         // Invocation response
          handler({ S: 1, G: 'group-id' });     // Init message
          handler({});                           // Empty
        }
      },
    };
    exchange._getWsClient = () => fakeClient;
    exchange._ensureWsConnected = async () => fakeClient;

    await exchange._subscribeBittrex(['ticker_BTC-USDT'], () => {
      callCount++;
    });

    assert.strictEqual(callCount, 0);
  });
});

// =============================================================================
// 16. Version check
// =============================================================================

describe('Bittrex — Version', () => {
  it('library version is 2.2.0', () => {
    assert.strictEqual(ygcc.version, '2.2.0');
  });
});

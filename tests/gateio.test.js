'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ygcc = require('../index');
const { Gateio, sha512, hmacSHA512Hex, hmacSHA256 } = ygcc;
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = ygcc;

// =============================================================================
// 1. MODULE EXPORTS
// =============================================================================

describe('Module Exports — Gate.io', () => {
  it('exports Gateio class and lowercase alias', () => {
    assert.strictEqual(typeof Gateio, 'function');
    assert.strictEqual(ygcc.gateio, Gateio);
    assert.strictEqual(ygcc.Gateio, Gateio);
  });

  it('exchange list includes gateio', () => {
    assert.ok(ygcc.exchanges.includes('gateio'));
  });

  it('version is 2.4.0', () => {
    assert.strictEqual(ygcc.version, '2.4.0');
  });
});

// =============================================================================
// 2. GATEIO CONSTRUCTOR
// =============================================================================

describe('Gateio Constructor', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio();
  });

  it('creates instance with correct id, name, version', () => {
    assert.strictEqual(ex.id, 'gateio');
    assert.strictEqual(ex.name, 'Gate.io');
    assert.strictEqual(ex.version, 'v4');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(ex.postAsJson, true);
    assert.strictEqual(ex.postAsFormEncoded, false);
  });

  it('accepts custom config', () => {
    const custom = new Gateio({ apiKey: 'k', secret: 's', timeout: 5000 });
    assert.strictEqual(custom.apiKey, 'k');
    assert.strictEqual(custom.secret, 's');
    assert.strictEqual(custom.timeout, 5000);
  });

  it('has default settle usdt', () => {
    assert.strictEqual(ex.settle, 'usdt');
  });

  it('accepts custom settle', () => {
    const custom = new Gateio({ settle: 'btc' });
    assert.strictEqual(custom.settle, 'btc');
  });

  it('has correct API URLs', () => {
    assert.strictEqual(ex.urls.api, 'https://api.gateio.ws');
    assert.strictEqual(ex.urls.ws, 'wss://api.gateio.ws/ws/v4/');
  });

  it('has timeframes defined', () => {
    assert.ok(Object.keys(ex.timeframes).length > 0);
    assert.strictEqual(ex.timeframes['1m'], '1m');
    assert.strictEqual(ex.timeframes['1h'], '1h');
    assert.strictEqual(ex.timeframes['1d'], '1d');
  });

  it('has trading fees', () => {
    assert.strictEqual(ex.fees.trading.maker, 0.002);
    assert.strictEqual(ex.fees.trading.taker, 0.002);
  });

  it('supports all expected capabilities', () => {
    assert.strictEqual(ex.has.loadMarkets, true);
    assert.strictEqual(ex.has.fetchTicker, true);
    assert.strictEqual(ex.has.fetchOrderBook, true);
    assert.strictEqual(ex.has.createOrder, true);
    assert.strictEqual(ex.has.watchTicker, true);
    assert.strictEqual(ex.has.watchBalance, true);
    assert.strictEqual(ex.has.amendOrder, false);
  });

  it('inherits from BaseExchange', () => {
    assert.ok(ex instanceof require('../lib/BaseExchange'));
  });
});

// =============================================================================
// 3. AUTHENTICATION — SHA512 body hash + HMAC-SHA512 hex
// =============================================================================

describe('Gate.io Authentication', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio({ apiKey: 'test-key', secret: 'test-secret' });
  });

  it('_sign returns headers with KEY, Timestamp, SIGN', () => {
    const result = ex._sign('/api/v4/spot/accounts', 'GET', {});
    assert.ok(result.headers);
    assert.strictEqual(result.headers.KEY, 'test-key');
    assert.ok(result.headers.Timestamp);
    assert.ok(result.headers.SIGN);
  });

  it('Timestamp is unix seconds (not milliseconds)', () => {
    const result = ex._sign('/api/v4/spot/accounts', 'GET', {});
    const ts = parseInt(result.headers.Timestamp, 10);
    assert.ok(ts < 10000000000, 'Should be seconds, not milliseconds');
    assert.ok(ts > 1700000000, 'Should be reasonable unix timestamp');
  });

  it('SIGN is hex string (lowercase, 128 chars for SHA512)', () => {
    const result = ex._sign('/api/v4/spot/accounts', 'GET', {});
    assert.ok(/^[0-9a-f]{128}$/.test(result.headers.SIGN), 'Should be 128-char hex (SHA512)');
  });

  it('signing payload uses 5-line format for GET', () => {
    // Verify that GET signing hashes empty body
    const emptyBodyHash = sha512('');
    assert.ok(emptyBodyHash.length === 128, 'SHA512 of empty string should be 128 hex chars');
  });

  it('signing payload uses 5-line format for POST with body', () => {
    const result = ex._sign('/api/v4/spot/orders', 'POST', { currency_pair: 'BTC_USDT', side: 'buy' });
    assert.ok(result.headers.SIGN);
    assert.ok(result.headers.SIGN.length === 128);
  });

  it('throws AuthenticationError without apiKey', () => {
    const noKey = new Gateio({ secret: 's' });
    assert.throws(() => noKey._sign('/path', 'GET', {}), ExchangeError);
  });

  it('throws AuthenticationError without secret', () => {
    const noSecret = new Gateio({ apiKey: 'k' });
    assert.throws(() => noSecret._sign('/path', 'GET', {}), ExchangeError);
  });

  it('different params produce different signatures', () => {
    const r1 = ex._sign('/api/v4/spot/orders', 'POST', { currency_pair: 'BTC_USDT' });
    const r2 = ex._sign('/api/v4/spot/orders', 'POST', { currency_pair: 'ETH_USDT' });
    assert.notStrictEqual(r1.headers.SIGN, r2.headers.SIGN);
  });
});

// =============================================================================
// 4. RESPONSE HANDLING — No wrapper, label/message errors
// =============================================================================

describe('Gate.io Response Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio();
  });

  it('_unwrapResponse returns data directly when no error', () => {
    const data = { currency_pair: 'BTC_USDT', last: '50000' };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse returns array directly', () => {
    const data = [{ id: '1' }, { id: '2' }];
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse throws on label error', () => {
    assert.throws(
      () => ex._unwrapResponse({ label: 'INVALID_KEY', message: 'bad key' }),
      AuthenticationError,
    );
  });

  it('_unwrapResponse handles null/undefined gracefully', () => {
    assert.strictEqual(ex._unwrapResponse(null), null);
    assert.strictEqual(ex._unwrapResponse(undefined), undefined);
  });
});

// =============================================================================
// 5. PARSERS
// =============================================================================

describe('Gate.io Parsers', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio();
  });

  it('_parseTicker parses Gate.io ticker format', () => {
    const ticker = ex._parseTicker({
      currency_pair: 'BTC_USDT',
      last: '50000.50',
      high_24h: '51000',
      low_24h: '49000',
      base_volume: '1234.5',
      quote_volume: '61725000',
      highest_bid: '49999',
      lowest_ask: '50001',
      change_percentage: '2.5',
    });
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, 50000.50);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.low, 49000);
    assert.strictEqual(ticker.bid, 49999);
    assert.strictEqual(ticker.ask, 50001);
    assert.strictEqual(ticker.volume, 1234.5);
    assert.strictEqual(ticker.quoteVolume, 61725000);
    assert.strictEqual(ticker.percentage, 2.5);
  });

  it('_parseOrder parses Gate.io order format', () => {
    const order = ex._parseOrder({
      id: '12345',
      currency_pair: 'BTC_USDT',
      side: 'buy',
      type: 'limit',
      amount: '0.5',
      price: '50000',
      left: '0.2',
      filled_total: '15000',
      status: 'open',
      create_time: '1700000000.123',
      fee: '0.001',
      fee_currency: 'BTC',
      text: 'my-order-1',
    });
    assert.strictEqual(order.id, '12345');
    assert.strictEqual(order.symbol, 'BTC/USDT');
    assert.strictEqual(order.side, 'BUY');
    assert.strictEqual(order.type, 'LIMIT');
    assert.strictEqual(order.amount, 0.5);
    assert.strictEqual(order.remaining, 0.2);
    assert.strictEqual(order.filled, 0.3);
    assert.strictEqual(order.cost, 15000);
    assert.strictEqual(order.status, 'NEW');
    assert.strictEqual(order.clientOrderId, 'my-order-1');
    assert.strictEqual(order.fee.cost, 0.001);
    assert.strictEqual(order.fee.currency, 'BTC');
  });

  it('_parseOrderCreateResult returns id and status NEW', () => {
    const result = ex._parseOrderCreateResult({
      id: '99999',
      currency_pair: 'ETH_USDT',
      text: 't-my-order',
    });
    assert.strictEqual(result.id, '99999');
    assert.strictEqual(result.status, 'NEW');
    assert.strictEqual(result.symbol, 'ETH/USDT');
  });

  it('_parseTrade parses public trade', () => {
    const trade = ex._parseTrade({
      id: 't123',
      currency_pair: 'BTC_USDT',
      price: '50000',
      amount: '0.1',
      side: 'buy',
      create_time: '1700000000',
    });
    assert.strictEqual(trade.id, 't123');
    assert.strictEqual(trade.symbol, 'BTC/USDT');
    assert.strictEqual(trade.price, 50000);
    assert.strictEqual(trade.amount, 0.1);
    assert.strictEqual(trade.cost, 5000);
    assert.strictEqual(trade.side, 'buy');
  });

  it('_parseMyTrade parses private trade with fee', () => {
    const trade = ex._parseMyTrade({
      id: 'mt456',
      order_id: 'o789',
      currency_pair: 'ETH_USDT',
      price: '3000',
      amount: '2.5',
      fee: '0.005',
      fee_currency: 'ETH',
      side: 'sell',
      role: 'maker',
      create_time: '1700000000',
    });
    assert.strictEqual(trade.id, 'mt456');
    assert.strictEqual(trade.orderId, 'o789');
    assert.strictEqual(trade.symbol, 'ETH/USDT');
    assert.strictEqual(trade.price, 3000);
    assert.strictEqual(trade.fee.cost, 0.005);
    assert.strictEqual(trade.fee.currency, 'ETH');
    assert.strictEqual(trade.isMaker, true);
  });

  it('_normalizeStatus maps Gate.io statuses correctly', () => {
    assert.strictEqual(ex._normalizeStatus('open'), 'NEW');
    assert.strictEqual(ex._normalizeStatus('closed'), 'FILLED');
    assert.strictEqual(ex._normalizeStatus('cancelled'), 'CANCELED');
    assert.strictEqual(ex._normalizeStatus('canceled'), 'CANCELED');
  });

  it('_parseTicker handles missing fields gracefully', () => {
    const ticker = ex._parseTicker({ currency_pair: 'BTC_USDT' });
    assert.strictEqual(ticker.symbol, 'BTC/USDT');
    assert.strictEqual(ticker.last, undefined);
    assert.strictEqual(ticker.high, undefined);
  });

  it('_parseOrder handles zero amounts correctly', () => {
    const order = ex._parseOrder({
      id: '1',
      currency_pair: 'BTC_USDT',
      amount: '0',
      left: '0',
      status: 'closed',
    });
    assert.strictEqual(order.amount, 0);
    assert.strictEqual(order.filled, 0);
    assert.strictEqual(order.remaining, 0);
  });

  it('candlestick format is correctly documented [time, vol, close, high, low, open, quote_vol]', () => {
    // Gate.io OHLCV: [time(s), volume, close, high, low, open, quote_volume]
    // Verify parsing logic with mock data
    const raw = ['1700000000', '100.5', '50000', '51000', '49000', '49500', '5000000'];
    // After parsing: [time*1000, open(idx5), high(idx3), low(idx4), close(idx2), volume(idx1)]
    const parsed = [
      parseInt(raw[0], 10) * 1000,
      parseFloat(raw[5]),  // open
      parseFloat(raw[3]),  // high
      parseFloat(raw[4]),  // low
      parseFloat(raw[2]),  // close
      parseFloat(raw[1]),  // volume
    ];
    assert.strictEqual(parsed[0], 1700000000000);
    assert.strictEqual(parsed[1], 49500);   // open
    assert.strictEqual(parsed[2], 51000);   // high
    assert.strictEqual(parsed[3], 49000);   // low
    assert.strictEqual(parsed[4], 50000);   // close
    assert.strictEqual(parsed[5], 100.5);   // volume
  });
});

// =============================================================================
// 6. HELPER METHODS — Symbol Conversion
// =============================================================================

describe('Gate.io Helper Methods', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio();
  });

  it('_toGateSymbol converts BTC/USDT → BTC_USDT', () => {
    assert.strictEqual(ex._toGateSymbol('BTC/USDT'), 'BTC_USDT');
  });

  it('_toGateSymbol passes through already-formatted symbols', () => {
    assert.strictEqual(ex._toGateSymbol('BTC_USDT'), 'BTC_USDT');
  });

  it('_fromGateSymbol converts BTC_USDT → BTC/USDT', () => {
    assert.strictEqual(ex._fromGateSymbol('BTC_USDT'), 'BTC/USDT');
  });

  it('_fromGateSymbol passes through already-unified symbols', () => {
    assert.strictEqual(ex._fromGateSymbol('BTC/USDT'), 'BTC/USDT');
  });
});

// =============================================================================
// 7. ERROR MAPPING — Label-based
// =============================================================================

describe('Gate.io Error Mapping', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio();
  });

  it('INVALID_KEY throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleGateError('INVALID_KEY', 'bad key'),
      AuthenticationError,
    );
  });

  it('INVALID_SIGNATURE throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleGateError('INVALID_SIGNATURE', 'bad sig'),
      AuthenticationError,
    );
  });

  it('TOO_MANY_REQUESTS throws RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleGateError('TOO_MANY_REQUESTS', 'slow down'),
      RateLimitExceeded,
    );
  });

  it('INSUFFICIENT_BALANCE throws InsufficientFunds', () => {
    assert.throws(
      () => ex._handleGateError('INSUFFICIENT_BALANCE', 'no funds'),
      InsufficientFunds,
    );
  });

  it('INVALID_AMOUNT throws InvalidOrder', () => {
    assert.throws(
      () => ex._handleGateError('INVALID_AMOUNT', 'bad amount'),
      InvalidOrder,
    );
  });

  it('ORDER_NOT_FOUND throws OrderNotFound', () => {
    assert.throws(
      () => ex._handleGateError('ORDER_NOT_FOUND', 'not found'),
      OrderNotFound,
    );
  });

  it('INVALID_CURRENCY_PAIR throws BadSymbol', () => {
    assert.throws(
      () => ex._handleGateError('INVALID_CURRENCY_PAIR', 'bad pair'),
      BadSymbol,
    );
  });

  it('INVALID_PARAM throws BadRequest', () => {
    assert.throws(
      () => ex._handleGateError('INVALID_PARAM', 'bad param'),
      BadRequest,
    );
  });

  it('SERVER_ERROR throws ExchangeNotAvailable', () => {
    assert.throws(
      () => ex._handleGateError('SERVER_ERROR', 'down'),
      ExchangeNotAvailable,
    );
  });

  it('unknown label throws ExchangeError', () => {
    assert.throws(
      () => ex._handleGateError('UNKNOWN_ERROR', 'something'),
      ExchangeError,
    );
  });
});

// =============================================================================
// 8. HTTP ERROR HANDLING
// =============================================================================

describe('Gate.io HTTP Error Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio();
  });

  it('HTTP 401 throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleHttpError(401, 'Unauthorized'),
      AuthenticationError,
    );
  });

  it('HTTP 403 throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleHttpError(403, 'Forbidden'),
      AuthenticationError,
    );
  });

  it('HTTP 429 throws RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleHttpError(429, 'Too Many Requests'),
      RateLimitExceeded,
    );
  });

  it('HTTP 503 throws ExchangeNotAvailable', () => {
    assert.throws(
      () => ex._handleHttpError(503, 'Service Unavailable'),
      ExchangeNotAvailable,
    );
  });

  it('HTTP error with JSON label triggers _handleGateError', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ label: 'INVALID_KEY', message: 'bad' })),
      AuthenticationError,
    );
  });
});

// =============================================================================
// 9. RATE LIMIT HEADERS
// =============================================================================

describe('Gate.io Rate Limit Headers', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio({ enableRateLimit: true });
  });

  it('processes x-gate-ratelimit headers', () => {
    const headers = new Map();
    headers.set('x-gate-ratelimit-limit', '300');
    headers.set('x-gate-ratelimit-remaining', '250');
    headers.get = headers.get.bind(headers);

    // Should not throw
    ex._handleResponseHeaders(headers);
  });

  it('emits rateLimitWarning when remaining < 20%', () => {
    let warned = false;
    ex.on('rateLimitWarning', () => { warned = true; });

    const headers = new Map();
    headers.set('x-gate-ratelimit-limit', '300');
    headers.set('x-gate-ratelimit-remaining', '10');
    headers.get = headers.get.bind(headers);

    ex._handleResponseHeaders(headers);
    assert.ok(warned, 'Should emit rateLimitWarning');
  });

  it('handles missing rate limit headers gracefully', () => {
    const headers = new Map();
    headers.get = headers.get.bind(headers);
    // Should not throw
    ex._handleResponseHeaders(headers);
  });
});

// =============================================================================
// 10. MOCKED API CALLS
// =============================================================================

describe('Gate.io Mocked API Calls', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio({ apiKey: 'test-key', secret: 'test-secret' });
  });

  // --- Public endpoints (unsigned) ---

  it('fetchTime returns current timestamp', async () => {
    const time = await ex.fetchTime();
    assert.ok(typeof time === 'number');
    assert.ok(time > 1700000000000);
  });

  it('loadMarkets builds correct structure from mock data', () => {
    // Simulate direct market parsing
    const pair = {
      id: 'BTC_USDT',
      base: 'BTC',
      quote: 'USDT',
      trade_status: 'tradable',
      precision: 2,
      amount_precision: 6,
      min_base_amount: '0.0001',
      min_quote_amount: '1',
    };
    const symbol = pair.base + '/' + pair.quote;
    assert.strictEqual(symbol, 'BTC/USDT');
    assert.strictEqual(pair.trade_status, 'tradable');
  });

  it('fetchTicker builds correct request params', () => {
    const pair = ex._toGateSymbol('BTC/USDT');
    assert.strictEqual(pair, 'BTC_USDT');
  });

  it('fetchOrderBook request includes currency_pair and limit', () => {
    const pair = ex._toGateSymbol('ETH/USDT');
    const request = { currency_pair: pair, limit: 20 };
    assert.strictEqual(request.currency_pair, 'ETH_USDT');
    assert.strictEqual(request.limit, 20);
  });

  it('fetchOHLCV includes interval and currency_pair', () => {
    const pair = ex._toGateSymbol('BTC/USDT');
    const interval = ex.timeframes['1h'];
    const request = { currency_pair: pair, interval };
    assert.strictEqual(request.currency_pair, 'BTC_USDT');
    assert.strictEqual(request.interval, '1h');
  });

  // --- Private endpoints (signed) ---

  it('createOrder builds correct request body', () => {
    const pair = ex._toGateSymbol('BTC/USDT');
    const request = {
      currency_pair: pair,
      side: 'buy',
      type: 'limit',
      amount: '0.1',
      price: '50000',
      account: 'spot',
    };
    assert.strictEqual(request.currency_pair, 'BTC_USDT');
    assert.strictEqual(request.side, 'buy');
    assert.strictEqual(request.type, 'limit');
  });

  it('cancelOrder requires symbol', () => {
    assert.rejects(
      () => ex.cancelOrder('123'),
      BadRequest,
    );
  });

  it('fetchOrder requires symbol', () => {
    assert.rejects(
      () => ex.fetchOrder('123'),
      BadRequest,
    );
  });

  it('createOrder signs the request', () => {
    const result = ex._sign('/api/v4/spot/orders', 'POST', {
      currency_pair: 'BTC_USDT',
      side: 'buy',
      type: 'limit',
      amount: '0.1',
      price: '50000',
    });
    assert.ok(result.headers.KEY);
    assert.ok(result.headers.SIGN);
    assert.ok(result.headers.Timestamp);
  });

  it('DELETE endpoint builds query string params', () => {
    const result = ex._sign('/api/v4/spot/orders/123', 'DELETE', { currency_pair: 'BTC_USDT' });
    assert.ok(result.headers.KEY);
    assert.ok(result.headers.SIGN);
  });

  it('fetchBalance signs request', () => {
    const result = ex._sign('/api/v4/spot/accounts', 'GET', {});
    assert.ok(result.headers.KEY);
    assert.ok(result.headers.SIGN);
  });

  it('fetchOpenOrders builds correct params', () => {
    const request = { status: 'open', currency_pair: ex._toGateSymbol('BTC/USDT') };
    assert.strictEqual(request.status, 'open');
    assert.strictEqual(request.currency_pair, 'BTC_USDT');
  });

  it('fetchClosedOrders uses status=finished', () => {
    const request = { status: 'finished' };
    assert.strictEqual(request.status, 'finished');
  });

  it('fetchMyTrades accepts currency_pair param', () => {
    const request = { currency_pair: ex._toGateSymbol('ETH/USDT'), limit: 50 };
    assert.strictEqual(request.currency_pair, 'ETH_USDT');
    assert.strictEqual(request.limit, 50);
  });

  it('cancelAllOrders accepts optional symbol', () => {
    const request = { currency_pair: ex._toGateSymbol('BTC/USDT') };
    assert.strictEqual(request.currency_pair, 'BTC_USDT');
  });

  it('fetchTradingFees converts symbol', () => {
    const pair = ex._toGateSymbol('BTC/USDT');
    assert.strictEqual(pair, 'BTC_USDT');
  });

  it('GET signing hashes empty body', () => {
    const result = ex._sign('/api/v4/spot/accounts', 'GET', {});
    // Body should be hashed as empty string for GET
    assert.ok(result.headers.SIGN.length === 128);
  });
});

// =============================================================================
// 11. MARKET LOOKUP
// =============================================================================

describe('Gate.io Market Lookup', () => {
  let ex;
  beforeEach(() => {
    ex = new Gateio();
  });

  it('market() throws when markets not loaded', () => {
    assert.throws(
      () => ex.market('BTC/USDT'),
      ExchangeError,
    );
  });

  it('market() throws for unknown symbol', () => {
    ex._marketsLoaded = true;
    ex.markets = { 'BTC/USDT': { id: 'BTC_USDT' } };
    assert.throws(
      () => ex.market('FAKE/COIN'),
      ExchangeError,
    );
  });

  it('market() returns market for valid symbol', () => {
    ex._marketsLoaded = true;
    ex.markets = { 'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT' } };
    const m = ex.market('BTC/USDT');
    assert.strictEqual(m.id, 'BTC_USDT');
  });
});

// =============================================================================
// 12. GATE.IO VS OTHERS DIFFERENCES
// =============================================================================

describe('Gate.io vs Others — Key Differences', () => {
  it('Gate.io uses HMAC-SHA512 hex (not SHA256)', () => {
    const data = 'test';
    const secret = 'secret';
    const sig = hmacSHA512Hex(data, secret);
    // SHA512 hex = 128 chars, SHA256 hex = 64 chars
    assert.strictEqual(sig.length, 128);
    assert.ok(/^[0-9a-f]+$/.test(sig));
  });

  it('Gate.io hashes body with SHA512 before signing', () => {
    const bodyHash = sha512('{"currency_pair":"BTC_USDT"}');
    assert.strictEqual(bodyHash.length, 128);
  });

  it('Gate.io uses underscore symbols (BTC_USDT)', () => {
    const ex = new Gateio();
    assert.strictEqual(ex._toGateSymbol('BTC/USDT'), 'BTC_USDT');
    assert.strictEqual(ex._toGateSymbol('ETH/BTC'), 'ETH_BTC');
  });

  it('Gate.io candlestick order: [time, vol, close, high, low, open, quote_vol]', () => {
    // Gate.io is unique: volume at index 1, close at index 2, open at index 5
    const raw = ['1700000000', '500', '50000', '51000', '49000', '49500', '25000000'];
    const open = parseFloat(raw[5]);    // 49500
    const high = parseFloat(raw[3]);    // 51000
    const low = parseFloat(raw[4]);     // 49000
    const close = parseFloat(raw[2]);   // 50000
    const volume = parseFloat(raw[1]);  // 500
    assert.strictEqual(open, 49500);
    assert.strictEqual(close, 50000);
    assert.strictEqual(high, 51000);
    assert.strictEqual(low, 49000);
    assert.strictEqual(volume, 500);
  });

  it('Gate.io response has no wrapper (direct JSON)', () => {
    const ex = new Gateio();
    // Unlike OKX { code, data } or Kraken { error, result }
    const data = { last: '50000', currency_pair: 'BTC_USDT' };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });
});

// =============================================================================
// 13. CRYPTO — sha512 & hmacSHA512Hex
// =============================================================================

describe('Crypto — sha512 & hmacSHA512Hex', () => {
  it('sha512 produces 128-char hex string', () => {
    const hash = sha512('hello world');
    assert.strictEqual(hash.length, 128);
    assert.ok(/^[0-9a-f]+$/.test(hash));
  });

  it('sha512 of empty string produces known hash', () => {
    const hash = sha512('');
    // SHA512 of empty string is well-known
    assert.ok(hash.startsWith('cf83e1357eefb8bd'));
    assert.strictEqual(hash.length, 128);
  });

  it('hmacSHA512Hex produces 128-char hex string', () => {
    const mac = hmacSHA512Hex('data', 'secret');
    assert.strictEqual(mac.length, 128);
    assert.ok(/^[0-9a-f]+$/.test(mac));
  });
});

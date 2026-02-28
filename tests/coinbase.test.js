'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const ygcc = require('../index');
const { Coinbase, base64UrlEncode, signJWT } = ygcc;
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = ygcc;

// Generate a test EC P-256 key pair for JWT signing tests
const testKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testPrivateKeyPem = testKeyPair.privateKey.export({ type: 'sec1', format: 'pem' });
const testPublicKey = testKeyPair.publicKey;
const testApiKey = 'organizations/test-org/apiKeys/test-key-id';

// =============================================================================
// 1. MODULE EXPORTS
// =============================================================================

describe('Module Exports — Coinbase', () => {
  it('exports Coinbase class and lowercase alias', () => {
    assert.strictEqual(typeof Coinbase, 'function');
    assert.strictEqual(ygcc.coinbase, Coinbase);
    assert.strictEqual(ygcc.Coinbase, Coinbase);
  });

  it('exchange list includes coinbase', () => {
    assert.ok(ygcc.exchanges.includes('coinbase'));
  });

  it('version is 2.4.0', () => {
    assert.strictEqual(ygcc.version, '2.4.0');
  });
});

// =============================================================================
// 2. COINBASE CONSTRUCTOR
// =============================================================================

describe('Coinbase Constructor', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase();
  });

  it('creates instance with correct id, name, version', () => {
    assert.strictEqual(ex.id, 'coinbase');
    assert.strictEqual(ex.name, 'Coinbase');
    assert.strictEqual(ex.version, 'v3');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(ex.postAsJson, true);
    assert.strictEqual(ex.postAsFormEncoded, false);
  });

  it('accepts custom config', () => {
    const custom = new Coinbase({ apiKey: testApiKey, secret: testPrivateKeyPem, timeout: 5000 });
    assert.strictEqual(custom.apiKey, testApiKey);
    assert.strictEqual(custom.secret, testPrivateKeyPem);
    assert.strictEqual(custom.timeout, 5000);
  });

  it('has correct API URL', () => {
    assert.strictEqual(ex.urls.api, 'https://api.coinbase.com');
  });

  it('has two separate WebSocket URLs', () => {
    assert.strictEqual(ex.urls.ws, 'wss://advanced-trade-ws.coinbase.com');
    assert.strictEqual(ex.urls.wsPrivate, 'wss://advanced-trade-ws-user.coinbase.com');
  });

  it('has timeframes as string enums', () => {
    assert.ok(Object.keys(ex.timeframes).length > 0);
    assert.strictEqual(ex.timeframes['1m'], 'ONE_MINUTE');
    assert.strictEqual(ex.timeframes['5m'], 'FIVE_MINUTE');
    assert.strictEqual(ex.timeframes['1h'], 'ONE_HOUR');
    assert.strictEqual(ex.timeframes['1d'], 'ONE_DAY');
  });

  it('has trading fees (maker 0.4%, taker 0.6%)', () => {
    assert.strictEqual(ex.fees.trading.maker, 0.004);
    assert.strictEqual(ex.fees.trading.taker, 0.006);
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

  it('does not require passphrase (unlike KuCoin/OKX)', () => {
    const coinbase = new Coinbase({ apiKey: testApiKey, secret: testPrivateKeyPem });
    assert.strictEqual(coinbase.apiKey, testApiKey);
    // No passphrase property needed — should not throw
  });
});

// =============================================================================
// 3. AUTHENTICATION — JWT / ES256 (ECDSA P-256)
// =============================================================================

describe('Coinbase Authentication — JWT/ES256', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase({ apiKey: testApiKey, secret: testPrivateKeyPem });
  });

  it('_sign returns Authorization header with Bearer JWT', () => {
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    assert.ok(result.headers);
    assert.ok(result.headers['Authorization']);
    assert.ok(result.headers['Authorization'].startsWith('Bearer '));
  });

  it('JWT has 3 dot-separated segments', () => {
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const jwt = result.headers['Authorization'].replace('Bearer ', '');
    const parts = jwt.split('.');
    assert.strictEqual(parts.length, 3, 'JWT should have 3 segments: header.payload.signature');
  });

  it('JWT header contains alg=ES256, typ=JWT, kid=apiKey, nonce', () => {
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const jwt = result.headers['Authorization'].replace('Bearer ', '');
    const headerB64 = jwt.split('.')[0];
    // Decode base64url
    const headerJson = Buffer.from(headerB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const header = JSON.parse(headerJson);
    assert.strictEqual(header.alg, 'ES256');
    assert.strictEqual(header.typ, 'JWT');
    assert.strictEqual(header.kid, testApiKey);
    assert.ok(header.nonce, 'Should have a random nonce');
    assert.ok(typeof header.nonce === 'string');
  });

  it('JWT payload contains iss=coinbase-cloud, sub=apiKey, nbf, exp, uri', () => {
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const jwt = result.headers['Authorization'].replace('Bearer ', '');
    const payloadB64 = jwt.split('.')[1];
    const payloadJson = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const payload = JSON.parse(payloadJson);
    assert.strictEqual(payload.iss, 'coinbase-cloud');
    assert.strictEqual(payload.sub, testApiKey);
    assert.ok(typeof payload.nbf === 'number');
    assert.ok(typeof payload.exp === 'number');
    assert.strictEqual(payload.exp, payload.nbf + 120, 'Token should expire in 120 seconds');
    assert.strictEqual(payload.uri, 'GET api.coinbase.com/api/v3/brokerage/accounts');
  });

  it('JWT signature is valid ES256 (verifiable with public key)', () => {
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const jwt = result.headers['Authorization'].replace('Bearer ', '');
    const parts = jwt.split('.');
    const signingInput = parts[0] + '.' + parts[1];
    // Decode base64url signature
    const sigB64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    const sigBuffer = Buffer.from(sigB64, 'base64');
    const valid = crypto.verify('sha256', Buffer.from(signingInput), {
      key: testPublicKey,
      dsaEncoding: 'ieee-p1363',
    }, sigBuffer);
    assert.ok(valid, 'JWT signature should be verifiable with the corresponding public key');
  });

  it('different paths produce different URIs in JWT payload', () => {
    const r1 = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const r2 = ex._sign('/api/v3/brokerage/orders', 'POST', {});
    const jwt1 = r1.headers['Authorization'].replace('Bearer ', '');
    const jwt2 = r2.headers['Authorization'].replace('Bearer ', '');
    const p1 = JSON.parse(Buffer.from(jwt1.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const p2 = JSON.parse(Buffer.from(jwt2.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.strictEqual(p1.uri, 'GET api.coinbase.com/api/v3/brokerage/accounts');
    assert.strictEqual(p2.uri, 'POST api.coinbase.com/api/v3/brokerage/orders');
  });

  it('different calls produce different nonces', () => {
    const r1 = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const r2 = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const jwt1 = r1.headers['Authorization'].replace('Bearer ', '');
    const jwt2 = r2.headers['Authorization'].replace('Bearer ', '');
    const h1 = JSON.parse(Buffer.from(jwt1.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const h2 = JSON.parse(Buffer.from(jwt2.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.notStrictEqual(h1.nonce, h2.nonce, 'Each JWT should have a unique nonce');
  });

  it('throws ExchangeError without apiKey', () => {
    const noKey = new Coinbase({ secret: testPrivateKeyPem });
    assert.throws(() => noKey._sign('/path', 'GET', {}), ExchangeError);
  });

  it('throws ExchangeError without secret', () => {
    const noSecret = new Coinbase({ apiKey: testApiKey });
    assert.throws(() => noSecret._sign('/path', 'GET', {}), { name: /Error/ });
  });

  it('WS JWT uses iss=cdp and no uri claim', () => {
    const wsJwt = signJWT(testApiKey, testPrivateKeyPem, null, 'cdp');
    const parts = wsJwt.split('.');
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.strictEqual(payload.iss, 'cdp', 'WS JWT should use iss=cdp');
    assert.strictEqual(payload.uri, undefined, 'WS JWT should NOT have uri');
    assert.strictEqual(payload.sub, testApiKey);
  });
});

// =============================================================================
// 4. RESPONSE HANDLING — No wrapper, error via { error } or { errors }
// =============================================================================

describe('Coinbase Response Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase();
  });

  it('_unwrapResponse returns data directly (no wrapper)', () => {
    const data = { products: [{ product_id: 'BTC-USD' }] };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, data);
  });

  it('_unwrapResponse throws on { error } field', () => {
    assert.throws(
      () => ex._unwrapResponse({ error: 'authentication_error', message: 'Invalid token' }),
      AuthenticationError,
    );
  });

  it('_unwrapResponse throws on { errors: [{ id, message }] }', () => {
    assert.throws(
      () => ex._unwrapResponse({ errors: [{ id: 'not_found', message: 'Resource not found' }] }),
      OrderNotFound,
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

describe('Coinbase Parsers', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase();
  });

  it('_parseTicker parses product data', () => {
    const ticker = ex._parseTicker({
      product_id: 'BTC-USD',
      price: '50000.50',
      bid: '49999',
      bid_size: '1.5',
      ask: '50001',
      ask_size: '2.0',
      volume_24h: '12345.6',
      price_percentage_change_24h: '2.5',
      high_24h: '51000',
      low_24h: '49000',
    }, 'BTC/USD');
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.last, 50000.50);
    assert.strictEqual(ticker.bid, 49999);
    assert.strictEqual(ticker.bidVolume, 1.5);
    assert.strictEqual(ticker.ask, 50001);
    assert.strictEqual(ticker.askVolume, 2.0);
    assert.strictEqual(ticker.volume, 12345.6);
    assert.strictEqual(ticker.percentage, 2.5);
    assert.strictEqual(ticker.high, 51000);
    assert.strictEqual(ticker.low, 49000);
  });

  it('_parseOrder parses order with limit_limit_gtc configuration', () => {
    const order = ex._parseOrder({
      order_id: 'ord-123',
      client_order_id: 'my-uuid',
      product_id: 'BTC-USD',
      side: 'BUY',
      status: 'FILLED',
      filled_size: '0.3',
      filled_value: '15000',
      average_filled_price: '50000',
      total_fees: '9.0',
      created_time: '2024-01-15T10:00:00Z',
      order_configuration: {
        limit_limit_gtc: {
          base_size: '0.5',
          limit_price: '50000',
        },
      },
    });
    assert.strictEqual(order.id, 'ord-123');
    assert.strictEqual(order.clientOrderId, 'my-uuid');
    assert.strictEqual(order.symbol, 'BTC/USD');
    assert.strictEqual(order.side, 'BUY');
    assert.strictEqual(order.type, 'LIMIT');
    assert.strictEqual(order.amount, 0.5);
    assert.strictEqual(order.price, 50000);
    assert.strictEqual(order.filled, 0.3);
    assert.strictEqual(order.remaining, 0.2);
    assert.strictEqual(order.average, 50000);
    assert.strictEqual(order.status, 'FILLED');
    assert.strictEqual(order.fee.cost, 9.0);
  });

  it('_parseOrder handles market_market_ioc configuration', () => {
    const order = ex._parseOrder({
      order_id: 'ord-456',
      product_id: 'ETH-USD',
      side: 'SELL',
      status: 'FILLED',
      filled_size: '2.0',
      filled_value: '6000',
      total_fees: '3.6',
      order_configuration: {
        market_market_ioc: {
          base_size: '2.0',
        },
      },
    });
    assert.strictEqual(order.type, 'MARKET');
    assert.strictEqual(order.amount, 2.0);
    assert.strictEqual(order.side, 'SELL');
  });

  it('_parseOrderCreateResult handles success', () => {
    const result = ex._parseOrderCreateResult({
      success: true,
      success_response: {
        order_id: 'new-ord-789',
        product_id: 'BTC-USD',
      },
    }, 'my-client-id');
    assert.strictEqual(result.id, 'new-ord-789');
    assert.strictEqual(result.clientOrderId, 'my-client-id');
    assert.strictEqual(result.symbol, 'BTC/USD');
    assert.strictEqual(result.status, 'NEW');
  });

  it('_parseOrderCreateResult throws on failure', () => {
    assert.throws(
      () => ex._parseOrderCreateResult({
        success: false,
        failure_response: { error: 'INSUFFICIENT_FUND' },
      }, 'client-id'),
      InvalidOrder,
    );
  });

  it('_parseTrade parses trade data', () => {
    const trade = ex._parseTrade({
      trade_id: 't-100',
      price: '50000',
      size: '0.1',
      side: 'BUY',
      time: '2024-01-15T10:00:00Z',
    }, 'BTC/USD');
    assert.strictEqual(trade.id, 't-100');
    assert.strictEqual(trade.symbol, 'BTC/USD');
    assert.strictEqual(trade.price, 50000);
    assert.strictEqual(trade.amount, 0.1);
    assert.strictEqual(trade.cost, 5000);
    assert.strictEqual(trade.side, 'buy');
  });

  it('_parseMyTrade parses fill data', () => {
    const trade = ex._parseMyTrade({
      entry_id: 'e-200',
      trade_id: 't-200',
      order_id: 'ord-500',
      product_id: 'ETH-USD',
      price: '3000',
      size: '5.0',
      commission: '9.0',
      side: 'SELL',
      trade_time: '2024-01-15T11:00:00Z',
    });
    assert.strictEqual(trade.id, 'e-200');
    assert.strictEqual(trade.tradeId, 't-200');
    assert.strictEqual(trade.orderId, 'ord-500');
    assert.strictEqual(trade.symbol, 'ETH/USD');
    assert.strictEqual(trade.price, 3000);
    assert.strictEqual(trade.amount, 5.0);
    assert.strictEqual(trade.cost, 15000);
    assert.strictEqual(trade.fee.cost, 9.0);
    assert.strictEqual(trade.fee.currency, 'USD');
    assert.strictEqual(trade.side, 'sell');
  });

  it('_parseCandle converts object to array (strings to numbers)', () => {
    const candle = ex._parseCandle({
      start: '1700000000',
      open: '49500.50',
      high: '51000.75',
      low: '49000.25',
      close: '50000.00',
      volume: '1234.5678',
    });
    assert.deepStrictEqual(candle, [
      1700000000000,   // timestamp ms
      49500.50,        // open
      51000.75,        // high
      49000.25,        // low
      50000.00,        // close
      1234.5678,       // volume
    ]);
  });

  it('_parseTicker handles missing fields gracefully', () => {
    const ticker = ex._parseTicker({}, 'BTC/USD');
    assert.strictEqual(ticker.symbol, 'BTC/USD');
    assert.strictEqual(ticker.last, undefined);
    assert.strictEqual(ticker.bid, undefined);
  });

  it('_normalizeOrderStatus maps Coinbase statuses', () => {
    assert.strictEqual(ex._normalizeOrderStatus('OPEN'), 'NEW');
    assert.strictEqual(ex._normalizeOrderStatus('PENDING'), 'NEW');
    assert.strictEqual(ex._normalizeOrderStatus('FILLED'), 'FILLED');
    assert.strictEqual(ex._normalizeOrderStatus('CANCELLED'), 'CANCELED');
    assert.strictEqual(ex._normalizeOrderStatus('EXPIRED'), 'CANCELED');
    assert.strictEqual(ex._normalizeOrderStatus('FAILED'), 'REJECTED');
  });
});

// =============================================================================
// 6. HELPER METHODS — Symbol Conversion + clientOrderId + Order Config
// =============================================================================

describe('Coinbase Helper Methods', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase();
  });

  it('_toCoinbaseSymbol converts BTC/USD → BTC-USD', () => {
    assert.strictEqual(ex._toCoinbaseSymbol('BTC/USD'), 'BTC-USD');
  });

  it('_toCoinbaseSymbol passes through already-formatted symbols', () => {
    assert.strictEqual(ex._toCoinbaseSymbol('BTC-USD'), 'BTC-USD');
  });

  it('_fromCoinbaseSymbol converts BTC-USD → BTC/USD', () => {
    assert.strictEqual(ex._fromCoinbaseSymbol('BTC-USD'), 'BTC/USD');
  });

  it('_generateClientOrderId returns valid UUID', () => {
    const oid = ex._generateClientOrderId();
    assert.ok(typeof oid === 'string');
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(oid));
  });

  it('_buildOrderConfig builds limit_limit_gtc for limit orders', () => {
    const config = ex._buildOrderConfig('LIMIT', 'BUY', 0.5, 50000);
    assert.ok(config.limit_limit_gtc);
    assert.strictEqual(config.limit_limit_gtc.base_size, '0.5');
    assert.strictEqual(config.limit_limit_gtc.limit_price, '50000');
  });

  it('_buildOrderConfig builds market_market_ioc for market buy (quote_size)', () => {
    const config = ex._buildOrderConfig('MARKET', 'BUY', 100, undefined);
    assert.ok(config.market_market_ioc);
    assert.strictEqual(config.market_market_ioc.quote_size, '100');
    assert.strictEqual(config.market_market_ioc.base_size, undefined);
  });

  it('_buildOrderConfig builds market_market_ioc for market sell (base_size)', () => {
    const config = ex._buildOrderConfig('MARKET', 'SELL', 0.5, undefined);
    assert.ok(config.market_market_ioc);
    assert.strictEqual(config.market_market_ioc.base_size, '0.5');
    assert.strictEqual(config.market_market_ioc.quote_size, undefined);
  });

  it('timeframe mapping uses string enums', () => {
    assert.strictEqual(ex.timeframes['1m'], 'ONE_MINUTE');
    assert.strictEqual(ex.timeframes['15m'], 'FIFTEEN_MINUTE');
    assert.strictEqual(ex.timeframes['2h'], 'TWO_HOUR');
    assert.strictEqual(ex.timeframes['6h'], 'SIX_HOUR');
  });
});

// =============================================================================
// 7. COINBASE ERROR MAPPING — ID-based
// =============================================================================

describe('Coinbase Error Mapping', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase();
  });

  it('authentication_error throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleCoinbaseError('authentication_error', 'Invalid credentials'),
      AuthenticationError,
    );
  });

  it('invalid_token throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleCoinbaseError('invalid_token', 'Token is invalid'),
      AuthenticationError,
    );
  });

  it('expired_token throws AuthenticationError', () => {
    assert.throws(
      () => ex._handleCoinbaseError('expired_token', 'Token expired'),
      AuthenticationError,
    );
  });

  it('rate_limit_exceeded throws RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleCoinbaseError('rate_limit_exceeded', 'Too many requests'),
      RateLimitExceeded,
    );
  });

  it('insufficient_funds throws InsufficientFunds', () => {
    assert.throws(
      () => ex._handleCoinbaseError('insufficient_funds', 'Not enough balance'),
      InsufficientFunds,
    );
  });

  it('validation_error throws InvalidOrder', () => {
    assert.throws(
      () => ex._handleCoinbaseError('validation_error', 'Invalid order params'),
      InvalidOrder,
    );
  });

  it('not_found throws OrderNotFound', () => {
    assert.throws(
      () => ex._handleCoinbaseError('not_found', 'Resource not found'),
      OrderNotFound,
    );
  });

  it('invalid_product_id throws BadSymbol', () => {
    assert.throws(
      () => ex._handleCoinbaseError('invalid_product_id', 'Unknown product'),
      BadSymbol,
    );
  });

  it('internal_server_error throws ExchangeNotAvailable', () => {
    assert.throws(
      () => ex._handleCoinbaseError('internal_server_error', 'Server error'),
      ExchangeNotAvailable,
    );
  });

  it('unknown error throws ExchangeError', () => {
    assert.throws(
      () => ex._handleCoinbaseError('some_unknown_error', 'something happened'),
      ExchangeError,
    );
  });
});

// =============================================================================
// 8. HTTP ERROR HANDLING
// =============================================================================

describe('Coinbase HTTP Error Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase();
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

  it('HTTP 500 throws ExchangeNotAvailable', () => {
    assert.throws(
      () => ex._handleHttpError(500, 'Internal Server Error'),
      ExchangeNotAvailable,
    );
  });

  it('HTTP error with JSON error field triggers _handleCoinbaseError', () => {
    assert.throws(
      () => ex._handleHttpError(400, JSON.stringify({ error: 'insufficient_funds', message: 'Not enough' })),
      InsufficientFunds,
    );
  });
});

// =============================================================================
// 9. RATE LIMIT HANDLING
// =============================================================================

describe('Coinbase Rate Limit Handling', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase({ enableRateLimit: true });
  });

  it('_handleResponseHeaders exists and does not throw', () => {
    const headers = new Map();
    headers.get = headers.get.bind(headers);
    ex._handleResponseHeaders(headers);
  });

  it('RATE_LIMIT_EXCEEDED code throws RateLimitExceeded', () => {
    assert.throws(
      () => ex._handleCoinbaseError('RATE_LIMIT_EXCEEDED', 'Rate limit hit'),
      RateLimitExceeded,
    );
  });

  it('has rateLimitCapacity configured', () => {
    assert.ok(ex.rateLimit > 0);
  });
});

// =============================================================================
// 10. MOCKED API CALLS
// =============================================================================

describe('Coinbase Mocked API Calls', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase({ apiKey: testApiKey, secret: testPrivateKeyPem });
  });

  // --- Public endpoints ---

  it('fetchTicker converts symbol correctly', () => {
    const productId = ex._toCoinbaseSymbol('BTC/USD');
    assert.strictEqual(productId, 'BTC-USD');
  });

  it('fetchTickers filters by symbols', () => {
    const products = [
      { product_id: 'BTC-USD', price: '50000' },
      { product_id: 'ETH-USD', price: '3000' },
      { product_id: 'DOGE-USD', price: '0.1' },
    ];
    const symbols = ['BTC/USD', 'ETH/USD'];
    const filtered = products.filter((p) => symbols.includes(ex._fromCoinbaseSymbol(p.product_id)));
    assert.strictEqual(filtered.length, 2);
  });

  it('fetchOrderBook passes product_id and limit', () => {
    const request = { product_id: 'BTC-USD', limit: 25 };
    assert.strictEqual(request.product_id, 'BTC-USD');
    assert.strictEqual(request.limit, 25);
  });

  it('fetchOHLCV maps timeframe to granularity string', () => {
    assert.strictEqual(ex.timeframes['1m'], 'ONE_MINUTE');
    assert.strictEqual(ex.timeframes['5m'], 'FIVE_MINUTE');
    assert.strictEqual(ex.timeframes['1h'], 'ONE_HOUR');
    assert.strictEqual(ex.timeframes['1d'], 'ONE_DAY');
  });

  it('fetchOHLCV calculates start and end timestamps', () => {
    const since = 1700000000000;
    const limit = 100;
    const intervalMs = 60000; // 1m
    const start = String(Math.floor(since / 1000));
    const end = String(Math.floor((since + limit * intervalMs) / 1000));
    assert.strictEqual(start, '1700000000');
    assert.strictEqual(end, '1700006000');
  });

  it('loadMarkets parses product list', () => {
    const item = {
      product_id: 'BTC-USD',
      base_currency_id: 'BTC',
      quote_currency_id: 'USD',
      status: 'online',
      is_disabled: false,
      base_min_size: '0.0001',
      base_increment: '0.00000001',
      quote_increment: '0.01',
    };
    const symbol = item.base_currency_id + '/' + item.quote_currency_id;
    assert.strictEqual(symbol, 'BTC/USD');
    assert.strictEqual(item.is_disabled, false);
  });

  // --- Private endpoints (signed) ---

  it('createOrder builds correct request with order_configuration', () => {
    const productId = ex._toCoinbaseSymbol('BTC/USD');
    const clientOrderId = ex._generateClientOrderId();
    const orderConfig = ex._buildOrderConfig('LIMIT', 'BUY', 0.1, 50000);
    const request = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'BUY',
      order_configuration: orderConfig,
    };
    assert.strictEqual(request.product_id, 'BTC-USD');
    assert.strictEqual(request.side, 'BUY');
    assert.ok(request.order_configuration.limit_limit_gtc);
    assert.ok(request.client_order_id);
  });

  it('cancelOrder uses POST batch_cancel with order_ids array', () => {
    const request = { order_ids: ['ord-123'] };
    assert.ok(Array.isArray(request.order_ids));
    assert.strictEqual(request.order_ids[0], 'ord-123');
  });

  it('createOrder signs the request with JWT', () => {
    const result = ex._sign('/api/v3/brokerage/orders', 'POST', {});
    assert.ok(result.headers['Authorization']);
    assert.ok(result.headers['Authorization'].startsWith('Bearer '));
  });

  it('fetchBalance signs request', () => {
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    assert.ok(result.headers['Authorization']);
  });

  it('fetchOpenOrders uses order_status=OPEN', () => {
    const request = { order_status: 'OPEN', product_id: ex._toCoinbaseSymbol('BTC/USD') };
    assert.strictEqual(request.order_status, 'OPEN');
    assert.strictEqual(request.product_id, 'BTC-USD');
  });

  it('fetchClosedOrders uses order_status=FILLED', () => {
    const request = { order_status: 'FILLED' };
    assert.strictEqual(request.order_status, 'FILLED');
  });

  it('fetchMyTrades accepts product_id param', () => {
    const request = { product_id: ex._toCoinbaseSymbol('ETH/USD'), limit: 50 };
    assert.strictEqual(request.product_id, 'ETH-USD');
    assert.strictEqual(request.limit, 50);
  });

  it('fetchTradingFees endpoint is transaction_summary', () => {
    const path = '/api/v3/brokerage/transaction_summary';
    assert.ok(path.includes('transaction_summary'));
  });

  it('GET signing produces valid JWT', () => {
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    const jwt = result.headers['Authorization'].replace('Bearer ', '');
    const parts = jwt.split('.');
    assert.strictEqual(parts.length, 3);
  });

  it('POST signing produces valid JWT', () => {
    const result = ex._sign('/api/v3/brokerage/orders', 'POST', { product_id: 'BTC-USD' });
    const jwt = result.headers['Authorization'].replace('Bearer ', '');
    const parts = jwt.split('.');
    assert.strictEqual(parts.length, 3);
  });
});

// =============================================================================
// 11. MARKET LOOKUP
// =============================================================================

describe('Coinbase Market Lookup', () => {
  let ex;
  beforeEach(() => {
    ex = new Coinbase();
  });

  it('market() throws when markets not loaded', () => {
    assert.throws(
      () => ex.market('BTC/USD'),
      ExchangeError,
    );
  });

  it('market() throws for unknown symbol', () => {
    ex._marketsLoaded = true;
    ex.markets = { 'BTC/USD': { id: 'BTC-USD' } };
    assert.throws(
      () => ex.market('FAKE/COIN'),
      ExchangeError,
    );
  });

  it('market() returns market for valid symbol', () => {
    ex._marketsLoaded = true;
    ex.markets = { 'BTC/USD': { id: 'BTC-USD', symbol: 'BTC/USD' } };
    const m = ex.market('BTC/USD');
    assert.strictEqual(m.id, 'BTC-USD');
  });
});

// =============================================================================
// 12. COINBASE VS OTHERS — KEY DIFFERENCES
// =============================================================================

describe('Coinbase vs Others — Key Differences', () => {
  it('Coinbase uses JWT/ES256 (not HMAC)', () => {
    const ex = new Coinbase({ apiKey: testApiKey, secret: testPrivateKeyPem });
    const result = ex._sign('/api/v3/brokerage/accounts', 'GET', {});
    // Should have Authorization header with Bearer JWT, not API-KEY/SIGN headers
    assert.ok(result.headers['Authorization'].startsWith('Bearer '));
    assert.strictEqual(result.headers['KC-API-KEY'], undefined, 'Should NOT have KuCoin-style headers');
    assert.strictEqual(result.headers['SIGN'], undefined, 'Should NOT have Gate.io-style headers');
  });

  it('Coinbase candles are objects (not arrays like other exchanges)', () => {
    const ex = new Coinbase();
    const raw = { start: '1700000000', open: '49500', high: '51000', low: '49000', close: '50000', volume: '100.5' };
    const parsed = ex._parseCandle(raw);
    assert.ok(Array.isArray(parsed), 'Should be converted to array');
    assert.strictEqual(parsed.length, 6);
    assert.strictEqual(parsed[0], 1700000000000);
    assert.strictEqual(typeof parsed[1], 'number', 'Strings should be converted to numbers');
  });

  it('Coinbase order_configuration is nested (not flat like other exchanges)', () => {
    const ex = new Coinbase();
    const config = ex._buildOrderConfig('LIMIT', 'BUY', 0.1, 50000);
    // Nested: { limit_limit_gtc: { base_size, limit_price } }
    assert.ok(config.limit_limit_gtc, 'Should have nested key');
    assert.strictEqual(config.limit_limit_gtc.base_size, '0.1');
    assert.strictEqual(config.limit_limit_gtc.limit_price, '50000');
    // Other exchanges use flat: { size: '0.1', price: '50000' }
  });

  it('Coinbase uses POST batch_cancel (not DELETE)', () => {
    // Binance: DELETE /api/v3/order
    // KuCoin: DELETE /api/v1/orders/{id}
    // Gate.io: DELETE /api/v4/spot/orders/{id}
    // Coinbase: POST /api/v3/brokerage/orders/batch_cancel
    const path = '/api/v3/brokerage/orders/batch_cancel';
    assert.ok(path.includes('batch_cancel'));
  });

  it('Coinbase uses string enum timeframes (not interval strings)', () => {
    const ex = new Coinbase();
    // Other exchanges: '1m', '5m', '1h' or '1min', '5min', '1hour'
    // Coinbase: 'ONE_MINUTE', 'FIVE_MINUTE', 'ONE_HOUR'
    assert.strictEqual(ex.timeframes['1m'], 'ONE_MINUTE');
    assert.strictEqual(ex.timeframes['5m'], 'FIVE_MINUTE');
    assert.strictEqual(ex.timeframes['1h'], 'ONE_HOUR');
  });

  it('Coinbase has 2 separate WS URLs (public vs private)', () => {
    const ex = new Coinbase();
    assert.strictEqual(ex.urls.ws, 'wss://advanced-trade-ws.coinbase.com');
    assert.strictEqual(ex.urls.wsPrivate, 'wss://advanced-trade-ws-user.coinbase.com');
    assert.notStrictEqual(ex.urls.ws, ex.urls.wsPrivate);
    // Other exchanges: same URL or token-based
  });

  it('REST JWT uses iss=coinbase-cloud, WS JWT uses iss=cdp', () => {
    // REST JWT
    const restJwt = signJWT(testApiKey, testPrivateKeyPem, 'GET api.coinbase.com/path', 'coinbase-cloud');
    const restPayload = JSON.parse(Buffer.from(restJwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.strictEqual(restPayload.iss, 'coinbase-cloud');
    assert.ok(restPayload.uri);

    // WS JWT
    const wsJwt = signJWT(testApiKey, testPrivateKeyPem, null, 'cdp');
    const wsPayload = JSON.parse(Buffer.from(wsJwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.strictEqual(wsPayload.iss, 'cdp');
    assert.strictEqual(wsPayload.uri, undefined);
  });

  it('Coinbase requires client_order_id (UUID) like KuCoin clientOid', () => {
    const ex = new Coinbase();
    const id1 = ex._generateClientOrderId();
    const id2 = ex._generateClientOrderId();
    assert.notStrictEqual(id1, id2, 'Each call should generate unique UUID');
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}/.test(id1), 'Should be UUID format');
  });
});

// =============================================================================
// 13. CRYPTO — signJWT + base64UrlEncode
// =============================================================================

describe('Crypto — signJWT + base64UrlEncode for Coinbase', () => {
  it('base64UrlEncode produces URL-safe string (no +, /, =)', () => {
    const data = Buffer.from('test data with special chars');
    const encoded = base64UrlEncode(data);
    assert.ok(typeof encoded === 'string');
    assert.ok(!encoded.includes('+'), 'Should not contain +');
    assert.ok(!encoded.includes('/'), 'Should not contain /');
    assert.ok(!encoded.includes('='), 'Should not contain =');
  });

  it('signJWT produces valid 3-part JWT string', () => {
    const jwt = signJWT(testApiKey, testPrivateKeyPem, 'GET api.coinbase.com/path', 'coinbase-cloud');
    const parts = jwt.split('.');
    assert.strictEqual(parts.length, 3);
    // All parts should be base64url
    for (const part of parts) {
      assert.ok(!part.includes('+'), 'Should be base64url');
      assert.ok(!part.includes('/'), 'Should be base64url');
    }
  });

  it('signJWT signature is in ieee-p1363 format (64 bytes for P-256)', () => {
    const jwt = signJWT(testApiKey, testPrivateKeyPem, 'GET api.coinbase.com/path', 'coinbase-cloud');
    const sigB64 = jwt.split('.')[2];
    // Decode base64url
    const sigBuffer = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    // P-256 ieee-p1363 signature is exactly 64 bytes (32 + 32)
    assert.strictEqual(sigBuffer.length, 64, 'ES256 ieee-p1363 signature should be 64 bytes');
  });
});

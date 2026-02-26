'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ygcc = require('../index');
const { Okx, hmacSHA256, hmacSHA256Base64 } = ygcc;
const {
  ExchangeError, AuthenticationError, RateLimitExceeded,
  InsufficientFunds, InvalidOrder, OrderNotFound,
  BadSymbol, BadRequest, ExchangeNotAvailable,
} = ygcc;

// =============================================================================
// 1. MODULE EXPORTS
// =============================================================================

describe('Module Exports — OKX', () => {
  it('exports Okx class and lowercase alias', () => {
    assert.strictEqual(typeof Okx, 'function');
    assert.strictEqual(ygcc.okx, Okx);
    assert.strictEqual(ygcc.Okx, Okx);
  });

  it('exchange list includes okx', () => {
    assert.ok(ygcc.exchanges.includes('okx'));
  });

  it('version is 1.9.0', () => {
    assert.strictEqual(ygcc.version, '1.9.0');
  });
});

// =============================================================================
// 2. OKX CONSTRUCTOR
// =============================================================================

describe('OKX Constructor', () => {
  let ex;
  beforeEach(() => {
    ex = new Okx();
  });

  it('creates instance with correct id, name, version', () => {
    assert.strictEqual(ex.id, 'okx');
    assert.strictEqual(ex.name, 'OKX');
    assert.strictEqual(ex.version, 'v5');
  });

  it('sets postAsJson to true', () => {
    assert.strictEqual(ex.postAsJson, true);
  });

  it('accepts custom config', () => {
    const custom = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p', timeout: 5000 });
    assert.strictEqual(custom.apiKey, 'k');
    assert.strictEqual(custom.secret, 's');
    assert.strictEqual(custom.passphrase, 'p');
    assert.strictEqual(custom.timeout, 5000);
  });

  it('has correct URLs', () => {
    assert.strictEqual(ex.urls.api, 'https://www.okx.com');
    assert.strictEqual(ex.urls.ws, 'wss://ws.okx.com:8443/ws/v5/public');
    assert.strictEqual(ex.urls.wsPrivate, 'wss://ws.okx.com:8443/ws/v5/private');
    assert.strictEqual(ex.urls.wsBusiness, 'wss://ws.okx.com:8443/ws/v5/business');
  });

  it('enables simulated trading mode with sandbox option', () => {
    const sim = new Okx({ options: { sandbox: true } });
    assert.strictEqual(sim._simulated, true);
    assert.ok(sim.urls.ws.includes('wspap.okx.com'));
    assert.ok(sim.urls.wsPrivate.includes('wspap.okx.com'));
  });

  it('has all capability flags', () => {
    const caps = [
      'loadMarkets', 'fetchTicker', 'fetchTickers', 'fetchOrderBook',
      'fetchTrades', 'fetchOHLCV', 'fetchTime', 'createOrder',
      'createLimitOrder', 'createMarketOrder', 'cancelOrder',
      'cancelAllOrders', 'amendOrder', 'fetchOrder', 'fetchOpenOrders',
      'fetchClosedOrders', 'fetchMyTrades', 'fetchBalance', 'fetchTradingFees',
      'watchTicker', 'watchOrderBook', 'watchTrades', 'watchKlines',
      'watchBalance', 'watchOrders',
    ];
    for (const c of caps) {
      assert.strictEqual(ex.has[c], true, `missing capability: ${c}`);
    }
  });

  it('has timeframes mapping with correct OKX format', () => {
    assert.strictEqual(ex.timeframes['1m'], '1m');
    assert.strictEqual(ex.timeframes['1h'], '1H');
    assert.strictEqual(ex.timeframes['4h'], '4H');
    assert.strictEqual(ex.timeframes['1d'], '1D');
    assert.strictEqual(ex.timeframes['1w'], '1W');
    assert.strictEqual(ex.timeframes['3M'], '3M');
  });

  it('has fee structure', () => {
    assert.strictEqual(ex.fees.trading.maker, 0.001);
    assert.strictEqual(ex.fees.trading.taker, 0.0015);
  });

  it('sets default instType to SPOT', () => {
    assert.strictEqual(ex._defaultInstType, 'SPOT');
  });

  it('allows custom instType', () => {
    const swap = new Okx({ options: { instType: 'SWAP' } });
    assert.strictEqual(swap._defaultInstType, 'SWAP');
  });

  it('sets default tdMode to cash', () => {
    assert.strictEqual(ex._defaultTdMode, 'cash');
  });

  it('stores passphrase from config', () => {
    const withPass = new Okx({ passphrase: 'mypass' });
    assert.strictEqual(withPass.passphrase, 'mypass');
  });
});

// =============================================================================
// 3. AUTHENTICATION — _sign()
// =============================================================================

describe('OKX Authentication', () => {
  let ex;
  beforeEach(() => {
    ex = new Okx({ apiKey: 'testkey', secret: 'testsecret', passphrase: 'testpass' });
  });

  it('produces Base64 signature (not hex)', () => {
    const result = ex._sign('/api/v5/trade/order', 'POST', { instId: 'BTC-USDT' });
    const sig = result.headers['OK-ACCESS-SIGN'];
    // Base64 chars: A-Z, a-z, 0-9, +, /, =
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(sig), 'signature should be Base64');
    // SHA256 = 32 bytes → Base64 = 44 chars
    assert.strictEqual(sig.length, 44);
  });

  it('signature is NOT hex (not 64 chars)', () => {
    const result = ex._sign('/api/v5/trade/order', 'POST', { instId: 'BTC-USDT' });
    const sig = result.headers['OK-ACCESS-SIGN'];
    assert.notStrictEqual(sig.length, 64, 'should not be 64-char hex');
  });

  it('uses ISO 8601 timestamp in headers', () => {
    const result = ex._sign('/api/v5/trade/order', 'POST', {});
    const ts = result.headers['OK-ACCESS-TIMESTAMP'];
    // ISO format: 2024-01-15T10:30:00.000Z
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(ts), 'timestamp should be ISO 8601');
  });

  it('includes OK-ACCESS-PASSPHRASE header', () => {
    const result = ex._sign('/api/v5/trade/order', 'POST', {});
    assert.strictEqual(result.headers['OK-ACCESS-PASSPHRASE'], 'testpass');
  });

  it('includes OK-ACCESS-KEY header', () => {
    const result = ex._sign('/api/v5/trade/order', 'POST', {});
    assert.strictEqual(result.headers['OK-ACCESS-KEY'], 'testkey');
  });

  it('returns params unchanged', () => {
    const params = { instId: 'BTC-USDT', sz: '0.001' };
    const result = ex._sign('/api/v5/trade/order', 'POST', params);
    assert.deepStrictEqual(result.params, params);
  });

  it('throws without apiKey', () => {
    const noKey = new Okx({ secret: 's', passphrase: 'p' });
    assert.throws(() => noKey._sign('/test', 'GET', {}), /apiKey required/);
  });

  it('throws without passphrase', () => {
    const noPass = new Okx({ apiKey: 'k', secret: 's' });
    assert.throws(() => noPass._sign('/test', 'GET', {}), /passphrase required/);
  });

  it('adds x-simulated-trading header in sandbox mode', () => {
    const sim = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p', options: { sandbox: true } });
    const result = sim._sign('/api/v5/trade/order', 'POST', {});
    assert.strictEqual(result.headers['x-simulated-trading'], '1');
  });
});

// =============================================================================
// 4. RESPONSE UNWRAPPING
// =============================================================================

describe('OKX Response Unwrapping', () => {
  let ex;
  beforeEach(() => { ex = new Okx(); });

  it('unwraps successful response (code string "0")', () => {
    const data = { code: '0', msg: '', data: [{ instId: 'BTC-USDT' }] };
    const result = ex._unwrapResponse(data);
    assert.deepStrictEqual(result, [{ instId: 'BTC-USDT' }]);
  });

  it('throws on non-zero code string', () => {
    const data = { code: '51001', msg: 'Insufficient balance' };
    assert.throws(() => ex._unwrapResponse(data), InsufficientFunds);
  });

  it('returns data as-is if no code field', () => {
    const data = { foo: 'bar' };
    assert.deepStrictEqual(ex._unwrapResponse(data), { foo: 'bar' });
  });

  it('returns non-object data as-is', () => {
    assert.strictEqual(ex._unwrapResponse('text'), 'text');
    assert.strictEqual(ex._unwrapResponse(null), null);
  });
});

// =============================================================================
// 5. PARSERS
// =============================================================================

describe('OKX Parsers', () => {
  let ex;
  beforeEach(() => { ex = new Okx(); });

  it('_parseTicker: parses OKX ticker fields', () => {
    const data = {
      instId: 'BTC-USDT',
      last: '65000.5',
      bidPx: '64999.0',
      bidSz: '1.5',
      askPx: '65001.0',
      askSz: '2.0',
      high24h: '66000.0',
      low24h: '63000.0',
      open24h: '64000.0',
      vol24h: '12345.67',
      volCcy24h: '800000000',
      ts: '1700000000000',
    };
    const t = ex._parseTicker(data);
    assert.strictEqual(t.symbol, 'BTC-USDT');
    assert.strictEqual(t.last, 65000.5);
    assert.strictEqual(t.bid, 64999.0);
    assert.strictEqual(t.ask, 65001.0);
    assert.strictEqual(t.high, 66000.0);
    assert.strictEqual(t.low, 63000.0);
    assert.strictEqual(t.open, 64000.0);
    assert.strictEqual(t.volume, 12345.67);
    assert.strictEqual(t.timestamp, 1700000000000);
  });

  it('_parseTicker: computes change and percentage', () => {
    const data = { last: '110', open24h: '100', ts: '1700000000000' };
    const t = ex._parseTicker(data);
    assert.strictEqual(t.change, 10);
    assert.strictEqual(t.percentage, 10);
  });

  it('_parseOrder: parses OKX order fields', () => {
    const data = {
      ordId: '123456',
      clOrdId: 'my-order-1',
      instId: 'ETH-USDT',
      ordType: 'limit',
      side: 'buy',
      px: '3500.00',
      sz: '2.0',
      accFillSz: '1.0',
      avgPx: '3490.00',
      state: 'partially_filled',
      cTime: '1700000000000',
      fee: '-0.5',
      feeCcy: 'USDT',
    };
    const o = ex._parseOrder(data);
    assert.strictEqual(o.id, '123456');
    assert.strictEqual(o.clientOrderId, 'my-order-1');
    assert.strictEqual(o.symbol, 'ETH-USDT');
    assert.strictEqual(o.type, 'LIMIT');
    assert.strictEqual(o.side, 'BUY');
    assert.strictEqual(o.price, 3500.00);
    assert.strictEqual(o.amount, 2.0);
    assert.strictEqual(o.filled, 1.0);
    assert.strictEqual(o.remaining, 1.0);
    assert.strictEqual(o.average, 3490.00);
    assert.strictEqual(o.status, 'PARTIALLY_FILLED');
  });

  it('_parseOrder: normalizes side/type to UPPERCASE', () => {
    const data = { ordType: 'market', side: 'sell', state: 'filled' };
    const o = ex._parseOrder(data);
    assert.strictEqual(o.type, 'MARKET');
    assert.strictEqual(o.side, 'SELL');
  });

  it('_parseOrder: handles filled order', () => {
    const data = { state: 'filled', sz: '5', accFillSz: '5', avgPx: '100' };
    const o = ex._parseOrder(data);
    assert.strictEqual(o.status, 'FILLED');
    assert.strictEqual(o.remaining, 0);
  });

  it('_parseOrder: handles canceled order', () => {
    const data = { state: 'canceled' };
    const o = ex._parseOrder(data);
    assert.strictEqual(o.status, 'CANCELED');
  });

  it('_parseOrderCreateResult: parses create result', () => {
    const data = { ordId: '789', clOrdId: 'c1', sCode: '0', sMsg: '' };
    const r = ex._parseOrderCreateResult(data);
    assert.strictEqual(r.id, '789');
    assert.strictEqual(r.clientOrderId, 'c1');
    assert.strictEqual(r.status, 'NEW');
  });

  it('_parseTrade: parses public trade', () => {
    const data = { tradeId: 't1', px: '50000', sz: '0.1', side: 'buy', ts: '1700000000000' };
    const t = ex._parseTrade(data, 'BTC-USDT');
    assert.strictEqual(t.id, 't1');
    assert.strictEqual(t.symbol, 'BTC-USDT');
    assert.strictEqual(t.price, 50000);
    assert.strictEqual(t.amount, 0.1);
    assert.strictEqual(t.cost, 5000);
    assert.strictEqual(t.side, 'buy');
  });

  it('_parseMyTrade: parses private fill', () => {
    const data = {
      tradeId: 'mt1', ordId: 'o1', instId: 'BTC-USDT',
      fillPx: '50000', fillSz: '0.5', side: 'sell',
      fee: '-2.5', feeCcy: 'USDT', ts: '1700000000000',
      execType: 'M',
    };
    const t = ex._parseMyTrade(data);
    assert.strictEqual(t.id, 'mt1');
    assert.strictEqual(t.orderId, 'o1');
    assert.strictEqual(t.price, 50000);
    assert.strictEqual(t.amount, 0.5);
    assert.strictEqual(t.cost, 25000);
    assert.strictEqual(t.fee.cost, -2.5);
    assert.strictEqual(t.fee.currency, 'USDT');
    assert.strictEqual(t.isMaker, true);
  });
});

// =============================================================================
// 6. HELPER METHODS
// =============================================================================

describe('OKX Helper Methods', () => {
  let ex;
  beforeEach(() => { ex = new Okx(); });

  it('_normalizeStatus: maps OKX statuses correctly', () => {
    assert.strictEqual(ex._normalizeStatus('live'), 'NEW');
    assert.strictEqual(ex._normalizeStatus('partially_filled'), 'PARTIALLY_FILLED');
    assert.strictEqual(ex._normalizeStatus('filled'), 'FILLED');
    assert.strictEqual(ex._normalizeStatus('canceled'), 'CANCELED');
    assert.strictEqual(ex._normalizeStatus('mmp_canceled'), 'CANCELED');
  });

  it('_countDecimals: counts correctly', () => {
    assert.strictEqual(ex._countDecimals('0.01'), 2);
    assert.strictEqual(ex._countDecimals('0.00001'), 5);
    assert.strictEqual(ex._countDecimals('1'), 0);
    assert.strictEqual(ex._countDecimals(null), 8);
  });

  it('checkRequiredCredentials: validates all 3 credentials', () => {
    const noKey = new Okx({ secret: 's', passphrase: 'p' });
    assert.throws(() => noKey.checkRequiredCredentials(), /apiKey required/);

    const noSecret = new Okx({ apiKey: 'k', passphrase: 'p' });
    assert.throws(() => noSecret.checkRequiredCredentials(), /secret required/);

    const noPass = new Okx({ apiKey: 'k', secret: 's' });
    assert.throws(() => noPass.checkRequiredCredentials(), /passphrase required/);
  });

  it('checkRequiredCredentials: passes with all 3', () => {
    const valid = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p' });
    assert.doesNotThrow(() => valid.checkRequiredCredentials());
  });
});

// =============================================================================
// 7. ERROR MAPPING — _handleOkxError()
// =============================================================================

describe('OKX Error Mapping', () => {
  let ex;
  beforeEach(() => { ex = new Okx(); });

  it('maps 50104 to AuthenticationError (invalid signature)', () => {
    assert.throws(() => ex._handleOkxError('50104', 'Invalid signature'), AuthenticationError);
  });

  it('maps 50105 to AuthenticationError (passphrase mismatch)', () => {
    assert.throws(() => ex._handleOkxError('50105', 'Passphrase mismatch'), AuthenticationError);
  });

  it('maps 50103 to AuthenticationError (API key blank)', () => {
    assert.throws(() => ex._handleOkxError('50103', 'Key blank'), AuthenticationError);
  });

  it('maps 50011 to RateLimitExceeded', () => {
    assert.throws(() => ex._handleOkxError('50011', 'Rate limit'), RateLimitExceeded);
  });

  it('maps 50013 to RateLimitExceeded (system busy)', () => {
    assert.throws(() => ex._handleOkxError('50013', 'System busy'), RateLimitExceeded);
  });

  it('maps 50000 to BadRequest (body empty)', () => {
    assert.throws(() => ex._handleOkxError('50000', 'Body empty'), BadRequest);
  });

  it('maps 50001 to ExchangeNotAvailable', () => {
    assert.throws(() => ex._handleOkxError('50001', 'Unavailable'), ExchangeNotAvailable);
  });

  it('maps 51001 to InsufficientFunds', () => {
    assert.throws(() => ex._handleOkxError('51001', 'Insufficient'), InsufficientFunds);
  });

  it('maps 51006 to OrderNotFound', () => {
    assert.throws(() => ex._handleOkxError('51006', 'Not found'), OrderNotFound);
  });

  it('maps 51020 to OrderNotFound', () => {
    assert.throws(() => ex._handleOkxError('51020', 'Order doesnt exist'), OrderNotFound);
  });

  it('maps 51400 to InvalidOrder (cancel failed)', () => {
    assert.throws(() => ex._handleOkxError('51400', 'Cancel failed'), InvalidOrder);
  });

  it('falls back to ExchangeError for unknown codes', () => {
    assert.throws(() => ex._handleOkxError('99999', 'Unknown'), ExchangeError);
  });
});

// =============================================================================
// 8. HTTP ERROR HANDLING
// =============================================================================

describe('OKX HTTP Error Handling', () => {
  let ex;
  beforeEach(() => { ex = new Okx(); });

  it('handles 401 as AuthenticationError', () => {
    assert.throws(() => ex._handleHttpError(401, 'Unauthorized'), AuthenticationError);
  });

  it('handles 403 as AuthenticationError', () => {
    assert.throws(() => ex._handleHttpError(403, 'Forbidden'), AuthenticationError);
  });

  it('handles 429 as RateLimitExceeded', () => {
    assert.throws(() => ex._handleHttpError(429, 'Too Many Requests'), RateLimitExceeded);
  });

  it('handles JSON body with OKX error code', () => {
    const body = JSON.stringify({ code: '51001', msg: 'Insufficient balance' });
    assert.throws(() => ex._handleHttpError(400, body), InsufficientFunds);
  });

  it('handles non-JSON body', () => {
    assert.throws(() => ex._handleHttpError(500, 'Internal Error'), ExchangeError);
  });
});

// =============================================================================
// 9. RATE LIMIT HEADER HANDLING
// =============================================================================

describe('OKX Rate Limit Header Handling', () => {
  it('emits rateLimitWarning when remaining < 20%', () => {
    const ex = new Okx();
    let warned = false;
    ex.on('rateLimitWarning', () => { warned = true; });

    const headers = new Map();
    headers.set('x-ratelimit-limit', '60');
    headers.set('x-ratelimit-remaining', '5');
    ex._handleResponseHeaders(headers);

    assert.strictEqual(warned, true);
  });

  it('does NOT emit warning when remaining > 20%', () => {
    const ex = new Okx();
    let warned = false;
    ex.on('rateLimitWarning', () => { warned = true; });

    const headers = new Map();
    headers.set('x-ratelimit-limit', '60');
    headers.set('x-ratelimit-remaining', '50');
    ex._handleResponseHeaders(headers);

    assert.strictEqual(warned, false);
  });

  it('handles missing rate limit headers gracefully', () => {
    const ex = new Okx();
    const headers = new Map();
    assert.doesNotThrow(() => ex._handleResponseHeaders(headers));
  });
});

// =============================================================================
// 10. MOCKED API CALLS
// =============================================================================

describe('OKX API Methods (mocked)', () => {
  let ex;
  let lastRequest;

  beforeEach(() => {
    ex = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p' });
    ex._request = async (method, path, params, signed, weight) => {
      lastRequest = { method, path, params, signed, weight };
      return { code: '0', msg: '', data: [] };
    };
  });

  // fetchTime
  it('fetchTime: calls /api/v5/public/time', async () => {
    ex._request = async () => ({ code: '0', msg: '', data: [{ ts: '1700000000000' }] });
    const time = await ex.fetchTime();
    assert.strictEqual(time, 1700000000000);
  });

  // loadMarkets
  it('loadMarkets: parses instruments into unified format', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [
        {
          instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT',
          state: 'live', instType: 'SPOT', tickSz: '0.1', lotSz: '0.00001', minSz: '0.00001',
        },
      ],
    });
    const markets = await ex.loadMarkets();
    assert.ok(markets['BTC-USDT']);
    assert.strictEqual(markets['BTC-USDT'].base, 'BTC');
    assert.strictEqual(markets['BTC-USDT'].quote, 'USDT');
    assert.strictEqual(markets['BTC-USDT'].active, true);
    assert.strictEqual(markets['BTC-USDT'].precision.price, 1);
    assert.strictEqual(markets['BTC-USDT'].precision.amount, 5);
  });

  it('loadMarkets: returns cached on second call', async () => {
    let callCount = 0;
    ex._request = async () => {
      callCount++;
      return { code: '0', msg: '', data: [{ instId: 'BTC-USDT', state: 'live' }] };
    };
    await ex.loadMarkets();
    await ex.loadMarkets();
    assert.strictEqual(callCount, 1);
  });

  it('loadMarkets: reloads when forced', async () => {
    let callCount = 0;
    ex._request = async () => {
      callCount++;
      return { code: '0', msg: '', data: [{ instId: 'BTC-USDT', state: 'live' }] };
    };
    await ex.loadMarkets();
    await ex.loadMarkets(true);
    assert.strictEqual(callCount, 2);
  });

  // fetchTicker
  it('fetchTicker: calls /api/v5/market/ticker with instId', async () => {
    ex._request = async (m, p, params) => {
      lastRequest = { params };
      return { code: '0', msg: '', data: [{ instId: 'BTC-USDT', last: '50000', ts: '1700000000000' }] };
    };
    const ticker = await ex.fetchTicker('BTC-USDT');
    assert.strictEqual(lastRequest.params.instId, 'BTC-USDT');
    assert.strictEqual(ticker.last, 50000);
  });

  it('fetchTicker: throws BadSymbol when not found', async () => {
    ex._request = async () => ({ code: '0', msg: '', data: [] });
    await assert.rejects(() => ex.fetchTicker('FAKE-COIN'), BadSymbol);
  });

  // fetchOrderBook
  it('fetchOrderBook: returns unified book', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [{
        bids: [['49999', '1.5', '0', '3'], ['49998', '2.0', '0', '5']],
        asks: [['50001', '0.8', '0', '2']],
        ts: '1700000000000',
      }],
    });
    const book = await ex.fetchOrderBook('BTC-USDT');
    assert.strictEqual(book.bids[0][0], 49999);
    assert.strictEqual(book.bids[0][1], 1.5);
    assert.strictEqual(book.asks[0][0], 50001);
    assert.strictEqual(book.asks[0][1], 0.8);
  });

  // fetchOHLCV
  it('fetchOHLCV: returns candles reversed to chronological', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [
        ['1700000200000', '50100', '50200', '50000', '50150', '100'],
        ['1700000100000', '50000', '50100', '49900', '50050', '90'],
      ],
    });
    const candles = await ex.fetchOHLCV('BTC-USDT', '1h');
    assert.strictEqual(candles[0][0], 1700000100000); // older first
    assert.strictEqual(candles[1][0], 1700000200000);
    assert.strictEqual(candles[0][1], 50000); // open
  });

  // fetchTrades
  it('fetchTrades: returns parsed public trades', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [
        { tradeId: 't1', px: '50000', sz: '0.1', side: 'buy', ts: '1700000000000' },
      ],
    });
    const trades = await ex.fetchTrades('BTC-USDT');
    assert.strictEqual(trades[0].id, 't1');
    assert.strictEqual(trades[0].price, 50000);
    assert.strictEqual(trades[0].side, 'buy');
  });

  // createOrder
  it('createOrder: sends correct params with lowercase side/type', async () => {
    ex._request = async (m, p, params) => {
      lastRequest = { method: m, path: p, params };
      return { code: '0', msg: '', data: [{ ordId: '999', clOrdId: '' }] };
    };
    await ex.createOrder('BTC-USDT', 'limit', 'buy', 0.001, 50000);
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.path, '/api/v5/trade/order');
    assert.strictEqual(lastRequest.params.instId, 'BTC-USDT');
    assert.strictEqual(lastRequest.params.side, 'buy');
    assert.strictEqual(lastRequest.params.ordType, 'limit');
    assert.strictEqual(lastRequest.params.sz, '0.001');
    assert.strictEqual(lastRequest.params.px, '50000');
    assert.strictEqual(lastRequest.params.tdMode, 'cash');
  });

  it('createOrder: market order has no px', async () => {
    ex._request = async (m, p, params) => {
      lastRequest = { params };
      return { code: '0', msg: '', data: [{ ordId: '888' }] };
    };
    await ex.createOrder('BTC-USDT', 'market', 'sell', 0.5);
    assert.strictEqual(lastRequest.params.ordType, 'market');
    assert.strictEqual(lastRequest.params.px, undefined);
  });

  // cancelOrder
  it('cancelOrder: sends POST with instId + ordId', async () => {
    ex._request = async (m, p, params) => {
      lastRequest = { method: m, params };
      return { code: '0', msg: '', data: [{ ordId: '123' }] };
    };
    const result = await ex.cancelOrder('123', 'BTC-USDT');
    assert.strictEqual(lastRequest.method, 'POST');
    assert.strictEqual(lastRequest.params.instId, 'BTC-USDT');
    assert.strictEqual(lastRequest.params.ordId, '123');
    assert.strictEqual(result.status, 'CANCELED');
  });

  it('cancelOrder: throws without symbol', async () => {
    await assert.rejects(() => ex.cancelOrder('123'), BadRequest);
  });

  // fetchOrder
  it('fetchOrder: returns parsed order', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [{
        ordId: '456', instId: 'ETH-USDT', ordType: 'limit', side: 'buy',
        px: '3000', sz: '1', accFillSz: '0', avgPx: '0', state: 'live', cTime: '1700000000000',
      }],
    });
    const order = await ex.fetchOrder('456', 'ETH-USDT');
    assert.strictEqual(order.id, '456');
    assert.strictEqual(order.status, 'NEW');
  });

  it('fetchOrder: throws OrderNotFound when empty', async () => {
    ex._request = async () => ({ code: '0', msg: '', data: [] });
    await assert.rejects(() => ex.fetchOrder('999', 'BTC-USDT'), OrderNotFound);
  });

  // fetchBalance
  it('fetchBalance: returns unified balance from details', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [{
        details: [
          { ccy: 'USDT', availBal: '1000', frozenBal: '200', eq: '1200' },
          { ccy: 'BTC', availBal: '0.5', frozenBal: '0', eq: '0.5' },
          { ccy: 'DOGE', availBal: '0', frozenBal: '0', eq: '0' },
        ],
      }],
    });
    const balance = await ex.fetchBalance();
    assert.strictEqual(balance.USDT.free, 1000);
    assert.strictEqual(balance.USDT.used, 200);
    assert.strictEqual(balance.USDT.total, 1200);
    assert.strictEqual(balance.BTC.free, 0.5);
    assert.strictEqual(balance.DOGE, undefined); // zero balance excluded
  });

  // fetchTradingFees
  it('fetchTradingFees: returns maker/taker fees', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [{ instId: 'BTC-USDT', maker: '-0.001', taker: '-0.0015' }],
    });
    const fees = await ex.fetchTradingFees('BTC-USDT');
    assert.strictEqual(fees.maker, -0.001);
    assert.strictEqual(fees.taker, -0.0015);
  });

  // fetchOpenOrders
  it('fetchOpenOrders: returns array of open orders', async () => {
    ex._request = async () => ({
      code: '0', msg: '', data: [
        { ordId: '1', instId: 'BTC-USDT', state: 'live', ordType: 'limit', side: 'buy' },
        { ordId: '2', instId: 'BTC-USDT', state: 'live', ordType: 'limit', side: 'sell' },
      ],
    });
    const orders = await ex.fetchOpenOrders('BTC-USDT');
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].id, '1');
    assert.strictEqual(orders[1].id, '2');
  });
});

// =============================================================================
// 11. MARKET LOOKUP
// =============================================================================

describe('OKX market() lookup', () => {
  it('throws if markets not loaded', () => {
    const ex = new Okx();
    assert.throws(() => ex.market('BTC-USDT'), /markets not loaded/);
  });

  it('throws for unknown symbol', async () => {
    const ex = new Okx();
    ex._request = async () => ({ code: '0', msg: '', data: [{ instId: 'BTC-USDT', state: 'live' }] });
    await ex.loadMarkets();
    assert.throws(() => ex.market('FAKE-COIN'), /unknown symbol/);
  });

  it('returns market for valid symbol (BTC-USDT format)', async () => {
    const ex = new Okx();
    ex._request = async () => ({
      code: '0', msg: '', data: [{ instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live' }],
    });
    await ex.loadMarkets();
    const m = ex.market('BTC-USDT');
    assert.strictEqual(m.symbol, 'BTC-USDT');
    assert.strictEqual(m.base, 'BTC');
  });
});

// =============================================================================
// 12. OKX vs BINANCE/BYBIT — KEY DIFFERENCES
// =============================================================================

describe('OKX vs Binance/Bybit — Key Differences', () => {
  it('OKX uses JSON POST body (postAsJson=true)', () => {
    const okx = new Okx();
    assert.strictEqual(okx.postAsJson, true);
  });

  it('OKX cancel uses POST (not DELETE)', async () => {
    const okx = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p' });
    let method;
    okx._request = async (m) => {
      method = m;
      return { code: '0', msg: '', data: [{ ordId: '1' }] };
    };
    await okx.cancelOrder('1', 'BTC-USDT');
    assert.strictEqual(method, 'POST');
  });

  it('OKX uses lowercase side/type', async () => {
    const okx = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p' });
    let params;
    okx._request = async (m, p, prm) => {
      params = prm;
      return { code: '0', msg: '', data: [{ ordId: '1' }] };
    };
    await okx.createOrder('BTC-USDT', 'LIMIT', 'BUY', 1, 50000);
    assert.strictEqual(params.side, 'buy');
    assert.strictEqual(params.ordType, 'limit');
  });

  it('OKX requires passphrase (3rd credential)', () => {
    const okx = new Okx({ apiKey: 'k', secret: 's' });
    assert.throws(() => okx.checkRequiredCredentials(), /passphrase required/);
  });

  it('OKX signature is Base64 (not hex)', () => {
    const okx = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p' });
    const result = okx._sign('/test', 'GET', {});
    const sig = result.headers['OK-ACCESS-SIGN'];
    assert.strictEqual(sig.length, 44); // Base64 of 32 bytes
  });

  it('OKX uses ISO timestamp (not unix ms)', () => {
    const okx = new Okx({ apiKey: 'k', secret: 's', passphrase: 'p' });
    const result = okx._sign('/test', 'GET', {});
    const ts = result.headers['OK-ACCESS-TIMESTAMP'];
    assert.ok(ts.includes('T'), 'should contain T from ISO format');
    assert.ok(ts.endsWith('Z'), 'should end with Z');
  });

  it('OKX response code is string "0" (not integer 0)', () => {
    const okx = new Okx();
    // String "0" should succeed
    const result = okx._unwrapResponse({ code: '0', data: [1] });
    assert.deepStrictEqual(result, [1]);
    // Integer 0 would NOT match string comparison
    assert.throws(() => okx._unwrapResponse({ code: 0, data: [1] }));
  });
});

// =============================================================================
// 13. CRYPTO — hmacSHA256Base64
// =============================================================================

describe('Crypto — hmacSHA256Base64', () => {
  it('produces valid Base64 output (44 chars for SHA256)', () => {
    const result = hmacSHA256Base64('hello', 'secret');
    assert.strictEqual(result.length, 44);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(result));
  });

  it('produces different output than hmacSHA256 (hex) for same input', () => {
    const base64 = hmacSHA256Base64('test', 'key');
    const hex = hmacSHA256('test', 'key');
    assert.notStrictEqual(base64, hex);
    assert.strictEqual(hex.length, 64); // hex is 64 chars
    assert.strictEqual(base64.length, 44); // base64 is 44 chars
  });
});

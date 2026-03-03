# Rate Limiting

## Overview

YGCC includes automatic rate limit handling to prevent your application from exceeding exchange API limits. When enabled (the default), every request passes through a token-bucket throttler that delays calls as needed, so you never get IP-banned or receive `429` responses during normal operation.

---

## Token-Bucket Throttler

The rate limiter uses a **token-bucket algorithm** with weight-based consumption:

1. The bucket starts at full **capacity** (e.g., 1200 tokens for Binance).
2. Each API request **consumes** tokens equal to its endpoint weight (most endpoints cost 1, but some cost 5, 10, or 40+).
3. Tokens **refill** at a steady rate over the refill interval (e.g., 1200 tokens every 60 seconds).
4. If the bucket is empty, the request **waits** until enough tokens have refilled before proceeding.

```
┌─────────────────────────────────────────────┐
│  Token Bucket                               │
│                                             │
│  capacity: 1200     refillRate: 1200        │
│  refillInterval: 60000ms                    │
│                                             │
│  ┌──────────────────────┐                   │
│  │ ████████████░░░░░░░░ │  tokens: 800      │
│  └──────────────────────┘                   │
│                                             │
│  consume(weight=10) → deduct 10 tokens      │
│  consume(weight=50) → wait if insufficient  │
└─────────────────────────────────────────────┘
```

Key methods on the `Throttler` class:

| Method                      | Description                                                  |
|-----------------------------|--------------------------------------------------------------|
| `consume(weight)`           | Deduct tokens, waiting if the bucket is empty                |
| `tryConsume(weight)`        | Try to deduct tokens without waiting; returns `true`/`false` |
| `updateFromHeader(used)`    | Sync token count from exchange response headers              |
| `getStatus()`               | Returns `{ available, capacity, usage }` snapshot            |

---

## Configuration

Rate limiting is **enabled by default**. You can control it via the constructor:

```javascript
const { binance } = require('ygcc');

// Default — rate limiting ON
const exchange = new binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET',
});

// Explicit — same as default
const exchange2 = new binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET',
  enableRateLimit: true,
});
```

The throttler is initialized automatically using the values from the exchange's `describe()` method:

```javascript
// Inside BaseExchange constructor:
this._throttler = new Throttler({
  capacity: desc.rateLimitCapacity || 1200,
  refillRate: desc.rateLimitCapacity || 1200,
  refillInterval: desc.rateLimitInterval || 60000,
});
```

---

## Exchange-Specific Limits

Each exchange defines its own rate limit profile. YGCC configures the throttler accordingly:

| Exchange | Capacity        | Interval   | Tracking Method                             |
|----------|-----------------|------------|---------------------------------------------|
| Binance  | 6000 weight/min | 60 000 ms  | `X-MBX-USED-WEIGHT-1M` response header      |
| Bybit    | 120 req/min     | 60 000 ms  | Request counting                            |
| OKX      | 60 req/2s       | 2 000 ms   | Request counting                            |
| Kraken   | 15 req/3s       | 3 000 ms   | Request counting                            |
| Gate.io  | 900 req/min     | 60 000 ms  | Request counting                            |
| KuCoin   | 200 req/10s     | 10 000 ms  | Request counting                            |
| Coinbase | 30 req/s        | 1 000 ms   | Request counting                            |
| Others   | 1200 req/min    | 60 000 ms  | Reasonable defaults                         |

### Header-Based Tracking (Binance)

Binance is unique in that it reports how much weight you have consumed via the `X-MBX-USED-WEIGHT-1M` response header. YGCC reads this header after every response and syncs the throttler's token count accordingly, giving you the most accurate rate limit tracking possible:

```javascript
// Inside Binance._handleResponseHeaders():
const used = headers.get('x-mbx-used-weight-1m');
if (used) {
  this._throttler.updateFromHeader(parseInt(used, 10));
}
```

---

## Monitoring

Exchanges that support it emit a `rateLimitWarning` event when usage gets high. You can listen for this to implement your own backoff logic or logging:

```javascript
const { binance } = require('ygcc');

const exchange = new binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET',
});

exchange.on('rateLimitWarning', ({ used, limit }) => {
  console.warn(`Rate limit warning: ${used}/${limit} weight used`);
  // Implement custom backoff, alerting, etc.
});
```

On Binance, the warning fires when used weight exceeds 4800 out of 6000 (80% threshold).

---

## Disabling Rate Limiting

If you are managing rate limits yourself (e.g., with an external queue or proxy), you can disable the built-in throttler:

```javascript
const exchange = new binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET',
  enableRateLimit: false,
});
```

> **Warning:** Disabling rate limiting means YGCC will send requests as fast as your code calls them. You are responsible for staying within the exchange's limits. Exceeding them may result in IP bans or `418` responses (Binance) / `429` responses (most others).

---

## Automatic 429 / 418 Handling

Even with the throttler enabled, unexpected rate limit responses can occur (e.g., if other applications share the same API key). When the library receives a `429` or `418` HTTP status, it throws a `RateLimitExceeded` error with the `Retry-After` value from the response:

```javascript
const { RateLimitExceeded } = require('ygcc');

try {
  await exchange.fetchTicker('BTC/USDT');
} catch (error) {
  if (error instanceof RateLimitExceeded) {
    console.error(error.message);
    // e.g., "binance rate limited. Retry after 60s"
  }
}
```

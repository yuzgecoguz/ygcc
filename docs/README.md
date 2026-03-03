# YGCC — Cryptocurrency Exchange Library

[![npm](https://img.shields.io/badge/npm-v2.9.0-blue)](https://www.npmjs.com/package/ygcc)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](https://github.com/AquiraSec/ygcc/blob/main/LICENSE)
[![Tests](https://img.shields.io/badge/tests-2806%20passing-brightgreen)]()
[![Exchanges](https://img.shields.io/badge/exchanges-33-orange)]()

> Lightweight, unified REST & WebSocket API for 30+ cryptocurrency exchanges. One interface, all exchanges.

---

## Features

- **Unified API** — Every exchange exposes the same method signatures (`fetchTicker`, `fetchOrderBook`, `createOrder`, etc.). Learn once, trade everywhere.
- **REST + WebSocket** — Full REST client for every exchange, plus real-time WebSocket streams where supported (30 of 33 exchanges).
- **Weight-Aware Rate Limiting** — Built-in rate limiter that tracks endpoint weights, not just request counts. Never get IP-banned again.
- **Auto-Reconnect WebSocket** — WebSocket connections automatically reconnect on disconnect with exponential backoff. Zero manual intervention.
- **Typed Error Hierarchy** — Granular error classes (`AuthenticationError`, `InsufficientFunds`, `RateLimitExceeded`, `NetworkError`, etc.) so you can handle failures precisely.
- **Minimal Dependencies** — Only one runtime dependency: [`ws`](https://github.com/websockets/ws). Nothing else.
- **Multi-Auth Support** — 22+ authentication patterns implemented out of the box:
  - HMAC-SHA256, HMAC-SHA384, HMAC-SHA512
  - Base64-encoded HMAC variants
  - SHA256 + HMAC-SHA512 chained
  - MD5 + HMAC-SHA256 dual-layer
  - JWT / ES256
  - HTTP Basic Auth
  - Passphrase-based auth (OKX, KuCoin)
  - Body-hash signing (Gate.io, Bittrex)
  - UUID nonce signing (Bitstamp)
  - Path-based signing (Bitforex)
  - Query-string signing (HotCoin, Bitrue)
  - 4-credential uppercase hashing (Bitexen)
  - Double-layer HMAC (CoinTR)
  - Form-encoded signing (EXMO)
  - And more...
- **Testnet Support** — First-class support for exchange sandbox/testnet environments for safe development and testing.

---

## Quick Start

```bash
npm install ygcc
```

```js
const { binance } = require('ygcc');

const exchange = new binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET',
});

(async () => {
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`${ticker.symbol}: $${ticker.last}`);
  console.log(`24h Volume: ${ticker.baseVolume} BTC`);
  console.log(`High: $${ticker.high}  Low: $${ticker.low}`);
})();
```

---

## Documentation

Explore the full documentation:

- [Supported Exchanges](exchanges.md) — All 33 exchanges, feature matrix, and auth patterns

# YGCC — Cryptocurrency Exchange Library

[![npm version](https://img.shields.io/badge/npm-v2.7.0-blue)](https://www.npmjs.com/package/@ygcc/ygcc)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-1929%20passing-brightgreen)](tests/)
[![Exchanges](https://img.shields.io/badge/Exchanges-42-orange)](https://github.com/yuzgecoguz/ygcc)

> Lightweight, unified REST & WebSocket API for cryptocurrency exchanges. One interface, 42 exchanges.

## Overview

**YGCC** is a JavaScript library for cryptocurrency trading that provides a unified API across multiple exchanges. Write your trading logic once — it works on every supported exchange without modification.

Built from **5+ years of production trading experience** across 40+ exchanges.

## Features

- **Unified API** — Same method signatures across all exchanges (`fetchTicker`, `createOrder`, `watchOrderBook`, etc.)
- **REST + WebSocket** — Full market data, trading, and real-time streaming support
- **Weight-Aware Rate Limiting** — Token-bucket limiter that syncs with exchange response headers
- **Auto-Reconnect WebSocket** — Exponential backoff with jitter, automatic resubscription
- **Typed Error Hierarchy** — `AuthenticationError`, `InsufficientFunds`, `RateLimitExceeded`, etc.
- **Minimal Dependencies** — Only [`ws`](https://github.com/websockets/ws) for WebSocket support
- **Multi-Auth Support** — HMAC-SHA256/384/512 (hex, Base64), SHA512 content hash (Kraken/Gate.io/Bittrex), JWT/ES256 (Coinbase), UUID nonce (Bitstamp), MD5+HMAC-SHA256 (LBank), Base64-decoded HMAC-SHA256 (Phemex), HMAC-SHA256+memo (BitMart), HMAC-SHA256+URL-signature (Bitrue), HMAC-SHA256+path-signing (Bitforex), HMAC-SHA256+header-signing (Pionex), dual V3 HmacMD5 + V4 HmacSHA256 (Bibox), Base64+HMAC-SHA512 (WhiteBit), HMAC-SHA512 timestamp+method+path (VALR), HMAC-SHA256 uppercase 4-credential (Bitexen)
- **Testnet Support** — Built-in sandbox mode for safe testing

## Supported Exchanges

### CEX (Centralized)

| # | Exchange | ID | REST | WebSocket | Status |
|---|----------|-----|------|-----------|--------|
| 1 | [Binance](https://www.binance.com) | `binance` | ✅ | ✅ | **Ready** |
| 2 | [Bybit](https://www.bybit.com) | `bybit` | ✅ | ✅ | **Ready** |
| 3 | [OKX](https://www.okx.com) | `okx` | ✅ | ✅ | **Ready** |
| 4 | [Kraken](https://www.kraken.com) | `kraken` | ✅ | ✅ | **Ready** |
| 5 | [Gate.io](https://www.gate.io) | `gateio` | ✅ | ✅ | **Ready** |
| 6 | [Coinbase](https://www.coinbase.com) | `coinbase` | ✅ | ✅ | **Ready** |
| 7 | [KuCoin](https://www.kucoin.com) | `kucoin` | ✅ | ✅ | **Ready** |
| 8 | [Bitfinex](https://www.bitfinex.com) | `bitfinex` | ✅ | ✅ | **Ready** |
| 9 | [Bitstamp](https://www.bitstamp.net) | `bitstamp` | ✅ | ✅ | **Ready** |
| 10 | [Gemini](https://www.gemini.com) | `gemini` | 🔜 | 🔜 | Planned |
| 11 | [Crypto.com](https://crypto.com) | `cryptocom` | 🔜 | 🔜 | Planned |
| 12 | [Bittrex](https://bittrex.com) | `bittrex` | ✅ | ✅ | **Ready** |
| 13 | [Bitrue](https://www.bitrue.com) | `bitrue` | ✅ | ✅ | **Ready** |
| 14 | [LBANK](https://www.lbank.com) | `lbank` | ✅ | ✅ | **Ready** |
| 15 | [BitMart](https://www.bitmart.com) | `bitmart` | ✅ | ✅ | **Ready** |
| 16 | [Bitforex](https://www.bitforex.com) | `bitforex` | ✅ | ✅ | **Ready** |
| 17 | [Phemex](https://phemex.com) | `phemex` | ✅ | ✅ | **Ready** |
| 18 | [Pionex](https://www.pionex.com) | `pionex` | ✅ | ✅ | **Ready** |
| 19 | [Bibox](https://www.bibox.com) | `bibox` | ✅ | ✅ | **Ready** |
| 20 | [WhiteBit](https://whitebit.com) | `whitebit` | ✅ | ✅ | **Ready** |
| 21 | [VALR](https://www.valr.com) | `valr` | ✅ | ✅ | **Ready** |
| 22 | [Bitexen](https://www.bitexen.com) | `bitexen` | ✅ | ✅ | **Ready** |
| 23 | [BtcTurk](https://www.btcturk.com) | `btcturk` | 🔜 | 🔜 | Planned |
| 24 | [BTSE](https://www.btse.com) | `btse` | 🔜 | 🔜 | Planned |
| 25 | [EXMO](https://exmo.com) | `exmo` | 🔜 | 🔜 | Planned |
| 26 | [CoinTR](https://www.cointr.com) | `cointr` | 🔜 | 🔜 | Planned |
| 27 | [Coinzix](https://coinzix.com) | `coinzix` | 🔜 | 🔜 | Planned |
| 28 | [DigiFinex](https://www.digifinex.com) | `digifinex` | 🔜 | 🔜 | Planned |
| 29 | [HotCoin](https://www.hotcoin.com) | `hotcoin` | 🔜 | 🔜 | Planned |
| 30 | [iCrypex](https://icrypex.com) | `icrypex` | 🔜 | 🔜 | Planned |
| 31 | [JBEX](https://www.jbex.com) | `jbex` | 🔜 | 🔜 | Planned |
| 32 | [Kuna](https://kuna.io) | `kuna` | 🔜 | 🔜 | Planned |
| 33 | [Narkasa](https://www.narkasa.com) | `narkasa` | 🔜 | 🔜 | Planned |
| 34 | [NovaDax](https://www.novadax.com) | `novadax` | 🔜 | 🔜 | Planned |
| 35 | [PointPay](https://pointpay.io) | `pointpay` | 🔜 | 🔜 | Planned |
| 36 | [QMall](https://qmall.io) | `qmall` | 🔜 | 🔜 | Planned |
| 37 | [TruBit](https://www.trubit.com) | `trubit` | 🔜 | 🔜 | Planned |
| 38 | [TradeOgre](https://tradeogre.com) | `tradeogre` | 🔜 | 🔜 | Planned |
| 39 | [TIDEX](https://tidex.com) | `tidex` | 🔜 | 🔜 | Planned |
| 40 | [Latoken](https://latoken.com) | `latoken` | 🔜 | 🔜 | Planned |
| 41 | [Polymarket](https://polymarket.com) | `polymarket` | 🔜 | 🔜 | Planned |

### DEX (Decentralized)

| # | Exchange | ID | REST | WebSocket | Status |
|---|----------|-----|------|-----------|--------|
| 41 | [Hyperliquid](https://hyperliquid.xyz) | `hyperliquid` | 🔜 | 🔜 | Planned |
| 42 | [ZKLighter](https://zklighter.com) | `zklighter` | 🔜 | 🔜 | Planned |

> ✅ = Implemented &nbsp;&nbsp; 🔜 = Coming Soon

## Installation

```bash
npm install @ygcc/ygcc
```

Or clone directly:

```bash
git clone https://github.com/yuzgecoguz/ygcc.git
cd ygcc
npm install
```

## Quick Start

### Fetch Market Data (Public — No API Key Needed)

```javascript
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
  // Load all trading pairs
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Get BTC price
  const ticker = await exchange.fetchTicker('BTCUSDT');
  console.log(`BTC: $${ticker.last} (${ticker.percentage}%)`);

  // Order book (top 5 levels)
  const book = await exchange.fetchOrderBook('BTCUSDT', 5);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);

  // OHLCV candlesticks
  const candles = await exchange.fetchOHLCV('BTCUSDT', '1h', undefined, 5);
  console.log(`Last 5 hourly candles:`, candles);
})();
```

### Place Orders (Private — API Key Required)

```javascript
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET,
  enableRateLimit: true,
});

(async () => {
  // Check balance
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Place a limit order
  const order = await exchange.createLimitOrder('BTCUSDT', 'BUY', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel it
  const canceled = await exchange.cancelOrder(order.id, 'BTCUSDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### WebSocket Streaming (Real-Time)

```javascript
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

// Real-time ticker updates
exchange.watchTicker('BTCUSDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time trades
exchange.watchTrades('ETHUSDT', (trade) => {
  console.log(`${trade.side.toUpperCase()} ${trade.amount} ETH @ $${trade.price}`);
});

// Real-time order book
exchange.watchOrderBook('BTCUSDT', (book) => {
  const spread = book.asks[0][0] - book.bids[0][0];
  console.log(`Spread: $${spread.toFixed(2)}`);
}, 5);

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using Bybit

```javascript
const { Bybit } = require('@ygcc/ygcc');

const exchange = new Bybit();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  const ticker = await exchange.fetchTicker('BTCUSDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTCUSDT', 50);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Bybit Trading (Private)

```javascript
const { Bybit } = require('@ygcc/ygcc');

const exchange = new Bybit({
  apiKey: process.env.BYBIT_API_KEY,
  secret: process.env.BYBIT_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Bybit V5 uses POST for orders (not query string like Binance)
  const order = await exchange.createLimitOrder('BTCUSDT', 'Buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses POST too (not DELETE like Binance)
  const canceled = await exchange.cancelOrder(order.id, 'BTCUSDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using OKX

```javascript
const { Okx } = require('@ygcc/ygcc');

const exchange = new Okx();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // OKX uses dash-separated symbols: BTC-USDT (not BTCUSDT)
  const ticker = await exchange.fetchTicker('BTC-USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC-USDT', 5);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### OKX Trading (Private)

```javascript
const { Okx } = require('@ygcc/ygcc');

const exchange = new Okx({
  apiKey: process.env.OKX_API_KEY,
  secret: process.env.OKX_SECRET,
  passphrase: process.env.OKX_PASSPHRASE, // OKX requires passphrase!
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // OKX uses lowercase side/type, Base64 signature, POST for all trades
  const order = await exchange.createLimitOrder('BTC-USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id, 'BTC-USDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using Kraken

```javascript
const { Kraken } = require('@ygcc/ygcc');

const exchange = new Kraken();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Kraken uses slash-separated symbols: BTC/USD
  const ticker = await exchange.fetchTicker('BTC/USD');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USD', 10);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Kraken Trading (Private)

```javascript
const { Kraken } = require('@ygcc/ygcc');

const exchange = new Kraken({
  apiKey: process.env.KRAKEN_API_KEY,
  secret: process.env.KRAKEN_SECRET, // Base64-encoded secret
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USD:', balance.USD);

  // Kraken uses form-urlencoded POST, SHA256+HMAC-SHA512 signing
  const order = await exchange.createLimitOrder('BTC/USD', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using Gate.io

```javascript
const { Gateio } = require('@ygcc/ygcc');

const exchange = new Gateio();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Gate.io uses underscore-separated symbols: BTC_USDT
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 10);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Gate.io Trading (Private)

```javascript
const { Gateio } = require('@ygcc/ygcc');

const exchange = new Gateio({
  apiKey: process.env.GATEIO_API_KEY,
  secret: process.env.GATEIO_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Gate.io uses HMAC-SHA512 hex signing with SHA512 body hash
  const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id, 'BTC/USDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using KuCoin

```javascript
const { KuCoin } = require('@ygcc/ygcc');

const exchange = new KuCoin();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // KuCoin uses hyphen-separated symbols: BTC-USDT
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 20);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### KuCoin Trading (Private)

```javascript
const { KuCoin } = require('@ygcc/ygcc');

const exchange = new KuCoin({
  apiKey: process.env.KUCOIN_API_KEY,
  secret: process.env.KUCOIN_SECRET,
  passphrase: process.env.KUCOIN_PASSPHRASE, // KuCoin requires passphrase (encrypted automatically)
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // KuCoin auto-generates clientOid (UUID) for every order
  const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using Coinbase

```javascript
const { Coinbase } = require('@ygcc/ygcc');

const exchange = new Coinbase();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Coinbase uses hyphen-separated symbols: BTC-USD (note: USD, not USDT)
  const ticker = await exchange.fetchTicker('BTC/USD');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USD', 10);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Coinbase Trading (Private)

```javascript
const { Coinbase } = require('@ygcc/ygcc');

const exchange = new Coinbase({
  apiKey: process.env.COINBASE_API_KEY,    // organizations/{org_id}/apiKeys/{key_id}
  secret: process.env.COINBASE_SECRET,      // EC private key (PEM format)
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USD:', balance.USD);

  // Coinbase uses JWT/ES256 auth, nested order_configuration, auto-generated client_order_id
  const order = await exchange.createLimitOrder('BTC/USD', 'BUY', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses POST batch_cancel (not DELETE)
  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using Bitfinex

```javascript
const { Bitfinex } = require('@ygcc/ygcc');

const exchange = new Bitfinex();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Bitfinex uses tBTCUSD format internally, accepts BTC/USD
  const ticker = await exchange.fetchTicker('BTC/USD');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USD', 25);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Bitfinex Trading (Private)

```javascript
const { Bitfinex } = require('@ygcc/ygcc');

const exchange = new Bitfinex({
  apiKey: process.env.BITFINEX_API_KEY,
  secret: process.env.BITFINEX_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USD:', balance.USD);

  // Bitfinex uses HMAC-SHA384, EXCHANGE LIMIT/MARKET types, amount sign for side
  const order = await exchange.createLimitOrder('BTC/USD', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using Bitstamp

```javascript
const { Bitstamp } = require('@ygcc/ygcc');

const exchange = new Bitstamp();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Bitstamp uses slash-separated symbols: BTC/USD
  const ticker = await exchange.fetchTicker('BTC/USD');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USD', 10);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Bitstamp Trading (Private)

```javascript
const { Bitstamp } = require('@ygcc/ygcc');

const exchange = new Bitstamp({
  apiKey: process.env.BITSTAMP_API_KEY,
  secret: process.env.BITSTAMP_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USD:', balance.USD);

  // Bitstamp uses HMAC-SHA256 + UUID nonce, side is in the URL path (buy/sell)
  const order = await exchange.createLimitOrder('BTC/USD', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using Bittrex

```javascript
const { Bittrex } = require('@ygcc/ygcc');

const exchange = new Bittrex();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Bittrex uses hyphen-separated uppercase symbols: BTC-USDT
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 25);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Bittrex Trading (Private)

```javascript
const { Bittrex } = require('@ygcc/ygcc');

const exchange = new Bittrex({
  apiKey: process.env.BITTREX_API_KEY,
  secret: process.env.BITTREX_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Bittrex uses HMAC-SHA512 + SHA512 content hash, JSON POST body, DELETE for cancel
  const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses DELETE method (unique among exchanges)
  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Bittrex WebSocket (SignalR V3)

```javascript
const { Bittrex } = require('@ygcc/ygcc');

const exchange = new Bittrex();

// Real-time ticker via SignalR V3 hub "c3"
exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time order book deltas
exchange.watchOrderBook('BTC/USDT', (book) => {
  console.log(`Bids: ${book.bids.length} | Asks: ${book.asks.length} | Seq: ${book.nonce}`);
}, 25);

// Real-time trades
exchange.watchTrades('ETH/USD', (trade) => {
  console.log(`${trade.side.toUpperCase()} ${trade.amount} ETH @ $${trade.price}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using LBank

```javascript
const { LBank } = require('@ygcc/ygcc');

const exchange = new LBank();

(async () => {
  await exchange.loadMarkets();
  console.log(`${Object.keys(exchange.markets).length} symbols loaded`);

  // LBank uses underscore-separated lowercase symbols: btc_usdt
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 50);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### LBank Trading (Private)

```javascript
const { LBank } = require('@ygcc/ygcc');

const exchange = new LBank({
  apiKey: process.env.LBANK_API_KEY,
  secret: process.env.LBANK_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // LBank uses MD5+HMAC-SHA256 two-step signing, POST params in query string
  const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id, 'BTC/USDT');
  console.log(`Canceled: ${canceled.id}`);
})();
```

### LBank WebSocket (V3 JSON)

```javascript
const { LBank } = require('@ygcc/ygcc');

const exchange = new LBank();

// Real-time ticker via V3 JSON subscribe
exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time order book depth
exchange.watchOrderBook('BTC/USDT', (book) => {
  console.log(`Bids: ${book.bids.length} | Asks: ${book.asks.length}`);
}, 50);

// Real-time trades
exchange.watchTrades('ETH/USDT', (trades) => {
  trades.forEach(t => console.log(`${t.side.toUpperCase()} ${t.amount} ETH @ $${t.price}`));
});

// Real-time klines
exchange.watchKlines('BTC/USDT', '1m', (kline) => {
  console.log(`Open: ${kline.open} | Close: ${kline.close} | Vol: ${kline.volume}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using Phemex

```javascript
const { Phemex } = require('@ygcc/ygcc');

const exchange = new Phemex();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Phemex uses s-prefix format internally: sBTCUSDT
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT');
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Phemex Trading (Private)

```javascript
const { Phemex } = require('@ygcc/ygcc');

const exchange = new Phemex({
  apiKey: process.env.PHEMEX_API_KEY,
  secret: process.env.PHEMEX_SECRET, // Base64-encoded secret key
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Phemex uses HMAC-SHA256 with Base64-decoded secret, Ep/Ev 10^8 scaling
  const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses DELETE method with query params
  const canceled = await exchange.cancelOrder(order.id, 'BTC/USDT');
  console.log(`Canceled: ${canceled.id}`);
})();
```

### Phemex WebSocket (JSON-RPC)

```javascript
const { Phemex } = require('@ygcc/ygcc');

const exchange = new Phemex();

// Real-time ticker via JSON-RPC subscribe
exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time order book (snapshot + incremental)
exchange.watchOrderBook('BTC/USDT', (book) => {
  console.log(`Bids: ${book.bids.length} | Asks: ${book.asks.length} | Type: ${book.type}`);
});

// Real-time trades
exchange.watchTrades('ETH/USDT', (trades) => {
  trades.forEach(t => console.log(`${t.side.toUpperCase()} ${t.amount} ETH @ $${t.price}`));
});

// Real-time klines
exchange.watchKlines('BTC/USDT', '1h', (klines) => {
  klines.forEach(k => console.log(`Open: ${k.open} | Close: ${k.close}`));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using BitMart

```javascript
const { BitMart } = require('@ygcc/ygcc');

const exchange = new BitMart();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // BitMart uses underscore-separated symbols: BTC_USDT
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 20);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### BitMart Trading (Private)

```javascript
const { BitMart } = require('@ygcc/ygcc');

const exchange = new BitMart({
  apiKey: process.env.BITMART_API_KEY,
  secret: process.env.BITMART_SECRET,
  memo: process.env.BITMART_MEMO, // BitMart requires memo (3rd credential)
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // BitMart uses HMAC-SHA256 with memo in signature: timestamp#memo#body
  const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id, 'BTC/USDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### BitMart WebSocket (zlib compressed)

```javascript
const { BitMart } = require('@ygcc/ygcc');

const exchange = new BitMart();

// Real-time ticker via zlib-compressed subscribe
exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time order book (depth5 or depth20)
exchange.watchOrderBook('BTC/USDT', (book) => {
  console.log(`Bids: ${book.bids.length} | Asks: ${book.asks.length}`);
}, 20);

// Real-time trades
exchange.watchTrades('ETH/USDT', (trades) => {
  trades.forEach(t => console.log(`${t.side.toUpperCase()} ${t.amount} ETH @ $${t.price}`));
});

// Real-time klines
exchange.watchKlines('BTC/USDT', '1h', (klines) => {
  klines.forEach(k => console.log(`Open: ${k.open} | Close: ${k.close}`));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using Bitrue

```javascript
const { Bitrue } = require('@ygcc/ygcc');

const exchange = new Bitrue();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Bitrue uses Binance-style symbols: BTCUSDT (no separator)
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 20);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Bitrue Trading (Private)

```javascript
const { Bitrue } = require('@ygcc/ygcc');

const exchange = new Bitrue({
  apiKey: process.env.BITRUE_API_KEY,
  secret: process.env.BITRUE_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Bitrue uses HMAC-SHA256 with signature in URL, JSON POST body, GTT timeInForce
  const order = await exchange.createLimitOrder('BTC/USDT', 'BUY', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id, 'BTC/USDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Bitrue WebSocket (gzip compressed)

```javascript
const { Bitrue } = require('@ygcc/ygcc');

const exchange = new Bitrue();

// Real-time ticker via gzip-compressed subscribe
exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time order book (depth_step0)
exchange.watchOrderBook('BTC/USDT', (book) => {
  console.log(`Bids: ${book.bids.length} | Asks: ${book.asks.length}`);
}, 20);

// Real-time trades
exchange.watchTrades('ETH/USDT', (trade) => {
  console.log(`${trade.side.toUpperCase()} ${trade.amount} ETH @ $${trade.price}`);
});

// Real-time klines
exchange.watchKlines('BTC/USDT', '1h', (kline) => {
  console.log(`Open: ${kline.open} | Close: ${kline.close} | Vol: ${kline.volume}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using Bitforex

```javascript
const { Bitforex } = require('@ygcc/ygcc');

const exchange = new Bitforex();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Bitforex uses unique coin-quote-base format: coin-usdt-btc
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 10);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Bitforex Trading (Private)

```javascript
const { Bitforex } = require('@ygcc/ygcc');

const exchange = new Bitforex({
  apiKey: process.env.BITFOREX_API_KEY,
  secret: process.env.BITFOREX_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Bitforex uses HMAC-SHA256 with path in signing string, limit orders only (no market orders)
  const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id, 'BTC/USDT');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Bitforex WebSocket (plain text JSON)

```javascript
const { Bitforex } = require('@ygcc/ygcc');

const exchange = new Bitforex();

// Real-time ticker via plain text JSON subscribe
exchange.watchTicker('BTC/USDT', (ticker) => {
  console.log(`BTC: $${ticker.last} | Bid: $${ticker.bid} | Ask: $${ticker.ask}`);
});

// Real-time order book (depth10)
exchange.watchOrderBook('BTC/USDT', (book) => {
  console.log(`Bids: ${book.bids.length} | Asks: ${book.asks.length}`);
}, 10);

// Real-time trades
exchange.watchTrades('ETH/USDT', (trade) => {
  console.log(`${trade.side.toUpperCase()} ${trade.amount} ETH @ $${trade.price}`);
});

// Real-time klines
exchange.watchKlines('BTC/USDT', '1m', (kline) => {
  console.log(`Open: ${kline.open} | Close: ${kline.close} | Vol: ${kline.volume}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using Pionex

```javascript
const { Pionex } = require('@ygcc/ygcc');

const exchange = new Pionex();

(async () => {
  // Pionex has NO REST market data — only loadMarkets is available publicly
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // No fetchTicker, fetchOrderBook, fetchTrades, or fetchOHLCV!
  // Use WebSocket for real-time market data instead
})();
```

### Pionex Trading (Private)

```javascript
const { Pionex } = require('@ygcc/ygcc');

const exchange = new Pionex({
  apiKey: process.env.PIONEX_API_KEY,
  secret: process.env.PIONEX_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Pionex MARKET BUY uses amount (quote currency), SELL uses size (base currency)
  const order = await exchange.createLimitOrder('BTC/USDT', 'BUY', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses DELETE with JSON body (unique to Pionex)
  const canceled = await exchange.cancelOrder(order.id, 'BTC/USDT');
  console.log(`Canceled: ${canceled.status}`);

  // Cancel all open orders for a symbol
  await exchange.cancelAllOrders('BTC/USDT');
})();
```

### Pionex WebSocket (Real-Time)

```javascript
const { Pionex } = require('@ygcc/ygcc');

const exchange = new Pionex();

// Real-time order book (server PING → client PONG heartbeat)
exchange.watchOrderBook('BTC/USDT', (book) => {
  const spread = book.asks[0][0] - book.bids[0][0];
  console.log(`Spread: $${spread.toFixed(2)}`);
}, 100);

// Real-time trades
exchange.watchTrades('BTC/USDT', (trades) => {
  trades.forEach(t => console.log(`${t.side} ${t.amount} @ $${t.price}`));
});

process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using Bibox

```javascript
const { Bibox } = require('@ygcc/ygcc');

const exchange = new Bibox();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Bibox uses underscore-separated symbols: BTC_USDT
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 10);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### Bibox Trading (Private)

```javascript
const { Bibox } = require('@ygcc/ygcc');

const exchange = new Bibox({
  apiKey: process.env.BIBOX_API_KEY,
  secret: process.env.BIBOX_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // Bibox uses dual auth: V3 HmacMD5 for trading, V4 HmacSHA256 for account
  // Only limit orders supported (no market orders)
  const order = await exchange.createLimitOrder('BTC/USDT', 'BUY', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses POST (not DELETE like Pionex)
  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Bibox WebSocket (zlib compressed)

```javascript
const { Bibox } = require('@ygcc/ygcc');

const exchange = new Bibox();

// Real-time order book via zlib-compressed binary data
exchange.watchOrderBook('BTC/USDT', (book) => {
  const spread = book.asks[0][0] - book.bids[0][0];
  console.log(`Spread: $${spread.toFixed(2)}`);
}, 10);

// Graceful shutdown
process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using WhiteBit

```javascript
const { WhiteBit } = require('@ygcc/ygcc');

const exchange = new WhiteBit();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // WhiteBit uses underscore-separated symbols: BTC_USDT
  const ticker = await exchange.fetchTicker('BTC/USDT');
  console.log(`BTC: $${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/USDT', 10);
  console.log(`Best bid: $${book.bids[0][0]} | Best ask: $${book.asks[0][0]}`);
})();
```

### WhiteBit Trading (Private)

```javascript
const { WhiteBit } = require('@ygcc/ygcc');

const exchange = new WhiteBit({
  apiKey: process.env.WHITEBIT_API_KEY,
  secret: process.env.WHITEBIT_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('USDT:', balance.USDT);

  // WhiteBit uses Base64+HMAC-SHA512 signing, all private endpoints are POST
  const order = await exchange.createLimitOrder('BTC/USDT', 'BUY', 0.001, 50000);
  console.log(`Order ${order.id}: ${order.status}`);

  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### WhiteBit WebSocket (zlib compressed)

```javascript
const { WhiteBit } = require('@ygcc/ygcc');

const exchange = new WhiteBit();

// Real-time order book via zlib-compressed binary data (Z_SYNC_FLUSH)
exchange.watchOrderBook('BTC/USDT', (book) => {
  const spread = book.asks[0][0] - book.bids[0][0];
  console.log(`Spread: $${spread.toFixed(2)}`);
}, 50);

process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Using VALR

```javascript
const { Valr } = require('@ygcc/ygcc');

const exchange = new Valr();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // VALR uses concatenated symbols: BTCZAR (South African exchange, ZAR quote)
  const ticker = await exchange.fetchTicker('BTC/ZAR');
  console.log(`BTC: R${ticker.last}`);

  const book = await exchange.fetchOrderBook('BTC/ZAR', 10);
  console.log(`Best bid: R${book.bids[0][0]} | Best ask: R${book.asks[0][0]}`);
})();
```

### VALR Trading (Private)

```javascript
const { Valr } = require('@ygcc/ygcc');

const exchange = new Valr({
  apiKey: process.env.VALR_API_KEY,
  secret: process.env.VALR_SECRET,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('ZAR:', balance.ZAR);

  // VALR uses HMAC-SHA512(timestamp+method+path+body) signing
  const order = await exchange.createLimitOrder('BTC/ZAR', 'BUY', 0.001, 500000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses DELETE with JSON body (like Pionex)
  const canceled = await exchange.cancelOrder(order.id, 'BTC/ZAR');
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Using Bitexen

```javascript
const { Bitexen } = require('@ygcc/ygcc');

const exchange = new Bitexen();

(async () => {
  await exchange.loadMarkets();
  console.log(`${exchange.symbols.length} symbols loaded`);

  // Bitexen uses concatenated symbols: BTCTRY (Turkish exchange, TRY quote)
  const ticker = await exchange.fetchTicker('BTC/TRY');
  console.log(`BTC: ₺${ticker.last}`);
})();
```

### Bitexen Trading (Private)

```javascript
const { Bitexen } = require('@ygcc/ygcc');

const exchange = new Bitexen({
  apiKey: process.env.BITEXEN_API_KEY,
  secret: process.env.BITEXEN_SECRET,
  passphrase: process.env.BITEXEN_PASSPHRASE, // Bitexen requires 4 credentials
  uid: process.env.BITEXEN_USERNAME,
});

(async () => {
  const balance = await exchange.fetchBalance();
  console.log('TRY:', balance.TRY);

  // Bitexen uses HMAC-SHA256 uppercase, only limit orders, buy_sell: B/S
  const order = await exchange.createLimitOrder('BTC/TRY', 'BUY', 0.001, 750000);
  console.log(`Order ${order.id}: ${order.status}`);

  // Cancel uses POST with orderId in URL path
  const canceled = await exchange.cancelOrder(order.id);
  console.log(`Canceled: ${canceled.status}`);
})();
```

### Bitexen WebSocket (Socket.IO v2)

```javascript
const { Bitexen } = require('@ygcc/ygcc');

const exchange = new Bitexen();

// Real-time ticker via Socket.IO v2 (SID handshake, Engine.IO keepalive)
exchange.watchTicker('BTC/TRY', (ticker) => {
  console.log(`BTC: ₺${ticker.last}`);
});

// Real-time order book
exchange.watchOrderBook('BTC/TRY', (book) => {
  const spread = book.asks[0][0] - book.bids[0][0];
  console.log(`Spread: ₺${spread.toFixed(2)}`);
});

process.on('SIGINT', async () => {
  await exchange.closeAllWs();
  process.exit(0);
});
```

### Testnet / Sandbox Mode

```javascript
// Binance testnet
const binance = new Binance({
  apiKey: 'testnet-key',
  secret: 'testnet-secret',
  options: { sandbox: true }, // Uses testnet.binance.vision
});

// Bybit testnet
const bybit = new Bybit({
  apiKey: 'testnet-key',
  secret: 'testnet-secret',
  options: { sandbox: true }, // Uses api-testnet.bybit.com
});

// OKX demo trading
const okx = new Okx({
  apiKey: 'demo-key',
  secret: 'demo-secret',
  passphrase: 'demo-pass',
  options: { sandbox: true }, // Adds x-simulated-trading header
});
```

## Unified API Reference

All exchanges implement the same method signatures:

### Market Data (Public)

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase | Bitfinex | Bitstamp | Bittrex | LBank | Phemex | BitMart | Bitrue | Bitforex | Pionex | Bibox | WhiteBit | VALR | Bitexen |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|----------|----------|---------|-------|--------|---------|--------|----------|--------|-------|----------|------|---------|
| `loadMarkets()` | Load trading pairs, filters, precision rules | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchTicker(symbol)` | 24hr price statistics | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `fetchTickers(symbols?)` | All tickers at once | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | ❌ | ❌ | ✅ | ❌ | ✅ |
| `fetchOrderBook(symbol, limit?)` | Bids & asks depth | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| `fetchTrades(symbol, since?, limit?)` | Recent public trades | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `fetchOHLCV(symbol, timeframe?, since?, limit?)` | Candlestick / kline data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `fetchAvgPrice(symbol)` | Current average price | ✅ | | | | | | | | | | | | | | | | | | | |
| `fetchPrice(symbol?)` | Quick price lookup (lightweight) | ✅ | | | | | | | | | | | | | | | | | | | |
| `fetchBookTicker(symbol?)` | Best bid/ask only | ✅ | | | | | | | | | | | | | | | | | | | |
| `fetchTime()` | Server time | | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | | ❌ | ❌ | ❌ |

### Trading (Private — Signed)

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase | Bitfinex | Bitstamp | Bittrex | LBank | Phemex | BitMart | Bitrue | Bitforex | Pionex | Bibox | WhiteBit | VALR | Bitexen |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|----------|----------|---------|-------|--------|---------|--------|----------|--------|-------|----------|------|---------|
| `createOrder(symbol, type, side, amount, price?, params?)` | Place any order type | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `createLimitOrder(symbol, side, amount, price)` | Limit order shortcut | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `createMarketOrder(symbol, side, amount)` | Market order shortcut | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | ✅ | ❌ | ✅ | ✅ | ❌ |
| `cancelOrder(id, symbol)` | Cancel single order | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cancelAllOrders(symbol)` | Cancel all open orders | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | | ✅ | | ❌ | ❌ | ❌ |
| `amendOrder(id, symbol, params)` | Modify existing order | ✅ | ✅ | ✅ | | | | | | | | | | | | | | | | | |
| `createOCO(symbol, side, qty, price, stopPrice)` | One-Cancels-Other | ✅ | | | | | | | | | | | | | | | | | | | |
| `createOTO(...)` | One-Triggers-Other | ✅ | | | | | | | | | | | | | | | | | | | |
| `createOTOCO(...)` | One-Triggers-OCO | ✅ | | | | | | | | | | | | | | | | | | | |
| `testOrder(...)` | Validate without placing | ✅ | | | | | | | | | | | | | | | | | | | |

### Account (Private — Signed)

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase | Bitfinex | Bitstamp | Bittrex | LBank | Phemex | BitMart | Bitrue | Bitforex | Pionex | Bibox | WhiteBit | VALR | Bitexen |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|----------|----------|---------|-------|--------|---------|--------|----------|--------|-------|----------|------|---------|
| `fetchBalance()` | Account balances (free, used, total) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchOrder(id, symbol)` | Single order status | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `fetchOpenOrders(symbol?)` | All open orders | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | ✅ | ❌ | ❌ | ❌ | ❌ |
| `fetchClosedOrders(symbol, ...)` | Closed order history | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | ✅ | ✅ | ✅ | ✅ | ✅ | | ✅ | ❌ | ❌ | ❌ | ❌ |
| `fetchMyTrades(symbol, ...)` | Trade history with fees | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | | ✅ | ✅ | ✅ | | ✅ | ❌ | ❌ | ❌ | ❌ |
| `fetchTradingFees(symbol)` | Maker/taker fee rates | | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | ✅ | | | ❌ | ❌ | ❌ | ❌ | ❌ |
| `fetchCommission(symbol)` | Maker/taker commission rates | ✅ | | | | | | | | | | | | | | | | | | | |

### WebSocket Streams

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase | Bitfinex | Bitstamp | Bittrex | LBank | Phemex | BitMart | Bitrue | Bitforex | Pionex | Bibox | WhiteBit | VALR | Bitexen |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|----------|----------|---------|-------|--------|---------|--------|----------|--------|-------|----------|------|---------|
| `watchTicker(symbol, callback)` | Real-time ticker | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `watchAllTickers(callback)` | All tickers stream | ✅ | | | | | | | | | | | | | | | | | | | |
| `watchOrderBook(symbol, callback, levels?)` | Real-time order book | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `watchTrades(symbol, callback)` | Real-time trades | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `watchKlines(symbol, interval, callback)` | Real-time candlesticks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `watchBookTicker(symbol, callback)` | Real-time best bid/ask | ✅ | | | | | | | | | | | | | | | | | | | |
| `watchBalance(callback)` | Balance updates (private) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | | | | | | | ❌ | ❌ | ❌ | ❌ | ❌ |
| `watchOrders(callback)` | Order updates (private) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | | | | | | | ❌ | ❌ | ❌ | ❌ | ❌ |

## Unified Response Formats

### Ticker

```javascript
{
  symbol: 'BTCUSDT',
  last: 97500.00,
  bid: 97499.50,  bidVolume: 1.5,
  ask: 97500.50,  askVolume: 0.8,
  high: 98200.00, low: 96800.00,
  open: 97000.00, close: 97500.00,
  volume: 12345.678,
  quoteVolume: 1204567890.12,
  change: 500.00,
  percentage: 0.515,
  timestamp: 1700000000000,
  datetime: '2023-11-14T22:13:20.000Z',
}
```

### Order Book

```javascript
{
  symbol: 'BTCUSDT',
  bids: [[97500.00, 1.5], [97499.00, 2.0], ...],  // [price, quantity]
  asks: [[97501.00, 0.8], [97502.00, 1.2], ...],
  timestamp: 1700000000000,
  nonce: 123456789,
}
```

### Order

```javascript
{
  id: '12345678',
  clientOrderId: 'myOrder1',
  symbol: 'BTCUSDT',
  type: 'LIMIT',
  side: 'BUY',
  price: 95000.00,
  amount: 0.01,
  filled: 0.005,
  remaining: 0.005,
  cost: 475.00,
  average: 95000.00,
  status: 'PARTIALLY_FILLED',  // NEW, FILLED, CANCELED, EXPIRED, REJECTED
  timestamp: 1700000000000,
  trades: [{ price, amount, commission, commissionAsset }],
}
```

### Balance

```javascript
{
  BTC:  { free: 0.50, used: 0.10, total: 0.60 },
  USDT: { free: 5000, used: 1000, total: 6000 },
  timestamp: 1700000000000,
}
```

## Error Handling

YGCC provides typed errors for precise error handling:

```javascript
const {
  Binance,
  AuthenticationError,
  InsufficientFunds,
  RateLimitExceeded,
  InvalidOrder,
  OrderNotFound,
  BadSymbol,
  NetworkError,
} = require('@ygcc/ygcc');

try {
  await exchange.createOrder('BTCUSDT', 'LIMIT', 'BUY', 0.001, 95000);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Check your API key and secret');
  } else if (error instanceof InsufficientFunds) {
    console.error('Not enough balance');
  } else if (error instanceof RateLimitExceeded) {
    console.error('Slow down — rate limited');
  } else if (error instanceof InvalidOrder) {
    console.error('Order rejected:', error.message);
  } else if (error instanceof NetworkError) {
    console.error('Connection issue — retry');
  }
}
```

### Error Hierarchy

```
Error
  └── ExchangeError
        ├── AuthenticationError    // Invalid API key, signature, or timestamp
        ├── RateLimitExceeded      // 429 / 418 responses
        ├── InsufficientFunds      // Not enough balance
        ├── InvalidOrder           // Filter violations, bad params
        ├── OrderNotFound          // Order doesn't exist
        ├── BadSymbol              // Invalid trading pair
        ├── BadRequest             // Malformed request
        ├── ExchangeNotAvailable   // Exchange maintenance
        └── NetworkError
              └── RequestTimeout   // Request exceeded timeout
```

## Rate Limiting

YGCC automatically tracks and respects exchange rate limits:

```javascript
const exchange = new Binance({ enableRateLimit: true }); // Default: true

// Monitor rate limit usage
exchange.on('rateLimitWarning', ({ used, limit }) => {
  console.warn(`Rate limit: ${used}/${limit} weight used`);
});
```

Binance uses a **weight-based** system (6000 weight/minute). Each endpoint has a different weight cost. YGCC tracks the `X-MBX-USED-WEIGHT-1M` response header and automatically throttles requests when approaching the limit.

## Architecture

```
ygcc/
├── index.js                    # Entry point: const { Binance, Bybit, Okx, Kraken, Gateio, KuCoin, Coinbase, Bitfinex, Bitstamp, Bittrex, LBank, Phemex, BitMart, Bitrue, Bitforex, Pionex, Bibox, WhiteBit, Valr, Bitexen } = require('@ygcc/ygcc')
├── lib/
│   ├── BaseExchange.js         # Abstract base class — unified interface
│   ├── binance.js              # Binance implementation (1369 lines, 59 methods)
│   ├── bybit.js                # Bybit V5 implementation (1021 lines, 45 methods)
│   ├── okx.js                  # OKX V5 implementation (690 lines, 42 methods)
│   ├── kraken.js               # Kraken implementation (680 lines, 40 methods)
│   ├── gateio.js               # Gate.io V4 implementation (700 lines, 40 methods)
│   ├── kucoin.js               # KuCoin V1 implementation (1033 lines, 42 methods)
│   ├── coinbase.js             # Coinbase Advanced Trade implementation (780 lines, 42 methods)
│   ├── bitfinex.js             # Bitfinex V2 implementation (750 lines, 42 methods)
│   ├── bitstamp.js             # Bitstamp V2 implementation (580 lines, 38 methods)
│   ├── bittrex.js              # Bittrex V3 implementation (976 lines, 44 methods)
│   ├── lbank.js                # LBank V2 implementation (530 lines, 40 methods)
│   ├── phemex.js               # Phemex Spot implementation (580 lines, 42 methods)
│   ├── bitmart.js              # BitMart Spot implementation (600 lines, 48 methods)
│   ├── bitrue.js               # Bitrue Spot implementation (600 lines, 42 methods)
│   ├── bitforex.js             # Bitforex Spot implementation (500 lines, 35 methods)
│   ├── pionex.js               # Pionex — HMAC-SHA256 header-signing, DELETE with JSON body
│   ├── bibox.js                # Bibox — dual V3 HmacMD5 + V4 HmacSHA256, zlib WS, limit orders only
│   ├── whitebit.js             # WhiteBit — Base64+HMAC-SHA512, zlib Z_SYNC_FLUSH WS, all private POST
│   ├── valr.js                 # VALR — HMAC-SHA512 timestamp+method+path, DELETE with JSON body, ZAR pairs
│   ├── bitexen.js              # Bitexen — 4-credential HMAC-SHA256 uppercase, Socket.IO v2 WS, TRY pairs
│   └── utils/
│       ├── crypto.js           # HMAC-SHA256/384/512 + JWT/ES256 + MD5 + HmacMD5 + Base64-decoded + memo + path + Base64 + uppercase signing
│       ├── errors.js           # Typed error classes
│       ├── helpers.js          # Safe value extraction, query builders
│       ├── throttler.js        # Token-bucket rate limiter
│       └── ws.js               # WebSocket with auto-reconnect
├── examples/
│   ├── fetch-ticker.js         # Public market data demo
│   ├── place-order.js          # Trading demo
│   └── websocket-stream.js     # Real-time streaming demo
└── tests/
    ├── binance.test.js         # 82 tests — Binance implementation
    ├── bybit.test.js           # 83 tests — Bybit V5 implementation
    ├── okx.test.js             # 91 tests — OKX V5 implementation
    ├── kraken.test.js          # 86 tests — Kraken implementation
    ├── gateio.test.js          # 84 tests — Gate.io V4 implementation
    ├── kucoin.test.js          # 86 tests — KuCoin V1 implementation
    ├── coinbase.test.js        # 93 tests — Coinbase Advanced Trade implementation
    ├── bitfinex.test.js        # 97 tests — Bitfinex V2 implementation
    ├── bitstamp.test.js        # 91 tests — Bitstamp V2 implementation
    ├── bittrex.test.js         # 112 tests — Bittrex V3 implementation
    ├── lbank.test.js           # 110 tests — LBank V2 implementation
    ├── phemex.test.js          # 106 tests — Phemex Spot implementation
    ├── bitmart.test.js         # 108 tests — BitMart Spot implementation
    ├── bitrue.test.js          # 108 tests — Bitrue Spot implementation
    ├── bitforex.test.js        # 101 tests — Bitforex Spot implementation
    ├── pionex.test.js          # 101 tests — Pionex implementation
    ├── bibox.test.js           # 98 tests — Bibox dual-auth implementation
    ├── whitebit.test.js        # 94 tests — WhiteBit Base64+HMAC-SHA512 implementation
    ├── valr.test.js            # 97 tests — VALR HMAC-SHA512 implementation
    └── bitexen.test.js         # 101 tests — Bitexen 4-credential implementation
```

## Adding a New Exchange

Every exchange extends `BaseExchange` and implements:

```javascript
const BaseExchange = require('./BaseExchange');

class MyExchange extends BaseExchange {
  describe() {
    return {
      id: 'myexchange',
      name: 'My Exchange',
      version: 'v1',
      rateLimit: 100,
      urls: { api: 'https://api.myexchange.com' },
      has: { fetchTicker: true, createOrder: true, ... },
    };
  }

  _sign(path, method, params) {
    // Exchange-specific authentication
  }

  async loadMarkets() { /* ... */ }
  async fetchTicker(symbol) { /* ... */ }
  async createOrder(symbol, type, side, amount, price) { /* ... */ }
  // ... implement all supported methods
}
```

## Tests

```bash
npm test
```

```
▶ Module Exports (4 tests)
▶ Binance Constructor (7 tests)
▶ BaseExchange (1 test)
▶ Binance Authentication (5 tests)
▶ Binance Parsers (8 tests)
▶ Binance Error Mapping (9 tests)
▶ Binance Rate Limit Header Handling (2 tests)
▶ Binance API Methods — mocked (16 tests)
▶ Utility Functions (18 tests)
▶ Crypto Utilities (4 tests)
▶ Throttler (5 tests)
▶ Error Classes (4 tests)
▶ Binance market() lookup (3 tests)
▶ Module Exports — Bybit (3 tests)
▶ Bybit Constructor (10 tests)
▶ Bybit Authentication (6 tests)
▶ Bybit Response Unwrapping (4 tests)
▶ Bybit Parsers (10 tests)
▶ Bybit Helper Methods (3 tests)
▶ Bybit Error Mapping (13 tests)
▶ Bybit HTTP Error Handling (5 tests)
▶ Bybit Rate Limit Header Handling (3 tests)
▶ Bybit API Methods — mocked (20 tests)
▶ Bybit market() lookup (3 tests)
▶ Bybit vs Binance Differences (5 tests)
▶ Module Exports — OKX (3 tests)
▶ OKX Constructor (12 tests)
▶ OKX Authentication (9 tests)
▶ OKX Response Unwrapping (4 tests)
▶ OKX Parsers (9 tests)
▶ OKX Helper Methods (4 tests)
▶ OKX Error Mapping (12 tests)
▶ OKX HTTP Error Handling (5 tests)
▶ OKX Rate Limit Header Handling (3 tests)
▶ OKX API Methods — mocked (18 tests)
▶ OKX market() lookup (3 tests)
▶ OKX vs Binance/Bybit Differences (7 tests)
▶ Crypto — hmacSHA256Base64 (2 tests)
▶ Module Exports — Kraken (3 tests)
▶ Kraken Constructor (10 tests)
▶ Kraken Authentication (8 tests)
▶ Kraken Response Unwrapping (4 tests)
▶ Kraken Parsers (10 tests)
▶ Kraken Helper Methods (4 tests)
▶ Kraken Error Mapping (12 tests)
▶ Kraken HTTP Error Handling (5 tests)
▶ Kraken Rate Limit Headers (3 tests)
▶ Kraken Mocked API Calls (20 tests)
▶ Kraken Market Lookup (3 tests)
▶ Kraken vs Other Exchanges (7 tests)
▶ Crypto — krakenSign (3 tests)
▶ Module Exports — Gate.io (3 tests)
▶ Gateio Constructor (10 tests)
▶ Gate.io Authentication (8 tests)
▶ Gate.io Response Handling (4 tests)
▶ Gate.io Parsers (9 tests)
▶ Gate.io Helper Methods (4 tests)
▶ Gate.io Error Mapping (10 tests)
▶ Gate.io HTTP Error Handling (5 tests)
▶ Gate.io Rate Limit Headers (3 tests)
▶ Gate.io Mocked API Calls (17 tests)
▶ Gate.io Market Lookup (3 tests)
▶ Gate.io vs Others Differences (5 tests)
▶ Crypto — sha512 & hmacSHA512Hex (3 tests)
▶ Module Exports — KuCoin (3 tests)
▶ KuCoin Constructor (10 tests)
▶ KuCoin Authentication (8 tests)
▶ KuCoin Response Handling (4 tests)
▶ KuCoin Parsers (10 tests)
▶ KuCoin Helper Methods (4 tests)
▶ KuCoin Error Mapping (10 tests)
▶ KuCoin HTTP Error Handling (5 tests)
▶ KuCoin Rate Limit Handling (3 tests)
▶ KuCoin Mocked API Calls (18 tests)
▶ KuCoin Market Lookup (3 tests)
▶ KuCoin vs Others Differences (6 tests)
▶ Crypto — hmacSHA256Base64 for KuCoin (3 tests)
▶ Module Exports — Coinbase (3 tests)
▶ Coinbase Constructor (10 tests)
▶ Coinbase Authentication — JWT/ES256 (10 tests)
▶ Coinbase Response Handling (4 tests)
▶ Coinbase Parsers (10 tests)
▶ Coinbase Helper Methods (8 tests)
▶ Coinbase Error Mapping (10 tests)
▶ Coinbase HTTP Error Handling (5 tests)
▶ Coinbase Rate Limit Handling (3 tests)
▶ Coinbase Mocked API Calls (16 tests)
▶ Coinbase Market Lookup (3 tests)
▶ Coinbase vs Others Differences (8 tests)
▶ Crypto — signJWT + base64UrlEncode (3 tests)
▶ Module Exports — Bitfinex (3 tests)
▶ Bitfinex Constructor (10 tests)
▶ Bitfinex Authentication — HMAC-SHA384 (10 tests)
▶ Bitfinex Response Handling (5 tests)
▶ Bitfinex Parsers (12 tests)
▶ Bitfinex Helper Methods (13 tests)
▶ Bitfinex Error Mapping (10 tests)
▶ Bitfinex HTTP Error Handling (6 tests)
▶ Bitfinex Rate Limit Handling (3 tests)
▶ Bitfinex Mocked API Calls (16 tests)
▶ Bitfinex Market Lookup (3 tests)
▶ Bitfinex vs Other Exchanges (8 tests)
▶ Crypto — hmacSHA384Hex (3 tests)
▶ Module Exports — Bitstamp (3 tests)
▶ Bitstamp Constructor (8 tests)
▶ Bitstamp Authentication — HMAC-SHA256 + UUID nonce (10 tests)
▶ Bitstamp Response Handling (5 tests)
▶ Bitstamp Parsers (10 tests)
▶ Bitstamp Helper Methods (8 tests)
▶ Bitstamp Error Mapping (8 tests)
▶ Bitstamp HTTP Error Handling (6 tests)
▶ Bitstamp Rate Limit Handling (3 tests)
▶ Bitstamp Mocked API Calls (15 tests)
▶ Bitstamp Market Lookup (3 tests)
▶ Bitstamp vs Others Differences (8 tests)
▶ Crypto — hmacSHA256 (3 tests)
▶ Module Exports — Bittrex (3 tests)
▶ Bittrex Constructor (10 tests)
▶ Bittrex Authentication — HMAC-SHA512 + SHA512 content hash (10 tests)
▶ Bittrex Response Handling (5 tests)
▶ Bittrex Parsers (10 tests)
▶ Bittrex Helper Methods (8 tests)
▶ Bittrex Error Mapping (8 tests)
▶ Bittrex HTTP Error Handling (6 tests)
▶ Bittrex Rate Limit Handling (3 tests)
▶ Bittrex Mocked API Calls (15 tests)
▶ Bittrex Market Lookup (3 tests)
▶ Bittrex vs Others Differences (8 tests)
▶ Crypto — sha512 + hmacSHA512Hex (3 tests)
▶ Bittrex WebSocket — SignalR V3 (15 tests)
▶ Bittrex WebSocket — SignalR Message Dispatch (5 tests)
▶ Module Exports — LBank (3 tests)
▶ LBank Constructor (9 tests)
▶ LBank Authentication — MD5 + HMAC-SHA256 (10 tests)
▶ LBank Response Handling (5 tests)
▶ LBank Parsers (10 tests)
▶ LBank Helper Methods (8 tests)
▶ LBank Error Mapping (7 tests)
▶ LBank HTTP Error Handling (6 tests)
▶ LBank Rate Limit Handling (3 tests)
▶ LBank Mocked API Calls (15 tests)
▶ LBank Market Lookup (3 tests)
▶ LBank vs Others Differences (8 tests)
▶ Crypto — md5 + hmacSHA256 (3 tests)
▶ LBank WebSocket — V3 JSON subscribe (14 tests)
▶ LBank WebSocket — Message Dispatch (5 tests)
▶ LBank Version (1 test)
▶ Module Exports — Phemex (3 tests)
▶ Phemex Constructor (9 tests)
▶ Phemex Authentication — HMAC-SHA256 + Base64-decoded key (10 tests)
▶ Phemex Response Handling (5 tests)
▶ Phemex Parsers (9 tests)
▶ Phemex Helper Methods (8 tests)
▶ Phemex Error Mapping (7 tests)
▶ Phemex HTTP Error Handling (6 tests)
▶ Phemex Rate Limit Handling (3 tests)
▶ Phemex Mocked API Calls (13 tests)
▶ Phemex Market Lookup (3 tests)
▶ Phemex vs Others Differences (8 tests)
▶ Crypto — hmacSHA256 with Buffer key (3 tests)
▶ Phemex WebSocket — JSON-RPC subscribe (13 tests)
▶ Phemex WebSocket — Message Dispatch (5 tests)
▶ Phemex Version (1 test)
▶ Module Exports — BitMart (3 tests)
▶ BitMart Constructor (9 tests)
▶ BitMart Authentication — HMAC-SHA256 + memo (10 tests)
▶ BitMart Response Handling (5 tests)
▶ BitMart Parsers (9 tests)
▶ BitMart Helper Methods (8 tests)
▶ BitMart Error Mapping (8 tests)
▶ BitMart HTTP Error Handling (6 tests)
▶ BitMart Rate Limit Handling (3 tests)
▶ BitMart Mocked API Calls (14 tests)
▶ BitMart Market Lookup (3 tests)
▶ BitMart vs Others Differences (8 tests)
▶ Crypto — hmacSHA256 with memo (3 tests)
▶ BitMart WebSocket — zlib compressed subscribe (13 tests)
▶ BitMart WebSocket — Message Dispatch (5 tests)
▶ BitMart Version (1 test)
▶ Module Exports — Bitrue (3 tests)
▶ Bitrue Constructor (8 tests)
▶ Authentication — HMAC-SHA256 (10 tests)
▶ Response Handling (5 tests)
▶ Bitrue Parsers (9 tests)
▶ Bitrue Helper Methods (7 tests)
▶ Bitrue Error Mapping (10 tests)
▶ Bitrue HTTP Error Handling (6 tests)
▶ Bitrue Rate Limit Handling (3 tests)
▶ Bitrue Mocked API Calls (13 tests)
▶ Bitrue Market Lookup (3 tests)
▶ Bitrue vs Others Differences (8 tests)
▶ Crypto — hmacSHA256 (3 tests)
▶ WebSocket — gzip compressed (13 tests)
▶ WS Message Dispatch + Parsers (6 tests)
▶ Bitrue Version (1 test)
▶ Module Exports — Bitforex (3 tests)
▶ Bitforex Constructor (8 tests)
▶ Authentication — path-based HMAC-SHA256 (10 tests)
▶ Bitforex Response Handling (5 tests)
▶ Bitforex Parsers (8 tests)
▶ Bitforex Helper Methods (7 tests)
▶ Bitforex Error Mapping (8 tests)
▶ Bitforex HTTP Error Handling (6 tests)
▶ Bitforex Rate Limit Handling (3 tests)
▶ Bitforex Mocked API Calls (10 tests)
▶ Bitforex Market Lookup (3 tests)
▶ Bitforex vs Others Differences (8 tests)
▶ Crypto — hmacSHA256 (3 tests)
▶ WebSocket — string ping/pong (12 tests)
▶ WS Message Dispatch + Parsers (6 tests)
▶ Bitforex Version (1 test)
▶ Module Exports — Pionex (3 tests)
▶ Pionex Constructor (8 tests)
▶ Pionex Authentication — header-based HMAC-SHA256 (10 tests)
▶ Pionex Response Handling (5 tests)
▶ Pionex Parsers (8 tests)
▶ Pionex Helper Methods (7 tests)
▶ Pionex Error Mapping (8 tests)
▶ Pionex HTTP Error Handling (6 tests)
▶ Pionex Rate Limit Handling (3 tests)
▶ Pionex Mocked API Calls (10 tests)
▶ Pionex Market Lookup (3 tests)
▶ Pionex vs Others Differences (8 tests)
▶ Crypto — hmacSHA256 (3 tests)
▶ WebSocket — server PING/client PONG (12 tests)
▶ WS Message Dispatch + Parsers (6 tests)
▶ Pionex Version (1 test)
▶ Module Exports — Bibox (3 tests)
▶ Bibox Constructor (8 tests)
▶ Authentication — Dual V3 HmacMD5 + V4 HmacSHA256 (12 tests)
▶ Bibox Response Handling (5 tests)
▶ Bibox Parsers (8 tests)
▶ Bibox Helper Methods (7 tests)
▶ Bibox Error Mapping (8 tests)
▶ Bibox HTTP Error Handling (6 tests)
▶ Bibox Rate Limit Handling (3 tests)
▶ Bibox Mocked API Calls (8 tests)
▶ Bibox Market Lookup (3 tests)
▶ Bibox vs Others Differences (8 tests)
▶ Crypto — hmacMD5 + hmacSHA256 for Bibox (4 tests)
▶ WebSocket — client PING + zlib decompression (10 tests)
▶ Bibox WS Parsers (4 tests)
▶ Bibox Version (1 test)
▶ Module Exports — WhiteBit (3 tests)
▶ WhiteBit Constructor (8 tests)
▶ Authentication — Base64 + HMAC-SHA512 (10 tests)
▶ WhiteBit Response Handling (5 tests)
▶ WhiteBit Parsers (8 tests)
▶ WhiteBit Helper Methods (7 tests)
▶ WhiteBit Error Mapping (8 tests)
▶ WhiteBit HTTP Error Handling (6 tests)
▶ WhiteBit Rate Limit Handling (3 tests)
▶ WhiteBit Mocked API Calls (10 tests)
▶ WhiteBit Market Lookup (3 tests)
▶ WhiteBit vs Others Differences (8 tests)
▶ Crypto — hmacSHA512Hex for WhiteBit (3 tests)
▶ WebSocket — zlib Z_SYNC_FLUSH + client ping (10 tests)
▶ WhiteBit WS Parsers (4 tests)
▶ WhiteBit Version (1 test)
▶ Module Exports — VALR (3 tests)
▶ VALR Constructor (8 tests)
▶ Authentication — HMAC-SHA512 (timestamp+method+path+body) (10 tests)
▶ VALR Response Handling (5 tests)
▶ VALR Parsers (8 tests)
▶ VALR Helper Methods (7 tests)
▶ VALR Error Mapping (8 tests)
▶ VALR HTTP Error Handling (6 tests)
▶ VALR Rate Limit Handling (3 tests)
▶ VALR Mocked API Calls (10 tests)
▶ VALR Market Lookup (3 tests)
▶ VALR vs Others Differences (8 tests)
▶ Crypto — hmacSHA512Hex for VALR (3 tests)
▶ WebSocket — plain JSON + SUBSCRIBE (10 tests)
▶ VALR WS Parsers (4 tests)
▶ VALR Version (1 test)
▶ Module Exports — Bitexen (3 tests)
▶ Bitexen Constructor (10 tests)
▶ Authentication — HMAC-SHA256 uppercase + 4 credentials (12 tests)
▶ Bitexen Response Handling (5 tests)
▶ Bitexen Parsers (8 tests)
▶ Bitexen Helper Methods (7 tests)
▶ Bitexen Error Mapping (8 tests)
▶ Bitexen HTTP Error Handling (6 tests)
▶ Bitexen Rate Limit Handling (3 tests)
▶ Bitexen Mocked API Calls (10 tests)
▶ Bitexen Market Lookup (3 tests)
▶ Bitexen vs Others Differences (8 tests)
▶ Crypto — hmacSHA256 uppercase for Bitexen (4 tests)
▶ WebSocket — Socket.IO v2 + SID handshake (10 tests)
▶ Bitexen WS Parsers (4 tests)
▶ Bitexen Version (1 test)

1929 passing
```

## Roadmap

- [x] Binance Spot — Full REST + WebSocket (59 methods)
- [x] Bybit V5 — Full REST + WebSocket (45 methods)
- [x] OKX V5 — Full REST + WebSocket (42 methods)
- [x] Kraken — Full REST + WebSocket V2 (40 methods)
- [x] Gate.io V4 — Full REST + WebSocket (40 methods)
- [x] KuCoin V1 — Full REST + WebSocket (42 methods)
- [x] Coinbase Advanced Trade — Full REST + WebSocket (42 methods, JWT/ES256)
- [x] Bitfinex V2 — Full REST + WebSocket (42 methods, HMAC-SHA384)
- [x] Bitstamp V2 — Full REST + WebSocket (38 methods, HMAC-SHA256 + UUID nonce)
- [x] Bittrex V3 — Full REST + WebSocket (44 methods, HMAC-SHA512 + SHA512 content hash, SignalR V3)
- [x] LBank V2 — Full REST + WebSocket (40 methods, MD5+HMAC-SHA256 two-step signing, V3 JSON WS)
- [x] Phemex Spot — Full REST + WebSocket (42 methods, Base64-decoded HMAC-SHA256, Ep/Ev 10^8 scaling, JSON-RPC WS)
- [x] BitMart Spot — Full REST + WebSocket (48 methods, HMAC-SHA256+memo, zlib compressed WS, KEYED/SIGNED dual auth)
- [x] Bitrue Spot — Full REST + WebSocket (42 methods, HMAC-SHA256+URL-signature, gzip compressed WS, GTT timeInForce)
- [x] Bitforex Spot — Full REST + WebSocket (35 methods, HMAC-SHA256+path-signing, coin-quote-base symbols, limit orders only, plain text WS)
- [x] **Pionex** — HMAC-SHA256 header-signing, DELETE with JSON body, no REST market data, server PING/client PONG WS
- [x] **Bibox** — Dual V3 HmacMD5 + V4 HmacSHA256, zlib compressed WS, limit orders only, numeric order_side
- [x] **WhiteBit** — Base64+HMAC-SHA512 signing, all private endpoints POST, zlib Z_SYNC_FLUSH compressed WS, client-initiated ping
- [x] **VALR** — HMAC-SHA512 timestamp+method+path+body signing, DELETE with JSON body, concatenated ZAR pairs, plain JSON WS
- [x] **Bitexen** — 4-credential HMAC-SHA256 uppercase signing, Socket.IO v2 WS (SID handshake, Engine.IO keepalive), limit orders only, TRY pairs
- [ ] Futures/Margin support (Binance USDM, COINM)
- [ ] TypeScript type definitions
- [ ] npm publish

## Related Projects

- [crypto-exchange-connector-library](https://github.com/yuzgecoguz/crypto-exchange-connector-library) — Production connector framework for 50+ exchanges (2025)
- [crypto-triangular-arbitrage-engine](https://github.com/yuzgecoguz/crypto-triangular-arbitrage-engine) — 30-40ms triangular arbitrage engine (2022)
- [funding-rate-arbitrage-scanner](https://github.com/yuzgecoguz/funding-rate-arbitrage-scanner) — Delta-neutral funding rate strategy (2025)
- [ethereum-smart-contract-security-audit](https://github.com/yuzgecoguz/ethereum-smart-contract-security-audit) — Smart contract vulnerability detection benchmark (2025)
- [oracle-manipulation-attack-demo](https://github.com/yuzgecoguz/oracle-manipulation-attack-demo) — Flash loan oracle manipulation PoC (2025)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

**Oguzhan Yuzgec** — Blockchain Security & Quant Developer

- GitHub: [@yuzgecoguz](https://github.com/yuzgecoguz)
- LinkedIn: [oguzhan-yuzgec](https://www.linkedin.com/in/oguzhan-yuzgec-a72988182/)

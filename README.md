# YGCC — Cryptocurrency Exchange Library

[![npm version](https://img.shields.io/badge/npm-v1.6.0-blue)](https://www.npmjs.com/package/@ygcc/ygcc)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-605%20passing-brightgreen)](tests/)
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
- **Multi-Auth Support** — HMAC-SHA256/512 (hex, Base64), SHA512 (Kraken/Gate.io), JWT/ES256 (Coinbase)
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
| 8 | [Bitfinex](https://www.bitfinex.com) | `bitfinex` | 🔜 | 🔜 | Planned |
| 9 | [Bitstamp](https://www.bitstamp.net) | `bitstamp` | 🔜 | 🔜 | Planned |
| 10 | [Gemini](https://www.gemini.com) | `gemini` | 🔜 | 🔜 | Planned |
| 11 | [Crypto.com](https://crypto.com) | `cryptocom` | 🔜 | 🔜 | Planned |
| 12 | [Bittrex](https://bittrex.com) | `bittrex` | 🔜 | 🔜 | Planned |
| 13 | [Bitrue](https://www.bitrue.com) | `bitrue` | 🔜 | 🔜 | Planned |
| 14 | [LBANK](https://www.lbank.com) | `lbank` | 🔜 | 🔜 | Planned |
| 15 | [BitMart](https://www.bitmart.com) | `bitmart` | 🔜 | 🔜 | Planned |
| 16 | [Bitforex](https://www.bitforex.com) | `bitforex` | 🔜 | 🔜 | Planned |
| 17 | [Phemex](https://phemex.com) | `phemex` | 🔜 | 🔜 | Planned |
| 18 | [Pionex](https://www.pionex.com) | `pionex` | 🔜 | 🔜 | Planned |
| 19 | [Bibox](https://www.bibox.com) | `bibox` | 🔜 | 🔜 | Planned |
| 20 | [Bitexen](https://www.bitexen.com) | `bitexen` | 🔜 | 🔜 | Planned |
| 21 | [VALR](https://www.valr.com) | `valr` | 🔜 | 🔜 | Planned |
| 22 | [WhiteBit](https://whitebit.com) | `whitebit` | 🔜 | 🔜 | Planned |
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

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|
| `loadMarkets()` | Load trading pairs, filters, precision rules | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchTicker(symbol)` | 24hr price statistics | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchTickers(symbols?)` | All tickers at once | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchOrderBook(symbol, limit?)` | Bids & asks depth | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchTrades(symbol, since?, limit?)` | Recent public trades | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchOHLCV(symbol, timeframe?, since?, limit?)` | Candlestick / kline data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchAvgPrice(symbol)` | Current average price | ✅ | | | | | | |
| `fetchPrice(symbol?)` | Quick price lookup (lightweight) | ✅ | | | | | | |
| `fetchBookTicker(symbol?)` | Best bid/ask only | ✅ | | | | | | |
| `fetchTime()` | Server time | | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Trading (Private — Signed)

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|
| `createOrder(symbol, type, side, amount, price?, params?)` | Place any order type | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `createLimitOrder(symbol, side, amount, price)` | Limit order shortcut | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `createMarketOrder(symbol, side, amount)` | Market order shortcut | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cancelOrder(id, symbol)` | Cancel single order | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cancelAllOrders(symbol)` | Cancel all open orders | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `amendOrder(id, symbol, params)` | Modify existing order | ✅ | ✅ | ✅ | | | | |
| `createOCO(symbol, side, qty, price, stopPrice)` | One-Cancels-Other | ✅ | | | | | | |
| `createOTO(...)` | One-Triggers-Other | ✅ | | | | | | |
| `createOTOCO(...)` | One-Triggers-OCO | ✅ | | | | | | |
| `testOrder(...)` | Validate without placing | ✅ | | | | | | |

### Account (Private — Signed)

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|
| `fetchBalance()` | Account balances (free, used, total) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchOrder(id, symbol)` | Single order status | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchOpenOrders(symbol?)` | All open orders | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchClosedOrders(symbol, ...)` | Closed order history | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchMyTrades(symbol, ...)` | Trade history with fees | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchTradingFees(symbol)` | Maker/taker fee rates | | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fetchCommission(symbol)` | Maker/taker commission rates | ✅ | | | | | | |

### WebSocket Streams

| Method | Description | Binance | Bybit | OKX | Kraken | Gate.io | KuCoin | Coinbase |
|--------|-------------|---------|-------|-----|--------|---------|--------|----------|
| `watchTicker(symbol, callback)` | Real-time ticker | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `watchAllTickers(callback)` | All tickers stream | ✅ | | | | | | |
| `watchOrderBook(symbol, callback, levels?)` | Real-time order book | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `watchTrades(symbol, callback)` | Real-time trades | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `watchKlines(symbol, interval, callback)` | Real-time candlesticks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `watchBookTicker(symbol, callback)` | Real-time best bid/ask | ✅ | | | | | | |
| `watchBalance(callback)` | Balance updates (private) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `watchOrders(callback)` | Order updates (private) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

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
├── index.js                    # Entry point: const { Binance, Bybit, Okx, Kraken, Gateio, KuCoin, Coinbase } = require('@ygcc/ygcc')
├── lib/
│   ├── BaseExchange.js         # Abstract base class — unified interface
│   ├── binance.js              # Binance implementation (1369 lines, 59 methods)
│   ├── bybit.js                # Bybit V5 implementation (1021 lines, 45 methods)
│   ├── okx.js                  # OKX V5 implementation (690 lines, 42 methods)
│   ├── kraken.js               # Kraken implementation (680 lines, 40 methods)
│   ├── gateio.js               # Gate.io V4 implementation (700 lines, 40 methods)
│   ├── kucoin.js               # KuCoin V1 implementation (1033 lines, 42 methods)
│   ├── coinbase.js             # Coinbase Advanced Trade implementation (780 lines, 42 methods)
│   └── utils/
│       ├── crypto.js           # HMAC-SHA256/512 + JWT/ES256 signing
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
    └── coinbase.test.js        # 93 tests — Coinbase Advanced Trade implementation
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

605 passing
```

## Roadmap

- [x] Binance Spot — Full REST + WebSocket (59 methods)
- [x] Bybit V5 — Full REST + WebSocket (45 methods)
- [x] OKX V5 — Full REST + WebSocket (42 methods)
- [x] Kraken — Full REST + WebSocket V2 (40 methods)
- [x] Gate.io V4 — Full REST + WebSocket (40 methods)
- [x] KuCoin V1 — Full REST + WebSocket (42 methods)
- [x] Coinbase Advanced Trade — Full REST + WebSocket (42 methods, JWT/ES256)
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

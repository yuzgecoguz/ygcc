# Installation & Quick Start

This guide walks you through installing YGCC and making your first API calls across multiple cryptocurrency exchanges.

---

## 1. Installation

### Via npm

```bash
npm install @ygcc/ygcc
```

### Via Git Clone

```bash
git clone https://github.com/ygcc/ygcc.git
cd ygcc
npm install
```

After installation, you can import any supported exchange class directly:

```js
const { Binance } = require('@ygcc/ygcc');
```

---

## 2. Basic Usage — Fetch Market Data

All public endpoints (market data, tickers, order books) work without authentication.

### Load Markets

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
    // Load all available trading pairs
    const markets = await exchange.loadMarkets();
    console.log(`Loaded ${Object.keys(markets).length} markets`);

    // Access a specific market
    const btcUsdt = markets['BTC/USDT'];
    console.log('Symbol:', btcUsdt.symbol);
    console.log('Base:', btcUsdt.base);       // BTC
    console.log('Quote:', btcUsdt.quote);     // USDT
    console.log('Active:', btcUsdt.active);
})();
```

### Fetch Ticker

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log('Last Price:', ticker.last);
    console.log('24h High:', ticker.high);
    console.log('24h Low:', ticker.low);
    console.log('24h Volume:', ticker.baseVolume);
    console.log('Bid:', ticker.bid);
    console.log('Ask:', ticker.ask);
})();
```

### Fetch Order Book

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
    const orderBook = await exchange.fetchOrderBook('BTC/USDT', 10);
    console.log('Top Bid:', orderBook.bids[0]); // [price, amount]
    console.log('Top Ask:', orderBook.asks[0]); // [price, amount]
    console.log('Bid Count:', orderBook.bids.length);
    console.log('Ask Count:', orderBook.asks.length);
    console.log('Timestamp:', orderBook.timestamp);
})();
```

---

## 3. Place Orders

Private endpoints require API credentials. Pass them when constructing the exchange instance.

### Create a Limit Buy Order

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
});

(async () => {
    await exchange.loadMarkets();

    // Place a limit buy order: 0.001 BTC at $40,000
    const order = await exchange.createLimitOrder(
        'BTC/USDT',   // symbol
        'buy',        // side
        0.001,        // amount
        40000         // price
    );

    console.log('Order ID:', order.id);
    console.log('Status:', order.status);
    console.log('Symbol:', order.symbol);
    console.log('Type:', order.type);
    console.log('Side:', order.side);
    console.log('Price:', order.price);
    console.log('Amount:', order.amount);
})();
```

### Cancel an Order

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
});

(async () => {
    await exchange.loadMarkets();

    const orderId = '12345678';
    const result = await exchange.cancelOrder(orderId, 'BTC/USDT');
    console.log('Cancelled:', result.id);
    console.log('Status:', result.status); // 'canceled'
})();
```

### Fetch Account Balance

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
});

(async () => {
    const balance = await exchange.fetchBalance();

    // Total balances (free + used)
    console.log('BTC Total:', balance.total['BTC']);
    console.log('USDT Total:', balance.total['USDT']);

    // Available (free) balances
    console.log('BTC Free:', balance.free['BTC']);
    console.log('USDT Free:', balance.free['USDT']);

    // In-order (used) balances
    console.log('BTC Used:', balance.used['BTC']);
})();
```

---

## 4. WebSocket Streaming

YGCC provides real-time WebSocket streaming with a unified interface across all supported exchanges.

### Watch Ticker

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
    // Continuously receive real-time ticker updates
    while (true) {
        const ticker = await exchange.watchTicker('BTC/USDT');
        console.log(`${ticker.symbol} | Last: ${ticker.last} | Bid: ${ticker.bid} | Ask: ${ticker.ask}`);
    }
})();
```

### Watch Order Book

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
    while (true) {
        const orderBook = await exchange.watchOrderBook('BTC/USDT');
        const bestBid = orderBook.bids[0];
        const bestAsk = orderBook.asks[0];
        console.log(`Bid: ${bestBid[0]} (${bestBid[1]}) | Ask: ${bestAsk[0]} (${bestAsk[1]})`);
    }
})();
```

### Watch Trades

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
    while (true) {
        const trades = await exchange.watchTrades('BTC/USDT');
        for (const trade of trades) {
            console.log(`${trade.side.toUpperCase()} ${trade.amount} @ ${trade.price} | ${new Date(trade.timestamp).toISOString()}`);
        }
    }
})();
```

### Closing WebSocket Connections

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance();

(async () => {
    // Start streaming
    const ticker = await exchange.watchTicker('BTC/USDT');
    console.log('Connected:', ticker.last);

    // Close all WebSocket connections when done
    await exchange.closeAllWs();
    console.log('All WebSocket connections closed');
})();
```

---

## 5. Using Other Exchanges

YGCC provides a unified interface. The same methods work across all exchanges, though each exchange may have its own credential requirements or symbol formatting.

### Bybit (V5 API)

Bybit uses API version V5 internally, but YGCC abstracts this away. The interface remains identical.

```js
const { Bybit } = require('@ygcc/ygcc');

const exchange = new Bybit({
    apiKey: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_SECRET,
});

(async () => {
    await exchange.loadMarkets();
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log('Bybit BTC/USDT:', ticker.last);

    const balance = await exchange.fetchBalance();
    console.log('USDT Balance:', balance.free['USDT']);
})();
```

### OKX (Passphrase Required)

OKX requires a passphrase in addition to API key and secret. Note that OKX uses the `BTC-USDT` format in its native API, but YGCC normalizes symbols to `BTC/USDT`.

```js
const { OKX } = require('@ygcc/ygcc');

const exchange = new OKX({
    apiKey: process.env.OKX_API_KEY,
    secret: process.env.OKX_SECRET,
    password: process.env.OKX_PASSPHRASE,  // required for OKX
});

(async () => {
    await exchange.loadMarkets();
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log('OKX BTC/USDT:', ticker.last);

    const order = await exchange.createLimitOrder('ETH/USDT', 'buy', 0.1, 2500);
    console.log('Order placed:', order.id);
})();
```

### Kraken (SHA256 + HMAC-SHA512)

Kraken uses a unique two-step signing process (SHA256 followed by HMAC-SHA512). YGCC handles this internally. Kraken uses `BTC/USD` (fiat pairs) as well as `BTC/USDT`.

```js
const { Kraken } = require('@ygcc/ygcc');

const exchange = new Kraken({
    apiKey: process.env.KRAKEN_API_KEY,
    secret: process.env.KRAKEN_SECRET,
});

(async () => {
    await exchange.loadMarkets();
    const ticker = await exchange.fetchTicker('BTC/USD');
    console.log('Kraken BTC/USD:', ticker.last);

    const orderBook = await exchange.fetchOrderBook('ETH/USD', 5);
    console.log('Top Bid:', orderBook.bids[0]);
})();
```

### KuCoin (Passphrase + Auto-generated clientOid)

KuCoin requires a passphrase and automatically generates a `clientOid` for each order to ensure idempotency.

```js
const { KuCoin } = require('@ygcc/ygcc');

const exchange = new KuCoin({
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_SECRET,
    password: process.env.KUCOIN_PASSPHRASE,  // required for KuCoin
});

(async () => {
    await exchange.loadMarkets();
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log('KuCoin BTC/USDT:', ticker.last);

    // clientOid is automatically generated
    const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 40000);
    console.log('Order ID:', order.id);
    console.log('Client Order ID:', order.clientOrderId);
})();
```

---

## 6. Testnet / Sandbox Mode

Many exchanges offer testnet (sandbox) environments for development and testing. Enable sandbox mode by setting `sandbox: true` in the configuration.

> **Important:** Testnet API keys are separate from production keys. You must create API keys on the exchange's testnet portal.

### Binance Testnet

```js
const { Binance } = require('@ygcc/ygcc');

const exchange = new Binance({
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    secret: process.env.BINANCE_TESTNET_SECRET,
    sandbox: true,  // connects to testnet.binance.vision
});

(async () => {
    await exchange.loadMarkets();
    const balance = await exchange.fetchBalance();
    console.log('Testnet USDT:', balance.free['USDT']);

    // Place a test order
    const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.001, 30000);
    console.log('Testnet order:', order.id);
})();
```

### Bybit Testnet

```js
const { Bybit } = require('@ygcc/ygcc');

const exchange = new Bybit({
    apiKey: process.env.BYBIT_TESTNET_API_KEY,
    secret: process.env.BYBIT_TESTNET_SECRET,
    sandbox: true,  // connects to api-testnet.bybit.com
});

(async () => {
    await exchange.loadMarkets();
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log('Bybit Testnet BTC/USDT:', ticker.last);
})();
```

### OKX Demo Trading

```js
const { OKX } = require('@ygcc/ygcc');

const exchange = new OKX({
    apiKey: process.env.OKX_DEMO_API_KEY,
    secret: process.env.OKX_DEMO_SECRET,
    password: process.env.OKX_DEMO_PASSPHRASE,
    sandbox: true,  // connects to OKX demo trading environment
});

(async () => {
    await exchange.loadMarkets();
    const balance = await exchange.fetchBalance();
    console.log('Demo USDT:', balance.free['USDT']);

    const order = await exchange.createLimitOrder('BTC/USDT', 'buy', 0.01, 35000);
    console.log('Demo order:', order.id);
})();
```

---

## Next Steps

- **[Authentication Guide](authentication.md)** -- Learn about the 22+ authentication patterns supported by YGCC.
- **[API Reference](api-reference.md)** -- Full method documentation for all exchange classes.
- **[Exchange Guides](exchanges.md)** -- Detailed guides for each supported exchange.

'use strict';

/**
 * Example: WebSocket streaming from Binance
 *
 * Usage:
 *   node examples/websocket-stream.js                    # Watch BTCUSDT ticker
 *   node examples/websocket-stream.js ETHUSDT orderbook  # Watch ETHUSDT order book
 *   node examples/websocket-stream.js BTCUSDT trades     # Watch BTCUSDT trades
 *   node examples/websocket-stream.js BTCUSDT klines     # Watch BTCUSDT 1m klines
 *   node examples/websocket-stream.js BTCUSDT all        # Watch all streams at once
 *
 * For private streams (balance/orders):
 *   BINANCE_API_KEY=xxx BINANCE_SECRET=yyy node examples/websocket-stream.js private
 *
 * Press Ctrl+C to stop.
 */

const { Binance } = require('../');

const exchange = new Binance({
  apiKey: process.env.BINANCE_API_KEY || '',
  secret: process.env.BINANCE_SECRET || '',
  enableRateLimit: true,
});

const symbol = process.argv[2] || 'BTCUSDT';
const mode = process.argv[3] || 'ticker';

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nClosing WebSocket connections...');
  await exchange.closeAllWs();
  process.exit(0);
});

async function watchTicker() {
  console.log(`Watching ${symbol} ticker...`);
  await exchange.watchTicker(symbol, (ticker) => {
    console.log(
      `[${ticker.datetime}] ${ticker.symbol} ` +
      `Last: ${ticker.last} | Bid: ${ticker.bid} Ask: ${ticker.ask} | ` +
      `Vol: ${ticker.volume} | ${ticker.percentage}%`
    );
  });
}

async function watchOrderBook() {
  console.log(`Watching ${symbol} order book (top 5)...`);
  await exchange.watchOrderBook(symbol, (book) => {
    console.log(`\n--- ${symbol} Order Book ---`);
    console.log('Asks:');
    for (const [p, q] of book.asks.slice(0, 5).reverse()) {
      console.log(`  ${p.toFixed(2).padStart(12)} | ${q}`);
    }
    console.log('  ------------|----------');
    console.log('Bids:');
    for (const [p, q] of book.bids.slice(0, 5)) {
      console.log(`  ${p.toFixed(2).padStart(12)} | ${q}`);
    }
  }, 5);
}

async function watchTrades() {
  console.log(`Watching ${symbol} trades...`);
  await exchange.watchTrades(symbol, (trade) => {
    const side = trade.side === 'buy' ? '\x1b[32mBUY \x1b[0m' : '\x1b[31mSELL\x1b[0m';
    console.log(
      `[${trade.datetime}] ${side} ${trade.amount} @ ${trade.price} = $${trade.cost.toFixed(2)}`
    );
  });
}

async function watchKlines() {
  console.log(`Watching ${symbol} 1m klines...`);
  await exchange.watchKlines(symbol, '1m', (kline) => {
    const status = kline.closed ? 'CLOSED' : 'LIVE  ';
    console.log(
      `[${new Date(kline.timestamp).toISOString()}] ${status} ` +
      `O:${kline.open} H:${kline.high} L:${kline.low} C:${kline.close} V:${kline.volume}`
    );
  });
}

async function watchBookTicker() {
  console.log(`Watching ${symbol} book ticker...`);
  await exchange.watchBookTicker(symbol, (bt) => {
    const spread = (bt.ask - bt.bid).toFixed(2);
    console.log(
      `${bt.symbol} Bid: ${bt.bid} (${bt.bidVolume}) | Ask: ${bt.ask} (${bt.askVolume}) | Spread: ${spread}`
    );
  });
}

async function watchPrivateStreams() {
  if (!exchange.apiKey || !exchange.secret) {
    console.error('ERROR: BINANCE_API_KEY and BINANCE_SECRET environment variables required.');
    process.exit(1);
  }

  console.log('Watching balance and order updates...');

  await exchange.watchBalance((data) => {
    if (data.event === 'balance') {
      console.log('\n[Balance Update]');
      for (const [asset, b] of Object.entries(data.balances)) {
        console.log(`  ${asset}: free=${b.free}, used=${b.used}, total=${b.total}`);
      }
    } else if (data.event === 'balanceUpdate') {
      console.log(`[Balance Delta] ${data.asset}: ${data.delta > 0 ? '+' : ''}${data.delta}`);
    }
  });

  await exchange.watchOrders((order) => {
    if (order.event === 'order') {
      console.log(
        `\n[Order ${order.executionType}] ${order.symbol} ${order.side} ${order.type} ` +
        `${order.amount} @ ${order.price} — ${order.status} ` +
        `(filled: ${order.filled}/${order.amount})`
      );
    }
  });
}

async function watchAll() {
  console.log(`Watching all public streams for ${symbol}...`);
  await Promise.all([
    watchTicker(),
    watchBookTicker(),
    watchTrades(),
    watchKlines(),
  ]);
}

async function main() {
  const handlers = {
    ticker: watchTicker,
    orderbook: watchOrderBook,
    trades: watchTrades,
    klines: watchKlines,
    bookticker: watchBookTicker,
    private: watchPrivateStreams,
    all: watchAll,
  };

  const handler = handlers[mode.toLowerCase()];
  if (!handler) {
    console.error(`Unknown mode: ${mode}`);
    console.error(`Available modes: ${Object.keys(handlers).join(', ')}`);
    process.exit(1);
  }

  await handler();
  console.log('WebSocket connected. Press Ctrl+C to stop.\n');
}

main().catch(console.error);

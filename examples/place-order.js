'use strict';

/**
 * Example: Place, query, and cancel orders on Binance (PRIVATE — API key required)
 *
 * Usage:
 *   BINANCE_API_KEY=xxx BINANCE_SECRET=yyy node examples/place-order.js
 *
 * ⚠ WARNING: This will attempt to place REAL orders.
 *   Use testnet (options.sandbox: true) for safe testing.
 */

const { Binance } = require('../');

async function main() {
  const exchange = new Binance({
    apiKey: process.env.BINANCE_API_KEY || '',
    secret: process.env.BINANCE_SECRET || '',
    enableRateLimit: true,
    options: {
      sandbox: Boolean(process.env.BINANCE_TESTNET), // Set BINANCE_TESTNET=1 for testnet
    },
  });

  const symbol = 'BTCUSDT';

  // Load markets first (required for precision info)
  await exchange.loadMarkets();

  // 1) Check balance
  console.log('=== Balances ===');
  const balance = await exchange.fetchBalance();
  for (const [asset, b] of Object.entries(balance)) {
    if (typeof b === 'object' && b.total > 0) {
      console.log(`  ${asset}: free=${b.free}, used=${b.used}, total=${b.total}`);
    }
  }
  console.log();

  // 2) Test order (validates without placing)
  console.log('=== Test Order ===');
  const testResult = await exchange.testOrder(symbol, 'LIMIT', 'BUY', 0.001, 50000);
  console.log('Test order result:', testResult || '(valid — no error)');
  console.log();

  // 3) Place a limit buy order (far below market price — won't fill)
  console.log('=== Place Limit Order ===');
  const order = await exchange.createLimitOrder(symbol, 'BUY', 0.001, 50000);
  console.log('Order placed:');
  console.log(`  ID: ${order.id}`);
  console.log(`  Symbol: ${order.symbol}`);
  console.log(`  Type: ${order.type} | Side: ${order.side}`);
  console.log(`  Price: ${order.price} | Amount: ${order.amount}`);
  console.log(`  Status: ${order.status}`);
  console.log();

  // 4) Fetch the order back
  console.log('=== Fetch Order ===');
  const fetched = await exchange.fetchOrder(order.id, symbol);
  console.log(`  Status: ${fetched.status} | Filled: ${fetched.filled}/${fetched.amount}`);
  console.log();

  // 5) List open orders
  console.log('=== Open Orders ===');
  const openOrders = await exchange.fetchOpenOrders(symbol);
  console.log(`  ${openOrders.length} open order(s) on ${symbol}`);
  for (const o of openOrders) {
    console.log(`  [${o.id}] ${o.side} ${o.amount} @ ${o.price} — ${o.status}`);
  }
  console.log();

  // 6) Cancel the order
  console.log('=== Cancel Order ===');
  const canceled = await exchange.cancelOrder(order.id, symbol);
  console.log(`  Canceled order ${canceled.id} — new status: ${canceled.status}`);
  console.log();

  // 7) Fetch my trades
  console.log('=== My Trades (last 5) ===');
  const myTrades = await exchange.fetchMyTrades(symbol, undefined, 5);
  if (myTrades.length === 0) {
    console.log('  No trades found.');
  }
  for (const t of myTrades) {
    console.log(`  [${t.id}] ${t.datetime} | Price: ${t.price} | Amount: ${t.amount} | Fee: ${t.fee.cost} ${t.fee.currency}`);
  }
  console.log();

  // 8) Commission rates
  console.log('=== Commission ===');
  const comm = await exchange.fetchCommission(symbol);
  console.log(`  Maker: ${comm.maker} | Taker: ${comm.taker}`);
  console.log();

  console.log('Done. Rate limit weight used:', exchange._weightUsed);
}

main().catch(console.error);

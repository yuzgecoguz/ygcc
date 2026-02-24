'use strict';

/**
 * Example: Fetch market data from Binance (PUBLIC — no API key needed)
 *
 * Usage:
 *   node examples/fetch-ticker.js
 *   node examples/fetch-ticker.js ETHUSDT
 */

const { Binance } = require('../');

async function main() {
  const exchange = new Binance({ enableRateLimit: true });

  const symbol = process.argv[2] || 'BTCUSDT';

  // 1) Server connectivity
  console.log('=== Ping ===');
  await exchange.ping();
  console.log('Binance API is reachable.\n');

  // 2) Server time
  console.log('=== Server Time ===');
  const serverTime = await exchange.fetchTime();
  console.log('Server time:', new Date(serverTime).toISOString(), '\n');

  // 3) Load markets (exchange info)
  console.log('=== Load Markets ===');
  const markets = await exchange.loadMarkets();
  console.log(`Loaded ${exchange.symbols.length} symbols.`);
  const btc = markets[symbol];
  if (btc) {
    console.log(`${symbol} — Status: ${btc.status}, Base: ${btc.base}, Quote: ${btc.quote}`);
    console.log(`  Price precision: ${btc.precision.price}, Amount precision: ${btc.precision.amount}`);
    console.log(`  Tick size: ${btc.tickSize}, Step size: ${btc.stepSize}`);
  }
  console.log();

  // 4) 24hr Ticker
  console.log(`=== 24hr Ticker — ${symbol} ===`);
  const ticker = await exchange.fetchTicker(symbol);
  console.log(`  Last: ${ticker.last}`);
  console.log(`  High: ${ticker.high}  Low: ${ticker.low}`);
  console.log(`  Bid: ${ticker.bid}  Ask: ${ticker.ask}`);
  console.log(`  Volume: ${ticker.volume}`);
  console.log(`  Change: ${ticker.change} (${ticker.percentage}%)`);
  console.log();

  // 5) Order Book (top 5)
  console.log(`=== Order Book — ${symbol} (top 5) ===`);
  const book = await exchange.fetchOrderBook(symbol, 5);
  console.log('  Bids:');
  for (const [price, qty] of book.bids) {
    console.log(`    ${price} — ${qty}`);
  }
  console.log('  Asks:');
  for (const [price, qty] of book.asks) {
    console.log(`    ${price} — ${qty}`);
  }
  console.log();

  // 6) Recent trades (last 5)
  console.log(`=== Recent Trades — ${symbol} (last 5) ===`);
  const trades = await exchange.fetchTrades(symbol, undefined, 5);
  for (const t of trades) {
    console.log(`  ${t.datetime} | Price: ${t.price} | Amount: ${t.amount} | ${t.isBuyerMaker ? 'SELL' : 'BUY'}`);
  }
  console.log();

  // 7) OHLCV (last 5 hourly candles)
  console.log(`=== OHLCV — ${symbol} (1h, last 5) ===`);
  const candles = await exchange.fetchOHLCV(symbol, '1h', undefined, 5);
  console.log('  [timestamp, open, high, low, close, volume]');
  for (const c of candles) {
    console.log(`  ${new Date(c[0]).toISOString()} | O:${c[1]} H:${c[2]} L:${c[3]} C:${c[4]} V:${c[5]}`);
  }
  console.log();

  // 8) Average price
  console.log(`=== Average Price — ${symbol} ===`);
  const avg = await exchange.fetchAvgPrice(symbol);
  console.log(`  ${avg.price} (${avg.mins}-min average)`);
  console.log();

  // 9) Best bid/ask (book ticker — lightweight)
  console.log(`=== Book Ticker — ${symbol} ===`);
  const bt = await exchange.fetchBookTicker(symbol);
  console.log(`  Bid: ${bt.bid} (${bt.bidVolume}) | Ask: ${bt.ask} (${bt.askVolume})`);
  console.log();

  // 10) Price only (super lightweight)
  console.log(`=== Quick Price — ${symbol} ===`);
  const p = await exchange.fetchPrice(symbol);
  console.log(`  ${p.price}\n`);

  console.log('Done. Rate limit weight used:', exchange._weightUsed);
}

main().catch(console.error);

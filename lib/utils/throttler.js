'use strict';

const { sleep } = require('./helpers');

/**
 * Token-bucket rate limiter.
 * Supports weight-based consumption (e.g., Binance uses different weights per endpoint).
 */
class Throttler {
  constructor({ capacity = 1200, refillRate = 1200, refillInterval = 60000 } = {}) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.refillInterval = refillInterval;
    this._lastRefill = Date.now();
    this._queue = [];
    this._processing = false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this._lastRefill;
    if (elapsed > 0) {
      const tokensToAdd = (elapsed / this.refillInterval) * this.refillRate;
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this._lastRefill = now;
    }
  }

  /**
   * Consume tokens, waiting if necessary.
   * @param {number} weight - Number of tokens to consume
   */
  async consume(weight = 1) {
    this._refill();
    if (this.tokens >= weight) {
      this.tokens -= weight;
      return;
    }
    // Calculate wait time
    const deficit = weight - this.tokens;
    const waitMs = (deficit / this.refillRate) * this.refillInterval;
    await sleep(Math.ceil(waitMs));
    this._refill();
    this.tokens -= weight;
  }

  /**
   * Try to consume tokens without waiting.
   * @returns {boolean} true if tokens were available
   */
  tryConsume(weight = 1) {
    this._refill();
    if (this.tokens >= weight) {
      this.tokens -= weight;
      return true;
    }
    return false;
  }

  /**
   * Update tokens from exchange response headers (authoritative source).
   */
  updateFromHeader(usedWeight) {
    this.tokens = Math.max(0, this.capacity - usedWeight);
    this._lastRefill = Date.now();
  }

  getStatus() {
    this._refill();
    return {
      available: Math.floor(this.tokens),
      capacity: this.capacity,
      usage: Math.round(((this.capacity - this.tokens) / this.capacity) * 100),
    };
  }
}

module.exports = Throttler;

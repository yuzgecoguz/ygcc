'use strict';

function safeFloat(obj, key, defaultValue = undefined) {
  if (obj === undefined || obj === null) return defaultValue;
  const val = obj[key];
  if (val === undefined || val === null || val === '') return defaultValue;
  const n = parseFloat(val);
  return isNaN(n) ? defaultValue : n;
}

function safeString(obj, key, defaultValue = undefined) {
  if (obj === undefined || obj === null) return defaultValue;
  const val = obj[key];
  return (val !== undefined && val !== null) ? String(val) : defaultValue;
}

function safeInteger(obj, key, defaultValue = undefined) {
  if (obj === undefined || obj === null) return defaultValue;
  const val = obj[key];
  if (val === undefined || val === null || val === '') return defaultValue;
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultValue : n;
}

function safeValue(obj, key, defaultValue = undefined) {
  if (obj === undefined || obj === null) return defaultValue;
  const val = obj[key];
  return (val !== undefined && val !== null) ? val : defaultValue;
}

function safeStringUpper(obj, key, defaultValue = undefined) {
  const val = safeString(obj, key, defaultValue);
  return val !== undefined ? val.toUpperCase() : defaultValue;
}

function safeStringLower(obj, key, defaultValue = undefined) {
  const val = safeString(obj, key, defaultValue);
  return val !== undefined ? val.toLowerCase() : defaultValue;
}

function safeFloat2(obj, key1, key2, defaultValue = undefined) {
  const val = safeFloat(obj, key1);
  return val !== undefined ? val : safeFloat(obj, key2, defaultValue);
}

function safeString2(obj, key1, key2, defaultValue = undefined) {
  const val = safeString(obj, key1);
  return val !== undefined ? val : safeString(obj, key2, defaultValue);
}

/**
 * Sort object keys alphabetically and build URL-encoded query string
 */
function buildQuery(params) {
  const keys = Object.keys(params).sort();
  return keys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
}

/**
 * Build query string WITHOUT url-encoding (for Binance signature)
 */
function buildQueryRaw(params) {
  const keys = Object.keys(params);
  return keys
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function iso8601(timestamp) {
  if (timestamp === undefined || timestamp === null) return undefined;
  return new Date(timestamp).toISOString();
}

function parseDate(dateStr) {
  if (!dateStr) return undefined;
  const ts = Date.parse(dateStr);
  return isNaN(ts) ? undefined : ts;
}

/**
 * Deep merge two objects. Second object overrides first.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  safeFloat,
  safeString,
  safeInteger,
  safeValue,
  safeStringUpper,
  safeStringLower,
  safeFloat2,
  safeString2,
  buildQuery,
  buildQueryRaw,
  iso8601,
  parseDate,
  deepMerge,
  sleep,
};

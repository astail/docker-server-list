'use strict';

// Bad numbers here turn into hot loops against the Docker API, so nothing is
// coerced silently: an unparseable or out-of-range value stops the process
// with the variable name and the range it wanted.
function fail(name, raw, expected) {
  console.error(`[config] ${name}=${JSON.stringify(raw)} は不正です。${expected}`);
  process.exit(1);
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(name, raw, `${min}〜${max} の整数を指定してください。`);
  }
  return value;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return fail(name, raw, '1 / 0 (true / false) を指定してください。');
}

function strEnv(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

module.exports = { intEnv, boolEnv, strEnv };

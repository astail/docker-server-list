'use strict';

const http = require('node:http');

// `req.setTimeout` is an *idle* timer: a peer that dribbles a byte just under
// the limit keeps the request alive indefinitely, which is enough to wedge a
// collection loop that awaits it. Everything here gets a wall-clock deadline
// and a hard response-size cap instead.
function getJson(target, path, { deadlineMs, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`GET ${path} が ${deadlineMs}ms を超過`)),
      deadlineMs,
    );

    req = http.request({ ...target, path, method: 'GET' }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          finish(new Error(`GET ${path} の応答が ${maxBytes} バイトを超過`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', finish);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(new Error(`GET ${path} -> HTTP ${res.statusCode}`));
          return;
        }
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          finish(new Error(`GET ${path} -> JSON として解釈できません`));
        }
      });
    });

    req.on('error', finish);
    req.end();
  });
}

// Bounded fan-out so a host with hundreds of containers cannot open hundreds
// of sockets at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { getJson, mapLimit };

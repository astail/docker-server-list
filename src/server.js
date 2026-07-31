'use strict';

// The browser-facing tier. It serves four static files, enforces optional
// Basic auth, and relays an already-shaped snapshot from the collector. It has
// no route to the Docker socket and no Docker credentials, so compromising
// this process yields the same data the dashboard shows and nothing more.

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { intEnv, boolEnv, strEnv } = require('./lib/config');
const { getJson } = require('./lib/httpget');

const LISTEN_PORT = intEnv('PORT', 8080, { min: 1, max: 65535 });
const PUBLIC_DIR = path.join(__dirname, 'public');

const COLLECTOR_HOST = strEnv('COLLECTOR_HOST', 'collector');
const COLLECTOR_PORT = intEnv('COLLECTOR_PORT', 8081, { min: 1, max: 65535 });
const COLLECTOR_DEADLINE_MS = intEnv('COLLECTOR_DEADLINE_MS', 10000, { min: 500, max: 60000 });
const collectorTarget = { host: COLLECTOR_HOST, port: COLLECTOR_PORT };

// Optional HTTP Basic auth. Both must be set for it to engage; a half-filled
// .env can never silently pass.
const AUTH_USER = strEnv('AUTH_USER', '');
const AUTH_PASSWORD = strEnv('AUTH_PASSWORD', '');
const AUTH_ENABLED = AUTH_USER !== '' && AUTH_PASSWORD !== '';
const AUTH_REALM = 'docker-server-list';
const AUTH_MAX_FAILURES = intEnv('AUTH_MAX_FAILURES', 10, { min: 1, max: 1000 });
const AUTH_LOCKOUT_MS = intEnv('AUTH_LOCKOUT_MS', 60000, { min: 1000, max: 3600000 });

// Behind a TLS terminator every request arrives from the proxy's address, so
// keying the lockout on the socket would let one attacker lock out everybody.
// Only consult X-Forwarded-For when the operator states a proxy is in front —
// trusting it unconditionally would instead make the lockout trivial to evade.
const TRUST_PROXY = boolEnv('TRUST_PROXY', false);

// ---------------------------------------------------------------- static

// Routes are an explicit allowlist rather than a path derived from the URL, so
// there is no traversal surface to get wrong. Files are baked into the image
// and read once at startup.
const STATIC_ROUTES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

const staticAssets = new Map();

function loadStatic() {
  for (const [route, [file, type]] of STATIC_ROUTES) {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    staticAssets.set(route, { body, type, etag });
  }
}

// ------------------------------------------------------------------- auth

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const AUTH_USER_HASH = sha256(AUTH_USER);
const AUTH_PASSWORD_HASH = sha256(AUTH_PASSWORD);

const authFailures = new Map();

function clientKey(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      // The last hop is the address our own proxy observed; earlier entries
      // are attacker-supplied and must not be used.
      const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1];
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function lockedOut(key) {
  const entry = authFailures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    authFailures.delete(key);
    return false;
  }
  return entry.count >= AUTH_MAX_FAILURES;
}

function noteAuthFailure(key) {
  // Bounded so a flood of spoofed sources cannot grow this map without limit.
  if (authFailures.size > 1024) {
    for (const [existing, entry] of authFailures) {
      if (Date.now() > entry.until) authFailures.delete(existing);
    }
    if (authFailures.size > 1024) authFailures.clear();
  }
  const entry = authFailures.get(key) ?? { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + AUTH_LOCKOUT_MS;
  authFailures.set(key, entry);
}

function credentialsMatch(header) {
  const match = /^Basic +([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!match) return false;

  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }

  const split = decoded.indexOf(':');
  if (split < 0) return false;

  // Hashing first keeps both comparisons fixed-length and constant-time.
  const userOk = crypto.timingSafeEqual(sha256(decoded.slice(0, split)), AUTH_USER_HASH);
  const passOk = crypto.timingSafeEqual(sha256(decoded.slice(split + 1)), AUTH_PASSWORD_HASH);
  return userOk && passOk;
}

// -------------------------------------------------------------- http server

const SECURITY_HEADERS = {
  // The UI loads no third-party anything, so everything but same-origin is
  // denied outright. 'data:' covers the inline SVG favicon.
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // Keeps the dashboard URL out of the Referer sent to the services it links to.
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), usb=()',
  'cross-origin-resource-policy': 'same-origin',
};

// Browsers ignore COOP outside a secure context and log an error for it, so
// only send it when a reverse proxy tells us the client side is TLS.
const behindTls = (req) => req.headers['x-forwarded-proto'] === 'https';

function send(req, res, status, headers, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(behindTls(req) ? { 'cross-origin-opener-policy': 'same-origin' } : {}),
    ...headers,
  });
  // Node omits the body for HEAD on its own, but being explicit keeps the
  // content-length above honest.
  res.end(req.method === 'HEAD' ? undefined : body);
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };

async function handle(req, res, urlPath) {
  if (urlPath === '/api/containers') {
    let snapshot;
    try {
      snapshot = await getJson(collectorTarget, '/snapshot', { deadlineMs: COLLECTOR_DEADLINE_MS });
    } catch (err) {
      console.error(`[collector] ${err.message}`);
      send(req, res, 503, JSON_HEADERS, JSON.stringify({ error: 'collector unreachable' }));
      return;
    }
    const body = JSON.stringify(snapshot);
    send(req, res, 200, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) }, body);
    return;
  }

  const asset = staticAssets.get(urlPath);
  if (!asset) {
    send(req, res, 404, TEXT_HEADERS, 'not found');
    return;
  }

  if (req.headers['if-none-match'] === asset.etag) {
    send(req, res, 304, { etag: asset.etag, 'cache-control': 'no-cache' });
    return;
  }

  send(req, res, 200, {
    'content-type': asset.type,
    'cache-control': 'no-cache',
    etag: asset.etag,
    'content-length': asset.body.length,
  }, asset.body);
}

const server = http.createServer((req, res) => {
  req.resume(); // drain any body so the socket closes cleanly

  let urlPath;
  try {
    urlPath = new URL(req.url, 'http://localhost').pathname;
  } catch {
    send(req, res, 400, TEXT_HEADERS, 'bad request');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, { allow: 'GET, HEAD', ...TEXT_HEADERS }, 'method not allowed');
    return;
  }

  // Unauthenticated because the container healthcheck runs without
  // credentials. It reveals only whether collection is current.
  if (urlPath === '/healthz') {
    getJson(collectorTarget, '/healthz', { deadlineMs: COLLECTOR_DEADLINE_MS })
      .then((health) => send(req, res, health.ok ? 200 : 503, { ...JSON_HEADERS }, JSON.stringify({ ok: health.ok })))
      .catch(() => send(req, res, 503, JSON_HEADERS, JSON.stringify({ ok: false })));
    return;
  }

  if (AUTH_ENABLED) {
    const key = clientKey(req);
    if (lockedOut(key)) {
      send(req, res, 429, { 'retry-after': String(Math.ceil(AUTH_LOCKOUT_MS / 1000)), ...TEXT_HEADERS }, 'too many attempts');
      return;
    }
    if (!credentialsMatch(req.headers.authorization)) {
      noteAuthFailure(key);
      send(req, res, 401, {
        'www-authenticate': `Basic realm="${AUTH_REALM}", charset="UTF-8"`,
        ...TEXT_HEADERS,
      }, 'authentication required');
      return;
    }
    authFailures.delete(key);
  }

  handle(req, res, urlPath).catch((err) => {
    console.error('[handler]', err);
    if (!res.headersSent) send(req, res, 500, TEXT_HEADERS, 'internal error');
  });
});

// Slow-loris and idle-socket bounds. Node's defaults are generous for a
// service that only ever answers small same-origin GETs.
server.maxHeadersCount = 64;
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxConnections = 256;

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

loadStatic();

server.listen(LISTEN_PORT, () => {
  console.log(
    `web on :${LISTEN_PORT} — collector=${COLLECTOR_HOST}:${COLLECTOR_PORT} ` +
    `auth=${AUTH_ENABLED ? 'basic' : 'off'} trustProxy=${TRUST_PROXY}`,
  );
  if (!AUTH_ENABLED) {
    console.warn(
      '[warn] 認証が無効です。このダッシュボードはコンテナ名・イメージ・ポート・compose のパスを公開します。' +
      'LAN より広い範囲に出す場合は AUTH_USER / AUTH_PASSWORD を設定してください。',
    );
  }
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

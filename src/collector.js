'use strict';

// The only process that talks to the Docker API. It hands the web tier a
// shaped snapshot and nothing else — no Config.Env, no Mounts, no raw Docker
// passthrough — so a compromise of the browser-facing process cannot reach
// container secrets or /containers/{id}/archive.

const http = require('node:http');

const { intEnv, boolEnv, strEnv } = require('./lib/config');
const { getJson, mapLimit } = require('./lib/httpget');

const LISTEN_PORT = intEnv('COLLECTOR_PORT', 8081, { min: 1, max: 65535 });
const DOCKER_HOST = strEnv('DOCKER_HOST', 'unix:///var/run/docker.sock');
const REFRESH_MS = intEnv('REFRESH_INTERVAL_MS', 5000, { min: 1000, max: 3600000 });
const DOCKER_DEADLINE_MS = intEnv('DOCKER_DEADLINE_MS', 20000, { min: 1000, max: 120000 });
const DOCKER_CONCURRENCY = intEnv('DOCKER_CONCURRENCY', 32, { min: 1, max: 256 });

const PROBE_ENABLED = boolEnv('HTTP_PROBE', true);
const PROBE_HOST = strEnv('PROBE_HOST', 'host.docker.internal');
const PROBE_TTL_MS = intEnv('PROBE_TTL_MS', 30000, { min: 1000, max: 3600000 });
const PROBE_TIMEOUT_MS = intEnv('PROBE_TIMEOUT_MS', 2000, { min: 100, max: 30000 });
const PROBE_CONCURRENCY = intEnv('PROBE_CONCURRENCY', 8, { min: 1, max: 64 });

// A snapshot older than this means collection is wedged, not merely slow.
const HEALTH_MAX_AGE_MS = intEnv(
  'HEALTH_MAX_AGE_MS',
  Math.max(REFRESH_MS * 6, 30000),
  { min: 1000, max: 86400000 },
);

const dockerTarget = (() => {
  if (DOCKER_HOST.startsWith('unix://')) {
    return { socketPath: DOCKER_HOST.slice('unix://'.length) };
  }
  const url = new URL(DOCKER_HOST.replace(/^tcp:/, 'http:'));
  return { host: url.hostname, port: Number(url.port) || 2375 };
})();

const dockerGet = (path) => getJson(dockerTarget, path, { deadlineMs: DOCKER_DEADLINE_MS });

// ------------------------------------------------------------------ shaping

// IPv4 loopback is all of 127.0.0.0/8, and Docker reports IPv4-mapped forms
// too, so a bind to 127.0.0.2 must not be mistaken for a LAN-reachable port.
function isLoopback(ip) {
  if (!ip) return false;
  const addr = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

// Docker reports one entry per bound address, so 0.0.0.0 and :: show up as a
// pair for the same mapping. Collapse them, preferring the IPv4 address.
function shapePorts(ports = []) {
  const merged = new Map();
  for (const p of ports) {
    const isV6 = typeof p.IP === 'string' && p.IP.includes(':');
    if (p.PublicPort == null) {
      const key = `exposed:${p.PrivatePort}/${p.Type}`;
      if (!merged.has(key)) {
        merged.set(key, { published: false, private: p.PrivatePort, type: p.Type });
      }
      continue;
    }
    const key = `published:${p.PublicPort}/${p.PrivatePort}/${p.Type}`;
    if (merged.has(key) && isV6) continue;
    merged.set(key, {
      published: true,
      ip: p.IP || '0.0.0.0',
      loopback: isLoopback(p.IP),
      public: p.PublicPort,
      private: p.PrivatePort,
      type: p.Type,
    });
  }
  return [...merged.values()].sort((a, b) => {
    if (a.published !== b.published) return a.published ? -1 : 1;
    return (a.public ?? a.private) - (b.public ?? b.private);
  });
}

function cpuPercent(stats) {
  const cur = stats.cpu_stats;
  const pre = stats.precpu_stats;
  if (!cur?.cpu_usage || !pre?.cpu_usage) return null;
  const cpuDelta = cur.cpu_usage.total_usage - pre.cpu_usage.total_usage;
  const sysDelta = (cur.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  if (!(cpuDelta > 0) || !(sysDelta > 0)) return 0;
  const cpus = cur.online_cpus || cur.cpu_usage.percpu_usage?.length || 1;
  return (cpuDelta / sysDelta) * cpus * 100;
}

// Matches `docker stats`: page cache that the kernel can reclaim doesn't count.
function memoryUsage(stats) {
  const mem = stats.memory_stats;
  if (!mem || typeof mem.usage !== 'number') return { used: null, limit: null };
  const inactiveFile = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  return { used: Math.max(0, mem.usage - inactiveFile), limit: mem.limit ?? null };
}

function networkIO(stats) {
  const nets = stats.networks;
  if (!nets) return { rx: null, tx: null };
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(nets)) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }
  return { rx, tx };
}

// --------------------------------------------------------------- http probe

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function pageTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const text = match[1]
    .replace(/&(#\d{1,7}|[a-z]{2,8});/gi, (whole, ent) => {
      if (!ent.startsWith('#')) return HTML_ENTITIES[ent.toLowerCase()] ?? whole;
      const code = Number(ent.slice(1));
      // fromCodePoint throws outside the Unicode range, and this input is
      // controlled by whatever answered the probe.
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    // Strip control characters before this reaches a log line or the DOM.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 90) : null;
}

// One GET / against a published port. The deadline is wall-clock: a service
// that trickles bytes forever must not be able to stall the whole snapshot.
function probePort(port) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => done({ ok: false, reason: 'deadline' }), PROBE_TIMEOUT_MS);

    req = http.request(
      {
        host: PROBE_HOST,
        port,
        path: '/',
        method: 'GET',
        headers: { 'user-agent': 'docker-server-list', accept: 'text/html,*/*' },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (size >= 65536) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        const finish = () => done({
          ok: true,
          status: res.statusCode,
          title: pageTitle(Buffer.concat(chunks).toString('utf8')),
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );

    req.on('error', (err) => done({ ok: false, reason: err.code ?? 'error' }));
    req.end();
  });
}

const probeCache = new Map(); // port -> { at, result }

async function probeAll(containers) {
  if (!PROBE_ENABLED) return;

  const wanted = new Set();
  for (const c of containers) {
    if (c.state !== 'running') continue;
    for (const p of c.ports) {
      if (p.published && !p.loopback && p.type === 'tcp') wanted.add(p.public);
    }
  }

  const now = Date.now();
  for (const [port, entry] of probeCache) {
    if (!wanted.has(port) && now - entry.at > PROBE_TTL_MS * 4) probeCache.delete(port);
  }

  const stale = [...wanted].filter((port) => {
    const hit = probeCache.get(port);
    return !hit || now - hit.at > PROBE_TTL_MS;
  });

  await mapLimit(stale, PROBE_CONCURRENCY, async (port) => {
    probeCache.set(port, { at: Date.now(), result: await probePort(port) });
  });

  for (const c of containers) {
    if (c.state !== 'running') continue;
    for (const p of c.ports) {
      if (!p.published || p.loopback || p.type !== 'tcp') continue;
      const hit = probeCache.get(p.public);
      if (hit?.result.ok) p.http = { status: hit.result.status, title: hit.result.title };
    }
  }
}

// ------------------------------------------------------------------ collect

// Health flips starting -> healthy -> unhealthy while State stays "running",
// as do RestartCount, StartedAt and network attachments. Caching those against
// state would pin them at their first observed value, so running containers
// are always re-inspected; stopped ones genuinely cannot change until they
// move out of that state.
const stoppedInspectCache = new Map();

async function inspect(id, state) {
  if (state === 'running') return inspectOnce(id);
  const hit = stoppedInspectCache.get(id);
  if (hit && hit.state === state) return hit.value;
  const value = await inspectOnce(id);
  stoppedInspectCache.set(id, { state, value });
  return value;
}

async function inspectOnce(id) {
  const raw = await dockerGet(`/containers/${id}/json`);
  const time = (value) => (value && !value.startsWith('0001-') ? value : null);
  // Deliberately narrow: Config.Env, Mounts, Cmd and HostConfig bindings stay
  // on this side of the boundary.
  return {
    startedAt: time(raw.State?.StartedAt),
    finishedAt: time(raw.State?.FinishedAt),
    health: raw.State?.Health?.Status ?? null,
    restartCount: raw.RestartCount ?? 0,
    exitCode: raw.State?.ExitCode ?? null,
    restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? null,
    networks: Object.keys(raw.NetworkSettings?.Networks ?? {}),
  };
}

let snapshot = {
  updatedAt: null,
  durationMs: null,
  error: 'まだ収集していません',
  host: null,
  containers: [],
};

async function collect() {
  const startedAt = Date.now();
  const [info, list] = await Promise.all([
    dockerGet('/info'),
    dockerGet('/containers/json?all=1'),
  ]);

  const live = new Set(list.map((c) => c.Id));
  for (const id of stoppedInspectCache.keys()) {
    if (!live.has(id)) stoppedInspectCache.delete(id);
  }

  const containers = await mapLimit(list, DOCKER_CONCURRENCY, async (c) => {
    const labels = c.Labels ?? {};
    const running = c.State === 'running';

    const [details, stats] = await Promise.all([
      inspect(c.Id, c.State).catch(() => null),
      running
        ? dockerGet(`/containers/${c.Id}/stats?stream=false`).catch(() => null)
        : Promise.resolve(null),
    ]);

    const mem = stats ? memoryUsage(stats) : { used: null, limit: null };
    const net = stats ? networkIO(stats) : { rx: null, tx: null };

    return {
      id: c.Id.slice(0, 12),
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      health: details?.health ?? null,
      createdAt: c.Created ? new Date(c.Created * 1000).toISOString() : null,
      startedAt: details?.startedAt ?? null,
      finishedAt: details?.finishedAt ?? null,
      exitCode: details?.exitCode ?? null,
      restartCount: details?.restartCount ?? 0,
      restartPolicy: details?.restartPolicy ?? null,
      networks: details?.networks ?? [],
      ports: shapePorts(c.Ports),
      compose: {
        project: labels['com.docker.compose.project'] ?? null,
        service: labels['com.docker.compose.service'] ?? null,
        workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
        configFiles: labels['com.docker.compose.project.config_files'] ?? null,
      },
      cpuPercent: stats ? cpuPercent(stats) : null,
      memUsed: mem.used,
      memLimit: mem.limit,
      netRx: net.rx,
      netTx: net.tx,
    };
  });

  await probeAll(containers);

  containers.sort((a, b) => {
    const pa = a.compose.project ?? '￿';
    const pb = b.compose.project ?? '￿';
    return pa.localeCompare(pb) || a.name.localeCompare(b.name);
  });

  snapshot = {
    updatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    error: null,
    host: {
      name: info.Name ?? null,
      dockerVersion: info.ServerVersion ?? null,
      os: info.OperatingSystem ?? null,
      arch: info.Architecture ?? null,
      ncpu: info.NCPU ?? null,
      memTotal: info.MemTotal ?? null,
      containersRunning: info.ContainersRunning ?? containers.filter((c) => c.state === 'running').length,
      containersTotal: info.Containers ?? containers.length,
      images: info.Images ?? null,
    },
    containers,
  };
}

async function refreshLoop() {
  for (;;) {
    try {
      await collect();
    } catch (err) {
      // Keep serving the last good snapshot; /healthz reports the staleness.
      snapshot = { ...snapshot, error: err.message };
      console.error(`[collect] ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, REFRESH_MS));
  }
}

// ------------------------------------------------------------------- server

function snapshotAgeMs() {
  return snapshot.updatedAt ? Date.now() - Date.parse(snapshot.updatedAt) : null;
}

const server = http.createServer((req, res) => {
  req.resume();

  const path = req.url.split('?')[0];
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', ...headers }).end('{"error":"method not allowed"}');
    return;
  }

  // A snapshot that stopped advancing is a failure even if an old one is still
  // in memory, so age is part of the verdict rather than mere existence.
  if (path === '/healthz') {
    const age = snapshotAgeMs();
    const ok = age !== null && age <= HEALTH_MAX_AGE_MS;
    const reason = age === null ? 'まだ収集していません'
      : ok ? null
      : `最終収集から ${Math.round(age / 1000)} 秒経過（上限 ${Math.round(HEALTH_MAX_AGE_MS / 1000)} 秒）`;
    res.writeHead(ok ? 200 : 503, headers);
    res.end(JSON.stringify({ ok, ageMs: age, error: snapshot.error, reason }));
    return;
  }

  if (path === '/snapshot') {
    const age = snapshotAgeMs();
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      ...snapshot,
      refreshIntervalMs: REFRESH_MS,
      probeEnabled: PROBE_ENABLED,
      stale: age === null || age > REFRESH_MS * 3,
    }));
    return;
  }

  res.writeHead(404, headers).end('{"error":"not found"}');
});

server.maxHeadersCount = 32;
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxConnections = 64;

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

server.listen(LISTEN_PORT, () => {
  console.log(
    `collector on :${LISTEN_PORT} — docker=${DOCKER_HOST} refresh=${REFRESH_MS}ms ` +
    `probe=${PROBE_ENABLED ? 'on' : 'off'} healthMaxAge=${HEALTH_MAX_AGE_MS}ms`,
  );
  refreshLoop();
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

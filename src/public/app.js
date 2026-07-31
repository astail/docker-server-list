'use strict';

const ui = {
  data: null,
  query: '',
  filter: 'all',
  group: true,
  sort: null, // {key, dir}; null keeps the server order (project -> name)
  expanded: new Set(),
  error: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// ----------------------------------------------------------- formatting

function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function duration(fromIso, toMs = Date.now()) {
  if (!fromIso) return '—';
  let s = Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 7) return `${Math.floor(d / 7)}w ${d % 7}d`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function localTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

const barClass = (pct) => (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '');

// ----------------------------------------------------------- derivation

function portText(p) {
  if (!p.published) return `${p.private}/${p.type}`;
  return p.public === p.private ? `${p.public}/${p.type}` : `${p.public}→${p.private}/${p.type}`;
}

function searchBlob(c) {
  return [
    c.name,
    c.image,
    c.state,
    c.compose.project,
    c.compose.service,
    c.compose.configFiles,
    c.id,
    ...c.ports.map(portText),
  ].filter(Boolean).join(' ').toLowerCase();
}

// Reachable from another machine on the LAN: running, bound to a real
// interface rather than to loopback only.
const endpointUrl = (port) => `http://${location.hostname}${port === 80 ? '' : `:${port}`}/`;

const reachablePorts = (c) =>
  c.state === 'running' ? c.ports.filter((p) => p.published && !p.loopback && p.type === 'tcp') : [];

function visibleContainers() {
  const list = (ui.data?.containers ?? []).filter((c) => {
    if (ui.filter === 'running' && c.state !== 'running') return false;
    if (ui.filter === 'stopped' && c.state === 'running') return false;
    if (ui.filter === 'reachable' && reachablePorts(c).length === 0) return false;
    if (ui.query && !searchBlob(c).includes(ui.query)) return false;
    return true;
  });

  if (!ui.sort) return list;

  const { key, dir } = ui.sort;
  const sign = dir === 'desc' ? -1 : 1;
  const num = (v) => (v == null ? -1 : v);
  const cmp = {
    state: (a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    image: (a, b) => a.image.localeCompare(b.image),
    ports: (a, b) => {
      const first = (c) => c.ports.find((p) => p.published)?.public ?? Infinity;
      return first(a) - first(b) || a.name.localeCompare(b.name);
    },
    cpu: (a, b) => num(a.cpuPercent) - num(b.cpuPercent),
    mem: (a, b) => num(a.memUsed) - num(b.memUsed),
    net: (a, b) => num(a.netRx) + num(a.netTx) - (num(b.netRx) + num(b.netTx)),
    uptime: (a, b) => (b.startedAt ? Date.parse(b.startedAt) : 0) - (a.startedAt ? Date.parse(a.startedAt) : 0),
  }[key];

  return [...list].sort((a, b) => sign * cmp(a, b));
}

// -------------------------------------------------------------- render

function renderSummary() {
  const host = ui.data?.host;
  const containers = ui.data?.containers ?? [];
  if (!host) return;

  $('#host-line').textContent =
    `${host.name ?? 'unknown'} · Docker ${host.dockerVersion ?? '?'} · ${host.os ?? ''}`.trim();

  const running = containers.filter((c) => c.state === 'running');
  const cpuSum = running.reduce((a, c) => a + (c.cpuPercent ?? 0), 0);
  const memSum = running.reduce((a, c) => a + (c.memUsed ?? 0), 0);
  const projects = new Set(containers.map((c) => c.compose.project).filter(Boolean));
  const published = containers.reduce((a, c) => a + c.ports.filter((p) => p.published).length, 0);

  const hostCpu = host.ncpu ? cpuSum / host.ncpu : null;
  const hostMem = host.memTotal ? (memSum / host.memTotal) * 100 : null;

  const stats = [
    ['コンテナ', `${running.length}`, `/ ${containers.length}`],
    ['CPU', hostCpu == null ? '—' : `${hostCpu.toFixed(1)}%`, host.ncpu ? `${host.ncpu} cores` : ''],
    ['メモリ', bytes(memSum), host.memTotal ? `/ ${bytes(host.memTotal)}` : ''],
    ['プロジェクト', `${projects.size}`, ''],
    ['公開ポート', `${published}`, ''],
  ];

  const box = $('#summary');
  box.replaceChildren(...stats.map(([label, value, sub]) => {
    const stat = el('div', 'stat');
    stat.append(el('span', 'stat-label', label));
    const v = el('span', 'stat-value', value);
    if (sub) v.append(el('span', 'stat-sub', sub));
    stat.append(v);
    return stat;
  }));

  if (hostMem != null) {
    $('#footer-line').textContent =
      `メモリ使用率 ${hostMem.toFixed(1)}% · イメージ ${host.images ?? '?'} 個 · ` +
      `収集 ${ui.data.durationMs}ms · ${ui.data.refreshIntervalMs / 1000}秒ごとに自動更新`;
  }
}

function renderAccess() {
  const endpoints = [];
  for (const c of ui.data?.containers ?? []) {
    for (const p of reachablePorts(c)) endpoints.push({ c, p });
  }

  const label = (e) => e.c.compose.project ?? e.c.name;
  endpoints.sort((a, b) => {
    // Things you can actually open in a browser go first.
    if (!!a.p.http !== !!b.p.http) return a.p.http ? -1 : 1;
    return label(a).localeCompare(label(b)) || a.p.public - b.p.public;
  });

  $('#access').hidden = endpoints.length === 0;
  $('#access-count').textContent = `${endpoints.length} 件`;

  // A project exposing several ports needs the service name to tell them apart.
  const perProject = new Map();
  for (const e of endpoints) perProject.set(label(e), (perProject.get(label(e)) ?? 0) + 1);

  const grid = $('#access-grid');
  grid.replaceChildren(...endpoints.map(({ c, p }) => {
    const isHttp = Boolean(p.http);
    const url = endpointUrl(p.public);

    const tile = document.createElement(isHttp ? 'a' : 'div');
    tile.className = `tile${isHttp ? '' : ' is-tcp'}`;
    if (isHttp) {
      tile.href = url;
      tile.target = '_blank';
      tile.rel = 'noopener noreferrer';
    }
    tile.title = isHttp ? `${url}（${c.name}）` : `${location.hostname}:${p.public} — HTTP ではありません（${c.name}）`;

    const health = c.health === 'unhealthy' ? 'unhealthy' : c.health === 'starting' ? 'starting' : 'running';
    const base = c.compose.project ?? c.name;
    const top = el('div', 'tile-top');
    top.append(
      el('span', `dot ${health}`),
      el('span', 'tile-name', base),
      el('span', 'tile-port', `:${p.public}`),
    );

    // The project name gets the headline; the service only earns a spot when
    // the project publishes more than one endpoint.
    const service = c.compose.service ?? c.name;
    const sub = el('div', 'tile-sub');
    if (!isHttp) sub.append(el('span', 'tile-tag', 'TCP'));
    else if (p.http.status >= 400) sub.append(el('span', 'tile-tag', `HTTP ${p.http.status}`));
    if (perProject.get(base) > 1) sub.append(el('span', 'tile-tag', service));
    sub.append(document.createTextNode(
      (isHttp && p.http.title) || (perProject.get(base) > 1 ? '' : service),
    ));

    tile.append(top, sub);
    return tile;
  }));
}

function portsCell(container) {
  const wrap = el('div', 'ports');
  if (container.ports.length === 0) {
    wrap.append(el('span', 'muted', '—'));
    return wrap;
  }
  // Docker still reports the bindings of a stopped container, but nothing is
  // listening on them — so those stay plain text instead of dead links.
  const reachable = container.state === 'running';
  const onLan = (p) => p.published && !p.loopback && reachable;
  // Without probe data every published port is treated as openable; with it,
  // only the ones that actually answered HTTP become links.
  const openable = (p) => onLan(p) && (!ui.data.probeEnabled || Boolean(p.http));

  for (const p of container.ports) {
    const label = portText(p);
    if (openable(p)) {
      const a = el('a', 'port', label);
      a.href = endpointUrl(p.public);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = [`${p.ip}:${p.public} → コンテナ ${p.private}/${p.type}`, p.http?.title]
        .filter(Boolean).join('\n');
      a.addEventListener('click', (e) => e.stopPropagation());
      wrap.append(a);
    } else if (onLan(p)) {
      const span = el('span', 'port', label);
      span.title = `${p.ip}:${p.public} で待ち受け中。HTTP では応答しないためリンクなし`;
      wrap.append(span);
    } else if (!p.published) {
      const span = el('span', 'port internal', label);
      span.title = 'コンテナ内部のみ公開（ホストには未公開）';
      wrap.append(span);
    } else if (!reachable) {
      const span = el('span', 'port dormant', label);
      span.title = '設定上の公開ポート（コンテナが停止中のため待ち受けなし）';
      wrap.append(span);
    } else {
      const span = el('span', 'port loopback', label);
      span.title = `${p.ip} にのみバインド（このサーバ内からのみ到達可能）`;
      wrap.append(span);
    }
  }
  return wrap;
}

function meterCell(value, sub, pct) {
  const td = el('td', 'num');
  const meter = el('div', 'meter');
  meter.append(el('span', 'meter-value', value));
  if (sub) meter.append(el('span', 'meter-sub', sub));
  if (pct != null) {
    const bar = el('div', 'bar');
    const fill = el('i', barClass(pct));
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    bar.append(fill);
    meter.append(bar);
  }
  td.append(meter);
  return td;
}

function detailRow(c) {
  const tr = el('tr', 'detail-row');
  const td = el('td');
  td.colSpan = 8;
  const box = el('div', 'detail');

  const entries = [
    ['コンテナ ID', c.id],
    ['イメージ', c.image],
    ['ステータス', c.status],
    ['Compose', c.compose.project ? `${c.compose.project} / ${c.compose.service ?? '?'}` : '（compose 管理外）'],
    ['Compose ファイル', c.compose.configFiles ?? '—'],
    ['作業ディレクトリ', c.compose.workingDir ?? '—'],
    ['ネットワーク', c.networks.length ? c.networks.join(', ') : '—'],
    ['再起動ポリシー', `${c.restartPolicy ?? '—'} (回数 ${c.restartCount})`],
    ['作成', localTime(c.createdAt)],
    ['起動', localTime(c.startedAt)],
  ];
  if (c.state !== 'running') {
    entries.push(['終了', `${localTime(c.finishedAt)}（exit ${c.exitCode ?? '?'}）`]);
  }

  for (const [dt, dd] of entries) {
    const dl = el('dl');
    dl.append(el('dt', null, dt), el('dd', null, dd));
    box.append(dl);
  }
  td.append(box);
  tr.append(td);
  return tr;
}

function containerRow(c) {
  const tr = el('tr', 'row');
  tr.dataset.id = c.id;

  const stateTd = el('td', 'col-state');
  // Health is only meaningful while running; a stopped container keeps the
  // last value it had, which would otherwise show up as a warning.
  const health = c.state === 'running' ? c.health : null;
  const dotClass = health === 'unhealthy' ? 'unhealthy' : health === 'starting' ? 'starting' : c.state;
  const dot = el('span', `dot ${dotClass}`);
  dot.title = health ? `${c.state} (${health})` : c.state;
  stateTd.append(dot);

  const nameTd = el('td');
  nameTd.append(el('div', 'name', c.name));
  const subtitle = c.compose.project
    ? `${c.compose.project} / ${c.compose.service ?? '?'}`
    : c.id;
  nameTd.append(el('div', 'name-sub', subtitle));

  const imageTd = el('td');
  const img = el('div', 'image', c.image);
  img.title = c.image;
  imageTd.append(img);

  const portsTd = el('td');
  portsTd.append(portsCell(c));

  const cpuTd = c.cpuPercent == null
    ? el('td', 'num')
    : meterCell(`${c.cpuPercent.toFixed(1)}%`, null, (c.cpuPercent / (ui.data.host.ncpu || 1)));
  if (c.cpuPercent == null) cpuTd.append(el('span', 'muted', '—'));

  let memTd;
  if (c.memUsed == null) {
    memTd = el('td', 'num');
    memTd.append(el('span', 'muted', '—'));
  } else {
    const pct = c.memLimit ? (c.memUsed / c.memLimit) * 100 : null;
    memTd = meterCell(bytes(c.memUsed), pct != null ? `${pct.toFixed(1)}%` : null, pct);
  }

  const netTd = el('td', 'num net-col');
  netTd.append(c.netRx == null
    ? el('span', 'muted', '—')
    : el('span', null, `↓${bytes(c.netRx)} ↑${bytes(c.netTx)}`));

  const upTd = el('td', 'num');
  if (c.state === 'running') {
    upTd.append(el('span', null, duration(c.startedAt)));
  } else {
    const s = el('span', 'muted', c.finishedAt ? `${duration(c.finishedAt)} 前に停止` : c.state);
    upTd.append(s);
  }

  tr.append(stateTd, nameTd, imageTd, portsTd, cpuTd, memTd, netTd, upTd);
  tr.addEventListener('click', () => {
    if (ui.expanded.has(c.id)) ui.expanded.delete(c.id);
    else ui.expanded.add(c.id);
    renderTable();
  });
  return tr;
}

function groupRow(project, containers) {
  const tr = el('tr', 'group-row');
  const td = el('td');
  td.colSpan = 8;
  td.append(document.createTextNode(project ?? '（compose 管理外）'));
  const running = containers.filter((c) => c.state === 'running').length;
  td.append(el('span', 'group-count', `${running}/${containers.length} 稼働`));
  const dir = containers.find((c) => c.compose.workingDir)?.compose.workingDir;
  if (dir) td.append(el('span', 'group-path', dir));
  tr.append(td);
  return tr;
}

function renderTable() {
  const list = visibleContainers();
  const body = document.createDocumentFragment();

  const push = (c) => {
    body.append(containerRow(c));
    if (ui.expanded.has(c.id)) body.append(detailRow(c));
  };

  if (ui.group) {
    const groups = new Map();
    for (const c of list) {
      const key = c.compose.project ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const key of keys) {
      body.append(groupRow(key || null, groups.get(key)));
      groups.get(key).forEach(push);
    }
  } else {
    list.forEach(push);
  }

  $('#tbody').replaceChildren(body);
  $('#empty').hidden = list.length > 0;
  $('#table').hidden = list.length === 0;
}

function renderStatus(loading) {
  const dot = el('span', 'pulse');
  const msg = [];
  if (ui.error) {
    dot.classList.add('is-error');
    msg.push(`エラー: ${ui.error}`);
  } else if (loading) {
    dot.classList.add('is-loading');
    msg.push('更新中…');
  } else if (ui.data?.updatedAt) {
    if (ui.data.stale) {
      dot.classList.add('is-error');
      msg.push(`データが古い可能性: ${new Date(ui.data.updatedAt).toLocaleTimeString()}`);
    } else {
      msg.push(`最終更新 ${new Date(ui.data.updatedAt).toLocaleTimeString()}`);
    }
  }
  $('#status').replaceChildren(dot, el('span', null, msg.join(' ')));
}

// --------------------------------------------------------------- events

$('#search').addEventListener('input', (e) => {
  ui.query = e.target.value.trim().toLowerCase();
  renderTable();
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.chip')) other.classList.toggle('is-active', other === chip);
    ui.filter = chip.dataset.filter;
    renderTable();
  });
}

$('#group-toggle').addEventListener('change', (e) => {
  ui.group = e.target.checked;
  renderTable();
});

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    const numeric = ['cpu', 'mem', 'net', 'uptime'].includes(key);
    if (ui.sort?.key === key) {
      ui.sort = ui.sort.dir === 'asc' ? { key, dir: 'desc' } : null;
    } else {
      ui.sort = { key, dir: numeric ? 'desc' : 'asc' };
    }
    // A global ordering is what the user asked for, so drop the grouping.
    if (ui.sort && ui.group) {
      ui.group = false;
      $('#group-toggle').checked = false;
    }
    for (const other of document.querySelectorAll('th[data-sort]')) delete other.dataset.dir;
    if (ui.sort) th.dataset.dir = ui.sort.dir;
    renderTable();
  });
}

// ---------------------------------------------------------------- fetch

async function tick() {
  renderStatus(true);
  try {
    const res = await fetch('/api/containers', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ui.data = await res.json();
    ui.error = ui.data.error;
    renderSummary();
    renderAccess();
    renderTable();
  } catch (err) {
    ui.error = err.message;
  }
  renderStatus(false);
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  const ms = ui.data?.refreshIntervalMs ?? 5000;
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await tick();
    schedule();
  }, ms);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tick();
});

tick().then(schedule);

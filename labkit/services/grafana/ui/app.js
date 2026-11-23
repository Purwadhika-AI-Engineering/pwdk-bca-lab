// Grafana mock UI: one dashboard for the backend and an Explore page for LogQL and PromQL.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = (iso) => new Date(iso).toLocaleTimeString();

async function get(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessages?.join('; ') || res.statusText);
  return data;
}

function chart(perMinute) {
  const W = 900, H = 200, pad = 24;
  const max = Math.max(1, ...perMinute.map((b) => b.ok + b.client + b.server));
  const bw = (W - pad) / perMinute.length;
  let svg = `<text x="0" y="12">${max}</text><text x="0" y="${H - 4}">0</text>`;
  perMinute.forEach((b, i) => {
    let y = H - 16;
    const x = pad + i * bw + 1;
    for (const kind of ['ok', 'client', 'server']) {
      const h = ((H - 30) * b[kind]) / max;
      if (h > 0) svg += `<rect class="${kind}" x="${x}" y="${y - h}" width="${Math.max(bw - 2, 1)}" height="${h}"><title>${time(b.t)} ${kind}: ${b[kind]}</title></rect>`;
      y -= h;
    }
    if (i % 5 === 0) svg += `<text x="${x}" y="${H - 2}">${new Date(b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>`;
  });
  $('chart').innerHTML = svg;
}

async function refreshDashboard() {
  const d = await get(`/api/dashboard?minutes=${$('minutes').value}`);
  $('total').textContent = d.total;
  $('errorRate').textContent = `${(d.errorRate * 100).toFixed(1)}%`;
  $('errorRate').className = `value ${d.errorRate > 0.2 ? 'bad' : ''}`;
  $('serverErrors').textContent = d.serverErrors;
  $('serverErrors').className = `value ${d.serverErrors ? 'bad' : ''}`;
  $('p95').textContent = `${Math.round(d.p95ms)} ms`;
  chart(d.perMinute);
  $('routes').innerHTML = d.routes.map((r) => `<tr><td>${esc(r.route)}</td><td class="num">${r.count}</td><td class="num ${r.errors ? 'bad' : ''}">${r.errors}</td><td class="num">${Math.round(r.p95ms)} ms</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No requests yet. Start the backend with the labkit profile and use the app.</td></tr>';
  $('recent').innerHTML = d.recentErrors.map((e) => `<li><span class="muted">${time(e.ts)}</span> <span class="lvl-${e.level}">${e.level.toUpperCase()}</span> ${esc(e.message)} <span class="muted">${esc(e.logger)}${e.traceId ? ` traceId=${esc(e.traceId)}` : ''}</span></li>`).join('') || '<li class="muted">None</li>';
}

const HINTS = {
  logql: 'Examples: {job="banklab-backend"} |= "transfer"   ·   {logger="labkit.request"} | json | status >= 400   ·   sum by (level) (count_over_time({job="banklab-backend"}[5m]))',
  promql: 'Examples: sum by (status) (rate(http_requests_total[5m]))   ·   histogram_quantile(0.95, sum by (le, path) (rate(http_request_duration_seconds_bucket[5m])))',
};

async function runExplore(e) {
  e?.preventDefault();
  const lang = $('lang').value;
  const q = $('query').value;
  $('hint').textContent = HINTS[lang];
  $('error').hidden = true;
  const start = Math.floor(Date.now() / 1000) - Number($('minutes').value) * 60;
  try {
    const url = lang === 'logql'
      ? `/loki/api/v1/query_range?direction=backward&limit=200&start=${start}&query=${encodeURIComponent(q)}`
      : `/api/v1/query?query=${encodeURIComponent(q)}`;
    const r = await get(url);
    const data = r.data;
    if (data.resultType === 'streams') {
      const rows = data.result.flatMap((s) => s.values.map(([ns, line]) => ({ ns: BigInt(ns), line, level: s.stream.level })))
        .sort((a, b) => (a.ns < b.ns ? 1 : -1));
      $('result').innerHTML = `<p class="muted">${rows.length} lines</p><ol class="logs">${rows.map((r) => `<li><span class="muted">${time(Number(r.ns / 1000000n))}</span> <span class="lvl-${r.level}">${esc(r.level)}</span> ${esc(r.line)}</li>`).join('')}</ol>`;
    } else if (data.resultType === 'scalar') {
      $('result').innerHTML = `<p>${esc(data.result[1])}</p>`;
    } else {
      const rows = data.result.map((s) => ({ metric: s.metric, value: s.value ? s.value[1] : s.values.at(-1)[1] }));
      $('result').innerHTML = `<table><thead><tr><th>Series</th><th>Value</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(JSON.stringify(r.metric))}</td><td class="num">${esc(Number(r.value).toPrecision(4))}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No data</td></tr>'}</tbody></table>`;
    }
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = err.message;
  }
}

function show() {
  const explore = location.hash === '#explore';
  $('dashboard').hidden = explore;
  $('explore').hidden = !explore;
  if (explore) runExplore();
}

async function tick() {
  try {
    if (location.hash !== '#explore') await refreshDashboard();
    $('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $('updated').textContent = `offline: ${err.message}`;
  }
}

$('exploreForm').onsubmit = runExplore;
$('lang').onchange = () => {
  $('query').value = $('lang').value === 'logql' ? '{job="banklab-backend", level=~"warn|error"}' : 'sum by (status) (rate(http_requests_total[5m]))';
  runExplore();
};
$('minutes').onchange = () => (location.hash === '#explore' ? runExplore() : tick());
window.addEventListener('hashchange', show);
show();
tick();
setInterval(tick, 3000);

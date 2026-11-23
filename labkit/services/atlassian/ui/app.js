// Read-only web UI for the Atlassian mock: Jira board, issue page, Confluence tree and pages.
// It polls the event log and re-renders when an agent changes something.
import { renderMarkdown } from './markdown.js';

const main = document.getElementById('main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, '-');
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessages?.join('; ') || res.statusText);
  return data;
}

const state = { jql: localStorage.getItem('labkit.jql') || 'project = LB ORDER BY priority DESC' };

async function board() {
  let result;
  let error = '';
  try {
    result = await api('/rest/api/3/search/jql?maxResults=100&fields=summary,status,priority,issuetype,assignee,labels&jql=' + encodeURIComponent(state.jql));
  } catch (err) {
    error = err.message;
    result = { issues: [] };
  }
  const cols = ['To Do', 'In Progress', 'Done'];
  main.innerHTML = `
    <h1>Board</h1>
    <form class="toolbar" id="jqlForm">
      <label for="jql" class="muted">JQL</label>
      <input id="jql" value="${esc(state.jql)}" spellcheck="false">
      <button>Search</button>
    </form>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <div class="board">${cols
      .map((c) => {
        const issues = result.issues.filter((i) => i.fields.status.name === c);
        return `<section class="column"><h2>${c} (${issues.length})</h2>${issues.map(card).join('')}</section>`;
      })
      .join('')}</div>`;
  document.getElementById('jqlForm').onsubmit = (e) => {
    e.preventDefault();
    state.jql = document.getElementById('jql').value;
    localStorage.setItem('labkit.jql', state.jql);
    board();
  };
}

function card(i) {
  const f = i.fields;
  return `<a class="card" href="#/issue/${esc(i.key)}">
    <div>${esc(f.summary)}</div>
    <div class="meta">
      <span class="key">${esc(i.key)}</span>
      <span>${esc(f.issuetype.name)}</span>
      <span class="prio-${esc(f.priority?.name)}">▲ ${esc(f.priority?.name)}</span>
      ${f.labels.map((l) => `<span class="label">${esc(l)}</span>`).join('')}
      <span>${esc(f.assignee?.displayName || 'Unassigned')}</span>
    </div></a>`;
}

async function issue(key) {
  const i = await api(`/rest/api/3/issue/${encodeURIComponent(key)}`);
  const f = i.fields;
  main.innerHTML = `
    <p><a href="#/board">← Board</a> / ${esc(f.project.name)} / <span class="key">${esc(i.key)}</span></p>
    <div class="issue">
      <div class="panel">
        <h1>${esc(f.summary)}</h1>
        <h3>Description</h3>
        <div class="doc">${renderMarkdown(f.description) || '<p class="muted">No description</p>'}</div>
        <h3>Comments (${f.comment.total})</h3>
        ${f.comment.comments
          .map((c) => `<div class="comment"><span class="who">${esc(c.author?.displayName)}</span><span class="when">${when(c.created)}</span><div class="doc">${renderMarkdown(c.body)}</div></div>`)
          .join('') || '<p class="muted">No comments yet</p>'}
      </div>
      <div class="panel">
        <span class="pill status-${slug(f.status.name)}">${esc(f.status.name)}</span>
        <dl class="fields">
          <dt>Type</dt><dd>${esc(f.issuetype.name)}</dd>
          <dt>Priority</dt><dd class="prio-${esc(f.priority?.name)}">${esc(f.priority?.name)}</dd>
          <dt>Assignee</dt><dd>${esc(f.assignee?.displayName || 'Unassigned')}</dd>
          <dt>Reporter</dt><dd>${esc(f.reporter?.displayName || '')}</dd>
          <dt>Labels</dt><dd>${f.labels.map((l) => `<span class="label">${esc(l)}</span>`).join(' ') || '<span class="muted">None</span>'}</dd>
          <dt>Created</dt><dd>${when(f.created)}</dd>
          <dt>Updated</dt><dd>${when(f.updated)}</dd>
        </dl>
      </div>
    </div>`;
}

async function spaces() {
  const { results } = await api('/wiki/api/v2/spaces');
  main.innerHTML = `<h1>Confluence spaces</h1><div class="spaces">${results
    .map((s) => `<a class="card" href="#/wiki/${esc(s.key)}"><strong>${esc(s.name)}</strong><div class="meta"><span class="key">${esc(s.key)}</span><span>${esc(s.description.plain.value)}</span></div></a>`)
    .join('')}</div>`;
}

function tree(pages, activeId) {
  const kids = (parentId) => pages.filter((p) => p.parentId === parentId);
  const ids = new Set(pages.map((p) => p.id));
  const roots = pages.filter((p) => !p.parentId || !ids.has(p.parentId));
  const render = (list) =>
    `<ul>${list.map((p) => `<li><a href="#/page/${p.id}" class="${p.id === activeId ? 'active' : ''}">${esc(p.title)}</a>${kids(p.id).length ? render(kids(p.id)) : ''}</li>`).join('')}</ul>`;
  return render(roots);
}

async function space(key, pageId) {
  const s = await api(`/wiki/api/v2/spaces/${encodeURIComponent(key)}`);
  const { results: pages } = await api(`/wiki/api/v2/spaces/${s.id}/pages`);
  const id = pageId || s.homepageId || pages[0]?.id;
  const page = id ? await api(`/wiki/api/v2/pages/${id}`) : null;
  main.innerHTML = `
    <p><a href="#/wiki">← Spaces</a> / ${esc(s.name)}</p>
    <div class="wiki">
      <nav class="panel tree">${tree(pages, page?.id)}</nav>
      <article class="panel">
        ${page ? `<h1>${esc(page.title)}</h1><p class="muted">Version ${page.version.number} · updated ${when(page.version.createdAt)}${page.authorId ? ` by ${esc(page.authorId)}` : ''}</p><div class="doc">${renderMarkdown(page.body.value)}</div>` : '<p class="muted">No pages yet</p>'}
      </article>
    </div>`;
}

async function pageRoute(id) {
  const p = await api(`/wiki/api/v2/pages/${encodeURIComponent(id)}`);
  return space(p.spaceKey, p.id);
}

async function route() {
  const [, view = 'board', arg] = location.hash.split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (view === 'issue' ? 'board' : view === 'page' ? 'wiki' : view)));
  try {
    if (view === 'issue') await issue(decodeURIComponent(arg));
    else if (view === 'wiki' && arg) await space(decodeURIComponent(arg));
    else if (view === 'wiki') await spaces();
    else if (view === 'page') await pageRoute(arg);
    else await board();
  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

let lastEvent = null;
async function poll() {
  try {
    const { events } = await api('/admin/events');
    const top = events[0]?.id ?? 0;
    document.getElementById('events').innerHTML = events
      .slice(0, 30)
      .map((e) => `<li><span class="when">${when(e.at)}</span><strong>${esc(e.target)}</strong> ${esc(e.kind.replace('.', ' '))}: ${esc(e.summary)}</li>`)
      .join('');
    if (lastEvent !== null && top !== lastEvent) {
      const live = document.getElementById('live');
      live.classList.add('flash');
      setTimeout(() => live.classList.remove('flash'), 1500);
      if (!document.activeElement || document.activeElement.id !== 'jql') route();
    }
    lastEvent = top;
  } catch {
    /* service restarting */
  }
}

window.addEventListener('hashchange', route);
route();
poll();
setInterval(poll, 2000);

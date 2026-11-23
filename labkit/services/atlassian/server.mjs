#!/usr/bin/env node
// Atlassian mock: a small Jira + Confluence on 127.0.0.1:4310, stored in node:sqlite.
// REST paths and shapes follow subsets of Jira Cloud v3 and Confluence Cloud v2.
//
//   node --no-warnings=ExperimentalWarning labkit/services/atlassian/server.mjs [--port 4310] [--db file] [--seed file]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRouter, listen, reply, HttpError } from '../../lib/http.mjs';
import { mountHttp } from '../../lib/mcp.mjs';
import { compileJql, toIso, QueryError } from './jql.mjs';
import { compileCql } from './cql.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABKIT = path.resolve(HERE, '..', '..');
export const DEFAULT_PORT = 4310;
export const DEFAULT_SEED = path.join(LABKIT, 'seed', 'atlassian.json');
export const DEFAULT_DB = path.join(LABKIT, 'data', 'atlassian.db');

export const STATUSES = [
  { id: '11', name: 'To Do', category: 'new' },
  { id: '21', name: 'In Progress', category: 'indeterminate' },
  { id: '31', name: 'Done', category: 'done' },
];
export const ISSUE_TYPES = ['Bug', 'Task', 'Story', 'Epic', 'Sub-task'];
export const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (account_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT);
CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, name TEXT NOT NULL, lead TEXT, next_number INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, project TEXT NOT NULL REFERENCES projects(key),
  type TEXT NOT NULL, summary TEXT NOT NULL, description TEXT, status TEXT NOT NULL, priority TEXT,
  assignee TEXT, reporter TEXT, labels TEXT NOT NULL DEFAULT '[]', created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT NOT NULL REFERENCES issues(key), author TEXT, body TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT, homepage_id INTEGER);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, space_key TEXT NOT NULL REFERENCES spaces(key), parent_id INTEGER, title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, author TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, summary TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const TABLES = ['events', 'comments', 'issues', 'projects', 'pages', 'spaces', 'users', 'meta'];

/** ADF or string to plain text. Agents sometimes send Atlassian Document Format. */
export function toPlainText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toPlainText).join('');
  if (typeof value === 'object') {
    if (value.type === 'text') return value.text || '';
    if (value.type === 'hardBreak') return '\n';
    const inner = toPlainText(value.content || []);
    const block = ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(value.type);
    return block ? `${inner}\n` : inner;
  }
  return String(value);
}

export function createStore({ dbPath = ':memory:', seedPath = DEFAULT_SEED, now = () => new Date() } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const stamp = () => now().toISOString();
  const q = (sql) => db.prepare(sql);
  const meta = (key) => q('SELECT value FROM meta WHERE key = ?').get(key)?.value;
  const currentUser = () => meta('current_user') || 'participant';
  const event = (kind, target, summary) =>
    q('INSERT INTO events (at, kind, target, summary) VALUES (?, ?, ?, ?)').run(stamp(), kind, target, summary);

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- users ----------
  function userByRef(ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const id = typeof ref === 'object' ? ref.accountId || ref.id || ref.displayName || ref.name : ref;
    const u = q('SELECT account_id FROM users WHERE lower(account_id) = lower(?) OR lower(display_name) = lower(?)').get(id, id);
    if (!u) {
      const known = q('SELECT display_name FROM users ORDER BY display_name').all().map((r) => r.display_name);
      throw new HttpError(400, `Unknown user "${id}". Known users: ${known.join(', ')}`);
    }
    return u.account_id;
  }
  const userJson = (id) => {
    if (!id) return null;
    const u = q('SELECT * FROM users WHERE account_id = ?').get(id);
    return u ? { accountId: u.account_id, displayName: u.display_name, emailAddress: u.email } : { accountId: id, displayName: id };
  };

  // ---------- seed / reset ----------
  function reset(seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))) {
    const seedDir = path.dirname(seedPath);
    const time = (v, fallback) => (v ? toIso(v, now()) : fallback);
    tx(() => {
      for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
      db.exec("DELETE FROM sqlite_sequence WHERE name IN ('issues','comments','spaces','pages','events')");
      q('INSERT INTO meta (key, value) VALUES (?, ?)').run('current_user', seed.currentUser || 'participant');
      for (const u of seed.users || []) q('INSERT INTO users VALUES (?, ?, ?)').run(u.accountId, u.displayName, u.email || null);
      for (const p of seed.projects || []) q('INSERT INTO projects (key, name, lead) VALUES (?, ?, ?)').run(p.key, p.name, p.lead || null);
      for (const i of seed.issues || []) {
        const created = time(i.created, stamp());
        const key = insertIssue({
          project: i.project,
          type: i.type || 'Task',
          summary: i.summary,
          description: i.description || '',
          status: i.status || 'To Do',
          priority: i.priority || 'Medium',
          assignee: i.assignee || null,
          reporter: i.reporter || null,
          labels: i.labels || [],
          created,
          updated: time(i.updated, created),
        });
        for (const c of i.comments || []) {
          q('INSERT INTO comments (issue_key, author, body, created) VALUES (?, ?, ?, ?)').run(key, c.author || null, c.body, time(c.created, created));
        }
      }
      for (const s of seed.spaces || []) {
        q('INSERT INTO spaces (key, name, description) VALUES (?, ?, ?)').run(s.key, s.name, s.description || '');
        const addPages = (pages, parentId) => {
          for (const p of pages || []) {
            const body = p.bodyFile ? fs.readFileSync(path.join(seedDir, p.bodyFile), 'utf8') : p.body || '';
            const created = time(p.created, stamp());
            const r = q('INSERT INTO pages (space_key, parent_id, title, body, version, author, created, updated) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
              .run(s.key, parentId, p.title, body, p.author || null, created, time(p.updated, created));
            const id = Number(r.lastInsertRowid);
            if (p.home) q('UPDATE spaces SET homepage_id = ? WHERE key = ?').run(id, s.key);
            addPages(p.children, id);
          }
        };
        addPages(s.pages, null);
      }
    });
    event('reset', 'labkit', 'Seed data restored');
  }

  function insertIssue(f) {
    const project = q('SELECT * FROM projects WHERE lower(key) = lower(?)').get(f.project);
    if (!project) throw new HttpError(400, `Unknown project "${f.project}"`);
    const key = `${project.key}-${project.next_number}`;
    q('UPDATE projects SET next_number = next_number + 1 WHERE key = ?').run(project.key);
    q(`INSERT INTO issues (key, project, type, summary, description, status, priority, assignee, reporter, labels, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      key, project.key, f.type, f.summary, f.description, f.status, f.priority,
      f.assignee, f.reporter, JSON.stringify(f.labels), f.created, f.updated,
    );
    return key;
  }

  // ---------- Jira ----------
  function issueRow(key) {
    const row = q('SELECT * FROM issues WHERE lower(key) = lower(?) OR CAST(id AS TEXT) = ?').get(String(key), String(key));
    if (!row) throw new HttpError(404, `Issue does not exist: ${key}`);
    return row;
  }

  function commentJson(c) {
    return { id: String(c.id), author: userJson(c.author), body: c.body, created: c.created, updated: c.created };
  }

  const ALL_FIELDS = ['summary', 'description', 'status', 'priority', 'issuetype', 'project', 'assignee', 'reporter', 'labels', 'created', 'updated', 'comment'];
  const SEARCH_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'assignee', 'labels', 'updated'];

  function issueJson(row, fields = ALL_FIELDS) {
    const want = new Set(fields.includes('*all') ? ALL_FIELDS : fields);
    const status = STATUSES.find((s) => s.name === row.status);
    const all = {
      summary: row.summary,
      description: row.description,
      status: { id: status?.id, name: row.status, statusCategory: { key: status?.category } },
      priority: row.priority ? { name: row.priority } : null,
      issuetype: { name: row.type },
      project: { key: row.project, name: q('SELECT name FROM projects WHERE key = ?').get(row.project)?.name },
      assignee: userJson(row.assignee),
      reporter: userJson(row.reporter),
      labels: JSON.parse(row.labels),
      created: row.created,
      updated: row.updated,
    };
    const out = {};
    for (const f of want) if (f in all) out[f] = all[f];
    if (want.has('comment')) {
      const comments = q('SELECT * FROM comments WHERE issue_key = ? ORDER BY id').all(row.key).map(commentJson);
      out.comment = { comments, total: comments.length, maxResults: comments.length, startAt: 0 };
    }
    return { id: String(row.id), key: row.key, self: `/rest/api/3/issue/${row.key}`, fields: out };
  }

  function search({ jql = '', startAt = 0, maxResults = 50, fields } = {}) {
    let compiled;
    try {
      compiled = compileJql(jql, { currentUser: currentUser(), now: now() });
    } catch (err) {
      if (err instanceof QueryError) throw new HttpError(400, `JQL: ${err.message}`);
      throw err;
    }
    const limit = Math.min(Math.max(Number(maxResults) || 50, 1), 100);
    const offset = Math.max(Number(startAt) || 0, 0);
    const total = q(`SELECT count(*) AS n FROM issues i WHERE ${compiled.where}`).get(...compiled.params).n;
    const rows = q(`SELECT i.* FROM issues i WHERE ${compiled.where} ORDER BY ${compiled.orderBy} LIMIT ? OFFSET ?`)
      .all(...compiled.params, limit, offset);
    const list = typeof fields === 'string' ? fields.split(',').map((s) => s.trim()).filter(Boolean) : fields;
    return { startAt: offset, maxResults: limit, total, isLast: offset + rows.length >= total, issues: rows.map((r) => issueJson(r, list?.length ? list : SEARCH_FIELDS)) };
  }

  function normalizeName(value, allowed, what) {
    const name = typeof value === 'object' && value ? value.name ?? value.id : value;
    const hit = allowed.find((a) => a.toLowerCase() === String(name).toLowerCase());
    if (!hit) throw new HttpError(400, `Unknown ${what} "${name}". Use one of: ${allowed.join(', ')}`);
    return hit;
  }

  function labelsList(value) {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list.map((l) => String(l).trim().replace(/\s+/g, '-')).filter(Boolean);
  }

  function createIssue(fields = {}) {
    const projectKey = typeof fields.project === 'object' ? fields.project?.key || fields.project?.id : fields.project;
    if (!projectKey) throw new HttpError(400, 'fields.project.key is required');
    if (!fields.summary || !String(fields.summary).trim()) throw new HttpError(400, 'fields.summary is required');
    const t = stamp();
    const key = tx(() =>
      insertIssue({
        project: projectKey,
        type: normalizeName(fields.issuetype || 'Task', ISSUE_TYPES, 'issue type'),
        summary: String(fields.summary).trim(),
        description: toPlainText(fields.description),
        status: 'To Do',
        priority: normalizeName(fields.priority || 'Medium', PRIORITIES, 'priority'),
        assignee: userByRef(fields.assignee),
        reporter: userByRef(fields.reporter) || currentUser(),
        labels: labelsList(fields.labels),
        created: t,
        updated: t,
      }),
    );
    event('issue.created', key, String(fields.summary).trim());
    const row = issueRow(key);
    return { id: String(row.id), key, self: `/rest/api/3/issue/${key}` };
  }

  function editIssue(key, fields = {}) {
    const row = issueRow(key);
    const sets = {};
    for (const [name, value] of Object.entries(fields)) {
      switch (name) {
        case 'summary':
          if (!String(value).trim()) throw new HttpError(400, 'summary cannot be empty');
          sets.summary = String(value).trim();
          break;
        case 'description':
          sets.description = toPlainText(value);
          break;
        case 'priority':
          sets.priority = normalizeName(value, PRIORITIES, 'priority');
          break;
        case 'issuetype':
          sets.type = normalizeName(value, ISSUE_TYPES, 'issue type');
          break;
        case 'labels':
          sets.labels = JSON.stringify(labelsList(value));
          break;
        case 'assignee':
          sets.assignee = userByRef(value);
          break;
        case 'status':
          throw new HttpError(400, 'Status cannot be edited. Use the transitions endpoint (transitionJiraIssue).');
        default:
          throw new HttpError(400, `Field "${name}" cannot be edited. Editable: summary, description, priority, issuetype, labels, assignee`);
      }
    }
    if (!Object.keys(sets).length) throw new HttpError(400, 'No fields to edit');
    sets.updated = stamp();
    const cols = Object.keys(sets);
    q(`UPDATE issues SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE key = ?`).run(...cols.map((c) => sets[c]), row.key);
    event('issue.edited', row.key, `Edited ${Object.keys(fields).join(', ')}`);
  }

  function addComment(key, body, author) {
    const row = issueRow(key);
    const text = toPlainText(body).trim();
    if (!text) throw new HttpError(400, 'Comment body is empty');
    const t = stamp();
    const r = q('INSERT INTO comments (issue_key, author, body, created) VALUES (?, ?, ?, ?)').run(row.key, userByRef(author) || currentUser(), text, t);
    q('UPDATE issues SET updated = ? WHERE key = ?').run(t, row.key);
    event('issue.commented', row.key, text.slice(0, 80));
    return commentJson(q('SELECT * FROM comments WHERE id = ?').get(Number(r.lastInsertRowid)));
  }

  function transitions(key) {
    const row = issueRow(key);
    return {
      transitions: STATUSES.filter((s) => s.name !== row.status).map((s) => ({
        id: s.id,
        name: s.name,
        to: { id: s.id, name: s.name, statusCategory: { key: s.category } },
      })),
    };
  }

  function transition(key, body = {}) {
    const row = issueRow(key);
    const want = body.transition?.id ?? body.transition?.name ?? body.transitionId ?? body.transition;
    const target = STATUSES.find((s) => s.id === String(want) || s.name.toLowerCase() === String(want).toLowerCase());
    if (!target) throw new HttpError(400, `Unknown transition "${want}". Get the ids from the transitions endpoint.`);
    if (target.name === row.status) throw new HttpError(400, `Issue ${row.key} is already in "${row.status}"`);
    q('UPDATE issues SET status = ?, updated = ? WHERE key = ?').run(target.name, stamp(), row.key);
    event('issue.transitioned', row.key, `${row.status} → ${target.name}`);
    const comment = body.update?.comment?.[0]?.add?.body ?? body.comment;
    if (comment) addComment(row.key, comment);
  }

  // ---------- Confluence ----------
  function spaceRow(ref) {
    const s = q('SELECT * FROM spaces WHERE CAST(id AS TEXT) = ? OR lower(key) = lower(?)').get(String(ref), String(ref));
    if (!s) throw new HttpError(404, `Space not found: ${ref}`);
    return s;
  }
  const spaceJson = (s) => ({
    id: String(s.id),
    key: s.key,
    name: s.name,
    type: 'global',
    status: 'current',
    description: { plain: { value: s.description } },
    homepageId: s.homepage_id ? String(s.homepage_id) : null,
    _links: { webui: `/#/wiki/${s.key}` },
  });

  function pageRow(id) {
    const p = q('SELECT * FROM pages WHERE id = ?').get(Number(id));
    if (!p) throw new HttpError(404, `Page not found: ${id}`);
    return p;
  }
  function pageJson(p, withBody = true) {
    const space = q('SELECT id FROM spaces WHERE key = ?').get(p.space_key);
    return {
      id: String(p.id),
      status: 'current',
      title: p.title,
      spaceId: String(space.id),
      spaceKey: p.space_key,
      parentId: p.parent_id ? String(p.parent_id) : null,
      authorId: p.author,
      createdAt: p.created,
      version: { number: p.version, createdAt: p.updated },
      ...(withBody ? { body: { representation: 'markdown', value: p.body } } : {}),
      _links: { webui: `/#/page/${p.id}` },
    };
  }

  function bodyText(body) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string') return body;
    if (body.value !== undefined) return toPlainText(body.value);
    if (body.storage?.value !== undefined) return toPlainText(body.storage.value);
    if (body.markdown?.value !== undefined) return toPlainText(body.markdown.value);
    return toPlainText(body);
  }

  function createPage({ spaceId, spaceKey, title, parentId, body } = {}) {
    const space = spaceRow(spaceId ?? spaceKey ?? '');
    if (!title || !String(title).trim()) throw new HttpError(400, 'title is required');
    const clean = String(title).trim();
    if (q('SELECT 1 FROM pages WHERE space_key = ? AND lower(title) = lower(?)').get(space.key, clean)) {
      throw new HttpError(400, `A page titled "${clean}" already exists in space ${space.key}`);
    }
    let parent = null;
    if (parentId) {
      const pr = pageRow(parentId);
      if (pr.space_key !== space.key) throw new HttpError(400, 'Parent page is in another space');
      parent = pr.id;
    } else {
      parent = space.homepage_id || null;
    }
    const t = stamp();
    const r = q('INSERT INTO pages (space_key, parent_id, title, body, version, author, created, updated) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
      .run(space.key, parent, clean, bodyText(body) || '', currentUser(), t, t);
    const id = Number(r.lastInsertRowid);
    event('page.created', `${space.key}/${id}`, clean);
    return pageJson(pageRow(id));
  }

  function updatePage(id, { title, body, version } = {}) {
    const p = pageRow(id);
    const wanted = version?.number ?? version;
    if (wanted !== undefined && Number(wanted) !== p.version + 1) {
      throw new HttpError(409, `Version conflict: page ${p.id} is at version ${p.version}, so send version.number ${p.version + 1}`);
    }
    const newTitle = title ? String(title).trim() : p.title;
    if (newTitle.toLowerCase() !== p.title.toLowerCase() &&
        q('SELECT 1 FROM pages WHERE space_key = ? AND lower(title) = lower(?) AND id <> ?').get(p.space_key, newTitle, p.id)) {
      throw new HttpError(400, `A page titled "${newTitle}" already exists in space ${p.space_key}`);
    }
    const newBody = bodyText(body);
    q('UPDATE pages SET title = ?, body = ?, version = version + 1, updated = ?, author = ? WHERE id = ?')
      .run(newTitle, newBody ?? p.body, stamp(), currentUser(), p.id);
    event('page.updated', `${p.space_key}/${p.id}`, newTitle);
    return pageJson(pageRow(p.id));
  }

  function excerpt(text, cql) {
    const words = [...String(cql).matchAll(/~\s*["']([^"']+)["']/g)].flatMap((m) => m[1].split(/\s+/));
    const lower = text.toLowerCase();
    const at = words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, at - 60);
    return (start > 0 ? '…' : '') + text.slice(start, start + 200).replace(/\s+/g, ' ').trim() + '…';
  }

  function searchPages({ cql = '', limit = 25, start = 0 } = {}) {
    let compiled;
    try {
      compiled = compileCql(cql, { now: now() });
    } catch (err) {
      if (err instanceof QueryError) throw new HttpError(400, `CQL: ${err.message}`);
      throw err;
    }
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const off = Math.max(Number(start) || 0, 0);
    const total = q(`SELECT count(*) AS n FROM pages p WHERE ${compiled.where}`).get(...compiled.params).n;
    const rows = q(`SELECT p.* FROM pages p WHERE ${compiled.where} ORDER BY ${compiled.orderBy} LIMIT ? OFFSET ?`).all(...compiled.params, lim, off);
    return {
      results: rows.map((p) => ({
        content: { id: String(p.id), type: 'page', status: 'current', title: p.title, space: { key: p.space_key } },
        title: p.title,
        excerpt: excerpt(p.body, cql),
        url: `/#/page/${p.id}`,
        lastModified: p.updated,
      })),
      start: off,
      limit: lim,
      size: rows.length,
      totalSize: total,
    };
  }

  return {
    db,
    reset,
    currentUser,
    search,
    issueRow,
    issueJson,
    createIssue,
    editIssue,
    addComment,
    transitions,
    transition,
    projects: () => q('SELECT key, name, lead FROM projects ORDER BY key').all().map((p) => ({ key: p.key, name: p.name, lead: userJson(p.lead) })),
    users: () => q('SELECT * FROM users ORDER BY display_name').all().map((u) => userJson(u.account_id)),
    spaces: (keys) => {
      const list = keys ? String(keys).split(',').map((k) => k.trim().toLowerCase()) : null;
      return q('SELECT * FROM spaces ORDER BY key').all().filter((s) => !list || list.includes(s.key.toLowerCase())).map(spaceJson);
    },
    spaceRow,
    spacePages: (ref) => {
      const s = spaceRow(ref);
      return q('SELECT * FROM pages WHERE space_key = ? ORDER BY parent_id IS NOT NULL, parent_id, title').all(s.key).map((p) => pageJson(p, false));
    },
    page: (id) => pageJson(pageRow(id)),
    createPage,
    updatePage,
    searchPages,
    events: (since = 0) => q('SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT 100').all(Number(since) || 0),
    close: () => db.close(),
  };
}

/** mcp: { server, token } mounts the simulated remote MCP endpoint at /mcp. */
export function createApp(store, { mcp } = {}) {
  const r = createRouter();
  if (mcp) mountHttp(r, '/mcp', mcp.server, { token: mcp.token });
  r.get('/health', () => ({ ok: true, service: 'atlassian' }));
  r.post('/admin/reset', () => {
    store.reset();
    return { ok: true };
  });
  r.get('/admin/events', ({ query }) => ({ events: store.events(query.since) }));

  // Jira v3 subset
  r.get('/rest/api/3/myself', () => store.users().find((u) => u.accountId === store.currentUser()) || { accountId: store.currentUser() });
  r.get('/rest/api/3/users', () => store.users());
  r.get('/rest/api/3/project', () => store.projects());
  r.get('/rest/api/3/search/jql', ({ query }) => store.search(query));
  r.post('/rest/api/3/search/jql', ({ body }) => store.search(body || {}));
  r.get('/rest/api/3/search', ({ query }) => store.search(query));
  r.post('/rest/api/3/issue', ({ body }) => reply(201, store.createIssue(body?.fields)));
  r.get('/rest/api/3/issue/:key', ({ params, query }) => {
    const fields = query.fields ? query.fields.split(',').map((s) => s.trim()) : undefined;
    return store.issueJson(store.issueRow(params.key), fields);
  });
  r.put('/rest/api/3/issue/:key', ({ params, body }) => {
    store.editIssue(params.key, body?.fields);
  });
  r.get('/rest/api/3/issue/:key/comment', ({ params }) => store.issueJson(store.issueRow(params.key), ['comment']).fields.comment);
  r.post('/rest/api/3/issue/:key/comment', ({ params, body }) => reply(201, store.addComment(params.key, body?.body)));
  r.get('/rest/api/3/issue/:key/transitions', ({ params }) => store.transitions(params.key));
  r.post('/rest/api/3/issue/:key/transitions', ({ params, body }) => {
    store.transition(params.key, body);
  });

  // Confluence v2 subset (+ v1 CQL search)
  r.get('/wiki/api/v2/spaces', ({ query }) => ({ results: store.spaces(query.keys) }));
  r.get('/wiki/api/v2/spaces/:id', ({ params }) => store.spaces().find((s) => s.id === params.id || s.key.toLowerCase() === params.id.toLowerCase()) || (() => { throw new HttpError(404, `Space not found: ${params.id}`); })());
  r.get('/wiki/api/v2/spaces/:id/pages', ({ params }) => ({ results: store.spacePages(params.id) }));
  r.get('/wiki/api/v2/pages/:id', ({ params }) => store.page(params.id));
  r.post('/wiki/api/v2/pages', ({ body }) => reply(200, store.createPage(body || {})));
  r.put('/wiki/api/v2/pages/:id', ({ params, body }) => store.updatePage(params.id, body || {}));
  r.get('/wiki/rest/api/search', ({ query }) => store.searchPages(query));

  r.static('/', path.join(HERE, 'ui'));
  return r;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(arg('port', process.env.LABKIT_ATLASSIAN_PORT || DEFAULT_PORT));
  const dbPath = arg('db', DEFAULT_DB);
  const store = createStore({ dbPath, seedPath: arg('seed', DEFAULT_SEED) });
  const empty = store.db.prepare('SELECT count(*) AS n FROM projects').get().n === 0;
  if (empty || process.argv.includes('--reset')) store.reset();
  process.env.LABKIT_ATLASSIAN_URL ||= `http://127.0.0.1:${port}`;
  const { server: mcpServer } = await import('../../mcp/atlassian.mjs');
  const { getToken } = await import('../../lib/token.mjs');
  const server = await listen(createApp(store, { mcp: { server: mcpServer, token: getToken() } }), port);
  console.log(`[atlassian] Jira + Confluence mock on http://127.0.0.1:${server.address().port} (db ${dbPath}), remote MCP at /mcp`);
}

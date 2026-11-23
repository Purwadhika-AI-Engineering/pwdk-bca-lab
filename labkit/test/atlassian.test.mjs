import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStore, createApp, toPlainText } from '../services/atlassian/server.mjs';
import { listen, requestJson } from '../lib/http.mjs';
import { parse, QueryError } from '../services/atlassian/jql.mjs';

const seedPath = fileURLToPath(new URL('./fixtures/atlassian-seed.json', import.meta.url));
let store, server, base;
const api = (method, path, body) => requestJson(base, method, path, body);
const keys = (r) => r.issues.map((i) => i.key);

before(async () => {
  store = createStore({ seedPath });
  store.reset();
  server = await listen(createApp(store), 0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  store.close();
});

test('JQL parser handles precedence, IN lists and ORDER BY', () => {
  const ast = parse('project = LB AND (status = "To Do" OR status IN (Done, "In Progress")) ORDER BY created DESC, key');
  assert.equal(ast.where.type, 'and');
  assert.equal(ast.where.right.type, 'or');
  assert.deepEqual(ast.where.right.right.values.map((v) => v.value), ['Done', 'In Progress']);
  assert.deepEqual(ast.order, [{ field: 'created', dir: 'DESC' }, { field: 'key', dir: 'ASC' }]);
  assert.throws(() => parse('project = LB status = Done'), QueryError);
  assert.throws(() => parse('summary ~ "open'), /closing quote/);
});

test('search by project, status and priority', async () => {
  assert.deepEqual(keys(await api('GET', '/rest/api/3/search/jql?jql=' + encodeURIComponent('project = LB ORDER BY key'))), ['LB-1', 'LB-2', 'LB-3']);
  assert.deepEqual(keys(await api('GET', '/rest/api/3/search/jql?jql=' + encodeURIComponent('project = lb AND status = "to do"'))), ['LB-1']);
  assert.deepEqual(keys(await api('GET', '/rest/api/3/search/jql?jql=' + encodeURIComponent('status != Done AND project = LB ORDER BY priority DESC'))), ['LB-1', 'LB-2']);
  assert.deepEqual(keys(await api('GET', '/rest/api/3/search/jql?jql=' + encodeURIComponent('priority in (Low, Medium) ORDER BY key'))), ['LB-2', 'LB-3', 'OPS-1']);
});

test('search by assignee name, account id and currentUser()', async () => {
  const s = (jql) => api('POST', '/rest/api/3/search/jql', { jql: jql + ' ORDER BY key' }).then(keys);
  assert.deepEqual(await s('assignee = "Rina QA"'), ['LB-1']);
  assert.deepEqual(await s('assignee = dimas'), ['OPS-1']);
  assert.deepEqual(await s('assignee = currentUser()'), ['LB-2']);
  assert.deepEqual(await s('assignee is EMPTY'), ['LB-3']);
});

test('search by labels and text, including comments', async () => {
  const s = (jql) => api('POST', '/rest/api/3/search/jql', { jql }).then(keys);
  assert.deepEqual(await s('labels = transfer'), ['LB-1']);
  assert.deepEqual(await s('labels in (ui, nothing)'), ['LB-2']);
  assert.deepEqual(await s('text ~ "balance receipt"'), ['LB-1']);
  assert.deepEqual(await s('text ~ "reproduce staging"'), ['LB-1']);
  assert.deepEqual(await s('summary ~ csv'), ['LB-3']);
  assert.deepEqual(await s('created >= -3d ORDER BY key'), ['LB-1', 'OPS-1']);
});

test('bad JQL is a 400 with a helpful message', async () => {
  await assert.rejects(api('GET', '/rest/api/3/search/jql?jql=' + encodeURIComponent('sprint = 5')), /400 JQL: Field "sprint" is not supported.*project/);
});

test('search returns only the asked fields and paginates', async () => {
  const r = await api('GET', '/rest/api/3/search/jql?jql=project%3DLB&fields=summary&maxResults=2');
  assert.equal(r.total, 3);
  assert.equal(r.issues.length, 2);
  assert.equal(r.isLast, false);
  assert.deepEqual(Object.keys(r.issues[0].fields), ['summary']);
});

test('get issue returns fields and comments', async () => {
  const i = await api('GET', '/rest/api/3/issue/LB-1');
  assert.equal(i.fields.summary, 'Balance looks wrong after transfer');
  assert.equal(i.fields.status.name, 'To Do');
  assert.equal(i.fields.assignee.displayName, 'Rina QA');
  assert.deepEqual(i.fields.labels, ['customer-report', 'transfer']);
  assert.equal(i.fields.comment.comments[0].body, 'Can you reproduce on staging?');
  await assert.rejects(api('GET', '/rest/api/3/issue/LB-99'), /404 Issue does not exist/);
});

test('create, edit and comment on an issue', async () => {
  const created = await api('POST', '/rest/api/3/issue', {
    fields: { project: { key: 'LB' }, summary: 'New bug', issuetype: { name: 'bug' }, description: 'Steps', labels: ['triage'], assignee: { accountId: 'dimas' } },
  });
  assert.equal(created.key, 'LB-4');
  await api('PUT', '/rest/api/3/issue/LB-4', { fields: { summary: 'New bug (edited)', priority: { name: 'High' } } });
  const c = await api('POST', '/rest/api/3/issue/LB-4/comment', { body: 'Found it in the logs' });
  assert.equal(c.author.accountId, 'me');
  const i = await api('GET', '/rest/api/3/issue/LB-4');
  assert.equal(i.fields.summary, 'New bug (edited)');
  assert.equal(i.fields.priority.name, 'High');
  assert.equal(i.fields.issuetype.name, 'Bug');
  assert.equal(i.fields.reporter.accountId, 'me');
  assert.equal(i.fields.comment.total, 1);
  await assert.rejects(api('PUT', '/rest/api/3/issue/LB-4', { fields: { status: 'Done' } }), /Use the transitions endpoint/);
  await assert.rejects(api('POST', '/rest/api/3/issue', { fields: { project: { key: 'NOPE' }, summary: 'x' } }), /Unknown project/);
});

test('comments accept Atlassian Document Format', async () => {
  const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'ADF' }] }] };
  assert.equal(toPlainText(adf), 'Hello ADF\n');
  const c = await api('POST', '/rest/api/3/issue/LB-2/comment', { body: adf });
  assert.equal(c.body, 'Hello ADF');
});

test('transitions list and move an issue', async () => {
  const t = await api('GET', '/rest/api/3/issue/LB-1/transitions');
  assert.deepEqual(t.transitions.map((x) => x.name), ['In Progress', 'Done']);
  const toProgress = t.transitions.find((x) => x.name === 'In Progress');
  await api('POST', '/rest/api/3/issue/LB-1/transitions', { transition: { id: toProgress.id } });
  assert.equal((await api('GET', '/rest/api/3/issue/LB-1')).fields.status.name, 'In Progress');
  await assert.rejects(api('POST', '/rest/api/3/issue/LB-1/transitions', { transition: { id: '21' } }), /already in "In Progress"/);
  await assert.rejects(api('POST', '/rest/api/3/issue/LB-1/transitions', { transition: { id: '99' } }), /Unknown transition/);
});

test('Confluence spaces, page tree and page body', async () => {
  const spaces = await api('GET', '/wiki/api/v2/spaces');
  assert.deepEqual(spaces.results.map((s) => s.key), ['LB', 'OPS']);
  const lb = spaces.results[0];
  const pages = await api('GET', `/wiki/api/v2/spaces/${lb.id}/pages`);
  assert.deepEqual(pages.results.map((p) => p.title), ['Lab Bank home', 'Architecture', 'Incident runbook']);
  assert.equal(pages.results[1].parentId, lb.homepageId);
  const page = await api('GET', `/wiki/api/v2/pages/${pages.results[1].id}`);
  assert.match(page.body.value, /Spring Boot/);
});

test('CQL search by space, title and text', async () => {
  const s = (cql) => api('GET', '/wiki/rest/api/search?cql=' + encodeURIComponent(cql)).then((r) => r.results.map((x) => x.title).sort());
  assert.deepEqual(await s('space = LB AND title ~ "runbook"'), ['Incident runbook']);
  assert.deepEqual(await s('text ~ "grafana errors"'), ['Incident runbook']);
  assert.deepEqual(await s('space.key = OPS'), ['On-call']);
  assert.deepEqual(await s('type = page AND space IN (LB, OPS) AND text ~ pager'), ['On-call']);
  const r = await api('GET', '/wiki/rest/api/search?cql=' + encodeURIComponent('text ~ "accounts table"'));
  assert.match(r.results[0].excerpt, /accounts table/);
  await assert.rejects(api('GET', '/wiki/rest/api/search?cql=' + encodeURIComponent('label = x')), /400 CQL: Field "label"/);
});

test('create and update a page with version checks', async () => {
  const p = await api('POST', '/wiki/api/v2/pages', { spaceId: 'LB', title: 'Postmortem: wrong balance', body: { representation: 'storage', value: '# Summary' } });
  assert.equal(p.version.number, 1);
  assert.equal(p.spaceKey, 'LB');
  assert.ok(p.parentId, 'defaults to the space home page');
  await assert.rejects(api('POST', '/wiki/api/v2/pages', { spaceId: 'LB', title: 'postmortem: WRONG balance', body: 'x' }), /already exists/);
  await assert.rejects(api('PUT', `/wiki/api/v2/pages/${p.id}`, { title: 'x', body: 'y', version: { number: 5 } }), /409 Version conflict/);
  const u = await api('PUT', `/wiki/api/v2/pages/${p.id}`, { body: { value: '# Summary\nFixed' }, version: { number: 2 } });
  assert.equal(u.version.number, 2);
  assert.equal(u.title, 'Postmortem: wrong balance');
  assert.equal(u.body.value, '# Summary\nFixed');
});

test('events record changes and reset restores the seed', async () => {
  const ev = await api('GET', '/admin/events');
  assert.ok(ev.events.some((e) => e.kind === 'issue.transitioned' && e.target === 'LB-1'));
  await api('POST', '/admin/reset');
  assert.equal((await api('GET', '/rest/api/3/issue/LB-1')).fields.status.name, 'To Do');
  await assert.rejects(api('GET', '/rest/api/3/issue/LB-4'), /404/);
  const again = await api('POST', '/rest/api/3/issue', { fields: { project: { key: 'LB' }, summary: 'After reset' } });
  assert.equal(again.key, 'LB-4');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, createApp } from '../services/atlassian/server.mjs';
import { listen } from '../lib/http.mjs';
import { parseArgs, resolveTool, SERVICES } from '../cli.mjs';

const seedPath = fileURLToPath(new URL('./fixtures/atlassian-seed.json', import.meta.url));
let store, server, tools;
const call = (name, args = {}) => tools.find((t) => t.name === name).handler(args);

before(async () => {
  store = createStore({ seedPath });
  store.reset();
  server = await listen(createApp(store), 0);
  process.env.LABKIT_ATLASSIAN_URL = `http://127.0.0.1:${server.address().port}`;
  ({ tools } = await import('../mcp/atlassian.mjs'));
});
after(() => {
  server.close();
  store.close();
});

test('tool names mirror the Atlassian MCP server', () => {
  const names = tools.map((t) => t.name);
  for (const n of ['searchJiraIssuesUsingJql', 'getJiraIssue', 'createJiraIssue', 'editJiraIssue', 'addCommentToJiraIssue',
    'getTransitionsForJiraIssue', 'transitionJiraIssue', 'getConfluenceSpaces', 'searchConfluenceUsingCql',
    'getConfluencePage', 'createConfluencePage', 'updateConfluencePage']) {
    assert.ok(names.includes(n), n);
  }
});

test('the Day 2 loop: search, read, comment, transition, create a page', async () => {
  const found = await call('searchJiraIssuesUsingJql', { cloudId: 'labkit', jql: 'project = LB AND text ~ "balance"' });
  assert.equal(found.total, 1);
  assert.equal(found.issues[0].key, 'LB-1');
  assert.equal(found.issues[0].status, 'To Do');
  assert.match(found.issues[0].url, /#\/issue\/LB-1$/);

  const issue = await call('getJiraIssue', { issueIdOrKey: 'LB-1' });
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.assignee.displayName, 'Rina QA');

  await call('addCommentToJiraIssue', { issueIdOrKey: 'LB-1', commentBody: 'Root cause found, see postmortem.' });
  const t = await call('getTransitionsForJiraIssue', { issueIdOrKey: 'LB-1' });
  const done = t.find((x) => x.name === 'Done');
  const moved = await call('transitionJiraIssue', { issueIdOrKey: 'LB-1', transition: { id: done.id } });
  assert.equal(moved.status, 'Done');

  const spaces = await call('getConfluenceSpaces', { keys: ['LB'] });
  const page = await call('createConfluencePage', { spaceId: spaces[0].id, title: 'Postmortem LB-1', body: '# Postmortem\n\nDetails' });
  assert.equal(page.version, 1);
  const updated = await call('updateConfluencePage', { pageId: page.id, body: '# Postmortem\n\nMore details' });
  assert.equal(updated.version, 2);
  const read = await call('getConfluencePage', { pageId: page.id });
  assert.equal(read.body, '# Postmortem\n\nMore details');
  const search = await call('searchConfluenceUsingCql', { cql: 'space = LB AND title ~ postmortem' });
  assert.equal(search.results[0].id, page.id);
});

test('create and edit an issue', async () => {
  const users = await call('lookupJiraAccountId', { searchString: 'dimas' });
  const created = await call('createJiraIssue', {
    projectKey: 'LB', issueTypeName: 'Bug', summary: 'Found by agent', description: 'Steps', assignee_account_id: users[0].accountId,
    additional_fields: { priority: { name: 'High' }, labels: ['agent'] },
  });
  const edited = await call('editJiraIssue', { issueIdOrKey: created.key, fields: { labels: ['agent', 'triaged'] } });
  assert.deepEqual(edited.labels, ['agent', 'triaged']);
  assert.equal(edited.priority, 'High');
  assert.equal(edited.assignee.accountId, 'dimas');
});

test('missing arguments and server errors come back as clear errors', async () => {
  await assert.rejects(call('getJiraIssue', {}), /"issueIdOrKey" is required/);
  await assert.rejects(call('searchJiraIssuesUsingJql', { jql: 'sprint = 1' }), /400 JQL: Field "sprint"/);
});

test('MCP server over stdio lists and calls tools', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp/atlassian.mjs', import.meta.url))], {
    env: { ...process.env, LABKIT_ATLASSIAN_URL: process.env.LABKIT_ATLASSIAN_URL },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'getJiraIssue', arguments: { issueIdOrKey: 'LB-2' } } });
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(replies[1].result.tools.length >= 12);
  assert.equal(JSON.parse(replies[2].result.content[0].text).summary, 'Update login page copy');
});

test('CLI resolves aliases and kebab-case names', () => {
  const { aliases } = SERVICES.atlassian;
  assert.equal(resolveTool(tools, aliases, 'search').name, 'searchJiraIssuesUsingJql');
  assert.equal(resolveTool(tools, aliases, 'get-jira-issue').name, 'getJiraIssue');
  assert.equal(resolveTool(tools, aliases, 'GETJIRAISSUE').name, 'getJiraIssue');
  assert.equal(resolveTool(tools, aliases, 'nope'), undefined);
});

test('CLI parses positional, nested, typed and file arguments', () => {
  const tool = (n) => tools.find((t) => t.name === n).inputSchema;
  assert.deepEqual(parseArgs(['LB-1', '21'], tool('transitionJiraIssue')).args, { issueIdOrKey: 'LB-1', transition: { id: '21' } });
  assert.deepEqual(parseArgs(['LB-1', '--transition.id', '31'], tool('transitionJiraIssue')).args, { issueIdOrKey: 'LB-1', transition: { id: '31' } });
  assert.deepEqual(parseArgs(['--jql=project = LB', '--maxResults', '5', '--fields', 'summary,status'], tool('searchJiraIssuesUsingJql')).args,
    { jql: 'project = LB', maxResults: 5, fields: ['summary', 'status'] });
  assert.deepEqual(parseArgs(['LB-1', '--commentBody-file', 'x.md'], tool('addCommentToJiraIssue'), { readFile: () => 'from file' }).args,
    { issueIdOrKey: 'LB-1', commentBody: 'from file' });
  assert.deepEqual(parseArgs(['LB-1', '--fields', '{"summary":"x"}'], tool('editJiraIssue')).args, { issueIdOrKey: 'LB-1', fields: { summary: 'x' } });
  assert.throws(() => parseArgs(['a', 'b', 'c'], tool('getJiraIssue')), /Too many positional/);
});

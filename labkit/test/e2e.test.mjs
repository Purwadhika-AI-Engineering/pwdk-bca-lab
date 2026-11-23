// End-to-end check of the Day 2 loop, through the MCP servers over stdio (like Kiro).
// Needs labkit\start.cmd and labkit\backend.cmd running, and traffic sent once.
// It changes Jira/Confluence data and resets it at the end, so it only runs with LABKIT_E2E=1:
//   set LABKIT_E2E=1 && node --test labkit/test/e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const enabled = process.env.LABKIT_E2E === '1';

/** A tiny MCP stdio client, started the way .kiro/settings/mcp.json starts servers. */
function mcp(file) {
  const child = spawn(process.execPath, [`labkit/mcp/${file}.mjs`], { cwd: ROOT });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    init: () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }),
    async call(name, args) {
      const r = await request('tools/call', { name, arguments: args });
      const text = r.result.content[0].text;
      if (r.result.isError) throw new Error(text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => child.stdin.end(),
  };
}

test('Day 2 loop: Jira search, logs, DB, comment, transition, postmortem page', { skip: !enabled && 'set LABKIT_E2E=1 to run' }, async () => {
  const jira = mcp('atlassian');
  const grafana = mcp('grafana');
  const db = mcp('db');
  await Promise.all([jira.init(), grafana.init(), db.init()]);
  try {
    // 1. Find the ticket
    const found = await jira.call('searchJiraIssuesUsingJql', { jql: 'project = LB AND labels = customer-report AND text ~ "balance" ORDER BY priority DESC' });
    assert.equal(found.total, 1);
    const key = found.issues[0].key;
    const issue = await jira.call('getJiraIssue', { issueIdOrKey: key });
    assert.equal(issue.status, 'To Do');

    // 2. Logs: the transfer calls and the errors
    const transfers = await grafana.call('query_loki_logs', { logql: '{logger="labkit.request"} | json | path = "/api/transfers" and method = "POST" and status = 201' });
    assert.ok(Array.isArray(transfers) && transfers.length >= 1, 'transfer requests are in the logs');
    const errors = await grafana.call('query_loki_logs', { logql: '{job="banklab-backend"} | json | status >= 400' });
    assert.ok(errors.some((e) => JSON.parse(e.line).errorCode === 'LIMIT_EXCEEDED'), 'R4 error is in the logs');
    const traceId = JSON.parse(transfers[0].line).traceId;
    const sameTrace = await grafana.call('query_loki_logs', { logql: `{job="banklab-backend"} | json | traceId = "${traceId}"` });
    assert.ok(sameTrace.length >= 1);
    const rate = await grafana.call('query_prometheus', { expr: 'sum by (status) (increase(http_requests_total[1h]))' });
    assert.ok(rate.some((s) => s.metric.status === '422'));

    // 3. Read-only DB
    const rows = await db.call('query', { sql: 'SELECT reference_no, from_account, amount, status FROM transfers ORDER BY id DESC LIMIT 5' });
    assert.equal(rows.rowCount, 5);
    await assert.rejects(db.call('query', { sql: "UPDATE accounts SET owner = 'x'" }), /Only SELECT/);

    // 4. Comment and transition
    await jira.call('addCommentToJiraIssue', { issueIdOrKey: key, commentBody: 'e2e: checked logs and data.' });
    const t = await jira.call('getTransitionsForJiraIssue', { issueIdOrKey: key });
    const moved = await jira.call('transitionJiraIssue', { issueIdOrKey: key, transition: { id: t.find((x) => x.name === 'In Progress').id } });
    assert.equal(moved.status, 'In Progress');

    // 5. Postmortem page from the template
    const tpl = await jira.call('searchConfluenceUsingCql', { cql: 'space = LB AND title ~ "postmortem template"' });
    const template = await jira.call('getConfluencePage', { pageId: tpl.results[0].id });
    const page = await jira.call('createConfluencePage', {
      spaceId: 'LB',
      parentId: template.parentId,
      title: `Postmortem: e2e check (${key})`,
      body: template.body.replace('<short title>', 'e2e check').replace('<Jira key>', key),
    });
    assert.equal(page.version, 1);
  } finally {
    jira.close();
    grafana.close();
    db.close();
    await fetch('http://127.0.0.1:4310/admin/reset', { method: 'POST' });
  }
});

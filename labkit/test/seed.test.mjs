import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../services/atlassian/server.mjs';

const seedDir = fileURLToPath(new URL('../seed/', import.meta.url));

/** Text that participants read in Jira and Confluence. */
function pageText() {
  const files = [path.join(seedDir, 'atlassian.json'), ...fs.readdirSync(path.join(seedDir, 'pages')).map((f) => path.join(seedDir, 'pages', f))];
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

/** Plus the traffic scenario (its notes show up in logs). */
function allSeedText() {
  return pageText() + '\n' + fs.readFileSync(path.join(seedDir, 'traffic-scenario.json'), 'utf8');
}

test('the real seed loads: project LB, one Lab 5 bug, six other tickets, space LB', () => {
  const store = createStore({});
  store.reset();
  const all = store.search({ jql: 'project = LB', maxResults: 100 });
  assert.equal(all.total, 7);
  const bug = store.search({ jql: 'project = LB AND type = Bug AND labels = customer-report AND priority = High' });
  assert.equal(bug.total, 1);
  assert.match(bug.issues[0].fields.summary, /balance/i);
  const titles = store.spacePages('LB').map((p) => p.title);
  for (const t of ['Architecture overview', 'Incident runbook', 'Postmortem template']) assert.ok(titles.includes(t), t);
  assert.equal(store.searchPages({ cql: 'space = LB AND title ~ "postmortem template"' }).totalSize, 1);
  store.close();
});

// Seed text describes symptoms only. These words would point at a planted bug or its fix.
const SPOILERS = [
  /\bcents?\b/i, /balance_cents/i, /balanceAfter/i, /100\s*[x×]|times 100|divide/i, /HALF_UP|HALF_EVEN|rounding/i,
  /@Transactional|transaction boundary|atomic/i, /\bIDOR\b|owner check|another user's account/i, /SQL injection|injection/i,
  /\bXSS\b|innerHTML|bypassSecurityTrust/i, /lodash/i, /\bNIK\b/i, /in memory store|balance store|stored value/i,
];

test('seed text has no spoilers for the planted bugs', () => {
  const text = allSeedText();
  for (const re of SPOILERS) assert.doesNotMatch(text, re);
});

test('Jira and Confluence text shows no clear account numbers', () => {
  assert.doesNotMatch(pageText(), /(?<![*\d])\d{10,13}(?!\d)/);
});

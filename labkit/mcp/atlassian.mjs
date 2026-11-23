#!/usr/bin/env node
// MCP server for the labkit Atlassian mock (Jira + Confluence).
// Tool names and arguments follow the Atlassian Remote MCP server, so prompts carry over.
// "cloudId" is accepted everywhere and ignored: there is one local site.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, runStdio } from '../lib/mcp.mjs';
import { requestJson } from '../lib/http.mjs';

export const BASE_URL = process.env.LABKIT_ATLASSIAN_URL || 'http://127.0.0.1:4310';
const api = (method, p, body) => requestJson(BASE_URL, method, p, body);
const enc = encodeURIComponent;
const web = (hash) => `${BASE_URL}/${hash}`;

const cloudId = { type: 'string', description: 'Optional. Ignored: labkit has one local site ("labkit").' };
const issueKey = { type: 'string', description: 'Issue key or id, for example LB-1' };
const schema = (properties, required = []) => ({ type: 'object', properties: { cloudId, ...properties }, required });

function need(args, ...names) {
  for (const n of names) {
    if (args[n] === undefined || args[n] === null || args[n] === '') throw new Error(`"${n}" is required`);
  }
}

/** Short issue summary for search results: easier for agents to read than the raw Jira shape. */
function brief(issue) {
  const f = issue.fields;
  const out = { key: issue.key, url: web(`#/issue/${issue.key}`) };
  if (f.summary !== undefined) out.summary = f.summary;
  if (f.status) out.status = f.status.name;
  if (f.issuetype) out.type = f.issuetype.name;
  if (f.priority) out.priority = f.priority.name;
  if (f.assignee !== undefined) out.assignee = f.assignee?.displayName ?? null;
  if (f.labels) out.labels = f.labels;
  if (f.updated) out.updated = f.updated;
  for (const [k, v] of Object.entries(f)) if (!(k in out) && !['issuetype'].includes(k)) out[k] = v;
  return out;
}

function fullIssue(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    id: issue.id,
    url: web(`#/issue/${issue.key}`),
    summary: f.summary,
    status: f.status?.name,
    type: f.issuetype?.name,
    priority: f.priority?.name,
    project: f.project?.key,
    assignee: f.assignee ? { accountId: f.assignee.accountId, displayName: f.assignee.displayName } : null,
    reporter: f.reporter ? { accountId: f.reporter.accountId, displayName: f.reporter.displayName } : null,
    labels: f.labels,
    created: f.created,
    updated: f.updated,
    description: f.description,
    comments: f.comment?.comments.map((c) => ({ id: c.id, author: c.author?.displayName, created: c.created, body: c.body })),
  };
}

const pageOut = (p) => ({ ...p, url: web(`#/page/${p.id}`), _links: undefined });

export const tools = [
  {
    name: 'getAccessibleAtlassianResources',
    description: 'List the Atlassian sites you can use. Labkit has one local site; its id works as cloudId.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => [{ id: 'labkit', name: 'Lab Bank staging (labkit)', url: BASE_URL, scopes: ['read:jira-work', 'write:jira-work', 'read:confluence-content.all', 'write:confluence-content'] }],
  },
  {
    name: 'atlassianUserInfo',
    description: 'Get the current user (you).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => api('GET', '/rest/api/3/myself'),
  },
  {
    name: 'lookupJiraAccountId',
    description: 'Find Jira users by name. Use the accountId to assign issues.',
    inputSchema: schema({ searchString: { type: 'string', description: 'Part of a display name, or empty for all users' } }),
    handler: async ({ searchString = '' }) => {
      const users = await api('GET', '/rest/api/3/users');
      const s = String(searchString).toLowerCase();
      return users.filter((u) => !s || u.displayName.toLowerCase().includes(s) || u.accountId.toLowerCase().includes(s));
    },
  },
  {
    name: 'getVisibleJiraProjects',
    description: 'List Jira projects.',
    inputSchema: schema({}),
    handler: async () => api('GET', '/rest/api/3/project'),
  },
  {
    name: 'searchJiraIssuesUsingJql',
    description:
      'Search Jira issues with JQL. Supported: project, status, assignee, reporter, priority, issuetype, labels, key, ' +
      'text ~ "words", summary ~, description ~, created/updated with dates or -7d; operators = != ~ !~ IN, NOT IN, IS EMPTY; ' +
      'AND, OR, NOT, parentheses; ORDER BY created, updated, priority, key, status. Statuses: "To Do", "In Progress", "Done".',
    inputSchema: schema(
      {
        jql: { type: 'string', description: 'For example: project = LB AND status = "To Do" ORDER BY priority DESC' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return. Default: summary, status, priority, issuetype, assignee, labels, updated' },
        maxResults: { type: 'number', description: 'Max issues to return (1-100, default 50)' },
        startAt: { type: 'number', description: 'Offset for paging (default 0)' },
      },
      ['jql'],
    ),
    handler: async (args) => {
      need(args, 'jql');
      const r = await api('POST', '/rest/api/3/search/jql', { jql: args.jql, fields: args.fields, maxResults: args.maxResults, startAt: args.startAt });
      return { total: r.total, startAt: r.startAt, isLast: r.isLast, issues: r.issues.map(brief) };
    },
  },
  {
    name: 'getJiraIssue',
    description: 'Get one Jira issue with its description and comments.',
    inputSchema: schema({ issueIdOrKey: issueKey }, ['issueIdOrKey']),
    handler: async (args) => {
      need(args, 'issueIdOrKey');
      return fullIssue(await api('GET', `/rest/api/3/issue/${enc(args.issueIdOrKey)}`));
    },
  },
  {
    name: 'createJiraIssue',
    description: 'Create a Jira issue. The description is Markdown. New issues start in "To Do".',
    inputSchema: schema(
      {
        projectKey: { type: 'string', description: 'For example LB' },
        issueTypeName: { type: 'string', description: 'Bug, Task, Story, Epic or Sub-task' },
        summary: { type: 'string' },
        description: { type: 'string', description: 'Markdown' },
        assignee_account_id: { type: 'string', description: 'From lookupJiraAccountId' },
        additional_fields: { type: 'object', description: 'Optional: priority ({"name":"High"}), labels (["a","b"])' },
      },
      ['projectKey', 'issueTypeName', 'summary'],
    ),
    handler: async (args) => {
      need(args, 'projectKey', 'issueTypeName', 'summary');
      const fields = {
        ...(args.additional_fields || {}),
        project: { key: args.projectKey },
        issuetype: { name: args.issueTypeName },
        summary: args.summary,
        description: args.description,
      };
      if (args.assignee_account_id) fields.assignee = { accountId: args.assignee_account_id };
      const r = await api('POST', '/rest/api/3/issue', { fields });
      return { key: r.key, id: r.id, url: web(`#/issue/${r.key}`) };
    },
  },
  {
    name: 'editJiraIssue',
    description: 'Edit fields of a Jira issue: summary, description (Markdown), priority, issuetype, labels, assignee. To change status, use transitionJiraIssue.',
    inputSchema: schema(
      {
        issueIdOrKey: issueKey,
        fields: { type: 'object', description: 'For example {"priority":{"name":"High"},"labels":["triage"],"assignee":{"accountId":"dimas"}}' },
      },
      ['issueIdOrKey', 'fields'],
    ),
    handler: async (args) => {
      need(args, 'issueIdOrKey', 'fields');
      await api('PUT', `/rest/api/3/issue/${enc(args.issueIdOrKey)}`, { fields: args.fields });
      return fullIssue(await api('GET', `/rest/api/3/issue/${enc(args.issueIdOrKey)}`));
    },
  },
  {
    name: 'addCommentToJiraIssue',
    description: 'Add a comment (Markdown) to a Jira issue.',
    inputSchema: schema({ issueIdOrKey: issueKey, commentBody: { type: 'string', description: 'Markdown' } }, ['issueIdOrKey', 'commentBody']),
    handler: async (args) => {
      need(args, 'issueIdOrKey', 'commentBody');
      const c = await api('POST', `/rest/api/3/issue/${enc(args.issueIdOrKey)}/comment`, { body: args.commentBody });
      return { id: c.id, author: c.author?.displayName, created: c.created, url: web(`#/issue/${String(args.issueIdOrKey).toUpperCase()}`) };
    },
  },
  {
    name: 'getTransitionsForJiraIssue',
    description: 'List the status transitions you can make on an issue, with their ids.',
    inputSchema: schema({ issueIdOrKey: issueKey }, ['issueIdOrKey']),
    handler: async (args) => {
      need(args, 'issueIdOrKey');
      const r = await api('GET', `/rest/api/3/issue/${enc(args.issueIdOrKey)}/transitions`);
      return r.transitions.map((t) => ({ id: t.id, name: t.name, to: t.to.name }));
    },
  },
  {
    name: 'transitionJiraIssue',
    description: 'Move an issue to another status. Get the transition id from getTransitionsForJiraIssue.',
    inputSchema: schema(
      {
        issueIdOrKey: issueKey,
        transition: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], description: 'For example {"id":"21"}' },
        fields: { type: 'object', description: 'Ignored by labkit (no resolution field)' },
        update: { type: 'object', description: 'Optional: {"comment":[{"add":{"body":"text"}}]}' },
      },
      ['issueIdOrKey', 'transition'],
    ),
    handler: async (args) => {
      need(args, 'issueIdOrKey', 'transition');
      const transition = typeof args.transition === 'object' ? args.transition : { id: String(args.transition) };
      await api('POST', `/rest/api/3/issue/${enc(args.issueIdOrKey)}/transitions`, { transition, update: args.update });
      const i = await api('GET', `/rest/api/3/issue/${enc(args.issueIdOrKey)}?fields=status`);
      return { key: i.key, status: i.fields.status.name, url: web(`#/issue/${i.key}`) };
    },
  },
  {
    name: 'getConfluenceSpaces',
    description: 'List Confluence spaces. Use the space id or key with the page tools.',
    inputSchema: schema({ keys: { type: 'array', items: { type: 'string' }, description: 'Optional filter, for example ["LB"]' } }),
    handler: async ({ keys }) => {
      const q = keys?.length ? `?keys=${enc([].concat(keys).join(','))}` : '';
      const r = await api('GET', `/wiki/api/v2/spaces${q}`);
      return r.results.map((s) => ({ id: s.id, key: s.key, name: s.name, description: s.description.plain.value, homepageId: s.homepageId }));
    },
  },
  {
    name: 'getPagesInConfluenceSpace',
    description: 'List the pages in a space (titles and parent ids, no bodies).',
    inputSchema: schema({ spaceId: { type: 'string', description: 'Space id or key' } }, ['spaceId']),
    handler: async (args) => {
      need(args, 'spaceId');
      const r = await api('GET', `/wiki/api/v2/spaces/${enc(args.spaceId)}/pages`);
      return r.results.map((p) => ({ id: p.id, title: p.title, parentId: p.parentId, version: p.version.number }));
    },
  },
  {
    name: 'searchConfluenceUsingCql',
    description: 'Search Confluence pages with CQL. Supported: space, title, text, type, created, lastmodified; = != ~ IN; AND, OR, NOT; ORDER BY title, created, lastmodified. Example: space = LB AND text ~ "runbook"',
    inputSchema: schema({ cql: { type: 'string' }, limit: { type: 'number', description: 'Default 25' } }, ['cql']),
    handler: async (args) => {
      need(args, 'cql');
      const r = await api('GET', `/wiki/rest/api/search?cql=${enc(args.cql)}&limit=${enc(args.limit ?? 25)}`);
      return {
        totalSize: r.totalSize,
        results: r.results.map((x) => ({ id: x.content.id, title: x.title, space: x.content.space.key, excerpt: x.excerpt, lastModified: x.lastModified, url: web(x.url.slice(1)) })),
      };
    },
  },
  {
    name: 'getConfluencePage',
    description: 'Get a Confluence page with its body (Markdown).',
    inputSchema: schema({ pageId: { type: 'string' } }, ['pageId']),
    handler: async (args) => {
      need(args, 'pageId');
      const p = await api('GET', `/wiki/api/v2/pages/${enc(args.pageId)}`);
      return { id: p.id, title: p.title, spaceId: p.spaceId, spaceKey: p.spaceKey, parentId: p.parentId, version: p.version.number, url: web(`#/page/${p.id}`), body: p.body.value };
    },
  },
  {
    name: 'createConfluencePage',
    description: 'Create a Confluence page. The body is Markdown. Without parentId the page goes under the space home page. Titles must be unique in a space.',
    inputSchema: schema(
      {
        spaceId: { type: 'string', description: 'Space id or key, for example LB' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown' },
        parentId: { type: 'string', description: 'Optional parent page id' },
      },
      ['spaceId', 'title', 'body'],
    ),
    handler: async (args) => {
      need(args, 'spaceId', 'title', 'body');
      const p = await api('POST', '/wiki/api/v2/pages', { spaceId: args.spaceId, title: args.title, parentId: args.parentId, body: { representation: 'markdown', value: args.body } });
      return { id: p.id, title: p.title, spaceKey: p.spaceKey, parentId: p.parentId, version: p.version.number, url: web(`#/page/${p.id}`) };
    },
  },
  {
    name: 'updateConfluencePage',
    description: 'Replace the body (Markdown) and optionally the title of a Confluence page. The version number is handled for you.',
    inputSchema: schema(
      {
        pageId: { type: 'string' },
        title: { type: 'string', description: 'Optional new title' },
        body: { type: 'string', description: 'The full new body, Markdown' },
        versionMessage: { type: 'string', description: 'Optional note for the change' },
      },
      ['pageId', 'body'],
    ),
    handler: async (args) => {
      need(args, 'pageId', 'body');
      const current = await api('GET', `/wiki/api/v2/pages/${enc(args.pageId)}`);
      const p = await api('PUT', `/wiki/api/v2/pages/${enc(args.pageId)}`, {
        title: args.title || current.title,
        body: { representation: 'markdown', value: args.body },
        version: { number: current.version.number + 1, message: args.versionMessage },
      });
      return { id: p.id, title: p.title, version: p.version.number, url: web(`#/page/${p.id}`) };
    },
  },
];

export const server = createServer({
  name: 'labkit-atlassian',
  version: '1.0.0',
  instructions: 'Local Jira + Confluence for Lab Bank staging (labkit). Jira project LB, Confluence space LB. Descriptions, comments and page bodies are Markdown.',
  tools,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStdio(server);
}

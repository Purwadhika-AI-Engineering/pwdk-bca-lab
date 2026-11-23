#!/usr/bin/env node
// MCP server for the labkit Grafana mock (Loki logs + Prometheus metrics from the backend log).
// Tool names and arguments follow the Grafana MCP server (mcp-grafana).
// "datasourceUid" is accepted and optional: labkit has one Loki ("loki") and one Prometheus ("prometheus").

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, runStdio } from '../lib/mcp.mjs';
import { requestJson } from '../lib/http.mjs';

export const BASE_URL = process.env.LABKIT_GRAFANA_URL || 'http://127.0.0.1:4330';
const get = (p, params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return requestJson(BASE_URL, 'GET', qs ? `${p}?${qs}` : p);
};
const DEFAULT_RANGE = 'now-6h';
const uid = { type: 'string', description: 'Optional. "loki" or "prometheus" (from list_datasources).' };
const timeArg = (what) => ({ type: 'string', description: `${what}: RFC3339 (2026-11-26T09:00:00+07:00) or relative (now-15m). Default ${what === 'Start' ? DEFAULT_RANGE : 'now'}.` });

function need(args, ...names) {
  for (const n of names) if (args[n] === undefined || args[n] === '') throw new Error(`"${n}" is required`);
}

const iso = (sec) => new Date(Number(sec) * 1000).toISOString();

export const tools = [
  {
    name: 'list_datasources',
    description: 'List the data sources: Loki (logs) and Prometheus (metrics derived from the request log).',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Optional filter: loki or prometheus' } } },
    handler: async ({ type }) => (await get('/api/datasources')).filter((d) => !type || d.type === type),
  },
  {
    name: 'query_loki_logs',
    description:
      'Query backend logs with LogQL. Stream labels: job ("banklab-backend"), level (info, warn, error), logger. ' +
      'Each line is JSON with ts, level, logger, message, traceId and, for request lines (logger "labkit.request"), method, path, status, duration_ms, errorCode, user; errors add error.type/message/stack_trace. ' +
      'Supported: {label="v", label=~"re"}, |= "text", != "text", |~ "re", !~ "re", | json, | field op value (=, !=, >, >=, <, <=, =~), ' +
      'and metric queries count_over_time / rate with sum by (...). Example: {job="banklab-backend"} | json | status >= 400. Newest lines first.',
    inputSchema: {
      type: 'object',
      properties: {
        datasourceUid: uid,
        logql: { type: 'string', description: 'LogQL query' },
        startRfc3339: timeArg('Start'),
        endRfc3339: timeArg('End'),
        limit: { type: 'number', description: 'Max lines (default 50, max 1000)' },
        direction: { type: 'string', enum: ['backward', 'forward'], description: 'backward = newest first (default)' },
      },
      required: ['logql'],
    },
    handler: async (args) => {
      need(args, 'logql');
      const r = await get('/loki/api/v1/query_range', {
        query: args.logql,
        start: args.startRfc3339 || DEFAULT_RANGE,
        end: args.endRfc3339,
        limit: Math.min(Number(args.limit) || 50, 1000),
        direction: args.direction || 'backward',
      });
      if (r.data.resultType === 'streams') {
        const rows = r.data.result.flatMap((s) => s.values.map(([ns, line]) => ({ ns: BigInt(ns), labels: s.stream, line })));
        rows.sort((a, b) => (args.direction === 'forward' ? (a.ns < b.ns ? -1 : 1) : a.ns < b.ns ? 1 : -1));
        if (!rows.length) return 'No log lines matched. Try a wider time range (startRfc3339: "now-24h") or a looser filter.';
        return rows.map((x) => ({ timestamp: new Date(Number(x.ns / 1_000_000n)).toISOString(), labels: x.labels, line: x.line }));
      }
      return r.data.result.map((s) => ({ metric: s.metric, values: s.values.map(([t, v]) => [iso(t), Number(v)]) }));
    },
  },
  {
    name: 'list_loki_label_names',
    description: 'List the Loki stream label names seen in a time range.',
    inputSchema: { type: 'object', properties: { datasourceUid: uid, startRfc3339: timeArg('Start'), endRfc3339: timeArg('End') } },
    handler: async (a) => (await get('/loki/api/v1/labels', { start: a.startRfc3339 || DEFAULT_RANGE, end: a.endRfc3339 })).data,
  },
  {
    name: 'list_loki_label_values',
    description: 'List the values of one Loki label, for example level or logger.',
    inputSchema: { type: 'object', properties: { datasourceUid: uid, labelName: { type: 'string' }, startRfc3339: timeArg('Start'), endRfc3339: timeArg('End') }, required: ['labelName'] },
    handler: async (a) => {
      need(a, 'labelName');
      return (await get(`/loki/api/v1/label/${encodeURIComponent(a.labelName)}/values`, { start: a.startRfc3339 || DEFAULT_RANGE, end: a.endRfc3339 })).data;
    },
  },
  {
    name: 'list_prometheus_metric_names',
    description: 'List the metric names (all derived from the backend request log).',
    inputSchema: { type: 'object', properties: { datasourceUid: uid, regex: { type: 'string', description: 'Optional filter' } } },
    handler: async ({ regex }) => {
      const meta = (await get('/api/v1/metadata')).data;
      const re = regex ? new RegExp(regex) : null;
      return Object.entries(meta).filter(([n]) => !re || re.test(n)).map(([name, [m]]) => ({ name, type: m.type, help: m.help }));
    },
  },
  {
    name: 'query_prometheus',
    description:
      'Query metrics with PromQL. Metrics: http_requests_total{method,path,status}, http_request_duration_seconds_bucket{le,...} (+ _sum, _count), log_messages_total{level,logger}. ' +
      'Supported: rate, increase, sum/avg/min/max/count by (...), histogram_quantile, + - * /. ' +
      'Example: sum by (status) (increase(http_requests_total[15m])). queryType "instant" (default) or "range".',
    inputSchema: {
      type: 'object',
      properties: {
        datasourceUid: uid,
        expr: { type: 'string', description: 'PromQL expression' },
        queryType: { type: 'string', enum: ['instant', 'range'] },
        startTime: timeArg('Start'),
        endTime: timeArg('End'),
        stepSeconds: { type: 'number', description: 'Range queries only. Default 60.' },
      },
      required: ['expr'],
    },
    handler: async (a) => {
      need(a, 'expr');
      if (a.queryType === 'range') {
        const r = await get('/api/v1/query_range', { query: a.expr, start: a.startTime || 'now-1h', end: a.endTime, step: a.stepSeconds || 60 });
        return r.data.result.map((s) => ({ metric: s.metric, values: s.values.map(([t, v]) => [iso(t), Number(v)]) }));
      }
      const r = await get('/api/v1/query', { query: a.expr, time: a.endTime });
      if (r.data.resultType === 'scalar') return { time: iso(r.data.result[0]), value: Number(r.data.result[1]) };
      if (!r.data.result.length) return 'No data. There may be no requests in that window yet; try a longer range like [1h].';
      return r.data.result.map((s) => ({ metric: s.metric, value: Number(s.value[1]), time: iso(s.value[0]) }));
    },
  },
];

export const server = createServer({
  name: 'labkit-grafana',
  version: '1.0.0',
  instructions: 'Logs and metrics of the Lab Bank backend on staging (labkit). Start with query_loki_logs on {job="banklab-backend"}. Lines share a traceId per request.',
  tools,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runStdio(server);

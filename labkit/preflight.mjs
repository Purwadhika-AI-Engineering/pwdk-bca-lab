#!/usr/bin/env node
// Labkit preflight: checks this laptop for Day 2 and writes preflight-report.txt.
// Run: labkit\preflight.cmd   (or: node labkit/preflight.mjs)
// Uses Node built-ins only. Takes under 10 seconds.

import { spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPORT = path.join(HERE, 'preflight-report.txt');

export const PORTS = [
  [4300, 'labkit hub'],
  [4310, 'labkit Atlassian mock'],
  [4330, 'labkit Grafana mock'],
  [5435, 'labkit staging DB (backend)'],
  [8080, 'backend'],
  [4200, 'frontend'],
];

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });

export function parseJavaMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text || '');
  if (!m) return null;
  const major = Number(m[1]);
  return major === 1 ? Number(m[2]) : major; // "1.8.0" means Java 8
}

export function nodeMajor(version = process.version) {
  return Number(version.replace(/^v/, '').split('.')[0]);
}

function checkNode() {
  const major = nodeMajor();
  if (major >= 22) add('PASS', 'Node.js', `${process.version} (${process.arch})`);
  else add('FAIL', 'Node.js', `${process.version}. Labkit needs Node 22 or newer.`);
}

function checkSqlite() {
  const code = "require('node:sqlite'); console.log('ok')";
  const plain = spawnSync(process.execPath, ['--no-warnings', '-e', code], { encoding: 'utf8', timeout: 5000 });
  if (plain.stdout?.trim() === 'ok') return add('PASS', 'node:sqlite', 'loads without flags');
  const flagged = spawnSync(process.execPath, ['--no-warnings', '--experimental-sqlite', '-e', code], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (flagged.stdout?.trim() === 'ok') return add('PASS', 'node:sqlite', 'loads with --experimental-sqlite (start.cmd adds it)');
  add('FAIL', 'node:sqlite', 'does not load. Update Node to 22.13 or newer.');
}

function checkJava() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
  const text = `${r.stderr || ''}${r.stdout || ''}`;
  const major = parseJavaMajor(text);
  const javaHome = process.env.JAVA_HOME;
  if (major === null) {
    add('FAIL', 'Java', 'java not found on PATH. Install JDK 17 and set JAVA_HOME.');
  } else if (major < 17) {
    add('FAIL', 'Java', `Java ${major} found. The backend needs JDK 17 or newer.`);
  } else {
    add('PASS', 'Java', `${text.split(/\r?\n/)[0].trim()}`);
  }
  if (!javaHome) add('WARN', 'JAVA_HOME', 'not set. mvnw.cmd may fail. Set it to your JDK 17 folder.');
  else if (!fs.existsSync(javaHome)) add('WARN', 'JAVA_HOME', `points to a missing folder: ${javaHome}`);
  else add('PASS', 'JAVA_HOME', javaHome);
}

/** True if something already accepts connections on 127.0.0.1:port. */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(800, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function checkPort(port) {
  if (await isListening(port)) return 'EADDRINUSE';
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code || err.message));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(null)));
  });
}

async function checkPorts() {
  const errors = await Promise.all(PORTS.map(([port]) => checkPort(port)));
  for (const [i, [port, what]] of PORTS.entries()) {
    const err = errors[i];
    if (!err) add('PASS', `Port ${port}`, `free on 127.0.0.1 (${what})`);
    else if (err === 'EADDRINUSE') add('WARN', `Port ${port}`, `in use (${what}). Fine if labkit or the app is already running; otherwise stop what uses it.`);
    else add('FAIL', `Port ${port}`, `cannot bind on 127.0.0.1: ${err}`);
  }
}

const LOOPBACK = (a) => a === '::1' || a.startsWith('127.');

/** Do *.localhost names point to this computer? Kiro and Node use the OS for this. */
export async function checkNames(lookup = (h) => dns.lookup(h, { all: true })) {
  const names = ['labkit.localhost', 'jira.labbank.localhost'];
  const bad = [];
  for (const name of names) {
    try {
      const addrs = (await lookup(name)).map((x) => x.address);
      if (!addrs.length || !addrs.every(LOOPBACK)) bad.push(`${name} -> ${addrs.join(', ') || 'nothing'}`);
    } catch (err) {
      bad.push(`${name}: ${err.code || err.message}`);
    }
  }
  if (!bad.length) return add('PASS', 'Host names', `*.localhost points to this computer (${names.join(', ')})`);
  add('WARN', 'Host names', `${bad.join('; ')}. Use the 127.0.0.1 addresses instead of jira.labbank.localhost.`);
}

/** The gateway wants 127.0.0.1:80, else :8000. */
async function checkGatewayPort() {
  let why80 = '';
  for (const port of [80, 8000]) {
    const err = await checkPort(port);
    if (!err) {
      return add('PASS', 'Gateway port', port === 80 ? 'port 80 is free: host names work without a port number' : `port 80 is not available (${why80}); the gateway uses 8000 (http://jira.labbank.localhost:8000)`);
    }
    if (port === 80) why80 = err === 'EADDRINUSE' ? 'in use' : err === 'EACCES' ? 'needs admin on this OS' : err;
    if (err === 'EADDRINUSE') {
      const ours = await fetch(`http://127.0.0.1:${port}/health`, { headers: { host: 'labkit.localhost' }, signal: AbortSignal.timeout(1000) })
        .then((r) => r.json())
        .then((j) => j.service === 'hub')
        .catch(() => false);
      if (ours) return add('PASS', 'Gateway port', `labkit gateway already runs on port ${port}`);
    }
  }
  add('INFO', 'Gateway port', 'ports 80 and 8000 are taken. Host names are off; the 127.0.0.1 addresses still work.');
}

export function chromeCandidates(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean)
      .map((base) => path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function checkChrome() {
  const found = chromeCandidates().find((p) => fs.existsSync(p));
  if (found) add('PASS', 'Chrome', found);
  else add('WARN', 'Chrome', 'not found in the usual folders. Needed for Angular tests and the optional Playwright MCP.');
}

/** Hides user:password in a proxy URL. */
export function maskProxy(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '(set)';
  }
}

async function reach(url) {
  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
    return { ok: res.status < 500, detail: `HTTP ${res.status} in ${Date.now() - start} ms` };
  } catch (err) {
    return { ok: false, detail: err.cause?.code || err.name || err.message };
  }
}

async function checkNetwork() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) add('INFO', 'Proxy', `HTTPS_PROXY/HTTP_PROXY is ${maskProxy(proxy)}`);
  const [npm, maven] = await Promise.all([
    reach('https://registry.npmjs.org/-/ping'),
    reach('https://repo.maven.apache.org/maven2/'),
  ]);
  // Report only: labkit itself needs neither.
  add(npm.ok ? 'PASS' : 'INFO', 'npm registry', `${npm.ok ? 'reachable' : 'not reachable'} (${npm.detail}). Only needed for the optional Playwright MCP.`);
  add(maven.ok ? 'PASS' : 'INFO', 'Maven Central', `${maven.ok ? 'reachable' : 'not reachable'} (${maven.detail}). Not needed if the Maven cache is filled.`);
}

function checkMavenCache() {
  const m2 = process.env.MAVEN_REPO || path.join(os.homedir(), '.m2');
  const wrapper = path.join(m2, 'wrapper', 'dists');
  const boot = path.join(m2, 'repository', 'org', 'springframework', 'boot', 'spring-boot');
  const hasWrapper = fs.existsSync(wrapper);
  let bootVersions = [];
  try {
    bootVersions = fs.readdirSync(boot);
  } catch {}
  const want = readBootVersion();
  const hasBoot = want ? bootVersions.includes(want) : bootVersions.length > 0;
  if (hasWrapper && hasBoot) add('PASS', 'Maven cache', `wrapper and Spring Boot ${want || ''} found in ${m2}`);
  else add('INFO', 'Maven cache', `${hasWrapper ? 'wrapper found' : 'no Maven wrapper yet'}, ${hasBoot ? `Spring Boot ${want} found` : `Spring Boot ${want || ''} not cached`}. The first backend start needs Maven Central (or a mirror).`);
}

function readBootVersion() {
  try {
    const pom = fs.readFileSync(path.join(ROOT, 'backend', 'pom.xml'), 'utf8');
    return /<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>([^<]+)</.exec(pom)?.[1] || null;
  } catch {
    return null;
  }
}

function checkFolders() {
  const data = path.join(HERE, 'data');
  try {
    fs.mkdirSync(data, { recursive: true });
    const probe = path.join(data, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    add('PASS', 'Write access', data);
  } catch (err) {
    add('FAIL', 'Write access', `cannot write to ${data}: ${err.code || err.message}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'backend', 'mvnw.cmd'))) add('WARN', 'Repo', `backend/mvnw.cmd not found under ${ROOT}`);
}

export function formatReport(rows, meta) {
  const width = Math.max(...rows.map((r) => r.name.length));
  const lines = [
    'LABKIT PREFLIGHT REPORT',
    `Date: ${meta.date}`,
    `OS: ${meta.os}`,
    `Folder: ${meta.folder}`,
    '',
    ...rows.map((r) => `[${r.level.padEnd(4)}] ${r.name.padEnd(width)}  ${r.detail}`),
    '',
  ];
  const fails = rows.filter((r) => r.level === 'FAIL').length;
  const warns = rows.filter((r) => r.level === 'WARN').length;
  lines.push(fails ? `RESULT: NOT READY (${fails} fail, ${warns} warn)` : `RESULT: READY (${warns} warn)`);
  lines.push(`Took ${meta.ms} ms`);
  return lines.join(os.EOL) + os.EOL;
}

async function main() {
  const start = Date.now();
  checkNode();
  checkSqlite();
  checkJava();
  checkChrome();
  checkMavenCache();
  checkFolders();
  await Promise.all([checkPorts(), checkNetwork(), checkNames(), checkGatewayPort()]);
  const text = formatReport(results, {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    folder: ROOT,
    ms: Date.now() - start,
  });
  process.stdout.write(text);
  fs.writeFileSync(REPORT, text);
  process.stdout.write(`${os.EOL}Saved to ${REPORT}${os.EOL}Paste that file into the chat.${os.EOL}`);
  process.exitCode = results.some((r) => r.level === 'FAIL') ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

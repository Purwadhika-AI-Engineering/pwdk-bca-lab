import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJavaMajor, nodeMajor, maskProxy, chromeCandidates, formatReport } from '../preflight.mjs';

test('parseJavaMajor reads modern and old version strings', () => {
  assert.equal(parseJavaMajor('openjdk version "17.0.21" 2026-10-24'), 17);
  assert.equal(parseJavaMajor('java version "1.8.0_391"'), 8);
  assert.equal(parseJavaMajor('openjdk version "21" 2023-09-19'), 21);
  assert.equal(parseJavaMajor("'java' is not recognized"), null);
});

test('nodeMajor reads the major version', () => {
  assert.equal(nodeMajor('v22.13.1'), 22);
  assert.equal(nodeMajor('v20.11.0'), 20);
});

test('maskProxy hides credentials', () => {
  assert.equal(maskProxy('http://user:secret@proxy.corp:8080'), 'http://***@proxy.corp:8080/');
  assert.equal(maskProxy('http://proxy.corp:8080'), 'http://proxy.corp:8080/');
  assert.equal(maskProxy('not a url'), '(set)');
});

test('chromeCandidates uses Windows install folders', () => {
  const list = chromeCandidates({ PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32');
  assert.deepEqual(list, [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);
});

test('formatReport says NOT READY when a check fails', () => {
  const meta = { date: 'd', os: 'o', folder: 'f', ms: 1 };
  const ok = formatReport([{ level: 'PASS', name: 'A', detail: 'x' }, { level: 'WARN', name: 'B', detail: 'y' }], meta);
  assert.match(ok, /RESULT: READY \(1 warn\)/);
  const bad = formatReport([{ level: 'FAIL', name: 'A', detail: 'x' }], meta);
  assert.match(bad, /RESULT: NOT READY \(1 fail, 0 warn\)/);
});

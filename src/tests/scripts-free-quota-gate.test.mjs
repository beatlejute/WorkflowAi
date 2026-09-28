/**
 * Шлагбаум пула по счётчику бесплатных запросов аккаунта
 * (src/scripts/free-quota-gate.js).
 *
 * Скрипт делает один GET с ключом и отвечает блоком ---RESULT---:
 * `remaining > 0` — `status: open`, `remaining ≤ 0` — `status: closed`, оба с
 * выходом 0; сбой — `status: error`, `error_class`, выход 1. Счётчик отдаёт
 * локальный сервер (_model-server.mjs), он считает обращения и проверяет
 * заголовок Authorization. Ключ — файл во временном каталоге ОС; сеть наружу не
 * используется, каталог снимается в afterEach.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_KEY, startModelServer, sendJson, closedPort } from './_model-server.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'free-quota-gate.js');

function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => done({ stdout, stderr, exitCode }));
  });
}

function field(stdout, name) {
  return (stdout.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1];
}

const counter = (used, limit, remaining) => ({
  data: { label: 'service-key', usage: 0.07, free_model_daily_requests: { used, limit, remaining } },
});

describe('free-quota-gate: шлагбаум по счётчику бесплатных запросов', () => {
  let server;
  let respond;
  let root;
  let keyFile;

  before(async () => {
    server = await startModelServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        sendJson(res, 401, { error: { code: 401, message: 'No auth credentials found' } });
        return;
      }
      respond(req, res);
    });
  });
  after(async () => {
    await server?.close();
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-free-quota-gate-'));
    keyFile = join(root, 'service.key');
    writeFileSync(keyFile, `${TEST_KEY}\n`);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const gate = async (url = server.url('/key'), extra = ['--timeout', '5']) => {
    const seen = server.requests.length;
    const result = await run(['--url', url, '--key-file', keyFile, ...extra]);
    assert.ok(!result.stdout.includes(TEST_KEY) && !result.stderr.includes(TEST_KEY), 'ключ не печатается');
    return { ...result, requests: server.requests.slice(seen) };
  };

  it('remaining > 0 — status: open, remaining, выход 0; один GET с ключом', async () => {
    respond = (req, res) => sendJson(res, 200, counter(13, 50, 37));
    const { stdout, exitCode, requests } = await gate();

    assert.equal(exitCode, 0, stdout);
    assert.equal(field(stdout, 'status'), 'open');
    assert.equal(field(stdout, 'remaining'), '37');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, '/key');
    assert.equal(requests[0].headers.authorization, `Bearer ${TEST_KEY}`);
  });

  it('remaining: 0 — status: closed, выход 0', async () => {
    respond = (req, res) => sendJson(res, 200, counter(50, 50, 0));
    const { stdout, exitCode, requests } = await gate();

    assert.equal(exitCode, 0, stdout);
    assert.equal(field(stdout, 'status'), 'closed');
    assert.equal(field(stdout, 'remaining'), '0');
    assert.equal(requests.length, 1);
  });

  it('поля free_model_daily_requests нет или remaining не число — status: error, выход 1', async () => {
    respond = (req, res) => sendJson(res, 200, { data: { label: 'service-key' } });
    const missing = await gate();
    assert.equal(missing.exitCode, 1);
    assert.equal(field(missing.stdout, 'status'), 'error');
    assert.equal(field(missing.stdout, 'error_class'), 'bad_response');
    assert.equal(field(missing.stdout, 'remaining'), undefined);
    assert.equal(missing.requests.length, 1);

    respond = (req, res) => sendJson(res, 200, counter(1, 50, 'many'));
    const notNumber = await gate();
    assert.equal(notNumber.exitCode, 1);
    assert.equal(field(notNumber.stdout, 'status'), 'error');
  });

  it('HTTP 401 — error_class: auth, без повторов', async () => {
    writeFileSync(keyFile, 'rejected-key-value\n');
    respond = (req, res) => sendJson(res, 200, counter(1, 50, 49));
    const { stdout, exitCode, requests } = await gate();

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'status'), 'error');
    assert.equal(field(stdout, 'error_class'), 'auth');
    assert.equal(requests.length, 1);
    assert.ok(!stdout.includes('rejected-key-value'));
  });

  it('HTTP 500 — status: error, одно обращение без повторов', async () => {
    respond = (req, res) => sendJson(res, 500, { error: { code: 500, message: 'Internal Server Error' } });
    const { stdout, exitCode, requests } = await gate();

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'status'), 'error');
    assert.equal(field(stdout, 'error_class'), 'server');
    assert.equal(requests.length, 1);
  });

  it('сервер недоступен — status: error, error_class: network, адреса в тексте нет', async () => {
    const port = await closedPort();
    const { stdout, exitCode } = await gate(`http://127.0.0.1:${port}/key`);

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'status'), 'error');
    assert.equal(field(stdout, 'error_class'), 'network');
    assert.ok(!stdout.includes(String(port)), stdout);
  });

  it('сервер молчит дольше --timeout — error_class: timeout', async () => {
    respond = () => {};
    const { stdout, exitCode, requests } = await gate(server.url('/key'), ['--timeout', '1']);

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'error_class'), 'timeout');
    assert.equal(requests.length, 1);
  });

  it('ответ не JSON — error_class: bad_response', async () => {
    respond = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>maintenance</html>');
    };
    const { stdout, exitCode } = await gate();

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'error_class'), 'bad_response');
  });

  it('нет --url — usage, обращений нет', async () => {
    const seen = server.requests.length;
    const { stdout, exitCode } = await run(['--key-file', keyFile]);

    assert.equal(exitCode, 1);
    assert.equal(field(stdout, 'error_class'), 'usage');
    assert.equal(server.requests.length, seen);
  });
});

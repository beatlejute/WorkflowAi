/**
 * Проверка доступности MCP-серверов перед выполнением тикета (src/scripts/check-mcp.js).
 * До этого файла скрипт не имел ни одного теста: покрытие 0% (база храповика, коммит
 * 1156f42).
 *
 * Скрипт — стадия пайплайна: читает .mcp.json и .claude/settings.local.json из cwd,
 * пингует http-серверы и ищет stdio-команды в PATH. Поэтому проверяется запуском, как
 * его зовёт раннер, в каталоге временного проекта. Что охраняется:
 *  - код выхода всегда 0, а исход — в status: раннер при ненулевом коде переписывает
 *    status на failed и ломает маршрутизацию (комментарий в шапке скрипта);
 *  - пропуск (skipped), когда тип тикета не требует MCP или список не задан, — иначе
 *    стадия проверяла бы серверы там, где они не нужны, и блокировала работу;
 *  - нечего проверять — ok, а не fail: проект без MCP не должен стоять;
 *  - настоящая недоступность — fail с именем сервера: живой http-сервер поднимается в
 *    самом тесте, мёртвый — на закрытом порту; stdio — существующая и выдуманная
 *    команды; сервер, не разрешённый в настройках, — тоже fail.
 *
 * Запуск идёт асинхронно (execFile), а не spawnSync: синхронный запуск остановил бы
 * цикл событий теста, и поднятый здесь http-сервер не ответил бы на пинг.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/check-mcp.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-mcp.js');
const QA_CONTEXT = 'check-mcp\n\nContext:\n  mcp_require_for: qa, e2e\n  task_type: qa\n  ticket_id: QA-001';

function withProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mcp-'));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function writeMcp(root, servers) {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }), 'utf8');
}

function writeSettings(root, settings) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(settings), 'utf8');
}

function run(root, context = QA_CONTEXT) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, context], { cwd: root, encoding: 'utf8' }, (err, stdout, stderr) => {
      const block = stdout.split('---RESULT---')[1] || '';
      const status = (block.match(/status:\s*(\S+)/) || [])[1];
      const reason = (block.match(/reason:\s*(.*)/) || [])[1];
      resolve({ code: err ? err.code : 0, status, reason, out: stdout, err: stderr });
    });
  });
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Порт, на котором гарантированно никто не слушает: занять и сразу освободить.
function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('mcp_require_for не задан — skipped, код выхода 0', () =>
  withProject(async (root) => {
    const r = await run(root, 'Context:\n  task_type: qa');
    assert.equal(r.code, 0);
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /mcp_require_for is empty/);
  }));

test('тип тикета не требует MCP — skipped', () =>
  withProject(async (root) => {
    const r = await run(root, 'Context:\n  mcp_require_for: qa\n  task_type: impl');
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /task_type=impl not in mcp_require_for/);
  }));

test('.mcp.json нет — ok: проект без MCP не стоит', () =>
  withProject(async (root) => {
    const r = await run(root);
    assert.equal(r.code, 0);
    assert.equal(r.status, 'ok');
    assert.match(r.reason, /no mcp.json/);
  }));

test('.mcp.json битый — fail с причиной, код выхода всё равно 0', () =>
  withProject(async (root) => {
    fs.writeFileSync(path.join(root, '.mcp.json'), '{ не json', 'utf8');
    const r = await run(root);
    assert.equal(r.code, 0, 'исход только через status: раннер переписал бы его на failed');
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /mcp.json parse error/);
  }));

test('в .mcp.json нет серверов — ok', () =>
  withProject(async (root) => {
    writeMcp(root, {});
    const r = await run(root);
    assert.equal(r.status, 'ok');
    assert.match(r.reason, /no mcp servers/);
  }));

test('живой http-сервер и найденная stdio-команда — ok', () =>
  withProject(async (root) => {
    const server = await startServer();
    try {
      const { port } = server.address();
      writeMcp(root, {
        remote: { command: 'npx', args: ['mcp-remote', `http://127.0.0.1:${port}/mcp`] },
        local: { command: 'node', args: ['server.mjs'] },
      });
      writeSettings(root, { enableAllProjectMcpServers: true });
      const r = await run(root);
      // Причины сбоя — первой строкой: аннотация CI показывает только её, а вывод
      // скрипта начинается с заголовка, одинакового при любом сбое.
      const problems = r.out.split(/\r?\n/).filter((line) => /^\s+- /.test(line)).map((line) => line.trim());
      assert.equal(r.status, 'ok', `${problems.join('; ') || r.reason}\n${r.out}`);
      assert.match(r.reason, /2 servers reachable/);
    } finally {
      server.close();
    }
  }));

test('мёртвый http-сервер и выдуманная команда — fail с именами обоих', () =>
  withProject(async (root) => {
    const port = await closedPort();
    writeMcp(root, {
      dead: { command: 'npx', args: [`http://127.0.0.1:${port}/mcp`] },
      ghost: { command: 'no-such-mcp-binary-2026', args: [] },
    });
    const r = await run(root);
    assert.equal(r.code, 0);
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /unavailable: .*dead/);
    assert.match(r.reason, /ghost/);
    assert.match(r.out, /command not in PATH/);
  }));

test('сервер не разрешён в настройках — fail, даже если он доступен', () =>
  withProject(async (root) => {
    writeMcp(root, {
      allowed: { command: 'node', args: [] },
      forbidden: { command: 'node', args: [] },
    });
    writeSettings(root, { enabledMcpjsonServers: ['allowed'] });
    const r = await run(root);
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /unavailable: forbidden$/);
    assert.match(r.out, /не разрешён \(not in enabledMcpjsonServers\)/);
  }));

test('битый адрес http не роняет скрипт — сервер просто недоступен', () =>
  withProject(async (root) => {
    writeMcp(root, { broken: { command: 'npx', args: ['http://'] } });
    const r = await run(root);
    assert.equal(r.code, 0);
    assert.equal(r.status, 'fail');
    assert.match(r.out, /invalid url/);
  }));

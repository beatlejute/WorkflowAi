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

// PI_CODING_AGENT_DIR всегда указывает внутрь временного проекта: иначе скрипт читал бы
// машинный `~/.pi/agent/mcp.json` и результат теста зависел бы от чужого конфига.
function run(root, context = QA_CONTEXT, env = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, PI_CODING_AGENT_DIR: path.join(root, '.pi-agent-none'), ...env };
    execFile(process.execPath, [SCRIPT, context], { cwd: root, env: childEnv, encoding: 'utf8' }, (err, stdout, stderr) => {
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

// pi берёт серверы из <каталог агента>/mcp.json и проектного .pi/mcp.json, а не из
// .claude/settings.local.json: сервер, разрешённый только для pi, тикет не блокирует.
test('сервер, разрешённый только в конфиге pi, — доступен', () =>
  withProject(async (root) => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mcp-pi-'));
    try {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      fs.writeFileSync(
        path.join(agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { piserver: { command: 'node' } } }),
        'utf8'
      );

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
      assert.match(r.out, /глобальный mcp\.json pi/);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

// Сервер, отключённый в конфиге pi или не разрешённый нигде, по-прежнему блокирует.
test('сервер, отключённый в конфиге pi (enabled: false), — недоступен', () =>
  withProject(async (root) => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mcp-pi-off-'));
    try {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      fs.writeFileSync(
        path.join(agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { piserver: { command: 'node', enabled: false } } }),
        'utf8'
      );

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail');
      assert.match(r.reason, /unavailable: piserver$/);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

// Проектный .pi/mcp.json pi читает только в доверенном проекте: без записи в trust.json
// он на исход не влияет.
test('проектный .pi/mcp.json без доверия проекта не учитывается', () =>
  withProject(async (root) => {
    writeMcp(root, { piserver: { command: 'node', args: [] } });
    writeSettings(root, { enabledMcpjsonServers: [] });
    writeProjectPiServers(root, { piserver: { command: 'node' } });

    const r = await run(root);
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /unavailable: piserver$/);
  }));

/** Конфиги pi и запись доверия проекта в каталоге агента. */
function writePiAgent(agentDir, { servers = null, trust = null } = {}) {
  fs.mkdirSync(agentDir, { recursive: true });
  if (servers) fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: servers }), 'utf8');
  if (trust !== null) fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify(trust), 'utf8');
}

function writeProjectPiServers(root, servers) {
  fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: servers }), 'utf8');
}

/** Прогон с изолированным каталогом агента pi; колбэк получает его путь. */
async function withPiAgent(fn, options) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mcp-agent-'));
  try {
    writePiAgent(agentDir, options);
    return await fn(agentDir);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test('проектный .pi/mcp.json в доверенном проекте — сервер разрешён', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writeProjectPiServers(root, { piserver: { command: 'node' } });
      fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({ [root]: true }), 'utf8');

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
      assert.match(r.out, /\.pi\/mcp\.json/);
    })
  ));

test('запись проекта перекрывает глобальный сервер pi', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writeProjectPiServers(root, { piserver: { command: 'node', enabled: true } });
      fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({ [root]: true }), 'utf8');
      fs.writeFileSync(
        path.join(agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { piserver: { command: 'node' } } }),
        'utf8'
      );

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
    })
  ));

test('переопределение без своего сервера работает поверх глобального', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writeProjectPiServers(root, { piserver: { enabled: true } });
      fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({ [root]: true }), 'utf8');
      fs.writeFileSync(
        path.join(agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { piserver: { command: 'node' } } }),
        'utf8'
      );

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
    })
  ));

test('переопределение без сервера и без глобальной записи — недоступен', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writeProjectPiServers(root, { piserver: { enabled: true } });
      fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({ [root]: true }), 'utf8');

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail', r.out);
    })
  ));

test('глобальный сервер pi с enabled: false — недоступен', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      fs.writeFileSync(
        path.join(agentDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { piserver: { command: 'node', enabled: false } } }),
        'utf8'
      );

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail', r.out);
    })
  ));

test('проектный сервер pi с enabled: false — недоступен', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writeProjectPiServers(root, { piserver: { command: 'node', enabled: false } });
      fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({ [root]: true }), 'utf8');

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail', r.out);
    })
  ));

test('trust.json без записи о проекте — доверия нет', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writeProjectPiServers(root, { piserver: { command: 'node' } });
      fs.writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({ 'C:/где-то/ещё': true }), 'utf8');

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail', r.out);
    })
  ));

test('битый trust.json pi не считается доверием проекта', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writeProjectPiServers(root, { piserver: { command: 'node' } });
      fs.writeFileSync(path.join(agentDir, 'trust.json'), '[]', 'utf8');

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail', r.out);
    })
  ));

// Переменная не задана — берётся каталог агента по умолчанию (<домашний>/.pi/agent).
test('без PI_CODING_AGENT_DIR читается каталог агента в домашнем каталоге', () =>
  withProject(async (root) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mcp-home-'));
    try {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writePiAgent(path.join(home, '.pi', 'agent'), { servers: { piserver: { command: 'node' } } });

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: '', USERPROFILE: home, HOME: home });
      assert.equal(r.status, 'ok', r.out);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }));

// Доступность проверяется по записи того же хоста, что разрешил сервер: у pi своя
// команда и свои args, поэтому чужой конфиг даёт вердикт о другом сервере.
test('живой сервер pi при чужой команде в .mcp.json — доступен', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'no-such-mcp-binary-2026', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writePiAgent(agentDir, { servers: { piserver: { command: 'node' } } });

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
      assert.match(r.out, /stdio\s+node\b/, 'в вердикте должна быть команда конфига pi');
      assert.doesNotMatch(r.out, /no-such-mcp-binary-2026/, 'команда .mcp.json проверяться не должна');
    })
  ));

test('сломанный сервер pi при живой команде в .mcp.json — недоступен', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'node', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writePiAgent(agentDir, { servers: { piserver: { command: 'no-such-mcp-binary-2026' } } });

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail', r.out);
      assert.match(r.reason, /unavailable: piserver$/);
      assert.match(r.out, /command not in PATH/, 'в вердикте должна быть команда конфига pi');
    })
  ));

// Разрешают оба хоста, но команда .mcp.json не резолвится, а команда pi резолвится:
// рабочая запись второго хоста не скрывается неудачей первого.
test('рабочая запись pi при нерабочей записи .mcp.json — доступен', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, { piserver: { command: 'no-such-mcp-binary-2026', args: [] } });
      writeSettings(root, { enableAllProjectMcpServers: true });
      writePiAgent(agentDir, { servers: { piserver: { command: 'node' } } });

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
      assert.match(r.out, /stdio\s+node\b/, 'вердикт должен быть по рабочей записи pi');
    })
  ));

// Набор серверов, покрытый только по частям разными хостами, успешной проверкой не
// считается: сервер A доступен лишь Claude, сервер B — лишь pi, и набора целиком нет ни
// у одного исполнителя. По сумме вердиктов (каждый сервер «OK» у своего хоста) проверка
// проходила бы, и стадия шла дальше без обоих серверов у выбранного агента.
test('набор, покрытый только по частям (A — Claude, B — pi), — fail с разбивкой по хостам', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, {
        aserver: { command: 'node', args: [] },
        bserver: { command: 'node', args: [] },
      });
      writeSettings(root, { enabledMcpjsonServers: ['aserver'] });
      writePiAgent(agentDir, { servers: { bserver: { command: 'node' } } });

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'fail', r.out);
      assert.match(r.reason, /incomplete coverage/);
      assert.match(r.reason, /claude lacks bserver/);
      assert.match(r.reason, /pi lacks aserver/);
      assert.match(r.out, /claude: 1\/2, нет: bserver/);
      assert.match(r.out, /pi: 1\/2, нет: aserver/);
    })
  ));

// Обратная сторона правила: набор целиком дан pi, хотя у Claude есть только его часть, —
// проверка проходит по хосту с полным набором (иначе правило блокировало бы рабочий проект).
test('набор целиком у pi при частичном у Claude — ok', () =>
  withProject((root) =>
    withPiAgent(async (agentDir) => {
      writeMcp(root, {
        aserver: { command: 'node', args: [] },
        bserver: { command: 'node', args: [] },
      });
      writeSettings(root, { enabledMcpjsonServers: ['aserver'] });
      writePiAgent(agentDir, {
        servers: { aserver: { command: 'node' }, bserver: { command: 'node' } },
      });

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
      assert.match(r.reason, /2 servers reachable \(host: pi\)/);
    })
  ));

// Запись pi со встроенным транспортом http: адрес лежит в поле url, а не в args, — без его
// учёта сервер опознался бы как stdio без команды и получил бы «недоступен».
test('запись pi с транспортом http (поле url) — доступна', () =>
  withProject(async (root) => {
    const server = await startServer();
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mcp-agent-'));
    try {
      const { port } = server.address();
      writeMcp(root, { piserver: { command: 'no-such-mcp-binary-2026', args: [] } });
      writeSettings(root, { enabledMcpjsonServers: [] });
      writePiAgent(agentDir, { servers: { piserver: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } });

      const r = await run(root, QA_CONTEXT, { PI_CODING_AGENT_DIR: agentDir });
      assert.equal(r.status, 'ok', r.out);
      assert.match(r.out, /http\s+http:\/\/127\.0\.0\.1:/, 'вердикт должен быть по http-записи pi');
    } finally {
      server.close();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

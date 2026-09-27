/**
 * Фактическая модель kilo-агента (src/lib/kilo-models.mjs) и её путь в раннере.
 *
 * Роутеры kilo выбирают модель сами; kilo 7.7.9 пишет ответившую модель роутера в
 * каждую часть step-finish своей базы, а у сессии с фиксированной моделью шаги без
 * модели — модель шага тогда модель сессии (`session.model.id`). 2026-09-25 в
 * PulseProxy через роутер в одной сессии execute-task отвечали 11 моделей, а лог
 * раннера показывал только роутер; у агентов без роутера раннер писал «фактическая
 * модель неизвестна».
 *
 * Что охраняется:
 *  - раннер передаёт kilo `--title` с меткой запуска и не трогает `--title` из конфига;
 *  - по метке находятся модели корневой сессии и её субагентов, чужие сессии не
 *    смешиваются; нет сессии — null, а не пустой список;
 *  - шаг без модели отвечает моделью своей сессии, субагент без модели — моделью
 *    корневой;
 *  - модель запуска — модель последнего шага корневой сессии (по `time_created`, при
 *    равенстве — по `id`), шаги субагентов в ней не участвуют;
 *  - подпись агента: своя модель — без скобок (`agent-a`), выбор роутера — в скобках
 *    (`router-agent(alpha-3-ultra)`), несколько — семейства (`router-agent(alpha, beta)`);
 *  - пока агент работает, раннер пишет `AGENT_MODELS` при смене подписи (по ней панель
 *    pipeline в расширении обновляет агента), после выхода — финальную строку;
 *    в историю работы тикета, в столбец «Агент», встаёт та же подпись;
 *  - у не-kilo агентов ни метки, ни поиска.
 *
 * База kilo здесь — временный SQLite с полями, которые читает модуль, как у настоящей
 * базы kilo 7.7.9 (PRAGMA table_info 2026-09-27): session — id, title, parent_id,
 * model (JSON `{"id", "providerID"}`); part — id, session_id, time_created, data.
 * Фейковый kilo — скрипт, который, как настоящий, создаёт сессию с переданным `--title`.
 * Имена моделей и агентов — нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/kilo-models.test.mjs
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isKiloRun, kiloRunTitle, withKiloTitle, requestedKiloModel, kiloModelKey,
  readKiloModels, readKiloRun, formatKiloModels, kiloAgentLabel, setKiloDbPathCache,
} from '../lib/kilo-models.mjs';
import { StageExecutor } from '../runner.mjs';
import { parseAgentHistory } from '../lib/agent-history.mjs';

let sqlite = null;
try {
  process.removeAllListeners('warning');
  sqlite = await import('node:sqlite');
} catch {}
const skipNoSqlite = sqlite ? false : 'node:sqlite недоступен (Node < 22.5)';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-models-'));
after(() => {
  setKiloDbPathCache();
  fs.rmSync(BASE, { recursive: true, force: true });
});

// Шаг без модели — как у сессии с фиксированной моделью.
const STEP = Symbol('step-finish без модели');
// Часть не шаг — текст ответа.
const TEXT = null;

function makeDb(name) {
  const dbPath = path.join(BASE, name);
  const db = new sqlite.DatabaseSync(dbPath);
  // Как у настоящей базы kilo: в режиме WAL чтение раннера не блокирует запись агента.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT, model TEXT);
           CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);
  return { dbPath, db };
}

let clock = 1000;

/**
 * Сессия и её части в порядке времени. `steps` — модель шага (строка), STEP — шаг без
 * модели, TEXT — часть не шаг. `model` — модель сессии (`session.model.id`) или null.
 */
function addSession(db, id, title, { parentId = null, model = null, steps = [] } = {}) {
  const sessionModel = model ? JSON.stringify({ id: model, providerID: 'prov', variant: 'default' }) : null;
  db.prepare('INSERT INTO session (id, title, parent_id, model) VALUES (?, ?, ?, ?)').run(id, title, parentId, sessionModel);
  steps.forEach((step, i) => addPart(db, `${id}-p${i}`, id, step));
}

function addPart(db, partId, sessionId, step, timeCreated = clock++) {
  const data = step === TEXT
    ? { type: 'text', text: 'ответ' }
    : step === STEP
      ? { type: 'step-finish', reason: 'stop' }
      : { type: 'step-finish', reason: 'stop', model: { providerID: 'prov', modelID: step } };
  db.prepare('INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run(partId, sessionId, timeCreated, JSON.stringify(data));
}

describe('разбор аргументов kilo', () => {
  test('isKiloRun: kilo с подкомандой run, в том числе kilo.cmd по пути', () => {
    assert.equal(isKiloRun({ command: 'kilo', args: ['-m', 'kilo/router-x/free', 'run', '--auto'] }), true);
    // путь в записи своей ОС: на POSIX `C:\tools\kilo.cmd` — одно имя файла, а не путь
    assert.equal(isKiloRun({ command: path.resolve('tools', 'kilo.cmd'), args: ['run'] }), true);
    assert.equal(isKiloRun({ command: 'kilo', args: ['db', 'path'] }), false);
    assert.equal(isKiloRun({ command: 'other-cli', args: ['run'] }), false);
    assert.equal(isKiloRun({ command: 'node', args: ['stub.mjs'] }), false);
  });

  test('withKiloTitle: --title сразу после run, заданный в конфиге не меняется', () => {
    assert.deepEqual(
      withKiloTitle(['-m', 'x', 'run', '--auto'], 'workflow-1'),
      ['-m', 'x', 'run', '--title', 'workflow-1', '--auto'],
    );
    const own = ['run', '--title', 'моя', '--auto'];
    assert.deepEqual(withKiloTitle(own, 'workflow-1'), own);
  });

  test('kiloRunTitle: только безопасные для cmd.exe символы', () => {
    assert.equal(kiloRunTitle('3f2a-9b ok&|"'), 'workflow-3f2a-9b-ok---');
  });

  test('requestedKiloModel: -m и --model', () => {
    assert.equal(requestedKiloModel(['-m', 'kilo/router-x/free', 'run']), 'kilo/router-x/free');
    assert.equal(requestedKiloModel(['--model', 'prov/model-a', 'run']), 'prov/model-a');
    assert.equal(requestedKiloModel(['run']), null);
  });

  test('kiloModelKey: ключ как в session.model.id — без провайдера', () => {
    assert.equal(kiloModelKey('prov/model-a'), 'model-a');
    assert.equal(kiloModelKey('kilo/router-x/free'), 'router-x/free');
    assert.equal(kiloModelKey('model-a'), 'model-a');
    assert.equal(kiloModelKey(null), null);
  });

  test('formatKiloModels: полные id с числом шагов — для лога', () => {
    const models = [{ model: 'prov-a/alpha-3-ultra-550b:free', steps: 10 }, { model: 'model-a', steps: 1 }];
    assert.equal(formatKiloModels(models), 'prov-a/alpha-3-ultra-550b:free ×10, model-a ×1');
  });

  test('kiloAgentLabel: своя модель — без скобок, выбор роутера — имя, несколько — семейства', () => {
    assert.equal(kiloAgentLabel('agent-a', 'prov/model-a', [{ model: 'model-a', steps: 12 }]), 'agent-a');
    assert.equal(
      kiloAgentLabel('router-agent', 'kilo/router-x/free', [{ model: 'prov-d/delta-3-note-preview:free', steps: 48 }]),
      'router-agent(delta-3-note-preview)',
    );
    assert.equal(
      kiloAgentLabel('router-agent', 'kilo/router-y/free', [
        { model: 'prov-a/alpha-3-ultra-550b:free', steps: 10 },
        { model: 'prov-b/beta-3.0-flash-fin:free', steps: 9 },
        { model: 'prov-b/beta-3.0-flash-sante:free', steps: 8 },
        { model: 'prov-c/gamma-n2.5-mini:free', steps: 6 },
        { model: 'prov-a/alpha-3-super-120b:free', steps: 3 },
        { model: 'prov-e/epsilon-xs-2.1:free', steps: 2 },
      ]),
      'router-agent(alpha, beta, gamma, epsilon)',
    );
    assert.equal(kiloAgentLabel('router-agent', 'kilo/router-x/free', []), 'router-agent');
  });
});

describe('чтение базы kilo', { skip: skipNoSqlite }, () => {
  test('модели сессии и её субагентов, по убыванию шагов; чужая сессия не смешивается', async () => {
    const { dbPath, db } = makeDb('read.db');
    addSession(db, 'ses_root', 'workflow-run-1', {
      model: 'router-y/free',
      steps: ['prov-b/beta-3.0-flash-fin:free', TEXT, 'prov-a/alpha-3-ultra-550b:free', 'prov-a/alpha-3-ultra-550b:free'],
    });
    addSession(db, 'ses_child', 'Execute IMPL-1 (@general subagent)', { parentId: 'ses_root', steps: ['prov-e/epsilon-xs-2.1:free'] });
    addSession(db, 'ses_other', 'workflow-run-2', { model: 'router-x/free', steps: ['prov-d/delta-3-note-preview:free'] });
    db.close();

    assert.deepEqual(await readKiloModels(dbPath, 'workflow-run-1'), [
      { model: 'prov-a/alpha-3-ultra-550b:free', steps: 2 },
      { model: 'prov-b/beta-3.0-flash-fin:free', steps: 1 },
      { model: 'prov-e/epsilon-xs-2.1:free', steps: 1 },
    ]);
  });

  test('нет сессии — null; сессия без шагов — пустой список; нет базы — null', async () => {
    const { dbPath, db } = makeDb('empty.db');
    addSession(db, 'ses_a', 'workflow-no-steps', { model: 'model-a', steps: [TEXT] });
    db.close();
    assert.equal(await readKiloModels(dbPath, 'workflow-missing'), null);
    assert.deepEqual(await readKiloModels(dbPath, 'workflow-no-steps'), []);
    assert.deepEqual(await readKiloRun(dbPath, 'workflow-no-steps'), { models: [], last: null });
    assert.equal(await readKiloModels(path.join(BASE, 'nope.db'), 'workflow-x'), null);
    assert.equal(await readKiloRun(path.join(BASE, 'nope.db'), 'workflow-x'), null);
  });

  test('модель без роутера: шаги без модели отвечают моделью сессии', async () => {
    const { dbPath, db } = makeDb('fixed.db');
    addSession(db, 'ses_fixed', 'workflow-fixed', { model: 'model-a', steps: [STEP, TEXT, STEP, STEP] });
    db.close();
    assert.deepEqual(await readKiloModels(dbPath, 'workflow-fixed'), [{ model: 'model-a', steps: 3 }]);
    assert.deepEqual(await readKiloRun(dbPath, 'workflow-fixed'), { models: [{ model: 'model-a', steps: 3 }], last: 'model-a' });
  });

  test('субагент без своей модели отвечает моделью корневой сессии, со своей — своей', async () => {
    const { dbPath, db } = makeDb('subagent.db');
    addSession(db, 'ses_root', 'workflow-sub', { model: 'model-a', steps: [STEP, STEP] });
    addSession(db, 'ses_child', 'subagent', { parentId: 'ses_root', steps: [STEP] });
    addSession(db, 'ses_grandchild', 'subagent 2', { parentId: 'ses_child', steps: [STEP] });
    addSession(db, 'ses_own', 'subagent 3', { parentId: 'ses_root', model: 'model-b', steps: [STEP] });
    db.close();
    assert.deepEqual(await readKiloModels(dbPath, 'workflow-sub'), [
      { model: 'model-a', steps: 4 },
      { model: 'model-b', steps: 1 },
    ]);
  });

  test('модель запуска — последний шаг корневой сессии: A, B, A, C → C; шаги субагента не участвуют', async () => {
    const { dbPath, db } = makeDb('last.db');
    addSession(db, 'ses_root', 'workflow-last', { model: 'router-y/free', steps: ['model-a', 'model-b', 'model-a', 'model-c'] });
    // Субагент закончил позже корневой сессии — его модель не модель запуска.
    addSession(db, 'ses_child', 'subagent', { parentId: 'ses_root', steps: ['model-d'] });
    db.close();
    const run = await readKiloRun(dbPath, 'workflow-last');
    assert.equal(run.last, 'model-c');
    assert.deepEqual(run.models, [
      { model: 'model-a', steps: 2 },
      { model: 'model-b', steps: 1 },
      { model: 'model-c', steps: 1 },
      { model: 'model-d', steps: 1 },
    ]);
  });

  test('последний шаг: порядок по time_created, а не по вставке; при равенстве — наибольший id', async () => {
    const { dbPath, db } = makeDb('order.db');
    addSession(db, 'ses_root', 'workflow-order', { model: 'router-y/free' });
    addPart(db, 'p-3', 'ses_root', 'model-late', 300);
    addPart(db, 'p-1', 'ses_root', 'model-early', 100);
    db.close();
    assert.equal((await readKiloRun(dbPath, 'workflow-order')).last, 'model-late');

    const tie = makeDb('tie.db');
    addSession(tie.db, 'ses_root', 'workflow-tie', { model: 'router-y/free' });
    addPart(tie.db, 'p-b', 'ses_root', 'model-b', 500);
    addPart(tie.db, 'p-a', 'ses_root', 'model-a', 500);
    tie.db.close();
    assert.equal((await readKiloRun(tie.dbPath, 'workflow-tie')).last, 'model-b');
  });

  test('последний шаг без модели — модель сессии', async () => {
    const { dbPath, db } = makeDb('last-fixed.db');
    addSession(db, 'ses_root', 'workflow-last-fixed', { model: 'model-a', steps: ['model-b', STEP] });
    db.close();
    assert.equal((await readKiloRun(dbPath, 'workflow-last-fixed')).last, 'model-a');
  });
});

describe('раннер: подпись агента в логе и в истории тикета', { skip: skipNoSqlite }, () => {
  // Фейковый kilo: создаёт в базе сессию с переданным --title и моделью сессии из
  // FAKE_KILO_SESSION_MODEL (JSON или пусто), пишет шаги из FAKE_KILO_STEPS (JSON:
  // массив групп [{ session, model|null, parent? }] с паузой между группами) и
  // отвечает блоком RESULT.
  function writeFakeKilo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'kilo-stub.mjs');
    fs.writeFileSync(script, `
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const title = args[args.indexOf('--title') + 1];
const db = new DatabaseSync(process.env.FAKE_KILO_DB);
db.exec('PRAGMA busy_timeout = 5000;');
const sessionModel = process.env.FAKE_KILO_SESSION_MODEL || null;
const groups = JSON.parse(process.env.FAKE_KILO_STEPS);
const sessions = new Set();
let n = 0;
const ensure = (sid, parent) => {
  if (sessions.has(sid)) return;
  sessions.add(sid);
  const t = parent ? 'subagent' : title;
  db.prepare('INSERT INTO session (id, title, parent_id, model) VALUES (?, ?, ?, ?)').run(sid, t, parent || null, parent ? null : sessionModel);
};
for (let g = 0; g < groups.length; g++) {
  if (g > 0) await sleep(1500);
  for (const s of groups[g]) {
    ensure(s.session, s.parent);
    const data = s.model ? { type: 'step-finish', model: { providerID: 'prov', modelID: s.model } } : { type: 'step-finish' };
    n++;
    db.prepare('INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(s.session + '-' + n, s.session, Date.now() + n, JSON.stringify(data));
  }
}
await sleep(300);
db.close();
process.stdout.write('---RESULT---\\nstatus: default\\n---RESULT---\\n');
`);
    if (process.platform === 'win32') {
      const cmd = path.join(dir, 'kilo.cmd');
      fs.writeFileSync(cmd, `@node "%~dp0kilo-stub.mjs" %*\r\n`);
      return cmd;
    }
    const sh = path.join(dir, 'kilo');
    fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/kilo-stub.mjs" "$@"\n`);
    fs.chmodSync(sh, 0o755);
    return sh;
  }

  function makeLogger() {
    const lines = [];
    const push = (level) => (msg) => lines.push(`${level} ${msg}`);
    return {
      lines,
      info: push('INFO'), warn: push('WARN'), error: push('ERROR'),
      stageStart() {}, stageComplete() {}, cliCall(cmd, args) { lines.push(`CLI ${cmd} ${args.join(' ')}`); }, timeout() {},
    };
  }

  async function runFakeKilo({ name, agentId, requested, sessionModel, steps }) {
    const root = path.join(BASE, name);
    const ticketDir = path.join(root, '.workflow', 'tickets', 'in-progress');
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, 'IMPL-1.md');
    fs.writeFileSync(ticketPath, '---\nid: IMPL-1\n---\n\n# Тикет\n');

    const { dbPath, db } = makeDb(`${name}.db`);
    db.close();
    setKiloDbPathCache(dbPath);
    const saved = {
      FAKE_KILO_DB: process.env.FAKE_KILO_DB,
      FAKE_KILO_STEPS: process.env.FAKE_KILO_STEPS,
      FAKE_KILO_SESSION_MODEL: process.env.FAKE_KILO_SESSION_MODEL,
    };
    process.env.FAKE_KILO_DB = dbPath;
    process.env.FAKE_KILO_STEPS = JSON.stringify(steps);
    process.env.FAKE_KILO_SESSION_MODEL = sessionModel ? JSON.stringify({ id: sessionModel, providerID: 'prov' }) : '';

    const fakeKilo = writeFakeKilo(path.join(BASE, `${name}-bin`));
    const config = {
      pipeline: {
        name: 'kilo-models', version: '1.0',
        agents: {
          [agentId]: { command: fakeKilo, args: ['-m', requested, '--agent', 'code', 'run', '--auto'], capabilities: ['text'] },
        },
        execution: { artifact_snapshot_enabled: false, timeout_per_stage: 30 },
        stages: {}, entry: 'none', context: {},
      },
    };
    const logger = makeLogger();
    const executor = new StageExecutor(config, {}, {}, {}, null, logger, root);
    executor.context = { ticket_id: 'IMPL-1' };
    executor.kiloModelsPollMs = 50;

    let result;
    try {
      result = await executor.executeWithFallback('execute-task', { agents: [agentId], instructions: 'Выполни', skill: 'execute-task' });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    return { result, logger, ticketPath };
  }

  test('роутер: AGENT_MODELS при смене набора и в конце, в тикете — подпись в столбце «Агент»', async () => {
    const { result, logger, ticketPath } = await runFakeKilo({
      name: 'project-router',
      agentId: 'router-agent',
      requested: 'kilo/router-y/free',
      sessionModel: 'router-y/free',
      steps: [
        [{ session: 'ses_r', model: 'prov-a/alpha-3-ultra-550b:free' }],
        [
          { session: 'ses_r', model: 'prov-a/alpha-3-ultra-550b:free' },
          { session: 'ses_r', model: 'prov-b/beta-3.0-flash-fin:free' },
          { session: 'ses_c', parent: 'ses_r', model: 'prov-e/epsilon-xs-2.1:free' },
        ],
      ],
    });
    assert.equal(result.status, 'default');

    const cli = logger.lines.find((l) => l.startsWith('CLI '));
    assert.match(cli, / run --title workflow-[0-9a-f-]{36} --auto/, 'kilo получил метку запуска');

    const modelLines = logger.lines.filter((l) => l.startsWith('INFO AGENT_MODELS '));
    assert.equal(
      modelLines[0],
      'INFO AGENT_MODELS agent="router-agent(alpha-3-ultra-550b)" requested="kilo/router-y/free" models="prov-a/alpha-3-ultra-550b:free ×1"',
      'пока агент работает — видна первая модель',
    );
    assert.equal(
      modelLines.at(-1),
      'INFO AGENT_MODELS agent="router-agent(alpha, beta, epsilon)" requested="kilo/router-y/free" models="prov-a/alpha-3-ultra-550b:free ×2, prov-b/beta-3.0-flash-fin:free ×1, prov-e/epsilon-xs-2.1:free ×1"',
      'финальная строка — все модели, с субагентом',
    );

    const history = parseAgentHistory(fs.readFileSync(ticketPath, 'utf8'));
    assert.deepEqual(history.at(-1), {
      timestamp: history.at(-1).timestamp,
      skill: 'execute-task',
      agent: 'router-agent(alpha, beta, epsilon)',
      status: 'ok',
    });
  });

  test('без роутера: AGENT_MODELS с моделью сессии вместо «фактическая модель неизвестна»', async () => {
    const { logger, ticketPath } = await runFakeKilo({
      name: 'project-fixed',
      agentId: 'agent-a',
      requested: 'prov/model-a',
      sessionModel: 'model-a',
      steps: [[{ session: 'ses_f', model: null }, { session: 'ses_f', model: null }, { session: 'ses_f', model: null }]],
    });
    const modelLines = logger.lines.filter((l) => l.startsWith('INFO AGENT_MODELS '));
    assert.equal(modelLines.at(-1), 'INFO AGENT_MODELS agent="agent-a" requested="prov/model-a" models="model-a ×3"');
    assert.ok(!logger.lines.some((l) => l.includes('фактическая модель неизвестна')), logger.lines.join('\n'));
    const history = parseAgentHistory(fs.readFileSync(ticketPath, 'utf8'));
    assert.equal(history.at(-1).agent, 'agent-a');
  });

  test('не-kilo агент: без метки и без строки о модели', async () => {
    const root = path.join(BASE, 'project-node');
    fs.mkdirSync(root, { recursive: true });
    const stub = path.join(root, 'stub.mjs');
    fs.writeFileSync(stub, `process.stdout.write('---RESULT---\\nstatus: default\\n---RESULT---\\n');`);
    const config = {
      pipeline: {
        name: 'kilo-models', version: '1.0',
        agents: { 'node-agent': { command: 'node', args: [stub, 'run'], capabilities: ['text'] } },
        execution: { artifact_snapshot_enabled: false, timeout_per_stage: 30 },
        stages: {}, entry: 'none', context: {},
      },
    };
    const logger = makeLogger();
    const executor = new StageExecutor(config, {}, {}, {}, null, logger, root);
    await executor.executeWithFallback('execute-task', { agents: ['node-agent'], instructions: 'x', skill: 'execute-task' });
    assert.ok(!logger.lines.some((l) => l.includes('--title') || l.includes('AGENT_MODELS') || l.includes('kilo:')), logger.lines.join('\n'));
  });
});

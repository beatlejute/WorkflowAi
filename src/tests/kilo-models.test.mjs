/**
 * Фактическая модель kilo-агента (src/lib/kilo-models.mjs) и её путь в раннере.
 *
 * Роутеры kilo/kilo-auto/free и kilo/openrouter/free выбирают модель сами; kilo 7.7.9
 * пишет ответившую модель в каждую часть step-finish своей базы. 2026-09-25 в
 * PulseProxy через openrouter/free в одной сессии execute-task отвечали 11 моделей,
 * а лог раннера показывал только роутер.
 *
 * Что охраняется:
 *  - раннер передаёт kilo `--title` с меткой запуска и не трогает `--title` из конфига;
 *  - по метке находятся модели корневой сессии и её субагентов, чужие сессии не
 *    смешиваются; нет сессии — null, а не пустой список;
 *  - подпись агента: своя модель — без скобок (`gpt-luna`), выбор роутера — в скобках
 *    (`kilo-free(dots-3-note-preview)`), несколько — семейства (`openrouter-free(nemotron, ling)`);
 *  - пока агент работает, раннер пишет `AGENT_MODELS` при смене подписи (по ней панель
 *    pipeline в расширении обновляет агента), после выхода — финальную строку;
 *    в историю работы тикета, в столбец «Агент», встаёт та же подпись;
 *  - у не-kilo агентов ни метки, ни поиска.
 *
 * База kilo здесь — временный SQLite с теми же таблицами и полями, что читает модуль
 * (session: id, title, parent_id; part: id, session_id, data). Фейковый kilo —
 * скрипт, который, как настоящий, создаёт сессию с переданным `--title`.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/kilo-models.test.mjs
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isKiloRun, kiloRunTitle, withKiloTitle, requestedKiloModel,
  readKiloModels, formatKiloModels, kiloAgentLabel, setKiloDbPathCache,
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

function makeDb(name) {
  const dbPath = path.join(BASE, name);
  const db = new sqlite.DatabaseSync(dbPath);
  // Как у настоящей базы kilo: в режиме WAL чтение раннера не блокирует запись агента.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT);
           CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);`);
  return { dbPath, db };
}

function addSession(db, id, title, parentId = null, steps = []) {
  db.prepare('INSERT INTO session (id, title, parent_id) VALUES (?, ?, ?)').run(id, title, parentId);
  steps.forEach((model, i) => {
    const data = model === null
      ? { type: 'text', text: 'ответ' }
      : { type: 'step-finish', reason: 'stop', model: { providerID: 'kilo', modelID: model } };
    db.prepare('INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)').run(`${id}-p${i}`, id, JSON.stringify(data));
  });
}

describe('разбор аргументов kilo', () => {
  test('isKiloRun: kilo с подкомандой run, в том числе kilo.cmd по пути', () => {
    assert.equal(isKiloRun({ command: 'kilo', args: ['-m', 'kilo/openrouter/free', 'run', '--auto'] }), true);
    // путь в записи своей ОС: на POSIX `C:\tools\kilo.cmd` — одно имя файла, а не путь
    assert.equal(isKiloRun({ command: path.resolve('tools', 'kilo.cmd'), args: ['run'] }), true);
    assert.equal(isKiloRun({ command: 'kilo', args: ['db', 'path'] }), false);
    assert.equal(isKiloRun({ command: 'claude', args: ['run'] }), false);
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
    assert.equal(requestedKiloModel(['-m', 'kilo/kilo-auto/free', 'run']), 'kilo/kilo-auto/free');
    assert.equal(requestedKiloModel(['--model', 'openai/gpt-5.6-luna', 'run']), 'openai/gpt-5.6-luna');
    assert.equal(requestedKiloModel(['run']), null);
  });

  test('formatKiloModels: полные id с числом шагов — для лога', () => {
    const models = [{ model: 'nvidia/nemotron-3-ultra-550b-a55b:free', steps: 10 }, { model: 'gpt-5.6-luna', steps: 1 }];
    assert.equal(formatKiloModels(models), 'nvidia/nemotron-3-ultra-550b-a55b:free ×10, gpt-5.6-luna ×1');
  });

  test('kiloAgentLabel: своя модель — без скобок, выбор роутера — имя, несколько — семейства', () => {
    assert.equal(kiloAgentLabel('gpt-luna', 'openai/gpt-5.6-luna', [{ model: 'gpt-5.6-luna', steps: 12 }]), 'gpt-luna');
    assert.equal(
      kiloAgentLabel('kilo-free', 'kilo/kilo-auto/free', [{ model: 'dots-studio/dots-3-note-preview:free', steps: 48 }]),
      'kilo-free(dots-3-note-preview)',
    );
    assert.equal(
      kiloAgentLabel('openrouter-free', 'kilo/openrouter/free', [
        { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', steps: 10 },
        { model: 'inclusionai/ling-3.0-flash-fin:free', steps: 9 },
        { model: 'inclusionai/ling-3.0-flash-sante:free', steps: 8 },
        { model: 'nex-agi/nex-n2.5-mini:free', steps: 6 },
        { model: 'nvidia/nemotron-3-super-120b-a12b:free', steps: 3 },
        { model: 'poolside/laguna-xs-2.1:free', steps: 2 },
      ]),
      'openrouter-free(nemotron, ling, nex, laguna)',
    );
    assert.equal(kiloAgentLabel('kilo-free', 'kilo/kilo-auto/free', []), 'kilo-free');
  });
});

describe('чтение базы kilo', { skip: skipNoSqlite }, () => {
  test('модели сессии и её субагентов, по убыванию шагов; чужая сессия не смешивается', async () => {
    const { dbPath, db } = makeDb('read.db');
    addSession(db, 'ses_root', 'workflow-run-1', null, [
      'inclusionai/ling-3.0-flash-fin:free', null, 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free',
    ]);
    addSession(db, 'ses_child', 'Execute IMPL-1 (@general subagent)', 'ses_root', ['poolside/laguna-xs-2.1:free']);
    addSession(db, 'ses_other', 'workflow-run-2', null, ['dots-studio/dots-3-note-preview:free']);
    db.close();

    assert.deepEqual(await readKiloModels(dbPath, 'workflow-run-1'), [
      { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', steps: 2 },
      { model: 'inclusionai/ling-3.0-flash-fin:free', steps: 1 },
      { model: 'poolside/laguna-xs-2.1:free', steps: 1 },
    ]);
  });

  test('нет сессии — null; сессия без шагов — пустой список; нет базы — null', async () => {
    const { dbPath, db } = makeDb('empty.db');
    addSession(db, 'ses_a', 'workflow-no-steps', null, [null]);
    db.close();
    assert.equal(await readKiloModels(dbPath, 'workflow-missing'), null);
    assert.deepEqual(await readKiloModels(dbPath, 'workflow-no-steps'), []);
    assert.equal(await readKiloModels(path.join(BASE, 'nope.db'), 'workflow-x'), null);
  });
});

describe('раннер: подпись агента в логе и в истории тикета', { skip: skipNoSqlite }, () => {
  // Фейковый kilo: создаёт в базе сессию с переданным --title, пишет шаг одной модели,
  // ждёт, дописывает шаги ещё двух (одну — субагенту) и отвечает блоком RESULT.
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
const ins = (id, t, parent) => db.prepare('INSERT INTO session (id, title, parent_id) VALUES (?, ?, ?)').run(id, t, parent);
const step = (sid, i, model) => db.prepare('INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)')
  .run(sid + '-' + i, sid, JSON.stringify({ type: 'step-finish', model: { providerID: 'kilo', modelID: model } }));
ins('ses_r', title, null);
step('ses_r', 1, 'nvidia/nemotron-3-ultra-550b-a55b:free');
await sleep(1500);
step('ses_r', 2, 'nvidia/nemotron-3-ultra-550b-a55b:free');
step('ses_r', 3, 'inclusionai/ling-3.0-flash-fin:free');
ins('ses_c', 'subagent', 'ses_r');
step('ses_c', 1, 'poolside/laguna-xs-2.1:free');
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

  test('openrouter/free: AGENT_MODELS при смене набора и в конце, в тикете — подпись в столбце «Агент»', async () => {
    const root = path.join(BASE, 'project');
    const ticketDir = path.join(root, '.workflow', 'tickets', 'in-progress');
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, 'IMPL-1.md');
    fs.writeFileSync(ticketPath, '---\nid: IMPL-1\n---\n\n# Тикет\n');

    const { dbPath, db } = makeDb('runner.db');
    db.close();
    setKiloDbPathCache(dbPath);
    const prevDb = process.env.FAKE_KILO_DB;
    process.env.FAKE_KILO_DB = dbPath;

    const fakeKilo = writeFakeKilo(path.join(BASE, 'bin'));
    const config = {
      pipeline: {
        name: 'kilo-models', version: '1.0',
        agents: {
          'openrouter-free': { command: fakeKilo, args: ['-m', 'kilo/openrouter/free', '--agent', 'code', 'run', '--auto'], capabilities: ['text'] },
        },
        execution: { artifact_snapshot_enabled: false, timeout_per_stage: 30 },
        stages: {}, entry: 'none', context: {},
      },
    };
    const logger = makeLogger();
    const executor = new StageExecutor(config, {}, {}, {}, null, logger, root);
    executor.context = { ticket_id: 'IMPL-1' };
    executor.kiloModelsPollMs = 50;

    try {
      const result = await executor.executeWithFallback('execute-task', { agents: ['openrouter-free'], instructions: 'Выполни', skill: 'execute-task' });
      assert.equal(result.status, 'default');
    } finally {
      if (prevDb === undefined) delete process.env.FAKE_KILO_DB; else process.env.FAKE_KILO_DB = prevDb;
    }

    const cli = logger.lines.find((l) => l.startsWith('CLI '));
    assert.match(cli, / run --title workflow-[0-9a-f-]{36} --auto/, 'kilo получил метку запуска');

    const modelLines = logger.lines.filter((l) => l.startsWith('INFO AGENT_MODELS '));
    assert.equal(
      modelLines[0],
      'INFO AGENT_MODELS agent="openrouter-free(nemotron-3-ultra-550b-a55b)" requested="kilo/openrouter/free" models="nvidia/nemotron-3-ultra-550b-a55b:free ×1"',
      'пока агент работает — видна первая модель',
    );
    assert.equal(
      modelLines.at(-1),
      'INFO AGENT_MODELS agent="openrouter-free(nemotron, ling, laguna)" requested="kilo/openrouter/free" models="nvidia/nemotron-3-ultra-550b-a55b:free ×2, inclusionai/ling-3.0-flash-fin:free ×1, poolside/laguna-xs-2.1:free ×1"',
      'финальная строка — все модели, с субагентом',
    );

    const history = parseAgentHistory(fs.readFileSync(ticketPath, 'utf8'));
    assert.deepEqual(history.at(-1), {
      timestamp: history.at(-1).timestamp,
      skill: 'execute-task',
      agent: 'openrouter-free(nemotron, ling, laguna)',
      status: 'ok',
    });
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


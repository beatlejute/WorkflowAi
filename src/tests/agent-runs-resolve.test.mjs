/**
 * Отсев агента с запрещённой моделью при выборе — StageExecutor.resolveAgent
 * (src/runner.mjs, PLAN-003 задачи 19–20).
 *
 * Запреты вычисляются из журнала запусков `.workflow/metrics/agent-runs.jsonl`
 * (src/lib/agent-runs.mjs): постоянный — пара «модель + тип тикета», временный —
 * модель целиком за сбой. Выбор агента исключает агента, чей ключ модели под
 * запретом, — только на стадии исполнителя (скил execute-task): одна модель стоит и у
 * исполнителя, и у судьи ревью (решение 2026-09-26, «Только исполнитель»). Ключ
 * модели выбора обязан совпадать с ключом события `run`: разойдись они — запрет,
 * посчитанный по журналу, не нашёл бы агента, и плохая модель выбиралась бы дальше.
 *
 * Что охраняется:
 *  - постоянный запрет по типу: агент не выбирается для тикета `impl` и выбирается
 *    для `docs`; причина пропуска — в логе;
 *  - временный запрет — на модель для любого типа; истёкший TTL не действует;
 *  - роутер kilo по ключу роутера не отсеивается: его запуски с непрочитанной моделью
 *    (`model: null`) и ответившие модели ключ роутера не запрещают;
 *  - журнал не читается — агенты не фильтруются, WARN в лог;
 *  - стадия не исполнителя — без фильтра;
 *  - все агенты под запретом — `blocked: all_banned` с причиной запрета, не
 *    нездоровья; executeWithFallback отдаёт `status: blocked`, агент не запускается;
 *  - ключ kilo-агента `-m prov/x` — `x`, агента не kilo `--model prov/y` — `prov/y`,
 *    `kind: http` — поле `model`, без модели — id агента; и тот же ключ, что пишет
 *    событие `run` живого запуска (stub-агент и фейковый kilo).
 *
 * Корень — временный проект в os.tmpdir() с журналом-фикстурой, снимается в
 * afterEach. Имена моделей и агентов — нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-resolve.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { setKiloDbPathCache } from '../lib/kilo-models.mjs';
import { configuredModelKey } from '../lib/agent-runs.mjs';

let sqlite = null;
try {
  process.removeAllListeners('warning');
  sqlite = await import('node:sqlite');
} catch {}
const skipNoSqlite = sqlite ? false : 'node:sqlite недоступен (Node < 22.5)';

const TEMPS = [];
afterEach(() => {
  setKiloDbPathCache();
  for (const dir of TEMPS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeTemp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-resolve-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { base, root, outside };
}

function journalPath(root) {
  return path.join(root, '.workflow', 'metrics', 'agent-runs.jsonl');
}

function writeJournal(root, events) {
  const file = journalPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

let seq = 0;
const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

/** Событие run исполнителя; по умолчанию — «пусто» (статус ok, ни одного изменённого файла). */
function run({ model, agent = 'agent-x', ticketType = 'impl', status = 'ok', changed = 0, ts = minutesAgo(30), ...extra }) {
  seq += 1;
  const prefix = ticketType ? ticketType.toUpperCase() : 'T';
  return {
    type: 'run', ts, run_key: `rk-${seq}`, pipeline_run: 'pr-1', stage: 'execute-task', skill: 'execute-task',
    ticket: `${prefix}-${seq}`, ticket_type: ticketType, attempt: 1, agent, requested: null, models: null,
    model, status, exit_code: status === 'ok' ? 0 : 1, changed_files: changed, duration_ms: 1000, ...extra,
  };
}

/** Три «пусто» без успеха — постоянный запрет пары по правилу 1. */
const permanentBan = (model, ticketType = 'impl') => [0, 1, 2].map(() => run({ model, ticketType }));

/** Сбой без правок минуту назад с TTL 1 час — временный запрет модели. */
const crashBan = (model, { ts = minutesAgo(1), ttl = 60 * 60 * 1000 } = {}) =>
  [run({ model, status: 'error', changed: 0, crash_ttl_ms: ttl, ts })];

// Агенты выбора. Команды не запускаются: resolveAgent только выбирает.
const AGENTS = {
  'agent-k': { command: 'kilo', args: ['-m', 'prov/model-a', '--agent', 'code', 'run', '--auto'], capabilities: ['text'] },
  'agent-n': { command: 'node', args: ['agent.mjs', '--model', 'prov/model-b'], capabilities: ['text'] },
  'router-k': { command: 'kilo', args: ['-m', 'kilo/router-x/free', '--agent', 'code', 'run', '--auto'], capabilities: ['text'] },
  'agent-r1': { command: 'kilo', args: ['-m', 'prov/model-r1', 'run'], capabilities: ['text'] },
  'agent-h': { kind: 'http', protocol: 'decisions', url: 'http://127.0.0.1:9/d', model: 'prov/model-h', capabilities: ['text'] },
  'agent-plain': { command: 'node', args: ['agent.mjs'], capabilities: ['text'] },
};

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'),
    stageStart() {}, stageComplete() {}, timeout() {}, cliCall() {},
  };
}

function makeExecutor(root, context, agents = AGENTS) {
  const logger = captureLogger();
  const config = {
    pipeline: {
      name: 'agent-runs-resolve', version: '1.0', agents,
      execution: { artifact_snapshot_enabled: true, timeout_per_stage: 60 },
      stages: {}, entry: 'none', context: {},
    },
  };
  const executor = new StageExecutor(config, context, {}, {}, null, logger, root);
  executor.kiloModelsPollMs = 50;
  return { executor, logger };
}

const executorStage = (agents) => ({ agents, instructions: 'Выполни тикет', skill: 'execute-task' });

function resolve(root, context, stage) {
  const { executor, logger } = makeExecutor(root, context);
  const resolved = executor.resolveAgent(stage, 'execute-task');
  return { resolved, logger };
}

const skipLines = (logger) => logger.lines.filter((l) => / skipped: model /.test(l));

// ---------------------------------------------------------------------------

describe('resolveAgent: запреты моделей на стадии исполнителя', () => {
  test('постоянный запрет по типу: impl — агент пропущен с причиной в логе, docs — выбран', () => {
    const { root } = makeTemp();
    writeJournal(root, permanentBan('model-a', 'impl'));
    const stage = executorStage(['agent-k', 'agent-n']);

    const impl = resolve(root, { ticket_id: 'IMPL-9' }, stage);
    assert.equal(impl.resolved.blocked, undefined, JSON.stringify(impl.resolved));
    assert.equal(impl.resolved.agentId, 'agent-n');
    assert.deepEqual(impl.resolved.compatible, ['agent-n']);
    const lines = skipLines(impl.logger);
    assert.equal(lines.length, 1, impl.logger.lines.join('\n'));
    assert.match(lines[0], /^INFO agent agent-k skipped: model "model-a" — permanent ban for type "impl" by rule 1/);

    const docs = resolve(root, { ticket_id: 'DOCS-4' }, stage);
    assert.equal(docs.resolved.agentId, 'agent-k');
    assert.deepEqual(docs.resolved.compatible, ['agent-k', 'agent-n']);
    assert.deepEqual(skipLines(docs.logger), []);

    // Тип тикета — task_type контекста раньше префикса ticket_id, как у resolveAgent.
    const typed = resolve(root, { ticket_id: 'IMPL-9', task_type: 'docs' }, stage);
    assert.equal(typed.resolved.agentId, 'agent-k');
  });

  test('временный запрет — модель целиком, для любого типа; истёкший TTL не действует', () => {
    const { root } = makeTemp();
    writeJournal(root, crashBan('prov/model-b'));
    const stage = executorStage(['agent-n', 'agent-k']);

    for (const ticketId of ['IMPL-9', 'DOCS-4', 'TEST-2']) {
      const { resolved, logger } = resolve(root, { ticket_id: ticketId }, stage);
      assert.equal(resolved.agentId, 'agent-k', `${ticketId}: ${JSON.stringify(resolved)}`);
      assert.deepEqual(resolved.compatible, ['agent-k']);
      const lines = skipLines(logger);
      assert.equal(lines.length, 1, logger.lines.join('\n'));
      assert.match(lines[0], /agent agent-n skipped: model "prov\/model-b" — temporary ban until \d{4}-\d{2}-\d{2}T/);
    }

    const expired = makeTemp();
    writeJournal(expired.root, crashBan('prov/model-b', { ts: minutesAgo(120), ttl: 60 * 60 * 1000 }));
    const { resolved, logger } = resolve(expired.root, { ticket_id: 'IMPL-9' }, stage);
    assert.equal(resolved.agentId, 'agent-n');
    assert.deepEqual(resolved.compatible, ['agent-n', 'agent-k']);
    assert.deepEqual(skipLines(logger), []);
  });

  test('роутер kilo не отсеивается: запуски с model: null и ответившие модели не запрещают ключ роутера', () => {
    const { root } = makeTemp();
    writeJournal(root, [
      // Роутер: модель не прочитана — три «пусто» и последним сбой.
      ...[0, 1, 2].map(() => run({ model: null, agent: 'router-k' })),
      run({ model: null, agent: 'router-k', status: 'error', crash_ttl_ms: 3600000, ts: minutesAgo(1) }),
      // Модель, которую выбирал роутер, — под постоянным и временным запретом.
      ...[0, 1, 2].map(() => run({ model: 'model-r1', agent: 'router-k' })),
      run({ model: 'model-r1', agent: 'router-k', status: 'error', crash_ttl_ms: 3600000, ts: minutesAgo(1) }),
    ]);
    const { resolved, logger } = resolve(root, { ticket_id: 'IMPL-9' }, executorStage(['router-k', 'agent-r1']));
    assert.equal(resolved.agentId, 'router-k', JSON.stringify(resolved));
    assert.deepEqual(resolved.compatible, ['router-k'], 'агент с той же моделью без роутера пропущен — запреты действуют');
    const lines = skipLines(logger);
    assert.equal(lines.length, 1, logger.lines.join('\n'));
    assert.match(lines[0], /agent agent-r1 skipped: model "model-r1"/);
  });

  test('журнал не читается (каталог вместо файла) — агенты не фильтруются, WARN в лог', () => {
    const { root } = makeTemp();
    fs.mkdirSync(journalPath(root), { recursive: true });
    const { resolved, logger } = resolve(root, { ticket_id: 'IMPL-9' }, executorStage(['agent-k', 'agent-n']));
    assert.equal(resolved.agentId, 'agent-k', JSON.stringify(resolved));
    assert.deepEqual(resolved.compatible, ['agent-k', 'agent-n']);
    const warns = logger.lines.filter((l) => l.startsWith('WARN '));
    assert.equal(warns.length, 1, logger.lines.join('\n'));
    assert.match(warns[0], /journal not readable, model bans not applied/);
  });

  test('стадия не исполнителя — без фильтра, тот же агент выбирается', () => {
    const { root } = makeTemp();
    writeJournal(root, [...permanentBan('model-a', 'impl'), ...crashBan('prov/model-b')]);
    for (const stage of [
      { agents: ['agent-k', 'agent-n'], instructions: 'Ревью', skill: 'review-result' },
      { agents: ['agent-k', 'agent-n'], instructions: 'Отчёт', skill: 'create-report' },
      { agents: ['agent-k', 'agent-n'], model_io: { prepare: 'p.mjs', apply: 'a.mjs' } },
    ]) {
      const { resolved, logger } = resolve(root, { ticket_id: 'IMPL-9' }, stage);
      assert.equal(resolved.agentId, 'agent-k', `${stage.skill}: ${JSON.stringify(resolved)}`);
      assert.deepEqual(resolved.compatible, ['agent-k', 'agent-n']);
      assert.deepEqual(skipLines(logger), []);
    }
  });

  test('все агенты под запретом — blocked all_banned с причиной запрета; executeWithFallback — status blocked', async () => {
    const { root } = makeTemp();
    const events = [...permanentBan('model-a', 'impl'), ...crashBan('prov/model-b')];
    writeJournal(root, events);
    const stage = executorStage(['agent-k', 'agent-n']);

    const { resolved } = resolve(root, { ticket_id: 'IMPL-9' }, stage);
    assert.equal(resolved.blocked, 'all_banned', JSON.stringify(resolved));
    assert.equal(resolved.attempt, 1);
    assert.match(resolved.reason, /agent-k \(model-a: permanent ban for type "impl" by rule 1/);
    assert.match(resolved.reason, /agent-n \(prov\/model-b: temporary ban until /);
    assert.doesNotMatch(resolved.reason, /unhealthy/i, 'причина — запрет, а не нездоровье агентов');

    const { executor, logger } = makeExecutor(root, { ticket_id: 'IMPL-9' });
    const result = await executor.executeWithFallback('execute-task', stage);
    assert.equal(result.status, 'blocked');
    assert.equal(result.blocked_reason, 'all_banned');
    assert.equal(result.reason, resolved.reason);
    assert.ok(logger.lines.some((l) => l.startsWith('WARN ') && l.includes(resolved.reason)), logger.lines.join('\n'));
    assert.ok(!logger.lines.some((l) => l.includes('RUN ')), 'агент не запускался');
    const after = fs.readFileSync(journalPath(root), 'utf8').trim().split('\n');
    assert.equal(after.length, events.length, 'событий run не добавилось');
  });
});

// ---------------------------------------------------------------------------

describe('ключ модели выбора — как в событии run', () => {
  test('kilo -m prov/x → x; не kilo --model prov/y → prov/y; http — поле model; без модели — id агента', () => {
    assert.equal(configuredModelKey(AGENTS['agent-k'], 'agent-k'), 'model-a');
    assert.equal(configuredModelKey(AGENTS['agent-n'], 'agent-n'), 'prov/model-b');
    assert.equal(configuredModelKey(AGENTS['router-k'], 'router-k'), 'router-x/free');
    assert.equal(configuredModelKey(AGENTS['agent-h'], 'agent-h'), 'prov/model-h');
    assert.equal(configuredModelKey(AGENTS['agent-plain'], 'agent-plain'), 'agent-plain');

    const cases = [
      // [агент, ключ под запретом → агент пропущен, похожий ключ → агент выбран]
      ['agent-k', 'model-a', 'prov/model-a'],
      ['agent-n', 'prov/model-b', 'model-b'],
      ['agent-h', 'prov/model-h', 'model-h'],
      ['agent-plain', 'agent-plain', 'prov/agent-plain'],
    ];
    for (const [agentId, bannedKey, otherKey] of cases) {
      const stage = executorStage([agentId, 'agent-r1']);

      const hit = makeTemp();
      writeJournal(hit.root, permanentBan(bannedKey, 'impl'));
      const banned = resolve(hit.root, { ticket_id: 'IMPL-9' }, stage);
      assert.equal(banned.resolved.agentId, 'agent-r1', `${agentId} под запретом ключа ${bannedKey}`);
      assert.match(skipLines(banned.logger)[0] ?? '', new RegExp(`agent ${agentId} skipped: model "${bannedKey.replace('/', '\\/')}"`));

      const miss = makeTemp();
      writeJournal(miss.root, permanentBan(otherKey, 'impl'));
      const chosen = resolve(miss.root, { ticket_id: 'IMPL-9' }, stage);
      assert.equal(chosen.resolved.agentId, agentId, `${agentId} не под запретом ключа ${otherKey}`);
      assert.deepEqual(skipLines(chosen.logger), []);
    }
  });

  test('живые запуски stub-агента --model prov/y: три «пусто» в журнале → агент пропущен при выборе', async () => {
    const { root, outside } = makeTemp();
    const stub = path.join(outside, 'idle-agent.mjs');
    fs.writeFileSync(stub, `process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');\n`);
    const agents = {
      'agent-y': { command: 'node', args: [stub, '--model', 'prov/model-y'], capabilities: ['text'] },
      'agent-z': { command: 'node', args: [stub, '--model', 'prov/model-z'], capabilities: ['text'] },
    };
    const stage = executorStage(['agent-y', 'agent-z']);
    for (let i = 0; i < 3; i++) {
      const { executor } = makeExecutor(root, { ticket_id: 'IMPL-1' }, agents);
      const result = await executor.executeWithFallback('execute-task', stage);
      assert.equal(result.status, 'passed');
    }
    const runs = fs.readFileSync(journalPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(runs.map((e) => [e.agent, e.model, e.status, e.changed_files]),
      Array(3).fill(['agent-y', 'prov/model-y', 'ok', 0]));

    const { executor, logger } = makeExecutor(root, { ticket_id: 'IMPL-1' }, agents);
    const resolved = executor.resolveAgent(stage, 'execute-task');
    assert.equal(resolved.agentId, 'agent-z', logger.lines.join('\n'));
    assert.match(skipLines(logger)[0] ?? '', /agent agent-y skipped: model "prov\/model-y" — permanent ban for type "impl" by rule 1/);

    // Для другого типа тикета запрета нет.
    const docs = makeExecutor(root, { ticket_id: 'DOCS-1' }, agents).executor.resolveAgent(stage, 'execute-task');
    assert.equal(docs.agentId, 'agent-y');
  });

  test('живые запуски фейкового kilo -m prov/x: модель шагов x, три «пусто» → агент пропущен при выборе',
    { skip: skipNoSqlite }, async () => {
      const { root, outside } = makeTemp();
      const dbPath = path.join(outside, 'kilo.db');
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT, model TEXT);
               CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);
      db.close();
      setKiloDbPathCache(dbPath);

      // Как kilo 7.7.9 с фиксированной моделью: session.model.id — модель без провайдера
      // из -m, в шагах модели нет.
      const script = path.join(outside, 'kilo-stub.mjs');
      fs.writeFileSync(script, `
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');
const args = process.argv.slice(2);
const title = args[args.indexOf('--title') + 1];
const requested = args[args.indexOf('-m') + 1];
const slash = requested.indexOf('/');
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec('PRAGMA busy_timeout = 5000;');
const sid = 'ses_' + process.pid + '_' + Date.now();
db.prepare('INSERT INTO session (id, title, parent_id, model) VALUES (?, ?, ?, ?)')
  .run(sid, title, null, JSON.stringify({ id: requested.slice(slash + 1), providerID: requested.slice(0, slash) }));
for (let i = 0; i < 2; i++) {
  db.prepare('INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run(sid + '-' + i, sid, Date.now() + i, JSON.stringify({ type: 'step-finish' }));
}
db.close();
process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');
`);
      let command;
      if (process.platform === 'win32') {
        command = path.join(outside, 'kilo.cmd');
        fs.writeFileSync(command, `@node "%~dp0kilo-stub.mjs" %*\r\n`);
      } else {
        command = path.join(outside, 'kilo');
        fs.writeFileSync(command, `#!/bin/sh\nexec node "$(dirname "$0")/kilo-stub.mjs" "$@"\n`);
        fs.chmodSync(command, 0o755);
      }
      const agents = {
        'agent-kx': { command, args: ['-m', 'prov/model-x', '--agent', 'code', 'run', '--auto'], capabilities: ['text'] },
        'agent-n': AGENTS['agent-n'],
      };
      const stage = executorStage(['agent-kx', 'agent-n']);
      for (let i = 0; i < 3; i++) {
        const { executor, logger } = makeExecutor(root, { ticket_id: 'IMPL-1' }, agents);
        const result = await executor.executeWithFallback('execute-task', stage);
        assert.equal(result.status, 'passed', logger.lines.join('\n'));
      }
      const runs = fs.readFileSync(journalPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(runs.map((e) => [e.agent, e.requested, e.model, e.changed_files]),
        Array(3).fill(['agent-kx', 'prov/model-x', 'model-x', 0]));

      const { executor, logger } = makeExecutor(root, { ticket_id: 'IMPL-1' }, agents);
      const resolved = executor.resolveAgent(stage, 'execute-task');
      assert.equal(resolved.agentId, 'agent-n', logger.lines.join('\n'));
      assert.match(skipLines(logger)[0] ?? '', /agent agent-kx skipped: model "model-x" — permanent ban for type "impl" by rule 1/);
    });
});

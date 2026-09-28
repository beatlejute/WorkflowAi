/**
 * Правила health участника пула (PLAN-004, задачи 21–22): src/runner.mjs —
 * онлайн-скан stderr (_callAgentOnce), classify после выхода (executeWithFallback).
 *
 * Правила участника `<пул>@<id>` ищутся по id пула (`agent.pool ?? agentId`):
 * доступность — свойство маршрута, правила у всех участников пула общие, а в файле
 * правил участников нет (их состав известен только после раскрытия). Пометка
 * нездоровья и проверка здоровья — по id участника: соседний участник того же пула
 * остаётся в выборе. Раздел плана «Справочные данные» → «Правила health участника».
 *
 * Что охраняется:
 *  - участник, у пула которого (по наследованию `extends`) есть правило ограничения
 *    провайдера, снимается онлайн на строке stderr формата kilo 7.7.9 — в логе
 *    `Fatal stderr pattern matched for <пул>@<id> (rule=…)`, процесс участника снят;
 *  - в health-реестре помечается `<пул>@<id>`, запись пула и соседний участник — нет;
 *  - сбой, опознанный правилом пула только после выхода (класс не для онлайн-скана), —
 *    пометка участника и TTL правила в `crash_ttl_ms` события run.
 *
 * Корень — временный каталог ОС с `.workflow/config/agent-health-rules.yaml`,
 * снимается в afterEach; процессы участников, если живы, снимаются там же. Имена
 * моделей, агентов и провайдеров — нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/model-pools-rules.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { expandModelPools } from '../lib/model-pools.mjs';
import { readRunEvents } from '../lib/agent-runs.mjs';
import { isHealthy } from '../lib/agent-health-registry.mjs';
import { processAlive } from '../lib/process-alive.mjs';

const TEMPS = [];
const PID_FILES = [];
afterEach(() => {
  for (const file of PID_FILES.splice(0)) {
    try {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (pid && processAlive(pid)) process.kill(pid);
    } catch {}
  }
  for (const dir of TEMPS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Правила по образцу шага 0: у базового агента — правила строк `stream error`, пул
// наследует их через `extends`. Шаблоны — как в configs/agent-health-rules.yaml.
const RULES_YAML = `version: "1.0"
agents:
  base-a:
    rules:
      - id: "stream-daily-limit"
        class: "unavailable"
        ttl: "until_utc_midnight"
        pattern: '(?:^|\\n)timestamp=[^ \\n]+ level=ERROR [^\\n]*message="stream error"[^\\n]*(?:limit_rpd|[Dd]aily limit)'
        exit_codes: "any"
      - id: "stream-rate-limit"
        class: "unavailable"
        ttl: "15m"
        pattern: '(?:^|\\n)timestamp=[^ \\n]+ level=ERROR [^\\n]*message="stream error"[^\\n]*(?:Rate limit exceeded|rate-limited upstream)'
        exit_codes: "any"
      - id: "vendor-overloaded-marker"
        class: "transient"
        ttl: "5m"
        pattern: "vendor overloaded marker"
        exit_codes: "any"
  pool-a:
    extends: base-a
`;

// Строка ограничения провайдера в формате kilo 7.7.9 (provider и модель — нейтральные).
const LIVE_STREAM_ERROR = 'timestamp=2026-09-27T11:40:25.237Z level=ERROR run=934d5fa5 message="stream error" '
  + 'providerID=prov modelID=vendor/m-1 session.id=ses_test small=false agent=code mode=primary '
  + 'error.error="AI_APICallError: [Vendor] Rate limit exceeded"';

// Команда списка: печатает свои аргументы, по одному на строку.
const LIST_SCRIPT = `process.stdout.write(process.argv.slice(2).join('\\n') + '\\n');\n`;

// Участник: поведение по модели (аргумент после --model). m-1 — строка 429 в stderr и
// ожидание (сам выходит через 30 с, если его не сняли); m-3 — строка, которую ловит
// только classify, и выход 1; прочие — RESULT passed. pid — в файл <каталог pid>/<модель>.
const MEMBER_AGENT = (pidDir, liveLine) => `
const fs = require('fs');
const path = require('path');
const model = process.argv[process.argv.indexOf('--model') + 1];
fs.writeFileSync(path.join(${JSON.stringify(pidDir)}, model.replace(/[^A-Za-z0-9.-]/g, '_')), String(process.pid));
if (model.endsWith('/m-1')) {
  process.stderr.write(${JSON.stringify(liveLine)} + '\\n');
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(1), 30000);
} else if (model.endsWith('/m-3')) {
  process.stderr.write('vendor overloaded marker\\n');
  process.exit(1);
} else {
  process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');
}
`;

function makeTemp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pools-rules-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const tools = path.join(base, 'tools');
  const pids = path.join(base, 'pids');
  for (const dir of [root, tools, pids]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.workflow', 'config', 'agent-health-rules.yaml'), RULES_YAML);
  const listScript = path.join(tools, 'list-models.cjs');
  const memberAgent = path.join(tools, 'member-agent.cjs');
  fs.writeFileSync(listScript, LIST_SCRIPT);
  fs.writeFileSync(memberAgent, MEMBER_AGENT(pids, LIVE_STREAM_ERROR));
  return { root, pids, listScript, memberAgent };
}

const pidFile = (env, model) => {
  const file = path.join(env.pids, model.replace(/[^A-Za-z0-9.-]/g, '_'));
  PID_FILES.push(file);
  return file;
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

function readHealth(root) {
  const file = path.join(root, '.workflow', 'state', 'agent-health.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).agents : {};
}

async function runPoolStage(env, models) {
  const logger = captureLogger();
  const config = {
    pipeline: {
      name: 'model-pools-rules', version: '1.0',
      agents: {
        'pool-a': {
          command: 'node',
          args: [env.memberAgent, '--model', '{model}'],
          capabilities: ['text'],
          models: { list: ['node', env.listScript, ...models], match: ['^prov/vendor/'] },
        },
      },
      execution: { artifact_snapshot_enabled: true, timeout_per_stage: 8 },
      stages: {}, entry: 'none', context: {},
    },
  };
  await expandModelPools(config.pipeline, { projectRoot: env.root, logger });
  const executor = new StageExecutor(config, { ticket_id: 'IMPL-1' }, {}, {}, null, logger, env.root);
  const started = Date.now();
  const result = await executor.executeWithFallback('execute-task', {
    agents: ['pool-a'], instructions: 'Выполни тикет', skill: 'execute-task',
  });
  return { result, logger, elapsed: Date.now() - started, events: readRunEvents(env.root).filter((e) => e.type === 'run') };
}

// ---------------------------------------------------------------------------

describe('правила health участника пула', () => {
  test('ограничение провайдера — онлайн-снятие участника по правилу пула; помечен участник, не пул и не сосед', async () => {
    const env = makeTemp();
    const m1Pid = pidFile(env, 'prov/vendor/m-1');

    const { result, logger, elapsed, events } = await runPoolStage(env, ['prov/vendor/m-1', 'prov/vendor/m-2']);

    assert.equal(result.status, 'passed', logger.lines.join('\n'));
    assert.ok(
      logger.lines.includes('ERROR Fatal stderr pattern matched for pool-a@prov/vendor/m-1 (rule=stream-rate-limit, class=unavailable). Killing process.'),
      logger.lines.join('\n'),
    );
    assert.ok(elapsed < 7000, `снят онлайн, а не по таймауту стадии: ${elapsed} мс`);
    assert.deepEqual(events.map((e) => e.agent), ['pool-a@prov/vendor/m-1', 'pool-a@prov/vendor/m-2']);

    const health = readHealth(env.root);
    assert.equal(health['pool-a@prov/vendor/m-1']?.rule_id, 'stream-rate-limit', JSON.stringify(health));
    assert.equal(health['pool-a@prov/vendor/m-1']?.class, 'unavailable');
    assert.equal(isHealthy(env.root, 'pool-a@prov/vendor/m-1'), false);
    assert.equal(health['pool-a'], undefined, 'запись пула не помечена');
    assert.equal(isHealthy(env.root, 'pool-a'), true);
    assert.equal(health['pool-a@prov/vendor/m-2'], undefined, 'соседний участник здоров');
    assert.equal(isHealthy(env.root, 'pool-a@prov/vendor/m-2'), true);

    // Процесс снятого участника не пережил снятие.
    const pid = Number(fs.readFileSync(m1Pid, 'utf8'));
    let alive = processAlive(pid);
    for (let i = 0; alive && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      alive = processAlive(pid);
    }
    assert.equal(alive, false, `процесс участника ${pid} снят`);
  });

  test('сбой, опознанный правилом пула после выхода, — пометка участника и TTL правила в crash_ttl_ms', async () => {
    const env = makeTemp();
    pidFile(env, 'prov/vendor/m-3');

    const { result, logger, events } = await runPoolStage(env, ['prov/vendor/m-3', 'prov/vendor/m-2']);

    assert.equal(result.status, 'passed', logger.lines.join('\n'));
    assert.ok(
      logger.lines.includes('INFO agent pool-a@prov/vendor/m-3 marked unhealthy: class=transient, excluded (fallback triggered)'),
      logger.lines.join('\n'),
    );
    assert.ok(!logger.lines.some((l) => l.includes('Fatal stderr pattern matched')), 'класс transient онлайн не снимает');
    const health = readHealth(env.root);
    assert.equal(health['pool-a@prov/vendor/m-3']?.rule_id, 'vendor-overloaded-marker', JSON.stringify(health));
    assert.equal(health['pool-a'], undefined);
    assert.equal(health['pool-a@prov/vendor/m-2'], undefined);

    const failed = events.find((e) => e.agent === 'pool-a@prov/vendor/m-3');
    assert.ok(failed, JSON.stringify(events));
    assert.equal(failed.crash_ttl_ms, 5 * 60 * 1000, 'срок временного запрета — TTL правила пула');
  });
});

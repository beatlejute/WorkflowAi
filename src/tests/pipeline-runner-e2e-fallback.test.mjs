#!/usr/bin/env node
/**
 * E2E-тест fallback-логики на ЖИВОМ runner'е (QA-24 rerun).
 *
 * Отличие от pipeline-runner-fallback.test.mjs: callAgent НЕ мокируется.
 * Реальный spawn() вызывает stub-скрипты из fixtures/manual-qa-fallback/stubs/,
 * которые имитируют quota-ошибку qwen, network-ошибку, ошибку с записью артефакта.
 *
 * Запуск: node --test src/tests/pipeline-runner-e2e-fallback.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { StageExecutor } from '../runner.mjs';
import { isHealthy } from '../lib/agent-health-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUBS_DIR = path.join(__dirname, 'fixtures', 'manual-qa-fallback', 'stubs');
const STUB_QUOTA = path.join(STUBS_DIR, 'qwen-stub.mjs');
const STUB_WRITES = path.join(STUBS_DIR, 'qwen-stub-writes.mjs');
const STUB_PERMISSION_REJECT = path.join(STUBS_DIR, 'kilo-permission-reject-stub.mjs');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-e2e-fallback-'));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Stub, успешно возвращающий ---RESULT--- блок. Параметризован путем файла,
 * куда писать маркер — чтобы тест мог проверить, что agent реально вызван.
 */
function writeSuccessStub(projectRoot, marker) {
  const stubPath = path.join(projectRoot, 'success-stub.mjs');
  fs.writeFileSync(stubPath, `#!/usr/bin/env node
import fs from 'fs';
fs.writeFileSync(${JSON.stringify(marker)}, 'called');
process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');
process.exit(0);
`);
  return stubPath;
}

const BASE_RULES_YAML = `version: "1.0"
common:
  - id: "net-econnreset"
    class: "transient"
    ttl: "5m"
    pattern: "ECONNRESET|ETIMEDOUT|connection reset by peer"
    exit_codes: "any"
agents:
  qwen-code:
    rules:
      - id: "qwen-quota"
        class: "unavailable"
        ttl: "until_utc_midnight"
        pattern: "Qwen OAuth quota exceeded"
        exit_codes: "any"
`;

function createRulesFile(projectRoot) {
  const dir = path.join(projectRoot, '.workflow', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-health-rules.yaml'), BASE_RULES_YAML, 'utf-8');
}

function makeConfig(agents) {
  return {
    pipeline: {
      name: 'e2e-fallback',
      version: '1.0',
      agents,
      execution: {
        artifact_snapshot_enabled: true,
        snapshot_paths: ['.workflow/tickets'],
        timeout_per_stage: 30,
      },
      stages: {},
      entry: 'none',
      context: {},
    },
  };
}

function makeExecutor(config, projectRoot) {
  return new StageExecutor(config, {}, {}, {}, null, null, projectRoot);
}

// ============================================================================
// QA-24 Позитивный сценарий: quota-ошибка qwen → fallback на success-stub,
// qwen помечен unhealthy в реестре.
// ============================================================================
test('QA-24-E2E-001: qwen quota → in-stage fallback на следующего агента (живой spawn)', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const marker = path.join(projectRoot, 'success-called.txt');
    const successStub = writeSuccessStub(projectRoot, marker);

    const config = makeConfig({
      'qwen-code': { command: 'node', args: [STUB_QUOTA], capabilities: ['text'] },
      'claude-sonnet': { command: 'node', args: [successStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    const stage = { agents: ['qwen-code', 'claude-sonnet'], instructions: 'Test', skill: 'test-skill' };

    const result = await executor.executeWithFallback('execute-task', stage);

    assert.strictEqual(result.status, 'passed', 'Итог — passed через second agent');
    assert.ok(fs.existsSync(marker), 'success-stub реально вызван (marker file создан)');
    assert.strictEqual(isHealthy(projectRoot, 'qwen-code'), false, 'qwen-code unhealthy в реестре');

    const healthPath = path.join(projectRoot, '.workflow', 'state', 'agent-health.json');
    assert.ok(fs.existsSync(healthPath), '.workflow/state/agent-health.json создан');
    const health = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
    assert.strictEqual(health.agents['qwen-code'].class, 'unavailable', 'class=unavailable');
    assert.strictEqual(health.agents['qwen-code'].rule_id, 'qwen-quota', 'rule_id=qwen-quota');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// QA-24 Контрольный сценарий: артефакт создан → fallback заблокирован.
// ============================================================================
// ============================================================================
// INC-2026-04-22: kilo auto-rejected permissions (exit=0, пустой RESULT) →
// runner должен мапить это в ошибку и fallback-ить на следующего агента.
// Без маппинга stage create-report/analyze-report тихо завершается status=default
// и pipeline «успешно завершается» без создания отчёта.
// ============================================================================
test('INC-2026-04-22-E2E: kilo auto-rejected permissions → fallback на следующего агента', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const marker = path.join(projectRoot, 'success-called.txt');
    const successStub = writeSuccessStub(projectRoot, marker);

    const config = makeConfig({
      'kilo-glm': { command: 'node', args: [STUB_PERMISSION_REJECT], capabilities: ['text'] },
      'claude-sonnet': { command: 'node', args: [successStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    const stage = { agents: ['kilo-glm', 'claude-sonnet'], instructions: 'Create report', skill: 'create-report' };

    const result = await executor.executeWithFallback('create-report', stage);

    assert.strictEqual(result.status, 'passed', 'Итог — passed через fallback-агента');
    assert.ok(fs.existsSync(marker), 'claude-sonnet реально вызван после fallback из kilo');
  } finally {
    cleanupDir(projectRoot);
  }
});

test('INC-2026-04-22-E2E: одиночный permission-reject при наличии RESULT не триггерит fallback', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const stubWithResult = path.join(projectRoot, 'kilo-with-result-stub.mjs');
    fs.writeFileSync(stubWithResult, `#!/usr/bin/env node
process.stderr.write('! permission requested: external_directory (/tmp/foo); auto-rejecting\\n');
process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');
process.exit(0);
`);
    const marker = path.join(projectRoot, 'success-called.txt');
    const successStub = writeSuccessStub(projectRoot, marker);

    const config = makeConfig({
      'kilo-glm': { command: 'node', args: [stubWithResult], capabilities: ['text'] },
      'claude-sonnet': { command: 'node', args: [successStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    const stage = { agents: ['kilo-glm', 'claude-sonnet'], instructions: 'Create report', skill: 'create-report' };

    const result = await executor.executeWithFallback('create-report', stage);

    assert.strictEqual(result.status, 'passed', 'Итог — passed от первого агента');
    assert.ok(!fs.existsSync(marker), 'claude-sonnet НЕ вызван — RESULT есть, fallback не нужен');
  } finally {
    cleanupDir(projectRoot);
  }
});

// ============================================================================
// 2026-09-25 PulseProxy, IMPL-107: gpt-luna через kilo выполнил тикет и закончил ответ
// блоком ---RESULT--- без закрывающего маркера; рельсы печатали в stderr узлы скила
// execute-task со словами «permission denied». Раннер решил «нет RESULT» и насчитал
// 7 отказов в правах, которых не было, — успешный запуск ушёл в ошибку.
// ============================================================================
const RAILS_ECHO_STDERR = [
  'RAILS: числится P2R2 «П2 ПРАВИЛО: Permission-гейт — если при чтении context.files получена ошибка permission denied»',
  'RAILS: числится P2G1 «П2 ГЕЙТ: Все обязательные файлы контекста прочитаны без permission denied?»',
].join('\n');

function writeStub(projectRoot, name, { stdout, stderr }) {
  const stubPath = path.join(projectRoot, name);
  fs.writeFileSync(stubPath, `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(stderr)});
process.stdout.write(${JSON.stringify(stdout)});
process.exit(0);
`);
  return stubPath;
}

async function runWithFallback(projectRoot, firstStub) {
  createRulesFile(projectRoot);
  const marker = path.join(projectRoot, 'success-called.txt');
  const successStub = writeSuccessStub(projectRoot, marker);
  const config = makeConfig({
    'kilo-agent': { command: 'node', args: [firstStub], capabilities: ['text'] },
    'claude-sonnet': { command: 'node', args: [successStub], capabilities: ['text'] },
  });
  const executor = makeExecutor(config, projectRoot);
  const stage = { agents: ['kilo-agent', 'claude-sonnet'], instructions: 'Execute', skill: 'execute-task' };
  const result = await executor.executeWithFallback('execute-task', stage);
  return { result, fallbackCalled: fs.existsSync(marker) };
}

test('незакрытый блок RESULT со status — результат агента, fallback не нужен', async () => {
  const projectRoot = makeTmpDir();
  try {
    const stub = writeStub(projectRoot, 'unclosed-result-stub.mjs', {
      stdout: 'выполнено: guard popup разрешает pool-пресет\n---RESULT---\nstatus: default\n',
      stderr: RAILS_ECHO_STDERR,
    });
    const { result, fallbackCalled } = await runWithFallback(projectRoot, stub);
    assert.strictEqual(result.parsed, true, 'блок распознан');
    assert.strictEqual(result.status, 'default');
    assert.ok(!fallbackCalled, 'второй агент не вызван');
  } finally {
    cleanupDir(projectRoot);
  }
});

test('незакрытый блок после закрытой пары берётся; одиночный маркер эха перед парой — нет', async () => {
  const projectRoot = makeTmpDir();
  try {
    const stub = writeStub(projectRoot, 'pair-then-unclosed-stub.mjs', {
      stdout: 'эхо тикета:\n---RESULT---\nstatus: failed\n---RESULT---\nитог\n---RESULT---\nstatus: blocked\nreason: нет доступа\n',
      stderr: '',
    });
    const { result } = await runWithFallback(projectRoot, stub);
    assert.strictEqual(result.status, 'blocked', 'взят последний, незакрытый блок');
    assert.strictEqual(result.result.reason, 'нет доступа');
  } finally {
    cleanupDir(projectRoot);
  }
  const root2 = makeTmpDir();
  try {
    const stub = writeStub(root2, 'stray-marker-stub.mjs', {
      stdout: 'эхо заголовка тикета:\n---RESULT---\nитог\n---RESULT---\nstatus: passed\n---RESULT---\n',
      stderr: '',
    });
    const { result } = await runWithFallback(root2, stub);
    // Хвост после последнего маркера пуст — прежнее правило «последняя пара».
    assert.strictEqual(result.status, 'passed');
  } finally {
    cleanupDir(root2);
  }
});

test('«permission denied» из текста скила без RESULT — не отказ в правах, fallback не нужен', async () => {
  const projectRoot = makeTmpDir();
  try {
    const stub = writeStub(projectRoot, 'rails-echo-no-result-stub.mjs', {
      stdout: 'Секция Result уже заполнена. Иду к финальной проверке.\n',
      stderr: RAILS_ECHO_STDERR,
    });
    const { result, fallbackCalled } = await runWithFallback(projectRoot, stub);
    assert.strictEqual(result.parsed, false);
    assert.ok(!fallbackCalled, 'настоящих отказов kilo нет — silent-failure не срабатывает');
  } finally {
    cleanupDir(projectRoot);
  }
});

test('отказ в правах субагенту kilo 7.7.9 без RESULT — silent-failure и fallback', async () => {
  const projectRoot = makeTmpDir();
  try {
    const stub = writeStub(projectRoot, 'subagent-reject-stub.mjs', {
      stdout: 'Starting work...\n',
      stderr: '! subagent permission requested: external_directory (D:\\Dev\\other\\*); auto-rejecting\n',
    });
    const { result, fallbackCalled } = await runWithFallback(projectRoot, stub);
    assert.strictEqual(result.status, 'passed', 'итог от второго агента');
    assert.ok(fallbackCalled);
  } finally {
    cleanupDir(projectRoot);
  }
});

test('QA-24-E2E-002: qwen записал артефакт + упал → fallback заблокирован, re-throw', async () => {
  const projectRoot = makeTmpDir();
  try {
    createRulesFile(projectRoot);
    const marker = path.join(projectRoot, 'success-called.txt');
    const successStub = writeSuccessStub(projectRoot, marker);

    const config = makeConfig({
      'qwen-code': { command: 'node', args: [STUB_WRITES], workdir: projectRoot, capabilities: ['text'] },
      'claude-sonnet': { command: 'node', args: [successStub], capabilities: ['text'] },
    });
    const executor = makeExecutor(config, projectRoot);
    const stage = { agents: ['qwen-code', 'claude-sonnet'], instructions: 'Test', skill: 'test-skill' };

    await assert.rejects(
      () => executor.executeWithFallback('decompose-plan', stage),
      (err) => err.exitCode !== undefined,
      'При непустом artifact diff должен re-throw',
    );

    assert.ok(!fs.existsSync(marker), 'claude-sonnet НЕ должен быть вызван (fallback blocked)');
    const feat = path.join(projectRoot, '.workflow', 'tickets', 'backlog', 'FEAT-TEST.md');
    assert.ok(fs.existsSync(feat), 'Артефакт qwen остался на диске (runner не откатывает)');
  } finally {
    cleanupDir(projectRoot);
  }
});

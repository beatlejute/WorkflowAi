#!/usr/bin/env node

/**
 * Юнит-тесты для run-skill-tests.js runner
 *
 * Покрывают: discovery кейсов из index.yaml, L0 static assertions (pass/fail/regex),
 * L1 deterministic assertions (все 3 вида), short-circuit, фильтрацию (--case/--tag/--layer),
 * формат output (---RESULT--- YAML), запись current/meta.json, отсутствие git write-операций.
 *
 * Стратегия: тесты запускают runner как subprocess с временными skill-fixtures
 * внутри проекта, чтобы избежать модификации исходника и не требовать реального LLM.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { join, dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../..');
const RUNNER_PATH = join(PROJECT_ROOT, 'src', 'scripts', 'run-skill-tests.js');
const SKILLS_DIR = join(PROJECT_ROOT, 'src', 'skills');
const TEST_PIPELINE_PATH = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'test-pipeline.yaml');

// Уникальное имя временного скила для изоляции от боевых данных
const TEST_SKILL = `__test-runner-${Date.now()}`;
const SKILL_DIR = join(SKILLS_DIR, TEST_SKILL);
const TESTS_DIR = join(SKILL_DIR, 'tests');

// ============================================================================
// Helpers
// ============================================================================

function runRunner(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [RUNNER_PATH, ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Генерирует YAML-содержимое тест-кейса с L0/L1 assertions.
 */
function buildCaseYaml(staticAssertions = [], deterministicAssertions = []) {
  const lines = ['assertions:'];

  lines.push('  static:');
  if (staticAssertions.length === 0) {
    lines.push('    []');
  } else {
    for (const a of staticAssertions) {
      lines.push(`    - kind: ${a.kind}`);
      if (a.file) lines.push(`      file: ${a.file}`);
      lines.push(`      pattern: '${a.pattern}'`);
      if (a.reason) lines.push(`      reason: '${a.reason}'`);
    }
  }

  lines.push('  deterministic:');
  if (deterministicAssertions.length === 0) {
    lines.push('    []');
  } else {
    for (const a of deterministicAssertions) {
      lines.push(`    - kind: ${a.kind}`);
      if (a.values) {
        lines.push('      values:');
        for (const v of a.values) lines.push(`        - "${v}"`);
      }
      if (a.regex) lines.push(`      regex: "${a.regex}"`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Setup / Teardown
// ============================================================================

before(() => {
  mkdirSync(TESTS_DIR, { recursive: true });

  // SKILL.md содержит "SIGNATURE_PRESENT" для L0 pass-тестов
  writeFileSync(join(SKILL_DIR, 'SKILL.md'), [
    '# Test Skill',
    '',
    'SIGNATURE_PRESENT',
    'SomeOtherContent',
    'version: 1.0',
  ].join('\n'));

  // TC-001: L0 PASS — pattern найден
  writeFileSync(join(TESTS_DIR, 'tc-001-l0-pass.yaml'),
    buildCaseYaml([{ kind: 'skill_contains', pattern: 'SIGNATURE_PRESENT', reason: 'Must be present' }])
  );

  // TC-002: L0 FAIL — pattern не найден
  writeFileSync(join(TESTS_DIR, 'tc-002-l0-fail.yaml'),
    buildCaseYaml([{ kind: 'skill_contains', pattern: 'SIGNATURE_MISSING', reason: 'Should fail' }])
  );

  // TC-003: L0 PASS — regex-паттерн
  writeFileSync(join(TESTS_DIR, 'tc-003-l0-regex.yaml'),
    buildCaseYaml([{ kind: 'skill_contains', pattern: 'SIGNATURE_\\w+', reason: 'Regex should match' }])
  );

  // TC-004: L1 output_does_not_contain — PASS на пустом mock output
  writeFileSync(join(TESTS_DIR, 'tc-004-l1-not-contain.yaml'),
    buildCaseYaml([], [{ kind: 'output_does_not_contain', values: ['git add', 'git commit'] }])
  );

  // TC-005: L1 output_contains_all — FAIL на пустом mock output (ничего нет в пустой строке)
  writeFileSync(join(TESTS_DIR, 'tc-005-l1-contains-all.yaml'),
    buildCaseYaml([], [{ kind: 'output_contains_all', values: ['required-string'] }])
  );

  // TC-006: L1 output_matches — FAIL на пустом mock output (regex не совпадает)
  writeFileSync(join(TESTS_DIR, 'tc-006-l1-matches.yaml'),
    buildCaseYaml([], [{ kind: 'output_matches', regex: 'status: passed' }])
  );

  // TC-007: Short-circuit — L0 FAIL + L1 assertions (L1 не должна запускаться)
  writeFileSync(join(TESTS_DIR, 'tc-007-short-circuit.yaml'),
    buildCaseYaml(
      [{ kind: 'skill_contains', pattern: 'PATTERN_NOT_FOUND' }],
      [{ kind: 'output_does_not_contain', values: ['should-not-matter'] }]
    )
  );

  // index.yaml: все тест-кейсы
  const indexYaml = [
    'cases:',
    '  - id: TC-001',
    '    file: tc-001-l0-pass.yaml',
    '    tags: [smoke]',
    '  - id: TC-002',
    '    file: tc-002-l0-fail.yaml',
    '    tags: [regression]',
    '  - id: TC-003',
    '    file: tc-003-l0-regex.yaml',
    '    tags: [smoke]',
    '  - id: TC-004',
    '    file: tc-004-l1-not-contain.yaml',
    '    tags: [smoke]',
    '  - id: TC-005',
    '    file: tc-005-l1-contains-all.yaml',
    '    tags: [regression]',
    '  - id: TC-006',
    '    file: tc-006-l1-matches.yaml',
    '    tags: [regression]',
    '  - id: TC-007',
    '    file: tc-007-short-circuit.yaml',
    '    tags: [smoke]',
  ].join('\n');

  writeFileSync(join(TESTS_DIR, 'index.yaml'), indexYaml);
});

after(() => {
  if (existsSync(SKILL_DIR)) {
    rmSync(SKILL_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// Discovery — кейсы из index.yaml
// ============================================================================

describe('Discovery — кейсы из index.yaml', () => {
  it('--skill запускает все кейсы из index.yaml', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--layer', 'static']);

    assert.match(stdout, /total: 7/, 'должно быть 7 кейсов');
  });

  it('--case TC-001 фильтрует один кейс', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    assert.match(stdout, /total: 1/, 'должен быть только 1 кейс');
    assert.match(stdout, /status: passed/, 'кейс TC-001 должен пройти');
  });

  it('--tag smoke запускает только кейсы с тегом smoke', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--tag', 'smoke', '--layer', 'static']);

    // Smoke: TC-001, TC-003, TC-004, TC-007 = 4 кейса
    assert.match(stdout, /total: 4/, 'должно быть 4 smoke-кейса');
  });

  it('--layer static запускает только L0 (L1 не запускается)', async () => {
    // TC-005: нет L0 assertions, есть L1 output_contains_all (FAIL если бы запустилась)
    // С --layer static L1 пропускается → кейс считается passed
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-005', '--layer', 'static']);

    assert.match(stdout, /status: passed/, 'с --layer static L1 не запускается, кейс должен пройти');
  });

  it('--layer deterministic запускает L0 и L1', async () => {
    // TC-001: L0 PASS, нет L1 assertions → passed
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'deterministic', '--skip-secret-scan']);

    assert.match(stdout, /status: passed/, 'TC-001 должен пройти с --layer deterministic');
  });
});

// ============================================================================
// L0 Static assertions
// ============================================================================

describe('L0 Static assertions', () => {
  it('skill_contains → PASS когда pattern найден в SKILL.md', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    assert.match(stdout, /status: passed/);
    assert.match(stdout, /current_run.passed: 1/);
    assert.match(stdout, /current_run.failed: 0/);
  });

  it('skill_contains → FAIL когда pattern не найден в SKILL.md', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-002', '--layer', 'static']);

    assert.match(stdout, /status: failed/);
    assert.match(stdout, /current_run.failed: 1/);
  });

  it('regex-паттерн работает корректно — PASS когда совпадение найдено', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-003', '--layer', 'static']);

    assert.match(stdout, /status: passed/);
    assert.match(stdout, /current_run.passed: 1/);
  });
});

// ============================================================================
// L1 Deterministic assertions
// ============================================================================

describe('L1 Deterministic assertions', () => {
  it('output_does_not_contain → PASS (запрещённые строки отсутствуют в mock output)', async () => {
    const { stdout } = await runRunner([
      '--skill', TEST_SKILL, '--case', 'TC-004',
      '--layer', 'deterministic', '--skip-secret-scan'
    ]);

    assert.match(stdout, /status: passed/);
    assert.match(stdout, /current_run.passed: 1/);
  });

  it('output_contains_all → FAIL (требуемые строки отсутствуют в пустом mock output)', async () => {
    const { stdout } = await runRunner([
      '--skill', TEST_SKILL, '--case', 'TC-005',
      '--layer', 'deterministic', '--skip-secret-scan'
    ]);

    assert.match(stdout, /status: failed/);
    assert.match(stdout, /current_run.failed: 1/);
  });

  it('output_matches → FAIL (regex не совпадает с пустым mock output)', async () => {
    const { stdout } = await runRunner([
      '--skill', TEST_SKILL, '--case', 'TC-006',
      '--layer', 'deterministic', '--skip-secret-scan'
    ]);

    assert.match(stdout, /status: failed/);
    assert.match(stdout, /current_run.failed: 1/);
  });
});

// ============================================================================
// Short-circuit: FAIL L0 → L1 не запускается
// ============================================================================

describe('Short-circuit', () => {
  it('провал L0 → кейс помечается failed без запуска L1', async () => {
    // TC-007: L0 FAIL + L1 output_does_not_contain (которая прошла бы если бы запустилась)
    // Если short-circuit работает: failed=1, passed=0
    // Если short-circuit НЕ работает: L1 запустится и пройдёт → passed=1
    const { stdout } = await runRunner([
      '--skill', TEST_SKILL, '--case', 'TC-007',
      '--layer', 'deterministic', '--skip-secret-scan'
    ]);

    assert.match(stdout, /status: failed/);
    assert.match(stdout, /current_run.failed: 1/);
    assert.match(stdout, /current_run.passed: 0/, 'L1 не должна была запуститься (passed должен быть 0)');
  });
});

// ============================================================================
// Формат output: валидный ---RESULT--- YAML
// ============================================================================

describe('Формат output', () => {
  it('вывод содержит маркеры ---RESULT---', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    assert.ok(stdout.includes('---RESULT---'), 'вывод должен содержать ---RESULT--- маркеры');
  });

  it('вывод содержит обязательные поля status, skill, mode, total', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    assert.match(stdout, /status:/, 'должно быть поле status');
    assert.match(stdout, /skill:/, 'должно быть поле skill');
    assert.match(stdout, /mode:/, 'должно быть поле mode');
    assert.match(stdout, /total:/, 'должно быть поле total');
  });

  it('поле skill содержит имя запущенного скила', async () => {
    const { stdout } = await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    assert.ok(stdout.includes(`skill: ${TEST_SKILL}`), `output должен содержать "skill: ${TEST_SKILL}"`);
  });
});

// ============================================================================
// Запись current/meta.json
// ============================================================================

describe('Запись meta.json', () => {
  it('meta.json создаётся после прогона кейса', async () => {
    await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    const metaPath = join(SKILL_DIR, 'tests', 'cases', 'TC-001', 'current', 'meta.json');
    assert.ok(existsSync(metaPath), `meta.json должен существовать: ${metaPath}`);
  });

  it('meta.json содержит поля date, skill_sha, status, duration_ms', async () => {
    await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    const metaPath = join(SKILL_DIR, 'tests', 'cases', 'TC-001', 'current', 'meta.json');
    assert.ok(existsSync(metaPath), 'meta.json должен существовать');

    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.ok('date' in meta, 'meta.json должен содержать поле date');
    assert.ok('skill_sha' in meta, 'meta.json должен содержать поле skill_sha');
    assert.ok('status' in meta, 'meta.json должен содержать поле status');
    assert.ok('duration_ms' in meta, 'meta.json должен содержать поле duration_ms');
  });

  it('meta.json содержит status "failed" после провального кейса', async () => {
    await runRunner(['--skill', TEST_SKILL, '--case', 'TC-002', '--layer', 'static']);

    const metaPath = join(SKILL_DIR, 'tests', 'cases', 'TC-002', 'current', 'meta.json');
    assert.ok(existsSync(metaPath), 'meta.json должен существовать для failed кейса');

    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.strictEqual(meta.status, 'failed', 'status в meta.json должен быть "failed"');
  });

  it('meta.json содержит status "passed" после успешного кейса', async () => {
    await runRunner(['--skill', TEST_SKILL, '--case', 'TC-001', '--layer', 'static']);

    const metaPath = join(SKILL_DIR, 'tests', 'cases', 'TC-001', 'current', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.strictEqual(meta.status, 'passed', 'status в meta.json должен быть "passed"');
  });
});

// ============================================================================
// L2 Rubric Layer — Trials Matrix, Majority Aggregation, AND-logic
//
// Используют mock-агенты через test-pipeline.yaml:
//   agent-a   → mock-agent-pass.js (MOCK_HIGH_SCORE → judge вернёт score: 5 → pass)
//   agent-b   → mock-agent-fail.js (MOCK_LOW_SCORE  → judge вернёт score: 2 → fail)
//   mock-judge → детерминированный по маркерам в промпте
// ============================================================================

describe('L2 Rubric Layer — Trials & Aggregation', () => {
  const TEST_SKILL_L2 = `__test-l2-${Date.now()}`;
  const SKILL_DIR_L2 = join(SKILLS_DIR, TEST_SKILL_L2);
  const TESTS_DIR_L2 = join(SKILL_DIR_L2, 'tests');

  // agent-a (pass) и agent-b (fail) определены в test-pipeline.yaml
  const AGENT_A = 'agent-a';
  const AGENT_B = 'agent-b';

  const RUBRIC_L2 = [
    '# L2 Rubric',
    '',
    'Score the response quality. A score of 4 or higher means pass.',
    'Score ≥ 4: pass',
    'Score < 4: fail',
  ].join('\n');

  function buildL2CaseYaml(options = {}) {
    const {
      rubric = 'l2-rubric',
      severity = 'normal',
      aggregate = 'auto',
      prompt = 'Test prompt',
      description = 'Test L2 case'
    } = options;

    const lines = [
      `description: "${description}"`,
      `prompt: "${prompt}"`,
      `severity: ${severity}`,
      `assertions:`,
      `  rubric:`,
      `    - rubric_file: rubrics/${rubric}.md`,
      `  static: []`,
      `  deterministic: []`
    ];

    if (aggregate !== 'auto') {
      lines.push(`aggregate: ${aggregate}`);
    }

    return lines.join('\n');
  }

  before(async () => {
    mkdirSync(TESTS_DIR_L2, { recursive: true });
    mkdirSync(join(SKILL_DIR_L2, 'tests', 'rubrics'), { recursive: true });

    writeFileSync(join(SKILL_DIR_L2, 'SKILL.md'), '# L2 Test Skill\nversion: 1.0\n');
    writeFileSync(join(SKILL_DIR_L2, 'tests', 'rubrics', 'l2-rubric.md'), RUBRIC_L2);
  });

  after(() => {
    if (existsSync(SKILL_DIR_L2)) {
      rmSync(SKILL_DIR_L2, { recursive: true, force: true });
    }
  });

  function createIndexYaml(agents, judge, cases) {
    const casesYaml = cases.map(c => `  - id: ${c.id}\n    file: ${c.file}\n    tags: [${c.tags || 'l2'}]`).join('\n');
    return [
      'cases:',
      casesYaml,
      'execution:',
      `  target_agents: [${agents.join(', ')}]`,
      `  judge_agent: ${judge}`
    ].join('\n');
  }

  // TC-L2-001: agent-a (pass) → 1/1 trial pass → majority pass
  it('TC-L2-001: majority aggregation — pass agent → model pass', async () => {
    const caseId = 'TC-L2-001';
    const caseFile = `${caseId}.yaml`;
    writeFileSync(join(TESTS_DIR_L2, caseFile), buildL2CaseYaml({
      description: 'Majority pass scenario',
      prompt: 'Majority test prompt'
    }));

    const indexYaml = createIndexYaml([AGENT_A], 'mock-judge', [{ id: caseId, file: caseFile }]);
    writeFileSync(join(TESTS_DIR_L2, 'index.yaml'), indexYaml);

    const { stdout } = await runRunner([
      '--skill', TEST_SKILL_L2, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    assert.match(stdout, /total: 1/, 'должен быть 1 кейс');
    assert.match(stdout, /status: passed/, 'agent-a pass → модель должна пройти');
  });

  // TC-L2-002: agent-b (fail) → 0/1 trial pass → majority fail
  it('TC-L2-002: majority aggregation — fail agent → model fail', async () => {
    const caseId = 'TC-L2-002';
    const caseFile = `${caseId}.yaml`;
    writeFileSync(join(TESTS_DIR_L2, caseFile), buildL2CaseYaml({
      description: 'Majority fail scenario',
      prompt: 'Fail majority test prompt'
    }));

    const indexYaml = createIndexYaml([AGENT_B], 'mock-judge', [{ id: caseId, file: caseFile }]);
    writeFileSync(join(TESTS_DIR_L2, 'index.yaml'), indexYaml);

    const { stdout } = await runRunner([
      '--skill', TEST_SKILL_L2, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    assert.match(stdout, /status: failed/, 'agent-b fail → модель должна провалиться');
  });

  // TC-L2-003: severity=critical + no aggregate → all must pass
  // agent-a (pass) → 1/1 pass → критерий all выполнен → case pass
  it('TC-L2-003: severity critical + no aggregate → all must pass', async () => {
    const caseId = 'TC-L2-003';
    const caseFile = `${caseId}.yaml`;
    writeFileSync(join(TESTS_DIR_L2, caseFile), buildL2CaseYaml({
      description: 'Critical severity — all must pass',
      severity: 'critical',
      aggregate: 'auto',
      prompt: 'Critical test prompt'
    }));

    const indexYaml = createIndexYaml([AGENT_A], 'mock-judge', [{ id: caseId, file: caseFile }]);
    writeFileSync(join(TESTS_DIR_L2, 'index.yaml'), indexYaml);

    const { stdout } = await runRunner([
      '--skill', TEST_SKILL_L2, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    assert.match(stdout, /total: 1/, 'должен быть 1 кейс');
    assert.match(stdout, /status: passed/, 'severity critical + все trials pass → case pass');
  });

  // TC-L2-003b: severity=critical, fail agent → 1 fail → весь кейс fail
  it('TC-L2-003b: severity critical + 1 fail → test fail', async () => {
    const caseId = 'TC-L2-003b';
    const caseFile = `${caseId}.yaml`;
    writeFileSync(join(TESTS_DIR_L2, caseFile), buildL2CaseYaml({
      description: 'Critical severity — one fail makes case fail',
      severity: 'critical',
      aggregate: 'auto',
      prompt: 'Critical fail test prompt'
    }));

    const indexYaml = createIndexYaml([AGENT_B], 'mock-judge', [{ id: caseId, file: caseFile }]);
    writeFileSync(join(TESTS_DIR_L2, 'index.yaml'), indexYaml);

    const { stdout } = await runRunner([
      '--skill', TEST_SKILL_L2, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    assert.match(stdout, /status: failed/, 'severity critical + 1 fail → кейс должен провалиться');
  });

  // TC-L2-004: обе модели pass → AND pass
  it('TC-L2-004: AND between models — both pass → test pass', async () => {
    const caseId = 'TC-L2-004';
    const caseFile = `${caseId}.yaml`;
    writeFileSync(join(TESTS_DIR_L2, caseFile), buildL2CaseYaml({
      description: 'AND logic — both pass',
      prompt: 'AND test prompt'
    }));

    // agent-a и agent-a (оба pass)
    const indexYaml = createIndexYaml([AGENT_A, AGENT_A], 'mock-judge', [{ id: caseId, file: caseFile }]);
    writeFileSync(join(TESTS_DIR_L2, 'index.yaml'), indexYaml);

    const { stdout } = await runRunner([
      '--skill', TEST_SKILL_L2, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    assert.match(stdout, /total: 1/, 'должен быть 1 кейс');
    assert.match(stdout, /status: passed/, 'обе модели pass → тест pass (AND)');
  });

  // TC-L2-005: одна модель fail → AND fail
  it('TC-L2-005: AND between models — one fail → test fail', async () => {
    const caseId = 'TC-L2-005';
    const caseFile = `${caseId}.yaml`;
    writeFileSync(join(TESTS_DIR_L2, caseFile), buildL2CaseYaml({
      description: 'AND logic — one model fails',
      prompt: 'AND fail test prompt'
    }));

    // agent-a (pass) + agent-b (fail) → AND = fail
    const indexYaml = createIndexYaml([AGENT_A, AGENT_B], 'mock-judge', [{ id: caseId, file: caseFile }]);
    writeFileSync(join(TESTS_DIR_L2, 'index.yaml'), indexYaml);

    const { stdout } = await runRunner([
      '--skill', TEST_SKILL_L2, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    assert.match(stdout, /status: failed/, 'одна модель fail → тест fail (AND)');
  });
});

// ============================================================================
// Calibration Gate Tests
//
// Каждый тест использует ОТДЕЛЬНУЮ изолированную skill-директорию,
// чтобы findCalibrationFiles() сканировал только нужные файлы.
//
// Сценарии:
//   TC-CAL-001: good score ≥ threshold + bad score < threshold → calibration_passed
//   TC-CAL-002: нет calibration файлов → warn, не abort → calibration_passed
//   TC-CAL-003: good score < threshold → calibration_failed
//   TC-CAL-004: bad score < threshold → calibration_passed (нормальное поведение)
//   TC-CAL-005: bad score ≥ threshold → calibration_failed
//
// Маркеры в calibration-файлах управляют mock-judge score:
//   MOCK_LOW_SCORE        → score 2 (fail)
//   CALIBRATION_GOOD_LOW  → score 2 (judge miscalibrated для good-ответа)
//   CALIBRATION_BAD_HIGH  → score 5 (judge miscalibrated для bad-ответа)
//   без маркера           → score 5 (pass, по умолчанию)
// ============================================================================

describe('Calibration Gate', () => {
  const TS = Date.now();

  const RUBRIC_CONTENT = [
    '# Test Rubric',
    'Score the response.',
    'Score ≥ 4: pass',
    'Score < 4: fail'
  ].join('\n');

  const GOOD_CONTENT_NORMAL = [
    '# Calibration Good Response',
    '',
    '## Ответ агента',
    '',
    'This is a high quality response that deserves a high score.',
    '',
    '---',
  ].join('\n');

  const BAD_CONTENT_NORMAL = [
    '# Calibration Bad Response',
    '',
    '## Ответ агента',
    '',
    'MOCK_LOW_SCORE This is a bad response that should score low.',
    '',
    '---',
  ].join('\n');

  const GOOD_CONTENT_LOW = [
    '# Calibration Good Response (low score marker)',
    '',
    '## Ответ агента',
    '',
    'CALIBRATION_GOOD_LOW This response has a marker making judge give low score.',
    '',
    '---',
  ].join('\n');

  const BAD_CONTENT_HIGH = [
    '# Calibration Bad Response (high score marker)',
    '',
    '## Ответ агента',
    '',
    'CALIBRATION_BAD_HIGH This bad response has a marker making judge give high score.',
    '',
    '---',
  ].join('\n');

  /**
   * Создаёт изолированную skill-директорию с одним rubric и его calibration-файлами.
   * Возвращает { skillName, skillDir, testsDir } для cleanup.
   */
  function makeCalSkill(suffix, goodContent, badContent) {
    const skillName = `__test-cal-${suffix}-${TS}`;
    const skillDir = join(SKILLS_DIR, skillName);
    const testsDir = join(skillDir, 'tests');

    mkdirSync(join(testsDir, 'rubrics', 'calibration'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Calibration Test Skill\nversion: 1.0\n');
    writeFileSync(join(testsDir, 'rubrics', 'cal-rubric.md'), RUBRIC_CONTENT);

    if (goodContent && badContent) {
      writeFileSync(join(testsDir, 'rubrics', 'calibration', 'cal-rubric-good.md'), goodContent);
      writeFileSync(join(testsDir, 'rubrics', 'calibration', 'cal-rubric-bad.md'), badContent);
    }

    const caseFile = 'tc-cal.yaml';
    const caseYaml = [
      'description: "Calibration test"',
      'prompt: "Test prompt"',
      'severity: normal',
      'assertions:',
      '  rubric:',
      '    - rubric_file: rubrics/cal-rubric.md',
      '  static: []',
      '  deterministic: []'
    ].join('\n');

    writeFileSync(join(testsDir, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: TC-CAL`,
      `    file: ${caseFile}`,
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(testsDir, 'index.yaml'), indexYaml);

    return { skillName, skillDir };
  }

  // TC-CAL-001: нормальная калибровка — good ≥ threshold + bad < threshold → pass
  it('TC-CAL-001: calibration gate — good score ≥ threshold, bad score < threshold → pass', async () => {
    const { skillName, skillDir } = makeCalSkill('001', GOOD_CONTENT_NORMAL, BAD_CONTENT_NORMAL);

    try {
      const { stdout } = await runRunner([
        '--skill', skillName, '--calibrate', '--yes',
        '--pipeline', TEST_PIPELINE_PATH
      ]);
      assert.match(stdout, /calibration_passed/, 'нормальная калибровка должна пройти');
    } finally {
      if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
    }
  });

  // TC-CAL-002: нет calibration файлов → warn, не abort → calibration_passed
  it('TC-CAL-002: no calibration files → warn, do not abort', async () => {
    // goodContent=null, badContent=null → calibration/ остаётся пустой
    const { skillName, skillDir } = makeCalSkill('002', null, null);

    try {
      const { stdout } = await runRunner([
        '--skill', skillName, '--calibrate', '--yes',
        '--pipeline', TEST_PIPELINE_PATH
      ]);
      assert.match(stdout, /calibration_passed/, 'без calibration файлов должна warn, не abort → calibration_passed');
    } finally {
      if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
    }
  });

  // TC-CAL-003: good score < threshold → calibration_failed
  it('TC-CAL-003: calibration gate — good score < threshold → calibration_failed', async () => {
    // good-файл содержит CALIBRATION_GOOD_LOW → mock-judge вернёт score 2 < 4 → goodPassed=false
    const { skillName, skillDir } = makeCalSkill('003', GOOD_CONTENT_LOW, BAD_CONTENT_NORMAL);

    try {
      const { stdout } = await runRunner([
        '--skill', skillName, '--calibrate', '--yes',
        '--pipeline', TEST_PIPELINE_PATH
      ]);
      assert.match(stdout, /calibration_failed/, 'good получает score < threshold → calibration_failed');
    } finally {
      if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
    }
  });

  // TC-CAL-004: bad score < threshold → calibration_passed (нормальное поведение)
  it('TC-CAL-004: calibration gate — bad score < threshold → calibration_passed', async () => {
    // Такая же нормальная калибровка как TC-CAL-001: bad имеет MOCK_LOW_SCORE → score 2 < 4 → badPassed=true
    const { skillName, skillDir } = makeCalSkill('004', GOOD_CONTENT_NORMAL, BAD_CONTENT_NORMAL);

    try {
      const { stdout } = await runRunner([
        '--skill', skillName, '--calibrate', '--yes',
        '--pipeline', TEST_PIPELINE_PATH
      ]);
      assert.match(stdout, /calibration_passed/, 'bad правильно получает score < threshold → calibration_passed');
    } finally {
      if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
    }
  });

  // TC-CAL-005: bad score ≥ threshold → calibration_failed
  it('TC-CAL-005: calibration gate — bad score ≥ threshold → calibration_failed', async () => {
    // bad-файл содержит CALIBRATION_BAD_HIGH → mock-judge вернёт score 5 ≥ 4 → badPassed=false
    const { skillName, skillDir } = makeCalSkill('005', GOOD_CONTENT_NORMAL, BAD_CONTENT_HIGH);

    try {
      const { stdout } = await runRunner([
        '--skill', skillName, '--calibrate', '--yes',
        '--pipeline', TEST_PIPELINE_PATH
      ]);
      assert.match(stdout, /calibration_failed/, 'bad получает score ≥ threshold → judge miscalibrated → calibration_failed');
    } finally {
      if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// File Output Tests — current/{agent}/trial-{n}.md, judge.json, meta.json
// ============================================================================

describe('L2 File Output — trial files, judge.json, meta.json', () => {
  const TEST_SKILL_OUT = `__test-output-${Date.now()}`;
  const SKILL_DIR_OUT = join(SKILLS_DIR, TEST_SKILL_OUT);
  const TESTS_DIR_OUT = join(SKILL_DIR_OUT, 'tests');

  before(async () => {
    mkdirSync(TESTS_DIR_OUT, { recursive: true });
    mkdirSync(join(SKILL_DIR_OUT, 'tests', 'rubrics'), { recursive: true });

    writeFileSync(join(SKILL_DIR_OUT, 'SKILL.md'), '# Output Test Skill\nversion: 1.0\n');
    writeFileSync(join(SKILL_DIR_OUT, 'tests', 'rubrics', 'out-rubric.md'), [
      '# Output Rubric',
      'Score ≥ 4: pass',
      'Score < 4: fail'
    ].join('\n'));
  });

  after(() => {
    if (existsSync(SKILL_DIR_OUT)) {
      rmSync(SKILL_DIR_OUT, { recursive: true, force: true });
    }
  });

  it('TC-OUT-001: current/{agent}/trial-{n}.md created for each trial', async () => {
    const caseId = 'TC-OUT-001';
    const caseFile = `${caseId}.yaml`;
    const caseYaml = [
      `description: "Trial file output test"`,
      `prompt: "Output test"`,
      `severity: normal`,
      `assertions:`,
      `  rubric:`,
      `    - rubric_file: rubrics/out-rubric.md`,
      `  static: []`,
      `  deterministic: []`
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: ${caseId}`,
      `    file: ${caseFile}`,
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, 'index.yaml'), indexYaml);

    await runRunner([
      '--skill', TEST_SKILL_OUT, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    const currentDir = join(SKILL_DIR_OUT, 'tests', 'cases', caseId, 'current');
    const agentDir = join(currentDir, 'agent-a');

    const trialFiles = existsSync(agentDir)
      ? readdirSync(agentDir).filter(f => f.startsWith('trial-') && f.endsWith('.md'))
      : [];

    assert.ok(trialFiles.length > 0, `должны быть созданы trial файлы в ${agentDir}, найдено: ${trialFiles.join(', ')}`);
  });

  it('TC-OUT-002: current/judge.json created after run', async () => {
    const caseId = 'TC-OUT-002';
    const caseFile = `${caseId}.yaml`;
    const caseYaml = [
      `description: "Judge.json output test"`,
      `prompt: "Judge json test"`,
      `severity: normal`,
      `assertions:`,
      `  rubric:`,
      `    - rubric_file: rubrics/out-rubric.md`,
      `  static: []`,
      `  deterministic: []`
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: ${caseId}`,
      `    file: ${caseFile}`,
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, 'index.yaml'), indexYaml);

    await runRunner([
      '--skill', TEST_SKILL_OUT, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    const judgeJsonPath = join(SKILL_DIR_OUT, 'tests', 'cases', caseId, 'current', 'judge.json');
    assert.ok(existsSync(judgeJsonPath), `judge.json должен существовать: ${judgeJsonPath}`);

    const judgeData = JSON.parse(readFileSync(judgeJsonPath, 'utf8'));
    assert.ok('per_model' in judgeData, 'judge.json должен содержать per_model');
    assert.ok('rubric_scores' in judgeData, 'judge.json должен содержать rubric_scores');
    assert.ok('timestamp' in judgeData, 'judge.json должен содержать timestamp');
  });

  it('TC-OUT-003: current/meta.json contains per_model and rubric_scores', async () => {
    const caseId = 'TC-OUT-003';
    const caseFile = `${caseId}.yaml`;
    const caseYaml = [
      `description: "Meta.json content test"`,
      `prompt: "Meta json test"`,
      `severity: normal`,
      `assertions:`,
      `  rubric:`,
      `    - rubric_file: rubrics/out-rubric.md`,
      `  static: []`,
      `  deterministic: []`
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: ${caseId}`,
      `    file: ${caseFile}`,
      'execution:',
      '  target_agents: [agent-a, agent-b]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, 'index.yaml'), indexYaml);

    await runRunner([
      '--skill', TEST_SKILL_OUT, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    const metaPath = join(SKILL_DIR_OUT, 'tests', 'cases', caseId, 'current', 'meta.json');
    assert.ok(existsSync(metaPath), `meta.json должен существовать: ${metaPath}`);

    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.ok('per_model' in meta, 'meta.json должен содержать per_model');
    assert.ok('rubric_scores' in meta, 'meta.json должен содержать rubric_scores');
  });

  it('TC-OUT-004: current/ overwritten on re-run (full rewrite)', async () => {
    const caseId = 'TC-OUT-004';
    const caseFile = `${caseId}.yaml`;
    const caseYaml = [
      `description: "Overwrite test"`,
      `prompt: "Overwrite test prompt"`,
      `severity: normal`,
      `assertions:`,
      `  rubric:`,
      `    - rubric_file: rubrics/out-rubric.md`,
      `  static: []`,
      `  deterministic: []`
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: ${caseId}`,
      `    file: ${caseFile}`,
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR_OUT, 'index.yaml'), indexYaml);

    const currentDir = join(SKILL_DIR_OUT, 'tests', 'cases', caseId, 'current');

    await runRunner([
      '--skill', TEST_SKILL_OUT, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    const firstRunJudge = readFileSync(join(currentDir, 'judge.json'), 'utf8');
    const firstTimestamp = JSON.parse(firstRunJudge).timestamp;

    await new Promise(r => setTimeout(r, 1100));

    await runRunner([
      '--skill', TEST_SKILL_OUT, '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    const secondRunJudge = readFileSync(join(currentDir, 'judge.json'), 'utf8');
    const secondTimestamp = JSON.parse(secondRunJudge).timestamp;

    assert.notStrictEqual(firstTimestamp, secondTimestamp, 'повторный прогон должен перезаписать judge.json с новым timestamp');
  });
});

// ============================================================================
// Verdict Logic — git HEAD comparison, no-baseline, no-regression, --relevant
// ============================================================================

describe('Verdict Logic — git HEAD comparison', () => {
  const VERDICT_SKILL = `__test-verdict-${Date.now()}`;
  const SKILL_DIR_V = join(SKILLS_DIR, VERDICT_SKILL);
  const TESTS_DIR_V = join(SKILL_DIR_V, 'tests');

  function makeMetaJson(status) {
    return JSON.stringify({
      date: '2026-04-01T00:00:00Z',
      skill_sha: 'abc1234',
      status,
      duration_ms: 100
    });
  }

  function runVerdict(args, gitMock) {
    return new Promise((resolve) => {
      const env = { ...process.env };
      if (gitMock) {
        env.TEST_GIT_MOCK = gitMock;
      }
      const proc = spawn(process.execPath, [RUNNER_PATH, ...args], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    });
  }

  before(() => {
    mkdirSync(TESTS_DIR_V, { recursive: true });
    writeFileSync(join(SKILL_DIR_V, 'SKILL.md'), '# Verdict Test Skill\nversion: 1.0\n');
  });

  after(() => {
    if (existsSync(SKILL_DIR_V)) {
      rmSync(SKILL_DIR_V, { recursive: true, force: true });
    }
  });

  function setupCases(cases) {
    const caseYamls = cases.map(c => {
      writeFileSync(join(TESTS_DIR_V, c.file), buildCaseYaml([], []));
      return `  - id: ${c.id}\n    file: ${c.file}\n    tags: [verdict]`;
    });
    writeFileSync(join(TESTS_DIR_V, 'index.yaml'), 'cases:\n' + caseYamls.join('\n'));
  }

  function parseGitHeadComparison(stdout) {
    const result = {};
    const fields = [
      'previously_green',
      'previously_green_still_green',
      'previously_green_now_red',
      'previously_red',
      'previously_red_still_red',
      'previously_red_now_green',
      'new_cases'
    ];
    for (const f of fields) {
      const m = stdout.match(new RegExp(`git_head_comparison\\.${f}:\\s*(\\d+)`));
      result[f] = m ? parseInt(m[1], 10) : null;
    }
    return result;
  }

  it('TC-VER-001: no-baseline — все кейсы новые, git show возвращает null → mode: no-baseline, verdict: no_baseline_failures', async () => {
    setupCases([{ id: 'TC-V001', file: 'tc-v001.yaml' }]);
    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    writeFileSync(mockFile, JSON.stringify({}));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static'], mockFile);
    assert.match(stdout, /mode: no-baseline/, 'mode должен быть no-baseline');
    assert.match(stdout, /verdict: no_baseline_failures/, 'verdict должен быть no_baseline_failures');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-002: no-baseline + --establish-baseline → verdict: baseline_established', async () => {
    setupCases([{ id: 'TC-V002', file: 'tc-v002.yaml' }]);
    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    writeFileSync(mockFile, JSON.stringify({}));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static', '--establish-baseline'], mockFile);
    assert.match(stdout, /verdict: baseline_established/, 'verdict должен быть baseline_established');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-003: no-regression — previously_green остаётся green → verdict: ready_for_user_review', async () => {
    setupCases([{ id: 'TC-V003', file: 'tc-v003.yaml' }]);
    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    const meta = makeMetaJson('passed');
    const mocks = {};
    // Нормализируем путь для кроссплатформности
    const normalizedPath = `src/skills/${VERDICT_SKILL}/tests/cases/TC-V003/current/meta.json`;
    mocks[`TEST_REF:${normalizedPath}`] = meta;
    writeFileSync(mockFile, JSON.stringify(mocks));
    const skillDir = join(SKILLS_DIR, VERDICT_SKILL);
    const currentMeta = join(skillDir, 'tests', 'cases', 'TC-V003', 'current', 'meta.json');
    mkdirSync(dirname(currentMeta), { recursive: true });
    writeFileSync(currentMeta, makeMetaJson('passed'));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static', '--baseline-ref', 'TEST_REF'], mockFile);
    assert.match(stdout, /mode: no-regression/, 'mode должен быть no-regression');
    assert.match(stdout, /verdict: ready_for_user_review/, 'verdict должен быть ready_for_user_review');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-004: no-regression — previously_green_now_red > 0 → verdict: regression_detected', async () => {
    // Create a test case that will FAIL (has a failing assertion)
    const caseFile = join(TESTS_DIR_V, 'tc-v004.yaml');
    writeFileSync(caseFile,
      buildCaseYaml([{ kind: 'skill_contains', pattern: 'PATTERN_NOT_FOUND', reason: 'Should fail' }])
    );
    writeFileSync(join(TESTS_DIR_V, 'index.yaml'), 'cases:\n  - id: TC-V004\n    file: tc-v004.yaml\n');

    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    const meta = makeMetaJson('passed');  // Baseline: was passing
    const mocks = {};
    const normalizedPath = `src/skills/${VERDICT_SKILL}/tests/cases/TC-V004/current/meta.json`;
    mocks[`TEST_REF:${normalizedPath}`] = meta;
    writeFileSync(mockFile, JSON.stringify(mocks));

    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static', '--baseline-ref', 'TEST_REF'], mockFile);
    assert.match(stdout, /mode: no-regression/, 'mode должен быть no-regression');
    assert.match(stdout, /verdict: regression_detected/, 'verdict должен быть regression_detected');
    assert.match(stdout, /previously_green_now_red: [1-9]/, 'previously_green_now_red должен быть > 0');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-005: все 7 полей git_head_comparison присутствуют в output', async () => {
    setupCases([{ id: 'TC-V005', file: 'tc-v005.yaml' }]);
    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    writeFileSync(mockFile, JSON.stringify({}));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static'], mockFile);
    assert.match(stdout, /git_head_comparison\.previously_green:/, 'должно быть поле previously_green');
    assert.match(stdout, /git_head_comparison\.previously_green_still_green:/, 'должно быть поле previously_green_still_green');
    assert.match(stdout, /git_head_comparison\.previously_green_now_red:/, 'должно быть поле previously_green_now_red');
    assert.match(stdout, /git_head_comparison\.previously_red:/, 'должно быть поле previously_red');
    assert.match(stdout, /git_head_comparison\.previously_red_still_red:/, 'должно быть поле previously_red_still_red');
    assert.match(stdout, /git_head_comparison\.previously_red_now_green:/, 'должно быть поле previously_red_now_green');
    assert.match(stdout, /git_head_comparison\.new_cases:/, 'должно быть поле new_cases');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-006: --relevant TC-NNN — релевантный кейс passed → relevant_case_status: passed', async () => {
    setupCases([{ id: 'TC-V006', file: 'tc-v006.yaml' }]);
    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    const meta = makeMetaJson('passed');
    const mocks = {};
    const normalizedPath = `src/skills/${VERDICT_SKILL}/tests/cases/TC-V006/current/meta.json`;
    mocks[`TEST_REF:${normalizedPath}`] = meta;
    writeFileSync(mockFile, JSON.stringify(mocks));
    const skillDir = join(SKILLS_DIR, VERDICT_SKILL);
    const currentMeta = join(skillDir, 'tests', 'cases', 'TC-V006', 'current', 'meta.json');
    mkdirSync(dirname(currentMeta), { recursive: true });
    writeFileSync(currentMeta, makeMetaJson('passed'));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static', '--baseline-ref', 'TEST_REF', '--relevant', 'TC-V006'], mockFile);
    assert.match(stdout, /relevant_case_status: passed/, 'relevant_case_status должен быть passed');
    assert.match(stdout, /verdict: ready_for_user_review/, 'verdict должен быть ready_for_user_review');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-007: --relevant TC-NNN — релевантный кейс failed → verdict: relevant_case_failed', async () => {
    // Create a test case that will FAIL (has a failing assertion)
    const caseFile = join(TESTS_DIR_V, 'tc-v007.yaml');
    writeFileSync(caseFile,
      buildCaseYaml([{ kind: 'skill_contains', pattern: 'NOT_THERE', reason: 'Will fail' }])
    );
    writeFileSync(join(TESTS_DIR_V, 'index.yaml'), 'cases:\n  - id: TC-V007\n    file: tc-v007.yaml\n');

    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    const meta = makeMetaJson('passed');  // Baseline: was passing
    const mocks = {};
    const normalizedPath = `src/skills/${VERDICT_SKILL}/tests/cases/TC-V007/current/meta.json`;
    mocks[`TEST_REF:${normalizedPath}`] = meta;
    writeFileSync(mockFile, JSON.stringify(mocks));

    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static', '--baseline-ref', 'TEST_REF', '--relevant', 'TC-V007'], mockFile);
    assert.match(stdout, /verdict: relevant_case_failed/, 'verdict должен быть relevant_case_failed');
    assert.match(stdout, /relevant_case_status: failed/, 'relevant_case_status должен быть failed');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-008: git_head_comparison counts — new_cases считается корректно', async () => {
    setupCases([{ id: 'TC-V008', file: 'tc-v008.yaml' }]);
    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    writeFileSync(mockFile, JSON.stringify({}));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static'], mockFile);
    const comp = parseGitHeadComparison(stdout);
    assert.strictEqual(comp.new_cases, 1, 'new_cases должен быть 1');
    assert.strictEqual(comp.previously_green, 0, 'previously_green должен быть 0');
    assert.strictEqual(comp.previously_red, 0, 'previously_red должен быть 0');
    rmSync(mockFile, { force: true });
  });

  it('TC-VER-009: git_head_comparison counts — previously_red_now_green считается корректно', async () => {
    setupCases([{ id: 'TC-V009', file: 'tc-v009.yaml' }]);
    const mockFile = join(TESTS_DIR_V, 'git-mock.json');
    const skillDir = join(SKILLS_DIR, VERDICT_SKILL);
    const currentMeta = join(skillDir, 'tests', 'cases', 'TC-V009', 'current', 'meta.json');
    mkdirSync(dirname(currentMeta), { recursive: true });
    writeFileSync(currentMeta, makeMetaJson('passed'));
    const meta = makeMetaJson('failed');
    const mocks = {};
    const normalizedPath = `src/skills/${VERDICT_SKILL}/tests/cases/TC-V009/current/meta.json`;
    mocks[`TEST_REF:${normalizedPath}`] = meta;
    writeFileSync(mockFile, JSON.stringify(mocks));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static', '--baseline-ref', 'TEST_REF'], mockFile);
    const comp = parseGitHeadComparison(stdout);
    assert.strictEqual(comp.previously_red_now_green, 1, 'previously_red_now_green должен быть 1');
    rmSync(mockFile, { force: true });
  });
});

// No git write-операции
// ============================================================================

describe('Нет git write-операций', () => {
  it('runner не содержит "git add"', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(!source.includes('git add'), 'runner не должен содержать "git add"');
  });

  it('runner не содержит "git commit"', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(!source.includes('git commit'), 'runner не должен содержать "git commit"');
  });

  it('runner не содержит "git push"', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(!source.includes('git push'), 'runner не должен содержать "git push"');
  });
});

// ============================================================================
// Severity filtering
// ============================================================================

describe('Severity filtering', () => {
  const SEVERITY_SKILL = `__test-severity-${Date.now()}`;
  const SKILL_DIR = join(SKILLS_DIR, SEVERITY_SKILL);
  const TESTS_DIR = join(SKILL_DIR, 'tests');

  before(() => {
    mkdirSync(TESTS_DIR, { recursive: true });
    writeFileSync(join(SKILL_DIR, 'SKILL.md'), '# Severity Test Skill\nSIGNATURE_PRESENT\n');

    // Case with critical severity
    writeFileSync(join(TESTS_DIR, 'tc-crit.yaml'),
      buildCaseYaml([{ kind: 'skill_contains', pattern: 'SIGNATURE_PRESENT', reason: 'Critical case' }])
    );
    // Case with normal severity
    writeFileSync(join(TESTS_DIR, 'tc-norm.yaml'),
      buildCaseYaml([{ kind: 'skill_contains', pattern: 'SIGNATURE_PRESENT', reason: 'Normal case' }])
    );

    const indexYaml = [
      'cases:',
      '  - id: TC-CRIT',
      '    file: tc-crit.yaml',
      '    severity: critical',
      '  - id: TC-NORM',
      '    file: tc-norm.yaml',
      '    severity: normal'
    ].join('\n');
    writeFileSync(join(TESTS_DIR, 'index.yaml'), indexYaml);
  });

  after(() => {
    if (existsSync(SKILL_DIR)) {
      rmSync(SKILL_DIR, { recursive: true, force: true });
    }
  });

  it('--severity critical filters only critical cases', async () => {
    const { stdout } = await runRunner(['--skill', SEVERITY_SKILL, '--severity', 'critical', '--layer', 'static']);
    assert.match(stdout, /total: 1/, 'должен быть 1 critical кейс');
  });

  it('--severity normal filters only normal cases', async () => {
    const { stdout } = await runRunner(['--skill', SEVERITY_SKILL, '--severity', 'normal', '--layer', 'static']);
    assert.match(stdout, /total: 1/, 'должен быть 1 normal кейс');
  });

  it('without severity returns all cases', async () => {
    const { stdout } = await runRunner(['--skill', SEVERITY_SKILL, '--layer', 'static']);
    assert.match(stdout, /total: 2/, 'должно быть 2 кейса');
  });
});

// ============================================================================
// All skills aggregation
// ============================================================================

describe('All skills aggregation', () => {
  const SKILL_A = `__test-all-a-${Date.now()}`;
  const SKILL_B = `__test-all-b-${Date.now()}`;
  const DIR_A = join(SKILLS_DIR, SKILL_A);
  const DIR_B = join(SKILLS_DIR, SKILL_B);
  const TESTS_A = join(DIR_A, 'tests');
  const TESTS_B = join(DIR_B, 'tests');

  before(() => {
    // Skill A
    mkdirSync(TESTS_A, { recursive: true });
    writeFileSync(join(DIR_A, 'SKILL.md'), '# Skill A\nSIGNATURE_A\n');
    writeFileSync(join(TESTS_A, 'tc-a.yaml'),
      buildCaseYaml([{ kind: 'skill_contains', pattern: 'SIGNATURE_A', reason: 'A case' }])
    );
    writeFileSync(join(TESTS_A, 'index.yaml'),
      `cases:\n  - id: TC-A\n    file: tc-a.yaml\n    tags: [aggregate-test]\n`
    );

    // Skill B
    mkdirSync(TESTS_B, { recursive: true });
    writeFileSync(join(DIR_B, 'SKILL.md'), '# Skill B\nSIGNATURE_B\n');
    writeFileSync(join(TESTS_B, 'tc-b.yaml'),
      buildCaseYaml([{ kind: 'skill_contains', pattern: 'SIGNATURE_B', reason: 'B case' }])
    );
    writeFileSync(join(TESTS_B, 'index.yaml'),
      `cases:\n  - id: TC-B\n    file: tc-b.yaml\n    tags: [aggregate-test]\n`
    );
  });

  after(() => {
    if (existsSync(DIR_A)) rmSync(DIR_A, { recursive: true, force: true });
    if (existsSync(DIR_B)) rmSync(DIR_B, { recursive: true, force: true });
  });

  it('--all aggregates totals across skills (tag-filtered)', async () => {
    const { stdout } = await runRunner(['--all', '--tag', 'aggregate-test', '--layer', 'static']);
    assert.match(stdout, /total: 2/, 'total should be 2');
    assert.match(stdout, /current_run\.passed: 2/);
    assert.match(stdout, /current_run\.failed: 0/);
    assert.match(stdout, /skill: all/);
    assert.match(stdout, /mode: aggregated/);
    assert.match(stdout, /verdict: all_passed/);
    assert.match(stdout, /outcome_message: All skills passed/);
  });
});

// ============================================================================
// Combined flags --all --severity
// ============================================================================

describe('Combined flags --all --severity', () => {
  it('--all --severity critical returns at least 3 tests (current state)', async () => {
    const { stdout } = await runRunner(['--all', '--severity', 'critical', '--layer', 'static']);
    const totalMatch = stdout.match(/total:\s*(\d+)/);
    assert.ok(totalMatch, 'Output should contain total');
    const total = parseInt(totalMatch[1], 10);
    assert.ok(total >= 3, `Expected at least 3 critical tests, got ${total}`);
  });
});

// ============================================================================
// L2 Skip — кейс без rubric должен пропускать L2
// ============================================================================

describe('L2 Skip — кейс без rubric', () => {
  const RUBRIC_SKILL = `__test-no-rubric-${Date.now()}`;
  const SKILL_DIR = join(SKILLS_DIR, RUBRIC_SKILL);
  const TESTS_DIR = join(SKILL_DIR, 'tests');

  before(() => {
    mkdirSync(TESTS_DIR, { recursive: true });
    writeFileSync(join(SKILL_DIR, 'SKILL.md'), '# No Rubric Test Skill\nversion: 1.0\n');

    // TC-NO-RUBRIC-001: кейс БЕЗ assertions.rubric, но с judge_agent в index.yaml
    const caseNoRubric = [
      'description: "Test case without rubric"',
      'prompt: "Test prompt"',
      'assertions:',
      '  static:',
      '    - kind: skill_contains',
      '      pattern: "version: 1.0"',
      '      reason: "SKILL.md должен содержать version"',
      '  deterministic: []'
    ].join('\n');

    writeFileSync(join(TESTS_DIR, 'tc-no-rubric.yaml'), caseNoRubric);

    // TC-WITH-RUBRIC-001: кейс С rubric для проверки что L2 работает когда rubric есть
    mkdirSync(join(SKILL_DIR, 'tests', 'rubrics'), { recursive: true });
    writeFileSync(join(SKILL_DIR, 'tests', 'rubrics', 'test-rubric.md'), [
      '# Test Rubric',
      'Score ≥ 4: pass',
      'Score < 4: fail'
    ].join('\n'));

    const caseWithRubric = [
      'description: "Test case with rubric"',
      'prompt: "Test prompt"',
      'assertions:',
      '  rubric:',
      '    - rubric_file: rubrics/test-rubric.md',
      '  static: []',
      '  deterministic: []'
    ].join('\n');

    writeFileSync(join(TESTS_DIR, 'tc-with-rubric.yaml'), caseWithRubric);

    // index.yaml: judge_agent настроен для обоих кейсов
    const indexYaml = [
      'cases:',
      '  - id: TC-NO-RUBRIC-001',
      '    file: tc-no-rubric.yaml',
      '    tags: [no-rubric]',
      '  - id: TC-WITH-RUBRIC-001',
      '    file: tc-with-rubric.yaml',
      '    tags: [with-rubric]',
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR, 'index.yaml'), indexYaml);
  });

  after(() => {
    if (existsSync(SKILL_DIR)) {
      rmSync(SKILL_DIR, { recursive: true, force: true });
    }
  });

  it('TC-NO-RUBRIC-001: кейс без rubric не падает (L2 пропускается)', async () => {
    const { stdout, stderr, exitCode } = await runRunner([
      '--skill', RUBRIC_SKILL,
      '--case', 'TC-NO-RUBRIC-001',
      '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    // Не должно быть crash с "Rubric not found"
    assert.ok(!stderr.includes('Rubric not found'), 'не должен искать rubric для кейса без rubric');
    assert.ok(!stderr.includes('default.md'), 'не должен пытаться загрузить default.md');
    
    // Кейс должен пройти (L0 + L1 без crash)
    assert.match(stdout, /status: passed/, 'кейс без rubric должен пройти (L2 пропущен)');
    assert.match(stdout, /total: 1/);
  });

  it('TC-WITH-RUBRIC-001: кейс с rubric запускает L2', async () => {
    const { stdout } = await runRunner([
      '--skill', RUBRIC_SKILL,
      '--case', 'TC-WITH-RUBRIC-001',
      '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    // L2 должен запуститься для кейса с rubric
    assert.match(stdout, /status: (passed|failed)/, 'кейс с rubric должен запустить L2');
    assert.match(stdout, /total: 1/);
  });
});

// ============================================================================
// buildTargetPrompt() — сборка prompt из scenario
//
// Проверяет что runner корректно собирает prompt из:
// - scenario.system_prompt_file (загрузка SKILL.md)
// - scenario.extra_instructions (дополнительные инструкции)
// - scenario.inputs (файлы fixtures)
// - fallback на testCase.prompt / testCase.input
// ============================================================================

describe('buildTargetPrompt() — сборка prompt из scenario', () => {
  const PROMPT_SKILL = `__test-prompt-builder-${Date.now()}`;
  const SKILL_DIR = join(SKILLS_DIR, PROMPT_SKILL);
  const TESTS_DIR = join(SKILL_DIR, 'tests');

  before(() => {
    mkdirSync(TESTS_DIR, { recursive: true });

    // Основной SKILL.md с содержимым для system_prompt_file
    writeFileSync(join(SKILL_DIR, 'SKILL.md'), [
      '# Test Skill for Prompt Builder',
      '',
      'This is the system prompt content from SKILL.md.',
      'It should be loaded and included in the target prompt.',
      'version: 1.0'
    ].join('\n'));

    // Создаём директорию для fixtures
    mkdirSync(join(TESTS_DIR, 'fixtures'), { recursive: true });

    // Fixture файл для input.path
    writeFileSync(join(TESTS_DIR, 'fixtures', 'test-input.txt'), [
      'This is a fixture input file.',
      'It will be loaded and included in the prompt.',
      'Content: test data'
    ].join('\n'));
  });

  after(() => {
    if (existsSync(SKILL_DIR)) {
      rmSync(SKILL_DIR, { recursive: true, force: true });
    }
  });

  it('TC-PROMPT-001: buildTargetPrompt собирает prompt из scenario.system_prompt_file + extra_instructions + inputs', async () => {
    // Тест-кейс с полным scenario (system_prompt_file, extra_instructions, inputs)
    const caseId = 'TC-PROMPT-001';
    const caseFile = 'tc-prompt-001.yaml';

    const caseYaml = [
      `description: "Test prompt building from scenario"`,
      `prompt: "Old prompt (should be ignored)"`,
      `scenario:`,
      `  system_prompt_file: SKILL.md`,
      `  extra_instructions: |`,
      `    You are a helpful assistant.`,
      `    Follow these instructions carefully.`,
      `  inputs:`,
      `    - kind: file`,
      `      path: fixtures/test-input.txt`,
      `      as: "Test Input"`,
      `severity: normal`,
      `assertions:`,
      `  static:`,
      `    - kind: skill_contains`,
      `      pattern: "Test Skill for Prompt Builder"`,
      `      reason: "SKILL.md should be accessible"`,
      `  deterministic: []`
    ].join('\n');

    writeFileSync(join(TESTS_DIR, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: ${caseId}`,
      `    file: ${caseFile}`,
      '    tags: [prompt-builder]',
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR, 'index.yaml'), indexYaml);

    const { stdout, stderr } = await runRunner([
      '--skill', PROMPT_SKILL,
      '--case', caseId,
      '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    // Проверяем что runner запустился успешно и не выдал ошибок про пустой prompt
    assert.ok(!stderr.includes('Input must be provided'), 'runner не должен выдавать ошибку про пустой prompt');
    assert.ok(!stderr.includes('input_error'), 'не должно быть ошибок input');
    assert.match(stdout, /total: 1/, 'должен быть 1 тест-кейс');
  });

  it('TC-PROMPT-002: fallback на testCase.prompt если scenario пуст', async () => {
    // Тест-кейс БЕЗ scenario, только с prompt
    const caseId = 'TC-PROMPT-002';
    const caseFile = 'tc-prompt-002.yaml';

    const caseYaml = [
      `description: "Test prompt fallback to testCase.prompt"`,
      `prompt: "This is the fallback prompt from testCase"`,
      `severity: normal`,
      `assertions:`,
      `  static:`,
      `    - kind: skill_contains`,
      `      pattern: "Test Skill for Prompt Builder"`,
      `      reason: "SKILL.md should be present"`,
      `  deterministic: []`
    ].join('\n');

    writeFileSync(join(TESTS_DIR, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: ${caseId}`,
      `    file: ${caseFile}`,
      '    tags: [prompt-fallback]',
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR, 'index.yaml'), indexYaml);

    const { stdout, stderr } = await runRunner([
      '--skill', PROMPT_SKILL,
      '--case', caseId,
      '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    // Проверяем что fallback работает (runner не выдаёт ошибку про пустой prompt)
    assert.ok(!stderr.includes('Input must be provided'), 'fallback должен предотвратить ошибку про пустой prompt');
    assert.match(stdout, /total: 1/, 'должен быть 1 тест-кейс');
  });

  it('TC-PROMPT-003: scenario.inputs с kind=file загружает fixture в prompt', async () => {
    // Тест-кейс с scenario.inputs, проверяем что файл был загружен
    const caseId = 'TC-PROMPT-003';
    const caseFile = 'tc-prompt-003.yaml';

    const caseYaml = [
      `description: "Test fixture loading from inputs"`,
      `prompt: "Base prompt"`,
      `scenario:`,
      `  extra_instructions: "Process the input"`,
      `  inputs:`,
      `    - kind: file`,
      `      path: fixtures/test-input.txt`,
      `      as: "Input Data"`,
      `severity: normal`,
      `assertions:`,
      `  static: []`,
      `  deterministic: []`
    ].join('\n');

    writeFileSync(join(TESTS_DIR, caseFile), caseYaml);

    const indexYaml = [
      'cases:',
      `  - id: ${caseId}`,
      `    file: ${caseFile}`,
      '    tags: [prompt-inputs]',
      'execution:',
      '  target_agents: [agent-a]',
      '  judge_agent: mock-judge'
    ].join('\n');

    writeFileSync(join(TESTS_DIR, 'index.yaml'), indexYaml);

    const { stdout, stderr } = await runRunner([
      '--skill', PROMPT_SKILL,
      '--case', caseId,
      '--layer', 'l2',
      '--skip-secret-scan', '--fast', '--yes',
      '--pipeline', TEST_PIPELINE_PATH
    ]);

    // Проверяем что runner запустился (не важен результат теста, важно что prompt был собран)
    assert.ok(!stderr.includes('ENOENT'), 'не должно быть ошибок при загрузке fixtures');
    assert.match(stdout, /total: 1/, 'тест должен быть найден');
  });
});

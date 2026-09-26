/**
 * Сравнение судей по записям попыток (src/scripts/compare-judges.js, PLAN-001).
 *
 * Записи судьи — фикстуры во временном каталоге скилов (WORKFLOW_SKILLS_DIR) с
 * известными баллами. Судья-кандидат — Jev на локальном сервере (_model-server.mjs):
 * уровень и уверенность он берёт из маркера `WANT:<уровень>:<уверенность>` в выводе
 * исполнителя. Числа отчёта сверяются с посчитанными вручную (таблица ниже). Сеть
 * наружу не используется; каталог снимается в after().
 *
 * | запись | скил | балл записи | Jev: уровень, уверенность | pass/fail |
 * |--------|------|-------------|---------------------------|-----------|
 * | r1     | A    | 5           | 5, 0.95                   | совпал    |
 * | r2     | A    | 4           | 5, 0.9                    | совпал    |
 * | r3     | A    | 2           | 5, 0.6                    | расхождение |
 * | r4     | A    | 5           | 1, 0.85                   | расхождение |
 * | r5     | A    | 3           | 3, 0.75                   | совпал    |
 * | r6     | A    | ошибка судьи| —                         | пропуск   |
 * | r7     | B    | 1           | 2, 0.99                   | совпал    |
 *
 * Точно 2/6, ±1 4/6, pass/fail 4/6. Пороги: 0.7 — уходит 1 (r3), на оставшихся
 * 4 из 5, мимо порога 1 (r4); 0.8 — уходит 2 (r3, r5), 3 из 4, мимо 1; 0.95 —
 * уходит 4, 2 из 2, мимо 0.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_KEY, startModelServer, sendJson, decisionsResponse } from './_model-server.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'compare-judges.js');

const RUBRIC = [
  '| Балл | Описание |', '|---|---|',
  '| 5 | полностью |', '| 4 | в основном |', '| 3 | частично |', '| 2 | почти нет |', '| 1 | нет |',
].join('\n');

const FIXTURES = [
  { id: 'r1', skill: 'skill-a', caseId: 'TC-A-1', trial: 1, score: 5, want: '5:0.95' },
  { id: 'r2', skill: 'skill-a', caseId: 'TC-A-1', trial: 2, score: 4, want: '5:0.9' },
  { id: 'r3', skill: 'skill-a', caseId: 'TC-A-1', trial: 3, score: 2, want: '5:0.6' },
  { id: 'r4', skill: 'skill-a', caseId: 'TC-A-2', trial: 1, score: 5, want: '1:0.85' },
  { id: 'r5', skill: 'skill-a', caseId: 'TC-A-2', trial: 2, score: 3, want: '3:0.75' },
  { id: 'r6', skill: 'skill-a', caseId: 'TC-A-2', trial: 3, score: null, want: '5:0.9', error: 'judge output unparsed' },
  { id: 'r7', skill: 'skill-b', caseId: 'TC-B-1', trial: 1, score: 1, want: '2:0.99' },
];

function record(f) {
  return {
    judge_agent: 'mock-opus',
    judge_kind: 'cli',
    input: {
      rubric_file: `${f.skill}/tests/rubrics/r.md`,
      rubric: RUBRIC,
      criterion: `Критерий ${f.id}`,
      agent_output: `вывод ${f.id} WANT:${f.want}`,
      ticket_files: '',
    },
    prompt: 'prompt',
    raw_output: f.score ? `score: ${f.score}` : 'нет балла',
    own_score: f.score,
    score: f.score,
    passed: f.score >= 4,
    confidence: null,
    probabilities: null,
    escalated: false,
    escalation: null,
    fallback: null,
    duration_ms: 1,
    cost_usd: null,
    error: f.error ?? null,
  };
}

function runScript(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => done({ stdout, stderr, exitCode }));
  });
}

describe('compare-judges: переоценка записей судьёй Jev', () => {
  let root;
  let skillsDir;
  let pipeline;
  let server;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'wf-compare-judges-test-'));
    skillsDir = join(root, 'skills');
    for (const f of FIXTURES) {
      const dir = join(skillsDir, f.skill, 'tests', 'cases', f.caseId, 'current', 'agent-x');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `trial-${f.trial}.md`), 'вывод');
      writeFileSync(join(dir, `trial-${f.trial}.judge.json`), JSON.stringify(record(f), null, 2));
    }
    server = await startModelServer((req, res) => {
      const [, level, confidence] = req.json.state.agent_output.match(/WANT:(\d):([\d.]+)/);
      sendJson(res, 200, decisionsResponse({
        verdict: { type: 'score', score: 0, legend: {}, probabilities: { [Number(level) - 1]: 1 }, confidence: Number(confidence) },
      }));
    });
    pipeline = join(root, 'pipeline.yaml');
    writeFileSync(pipeline, [
      'pipeline:',
      '  agents:',
      '    jev:',
      '      kind: http',
      '      protocol: decisions',
      `      url: "${server.url('/api/alpha/decisions')}"`,
      '      model: "typesafe/jev-1.13"',
      '      auth: { env: "TEST_MODEL_KEY" }',
      '      cost_per_call: 0.0001',
      '',
    ].join('\n'));
  });

  after(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const env = () => ({ WORKFLOW_SKILLS_DIR: skillsDir, TEST_MODEL_KEY: TEST_KEY });

  it('отчёт: совпадения, матрица, пороги, скилы, цена — как посчитано вручную', async () => {
    const out = join(root, 'report.md');
    const disagreements = join(root, 'disagreements');
    const seen = server.requests.length;
    const run = await runScript(['--judge', 'jev', '--pipeline', pipeline, '--yes',
      '--out', out, '--disagreements', disagreements], env());

    assert.equal(run.exitCode, 0, run.stdout + run.stderr);
    assert.equal(server.requests.length - seen, 6, 'запись с ошибкой судьи не переоценивается');
    const report = readFileSync(out, 'utf8');

    assert.match(report, /Записей судьи найдено: 7\. Судьи записей: mock-opus\./);
    assert.match(report, /Пропущено записей с ошибкой судьи: 1\. Переоценка не удалась: 0\. Сравнено: 6\./);
    assert.match(report, /\| Точное совпадение балла \| 2 из 6 \(33\.3%\) \|/);
    assert.match(report, /\| В пределах ±1 \| 4 из 6 \(66\.7%\) \|/);
    assert.match(report, /\| Совпадение pass\/fail \(порог 4\) \| 4 из 6 \(66\.7%\) \|/);
    assert.match(report, /\| Расхождений pass\/fail \| 2 \|/);

    // строки — балл записи, столбцы — Jev
    assert.match(report, /\| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \|/);
    assert.match(report, /\| 2 \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
    assert.match(report, /\| 3 \| 0 \| 0 \| 1 \| 0 \| 0 \|/);
    assert.match(report, /\| 4 \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
    assert.match(report, /\| 5 \| 1 \| 0 \| 0 \| 0 \| 1 \|/);

    assert.match(report, /\| skill-a \| 5 \| 2 \(40\.0%\) \| 3 \(60\.0%\) \|/);
    assert.match(report, /\| skill-b \| 1 \| 0 \(0\.0%\) \| 1 \(100\.0%\) \|/);

    assert.match(report, /\| 0\.7 \| 1 \(16\.7%\) \| 4 из 5 \(80\.0%\) \| 1 из 2 \|/);
    assert.match(report, /\| 0\.8 \| 2 \(33\.3%\) \| 3 из 4 \(75\.0%\) \| 1 из 2 \|/);
    assert.match(report, /\| 0\.95 \| 4 \(66\.7%\) \| 2 из 2 \(100\.0%\) \| 0 из 2 \|/);

    // 6 × 0.000126672 (цена ответа _model-server) = 0.000760032
    assert.match(report, /Судья jev: \$0\.0008 за 6 вызовов с ценой; без цены в ответе: 0\./);

    const files = readdirSync(disagreements).sort();
    assert.deepEqual(files, [
      'skill-a__TC-A-1__agent-x__trial-3.md',
      'skill-a__TC-A-2__agent-x__trial-1.md',
    ]);
    const r3 = readFileSync(join(disagreements, files[0]), 'utf8');
    assert.match(r3, /Запись: mock-opus — балл 2/);
    assert.match(r3, /jev: балл 5, уверенность 0\.6/);
    assert.match(r3, /вывод r3 WANT:5:0\.6/);
  });

  it('--skill — только записи этого скила', async () => {
    const out = join(root, 'report-b.md');
    const run = await runScript(['--judge', 'jev', '--pipeline', pipeline, '--yes', '--skill', 'skill-b', '--out', out], env());

    assert.equal(run.exitCode, 0, run.stdout + run.stderr);
    const report = readFileSync(out, 'utf8');
    assert.match(report, /Записей судьи найдено: 1 \(скил skill-b\)/);
    assert.match(report, /Сравнено: 1\./);
  });

  it('судья без ключа — переоценка не удалась у каждой записи: отчёт есть, код 1', async () => {
    const out = join(root, 'report-nokey.md');
    const run = await runScript(['--judge', 'jev', '--pipeline', pipeline, '--yes', '--out', out],
      { WORKFLOW_SKILLS_DIR: skillsDir, TEST_MODEL_KEY: '' });

    assert.equal(run.exitCode, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /ни одна из 6 записей не переоценена судьёй jev/);
    assert.match(readFileSync(out, 'utf8'), /Переоценка не удалась: 6\. Сравнено: 0\./);
    assert.equal(run.stdout.match(/нет ключа \(no_key\)/g)?.length, 1, 'предупреждение о ключе — одно');
  });

  it('без --judge — код 1 и подсказка', async () => {
    const run = await runScript(['--pipeline', pipeline, '--yes'], env());

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /--judge is required/);
  });

  it('ошибки аргументов и судьи — код 1 с причиной', async () => {
    const cases = [
      [['--judge', 'jev', '--bogus'], /Unknown argument: --bogus/],
      [['--judge', 'jev', '--concurrency', '0'], /--concurrency must be an integer >= 1/],
      [['--judge'], /--judge needs a value/],
      [['--judge', 'нет-такого', '--pipeline', pipeline], /Judge agent 'нет-такого' not found/],
    ];
    for (const [args, expected] of cases) {
      const run = await runScript(args, env());
      assert.equal(run.exitCode, 1, args.join(' '));
      assert.match(run.stderr, expected, args.join(' '));
    }
  });

  it('--help — код 0 и строка использования', async () => {
    const run = await runScript(['--help'], env());

    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /Usage: node compare-judges\.js --judge <agent>/);
  });
});

describe('compare-judges: CLI-судья, испорченная запись, судья chat', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-compare-judges-cli-'));
    const dir = join(root, 'skills', 'skill-c', 'tests', 'cases', 'TC-C-1', 'current', 'agent-x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trial-1.judge.json'), JSON.stringify(record({ id: 'c1', skill: 'skill-c', score: 5, want: '5:1' })));
    writeFileSync(join(dir, 'trial-2.judge.json'), '{ испорчено');
    // Балл записи дал escalate_to: HTTP-судья записи не ответил (фоллбек).
    writeFileSync(join(dir, 'trial-3.judge.json'), JSON.stringify({
      ...record({ id: 'c3', skill: 'skill-c', score: 2, want: '2:1' }),
      judge_agent: 'jev', judge_kind: 'http', own_score: null, fallback: 'no_key',
      escalation: { judge_agent: 'claude-opus', raw_output: 'score: 2', score: 2 },
    }));
    writeFileSync(join(dir, 'notes.txt'), 'не запись судьи');
    writeFileSync(join(root, 'pipeline.yaml'), [
      'pipeline:',
      '  agents:',
      '    cli-four:',
      '      command: "node"',
      `      args: ["${join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'mock-judge-raw.js').replace(/\\/g, '/')}", "score: 4"]`,
      '    jev-chat:',
      '      kind: http',
      '      protocol: chat',
      '      url: "http://127.0.0.1:9/v1/chat/completions"',
      '      model: "vendor/chat"',
      '      auth: { env: "TEST_MODEL_KEY" }',
      '',
    ].join('\n'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('CLI-судья: без уверенности таблица порогов не строится; испорченная запись — пропуск', async () => {
    const out = join(root, 'report.md');
    const run = await runScript(['--judge', 'cli-four', '--pipeline', join(root, 'pipeline.yaml'), '--yes', '--out', out],
      { WORKFLOW_SKILLS_DIR: join(root, 'skills') });

    assert.equal(run.exitCode, 0, run.stdout + run.stderr);
    const report = readFileSync(out, 'utf8');
    assert.match(report, /Записей судьи найдено: 3\. Судьи записей: claude-opus \(фоллбек no_key с jev\), mock-opus\./);
    assert.match(report, /Пропущено записей с ошибкой судьи: 1\. Переоценка не удалась: 0\. Сравнено: 2\./);
    assert.match(report, /\| 2 \| 0 \| 0 \| 0 \| 1 \| 0 \|/);
    assert.match(report, /\| 5 \| 0 \| 0 \| 0 \| 1 \| 0 \|/);
    assert.match(report, /нет уверенности \(CLI-судья\) — таблица порогов не строится/);
    assert.match(report, /без цены в ответе: 2\./);
  });

  it('судья kind: http с protocol: chat — код 1', async () => {
    const run = await runScript(['--judge', 'jev-chat', '--pipeline', join(root, 'pipeline.yaml'), '--yes'],
      { WORKFLOW_SKILLS_DIR: join(root, 'skills') });

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /must use protocol decisions, got: chat/);
  });
});

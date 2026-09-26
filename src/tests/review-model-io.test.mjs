/**
 * Скрипты стадии ревью с обменом `model_io` (PLAN-002, задачи 23–26):
 *  - src/skills/review-result/scripts/prepare-review.js — вопросы модели по файлу evidence;
 *  - src/skills/review-result/scripts/apply-review.js — вердикт по ответу модели, запись
 *    ревью в тикет и в файл evidence.
 *
 * Каждый тест — временный корень проекта в os.tmpdir() со своим `.workflow/`: тикет с
 * разделом Result, файл evidence по схеме «Файл evidence» плана, PNG пункта visual.
 * Скрипты запускаются дочерним процессом, как их запускает раннер: cwd — корень
 * проекта, промпт стадии последним аргументом, переменные WORKFLOW_MODEL_*. Шкала —
 * файл скила knowledge/dod-evidence-scale.md: prepare читает его рядом с собой, тест —
 * по тому же пути. Сквозной случай проводит стадию через runPipeline с агентом-моком
 * по контракту судьи тестов скилов. Корни снимаются в after(); сеть не используется.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rubricLevels } from '../lib/rubric-levels.mjs';
import { getLastReviewStatus } from '../lib/review-section.mjs';
import { buildCliJudgePrompt } from '../lib/skill-judge.mjs';
import { runPipeline } from '../runner.mjs';

const SKILL_DIR = fileURLToPath(new URL('../skills/review-result/', import.meta.url));
const PREPARE = join(SKILL_DIR, 'scripts', 'prepare-review.js');
const APPLY = join(SKILL_DIR, 'scripts', 'apply-review.js');
const SCALE_LEVELS = rubricLevels(readFileSync(join(SKILL_DIR, 'knowledge', 'dod-evidence-scale.md'), 'utf8'), 'dod-evidence-scale');
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

const TICKET_ID = 'QA-501';
const EVIDENCE_FILE = `.workflow/state/evidence/${TICKET_ID}.json`;
const REQUEST_FILE = `.workflow/state/evidence/${TICKET_ID}.review-request.json`;
const SCREEN = `.workflow/evidence/screens/${TICKET_ID}-export.png`;
// Заявление исполнителя в разделе Result тикета — в данные модели попадать не должно.
const RESULT_CLAIM = 'Исполнитель: всё сделано и проверено, маркер 7f3a';
const MODEL_ENV = {
  WORKFLOW_MODEL_AGENT: 'review-agent',
  WORKFLOW_MODEL_CAPABILITIES: JSON.stringify(['text', 'multimodal']),
  WORKFLOW_MODEL_IO_OPTIONS: JSON.stringify({ pass_level: 4, min_confidence: 0.8 }),
};

const CHECK_ITEM = {
  index: 1, text: 'Тесты модуля зелёные', kind: 'check',
  command: 'node --test src/tests/x.test.mjs', expect: 'exit 0',
  exit_code: 0, stdout: '# pass 3', stderr: '', duration_ms: 420, status: 'passed',
};
const PROSE_ITEM = {
  index: 2, text: 'Текст ошибки понятен пользователю', kind: 'prose',
  reason: 'понятность формулировки командой не проверить', status: 'pending',
};
const VISUAL_ITEM = {
  index: 3, text: 'Кнопка «Экспорт» стоит справа от поиска', kind: 'visual',
  images: [SCREEN], status: 'pending',
};

const ROOTS = [];

after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function evidenceFixture(overrides = {}) {
  return {
    ticket_id: TICKET_ID,
    attempt: 1,
    collected_at: '2026-09-26T12:00:00Z',
    items: [CHECK_ITEM, PROSE_ITEM, VISUAL_ITEM],
    source_refs: [{ ref: 'src/x.js:42', excerpt: 'throw new Error(\'Файл не найден: укажите путь от корня проекта\');', status: 'found' }],
    changed_files: ['src/x.js'],
    diff: '+  throw new Error(\'Файл не найден: укажите путь от корня проекта\');',
    diff_truncated: null,
    legacy_gates: { missing_files: [], result_filled: true, source_grounding: 'satisfied', assertions_failed: 0 },
    review: { agent: null, model: null, items: {} },
    ...overrides,
  };
}

const TICKET = `---
id: ${TICKET_ID}
title: "fixture"
type: impl
dod_format: 2
required_capabilities: []
---
## Описание

fixture

## Критерии готовности (Definition of Done)

- [x] ${CHECK_ITEM.text}
  - check: \`${CHECK_ITEM.command}\`, expect: \`exit 0\`
- [x] ${PROSE_ITEM.text}
  - prose: \`${PROSE_ITEM.reason}\`
- [x] ${VISUAL_ITEM.text}
  - visual: \`${SCREEN}\`

## Результат выполнения

### Summary
${RESULT_CLAIM}
`;

function makeProject(evidence = evidenceFixture()) {
  const root = mkdtempSync(join(tmpdir(), 'wf-review-model-io-'));
  ROOTS.push(root);
  mkdirSync(join(root, '.workflow', 'tickets', 'review'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'tickets', 'review', `${TICKET_ID}.md`), TICKET);
  mkdirSync(dirname(join(root, EVIDENCE_FILE)), { recursive: true });
  writeFileSync(join(root, EVIDENCE_FILE), JSON.stringify(evidence, null, 2));
  mkdirSync(dirname(join(root, SCREEN)), { recursive: true });
  writeFileSync(join(root, SCREEN), PNG_BYTES);
  return root;
}

/** Промпт стадии той же формы, что строит PromptBuilder раннера. */
function stagePrompt(context) {
  const lines = Object.entries(context).filter(([, value]) => value).map(([key, value]) => `  ${key}: ${value}`);
  return ['review-result', '\n\nContext:', ...lines, '\nCounters:', '  task_attempts: 1'].join('\n');
}

const CONTEXT = { ticket_id: TICKET_ID, evidence_file: EVIDENCE_FILE };

function runScript(script, root, context, env = {}) {
  const run = spawnSync('node', [script, stagePrompt(context)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...MODEL_ENV, ...env },
  });
  assert.equal(run.status, 0, `${script} завершился с кодом ${run.status}:\n${run.stderr}`);
  const block = run.stdout.match(/---RESULT---\n([\s\S]*?)---RESULT---/);
  assert.ok(block, `нет блока RESULT:\n${run.stdout}`);
  const fields = {};
  for (const line of block[1].split('\n')) {
    const match = line.match(/^([a-z_]+): ?(.*)$/);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

function readJson(root, file) {
  return JSON.parse(readFileSync(join(root, file), 'utf8'));
}

function ticketText(root) {
  return readFileSync(join(root, '.workflow', 'tickets', 'review', `${TICKET_ID}.md`), 'utf8');
}

function lastReviewRow(root) {
  const rows = ticketText(root).split('\n').filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line));
  assert.ok(rows.length > 0, `нет строки в ## Ревью:\n${ticketText(root)}`);
  return rows[rows.length - 1];
}

describe('prepare-review.js: вопросы модели по evidence', () => {
  it('пункты prose и visual — два вопроса по пять уровней шкалы, одно изображение, файл рядом с evidence', () => {
    const root = makeProject();

    const result = runScript(PREPARE, root, CONTEXT);

    assert.deepEqual(result, { status: 'ready', request_file: REQUEST_FILE });
    const request = readJson(root, REQUEST_FILE);
    assert.equal(SCALE_LEVELS.length, 5);
    assert.deepEqual(request.questions, [
      { id: 'dod-2', text: PROSE_ITEM.text, levels: SCALE_LEVELS },
      { id: 'dod-3', text: `${VISUAL_ITEM.text} — по приложенным изображениям: ${SCREEN}`, levels: SCALE_LEVELS },
    ]);
    assert.deepEqual(request.images, [SCREEN]);
    const evidence = evidenceFixture();
    assert.deepEqual(request.data, {
      items: [CHECK_ITEM],
      source_refs: evidence.source_refs,
      diff: evidence.diff,
    }, 'данные — проверки с выводом, source_refs и дифф; пункты, ждущие модели, — только вопросами');
  });

  it('раздел Result тикета в данные модели не попадает', () => {
    const root = makeProject();

    runScript(PREPARE, root, CONTEXT);

    assert.ok(ticketText(root).includes(RESULT_CLAIM), 'заявление есть в тикете');
    const requestText = readFileSync(join(root, REQUEST_FILE), 'utf8');
    assert.ok(!requestText.includes(RESULT_CLAIM), `заявление исполнителя попало в запрос:\n${requestText}`);
    assert.deepEqual(Object.keys(readJson(root, REQUEST_FILE).data), ['items', 'source_refs', 'diff'],
      'changed_files, legacy_gates и review в данные не идут');
  });

  it('evidence с diff_truncated — пометка усечения в data', () => {
    const truncated = { shown_chars: 60000, total_chars: 143975 };
    const root = makeProject(evidenceFixture({ diff_truncated: truncated }));

    runScript(PREPARE, root, CONTEXT);

    assert.deepEqual(readJson(root, REQUEST_FILE).data.diff_truncated, truncated);
  });

  it('evidence с diff_error — причина неполного диффа в data', () => {
    const diffError = 'git diff: fatal: bad revision \'HEAD\'';
    const root = makeProject(evidenceFixture({ diff_error: diffError }));

    runScript(PREPARE, root, CONTEXT);

    assert.deepEqual(readJson(root, REQUEST_FILE).data.diff_error, diffError);
  });

  it('нет пунктов prose и visual — status passed без модели, файла запроса нет', () => {
    const root = makeProject(evidenceFixture({ items: [CHECK_ITEM] }));

    const result = runScript(PREPARE, root, CONTEXT);

    assert.equal(result.status, 'passed');
    assert.equal(existsSync(join(root, REQUEST_FILE)), false);
  });

  it('изображения, а у агента нет multimodal — agent_without_multimodal, файла запроса нет', () => {
    const root = makeProject();

    const result = runScript(PREPARE, root, CONTEXT, { WORKFLOW_MODEL_CAPABILITIES: JSON.stringify(['text']) });

    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'agent_without_multimodal');
    assert.match(result.error, /review-agent/);
    assert.equal(existsSync(join(root, REQUEST_FILE)), false);
  });

  it('без пунктов visual агент без multimodal получает вопросы', () => {
    const root = makeProject(evidenceFixture({ items: [CHECK_ITEM, PROSE_ITEM] }));

    const result = runScript(PREPARE, root, CONTEXT, { WORKFLOW_MODEL_CAPABILITIES: JSON.stringify(['text']) });

    assert.equal(result.status, 'ready');
    const request = readJson(root, REQUEST_FILE);
    assert.deepEqual(request.images, []);
    assert.deepEqual(request.questions.map((question) => question.id), ['dod-2']);
  });

  it('evidence_file нет в контексте — evidence_missing', () => {
    const root = makeProject();

    const result = runScript(PREPARE, root, { ticket_id: TICKET_ID });

    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'evidence_missing');
  });

  it('файл evidence другого тикета — evidence_mismatch, файла запроса нет', () => {
    const root = makeProject(evidenceFixture({ ticket_id: 'QA-499' }));

    const result = runScript(PREPARE, root, CONTEXT);

    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'evidence_mismatch');
    assert.match(result.error, /QA-499/);
    assert.equal(existsSync(join(root, REQUEST_FILE)), false);
  });

  it('проваленная проверка в evidence — evidence_failed_items, вопросы модели не задаются', () => {
    const failedCheck = { ...CHECK_ITEM, exit_code: 1, status: 'failed' };
    const root = makeProject(evidenceFixture({ items: [failedCheck, PROSE_ITEM] }));

    const result = runScript(PREPARE, root, CONTEXT);

    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'evidence_failed_items');
    assert.match(result.error, /1 \(failed\)/);
    assert.equal(existsSync(join(root, REQUEST_FILE)), false);
  });
});

// Вход apply: запрос на два прозаических пункта 1 и 2 и ответ слоя оценки.
const APPLY_ITEMS = [
  { index: 1, text: 'Текст ошибки понятен пользователю', kind: 'prose', reason: 'формулировку командой не проверить', status: 'pending' },
  { index: 2, text: 'Сообщение называет путь от корня проекта', kind: 'prose', reason: 'смысл сообщения командой не проверить', status: 'pending' },
];
const APPLY_REQUEST = {
  data: { items: [], source_refs: [], diff: '+ сообщение' },
  images: [],
  questions: APPLY_ITEMS.map((item) => ({ id: `dod-${item.index}`, text: item.text, levels: SCALE_LEVELS })),
};

/** Ответ с уверенностью — как у протокола decisions и у обёртки-судьи. */
function answersWithConfidence(first, second) {
  return {
    answers: {
      'dod-1': { level: first[0], confidence: first[1], probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.1, 4: 0.9 }, reason: null },
      'dod-2': { level: second[0], confidence: second[1], probabilities: { 0: 0, 1: 0.1, 2: 0, 3: 0.9, 4: 0 }, reason: null },
    },
    raw: {},
    model: 'test/decisions-model',
    usage: null,
    cost_usd: 0.0002,
    duration_ms: 12,
  };
}

/** Ответ без уверенности — как у протокола chat и у агента с командой, который её не сообщает. */
function answersWithoutConfidence(first, second) {
  return {
    answers: {
      'dod-1': { level: first, confidence: null, probabilities: null, reason: 'сообщение видно в диффе' },
      'dod-2': { level: second, confidence: null, probabilities: null, reason: 'путь назван в сообщении' },
    },
    raw: 'текст ответа',
    model: 'test/chat-model',
    usage: null,
    cost_usd: null,
    duration_ms: 12,
  };
}

function runApply(response, { options } = {}) {
  const root = makeProject(evidenceFixture({ items: APPLY_ITEMS }));
  const dir = join(root, '.workflow', 'state', 'model-io');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'request.json'), JSON.stringify(APPLY_REQUEST));
  writeFileSync(join(dir, 'response.json'), JSON.stringify(response));
  const result = runScript(APPLY, root, CONTEXT, {
    WORKFLOW_MODEL_REQUEST: join(dir, 'request.json'),
    WORKFLOW_MODEL_RESPONSE: join(dir, 'response.json'),
    ...(options ? { WORKFLOW_MODEL_IO_OPTIONS: JSON.stringify(options) } : {}),
  });
  return { root, result };
}

describe('apply-review.js: вердикт по ответу модели и запись ревью', () => {
  it('уровни 5 и 4 при уверенности 0.9 — passed; строка ## Ревью и evidence называют агента и модель', () => {
    const { root, result } = runApply(answersWithConfidence([5, 0.9], [4, 0.9]));

    assert.deepEqual(result, {
      status: 'passed', failed_items: '', agent: 'review-agent', model: 'test/decisions-model',
      cost_usd: '0.0002', review_written: 'true',
    });
    assert.equal(getLastReviewStatus(ticketText(root)), 'passed');
    assert.equal(lastReviewRow(root).replace(/^\| \d{4}-\d{2}-\d{2} /, ''),
      `| ✅ passed | review-result: пункты DoD 1, 2 пройдены; evidence ${EVIDENCE_FILE}; модель test/decisions-model | review-agent |`);
    assert.deepEqual(readJson(root, EVIDENCE_FILE).review, {
      agent: 'review-agent',
      model: 'test/decisions-model',
      items: {
        1: { level: 5, confidence: 0.9, passed: true, reason: null },
        2: { level: 4, confidence: 0.9, passed: true, reason: null },
      },
    });
  });

  it('уровни 5 и 2 — failed, failed_items: 2, строка failed в ## Ревью, уровни в evidence', () => {
    const { root, result } = runApply(answersWithConfidence([5, 0.9], [2, 0.9]));

    assert.equal(result.status, 'failed');
    assert.equal(result.failed_items, '2');
    assert.equal(getLastReviewStatus(ticketText(root)), 'failed');
    assert.match(lastReviewRow(root),
      new RegExp(`\\| ❌ failed \\| review-result: не пройдены пункты DoD 2; evidence ${EVIDENCE_FILE.replace(/\./g, '\\.')}; модель test/decisions-model \\| review-agent \\|$`));
    const { items } = readJson(root, EVIDENCE_FILE).review;
    assert.deepEqual([items[1].level, items[2].level], [5, 2]);
    assert.deepEqual([items[1].passed, items[2].passed], [true, false]);
  });

  it('уровень 4 при уверенности 0.6 — failed: неуверенная оценка засчитывается провалом', () => {
    const { root, result } = runApply(answersWithConfidence([5, 0.9], [4, 0.6]));

    assert.equal(result.status, 'failed');
    assert.equal(result.failed_items, '2');
    assert.equal(getLastReviewStatus(ticketText(root)), 'failed');
    assert.deepEqual(readJson(root, EVIDENCE_FILE).review.items[2], { level: 4, confidence: 0.6, passed: false, reason: null });
  });

  it('уровень 4 без уверенности (null) — passed; модель и цена, которых ответ не назвал, — unknown', () => {
    const { root, result } = runApply({ ...answersWithoutConfidence(5, 4), model: null });

    assert.equal(result.status, 'passed');
    assert.equal(result.model, 'unknown');
    assert.equal(result.cost_usd, 'unknown');
    assert.match(lastReviewRow(root), /; модель неизвестна \| review-agent \|$/);
    assert.deepEqual(readJson(root, EVIDENCE_FILE).review.items[2],
      { level: 4, confidence: null, passed: true, reason: 'путь назван в сообщении' });
  });

  it('без options — порог уровня 4 и уверенности 0.8', () => {
    const { result } = runApply(answersWithConfidence([4, 0.85], [5, 0.75]), { options: {} });

    assert.equal(result.status, 'failed');
    assert.equal(result.failed_items, '2');
  });

  it('в ответе нет вопроса из запроса — answer_missing, ни тикет, ни evidence не меняются', () => {
    const response = answersWithoutConfidence(5, 5);
    delete response.answers['dod-2'];
    const { root, result } = runApply(response);

    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'answer_missing');
    assert.match(result.error, /dod-2/);
    assert.equal(ticketText(root), TICKET, 'строка ревью не пишется');
    assert.deepEqual(readJson(root, EVIDENCE_FILE).review, { agent: null, model: null, items: {} });
  });
});

// Агент с командой по контракту судьи: ответ на N-й запуск — N-й аргумент, строки через «;».
// Промпт — из stdin (prompt_stdin); каждый запуск дописывается в .workflow/tmp/judge-prompts.jsonl.
const JUDGE_AGENT_SCRIPT = `import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
fs.mkdirSync('.workflow/tmp', { recursive: true });
fs.appendFileSync('.workflow/tmp/judge-prompts.jsonl', JSON.stringify(prompt) + '\\n');
const call = fs.readFileSync('.workflow/tmp/judge-prompts.jsonl', 'utf8').trim().split('\\n').length;
const answer = process.argv[2 + call - 1] || '';
console.log('---RESULT---\\n' + answer.split(';').join('\\n') + '\\nreason: mock judge\\n---RESULT---');
`;

describe('стадия ревью через раннер: prepare-review.js → агент с командой → apply-review.js', () => {
  it('пункт prose пройден, пункт visual провален: строка failed в ## Ревью, уровни и агент в evidence', async () => {
    const root = makeProject();
    mkdirSync(join(root, '.workflow', 'config'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'judge.mjs'), JUDGE_AGENT_SCRIPT);
    const outcome = (status) => ({ stage: 'end', params: { review_outcome: status, failed_items: '$result.failed_items', review_error: '$result.reason' } });
    const config = {
      pipeline: {
        name: 'review-model-io',
        version: '1.0',
        entry: 'review-result',
        execution: { timeout_per_stage: 60, delay_between_stages: 0, artifact_snapshot_enabled: false },
        context: CONTEXT,
        agents: {
          'judge-cli': {
            command: 'node',
            args: ['scripts/judge.mjs', 'score: 5;confidence: 0.9;model: test/judge-model', 'score: 2;confidence: 0.95;model: test/judge-model'],
            prompt_stdin: true,
            capabilities: ['text', 'multimodal'],
          },
        },
        stages: {
          'review-result': {
            agents: ['judge-cli'],
            model_io: { prepare: PREPARE, apply: APPLY, options: { pass_level: 4, min_confidence: 0.8 } },
            goto: { passed: outcome('passed'), failed: outcome('failed'), error: outcome('error') },
          },
        },
      },
    };
    writeFileSync(join(root, '.workflow', 'config', 'pipeline.yaml'), JSON.stringify(config, null, 2));

    const run = await runPipeline(['--project', root]);

    assert.equal(run.exitCode, 0, JSON.stringify(run.details || run.error || ''));
    assert.equal(run.result.context.review_outcome, 'failed', run.result.context.review_error);
    assert.equal(run.result.context.failed_items, '3');

    const request = readJson(root, REQUEST_FILE);
    const prompts = readFileSync(join(root, '.workflow', 'tmp', 'judge-prompts.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(prompts.length, 2, 'по запуску агента на пункт prose и пункт visual');
    prompts.forEach((prompt, i) => {
      assert.equal(prompt, buildCliJudgePrompt({
        rubric: SCALE_LEVELS.map((level, n) => `| ${n + 1} | ${level} |`).join('\n'),
        agent_output: `${JSON.stringify(request.data, null, 2)}\nИзображения:\n${SCREEN}`,
        criterion: request.questions[i].text,
      }), 'промпт судьи: уровни шкалы, данные evidence, путь изображения, текст пункта');
      assert.ok(!prompt.includes(RESULT_CLAIM), 'заявление исполнителя из Result в промпт не попадает');
    });

    assert.equal(getLastReviewStatus(ticketText(root)), 'failed');
    assert.equal(lastReviewRow(root).replace(/^\| \d{4}-\d{2}-\d{2} /, ''),
      `| ❌ failed | review-result: не пройдены пункты DoD 3; evidence ${EVIDENCE_FILE}; модель test/judge-model | judge-cli |`);
    assert.deepEqual(readJson(root, EVIDENCE_FILE).review, {
      agent: 'judge-cli',
      model: 'test/judge-model',
      items: {
        2: { level: 5, confidence: 0.9, passed: true, reason: 'mock judge' },
        3: { level: 2, confidence: 0.95, passed: false, reason: 'mock judge' },
      },
    });
  });
});

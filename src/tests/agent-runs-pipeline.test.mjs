/**
 * События `verify` и `review` журнала запусков (.workflow/metrics/agent-runs.jsonl,
 * src/lib/agent-runs.mjs) от цикла PipelineRunner (PipelineRunner.recordStageEvent,
 * PLAN-003, задачи 10–12).
 *
 * По этим событиям считается градация запуска исполнителя: `verify` решает, прошёл ли
 * тикет контроль артефактов (успех или неудача модели для правил запрета), `review` —
 * вердикт ревью после пройденного контроля. Событие, которое не записалось или
 * записалось не с теми полями, молча портит градации и запреты моделей.
 *
 * Что охраняется:
 *  - стадия контроля артефактов пишет `verify` со всеми полями из «Справочных данных →
 *    Журнал»: статус как вернул контроль (`all_green`, `passed`, `legacy`, `failed`),
 *    процент DoD, списки отсутствующих и неизменённых файлов, `fail_reasons` списком;
 *    у тикета без `dod_format: 2` поля evidence — null;
 *  - провал проверок пунктов DoD (`fail_reasons: dod_items_failed=2,3`) даёт
 *    `fail_reasons: ["dod_items_failed=2,3"]` — запятая внутри кода список не делит;
 *  - сбой самого контроля (`status: failed` с `reason`, выход 1) — `verify` с `reason`
 *    и пустым `fail_reasons`; стадия контроля, упавшая без RESULT, `verify` не пишет;
 *  - исход `all_green` события `review` не даёт: ревью не было;
 *  - стадия ревью с обменом `model_io` (apply — apply-review.js) пишет `review` со
 *    статусом `passed` / `failed` / `error`, агентом стадии и моделью из ответа модели;
 *    prepare, закрывший стадию без модели, — агент стадии и `model: null`;
 *  - стадия ревью со скилом `review-result` пишет `review` со статусом `passed` /
 *    `failed` / `default`, агентом-ревьюером и ключом модели его запуска;
 *  - стадии опознаются по скрипту и скилу, а не по id: под другими id записи те же;
 *  - стадии других видов (скрипт с похожим RESULT, исполнитель, `model_io` с другим
 *    apply, счётчик) не пишут ни `verify`, ни `review`.
 *
 * Проект — временный каталог в os.tmpdir() со скриптами-фикстурами (контроль
 * артефактов, prepare и apply ревью, агент с командой по контракту судьи, ревьюер);
 * каталог снимается в afterEach при любом исходе. PipelineRunner создаётся напрямую
 * (`{ project: <каталог> }`), его обработчики сигналов снимаются после прогона.
 * Имена моделей и агентов — нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-pipeline.test.mjs
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PipelineRunner } from '../runner.mjs';
import { readRunEvents } from '../lib/agent-runs.mjs';

const ROOTS = [];

afterEach(() => {
  while (ROOTS.length > 0) {
    fs.rmSync(ROOTS.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------
// Фикстуры проекта (CommonJS: package.json проекта задаёт "type": "commonjs")
// ---------------------------------------------------------------------------

// Контроль артефактов: вариант — первый аргумент. Блоки RESULT повторяют печать
// src/skills/review-result/scripts/verify-artifacts.js (поля и порядок, `; ` между
// fail_reasons, выход 1 у сбоя самого контроля).
const VERIFY_SCRIPT = `const variant = process.argv[2];
const emit = (lines) => console.log(['---RESULT---', ...lines, '---RESULT---'].join('\\n'));
const head = (status, pct, filled, missing, unchanged) => [
  'status: ' + status, 'ticket_id: IMPL-7', 'dod_completion_pct: ' + pct, 'dod_total: 4',
  'dod_completed: ' + Math.round(pct / 25), 'result_filled: ' + filled,
  'missing_files: ' + missing, 'unchanged_files: ' + unchanged,
  'assertions_total: 0', 'assertions_failed: 0',
];
const evidence = (total, failed, prose) => [
  'evidence_file: .workflow/evidence/IMPL-7/attempt-1.json', 'required_capabilities: ["text"]',
  'dod_check_total: ' + total, 'dod_check_failed: ' + failed,
  'dod_prose_total: ' + prose, 'dod_visual_total: 0',
];
switch (variant) {
  case 'all_green':
    emit([...head('all_green', 100, true, '', ''), ...evidence(3, 0, 0), 'review_note_written: true']);
    break;
  case 'passed':
    emit([...head('passed', 100, true, '', ''), ...evidence(2, 0, 1)]);
    break;
  case 'legacy':
    emit(head('legacy', 100, true, '', ''));
    break;
  case 'failed_gate':
    emit([...head('failed', 50, false, 'src/a.js,src/b.js', 'src/c.js'),
      'fail_reasons: result_filled=false; missing_files=src/a.js,src/b.js; file_unchanged=src/c.js',
      'issues: секция Result не заполнена; нет файлов: src/a.js, src/b.js',
      'review_note_written: true']);
    break;
  case 'failed_dod':
    emit([...head('failed', 100, true, '', ''), ...evidence(3, 2, 0),
      'fail_reasons: dod_items_failed=2,3',
      'issues: не пройдены пункты DoD: 2 — проверка упала; 3 — проверка упала',
      'review_note_written: true']);
    break;
  case 'failed_reason':
    console.error('Error: ticket file not found');
    emit(['status: failed', 'reason: ticket_file_not_found', 'ticket_path: .workflow/tickets/review/IMPL-7.md']);
    process.exit(1);
    break;
  case 'crash':
    console.error('verify crashed before RESULT');
    process.exit(1);
    break;
  default:
    throw new Error('unknown verify variant: ' + variant);
}
`;

// prepare стадии ревью с model_io: options.prepare_mode = nothing — закрывает стадию
// сам, как prepare-review.js без вопросов (reason: no_questions); иначе — один вопрос
// с пятью уровнями (агенту с командой нужна шкала из пяти).
const PREPARE_SCRIPT = `const fs = require('fs');
const options = JSON.parse(process.env.WORKFLOW_MODEL_IO_OPTIONS || '{}');
if (options.prepare_mode === 'nothing') {
  console.log('---RESULT---\\nstatus: passed\\nreason: no_questions\\n---RESULT---');
} else {
  fs.mkdirSync('.workflow/tmp', { recursive: true });
  fs.writeFileSync('.workflow/tmp/request.json', JSON.stringify({
    data: 'evidence тикета',
    questions: [{ id: 'dod-1', text: 'Пункт 1 выполнен?', levels: ['1', '2', '3', '4', '5'] }],
  }));
  console.log('---RESULT---\\nstatus: ready\\nrequest_file: .workflow/tmp/request.json\\n---RESULT---');
}
`;

// apply: passed, если уровень каждого ответа не ниже pass_level (4); RESULT с agent и
// model — как у apply-review.js.
const APPLY_SCRIPT = `const fs = require('fs');
const options = JSON.parse(process.env.WORKFLOW_MODEL_IO_OPTIONS || '{}');
const request = JSON.parse(fs.readFileSync(process.env.WORKFLOW_MODEL_REQUEST, 'utf8'));
const response = JSON.parse(fs.readFileSync(process.env.WORKFLOW_MODEL_RESPONSE, 'utf8'));
const failed = request.questions
  .filter((q) => response.answers[q.id].level < (options.pass_level || 4))
  .map((q) => q.id);
console.log(['---RESULT---', 'status: ' + (failed.length ? 'failed' : 'passed'),
  'failed_items: ' + failed.join(','), 'agent: ' + process.env.WORKFLOW_MODEL_AGENT,
  'model: ' + (response.model || 'unknown'), '---RESULT---'].join('\\n'));
`;

// Агент с командой по контракту судьи: строки ответа — первый аргумент через «;».
const JUDGE_SCRIPT = `const answer = process.argv[2] || '';
console.log('---RESULT---\\n' + answer.split(';').join('\\n') + '\\nreason: mock judge\\n---RESULT---');
`;

// Ревьюер (и исполнитель): аргументы \`--model <модель> <вердикт>\`, промпт — последним.
// Вердикт none — ответ без блока RESULT и без статуса: стадия получает default.
const REVIEWER_SCRIPT = `const verdict = process.argv[4];
if (verdict === 'none') {
  console.log('Ревью выполнено без итоговой строки');
} else {
  console.log('---RESULT---\\nstatus: ' + verdict + '\\n---RESULT---');
}
`;

// Прочие скрипт-стадии. lookalike — RESULT, похожий на провал контроля артефактов.
const OTHER_SCRIPT = `if (process.argv[2] === 'lookalike') {
  console.log(['---RESULT---', 'status: failed', 'ticket_id: IMPL-7', 'dod_completion_pct: 0',
    'result_filled: false', 'missing_files: src/x.js', 'fail_reasons: dod_items_failed=1',
    '---RESULT---'].join('\\n'));
} else {
  console.log('---RESULT---\\nstatus: passed\\n---RESULT---');
}
`;

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-pipeline-'));
  ROOTS.push(root);
  const write = (rel, text) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('package.json', JSON.stringify({ name: 'agent-runs-pipeline-fixture', private: true, type: 'commonjs' }));
  write('scripts/verify-artifacts.js', VERIFY_SCRIPT);
  write('tools/checks/verify-artifacts.js', VERIFY_SCRIPT);
  write('scripts/prepare-review.js', PREPARE_SCRIPT);
  write('scripts/apply-review.js', APPLY_SCRIPT);
  write('scripts/apply.js', APPLY_SCRIPT);
  write('scripts/judge-agent.js', JUDGE_SCRIPT);
  write('scripts/review-agent.js', REVIEWER_SCRIPT);
  write('scripts/other-script.js', OTHER_SCRIPT);
  return root;
}

const EXECUTION = {
  max_steps: 20,
  // Не 0: раннер читает `delay_between_stages || 5`.
  delay_between_stages: 0.01,
  timeout_per_stage: 30,
  artifact_snapshot_enabled: false,
};

const TICKET = 'IMPL-7';

/**
 * Конфиг с маршрутом стадий, как в configs/pipeline.yaml: контроль артефактов →
 * all_green: перенос тикета (скрипт) / passed: ревью с model_io / legacy и error:
 * ревью со скилом / failed: счётчик попыток. `ids` переименовывает стадии и агентов,
 * `verifyScript` — путь скрипта контроля.
 */
function chainConfig({
  verify = 'passed',
  judge = 'score: 5;model: prov/model-c',
  prepareMode = null,
  verdict = 'passed',
  ids = {},
  verifyScript = 'scripts/verify-artifacts.js',
  context = { ticket_id: TICKET },
} = {}) {
  const id = {
    verify: 'verify-artifacts', review: 'review-result', legacy: 'review-result-legacy',
    verifyAgent: 'script-verify-artifacts', judge: 'judge-a', reviewer: 'agent-a', ...ids,
  };
  return {
    pipeline: {
      name: 'agent-runs-pipeline-test',
      version: '1.0',
      entry: id.verify,
      execution: EXECUTION,
      context,
      agents: {
        [id.verifyAgent]: { command: 'node', args: [verifyScript, verify], workdir: '.' },
        [id.judge]: { command: 'node', args: ['scripts/judge-agent.js', judge], capabilities: ['text'] },
        [id.reviewer]: {
          command: 'node', args: ['scripts/review-agent.js', '--model', 'prov/model-b', verdict], capabilities: ['text'],
        },
        'script-move': { command: 'node', args: ['scripts/other-script.js'], workdir: '.' },
      },
      stages: {
        [id.verify]: {
          agent: id.verifyAgent,
          goto: {
            all_green: 'move-ticket',
            passed: id.review,
            legacy: id.legacy,
            failed: 'increment-task-attempts',
            default: id.review,
            error: id.legacy,
          },
        },
        [id.review]: {
          agents: [id.judge],
          counter: 'task_attempts',
          model_io: {
            prepare: 'scripts/prepare-review.js',
            apply: 'scripts/apply-review.js',
            options: { pass_level: 4, ...(prepareMode ? { prepare_mode: prepareMode } : {}) },
          },
          goto: { passed: 'move-ticket', failed: 'increment-task-attempts', default: 'move-ticket', error: 'increment-task-attempts' },
        },
        [id.legacy]: {
          agents: [id.reviewer],
          skill: 'review-result',
          counter: 'task_attempts',
          goto: { passed: 'move-ticket', failed: 'increment-task-attempts', default: 'move-ticket', error: 'increment-task-attempts' },
        },
        'move-ticket': { agent: 'script-move', goto: { default: 'end' } },
        'increment-task-attempts': { type: 'update-counter', counter: 'task_attempts', goto: { default: 'end' } },
      },
    },
  };
}

/** Прогон пайплайна до конца; события журнала и пройденные стадии (по логу раннера). */
async function runPipeline(root, config) {
  const runner = new PipelineRunner(config, { project: root });
  try {
    await runner.run();
  } finally {
    runner.disposeSignalHandlers();
  }
  const log = fs.readFileSync(runner.logFilePath, 'utf8');
  const completed = [...log.matchAll(/Stage (\S+) completed with status: (\S+)/g)].map((m) => `${m[1]}=${m[2]}`);
  const events = readRunEvents(root);
  return {
    runner,
    log,
    completed,
    events,
    stageEvents: events.filter((e) => e.type === 'verify' || e.type === 'review'),
  };
}

/** Событие без `ts` (время проверяется отдельно) — для сравнения целиком. */
function withoutTs(event) {
  const { ts, ...rest } = event;
  assert.equal(typeof ts, 'string', `ts есть: ${JSON.stringify(event)}`);
  assert.equal(new Date(ts).toISOString(), ts, `ts — ISO UTC: ${ts}`);
  return rest;
}

function only(events, type) {
  const found = events.filter((e) => e.type === type);
  assert.equal(found.length, 1, `одно событие ${type}: ${JSON.stringify(events)}`);
  return found[0];
}

function verifyEvent(runner, fields) {
  return {
    type: 'verify',
    pipeline_run: runner.runId,
    ticket: TICKET,
    ticket_type: 'impl',
    reason: null,
    evidence_file: null,
    dod_check_total: null,
    dod_check_failed: null,
    fail_reasons: [],
    missing_files: [],
    unchanged_files: [],
    ...fields,
  };
}

function reviewEvent(runner, fields) {
  return { type: 'review', pipeline_run: runner.runId, ticket: TICKET, ticket_type: 'impl', ...fields };
}

const EVIDENCE = '.workflow/evidence/IMPL-7/attempt-1.json';

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe('журнал запусков: событие verify стадии контроля артефактов', () => {
  it('failed с провалом прежних гейтов — статус, процент DoD, списки файлов и fail_reasons; evidence null', async () => {
    const root = makeProject();
    const { runner, stageEvents, completed } = await runPipeline(root, chainConfig({ verify: 'failed_gate' }));

    assert.deepEqual(completed, ['verify-artifacts=failed', 'increment-task-attempts=default']);
    assert.deepEqual(stageEvents.map((e) => e.type), ['verify'], 'после failed ревью нет');
    assert.deepEqual(withoutTs(stageEvents[0]), verifyEvent(runner, {
      status: 'failed',
      dod_completion_pct: 50,
      result_filled: false,
      missing_files: ['src/a.js', 'src/b.js'],
      unchanged_files: ['src/c.js'],
      fail_reasons: ['result_filled=false', 'missing_files=src/a.js,src/b.js', 'file_unchanged=src/c.js'],
    }));
  });

  it('провал проверок пунктов DoD — fail_reasons ["dod_items_failed=2,3"] и поля evidence', async () => {
    const root = makeProject();
    const { runner, stageEvents } = await runPipeline(root, chainConfig({ verify: 'failed_dod' }));

    assert.deepEqual(stageEvents.map((e) => e.type), ['verify']);
    const event = withoutTs(stageEvents[0]);
    assert.deepEqual(event.fail_reasons, ['dod_items_failed=2,3']);
    assert.deepEqual(event, verifyEvent(runner, {
      status: 'failed',
      dod_completion_pct: 100,
      result_filled: true,
      evidence_file: EVIDENCE,
      dod_check_total: 3,
      dod_check_failed: 2,
      fail_reasons: ['dod_items_failed=2,3'],
    }));
  });

  it('all_green — verify с evidence_file и пустым fail_reasons; события review нет', async () => {
    const root = makeProject();
    const { runner, stageEvents, completed, events } = await runPipeline(root, chainConfig({ verify: 'all_green' }));

    assert.deepEqual(completed, ['verify-artifacts=all_green', 'move-ticket=passed']);
    assert.deepEqual(stageEvents.map((e) => e.type), ['verify'], 'all_green: ревью не было — review не пишется');
    assert.equal(events.filter((e) => e.type === 'review').length, 0);
    assert.deepEqual(withoutTs(stageEvents[0]), verifyEvent(runner, {
      status: 'all_green',
      dod_completion_pct: 100,
      result_filled: true,
      evidence_file: EVIDENCE,
      dod_check_total: 3,
      dod_check_failed: 0,
    }));
  });

  it('сбой самого контроля (reason: ticket_file_not_found, выход 1) — verify с reason и пустым fail_reasons', async () => {
    const root = makeProject();
    const { runner, stageEvents, completed } = await runPipeline(root, chainConfig({ verify: 'failed_reason' }));

    assert.deepEqual(completed, ['verify-artifacts=failed', 'increment-task-attempts=default']);
    assert.deepEqual(stageEvents.map((e) => e.type), ['verify']);
    assert.deepEqual(withoutTs(stageEvents[0]), verifyEvent(runner, {
      status: 'failed',
      reason: 'ticket_file_not_found',
      dod_completion_pct: null,
      result_filled: null,
      fail_reasons: [],
    }));
  });

  it('стадия контроля, упавшая без RESULT, verify не пишет', async () => {
    const root = makeProject();
    const { stageEvents, log } = await runPipeline(root, chainConfig({ verify: 'crash', verdict: 'passed' }));

    assert.match(log, /Error at stage "verify-artifacts"/, 'стадия упала исключением');
    assert.equal(stageEvents.filter((e) => e.type === 'verify').length, 0,
      `verify без RESULT не пишется: ${JSON.stringify(stageEvents)}`);
    // Ветка error маршрута — ревью со скилом, как в configs/pipeline.yaml.
    assert.deepEqual(stageEvents.map((e) => `${e.type}:${e.stage}`), ['review:review-result-legacy']);
  });
});

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

describe('журнал запусков: событие review', () => {
  it('ревью с model_io: passed, failed, error — статус стадии, агент стадии, модель из ответа', async () => {
    const cases = [
      { judge: 'score: 5;model: prov/model-c', status: 'passed', model: 'prov/model-c' },
      { judge: 'score: 2;model: prov/model-d', status: 'failed', model: 'prov/model-d' },
      // Ответ без балла — ошибка модели (unparsed): apply не запускается, ответа нет.
      { judge: 'оценки нет;model: prov/model-c', status: 'error', model: null },
      // Сбой модели с классом из MODEL_ERROR_HEALTH у единственного агента списка:
      // смены агента нет — результат стадии та же ошибка модели.
      { judge: 'status: error;error_class: server;error: upstream 502', status: 'error', model: null },
    ];
    for (const c of cases) {
      const root = makeProject();
      const { runner, stageEvents, completed } = await runPipeline(root, chainConfig({ verify: 'passed', judge: c.judge }));

      assert.equal(completed[1], `review-result=${c.status}`, `${c.status}: ${completed.join(' → ')}`);
      assert.deepEqual(stageEvents.map((e) => e.type), ['verify', 'review'], `${c.status}: verify, затем review`);
      assert.deepEqual(withoutTs(stageEvents[0]), verifyEvent(runner, {
        status: 'passed',
        dod_completion_pct: 100,
        result_filled: true,
        evidence_file: EVIDENCE,
        dod_check_total: 2,
        dod_check_failed: 0,
      }), `${c.status}: verify passed`);
      assert.deepEqual(withoutTs(stageEvents[1]), reviewEvent(runner, {
        stage: 'review-result',
        status: c.status,
        agent: 'judge-a',
        model: c.model,
      }), `${c.status}: review`);
    }
  });

  it('ревью с model_io: prepare закрыл стадию без модели — агент стадии, model null', async () => {
    const root = makeProject();
    const { runner, stageEvents, completed } = await runPipeline(root, chainConfig({ verify: 'passed', prepareMode: 'nothing' }));

    assert.equal(completed[1], 'review-result=passed');
    assert.deepEqual(withoutTs(only(stageEvents, 'review')), reviewEvent(runner, {
      stage: 'review-result',
      status: 'passed',
      agent: 'judge-a',
      model: null,
    }));
  });

  it('ревью со скилом review-result: passed, failed, default — агент-ревьюер и ключ модели его запуска', async () => {
    const cases = [
      { verdict: 'passed', status: 'passed' },
      { verdict: 'failed', status: 'failed' },
      { verdict: 'none', status: 'default' },
    ];
    for (const c of cases) {
      const root = makeProject();
      const { runner, stageEvents, completed } = await runPipeline(root, chainConfig({ verify: 'legacy', verdict: c.verdict }));

      assert.equal(completed[1], `review-result-legacy=${c.status}`, `${c.status}: ${completed.join(' → ')}`);
      assert.deepEqual(stageEvents.map((e) => e.type), ['verify', 'review'], `${c.status}: verify, затем review`);
      assert.deepEqual(withoutTs(stageEvents[0]), verifyEvent(runner, {
        status: 'legacy',
        dod_completion_pct: 100,
        result_filled: true,
      }), `${c.status}: verify legacy — поля evidence null`);
      assert.deepEqual(withoutTs(stageEvents[1]), reviewEvent(runner, {
        stage: 'review-result-legacy',
        status: c.status,
        agent: 'agent-a',
        model: 'prov/model-b',
      }), `${c.status}: review`);
    }
  });
});

// ---------------------------------------------------------------------------
// Опознание стадий
// ---------------------------------------------------------------------------

describe('журнал запусков: стадии опознаются не по id', () => {
  const RENAMED = {
    verify: 'artifact-gate', review: 'judge-pass', legacy: 'second-opinion',
    verifyAgent: 'gate-script', judge: 'judge-b', reviewer: 'agent-b',
  };

  it('контроль артефактов и ревью с model_io под другими id пишут verify и review', async () => {
    const root = makeProject();
    const { runner, stageEvents, completed } = await runPipeline(root, chainConfig({
      verify: 'passed', ids: RENAMED, verifyScript: 'tools/checks/verify-artifacts.js',
      context: { ticket_id: TICKET, task_type: 'docs' },
    }));

    assert.deepEqual(completed.slice(0, 2), ['artifact-gate=passed', 'judge-pass=passed']);
    assert.deepEqual(stageEvents.map((e) => e.type), ['verify', 'review']);
    assert.deepEqual(withoutTs(stageEvents[0]), verifyEvent(runner, {
      ticket_type: 'docs',
      status: 'passed',
      dod_completion_pct: 100,
      result_filled: true,
      evidence_file: EVIDENCE,
      dod_check_total: 2,
      dod_check_failed: 0,
    }));
    assert.deepEqual(withoutTs(stageEvents[1]), reviewEvent(runner, {
      ticket_type: 'docs', stage: 'judge-pass', status: 'passed', agent: 'judge-b', model: 'prov/model-c',
    }));
  });

  it('ревью со скилом review-result под другим id пишет review', async () => {
    const root = makeProject();
    const { runner, stageEvents, completed } = await runPipeline(root, chainConfig({
      verify: 'legacy', verdict: 'failed', ids: RENAMED, verifyScript: 'tools/checks/verify-artifacts.js',
    }));

    assert.deepEqual(completed.slice(0, 2), ['artifact-gate=legacy', 'second-opinion=failed']);
    assert.deepEqual(stageEvents.map((e) => e.type), ['verify', 'review']);
    assert.equal(stageEvents[0].status, 'legacy');
    assert.deepEqual(withoutTs(stageEvents[1]), reviewEvent(runner, {
      stage: 'second-opinion', status: 'failed', agent: 'agent-b', model: 'prov/model-b',
    }));
  });

  it('стадии других видов не пишут ни verify, ни review', async () => {
    const root = makeProject();
    const config = {
      pipeline: {
        name: 'agent-runs-other-stages',
        version: '1.0',
        entry: 'implement',
        execution: EXECUTION,
        context: { ticket_id: TICKET },
        agents: {
          'agent-a': {
            command: 'node', args: ['scripts/review-agent.js', '--model', 'prov/model-b', 'passed'], capabilities: ['text'],
          },
          'judge-a': { command: 'node', args: ['scripts/judge-agent.js', 'score: 5;model: prov/model-c'], capabilities: ['text'] },
          'lint-script': { command: 'node', args: ['scripts/other-script.js', 'lookalike'], workdir: '.' },
        },
        stages: {
          // Исполнитель — стадия со списком агентов и другим скилом.
          implement: { agents: ['agent-a'], skill: 'execute-task', goto: { default: 'lint-gate' } },
          // Скрипт с RESULT, похожим на провал контроля артефактов.
          'lint-gate': { agent: 'lint-script', goto: { default: 'score' } },
          // Обмен model_io, apply которого — не apply-review.js.
          score: {
            agents: ['judge-a'],
            model_io: { prepare: 'scripts/prepare-review.js', apply: 'scripts/apply.js', options: { pass_level: 4 } },
            goto: { default: 'count' },
          },
          count: { type: 'update-counter', counter: 'task_attempts', goto: { default: 'end' } },
        },
      },
    };

    const { stageEvents, completed, events } = await runPipeline(root, config);

    assert.deepEqual(completed, ['implement=passed', 'lint-gate=failed', 'score=passed', 'count=default'],
      'все стадии отработали');
    assert.deepEqual(stageEvents, [], `ни verify, ни review: ${JSON.stringify(stageEvents)}`);
    // Стадии со списком агентов при этом пишут свои запуски — журнал ведётся.
    assert.deepEqual(events.map((e) => `${e.type}:${e.stage}`), ['run:implement', 'run:score']);
  });
});

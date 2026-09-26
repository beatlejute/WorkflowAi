/**
 * Маршрут ревью в действующем configs/pipeline.yaml (PLAN-002).
 *
 * Предпроверка verify-artifacts разводит тикет по исходам:
 *  - all_green — все пункты DoD тикета dod_format: 2 закрыты зелёными проверками:
 *    сразу move-ticket в done, без модели;
 *  - passed и default — стадия review-result с файлом evidence и способностями из
 *    результата предпроверки;
 *  - legacy (тикет без dod_format: 2) и error — стадия review-result-legacy,
 *    прежнее ревью агентом со скилом. Обе ветки явно обнуляют evidence_file:
 *    updateContext раннера только присваивает ключи из params и ничего не
 *    удаляет, а переходы pick-* evidence_file не задают — иначе в промпт стадии
 *    попал бы файл evidence предыдущего тикета прогона. Ветка error обнуляет и
 *    required_capabilities (PLAN-002, задача 16);
 *  - failed — increment-task-attempts, без ревью.
 *
 * Стадия review-result (PLAN-002, задача 29) — обмен model_io, скрипты prepare и
 * apply есть в репозитории. В списке агентов — только модели без инструментов:
 * запись kind: http или запись с command и tool_less: true. Первый агент списка —
 * без multimodal (прозаические пункты), в списке есть агент с multimodal (пункты
 * со скриншотами).
 *
 * Имён агентов тест не проверяет. Файл конфига тест только читает; копии для
 * проверки отказа — во временном каталоге ОС, снимаются в after().
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/js-yaml.mjs';
import { validateConfig } from '../runner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'configs', 'pipeline.yaml');
const TMP_ROOTS = [];

after(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function loadYaml(file) {
  return yaml.load(readFileSync(file, 'utf8'));
}

/** Действующий конфиг: каждый тест получает свою копию объекта. */
function loadConfig() {
  return loadYaml(CONFIG_PATH);
}

/**
 * Копия действующего конфига с правкой `mutate(config)` — файл во временном
 * каталоге ОС. Возвращает конфиг, прочитанный из этой копии.
 */
function loadMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-review-route-'));
  TMP_ROOTS.push(dir);
  const config = loadConfig();
  mutate(config);
  const copy = join(dir, 'pipeline.yaml');
  writeFileSync(copy, yaml.dump(config));
  return loadYaml(copy);
}

/** Стадия конфига по id или undefined. */
function findStage(config, id) {
  return config.pipeline.stages[id];
}

/**
 * Нарушения перехода `goto.<status>` стадии: целевая стадия и перечисленные
 * параметры. Пустой список — переход совпал.
 */
function transitionProblems(config, stageId, status, { stage, params = {} }) {
  const where = `${stageId}.goto.${status}`;
  const actual = findStage(config, stageId)?.goto?.[status];
  if (!actual) return [`${where}: перехода нет`];
  const problems = [];
  if (actual.stage !== stage) problems.push(`${where}: stage ${actual.stage}, ожидалось ${stage}`);
  for (const [key, value] of Object.entries(params)) {
    const got = actual.params?.[key];
    if (got !== value) problems.push(`${where}: params.${key} = ${JSON.stringify(got)}, ожидалось ${JSON.stringify(value)}`);
  }
  return problems;
}

const TICKET = { ticket_id: '$context.ticket_id' };
const ATTEMPT = { ...TICKET, attempt: '$counter.task_attempts' };
const EVIDENCE = { evidence_file: '$result.evidence_file', required_capabilities: '$result.required_capabilities' };

/** Нарушения маршрута предпроверки verify-artifacts. */
function verifyArtifactsProblems(config) {
  const check = (status, expected) => transitionProblems(config, 'verify-artifacts', status, expected);
  return [
    ...check('all_green', { stage: 'move-ticket', params: { ...TICKET, target: 'done' } }),
    ...check('passed', { stage: 'review-result', params: { ...ATTEMPT, ...EVIDENCE } }),
    ...check('default', { stage: 'review-result', params: { ...ATTEMPT, ...EVIDENCE } }),
    ...check('legacy', { stage: 'review-result-legacy', params: { ...ATTEMPT, evidence_file: '' } }),
    ...check('error', { stage: 'review-result-legacy', params: { ...ATTEMPT, evidence_file: '', required_capabilities: '' } }),
    ...check('failed', { stage: 'increment-task-attempts', params: TICKET }),
  ];
}

/**
 * Нарушения стадии review-result-legacy: ревью агентом со скилом review-result,
 * без model_io; счётчик и переходы — те, что были у review-result до PLAN-002.
 */
function legacyStageProblems(config) {
  const stage = findStage(config, 'review-result-legacy');
  if (!stage) return ['стадии review-result-legacy нет'];
  const problems = [];
  if (stage.skill !== 'review-result') problems.push(`review-result-legacy.skill = ${stage.skill}, ожидалось review-result`);
  if (stage.model_io !== undefined) problems.push('у review-result-legacy есть model_io');
  if (stage.counter !== 'task_attempts') problems.push(`review-result-legacy.counter = ${stage.counter}, ожидалось task_attempts`);
  if (!Array.isArray(stage.agents) || stage.agents.length === 0) {
    problems.push('у review-result-legacy нет списка агентов');
  } else {
    for (const id of stage.agents) {
      if (!config.pipeline.agents[id]) problems.push(`агента ${id} из review-result-legacy нет в реестре`);
    }
  }
  const check = (status, expected) => transitionProblems(config, 'review-result-legacy', status, expected);
  return [
    ...problems,
    ...check('passed', { stage: 'move-ticket', params: { ...TICKET, target: 'done' } }),
    ...check('failed', { stage: 'increment-task-attempts', params: TICKET }),
    ...check('default', { stage: 'move-ticket', params: { ...TICKET, target: 'backlog' } }),
    ...check('error', { stage: 'increment-task-attempts', params: TICKET }),
  ];
}

const CANONICAL_SCRIPT_PREFIX = '.workflow/src/';

/**
 * Скрипт model_io в репозитории — та же подстановка, что в validateModelIo раннера:
 * путь `.workflow/src/…`, которого нет, ищется ещё по `src/…` от корня (в
 * репозитории канона `.workflow/src/skills/<скил>` — ссылка на установленную копию,
 * в CI каталога `.workflow/` нет).
 */
function repoScriptExists(script) {
  if (existsSync(resolve(REPO_ROOT, script))) return true;
  return script.startsWith(CANONICAL_SCRIPT_PREFIX)
    && existsSync(resolve(REPO_ROOT, 'src', script.slice(CANONICAL_SCRIPT_PREFIX.length)));
}

function hasMultimodal(agent) {
  return Array.isArray(agent?.capabilities) && agent.capabilities.includes('multimodal');
}

/** Модель без инструментов: запись kind: http или запись с command и tool_less: true. */
function isToolLess(agent) {
  if (agent?.kind === 'http') return true;
  return typeof agent?.command === 'string' && agent.tool_less === true;
}

/**
 * Нарушения стадии review-result: обмен model_io с существующими скриптами, в
 * списке только агенты без инструментов, первый — без multimodal, есть агент с
 * multimodal.
 */
function reviewStageProblems(config) {
  const stage = findStage(config, 'review-result');
  if (!stage) return ['стадии review-result нет'];
  const problems = [];
  if (!stage.model_io) {
    problems.push('у review-result нет model_io');
  } else {
    for (const step of ['prepare', 'apply']) {
      const script = stage.model_io[step];
      if (typeof script !== 'string' || script === '') {
        problems.push(`у review-result нет model_io.${step}`);
      } else if (!repoScriptExists(script)) {
        problems.push(`review-result.model_io.${step}: скрипта ${script} нет в репозитории`);
      }
    }
  }
  if (!Array.isArray(stage.agents) || stage.agents.length === 0) {
    problems.push('у review-result нет списка агентов');
    return problems;
  }
  const registry = config.pipeline.agents;
  for (const id of stage.agents) {
    if (!registry[id]) problems.push(`агента ${id} из review-result нет в реестре`);
    else if (!isToolLess(registry[id])) problems.push(`агент ${id} из review-result — не kind: http и не запись с command и tool_less: true`);
  }
  const [first] = stage.agents;
  if (hasMultimodal(registry[first])) problems.push(`первый агент review-result (${first}) — с multimodal`);
  if (!stage.agents.some((id) => hasMultimodal(registry[id]))) problems.push('в списке review-result нет агента с multimodal');
  return problems;
}

/** Запись агента с командой claude без tool_less — у него есть инструменты. */
const TOOLED_AGENT_ID = 'cli-with-tools';
const TOOLED_AGENT = { command: 'claude', args: ['-p'], workdir: '.', capabilities: ['text'] };

describe('pipeline-review-route: маршрут ревью в configs/pipeline.yaml', () => {
  it('verify-artifacts: all_green → done, legacy и error → review-result-legacy, в ревью — evidence', () => {
    assert.deepEqual(verifyArtifactsProblems(loadConfig()), []);
  });

  it('review-result-legacy — ревью агентом со скилом review-result, без model_io', () => {
    assert.deepEqual(legacyStageProblems(loadConfig()), []);
  });

  it('действующий конфиг проходит проверку раннера при старте', () => {
    assert.deepEqual(validateConfig(loadConfig(), REPO_ROOT), []);
  });

  it('копия конфига без goto.all_green у verify-artifacts — нарушение', () => {
    const config = loadMutatedCopy((c) => { delete c.pipeline.stages['verify-artifacts'].goto.all_green; });
    assert.deepEqual(verifyArtifactsProblems(config), ['verify-artifacts.goto.all_green: перехода нет']);
  });

  it('review-result — model_io со скриптами из репозитория, агенты без инструментов, первый без multimodal, есть multimodal', () => {
    assert.deepEqual(reviewStageProblems(loadConfig()), []);
  });

  it('копия конфига без агента с multimodal в списке review-result — нарушение', () => {
    const config = loadMutatedCopy((c) => {
      const stage = c.pipeline.stages['review-result'];
      stage.agents = stage.agents.filter((id) => !hasMultimodal(c.pipeline.agents[id]));
    });
    assert.deepEqual(reviewStageProblems(config), ['в списке review-result нет агента с multimodal']);
  });

  it('копия конфига с агентом command: claude без tool_less в списке review-result — нарушение', () => {
    const config = loadMutatedCopy((c) => {
      c.pipeline.agents[TOOLED_AGENT_ID] = { ...TOOLED_AGENT };
      c.pipeline.stages['review-result'].agents.push(TOOLED_AGENT_ID);
    });
    assert.deepEqual(reviewStageProblems(config), [
      `агент ${TOOLED_AGENT_ID} из review-result — не kind: http и не запись с command и tool_less: true`,
    ]);
  });
});

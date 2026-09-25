#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import YAML from '../lib/js-yaml.mjs';
import { findProjectRoot } from '../lib/find-root.mjs';
import { spawnAgent } from '../lib/agent-spawner.mjs';
import { writeClaudeHooks, writeKiloPluginLoader, userHasRailsHooks } from '../init.mjs';
import { loadRailsConfig } from '../rails/rails-config.mjs';
import { check as checkRailsOutput } from '../rails/output-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = findProjectRoot(process.cwd());

// Каталог скилов: по умолчанию `<корень проекта>/src/skills`, но его можно
// задать переменной WORKFLOW_SKILLS_DIR.
//
// Зачем: юнит-тесты раннера (src/tests/run-skill-tests.test.mjs) запускают его
// подпроцессом с cwd = корень репозитория — только там findProjectRoot находит
// `.workflow/`, а мок-агенты и configs/ задаются путями от корня. Скилы-фикстуры
// при этом приходилось создавать прямо в каноническом src/skills, на который
// junction'ятся все проекты: при снятии файла по таймауту каталог `__test-*`
// оставался в репозитории (так попали __test-runner-1777553217483 и
// __test-cal-001-1777553217513), а 2026-09-23 полный набор упал, поймав живую
// фикстуру в skill-test-index-agents.test.mjs. Переменная разводит две вещи:
// корень проекта (cwd) и каталог скилов.
const skillsDirOverride = process.env.WORKFLOW_SKILLS_DIR
  ? path.resolve(process.env.WORKFLOW_SKILLS_DIR)
  : null;

// current/meta.json — не временный вывод прогона, а baseline: loadBaselineMeta()
// читает его через `git show origin/main:...`, чтобы отличить previously_green
// от now_red. --skip-meta-write позволяет прогнать тесты, не трогая baseline.
let skipMetaWrite = false;

import os from 'os';
import { execSync } from 'child_process';

/**
 * Делает пути к скриптам-агентам абсолютными.
 *
 * Target-агент запускается в изолированном workdir (projectRoot: taskWorkdir),
 * но сам скрипт лежит в репозитории: и mock-агенты тестов
 * (node src/tests/fixtures/mock-agent-pass.js), и боевые script-агенты
 * pipeline.yaml (node .workflow/src/scripts/move-ticket.js) заданы путём
 * относительно корня проекта. Внутри workdir такого файла нет — node падал
 * с "Cannot find module", и L2-прогон получал errored вместо оценки.
 *
 * Переписываем только те аргументы, которые действительно существуют в корне:
 * флаги и произвольные строки остаются как есть.
 */
function resolveAgentScriptArgs(agentConfig) {
  const SCRIPT_EXT = /\.(js|mjs|cjs|ts|py|sh)$/;
  const args = (agentConfig.args || []).map(arg => {
    if (typeof arg !== 'string' || arg.startsWith('-') || path.isAbsolute(arg)) return arg;
    if (!SCRIPT_EXT.test(arg)) return arg;
    const abs = path.resolve(projectRoot, arg);
    return fs.existsSync(abs) ? abs : arg;
  });
  return { ...agentConfig, args };
}

// ============================================================================
// Rails integration (src/rails/README.md §11) — окружение целевого агента и
// output-check по завершении. Ядро rails — отдельный пакет работ; здесь
// только интеграция раннера тестов скилов (wp5).
// ============================================================================

// Таймаут судьи (сек): `execution.judge_timeout_s` в tests/index.yaml скила, иначе 180.
// Был жёстко 60 с — на длинных ответах коуча судья не успевал (TC-COACH-001/002, 2026-09-21/22),
// trial оставался без оценки.
let JUDGE_TIMEOUT_S = 180;

function railsYamlExists(root, skill) {
  if (!skill) return false;
  try {
    return fs.existsSync(path.join(root, '.workflow', 'src', 'skills', skill, 'rails.yaml'));
  } catch {
    return false;
  }
}

/** Файл состояния сессии rails с данным `run` (§5: поле `run`), или null. */
function findRailsStateByRun(root, run) {
  if (!run) return null;
  const dir = path.join(root, '.workflow', 'state', 'rails');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (state && state.run === run) return state;
    } catch {
      // повреждённый/недописанный файл состояния — пропускаем.
    }
  }
  return null;
}

/**
 * Вызывает целевого агента (`WORKFLOW_RAILS_ROLE=coordinator`) и, если у
 * скила есть `rails.yaml`, проверяет финальный ответ через output-check по
 * состоянию с этим `run`; при нарушении — один повтор с вердиктом в начале
 * промпта (§8, §11). Без rails.yaml у скила или без найденного состояния
 * (рельсы не были задействованы в этом запуске) — поведение как раньше.
 *
 * Открытый вопрос (спецификация не уточняет): отсутствие состояния при
 * наличии rails.yaml трактуется как «рельсы не зацепились» и check не
 * запускается — простое решение без риска ложных повторов, когда хуки в
 * workdir по какой-то причине не сработали.
 *
 * @returns {Promise<object>} результат spawnAgent (плюс railsRetried/railsVerdict при повторе)
 */
async function spawnTargetAgentWithRailsCheck(agentConfig, prompt, spawnOpts, root, skill) {
  const hasRails = railsYamlExists(root, skill);
  const runId = crypto.randomUUID();
  const railsOpts = hasRails
    ? { railsRole: 'coordinator', railsSkill: skill, railsRun: runId }
    : {};

  const result = await spawnAgent(agentConfig, prompt, { ...spawnOpts, ...railsOpts });
  if (!hasRails) return result;

  let config;
  try {
    config = loadRailsConfig(path.join(root, '.workflow', 'src', 'skills', skill));
  } catch {
    return result;
  }

  const state = findRailsStateByRun(root, runId);
  if (!state) return result;

  const verdict = checkRailsOutput(result.output || '', config, state);
  if (verdict.ok) return result;

  console.log(`[Runner] rails: output-check нарушен для ${skill}, повтор с вердиктом — отсутствует: ${verdict.missing.join('; ')}`);

  const verdictText = `RAILS: предыдущий ответ отклонён output-check — отсутствует: ${verdict.missing.join('; ')}. Исправь и ответь заново.\n\n`;
  const retryResult = await spawnAgent(agentConfig, verdictText + prompt, {
    ...spawnOpts,
    railsRole: 'coordinator',
    railsSkill: skill,
    railsRun: crypto.randomUUID()
  });
  retryResult.railsRetried = true;
  retryResult.railsVerdict = verdict;
  return retryResult;
}

function createTestWorkdir(skillName, suffix = '') {
  const prefix = suffix ? `wf-test-${skillName}-${suffix}-` : `wf-test-${skillName}-`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workflowDir = path.join(tmpRoot, '.workflow');
  fs.mkdirSync(workflowDir, { recursive: true });
  for (const sub of ['tickets/backlog', 'tickets/ready', 'tickets/in-progress', 'tickets/review', 'tickets/done', 'tickets/archive', 'plans/current', 'plans/archive', 'reports', 'logs']) {
    fs.mkdirSync(path.join(workflowDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(workflowDir, 'coach-backlog.yaml'), 'version: 1\nanalyzed_tickets: []\naudited_skills: {}\n', 'utf8');

  const srcDir = path.join(workflowDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  // Тот же каталог, откуда взят прогоняемый скил (findSkillsDir), иначе агент в
  // workdir не увидел бы скила из WORKFLOW_SKILLS_DIR.
  const realSkills = findSkillsDir();
  const realScripts = path.join(projectRoot, 'src', 'scripts');
  const realRails = path.join(projectRoot, 'src', 'rails');
  const linkSkills = path.join(srcDir, 'skills');
  const linkScripts = path.join(srcDir, 'scripts');
  const linkRails = path.join(srcDir, 'rails');
  const configDir = path.join(workflowDir, 'config');
  const realConfigs = path.join(projectRoot, 'configs');

  // Skills are COPIED (not junctioned) so that agents cannot write to real source files.
  fs.cpSync(realSkills, linkSkills, { recursive: true, dereference: true });

  // Scripts, configs and rails are junctioned — read-only for agents in practice.
  if (process.platform === 'win32') {
    try { execSync(`mklink /J "${linkScripts}" "${realScripts}"`, { stdio: 'pipe', shell: true }); } catch {}
    try { execSync(`mklink /J "${configDir}" "${realConfigs}"`, { stdio: 'pipe', shell: true }); } catch {}
    if (fs.existsSync(realRails)) {
      try { execSync(`mklink /J "${linkRails}" "${realRails}"`, { stdio: 'pipe', shell: true }); } catch {}
    }
  } else {
    try { fs.symlinkSync(realScripts, linkScripts, 'dir'); } catch {}
    try { fs.symlinkSync(realConfigs, configDir, 'dir'); } catch {}
    if (fs.existsSync(realRails)) {
      try { fs.symlinkSync(realRails, linkRails, 'dir'); } catch {}
    }
  }

  // rails/README.md §11: те же хуки/загрузчик, что `workflow init` пишет в
  // реальном проекте — судья/целевой агент в изолированном workdir видит
  // тот же rails, что и на настоящем проекте.
  if (fs.existsSync(realRails)) {
    // Хуки Claude уже у пользователя (~/.claude/settings.json, register-rails.js --user) —
    // workdir-копия не нужна: тот же вызов пришёл бы дважды (core дедуплицирует, но
    // второй процесс хука всё равно платится). Kilo-плагин — только проектный.
    // WORKFLOW_RAILS_WORKDIR_HOOKS: always | never | auto (по умолчанию — писать, если
    // у пользователя хуков rails нет).
    const mode = process.env.WORKFLOW_RAILS_WORKDIR_HOOKS || 'auto';
    if (mode === 'always' || (mode !== 'never' && !userHasRailsHooks())) {
      try { writeClaudeHooks(tmpRoot); } catch {}
    }
    try { writeKiloPluginLoader(tmpRoot); } catch {}
  }

  return tmpRoot;
}

function cleanupTestWorkdir(tmpRoot) {
  if (!tmpRoot || !fs.existsSync(tmpRoot)) return;
  // Remove junctions first so that their targets are not touched by rmSync.
  // src/rails снимается первым (rails/README.md §11).
  if (process.platform === 'win32') {
    for (const link of ['src/rails', 'src/scripts', 'config']) {
      const p = path.join(tmpRoot, '.workflow', link);
      try { execSync(`rmdir "${p}"`, { stdio: 'pipe', shell: true }); } catch {}
    }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// Вход сценария kind: dir — каталог фикстуры раскладывается в рабочий каталог
// прогона, dest_dir отсчитывается от его корня. До 2026-09-24 такой вход молча
// пропускался: агент TC-EXECUTE-TASK-008 не находил файлов проекта.
// В рабочем каталоге лежат junction'ы на настоящие src/scripts, src/rails и
// configs (createTestWorkdir): запись сквозь них попала бы в репозиторий. Поэтому
// путь назначения строится по одному сегменту, и любая ссылка на нём — ошибка;
// ссылки внутри самой фикстуры тоже не копируются.
function copyFixtureDir(srcDir, workdir, destDir, caseId) {
  if (!workdir) {
    throw new Error(`dir input requires task workdir (case ${caseId})`);
  }
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`dir fixture not found: ${srcDir}`);
  }
  const root = path.resolve(workdir);
  const destRel = path.relative(root, path.resolve(root, destDir));
  if (destRel === '..' || destRel.startsWith(`..${path.sep}`) || path.isAbsolute(destRel)) {
    throw new Error(`dir input dest_dir leaves task workdir: ${destDir} (case ${caseId})`);
  }

  // Создаёт каталоги по пути rel внутри root, не проходя через ссылки.
  function ensureDirInside(rel) {
    let current = root;
    for (const segment of rel.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (!fs.existsSync(current)) {
        fs.mkdirSync(current);
        continue;
      }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`dir input path crosses a link: ${path.relative(root, current)} (case ${caseId})`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`dir input path is not a directory: ${path.relative(root, current)} (case ${caseId})`);
      }
    }
    return current;
  }

  function copyTree(fromDir, toRel) {
    const toDir = ensureDirInside(toRel);
    for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
      const from = path.join(fromDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`dir fixture contains a link: ${from}`);
      }
      if (entry.isDirectory()) {
        copyTree(from, path.join(toRel, entry.name));
      } else if (entry.isFile()) {
        const to = path.join(toDir, entry.name);
        if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) {
          throw new Error(`dir input target is a link: ${path.relative(root, to)} (case ${caseId})`);
        }
        fs.copyFileSync(from, to);
      }
    }
  }

  copyTree(srcDir, destRel);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    skill: null,
    caseId: null,
    tag: null,
    layer: null,
    relevant: null,
    all: false,
    agent: null,
    primaryOnly: false,
    skipSecretScan: false,
    fast: false,
    yes: false,
    baselineRef: null,
    establishBaseline: false,
    calibrate: false,
    severity: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--calibrate') {
      opts.calibrate = true;
    } else if (arg === '--skill' && args[i + 1]) {
      opts.skill = args[i + 1];
      i++;
    } else if (arg === '--case' && args[i + 1]) {
      opts.caseId = args[i + 1];
      i++;
    } else if (arg === '--tag' && args[i + 1]) {
      opts.tag = args[i + 1];
      i++;
    } else if (arg === '--layer' && args[i + 1]) {
      opts.layer = args[i + 1];
      i++;
    } else if (arg === '--relevant' && args[i + 1]) {
      opts.relevant = args[i + 1];
      i++;
    } else if (arg === '--baseline-ref' && args[i + 1]) {
      opts.baselineRef = args[i + 1];
      i++;
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--agent' && args[i + 1]) {
      opts.agent = args[i + 1];
      i++;
    } else if (arg === '--primary-only') {
      opts.primaryOnly = true;
    } else if (arg === '--skip-secret-scan') {
      opts.skipSecretScan = true;
    } else if (arg === '--skip-meta-write') {
      opts.skipMetaWrite = true;
    } else if (arg === '--fast') {
      opts.fast = true;
    } else if (arg === '--yes') {
      opts.yes = true;
    } else if (arg === '--establish-baseline') {
      opts.establishBaseline = true;
    } else if (arg === '--pipeline' && args[i + 1]) {
      opts.pipeline = args[i + 1];
      i++;
    } else if (arg === '--severity' && args[i + 1]) {
      opts.severity = args[i + 1];
      i++;
    }
  }

  return opts;
}

function findSkillsDir() {
  return skillsDirOverride || path.join(projectRoot, 'src', 'skills');
}

function findSkillTestsDir(skillName) {
  return path.join(findSkillsDir(), skillName, 'tests');
}

function loadIndexYaml(skillName) {
  const testsDir = findSkillTestsDir(skillName);
  const indexPath = path.join(testsDir, 'index.yaml');
  
  if (!fs.existsSync(indexPath)) {
    throw new Error(`index.yaml not found for skill: ${skillName}`);
  }
  
  const content = fs.readFileSync(indexPath, 'utf8');
  return YAML.load(content);
}

function getBaselineRef(skillName, explicitRef) {
  if (explicitRef) {
    return explicitRef;
  }
  
  const index = loadIndexYaml(skillName);
  return index.baseline_ref || 'origin/main';
}

function gitShow(baselineRef, filePath) {
  if (process.env.TEST_GIT_MOCK) {
    return new Promise((resolve) => {
      try {
        const mocks = JSON.parse(fs.readFileSync(process.env.TEST_GIT_MOCK, 'utf8'));
        // Нормализируем путь для кроссплатформности (Windows использует \, но mocks используют /)
        const normalizedPath = filePath.replace(/\\/g, '/');
        const key = `${baselineRef}:${normalizedPath}`;
        if (mocks[key]) {
          resolve(mocks[key]);
        } else if (mocks.__error && mocks.__error[key]) {
          throw new Error(mocks.__error[key]);
        } else {
          resolve(null);
        }
      } catch (e) {
        resolve(null);
      }
    });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['show', `${baselineRef}:${filePath}`], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else if (stderr.includes('does not exist') || code === 128) {
        resolve(null);
      } else {
        reject(new Error(`git show failed: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function loadBaselineMeta(skillName, caseId, baselineRef) {
  const casesDir = path.join('src', 'skills', skillName, 'tests', 'cases', caseId);
  const metaPath = path.join(casesDir, 'current', 'meta.json');
  
  const gitMetaContent = await gitShow(baselineRef, metaPath);
  
  if (!gitMetaContent) {
    return null;
  }
  
  try {
    return JSON.parse(gitMetaContent);
  } catch {
    return null;
  }
}

async function analyzeGitHeadComparison(skillName, cases, baselineRef, currentRunStatuses = {}) {
  console.error(`[DEBUG] analyzeGitHeadComparison called`);
  console.log(`[Runner] analyzeGitHeadComparison called with ${cases.length} cases, skillName=${skillName}`);

  const comparison = {
    previously_green: 0,
    previously_green_still_green: 0,
    previously_green_now_red: 0,
    previously_red: 0,
    previously_red_still_red: 0,
    previously_red_now_green: 0,
    new_cases: 0
  };

  let hasBaselineHistory = false;

  console.log(`[Runner] Starting to iterate ${cases.length} cases`);
  for (const caseDef of cases) {
    console.log(`[Runner] Checking case ${caseDef.id} for git history`);
    let baselineMeta = null;
    try {
      baselineMeta = await loadBaselineMeta(skillName, caseDef.id, baselineRef);
      console.log(`[Runner] loadBaselineMeta result for ${caseDef.id}:`, baselineMeta ? 'found' : 'not found');

      if (!baselineMeta) {
        comparison.new_cases++;
        continue;
      }

      hasBaselineHistory = true;

      const prevStatus = baselineMeta.status;
      // Используем текущий статус из памяти (результат прогона), а не с диска
      const currentStatus = currentRunStatuses[caseDef.id] || 'unknown';

      if (prevStatus === 'passed') {
        comparison.previously_green++;
        if (currentStatus === 'passed') {
          comparison.previously_green_still_green++;
        } else if (currentStatus === 'failed' || currentStatus === 'error') {
          comparison.previously_green_now_red++;
        }
      } else if (prevStatus === 'failed' || prevStatus === 'error') {
        comparison.previously_red++;
        if (currentStatus === 'failed' || currentStatus === 'error') {
          comparison.previously_red_still_red++;
        } else if (currentStatus === 'passed') {
          comparison.previously_red_now_green++;
        }
      }
    } catch (err) {
      console.error(`[Runner] Error loading baseline meta for ${caseDef.id}:`, err.message);
      throw err;
    }
  }
  
  const mode = hasBaselineHistory ? 'no-regression' : 'no-baseline';
  console.log(`[Runner] analyzeGitHeadComparison: hasBaselineHistory=${hasBaselineHistory}, mode=${mode}, cases_checked=${Object.keys(comparison).reduce((sum, key) => sum + (comparison[key] || 0), 0)}`);

  return { comparison, mode };
}

function computeVerdict(comparison, mode, relevantCaseStatus, establishBaseline) {
  // Priority 1: Check relevant case status first
  if (relevantCaseStatus !== null && relevantCaseStatus !== 'passed') {
    return 'relevant_case_failed';
  }

  // Priority 2: Check for regression
  if (comparison.previously_green_now_red > 0) {
    return 'regression_detected';
  }

  // Priority 3: Check for no-baseline mode
  if (mode === 'no-baseline') {
    if (establishBaseline) {
      return 'baseline_established';
    }
    return 'no_baseline_failures';
  }

  // Default: ready for user review
  return 'ready_for_user_review';
}

function generateOutcomeMessage(result) {
  const { verdict, comparison, mode, relevantCase } = result;
  
  let msg = `Verdict: ${verdict}. `;
  
  if (mode === 'no-baseline') {
    msg += `Mode: no-baseline (no baseline history found). `;
  } else {
    msg += `Mode: no-regression. `;
  }
  
  msg += `Green→Red: ${comparison.previously_green_now_red}/${comparison.previously_green}. `;
  msg += `Red→Green: ${comparison.previously_red_now_green}/${comparison.previously_red}. `;
  msg += `New cases: ${comparison.new_cases}.`;
  
  if (relevantCase) {
    msg += ` Relevant case (${relevantCase.id}): ${relevantCase.status}.`;
  }
  
  return msg;
}

function resolvePipelineYaml(overridePath = null) {
  if (overridePath) {
    const resolved = path.resolve(overridePath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    throw new Error(`Pipeline not found: ${overridePath}`);
  }

  const projectRootDir = findProjectRoot(process.cwd());
  const workflowConfigPath = path.join(projectRootDir, '.workflow', 'config', 'pipeline.yaml');
  // Корень пакета — там, где лежит сам раннер (`src/scripts/` → два уровня
  // вверх), а не родитель корня проекта. Прежде здесь стоял
  // `path.dirname(projectRootDir)`, и в репозитории workflow-ai поиск уходил в
  // `D:\Dev\configs\pipeline.yaml` вместо `D:\Dev\workflowAi\configs\…`:
  // запасной путь не срабатывал ни разу, а без рабочей `.workflow/config/`
  // раннер падал с `pipeline.yaml not found`.
  const packageRoot = path.resolve(__dirname, '..', '..');
  const packageConfigPath = path.join(packageRoot, 'configs', 'pipeline.yaml');

  if (fs.existsSync(workflowConfigPath)) {
    return workflowConfigPath;
  }

  if (fs.existsSync(packageConfigPath)) {
    return packageConfigPath;
  }

  throw new Error('pipeline.yaml not found in .workflow/config/ or configs/');
}

function loadPipelineConfig(pipelinePath = null) {
  const resolvedPath = resolvePipelineYaml(pipelinePath);
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const config = YAML.load(content);
  console.log(`[Runner] Using pipeline.yaml: ${resolvedPath}`);
  return config.pipeline || config;
}

// role: 'target' — исполнитель кейса (target_agents скила или кейса, --agent);
// 'judge' — судья. Безынструментный агент (`kind: http`) выполнить скил не может:
// у него нет ни инструментов, ни файлов. Исполнителем он отклоняется до первого
// вызова модели; судьёй допустим (PLAN-001).
function validateAgents(agentIds, pipelineConfig, { role = 'target' } = {}) {
  const agents = pipelineConfig.agents || {};
  const availableAgents = Object.keys(agents);
  const invalid = [];

  for (const agentId of agentIds) {
    if (!availableAgents.includes(agentId)) {
      invalid.push(agentId);
    }
  }

  if (invalid.length > 0) {
    throw new Error(`Agent(s) '${invalid.join(', ')}' from target_agents[] not found in pipeline.yaml → agents[]`);
  }

  if (role === 'target') {
    const toolLess = agentIds.filter(id => agents[id]?.kind === 'http');
    if (toolLess.length > 0) {
      throw new Error(`Agent(s) '${toolLess.join(', ')}' are tool-less (kind: http) and cannot execute skill test cases: no tools, no files`);
    }
  }

  return true;
}

function loadTestCase(skillName, caseFile) {
  const testsDir = findSkillTestsDir(skillName);
  const casePath = path.join(testsDir, caseFile);
  
  if (!fs.existsSync(casePath)) {
    throw new Error(`Test case not found: ${casePath}`);
  }
  
  const content = fs.readFileSync(casePath, 'utf8');
  return YAML.load(content);
}

function filterCasesByTag(cases, tag) {
  if (!tag) return cases;
  return cases.filter(c => c.tags && c.tags.includes(tag));
}

function filterCasesBySeverity(cases, severity) {
  if (!severity) return cases;
  return cases.filter(c => c.severity === severity);
}

function getAllSkillNamesWithTests() {
  const skillsDir = findSkillsDir();
  const entries = fs.readdirSync(skillsDir);
  const skillNames = [];
  for (const entry of entries) {
    const fullPath = path.join(skillsDir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const indexPath = path.join(fullPath, 'tests', 'index.yaml');
        if (fs.existsSync(indexPath)) {
          skillNames.push(entry);
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return skillNames;
}

function runSecretScan() {
  return new Promise((resolve) => {
    const scannerPath = path.join(projectRoot, 'src', 'scripts', 'scan-fixtures-for-secrets.js');
    console.log('[Runner] Running secret scan before L2...');
    
    const proc = spawn(process.execPath, [scannerPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    
    proc.on('close', (code) => {
      if (code === 0 || stdout.includes('status: passed')) {
        console.log('[Runner] Secret scan passed');
        resolve({ passed: true });
      } else {
        console.log('[Runner] Secret scan FAILED - secrets detected:');
        console.log(stdout);
        if (stderr) console.error(stderr);
        resolve({ passed: false, output: stdout });
      }
    });
    
    proc.on('error', (err) => {
      console.error('[Runner] Secret scan error:', err.message);
      resolve({ passed: true });
    });
  });
}

function runL0Assertions(skillName, testCase) {
  const assertions = testCase.assertions?.static || [];
  const results = [];
  
  for (const assertion of assertions) {
    if (assertion.kind === 'skill_contains') {
      const skillFile = path.join(findSkillsDir(), skillName, assertion.file || 'SKILL.md');
      
      if (!fs.existsSync(skillFile)) {
        results.push({
          passed: false,
          kind: assertion.kind,
          reason: assertion.reason,
          error: `Skill file not found: ${skillFile}`
        });
        continue;
      }
      
      const skillContent = fs.readFileSync(skillFile, 'utf8');
      const regex = new RegExp(assertion.pattern, 'i');
      const matches = regex.test(skillContent);
      
      results.push({
        passed: matches,
        kind: assertion.kind,
        reason: assertion.reason,
        pattern: assertion.pattern
      });
    }
  }
  
  return results;
}

function runL1Assertions(output, testCase) {
  const assertions = testCase.assertions?.deterministic || [];
  const results = [];
  
  const outputDependentKinds = ['output_contains_all', 'output_matches', 'output_does_not_contain', 'output_yaml_shape', 'is_json'];
  if (!output && assertions.some(a => outputDependentKinds.includes(a.kind))) {
    return assertions.map(a => ({
      passed: true,
      skipped: true,
      kind: a.kind,
      reason: 'No agent output available (L2 not run)'
    }));
  }
  
  for (const assertion of assertions) {
    if (assertion.kind === 'output_contains_all') {
      const missing = [];
      for (const val of assertion.values || []) {
        if (!output.includes(val)) {
          missing.push(val);
        }
      }
      results.push({
        passed: missing.length === 0,
        kind: assertion.kind,
        missing,
        values: assertion.values
      });
    } else if (assertion.kind === 'output_matches') {
      const regex = new RegExp(assertion.regex);
      const matches = regex.test(output);
      results.push({
        passed: matches,
        kind: assertion.kind,
        regex: assertion.regex
      });
    } else if (assertion.kind === 'output_does_not_contain') {
      const found = [];
      for (const val of assertion.values || []) {
        if (output.includes(val)) {
          found.push(val);
        }
      }
      results.push({
        passed: found.length === 0,
        kind: assertion.kind,
        found,
        values: assertion.values
      });
    } else if (assertion.kind === 'output_yaml_shape') {
      try {
        const parsed = YAML.load(output);
        const hasKeys = assertion.required_keys?.every(k => parsed && typeof parsed[k] !== 'undefined');
        results.push({
          passed: hasKeys,
          kind: assertion.kind,
          required_keys: assertion.required_keys
        });
      } catch (e) {
        results.push({
          passed: false,
          kind: assertion.kind,
          error: e.message
        });
      }
    } else if (assertion.kind === 'is_json') {
      try {
        JSON.parse(output);
        results.push({
          passed: true,
          kind: assertion.kind
        });
      } catch (e) {
        results.push({
          passed: false,
          kind: assertion.kind,
          error: e.message
        });
      }
    } else {
      results.push({
        passed: false,
        kind: assertion.kind,
        error: `Unknown assertion kind: ${assertion.kind}`
      });
    }
  }
  
  return results;
}

function getSkillSha(skillName) {
  const skillsDir = findSkillsDir();
  const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
  
  if (!fs.existsSync(skillFile)) {
    return 'unknown';
  }
  
  const content = fs.readFileSync(skillFile, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 7);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadRubric(skillName, rubricName) {
  const rubricPath = path.join(findSkillsDir(), skillName, 'tests', 'rubrics', `${rubricName}.md`);
  if (!fs.existsSync(rubricPath)) {
    throw new Error(`Rubric not found: ${rubricPath}`);
  }
  return fs.readFileSync(rubricPath, 'utf8');
}

function findCalibrationFiles(skillName) {
  const rubricsDir = path.join(findSkillsDir(), skillName, 'tests', 'rubrics', 'calibration');
  if (!fs.existsSync(rubricsDir)) {
    return [];
  }

  const files = fs.readdirSync(rubricsDir);
  const calibrationMap = {};

  for (const file of files) {
    const match = file.match(/^(.+)-good\.md$/);
    if (match) {
      const rubricName = match[1];
      const goodPath = path.join(rubricsDir, file);
      const badPath = path.join(rubricsDir, `${rubricName}-bad.md`);
      const rubricPath = path.join(findSkillsDir(), skillName, 'tests', 'rubrics', `${rubricName}.md`);

      if (fs.existsSync(badPath) && fs.existsSync(rubricPath)) {
        calibrationMap[rubricName] = {
          good: goodPath,
          bad: badPath,
          rubric: rubricPath
        };
      }
    }
  }

  return calibrationMap;
}

function extractPassThreshold(rubricContent) {
  const match = rubricContent.match(/score\s*≥\s*(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 4;
}

async function runCalibrationCheck(skillName, rubricName, calibrationFiles, pipelineConfig, judgeAgentId) {
  const judgeAgentConfig = pipelineConfig.agents[judgeAgentId];
  if (!judgeAgentConfig) {
    throw new Error(`Judge agent not found: ${judgeAgentId}`);
  }

  const rubricContent = fs.readFileSync(calibrationFiles.rubric, 'utf8');
  const threshold = extractPassThreshold(rubricContent);

  const goodContent = fs.readFileSync(calibrationFiles.good, 'utf8');
  const badContent = fs.readFileSync(calibrationFiles.bad, 'utf8');

  const judgePrompt = (agentOutput, task) => `You are a judge evaluating the output of an AI agent.

## Rubric
${rubricContent}

## Target Agent Output
${agentOutput}

## Task
${task}

Please evaluate the output according to the rubric and provide a score from 1 to 5.
Output format:
---RESULT---
score: <number 1-5>
reason: <brief explanation>
---RESULT---`;

  const extractGoodResponse = (content) => {
    const match = content.match(/## Ответ агента[\s\S]*?^---$/m);
    return match ? match[0] : content;
  };

  const goodOutput = extractGoodResponse(goodContent);
  const badOutput = extractGoodResponse(badContent);

  // Судьи калибровки идут в каталоге раннера, то есть в настоящем проекте. Писать им
  // незачем: граница записи — пустой временный каталог, снимается после вызова.
  const calibSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-calib-'));
  const calibOpts = { timeout: JUDGE_TIMEOUT_S, railsRole: 'executor', env: { WORKFLOW_SANDBOX_ROOT: calibSandbox } };
  let goodResult;
  let badResult;
  try {
    [goodResult, badResult] = await Promise.all([
      spawnAgent(judgeAgentConfig, judgePrompt(goodOutput, 'Evaluate the good response'), calibOpts),
      spawnAgent(judgeAgentConfig, judgePrompt(badOutput, 'Evaluate the bad response'), calibOpts)
    ]);
  } finally {
    try { fs.rmSync(calibSandbox, { recursive: true, force: true }); } catch {}
  }

  const goodScore = parseJudgeResult(goodResult.output)?.score || 3;
  const badScore = parseJudgeResult(badResult.output)?.score || 3;

  return {
    rubricName,
    threshold,
    goodScore,
    badScore,
    goodPassed: goodScore >= threshold,
    badPassed: badScore < threshold
  };
}

async function runCalibrationGate(skillName, pipelineConfig) {
  const judgeAgent = loadIndexYaml(skillName).execution?.judge_agent;
  if (!judgeAgent) {
    console.log('[Runner] No judge_agent configured, skipping calibration gate');
    return { passed: true, calibrations: [] };
  }

  const calibrationMap = findCalibrationFiles(skillName);

  if (Object.keys(calibrationMap).length === 0) {
    console.log('[Runner] No calibration files found, skipping calibration gate');
    return { passed: true, calibrations: [], warnings: ['calibration files absent'] };
  }

  const results = [];
  const warnings = [];

  for (const [rubricName, files] of Object.entries(calibrationMap)) {
    console.log(`[Runner] Calibrating rubric: ${rubricName}`);
    const result = await runCalibrationCheck(skillName, rubricName, files, pipelineConfig, judgeAgent);
    results.push(result);

    if (!result.goodPassed) {
      console.error(`[Runner] ABORT: judge miscalibrated — rubric '${rubricName}' requires fix (good score=${result.goodScore}, expected ≥${result.threshold})`);
      return {
        passed: false,
        calibrations: results,
        error: `judge miscalibrated — rubric '${rubricName}' requires fix (good score=${result.goodScore}, expected ≥${result.threshold})`
      };
    }

    if (!result.badPassed) {
      console.error(`[Runner] ABORT: judge miscalibrated — rubric '${rubricName}' requires fix (bad score=${result.badScore}, expected <${result.threshold})`);
      return {
        passed: false,
        calibrations: results,
        error: `judge miscalibrated — rubric '${rubricName}' requires fix (bad score=${result.badScore}, expected <${result.threshold})`
      };
    }

    console.log(`[Runner] ${rubricName}: good=${result.goodScore} (≥${result.threshold}), bad=${result.badScore} (<${result.threshold}) ✓`);
  }

  return { passed: true, calibrations: results, warnings };
}

async function writeTrialOutput(skillName, caseId, agentId, trialNum, output) {
  const skillsDir = findSkillsDir();
  const trialDir = path.join(skillsDir, skillName, 'tests', 'cases', caseId, 'current');
  ensureDir(trialDir);
  
  const trialFile = path.join(trialDir, `${agentId}/trial-${trialNum}.md`);
  const agentDir = path.join(trialDir, agentId);
  ensureDir(agentDir);
  
  fs.writeFileSync(trialFile, output, 'utf8');
  return trialFile;
}

/**
 * Сохраняет улики rails из изолированного workdir до его удаления
 * (rails/README.md §10, §12 концепции — журнал отказов как обратная связь для
 * правки графа): журнал `rails-denials.jsonl` → `current/<agent>/rails-trial-N.jsonl`,
 * состояние сессии → `current/<agent>/rails-state-trial-N.json`. Без них workdir
 * уносил с собой всю историю отказов прогона.
 */
function persistRailsArtifacts(taskWorkdir, skillName, caseId, agentId, trialNum) {
  try {
    const skillsDir = findSkillsDir();
    const agentDir = path.join(skillsDir, skillName, 'tests', 'cases', caseId, 'current', agentId);
    const journal = path.join(taskWorkdir, '.workflow', 'logs', 'rails-denials.jsonl');
    const stateDir = path.join(taskWorkdir, '.workflow', 'state', 'rails');
    const hasJournal = fs.existsSync(journal);
    const states = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')) : [];
    if (!hasJournal && states.length === 0) return;
    ensureDir(agentDir);
    if (hasJournal) fs.copyFileSync(journal, path.join(agentDir, `rails-trial-${trialNum}.jsonl`));
    if (states.length > 0) {
      // Один прогон — одна сессия целевого агента; при нескольких берём самую свежую.
      const newest = states
        .map((f) => ({ f, m: fs.statSync(path.join(stateDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0].f;
      fs.copyFileSync(path.join(stateDir, newest), path.join(agentDir, `rails-state-trial-${trialNum}.json`));
    }
  } catch (err) {
    console.log(`[Runner] rails: не удалось сохранить улики workdir (${err.message})`);
  }
}

async function writeJudgeResults(skillName, caseId, results) {
  const skillsDir = findSkillsDir();
  const caseDir = path.join(skillsDir, skillName, 'tests', 'cases', caseId, 'current');
  ensureDir(caseDir);

  const judgePath = path.join(caseDir, 'judge.json');
  let judgeData = { per_model: {}, rubric_scores: [], timestamp: new Date().toISOString() };
  if (fs.existsSync(judgePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(judgePath, 'utf8'));
      judgeData.per_model = existing.per_model || {};
      judgeData.rubric_scores = existing.rubric_scores || [];
    } catch {}
  }

  const newAgentIds = new Set(Object.keys(results.per_model || {}));
  judgeData.rubric_scores = judgeData.rubric_scores.filter(r => !newAgentIds.has(r.agentId));
  for (const r of (results.rubric_scores || [])) {
    judgeData.rubric_scores.push(r);
  }

  for (const [agentId, modelData] of Object.entries(results.per_model || {})) {
    judgeData.per_model[agentId] = {
      pass_count: modelData.pass_count,
      total: modelData.total,
      trials: (modelData.trials || []).map(t => ({
        trial: t.trial,
        score: t.score,
        passed: t.passed
      }))
    };
  }

  judgeData.timestamp = new Date().toISOString();

  fs.writeFileSync(judgePath, JSON.stringify(judgeData, null, 2), 'utf8');
}

async function preFlightApproval(numCases, numModels, trials, judgeAgentCost = 0.02, targetAgentCost = 0.01) {
  const totalLlms = numCases * numModels * trials;
  const judgeCalls = numCases * numModels * trials;
  const targetCalls = numCases * numModels * trials;
  const estimatedCost = (judgeCalls * judgeAgentCost) + (targetCalls * targetAgentCost);
  
  console.log(`[Runner] Estimated LLM calls: ${totalLlms} (target: ${targetCalls}, judge: ${judgeCalls})`);
  console.log(`[Runner] Estimated cost: ~$${estimatedCost.toFixed(2)}`);
  
  if (!process.argv.includes('--yes')) {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    
    return new Promise((resolve) => {
      rl.question(`Estimated ${totalLlms} LLM calls ($${estimatedCost.toFixed(2)}). Continue? [y/N] `, (answer) => {
        rl.close();
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          resolve(true);
        } else {
          console.log('[Runner] Aborted by user');
          process.exit(0);
        }
      });
    });
  }
  
  return true;
}

async function runL2Evaluation(skillName, testCase, caseDef, targetAgents, judgeAgentId, pipelineConfig, options = {}) {
  const { trials = 3, timeout = 300 } = options;
  
  const judgeAgentConfig = pipelineConfig.agents[judgeAgentId];
  if (!judgeAgentConfig) {
    throw new Error(`Judge agent not found: ${judgeAgentId}`);
  }

  let rubricName = 'default';
  // Вопрос, на который отвечает судья: кейсы объявляют его рядом с rubric_file.
  // До 2026-09-24 он в промпт не попадал — судья получал заглушку «Evaluate the
  // response» и оценивал по одной рубрике (замер: все 201 сохранённых вызова).
  let rubricCriterion = '';
  if (testCase.assertions?.rubric && testCase.assertions.rubric.length > 0) {
    const rubricPath = testCase.assertions.rubric[0].rubric_file;
    if (rubricPath) {
      rubricName = path.basename(rubricPath, '.md');
    }
    rubricCriterion = testCase.assertions.rubric[0].criterion || '';
  }

  const rubric = loadRubric(skillName, rubricName);
  const results = {
    per_model: {},
    rubric_scores: [],
    tokens: null
  };

  const caseId = caseDef?.id || 'unknown';

  function buildTargetPrompt(taskWorkdir) {
    let targetPrompt = '';
    const testsDir = findSkillTestsDir(skillName);
    const caseDir = caseDef?.file ? path.dirname(caseDef.file) : '';

    if (testCase.scenario?.system_prompt_file) {
      const systemPromptPath = path.join(testsDir, caseDir, testCase.scenario.system_prompt_file);
      if (fs.existsSync(systemPromptPath)) {
        targetPrompt += fs.readFileSync(systemPromptPath, 'utf8') + '\n\n';
      }
    }

    if (testCase.scenario?.extra_instructions) {
      targetPrompt += testCase.scenario.extra_instructions + '\n\n';
    }

    if (testCase.scenario?.inputs) {
      for (const input of testCase.scenario.inputs) {
        if (input.kind === 'file') {
          const fixturePath = path.join(testsDir, caseDir, input.path);
          if (fs.existsSync(fixturePath)) {
            targetPrompt += `## ${input.as || 'Input'}\n`;
            targetPrompt += fs.readFileSync(fixturePath, 'utf8') + '\n\n';
          }
        } else if (input.kind === 'inline') {
          if (input.content) {
            targetPrompt += `## ${input.as || 'Input'}\n`;
            targetPrompt += input.content + '\n\n';
          }
        } else if (input.kind === 'ticket_file') {
          const fixturePath = path.join(testsDir, caseDir, input.path);
          const destDir = input.dest_dir || 'in-progress';
          const ticketId = input.ticket_id;
          if (!ticketId) {
            throw new Error(`ticket_file input requires ticket_id (case ${caseId})`);
          }
          if (!taskWorkdir) {
            throw new Error(`ticket_file input requires task workdir (case ${caseId})`);
          }
          if (!fs.existsSync(fixturePath)) {
            throw new Error(`ticket_file fixture not found: ${fixturePath}`);
          }
          const destPath = path.join(taskWorkdir, '.workflow', 'tickets', destDir, `${ticketId}.md`);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(fixturePath, destPath);
          targetPrompt += `## Context\nticket_id: ${ticketId}\n\n`;
        } else if (input.kind === 'dir') {
          const fixtureDir = path.join(testsDir, caseDir, input.path);
          copyFixtureDir(fixtureDir, taskWorkdir, input.dest_dir || '.', caseId);
        } else {
          // Незнакомый вид входа раньше пропускался молча — агент работал без
          // данных, а кейс выглядел как провал скила.
          throw new Error(`unknown scenario input kind "${input.kind}" (case ${caseId})`);
        }
      }
    }

    if (!targetPrompt.trim()) {
      targetPrompt = testCase.prompt || testCase.input || '';
    }

    return targetPrompt;
  }
  
  const allTasks = [];
  for (const agentId of targetAgents) {
    const agentConfig = pipelineConfig.agents[agentId];
    if (!agentConfig) {
      throw new Error(`Target agent not found: ${agentId}`);
    }
    results.per_model[agentId] = {
      trials: [],
      pass_count: 0,
      total: trials
    };
    for (let trial = 1; trial <= trials; trial++) {
      allTasks.push({
        agentId,
        trial,
        agentConfig: resolveAgentScriptArgs(agentConfig),
        judgeAgentConfig,
        rubric,
        testCase
      });
    }
  }

  const allResults = await Promise.all(
    allTasks.map(async (task) => {
      const taskSuffix = `${caseId}-${task.agentId}-t${task.trial}`;
      let taskWorkdir = null;
      try {
        taskWorkdir = createTestWorkdir(skillName, taskSuffix);
        const targetPrompt = buildTargetPrompt(taskWorkdir);
        // WORKFLOW_SANDBOX_ROOT — граница записи для хука рельс (core.decide,
        // «песочница тестов»): 2026-09-23 агенты кейсов create-plan и decompose-plan
        // записали планы и тикеты в настоящий проект.
        const targetOutput = await spawnTargetAgentWithRailsCheck(task.agentConfig, targetPrompt, {
          timeout,
          stageId: `${caseId}-${task.agentId}-trial-${task.trial}`,
          projectRoot: taskWorkdir,
          env: { WORKFLOW_SANDBOX_ROOT: taskWorkdir }
        }, taskWorkdir, skillName);

        // Snapshot ticket files after target-run (for judge to inspect actual file state).
        let ticketFilesSection = '';
        const ticketInputs = (testCase.scenario?.inputs || []).filter(i => i.kind === 'ticket_file');
        for (const input of ticketInputs) {
          const ticketPath = path.join(
            taskWorkdir,
            '.workflow', 'tickets',
            input.dest_dir || 'in-progress',
            `${input.ticket_id}.md`
          );
          if (fs.existsSync(ticketPath)) {
            const content = fs.readFileSync(ticketPath, 'utf8');
            ticketFilesSection += `\n## Ticket File After Execution — ${input.ticket_id} (${input.dest_dir || 'in-progress'}/)\n\n\`\`\`markdown\n${content}\n\`\`\`\n`;
          } else {
            ticketFilesSection += `\n## Ticket File After Execution — ${input.ticket_id}\n\n(file missing at ${input.dest_dir || 'in-progress'}/${input.ticket_id}.md)\n`;
          }
        }

        const judgePrompt = `You are a judge evaluating the output of an AI agent.

## Rubric
${rubric}

## Target Agent Output
${targetOutput.output || targetOutput.status || 'No output'}
${ticketFilesSection}
## Task
${rubricCriterion || testCase.description || testCase.name || 'Evaluate the response'}

Please evaluate the output according to the rubric and provide a score from 1 to 5.
Output format:
---RESULT---
score: <number 1-5>
reason: <brief explanation>
---RESULT---`;

        // Судья запускается в каталоге раннера, то есть в настоящем проекте, и пишет
        // ему незачем: та же граница записи, что у исполнителя.
        const judgeResult = await spawnAgent(task.judgeAgentConfig, judgePrompt, {
          timeout: JUDGE_TIMEOUT_S,
          stageId: `${caseId}-judge-${task.agentId}-trial-${task.trial}`,
          railsRole: 'executor',
          env: { WORKFLOW_SANDBOX_ROOT: taskWorkdir }
        });

        let score = 3;
        const parsed = parseJudgeResult(judgeResult.output);
        if (parsed && parsed.score) {
          score = parsed.score;
        }

        await writeTrialOutput(skillName, caseId, task.agentId, task.trial, targetOutput.output || '');

        return {
          trial: task.trial,
          agentId: task.agentId,
          score,
          output: targetOutput.output || '',
          judge_output: judgeResult.output || '',
          passed: score >= 4,
          l1: evaluateTrialL1(targetOutput.output || '', task.testCase),
          errored: false
        };
      } catch (err) {
        console.error(`[Runner] Trial errored: ${task.agentId} trial ${task.trial} — ${err.message}`);
        try {
          await writeTrialOutput(
            skillName,
            caseId,
            task.agentId,
            task.trial,
            `# TRIAL ERRORED\n\nagent: ${task.agentId}\ntrial: ${task.trial}\nerror: ${err.message}\n`
          );
        } catch {}
        return {
          trial: task.trial,
          agentId: task.agentId,
          score: null,
          error: err.message,
          passed: false,
          errored: true
        };
      } finally {
        if (taskWorkdir) {
          persistRailsArtifacts(taskWorkdir, skillName, caseId, task.agentId, task.trial);
          cleanupTestWorkdir(taskWorkdir);
        }
      }
    })
  );

  for (const result of allResults) {
    results.per_model[result.agentId].trials.push(result);
    if (result.errored) {
      results.per_model[result.agentId].error_count = (results.per_model[result.agentId].error_count || 0) + 1;
    } else if (result.passed) {
      results.per_model[result.agentId].pass_count++;
    }
    results.rubric_scores.push({
      agentId: result.agentId,
      trial: result.trial,
      score: result.score,
      errored: !!result.errored,
      error: result.error || undefined
    });
  }
  for (const agentId of Object.keys(results.per_model)) {
    results.per_model[agentId].trials.sort((a, b) => a.trial - b.trial);
  }
  results.rubric_scores.sort((a, b) =>
    a.agentId === b.agentId ? a.trial - b.trial : a.agentId.localeCompare(b.agentId)
  );

  return results;
}

/**
 * L1-ассершены по фактическому выводу одной попытки.
 *
 * Раньше runL1Assertions вызывался ровно один раз и всегда с пустой строкой:
 * все пять видов ассершенов зависят от вывода агента, поэтому помечались
 * skipped и не исполнялись никогда — 29 из 42 кейсов канона объявляли их
 * вхолостую. Вывод уже лежит в результате попытки L2, так что проверка не
 * стоит ни одного дополнительного вызова модели.
 *
 * Пустой вывод успехом не считается: output_does_not_contain на пустой строке
 * «проходит» вакуумно — ровно тот ложный зелёный, который убрал 4de6dea.
 */
function evaluateTrialL1(output, testCase) {
  const declared = (testCase.assertions?.deterministic || []).length;
  if (declared === 0) return { declared: 0, passed: true, failures: [] };

  const results = runL1Assertions(output, testCase);
  const skipped = results.filter(r => r.skipped);
  if (skipped.length > 0) {
    return {
      declared,
      passed: false,
      skipped: true,
      failures: [`нечего проверять: вывод пуст (${skipped.length}/${declared} ассершенов)`]
    };
  }

  const failed = results.filter(r => !r.passed);
  return {
    declared,
    passed: failed.length === 0,
    failures: failed.map(formatL1Failure)
  };
}

function formatL1Failure(r) {
  switch (r.kind) {
    case 'output_contains_all':
      return `output_contains_all: нет ${JSON.stringify(r.missing || [])}`;
    case 'output_does_not_contain':
      return `output_does_not_contain: найдено ${JSON.stringify(r.found || [])}`;
    case 'output_matches':
      return `output_matches: не совпал /${r.regex}/`;
    case 'output_yaml_shape':
      return `output_yaml_shape: нет ключей ${JSON.stringify(r.required_keys || [])}`;
    default:
      return r.error ? `${r.kind}: ${r.error}` : r.kind;
  }
}

/**
 * Агрегирует L1 теми же порогами, что и L2: majority по умолчанию, все попытки
 * при aggregate: all или severity: critical.
 */
function aggregateL1Results(l2Results, testCase) {
  const perModel = {};
  for (const [agentId, modelData] of Object.entries(l2Results.per_model)) {
    const trials = modelData.trials || [];
    perModel[agentId] = {
      total: modelData.total,
      error_count: modelData.error_count || 0,
      pass_count: trials.filter(t => !t.errored && t.l1 && t.l1.passed).length
    };
  }
  return aggregateResults({ per_model: perModel }, testCase);
}

function describeL1Failures(l2Results) {
  const lines = [];
  for (const [agentId, modelData] of Object.entries(l2Results.per_model)) {
    for (const trial of modelData.trials || []) {
      for (const failure of trial.l1?.failures || []) {
        lines.push(`${agentId} trial ${trial.trial}: ${failure}`);
      }
    }
  }
  return lines;
}

function parseJudgeResult(output) {
  if (!output) return null;
  
  const scoreMatch = output.match(/score:\s*(\d+)/i);
  const reasonMatch = output.match(/reason:\s*(.+)/i);
  
  if (scoreMatch) {
    return {
      score: parseInt(scoreMatch[1], 10),
      reason: reasonMatch ? reasonMatch[1].trim() : ''
    };
  }
  
  return null;
}

function aggregateResults(results, testCase) {
  const aggregate = testCase.aggregate || 'auto';
  const severity = testCase.severity || 'normal';
  
  let useAll = aggregate === 'all';
  if (aggregate === 'auto') {
    useAll = severity === 'critical';
  }
  
  const perModelResults = {};
  
  for (const [agentId, modelData] of Object.entries(results.per_model)) {
    const passCount = modelData.pass_count;
    const errorCount = modelData.error_count || 0;
    const total = modelData.total;
    const effective = total - errorCount;
    const threshold = Math.ceil(total / 2);

    let passed;
    let errored = false;
    if (effective === 0) {
      passed = false;
      errored = true;
    } else if (useAll) {
      passed = passCount === total;
    } else {
      passed = passCount >= threshold;
    }

    perModelResults[agentId] = {
      passed,
      errored,
      pass_count: passCount,
      error_count: errorCount,
      total,
      threshold: useAll ? total : threshold
    };
  }
  
  const allModelsPassed = Object.values(perModelResults).every(m => m.passed);
  
  return {
    per_model: perModelResults,
    overall_passed: allModelsPassed
  };
}

// `currentAgents` — агенты текущего прогона (target_agents кейса или скила, либо --agent).
// Инцидент 2026-09-22: per_model сливался с прошлым прогоном без фильтра, и записи агентов,
// убранных из configs/pipeline.yaml (kilo-glm, kilo-minimax, kilo-deepseek), навсегда держали
// кейс красным: их прогоны падали с «Agent exited with code 1», новые модели проходили, а
// status считался по объединению. Теперь запись агента, которого нет в текущем списке,
// из meta.json выбрасывается (артефакты его проб остаются в каталоге кейса).
async function writeMetaJson(caseId, skillName, status, durationMs, l2Results = null, l1_skipped = null, currentAgents = null) {
  if (skipMetaWrite) return;

  const skillsDir = findSkillsDir();
  const caseDir = path.join(skillsDir, skillName, 'tests', 'cases', caseId, 'current');
  ensureDir(caseDir);

  const metaPath = path.join(caseDir, 'meta.json');
  let existing = null;
  if (fs.existsSync(metaPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {}
  }

  const meta = {
    date: new Date().toISOString(),
    skill_sha: getSkillSha(skillName),
    status,
    duration_ms: durationMs
  };

  if (l1_skipped) {
    meta.l1_skipped = true;
  }

  const mergedPerModel = (existing && existing.per_model) ? { ...existing.per_model } : {};
  let mergedRubricScores = (existing && existing.rubric_scores) ? [...existing.rubric_scores] : [];

  if (l2Results) {
    const aggregated = aggregateResults(l2Results, {});
    const newAgentIds = new Set(Object.keys(aggregated.per_model || {}));
    for (const [agentId, data] of Object.entries(aggregated.per_model || {})) {
      mergedPerModel[agentId] = data;
    }
    mergedRubricScores = mergedRubricScores.filter(r => !newAgentIds.has(r.agentId));
    for (const r of (l2Results.rubric_scores || [])) {
      mergedRubricScores.push(r);
    }
    if (l2Results.tokens) {
      meta.tokens = l2Results.tokens;
    }
  }

  if (Array.isArray(currentAgents) && currentAgents.length > 0) {
    const allowed = new Set(currentAgents);
    for (const agentId of Object.keys(mergedPerModel)) {
      if (!allowed.has(agentId)) delete mergedPerModel[agentId];
    }
    mergedRubricScores = mergedRubricScores.filter((r) => !r.agentId || allowed.has(r.agentId));
  }

  if (Object.keys(mergedPerModel).length > 0) {
    meta.per_model = mergedPerModel;
  }
  if (mergedRubricScores.length > 0) {
    meta.rubric_scores = mergedRubricScores;
  }

  const allPassed = Object.values(mergedPerModel).every(m => m.passed);
  if (Object.keys(mergedPerModel).length > 0) {
    meta.status = allPassed ? 'passed' : 'failed';
  }

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

async function runTestsForSkill(skillName, opts) {
  console.log(`[Runner] Per-task isolated workdirs will be created for each (case × agent × trial)`);
  const result = {
    skill: skillName,
    status: 'passed',
    total: 0,
    current_run: { passed: 0, failed: 0, no_coverage: 0 },
    baseline_ref: 'origin/main',
    target_agents: [],
    judge_agent: null
  };
  let cases = [];
  const currentRunStatuses = {};

  try {
    const index = loadIndexYaml(skillName);
    const pipelineConfig = loadPipelineConfig(opts.pipeline || null);

    const defaultTargetAgents = index.execution?.target_agents || [];
    const judgeAgent = index.execution?.judge_agent || null;
    JUDGE_TIMEOUT_S = Number(index.execution?.judge_timeout_s) || 180;

    if (defaultTargetAgents.length > 0) {
      validateAgents(defaultTargetAgents, pipelineConfig);
      console.log(`[Runner] target_agents from index.yaml: ${defaultTargetAgents.join(', ')}`);
    }

    if (judgeAgent) {
      validateAgents([judgeAgent], pipelineConfig, { role: 'judge' });
      console.log(`[Runner] judge_agent from index.yaml: ${judgeAgent}`);
    }

    let effectiveTargetAgents = defaultTargetAgents;

    if (opts.agent) {
      validateAgents([opts.agent], pipelineConfig);
      effectiveTargetAgents = [opts.agent];
      console.log(`[Runner] Override target_agents via --agent: ${opts.agent}`);
    } else if (opts.primaryOnly && defaultTargetAgents.length > 0) {
      effectiveTargetAgents = [defaultTargetAgents[0]];
      console.log(`[Runner] Using only primary agent: ${effectiveTargetAgents[0]}`);
    }

    result.target_agents = effectiveTargetAgents;
    result.judge_agent = judgeAgent;

    if (opts.calibrate) {
      console.log(`[Runner] Running calibration gate only...`);
      const calibrationResult = await runCalibrationGate(skillName, pipelineConfig);

      if (!calibrationResult.passed) {
        console.error(`[Runner] Calibration FAILED: ${calibrationResult.error}`);
        result.status = 'calibration_failed';
        result.error = calibrationResult.error;
        result.calibration = calibrationResult;
        return result;
      }

      console.log('[Runner] Calibration gate PASSED');
      result.calibration = calibrationResult;
      result.status = 'calibration_passed';
      return result;
    }

    cases = index.cases || [];

    if (opts.tag) {
      cases = filterCasesByTag(cases, opts.tag);
    }

    if (opts.severity) {
      cases = filterCasesBySeverity(cases, opts.severity);
    }

    if (opts.caseId) {
      const caseDef = cases.find(c => c.id === opts.caseId);
      if (caseDef) {
        const testCase = loadTestCase(skillName, caseDef.file);
        if (testCase.execution?.target_agents) {
          validateAgents(testCase.execution.target_agents, pipelineConfig);
          effectiveTargetAgents = testCase.execution.target_agents;
          console.log(`[Runner] Override target_agents in case ${opts.caseId}: ${effectiveTargetAgents.join(', ')}`);
        }
        if (testCase.execution?.judge_agent) {
          const caseJudgeAgent = testCase.execution.judge_agent;
          validateAgents([caseJudgeAgent], pipelineConfig, { role: 'judge' });
          console.log(`[Runner] Override judge_agent in case ${opts.caseId}: ${caseJudgeAgent}`);
        }
        cases = [caseDef];
      } else {
        throw new Error(`Case not found: ${opts.caseId}`);
      }
    }

    result.total = cases.length;

    const startTime = Date.now();

    const runL2 = !opts.layer || opts.layer === 'l2';

    const casesWithRubric = cases.filter(cd => {
      try {
        const tc = loadTestCase(skillName, cd.file);
        return tc.assertions?.rubric && tc.assertions.rubric.length > 0;
      } catch { return false; }
    });
    const anyHasRubric = casesWithRubric.length > 0;

    if (casesWithRubric.length < cases.length) {
      const missing = cases.length - casesWithRubric.length;
      console.log(`[Runner] ${missing}/${cases.length} cases have no rubric — L2 will be skipped for them`);
    }

    if (runL2 && effectiveTargetAgents.length > 0 && judgeAgent && anyHasRubric) {
      const trials = opts.fast ? 1 : 3;
      const totalModels = effectiveTargetAgents.length;
      await preFlightApproval(casesWithRubric.length, totalModels, trials);
    }

    let secretScanFailed = false;
    let calibrationFailedResult = null;

    const anyRunL1 = !opts.layer || opts.layer === 'deterministic';
    const anyRunL2 = !opts.layer || opts.layer === 'l2';

    if (anyRunL1 && !opts.skipSecretScan) {
      const scanResult = await runSecretScan();
      if (!scanResult.passed) {
        secretScanFailed = true;
        result.error = 'Secret scan failed - secrets detected in fixtures';
      }
    }

    if (anyRunL2 && effectiveTargetAgents.length > 0 && judgeAgent && anyHasRubric && !secretScanFailed) {
      const calibrationResult = await runCalibrationGate(skillName, pipelineConfig);
      if (!calibrationResult.passed) {
        console.error(`[Runner] Calibration gate FAILED: ${calibrationResult.error}`);
        calibrationFailedResult = calibrationResult;
        result.status = 'calibration_failed';
        result.error = calibrationResult.error;
        result.calibration = calibrationResult;
        return { ...result, cases, currentRunStatuses };
      }
      if (calibrationResult.warnings && calibrationResult.warnings.length > 0) {
        console.log(`[Runner] Calibration warnings: ${calibrationResult.warnings.join(', ')}`);
      }
      console.log('[Runner] Calibration gate PASSED');
    }

    await Promise.all(cases.map(async (caseDef) => {
      const caseStart = Date.now();

      try {
        const testCase = loadTestCase(skillName, caseDef.file);
        
        const hasRubric = testCase.assertions?.rubric && testCase.assertions.rubric.length > 0;
        
        const runL0 = !opts.layer || opts.layer === 'static' || opts.layer === 'deterministic';
        const runL1 = !opts.layer || opts.layer === 'deterministic';
        const runL2 = !opts.layer || opts.layer === 'l2';

        // Secret scan result propagated from pre-loop
        if (runL1 && !opts.skipSecretScan && secretScanFailed) {
          result.current_run.failed++;
          result.status = 'failed';
          currentRunStatuses[caseDef.id] = 'failed';
          await writeMetaJson(caseDef.id, skillName, 'failed', Date.now() - caseStart);
          return;
        }

        // L0 static assertions
        if (runL0) {
          const l0Results = runL0Assertions(skillName, testCase);
          const l0Failed = l0Results.filter(r => !r.passed);
          if (l0Failed.length > 0) {
            result.current_run.failed++;
            result.status = 'failed';
            currentRunStatuses[caseDef.id] = 'failed';
            await writeMetaJson(caseDef.id, skillName, 'failed', Date.now() - caseStart);
            return;
          }
        }

        if (runL1) {
          const l1Declared = (testCase.assertions?.deterministic || []).length;
          const willRunL2 = runL2 && effectiveTargetAgents.length > 0 && judgeAgent && hasRubric;

          let l2Results = null;
          let l2Failed = false;

          if (willRunL2) {
            const trials = opts.fast ? 1 : 3;
            const index = loadIndexYaml(skillName);
            const defaultTimeout = index.execution?.default_timeout_s || 300;
            const timeout = testCase.execution?.timeout_s || defaultTimeout;
            const caseTargetAgents = testCase.execution?.target_agents;
            const perCaseAgents = caseTargetAgents && caseTargetAgents.length > 0
              ? (validateAgents(caseTargetAgents, pipelineConfig), caseTargetAgents)
              : effectiveTargetAgents;
            if (caseTargetAgents && caseTargetAgents.length > 0) {
              console.log(`[Runner] ${caseDef.id}: per-case target_agents override → ${perCaseAgents.join(', ')}`);
            }
            try {
              l2Results = await runL2Evaluation(
                skillName,
                testCase,
                caseDef,
                perCaseAgents,
                judgeAgent,
                pipelineConfig,
                { trials, concurrency: 2, timeout }
              );

              const aggregated = aggregateResults(l2Results, testCase);
              console.log(`[Runner] L2 Results for ${caseDef.id}:`, JSON.stringify(aggregated, null, 2));

              await writeJudgeResults(skillName, caseDef.id, l2Results);

              if (!aggregated.overall_passed) {
                l2Failed = true;
              }
            } catch (l2Err) {
              console.error(`[Runner] L2 evaluation failed:`, l2Err.message);
              l2Failed = true;
            }
          }

          // L1 проверяется по выводу агента, а вывод появляется только вместе с
          // L2: своего прогона агентов у слоя нет.
          let l1Verdict = 'passed';
          if (l1Declared > 0) {
            if (!l2Results) {
              l1Verdict = 'no_coverage';
              result.l1_skipped = true;
            } else {
              const l1Aggregated = aggregateL1Results(l2Results, testCase);
              console.log(`[Runner] L1 Results for ${caseDef.id}:`, JSON.stringify(l1Aggregated, null, 2));
              if (!l1Aggregated.overall_passed) {
                l1Verdict = 'failed';
                for (const line of describeL1Failures(l2Results)) {
                  console.log(`[Runner] ${caseDef.id}: L1 ${line}`);
                }
              }
            }
          }

          let caseStatus;
          if (l1Verdict === 'failed' || l2Failed) {
            caseStatus = 'failed';
          } else if (l1Verdict === 'no_coverage') {
            caseStatus = 'no_coverage';
          } else {
            caseStatus = 'passed';
          }
          currentRunStatuses[caseDef.id] = caseStatus;

          if (caseStatus === 'failed') {
            result.current_run.failed++;
            result.status = 'failed';
          } else if (caseStatus === 'no_coverage') {
            result.current_run.no_coverage = (result.current_run.no_coverage || 0) + 1;
            console.log(`[Runner] ${caseDef.id}: no_coverage — L1 assertions require agent output but L2 is not configured (no rubric or no agents)`);
          } else {
            result.current_run.passed++;
          }

          await writeMetaJson(caseDef.id, skillName, caseStatus, Date.now() - caseStart, l2Results, result.l1_skipped, effectiveTargetAgents);
        } else if (runL2 && effectiveTargetAgents.length > 0 && judgeAgent && hasRubric) {
          const trials = opts.fast ? 1 : 3;
          const defaultTimeout = index.execution?.default_timeout_s || 300;
          const timeout = testCase.execution?.timeout_s || defaultTimeout;
          const caseTargetAgents = testCase.execution?.target_agents;
          const perCaseAgents = caseTargetAgents && caseTargetAgents.length > 0
            ? (validateAgents(caseTargetAgents, pipelineConfig), caseTargetAgents)
            : effectiveTargetAgents;
          if (caseTargetAgents && caseTargetAgents.length > 0) {
            console.log(`[Runner] ${caseDef.id}: per-case target_agents override → ${perCaseAgents.join(', ')}`);
          }
          let l2Results = null;
          let caseStatus = 'passed';
          try {
            l2Results = await runL2Evaluation(
              skillName,
              testCase,
              caseDef,
              perCaseAgents,
              judgeAgent,
              pipelineConfig,
              { trials, concurrency: 2, timeout }
            );

            const aggregated = aggregateResults(l2Results, testCase);
            console.log(`[Runner] L2 Results for ${caseDef.id}:`, JSON.stringify(aggregated, null, 2));

            await writeJudgeResults(skillName, caseDef.id, l2Results);

            if (!aggregated.overall_passed) {
              result.status = 'failed';
              result.current_run.failed++;
              caseStatus = 'failed';
            } else {
              result.current_run.passed++;
            }
          } catch (l2Err) {
            console.error(`[Runner] L2 evaluation failed:`, l2Err.message);
            result.status = 'failed';
            result.current_run.failed++;
            caseStatus = 'failed';
          }

          currentRunStatuses[caseDef.id] = caseStatus;
          await writeMetaJson(caseDef.id, skillName, caseStatus, Date.now() - caseStart, l2Results, null, effectiveTargetAgents);
        } else {
          result.current_run.passed++;
          currentRunStatuses[caseDef.id] = 'passed';
          await writeMetaJson(caseDef.id, skillName, 'passed', Date.now() - caseStart);
        }
      } catch (e) {
        result.current_run.failed++;
        result.status = 'failed';
        currentRunStatuses[caseDef.id] = 'error';
        await writeMetaJson(caseDef.id, skillName, 'error', Date.now() - caseStart);
      }
    }));

    if (result.status === 'passed' && result.current_run.no_coverage > 0 && result.current_run.passed === 0) {
      result.status = 'no_coverage';
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message;
  }

  return {
    ...result,
    cases,
    currentRunStatuses
  };
}

async function runSkillTests(opts) {
  // Validate options
  if (!opts.all && !opts.skill) {
    throw new Error('Either --skill or --all must be specified');
  }

  skipMetaWrite = Boolean(opts.skipMetaWrite);

  const results = {
    status: 'passed',
    skill: opts.skill || 'unknown',
    mode: 'deterministic',
    total: 0,
    current_run: { passed: 0, failed: 0, no_coverage: 0 },
    baseline_ref: 'origin/main',
    git_head_comparison: null,
    verdict: 'ready_for_user_review',
    outcome_message: ''
  };

  try {
    if (opts.skill) {
      const skillResult = await runTestsForSkill(opts.skill, opts);

      // Merge skill results
      results.skill = skillResult.skill;
      results.total = skillResult.total;
      results.current_run.passed = skillResult.current_run.passed;
      results.current_run.failed = skillResult.current_run.failed;
      results.current_run.no_coverage = skillResult.current_run.no_coverage || 0;
      results.status = skillResult.status;
      results.target_agents = skillResult.target_agents;
      results.judge_agent = skillResult.judge_agent;
      if (skillResult.error) results.error = skillResult.error;
      if (skillResult.calibration) results.calibration = skillResult.calibration;

      // Prepare for git comparison (if applicable)
      const cases = skillResult.cases;
      const currentRunStatuses = skillResult.currentRunStatuses;

      // Git comparison and verdict (skip for calibration or no cases)
      if (cases && cases.length > 0 && !opts.calibrate && !skillResult.status.startsWith('calibration_')) {
        try {
          const baselineRef = getBaselineRef(opts.skill, opts.baselineRef);
          results.baseline_ref = baselineRef;

          console.log(`[Runner] Computing git head comparison for ${cases.length} cases with baselineRef=${baselineRef}`);
          const gitResult = await analyzeGitHeadComparison(opts.skill, cases, baselineRef, currentRunStatuses);
          const { comparison, mode } = gitResult;
          results.mode = mode;
          results.git_head_comparison = comparison;
          console.log(`[Runner] Git head comparison complete: mode=${mode}`);

          let relevantCaseStatus = null;
          if (opts.relevant) {
            const relevantCaseDir = path.join(findSkillTestsDir(opts.skill), 'cases', opts.relevant, 'current', 'meta.json');
            if (fs.existsSync(relevantCaseDir)) {
              try {
                const meta = JSON.parse(fs.readFileSync(relevantCaseDir, 'utf8'));
                relevantCaseStatus = meta.status;
              } catch {}
            }
          }

          if (relevantCaseStatus) {
            results.relevant_case_status = relevantCaseStatus;
          }

          results.verdict = computeVerdict(comparison, mode, relevantCaseStatus, opts.establishBaseline);
          results.outcome_message = generateOutcomeMessage({
            verdict: results.verdict,
            comparison,
            mode,
            relevantCase: opts.relevant ? { id: opts.relevant, status: relevantCaseStatus } : null
          });
        } catch (verdictErr) {
          console.error('[Runner] Verdict computation failed:', verdictErr.message);
          console.error('[Runner] Stack:', verdictErr.stack);
        }
      }
    } else if (opts.all) {
      const skillNames = getAllSkillNamesWithTests();
      let total = 0;
      let passed = 0;
      let failed = 0;
      let overallStatus = 'passed';

      for (const skillName of skillNames) {
        const skillResult = await runTestsForSkill(skillName, opts);
        total += skillResult.total;
        passed += skillResult.current_run.passed;
        failed += skillResult.current_run.failed;
        if (skillResult.status !== 'passed') {
          overallStatus = 'failed';
        }
      }

      results.total = total;
      results.current_run.passed = passed;
      results.current_run.failed = failed;
      results.status = overallStatus;
      results.skill = 'all';
      results.mode = 'aggregated';
      results.verdict = overallStatus === 'passed' ? 'all_passed' : 'aggregated_failed';
      results.outcome_message = overallStatus === 'passed' ? 'All skills passed' : 'Some skills failed';
      results.baseline_ref = null;
    }
  } catch (e) {
    results.status = 'error';
    results.error = e.message;
  }

  return results;
}

function printResult(result) {
  console.log('---RESULT---');
  console.log(`status: ${result.status}`);
  console.log(`skill: ${result.skill}`);
  console.log(`mode: ${result.mode}`);
  console.log(`total: ${result.total}`);
  console.log(`current_run.passed: ${result.current_run.passed}`);
  console.log(`current_run.failed: ${result.current_run.failed}`);
  if (result.current_run.no_coverage) {
    console.log(`current_run.no_coverage: ${result.current_run.no_coverage}`);
  }

  if (result.baseline_ref) {
    console.log(`baseline_ref: ${result.baseline_ref}`);
  }

  if (result.git_head_comparison) {
    const c = result.git_head_comparison;
    console.log(`git_head_comparison.previously_green: ${c.previously_green}`);
    console.log(`git_head_comparison.previously_green_still_green: ${c.previously_green_still_green}`);
    console.log(`git_head_comparison.previously_green_now_red: ${c.previously_green_now_red}`);
    console.log(`git_head_comparison.previously_red: ${c.previously_red}`);
    console.log(`git_head_comparison.previously_red_still_red: ${c.previously_red_still_red}`);
    console.log(`git_head_comparison.previously_red_now_green: ${c.previously_red_now_green}`);
    console.log(`git_head_comparison.new_cases: ${c.new_cases}`);
  }

  if (result.relevant_case_status) {
    console.log(`relevant_case_status: ${result.relevant_case_status}`);
  }

  if (result.verdict) {
    console.log(`verdict: ${result.verdict}`);
  }

  if (result.outcome_message) {
    console.log(`outcome_message: ${result.outcome_message}`);
  }

  // Причина status: error (агент не найден, агент без инструментов, …) — без неё
  // вывод говорил только «error».
  if (result.error) {
    console.log(`error: ${String(result.error).replace(/\s*\n\s*/g, ' ')}`);
  }

  console.log('---RESULT---');
}

function showHelp() {
  console.log('run-skill-tests.js - Runner for skill tests');
  console.log('');
  console.log('Usage:');
  console.log('  node run-skill-tests.js --skill <name>     Run all tests for a skill');
  console.log('  node run-skill-tests.js --case TC-XXX-NNN  Run a single test case');
  console.log('  node run-skill-tests.js --tag <tag>      Filter tests by tag');
  console.log('  node run-skill-tests.js --severity <level>  Filter tests by severity (e.g., critical, normal)');
  console.log('  node run-skill-tests.js --layer static|deterministic|l2  Run only L0, L1 or L2');
  console.log('  node run-skill-tests.js --relevant TC-XXX-NNN  Mark relevant case for coach');
  console.log('  node run-skill-tests.js --baseline-ref <ref>  Override baseline ref (default: origin/main)');
  console.log('  node run-skill-tests.js --establish-baseline  Allow reds in no-baseline mode');
  console.log('  node run-skill-tests.js --all             Run all skills');
  console.log('  node run-skill-tests.js --agent <id>      Run only on specific model from target_agents[]');
  console.log('  node run-skill-tests.js --primary-only    Run only on first model from target_agents[]');
  console.log('  node run-skill-tests.js --skip-secret-scan  Skip secret scanning before L2');
  console.log('  node run-skill-tests.js --skip-meta-write  Do not update current/meta.json (baseline)');
  console.log('  node run-skill-tests.js --fast            Run with trials=1 for all cases');
  console.log('  node run-skill-tests.js --yes             Skip pre-flight approval gate');
  console.log('  node run-skill-tests.js --calibrate       Run only calibration gate (no full suite)');
  console.log('');
  console.log('Environment:');
  console.log('  WORKFLOW_SKILLS_DIR   Skills directory (default: <project root>/src/skills)');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  const opts = parseArgs();
  const result = await runSkillTests(opts);
  printResult(result);
  
  if (result.status === 'error') {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
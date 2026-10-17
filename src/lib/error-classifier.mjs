import { load as loadYaml } from './js-yaml.mjs';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const STDERR_MATCH_LIMIT = 64 * 1024;
const MATCH_TIMEOUT_MS = 100;
const SUPPORTED_VERSION = '1.0';
const MIN_UTC_MIDNIGHT_DELAY_MS = 30 * 60 * 1000;

export class InvalidRulesConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRulesConfigError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

function parseConfigFile(configPath) {
  if (!existsSync(configPath)) {
    return { common: [], agents: {} };
  }
  const content = readFileSync(configPath, 'utf-8');
  const config = loadYaml(content);
  if (!config || typeof config !== 'object') {
    return { common: [], agents: {} };
  }
  return config;
}

function validateVersion(version) {
  if (version !== SUPPORTED_VERSION) {
    throw new InvalidRulesConfigError(
      `Unsupported rules version: ${version}. Update runner or downgrade rules file.`
    );
  }
}

function compilePattern(pattern) {
  if (!pattern) {
    return null;
  }
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new InvalidRulesConfigError(`Invalid regex pattern: ${pattern}. ${e.message}`);
  }
}

function resolveExtends(agentsConfig, agentId, visited = new Set()) {
  if (!agentsConfig[agentId]) {
    return null;
  }
  if (!agentsConfig[agentId].extends) {
    return null;
  }
  const extendsTarget = agentsConfig[agentId].extends;
  if (visited.has(agentId)) {
    throw new InvalidRulesConfigError('chained extends not supported');
  }
  if (!agentsConfig[extendsTarget]) {
    throw new InvalidRulesConfigError(`extends target '${extendsTarget}' not found`);
  }
  if (agentsConfig[extendsTarget].extends) {
    throw new InvalidRulesConfigError('chained extends not supported');
  }
  visited.add(agentId);
  return agentsConfig[extendsTarget].rules || [];
}

function buildRules(rulesData, compiledRules = []) {
  if (!Array.isArray(rulesData)) {
    return compiledRules;
  }
  for (const rule of rulesData) {
    if (!rule || !rule.id || !rule.class || !rule.ttl) {
      continue;
    }
    compiledRules.push({
      id: rule.id,
      class: rule.class,
      ttl: rule.ttl,
      pattern: compilePattern(rule.pattern),
      exitCodes: rule.exit_codes === 'any' ? 'any' : (
        Array.isArray(rule.exit_codes)
          ? rule.exit_codes.filter(c => typeof c === 'number')
          : []
      ),
    });
  }
  return compiledRules;
}

/**
 * Правила health-классификатора из `.workflow/config/agent-health-rules.yaml` (или
 * `configPath`). `pattern` правила — регулярное выражение JS без флагов (`new RegExp`),
 * с учётом регистра. Префикс `(?i)` JS не знает — InvalidRulesConfigError, а
 * `(?i:…)` понимает только Node 23+, тогда как `engines` — Node 18, и поставляемый
 * файл через общую папку конфигов читают раннеры прежних версий: регистр — классами
 * вида `[Rr]`. Порядок проверки в classify: правила агента (свои, затем
 * унаследованные по `extends`), потом общие (`common`) в порядке файла.
 * @returns {{common: Array, agents: Map<string, Array>}}
 */
export function loadRules(projectRoot, configPath) {
  const defaultPath = join(projectRoot, '.workflow/config/agent-health-rules.yaml');
  const fullPath = configPath || defaultPath;
  let config;
  try {
    config = parseConfigFile(fullPath);
  } catch (e) {
    if (e instanceof InvalidRulesConfigError) {
      throw e;
    }
    return { common: [], agents: new Map() };
  }
  if (!config || typeof config !== 'object') {
    return { common: [], agents: new Map() };
  }
  if (config.version) {
    validateVersion(config.version);
  }
  const commonRules = buildRules(config.common || []);
  const agents = new Map();
  const agentsConfig = config.agents || {};
  for (const agentId of Object.keys(agentsConfig)) {
    const agentConfig = agentsConfig[agentId];
    if (!agentConfig) {
      continue;
    }
    const inheritedRules = resolveExtends(agentsConfig, agentId);
    const ownRules = buildRules(agentConfig.rules || []);
    const finalRules = [...ownRules];
    if (inheritedRules && inheritedRules.length > 0) {
      finalRules.push(...buildRules(inheritedRules));
    }
    agents.set(agentId, finalRules);
  }
  return { common: commonRules, agents };
}

function truncateStderr(stderr) {
  if (!stderr || stderr.length <= STDERR_MATCH_LIMIT) {
    return stderr;
  }
  const halfLimit = STDERR_MATCH_LIMIT / 2;
  const head = stderr.slice(0, halfLimit);
  const tail = stderr.slice(-halfLimit);
  return head + '\n...[TRUNCATED]...\n' + tail;
}

function matchRule(rule, exitCode, truncatedStderr) {
  const exitCodesMatch = rule.exitCodes === 'any' ||
    rule.exitCodes.includes(exitCode);
  if (!exitCodesMatch) {
    return false;
  }
  if (!rule.pattern) {
    return true;
  }
  try {
    return rule.pattern.test(truncatedStderr);
  } catch (e) {
    return false;
  }
}

function matchWithTimeout(regex, text) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve(false);
    }, MATCH_TIMEOUT_MS);
    try {
      const result = regex.test(text);
      clearTimeout(timeoutId);
      resolve(result);
    } catch (e) {
      clearTimeout(timeoutId);
      resolve(false);
    }
  });
}

export async function classify(rules, agentId, { exitCode, stderr }) {
  const truncatedStderr = truncateStderr(stderr);
  const agentRules = rules.agents.get(agentId) || [];
  for (const rule of agentRules) {
    const matched = rule.pattern
      ? await matchWithTimeout(rule.pattern, truncatedStderr)
      : matchRule(rule, exitCode, truncatedStderr);
    if (matched) {
      return {
        class: rule.class,
        rule_id: rule.id,
        ttl: rule.ttl,
        reason: truncatedStderr,
      };
    }
  }
  for (const rule of rules.common) {
    const matched = rule.pattern
      ? await matchWithTimeout(rule.pattern, truncatedStderr)
      : matchRule(rule, exitCode, truncatedStderr);
    if (matched) {
      return {
        class: rule.class,
        rule_id: rule.id,
        ttl: rule.ttl,
        reason: truncatedStderr,
      };
    }
  }
  return null;
}

// Конец последнего match шаблона в тексте (или -1). Клон с флагом g: у правила
// флагов нет, а исходный RegExp без g в exec не двигается по совпадениям сам.
function lastPatternMatchEnd(pattern, text) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let last = null;
  let match;
  while ((match = global.exec(text)) !== null) {
    last = match;
    if (match.index === global.lastIndex) global.lastIndex += 1;
  }
  return last ? last.index + last[0].length : -1;
}

function newlinesAfter(text, from) {
  let count = 0;
  for (let i = text.indexOf('\n', from); i !== -1; i = text.indexOf('\n', i + 1)) {
    count += 1;
  }
  return count;
}

/**
 * Онлайн-проверка stderr на "фатальные" паттерны для агента.
 * Используется spawn-хендлером для раннего kill зависшего процесса,
 * когда дочерний агент уходит в retry-цикл на HTTP 429 / quota без завершения.
 *
 * Проверяет только правила самого агента (не common), и только те,
 * у которых class ∈ {unavailable, misconfigured} — это сигналы, после которых
 * продолжать вызов бессмысленно.
 *
 * С опцией `maxTailNewlines` фатальным считается только match в конце stderr:
 * после конца match — не больше maxTailNewlines переводов строк. 429 из середины,
 * после которого агент сам повторил запрос и продолжил работу, снятием не
 * считается — фатален запуск, застрявший на ограничении, то есть ограничение в
 * последних строках (тот же принцип, что у PROVIDER_RATE_LIMIT_PATTERN в
 * classifyAgentResult: «429 из середины не в счёт»). Берётся последний match
 * правила: в retry-цикле строк ограничения несколько, у хвоста — последняя.
 *
 * @param {{common: Array, agents: Map}} rules — результат loadRules()
 * @param {string} agentId
 * @param {string} stderrText — весь накопленный stderr (до STDERR_MATCH_LIMIT)
 * @param {{maxTailNewlines?: number}} [opts]
 * @returns {{rule_id: string, class: string, ttl: string, reason: string} | null}
 */
export function scanStderrForFatalRule(rules, agentId, stderrText, { maxTailNewlines } = {}) {
  if (!stderrText || !agentId) return null;
  const truncated = truncateStderr(stderrText);
  const agentRules = rules.agents.get(agentId) || [];
  for (const rule of agentRules) {
    if (rule.class !== 'unavailable' && rule.class !== 'misconfigured') continue;
    if (!rule.pattern) continue;
    try {
      if (typeof maxTailNewlines === 'number') {
        const matchEnd = lastPatternMatchEnd(rule.pattern, truncated);
        if (matchEnd < 0) continue;
        if (newlinesAfter(truncated, matchEnd) > maxTailNewlines) continue;
      } else if (!rule.pattern.test(truncated)) {
        continue;
      }
      return {
        rule_id: rule.id,
        class: rule.class,
        ttl: rule.ttl,
        reason: truncated,
      };
    } catch {
      // broken regex — пропускаем
    }
  }
  return null;
}

// Сколько переводов строк допускается после конца match фатального правила,
// чтобы считать match «концом запуска»: сам match и не больше одной строки
// после него (перевод строки, кончающий строку match, тоже считается).
const FATAL_TAIL_NEWLINES = 2;

// Grace-окно решает судьбу match: kill не мгновенный, а через 4 с, и только
// если ограничение осталось в хвосте stderr. Агент, сам повторивший запрос после
// 429 и продолживший работу, за окно печатает новый вывод — match уходит из хвоста,
// снятие отменяется; застрявший на ограничении агент снимается по истечении окна
// (назначение онлайн-скана — retry-цикл kilo вместо ожидания timeout_per_stage).
// Признак живости — только новые строки stderr: скан идёт по нему, и порция меньше
// порога скана (200 байт) его не двигает. Агент, который после ограничения пишет
// только в stdout, для окна неотличим от застрявшего и снимается: окно лишь снимает
// retry-цикл раньше timeout_per_stage, и границу держит он.
export const FATAL_KILL_GRACE_MS = 4000;

/**
 * Ранний kill по онлайн-скану stderr с grace-окном (см. FATAL_KILL_GRACE_MS).
 * onScan(stderr) — накопленный stderr на очередном скане (вызывает сторона
 * после своего throttle); match в хвосте stderr взводит таймер, уход match
 * из хвоста — отменяет: новые строки stderr и есть единственный признак того,
 * что агент продолжил работу. По таймеру правило перепроверяется на текущем
 * stderr: всё ещё в хвосте — onKill(match).
 * dispose() — на выходе, таймауте и ошибке процесса: отменяет взведённый
 * таймер и глушит onScan.
 */
export function createFatalStderrArbiter(rules, agentId, onKill, { graceMs = FATAL_KILL_GRACE_MS } = {}) {
  let disposed = false;
  let timer = null;
  let lastStderr = '';
  const scan = () => scanStderrForFatalRule(rules, agentId, lastStderr, { maxTailNewlines: FATAL_TAIL_NEWLINES });
  const evaluate = () => {
    timer = null;
    const match = scan();
    if (match) onKill(match);
  };
  return {
    onScan(stderrText) {
      if (disposed || !rules || !agentId) return;
      lastStderr = stderrText;
      if (scan()) {
        if (!timer) {
          timer = setTimeout(evaluate, graceMs);
          timer.unref?.();
        }
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function parseTtl(ttl, now = Date.now()) {
  if (ttl === 'infinite') {
    return Number.MAX_SAFE_INTEGER;
  }
  const untilMatch = ttl.match(/^(\d+)d$/);
  if (untilMatch) {
    return now + parseInt(untilMatch[1], 10) * 24 * 60 * 60 * 1000;
  }
  const hourMatch = ttl.match(/^(\d+)h$/);
  if (hourMatch) {
    return now + parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
  }
  const minMatch = ttl.match(/^(\d+)m$/);
  if (minMatch) {
    return now + parseInt(minMatch[1], 10) * 60 * 1000;
  }
  if (ttl === 'until_utc_midnight') {
    const nextMidnight = new Date(now);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    const minDelay = now + MIN_UTC_MIDNIGHT_DELAY_MS;
    return Math.max(nextMidnight.getTime(), minDelay);
  }
  throw new Error(`Invalid TTL format: ${ttl}. Expected Nm, Nh, Nd, until_utc_midnight, or infinite.`);
}

export function classifySync(rules, agentId, { exitCode, stderr }) {
  const truncatedStderr = truncateStderr(stderr);
  const agentRules = rules.agents.get(agentId) || [];
  for (const rule of agentRules) {
    const matched = rule.pattern
      ? (() => {
          try {
            return rule.pattern.test(truncatedStderr);
          } catch (e) {
            return false;
          }
        })()
      : matchRule(rule, exitCode, truncatedStderr);
    if (matched) {
      return {
        class: rule.class,
        rule_id: rule.id,
        ttl: rule.ttl,
        reason: truncatedStderr,
      };
    }
  }
  for (const rule of rules.common) {
    const matched = rule.pattern
      ? (() => {
          try {
            return rule.pattern.test(truncatedStderr);
          } catch (e) {
            return false;
          }
        })()
      : matchRule(rule, exitCode, truncatedStderr);
    if (matched) {
      return {
        class: rule.class,
        rule_id: rule.id,
        ttl: rule.ttl,
        reason: truncatedStderr,
      };
    }
  }
  return null;
}


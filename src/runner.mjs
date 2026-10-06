#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import crypto from 'crypto';
import yaml from './lib/js-yaml.mjs';
import { findProjectRoot } from './lib/find-root.mjs';
import { loadRules, scanStderrForFatalRule, classify, parseTtl } from './lib/error-classifier.mjs';
import { snapshot, diff, isEmpty } from './lib/artifact-snapshot.mjs';
import { markUnhealthy, isHealthy } from './lib/agent-health-registry.mjs';
import { writeMarker, readMarker, removeMarker } from './lib/marker.mjs';
import { processAlive } from './lib/process-alive.mjs';
import { readPauseRequest, RUNNER_CAPABILITIES } from './lib/pause-request.mjs';
import { packageVersion as pipelineVersion } from './lib/package-version.mjs';
import { appendAgentRun, classifyAgentResult } from './lib/agent-history.mjs';
import { buildAgentEnv } from './lib/agent-env.mjs';
import {
  findRailsStateByRun, railsStatesByRun, railsHost, railsHooksPresent, resumeSessionArgs,
  railsNotEngagedVerdict, outputCheckVerdict,
} from './lib/rails-run-state.mjs';
import { isKiloRun, kiloRunTitle, withKiloTitle, requestedKiloModel, kiloDbPath, readKiloRun, formatKiloModels, kiloAgentLabel } from './lib/kilo-models.mjs';
import {
  EXECUTOR_SKILL, CRASH_TTL_DEFAULT_MS,
  appendRunEvent, readRunEvents, activeBans, findBan, describeBan, configuredModelKey, runModelKey,
  requestedModel, ticketTypeOf, isCrashStatus, newRunKey, writeOpenRun, clearOpenRun, closeInterruptedRun,
  gradeRuns,
} from './lib/agent-runs.mjs';
import { captureRunChanges, listRunChanges, failedRunChanges } from './lib/agent-run-changes.mjs';
import {
  MODEL_PLACEHOLDER, expandModelPools, isModelPool, maxPerAttempt as poolMaxPerAttempt, poolMembers, healthRulesId,
  SELECTOR_TIMEOUT_MS, SELECTOR_MAX_CANDIDATES, poolSelectorData, selectorTicket, buildSelectorPrompt, selectorRanking,
  GATE_TIMEOUT_MS, runPoolCommand,
} from './lib/model-pools.mjs';
import {
  isGoverned, flattenSurvivors, computeBands, levelOf, ticketFloor, capFloor, walkOrder, selectionTicket,
  buildSelectionPrompt, parseRequiredLevel, loadStageFacts, hasStageFacts, stageFactsInfo, factsOf,
} from './lib/stage-selection.mjs';

// Как часто, пока kilo-агент работает, смотреть в базу kilo, какие модели ответили.
const KILO_MODELS_POLL_MS = 15000;
// Строка HEARTBEAT в лог прогона, пока работает процесс агента (_callAgentOnce). Во время
// агента раннер иначе молчит: AGENT_MODELS пишется только при смене подписи kilo, и
// 2026-09-29/30 в логе PulseProxy 30 пауз дольше 10 минут, самая длинная 1785 с, — момент
// смерти раннера по логу и по mtime лога (last_log_at в workflow-mcp) не восстановить.
// Строка идёт только пока взведён таймаут запуска агента: детектор stuck в workflow-mcp
// (тишина лога дольше `timeout` стадии, по умолчанию 300 с, плюс запас) во время агента,
// которого раннер ещё не снял, больше не срабатывает, а после таймаута раннера лог молчит,
// как прежде. Двоеточия в строке нет: разбор лога workflow-mcp (parsers/pipeline-log.mjs)
// принял бы её за строку блока Context шага.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
// Повторы финального чтения базы kilo после выхода агента (_trackKiloModels).
const KILO_FINAL_READ_RETRIES = 3;
const KILO_FINAL_READ_DELAY_MS = 300;
import { loadRailsConfig } from './rails/rails-config.mjs';
import { check as checkRailsOutput } from './rails/output-check.mjs';
import { loadSkillRuntime } from './rails/core.mjs';
import { recordCompletion } from './rails/completion.mjs';
import { evaluate as evaluateWithModel, validateInput } from './lib/model-evaluate.mjs';
import { ModelClientError, assertModelUrl, redactNetworkDetail, imageBatches } from './lib/model-client.mjs';
import { buildCliJudgePrompt, parseJudgeScore, parseJudgeExtras } from './lib/skill-judge.mjs';
import { RUBRIC_LEVEL_COUNT } from './lib/rubric-levels.mjs';
import { parseFrontmatter, normalizePlanId } from './lib/utils.mjs';

// Ошибка клиента безынструментного агента или класс ошибки в ответе агента с
// командой на шаге «модель» model_io → запись health-реестра. Классы и TTL —
// как у правил, которые ловят те же сбои CLI-агентов (configs/agent-health-rules.yaml):
// auth — http-auth, rate_limit — claude-rate-limit, server — http-5xx-transient,
// timeout и network — net-econnreset. Прочие классы (no_key, bad_request,
// bad_response) агента не помечают: стадия уходит по goto.error.
const MODEL_ERROR_HEALTH = Object.freeze({
  auth: { class: 'misconfigured', ttl: '1h' },
  rate_limit: { class: 'unavailable', ttl: '1h' },
  server: { class: 'transient', ttl: '5m' },
  timeout: { class: 'transient', ttl: '5m' },
  network: { class: 'transient', ttl: '5m' },
});

// Классы сбоя селектора модели стадии, которые повтор вызова с тем же промптом не
// исправит (_stageSelection): ключ не принят или не найден, запрос отвергнут, неверные
// аргументы обёртки или промпт (decisions-select.js: usage, bad_prompt). Остальные сбои —
// сеть, таймаут, 5xx, выход без класса — повторяются один раз.
const SELECTOR_NO_RETRY_CLASSES = new Set(['auth', 'no_key', 'bad_request', 'usage', 'bad_prompt']);

/**
 * `complexity` из frontmatter тикета — `simple`, `medium` или `complex`
 * (templates/ticket-template.md); поля нет, значение другое, файл не читается — null.
 * Не selectionTicket: тот без поля подставляет `medium` для промпта селектора, а здесь
 * отсутствие поля — «не знаем», и старт остаётся прежним (лестница с нижнего уровня).
 */
function ticketComplexity(ticketPath) {
  if (!ticketPath) return null;
  try {
    const value = parseFrontmatter(fs.readFileSync(ticketPath, 'utf8')).frontmatter?.complexity;
    return value === 'simple' || value === 'medium' || value === 'complex' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Стартовый уровень обхода по complexity тикета, когда уровня не назвал селектор:
 * `available` — уровни выживших над границей по возрастанию, без повторов; simple —
 * нижний, complex — верхний, medium — средний (при чётном числе — нижний из двух
 * средних: правило «самая слабая достаточная»). complexity null — null.
 */
function complexityStartLevel(complexity, available) {
  if (!complexity || available.length === 0) return null;
  if (complexity === 'simple') return available[0];
  if (complexity === 'complex') return available[available.length - 1];
  return available[Math.floor((available.length - 1) / 2)];
}

/**
 * TTL правила health (`5m`, `1h`, `until_utc_midnight`, …) в миллисекундах от текущего
 * момента — для `crash_ttl_ms` события run. Нет TTL или он не разбирается — null.
 */
function ttlToMs(ttl, now = Date.now()) {
  if (typeof ttl !== 'string' || !ttl) return null;
  try {
    // `infinite` — Number.MAX_SAFE_INTEGER: конец запрета держится в пределах Date.
    return Math.max(0, Math.min(parseTtl(ttl, now), MAX_DATE_MS) - now);
  } catch {
    return null;
  }
}

// Наибольшее время, которое представимо в Date (ECMAScript: ±8.64e15 мс).
const MAX_DATE_MS = 8.64e15;

/**
 * Какое событие журнала запусков пишет стадия по своему результату: `verify` —
 * стадия контроля артефактов (агент — скрипт verify-artifacts.js), `review` — стадия
 * ревью (со скилом review-result или с обменом model_io, чей apply — apply-review.js);
 * иначе null. Стадия опознаётся по скрипту и скилу, а не по id: переименование
 * стадии в конфиге запись не отключает.
 */
function stageEventKind(pipeline, stage) {
  if (!stage) return null;
  const script = stage.agent && !stage.agents ? pipeline.agents?.[stage.agent] : null;
  if (script && Array.isArray(script.args) && script.args.some((a) => path.basename(String(a)) === 'verify-artifacts.js')) {
    return 'verify';
  }
  if (stage.skill === 'review-result') return 'review';
  if (stage.model_io?.apply && path.basename(String(stage.model_io.apply)) === 'apply-review.js') return 'review';
  return null;
}

/** Значения RESULT (строки) → поля событий журнала. */
function resultNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resultBoolean(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function resultList(value, separator) {
  if (typeof value !== 'string') return [];
  return value.split(separator).map((s) => s.trim()).filter(Boolean);
}

/**
 * Вопросы входа слоя оценки для агента с командой (StageExecutor._askCommandAgent):
 * непустые уникальные id, непустой текст и ровно пять уровней. Промпт и разбор
 * судьи фиксированы на баллах 1..5 (skill-judge.mjs), обёртка decisions-judge.js
 * разбирает ровно пять строк таблицы (rubric-levels.mjs), а слой оценки допускает
 * 2..10 уровней: агент без обёртки на вопрос с тремя уровнями ответил бы
 * `score: 5` — уровнем вне шкалы. Нарушение — bad_request до запуска агента.
 */
function commandAgentQuestions(input) {
  validateInput(input, { minLevels: RUBRIC_LEVEL_COUNT, maxLevels: RUBRIC_LEVEL_COUNT });
  return input.questions;
}

// ============================================================================
// Audit-log helpers (used by executeWithFallback hook — IMPL-83)
// ============================================================================

/**
 * Время строки «Истории работы»: местное время ISO 8601 со смещением зоны
 * (`2026-10-01T03:12:45+05:00`). До 2026-10-01 — местное время без зоны
 * (`2026-10-01 03:12:45`): исполнители переписывали его в Result с меткой Z (сдвиг до 5 ч),
 * а разбор сопоставлял историю с UTC журнала запусков по сдвигу пояса. Читатели истории
 * берут оба вида: parseAgentHistory — ячейку как есть, calc-metrics.js скила create-report
 * — через Date (строка со смещением — абсолютное время, без зоны — местное).
 */
function formatLocalIsoDateTime(d) {
  const pad = n => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

// ============================================================================
// Rails integration (src/rails/README.md §11) — окружение целевого агента
// стадии и output-check по завершении. Ядро rails (граф/состояние/хуки) —
// отдельный пакет работ; здесь только интеграция раннера (wp5).
// ============================================================================

function railsYamlExists(root, skill) {
  if (!skill) return false;
  try {
    return fs.existsSync(path.join(root, '.workflow', 'src', 'skills', skill, 'rails.yaml'));
  } catch {
    return false;
  }
}

function findTicketPathForId(ticketId, projectRoot) {
  if (!ticketId) return null;
  const dirs = ['ready', 'in-progress', 'review', 'done', 'backlog', 'blocked'];
  for (const d of dirs) {
    const p = path.join(projectRoot, '.workflow', 'tickets', d, `${ticketId}.md`);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Колонки закрытого тикета: история работы туда не дописывается (_auditAgentRun).
const CLOSED_TICKET_COLUMNS = new Set(['done', 'archive']);

// Статусы стадии, после которых прогон, ушедший в end, кончается не успехом, а строкой
// «Pipeline stopped: … stuck» (PipelineRunner.run). stuck — check-report-needed: план
// стоит на тикетах в blocked/, разбиение их не сняло, нужно решение человека. До
// 2026-10-01 такой прогон кончался «Pipeline completed successfully!» (2026-09-30
// PulseProxy, DOCS-014 в blocked/ из-за write_deny) — ни строки о том, что план стоит.
const STUCK_END_STATUSES = new Set(['stuck']);

// Ключи контекста, которые описывают текущий тикет: их ставят переходы тикетных стадий
// поставляемого configs/pipeline.yaml (pick-*.found, verify-artifacts, mark-blocked и т.д.;
// ready_tickets — check-conditions.has_ready). Контекст раннера между стадиями не
// очищается, и стадия уровня плана (`scope: plan`) без отсечки получала последний тикет:
// 2026-09-29/30 create-report, analyze-report и decompose-gaps шли с ticket_id HUMAN-003
// и task_type fix (ListeningGlass), QA-180 (PulseProxy) — в промпте, в журнале запусков и
// строками истории работы закрытого тикета; 2026-04-20 устаревший required_capabilities
// заблокировал create-report и analyze-report (no_capable_agent).
const TICKET_CONTEXT_KEYS = Object.freeze([
  'ticket_id', 'task_type', 'required_capabilities', 'target', 'attempt', 'attempts', 'reason',
  'evidence_file', 'ready_tickets',
]);

/**
 * План отчёта: `related_plan` из frontmatter `.workflow/reports/<reportId>.md`,
 * нормализованный normalizePlanId (`plans/current/PLAN-020.md` → `PLAN-020`), — как
 * latestReport в scripts/check-report-needed.js, включая разбор строкой, когда YAML отчёта
 * не читается (PulseProxy REPORT-012). Id не вида `REPORT-<число>` (его пишет агент в
 * RESULT), нет файла или поля — null.
 */
function reportPlanId(projectRoot, reportId) {
  if (typeof reportId !== 'string' || !/^REPORT-\d+$/.test(reportId)) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(projectRoot, '.workflow', 'reports', `${reportId}.md`), 'utf8');
  } catch {
    return null;
  }
  try {
    const related = parseFrontmatter(text).frontmatter?.related_plan;
    return related ? normalizePlanId(String(related)) : null;
  } catch {
    const line = text.match(/^related_plan:[ \t]*["']?([^"'\r\n]+)/m);
    return line ? normalizePlanId(line[1].trim()) : null;
  }
}

// IMPL-86: normalize agent_id in last row of ## Ревью section
// Re-writes the agent column if it differs from expectedAgent. Other columns untouched.
// Returns { ok: true, changed: boolean } or { ok: false, code, error }.
function normalizeReviewAgentId(ticketPath, expectedAgent) {
  if (!ticketPath || !expectedAgent) return { ok: false, code: 'INVALID_INPUT' };
  let content;
  try {
    content = fs.readFileSync(ticketPath, 'utf8');
  } catch (err) {
    return { ok: false, code: 'READ_ERROR', error: err.message };
  }

  const sectionRegex = /(##\s+Ревью\s*\r?\n)([\s\S]*?)(?=\r?\n##\s+|$)/i;
  const match = content.match(sectionRegex);
  if (!match) return { ok: false, code: 'NO_SECTION' };

  const sectionBody = match[2];
  const lines = sectionBody.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('|') && t.endsWith('|') && !/^\s*\|[-:|\s]+\|\s*$/.test(t)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { ok: false, code: 'NO_HEADER' };

  const headerCells = lines[headerIdx].trim().slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim());
  const agentColIdx = headerCells.findIndex(c => /^(агент|agent)$/i.test(c));
  if (agentColIdx === -1) return { ok: false, code: 'NO_AGENT_COLUMN' };

  let lastDataIdx = -1;
  for (let i = lines.length - 1; i > headerIdx; i--) {
    const t = lines[i].trim();
    if (t.startsWith('|') && t.endsWith('|') && !/^\s*\|[-:|\s]+\|\s*$/.test(t)) {
      lastDataIdx = i;
      break;
    }
  }
  if (lastDataIdx === -1) return { ok: false, code: 'NO_DATA_ROW' };

  const cells = lines[lastDataIdx].trim().slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim());
  if (agentColIdx >= cells.length) return { ok: false, code: 'CELL_MISSING' };

  const currentAgent = cells[agentColIdx];
  if (currentAgent === expectedAgent) return { ok: true, changed: false };

  cells[agentColIdx] = expectedAgent;
  lines[lastDataIdx] = `| ${cells.join(' | ')} |`;

  const newSection = match[1] + lines.join('\n');
  const newContent = content.replace(sectionRegex, newSection);

  const dir = path.dirname(ticketPath);
  const tmp = path.join(dir, `.${path.basename(ticketPath)}.normagent.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, newContent, 'utf8');
    fs.renameSync(tmp, ticketPath);
    return { ok: true, changed: true };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, code: 'WRITE_ERROR', error: err.message };
  }
}

// ============================================================================
// Logger — система логирования с уровнями DEBUG/INFO/WARN/ERROR
// ============================================================================
class Logger {
  static LEVELS = {
    DEBUG: -1,
    INFO: 0,
    WARN: 1,
    ERROR: 2
  };

  static COLORS = {
    DEBUG: '\x1b[90m',   // gray
    INFO: '\x1b[36m',    // cyan
    WARN: '\x1b[33m',    // yellow
    ERROR: '\x1b[31m',   // red
    RESET: '\x1b[0m'
  };

  constructor(logFilePath, consoleLevel = Logger.LEVELS.INFO) {
    this.logFilePath = logFilePath;
    this.consoleLevel = consoleLevel;
    this.stats = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      stagesStarted: 0,
      stagesCompleted: 0,
      stagesFailed: 0,
      cliCalls: 0,
      gotoTransitions: 0,
      retries: 0,
      startTime: null,
      endTime: null
    };
  }

  /**
   * Создаёт директорию для логов если она не существует
   */
  _ensureLogDirectory() {
    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
      console.log(`[Logger] Created log directory: ${logDir}`);
    }
  }

  /**
   * Открывает файл для записи (append mode)
   */
  _openFile() {
    // Создаём директорию и файл если не существуют
    this._ensureLogDirectory();
    if (!fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, '');
    }
    this.stats.startTime = new Date();
  }

  /**
   * Инициализирует logger
   */
  async init() {
    this._openFile();
  }

  /**
   * Форматирует timestamp для логов
   */
  _formatTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
  }

  /**
   * Форматирует сообщение для вывода
   */
  _formatMessage(level, stage, message) {
    const timestamp = this._formatTimestamp();
    const stageTag = stage ? `[${stage}]` : '[Runner]';
    const prefix = `[${timestamp}] [${level}] ${stageTag} `;
    const lines = message.split('\n');
    if (lines.length === 1) {
      return `${prefix}${message}`;
    }
    const indent = ' '.repeat(prefix.length);
    return lines.map((line, i) => i === 0 ? `${prefix}${line}` : `${indent}${line}`).join('\n');
  }

  /**
   * Записывает лог в файл (синхронно)
   */
  _writeToFile(formattedMessage) {
    fs.appendFileSync(this.logFilePath, formattedMessage + '\n', 'utf8');
  }

  /**
   * Выводит в консоль с цветом
   */
  _writeToConsole(formattedMessage, level) {
    if (Logger.LEVELS[level] < this.consoleLevel) {
      return;
    }

    const color = Logger.COLORS[level];
    const reset = Logger.COLORS.RESET;

    if (level === 'ERROR') {
      console.error(`${color}${formattedMessage}${reset}`);
    } else if (level === 'WARN') {
      console.warn(`${color}${formattedMessage}${reset}`);
    } else {
      console.log(`${color}${formattedMessage}${reset}`);
    }
  }

  /**
   * Базовый метод логирования
   */
  _log(level, stage, message) {
    const formattedMessage = this._formatMessage(level, stage, message);
    this._writeToFile(formattedMessage);
    this._writeToConsole(formattedMessage, level);

    // Обновляем статистику
    if (level === 'DEBUG') this.stats.debug++;
    else if (level === 'INFO') this.stats.info++;
    else if (level === 'WARN') this.stats.warn++;
    else if (level === 'ERROR') this.stats.error++;
  }

  /**
   * Логгирует INFO сообщение
   */
  info(message, stage) {
    this._log('INFO', stage, message);
  }

  /**
   * Логгирует WARN сообщение
   */
  warn(message, stage) {
    this._log('WARN', stage, message);
  }

  /**
   * Логгирует ERROR сообщение
   */
  error(message, stage) {
    this._log('ERROR', stage, message);
  }

  /**
   * Логгирует DEBUG сообщение
   */
  debug(message, stage) {
    this._log('DEBUG', stage, message);
  }

  /**
   * Логгирует старт stage
   */
  stageStart(stageId, agentId, skillId) {
    this.stats.stagesStarted++;
    const ticketInfo = this.context && this.context.ticket_id ? ` ticket="${this.context.ticket_id}"` : "";
    this.info(`START stage="${stageId}" agent="${agentId}" skill="${skillId}"${ticketInfo}`, stageId);
  }

  /**
   * Логгирует завершение stage
   */
  stageComplete(stageId, status, exitCode) {
    this.stats.stagesCompleted++;
    this.info(`COMPLETE stage="${stageId}" status="${status}" exitCode=${exitCode}`, stageId);
  }

  /**
   * Логгирует ошибку stage
   */
  stageError(stageId, errorMessage) {
    this.stats.stagesFailed++;
    this.error(`ERROR stage="${stageId}" message="${errorMessage}"`, stageId);
  }

  /**
   * Логгирует goto переход
   */
  gotoTransition(fromStage, toStage, status, params = {}) {
    this.stats.gotoTransitions++;
    const paramsStr = Object.keys(params).length > 0 ? ` params=${JSON.stringify(params)}` : '';
    this.info(`GOTO ${fromStage} → ${toStage} status="${status}"${paramsStr}`, fromStage);
  }

  /**
   * Логгирует вызов CLI
   */
  cliCall(command, args, exitCode) {
    this.stats.cliCalls++;
    this.info(`CLI command="${command}" args="${args.join(' ')}" exitCode=${exitCode}`, 'CLI');
  }

  /**
   * Логгирует retry попытку
   */
  retry(stageId, attempt, maxAttempts) {
    this.stats.retries++;
    this.warn(`RETRY stage="${stageId}" attempt=${attempt}/${maxAttempts}`, stageId);
  }

  /**
   * Логгирует таймаут
   */
  timeout(stageId, timeoutSeconds) {
    this.error(`TIMEOUT stage="${stageId}" after ${timeoutSeconds}s`, stageId);
  }

  /**
   * Записывает итоговый summary
   */
  writeSummary(outcome = null) {
    this.stats.endTime = new Date();
    const duration = this.stats.endTime - this.stats.startTime;

    const summary = [
      '',
      '═══════════════════════════════════════════════════════════',
      '                    PIPELINE SUMMARY',
      '═══════════════════════════════════════════════════════════',
      '',
      `Duration: ${(duration / 1000).toFixed(2)}s`,
      '',
      ...(outcome ? [`Outcome: ${outcome}`, ''] : []),
      '┌─────────────────────────────────────────────────────────┐',
      '│ LOG STATISTICS                                          │',
      '├─────────────────────────────────────────────────────────┤',
      `│ DEBUG messages:    ${String(this.stats.debug).padEnd(34)}│`,
      `│ INFO messages:     ${String(this.stats.info).padEnd(34)}│`,
      `│ WARN messages:     ${String(this.stats.warn).padEnd(34)}│`,
      `│ ERROR messages:    ${String(this.stats.error).padEnd(34)}│`,
      '├─────────────────────────────────────────────────────────┤',
      '│ STAGE STATISTICS                                        │',
      '├─────────────────────────────────────────────────────────┤',
      `│ Stages started:   ${String(this.stats.stagesStarted).padEnd(34)}│`,
      `│ Stages completed: ${String(this.stats.stagesCompleted).padEnd(34)}│`,
      `│ Stages failed:    ${String(this.stats.stagesFailed).padEnd(34)}│`,
      '├─────────────────────────────────────────────────────────┤',
      '│ ACTIVITY STATISTICS                                     │',
      '├─────────────────────────────────────────────────────────┤',
      `│ CLI calls:        ${String(this.stats.cliCalls).padEnd(34)}│`,
      `│ GOTO transitions: ${String(this.stats.gotoTransitions).padEnd(34)}│`,
      `│ Retries:          ${String(this.stats.retries).padEnd(34)}│`,
      '└─────────────────────────────────────────────────────────┘',
      '',
      '═══════════════════════════════════════════════════════════'
    ].join('\n');

    // Вывод summary в консоль (всегда, независимо от уровня)
    console.log(summary);

    // Запись summary в файл
    this._writeToFile(summary);
  }

}

// ============================================================================
// PromptBuilder — формирует промпты для CLI-агентов с подстановкой контекста
// ============================================================================
class PromptBuilder {
  constructor(context, counters, previousResults = {}, projectRoot = null) {
    this.context = context;
    this.counters = counters;
    this.previousResults = previousResults;
    this.projectRoot = projectRoot;
  }

  /**
   * Формирует промпт для агента на основе skill инструкции
   * @param {object} stage - Stage из конфигурации
   * @param {string} stageId - ID stage
   * @returns {string} Промпт для агента
   */
  build(stage, stageId) {
    const parts = [stage.skill || stageId];
    const skillDir = this.skillFilesLine(stage);
    if (skillDir) parts.push(skillDir);

    // Добавляем контекст если есть непустые значения
    const contextEntries = Object.entries(this.context)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '');
    if (contextEntries.length > 0) {
      parts.push('\n\nContext:');
      for (const [key, value] of contextEntries) {
        parts.push(`  ${key}: ${value}`);
      }
    }

    // Добавляем счётчики если есть
    const counterEntries = Object.entries(this.counters)
      .filter(([_, v]) => v > 0);
    if (counterEntries.length > 0) {
      parts.push('\nCounters:');
      for (const [key, value] of counterEntries) {
        parts.push(`  ${key}: ${value}`);
      }
    }

    // Добавляем блок Instructions если поле instructions задано и непустое
    if (stage.instructions && typeof stage.instructions === 'string' && stage.instructions.trim() !== '') {
      parts.push('\n\nInstructions:');
      parts.push(this.interpolate(stage.instructions.trim()));
    }

    return parts.join('\n');
  }

  /**
   * Строка промпта с каталогом скила стадии — вторая строка, сразу после имени скила:
   * `Файлы скила: .workflow/src/skills/<skill>/ — начни с …/SKILL.md; …`. Без неё агент
   * искал файлы скила по имени, а каталог скила в проекте — ссылка на канон, и поиск через
   * неё файл не находит: 2026-09-30 стратегию исполнения execute-task прочитали 2 сессии из
   * 16. Только у стадии со `skill` без `model_io` (промпт стадии с model_io читают скрипты
   * prepare и apply, а не модель) и только если каталог есть в проекте: несуществующий путь
   * агенту не называется.
   * @returns {string|null}
   */
  skillFilesLine(stage) {
    const skill = stage?.skill;
    if (typeof skill !== 'string' || !/^[\w.-]+$/.test(skill) || stage.model_io || !this.projectRoot) return null;
    const dir = `.workflow/src/skills/${skill}/`;
    try {
      if (!fs.statSync(path.join(this.projectRoot, dir, 'SKILL.md')).isFile()) return null;
    } catch {
      return null;
    }
    return `Файлы скила: ${dir} — начни с ${dir}SKILL.md; пути к файлам скила (algorithms/, knowledge/, templates/) — от корня проекта.`;
  }

  /**
   * Форматирует контекст для вывода
   */
  formatContext() {
    const entries = Object.entries(this.context)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `  ${k}: ${v}`);
    return entries.length > 0 ? entries.join('\n') : '  (пусто)';
  }

  /**
   * Форматирует счётчики для вывода
   */
  formatCounters() {
    const entries = Object.entries(this.counters)
      .map(([k, v]) => `  ${k}: ${v}`);
    return entries.length > 0 ? entries.join('\n') : '  (пусто)';
  }

  /**
   * Форматирует результаты предыдущих stages
   */
  formatPreviousResults() {
    const entries = Object.entries(this.previousResults)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
    return entries.length > 0 ? entries.join('\n') : '  (нет результатов)';
  }

  /**
   * Интерполирует переменные в строке
   * Поддерживает: $result.field, $context.field, $counter.field
   * @param {string} template - Строка с переменными
   * @param {object} resultData - Данные результата для $result.*
   * @returns {string} Строка с подставленными значениями
   */
  interpolate(template, resultData = {}) {
    if (typeof template !== 'string') {
      return template;
    }

    let resolved = template;

    // $result.* - подстановка из результата
    resolved = resolved.replace(/\$result\.(\w+)/g, (_, key) => {
      return resultData[key] !== undefined ? resultData[key] : '';
    });

    // $context.* - подстановка из контекста
    resolved = resolved.replace(/\$context\.(\w+)/g, (_, key) => {
      return this.context[key] !== undefined ? this.context[key] : '';
    });

    // $counter.* - подстановка из счётчиков
    resolved = resolved.replace(/\$counter\.(\w+)/g, (_, key) => {
      return this.counters[key] !== undefined ? this.counters[key] : 0;
    });

    return resolved;
  }
}

// ============================================================================
// ResultParser — парсит вывод агентов и извлекает структурированные данные
// ============================================================================
class ResultParser {
  // Карта нормализации статусов: синонимы → каноническое значение
  static STATUS_ALIASES = {
    pass:        'passed',
    approved:    'passed',
    success:     'passed',
    succeeded:   'passed',
    ok:          'passed',
    accepted:    'passed',
    lgtm:        'passed',
    fixed:       'passed',
    resolved:    'passed',
    fail:        'failed',
    rejected:    'failed',
    denied:      'failed',
    not_passed:  'failed',
    err:         'error',
    crash:       'error',
    timeout:     'error',
  };

  /**
   * Нормализует статус: приводит синонимы к каноническому значению
   * @param {string} status
   * @returns {string}
   */
  normalizeStatus(status) {
    const lower = status.toLowerCase();
    const canonical = ResultParser.STATUS_ALIASES[lower];
    if (canonical) {
      console.log(`[ResultParser] Normalized status: "${status}" → "${canonical}"`);
      return canonical;
    }
    return status;
  }

  /**
   * Парсит вывод агента и извлекает результат между маркерами
   * @param {string} output - stdout агента
   * @param {string} stageId - ID stage для логирования
   * @returns {{status: string, data: object, raw: string}}
   */
  parse(output, stageId) {
    const marker = '---RESULT---';

    // Ищем маркеры ТОЛЬКО на отдельных строках (printResult выводит их на своих строках).
    // Берём последнюю пару: маркер может случайно встретиться в логах/заголовках тикетов
    // до финального блока (напр. "title: ... ---RESULT--- ..."). Regex ^---RESULT---$
    // с multi-line флагом отсеивает такие вхождения.
    const lineMarkerRegex = /^---RESULT---\s*$/gm;
    const markerPositions = [];
    let m;
    while ((m = lineMarkerRegex.exec(output)) !== null) {
      markerPositions.push(m.index);
    }

    const count = markerPositions.length;
    let resultBlock = null;

    // Незакрытый финальный блок: последний маркер без пары, после него — строка status.
    // Рельсы такой ответ принимают (final_requires execute-task — маркер и status, без
    // закрывающего маркера), а парсер видел «нет RESULT»: 2026-09-25 PulseProxy, gpt-luna
    // через kilo выполнил IMPL-107 и завершил ответ так — запуск ушёл в ошибку. Хвост
    // берётся только при нечётном числе маркеров и со строкой status: одиночный маркер
    // из эха тикета или лога перед закрытым блоком не перехватывает результат.
    if (count % 2 === 1) {
      const tail = output.substring(markerPositions[count - 1] + marker.length).trim();
      if (/^status:[ \t]*\S/m.test(tail)) resultBlock = tail;
    }
    if (resultBlock === null && count >= 2) {
      resultBlock = output.substring(markerPositions[count - 2] + marker.length, markerPositions[count - 1]).trim();
    }

    if (resultBlock !== null) {
      // Найдены маркеры — парсим структурированный блок
      const data = this.parseResultBlock(resultBlock);

      const normalizedStatus = this.normalizeStatus(data.status || 'default');
      console.log(`[ResultParser] Parsed structured result for ${stageId}: status=${normalizedStatus}`);

      return {
        status: normalizedStatus,
        data: data.data || {},
        raw: output,
        parsed: true
      };
    }

    // Fallback: пытаемся парсить текстовый вывод
    console.log(`[ResultParser] No result markers found for ${stageId}, attempting fallback parsing`);
    return this.fallbackParse(output, stageId);
  }

  /**
   * Парсит блок результата в формате key: value с поддержкой многострочных YAML-значений.
   * При обнаружении ключа без значения (key:) читает последующие индентированные строки
   * как тело значения до следующего ключа верхнего уровня (строки без indent).
   * @param {string} block - Текстовый блок результата
   * @returns {{status: string, data: object}}
   */
  parseResultBlock(block) {
    const lines = block.split('\n');
    const data = {};
    let status = 'default';
    let currentKey = null;
    let multilineValue = null;

    const flushMultiline = () => {
      if (currentKey !== null && multilineValue !== null) {
        // Убираем trailing newline, сохраняем сырой YAML-блок
        data[currentKey] = multilineValue.replace(/\n$/, '');
        currentKey = null;
        multilineValue = null;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Проверяем: строка верхнего уровня (без indent) с ключом
      const topLevelMatch = line.match(/^([^:\s][^:]*):\s*(.*)$/);

      if (topLevelMatch) {
        // Если копим многострочное значение — сбрасываем
        flushMultiline();

        const key = topLevelMatch[1].trim();
        const value = topLevelMatch[2].trim();

        if (value !== '') {
          // Однострочное key: value — как прежде
          if (key === 'status') {
            status = value;
          } else {
            data[key] = value;
          }
        } else {
          // Ключ без значения — потенциальное многострочное YAML-значение
          currentKey = key;
          multilineValue = '';
        }
      } else if (currentKey !== null && (line.startsWith(' ') || line.startsWith('\t') || line === '')) {
        // Индентированная строка (или пустая) — накапливаем как тело multiline-значения
        multilineValue += line + '\n';
      } else if (currentKey !== null) {
        // Строка без indent и не key: value — конец multiline-блока
        flushMultiline();
      }
      // Игнорируем строки без ключа верхнего уровня если не в multiline-режиме
    }

    // Сбрасываем последнее multiline-значение
    flushMultiline();

    return { status, data };
  }

  /**
   * Fallback-парсинг для вывода без маркеров
   * Пытается извлечь статус из текстового вывода
   * @param {string} output - stdout агента
   * @param {string} stageId - ID stage для логирования
   * @returns {{status: string, data: object, raw: string}}
   */
  fallbackParse(output, stageId) {
    const lines = output.split('\n');
    let status = 'default';
    const extractedData = {};
    let inResultSection = false;

    // Ищем паттерны вида "status: xxx" или "Status: xxx" в любом месте вывода
    for (const line of lines) {
      const trimmedLine = line.trim();

      // Паттерн для извлечения статуса
      const statusMatch = trimmedLine.match(/^(?:status|Status):\s*(\w+)/i);
      if (statusMatch) {
        status = statusMatch[1];
        inResultSection = true;
        continue;
      }

      // Если нашли статус, пытаемся извлечь дополнительные данные
      if (inResultSection) {
        const dataMatch = trimmedLine.match(/^(\w+):\s*(.+)$/i);
        if (dataMatch && dataMatch[1].toLowerCase() !== 'status') {
          extractedData[dataMatch[1]] = dataMatch[2];
        }
      }
    }

    // Если статус не найден, пытаемся определить по ключевым словам
    if (status === 'default') {
      const lowerOutput = output.toLowerCase();
      if (lowerOutput.includes('completed') || lowerOutput.includes('success') || lowerOutput.includes('done')) {
        status = 'default';
        extractedData._inferred = 'success_keywords';
      } else if (lowerOutput.includes('error') || lowerOutput.includes('failed')) {
        status = 'error';
        extractedData._inferred = 'error_keywords';
      }
    }

    const normalizedStatus = this.normalizeStatus(status);
    console.log(`[ResultParser] Fallback parsing for ${stageId}: status=${normalizedStatus}`);

    return {
      status: normalizedStatus,
      data: extractedData,
      raw: output,
      parsed: false
    };
  }
}

// ============================================================================
// FileGuard — защита файлов от несанкционированного изменения агентами
// ============================================================================
class FileGuard {
  constructor(patterns, projectRoot = process.cwd(), trustedAgents = [], trustedStages = []) {
    this.enabled = patterns && patterns.length > 0;
    this.snapshots = new Map();
    this.patterns = (patterns || []).map(p => {
      if (typeof p === 'string') {
        return { pattern: p.replace(/\\/g, '/'), mode: 'full' };
      }
      return { pattern: p.pattern.replace(/\\/g, '/'), mode: p.mode || 'full' };
    });
    // projectRoot — корневая директория проекта, относительно которой указаны паттерны
    this.projectRoot = projectRoot;
    // Доверенные агенты — для них FileGuard не откатывает изменения
    this.trustedAgents = trustedAgents;
    // Доверенные стейджи — для них FileGuard не откатывает изменения
    this.trustedStages = trustedStages;
  }

  /**
   * Проверяет, является ли агент или стейдж доверенным (пропускает FileGuard)
   * Поддерживает glob-паттерны: "script-*" соответствует "script-move", "script-pick" и т.д.
   * @param {string} agentId - ID агента
   * @param {string} [stageId] - ID стейджа (опционально)
   * @returns {boolean}
   */
  isTrusted(agentId, stageId) {
    // Проверка по trustedAgents (glob-паттерны)
    const agentMatch = this.trustedAgents.some(pattern => {
      if (pattern.endsWith('*')) {
        return agentId.startsWith(pattern.slice(0, -1));
      }
      return agentId === pattern;
    });
    if (agentMatch) return true;

    // Проверка по trustedStages (точное совпадение)
    if (stageId && this.trustedStages.includes(stageId)) {
      return true;
    }

    return false;
  }

  /**
   * Проверяет, соответствует ли путь файла защищённым паттернам
   * @param {string} filePath - Путь к файлу (нормализованный через /)
   * @returns {boolean}
   */
  matchesProtected(filePath) {
    const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
    return this.patterns.some(p => this._matchGlob(relativePath, p.pattern));
  }

  /**
   * Glob-сопоставление: поддерживает * (в пределах директории) и ** (через директории)
   * @param {string} filePath - Нормализованный путь
   * @param {string} pattern - Glob-паттерн
   * @returns {boolean}
   */
  _matchGlob(filePath, pattern) {
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const regexStr = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // экранируем regex-символы (кроме *)
      .replace(/\*\*/g, '\x00')              // ** → временный placeholder
      .replace(/\*/g, '[^/]*')               // * → совпадение внутри директории
      .replace(/\x00/g, '.*');              // placeholder → .* (через директории)
    return new RegExp('^' + regexStr + '$').test(filePath);
  }

  /**
   * Извлекает базовую директорию из glob-паттерна (до первого wildcard)
   * @param {string} pattern - Glob-паттерн
   * @returns {string} Базовая директория
   */
  _getBaseDir(pattern) {
    const parts = pattern.replace(/\\/g, '/').split('/');
    const nonWildcardParts = [];
    for (const part of parts) {
      if (part.includes('*')) break;
      nonWildcardParts.push(part);
    }
    return nonWildcardParts.join('/') || '.';
  }

  /**
   * Рекурсивно получает все файлы в директории
   * @param {string} dir - Директория для сканирования
   * @returns {string[]} Список путей к файлам (нормализованных через /)
    */
  _getAllFiles(dir) {
    const files = [];
    if (!fs.existsSync(dir)) return files;
    const stats = fs.statSync(dir);
    if (!stats.isDirectory()) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        files.push(...this._getAllFiles(entryPath));
      } else {
        files.push(entryPath);
      }
    }
    return files;
  }

  /**
   * Вычисляет SHA256-хэш содержимого файла
   * @param {string} filePath - Путь к файлу
   * @returns {string|null} Хэш или null если файл не существует
   */
  _hashFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Снимает snapshot защищённых файлов перед выполнением stage
   */
  takeSnapshot() {
    if (!this.enabled) return;
    this.snapshots.clear();

    for (const { pattern, mode } of this.patterns) {
      if (!pattern.includes('*')) {
        const absolutePath = path.resolve(this.projectRoot, pattern);
        if (fs.existsSync(absolutePath)) {
          if (mode === 'structure') {
            this.snapshots.set(absolutePath, { hash: this._hashFile(absolutePath), content: fs.readFileSync(absolutePath, null), mode: 'structure' });
          } else {
            this.snapshots.set(absolutePath, this._hashFile(absolutePath));
          }
        }
      } else {
        const baseDir = path.resolve(this.projectRoot, this._getBaseDir(pattern));
        const files = this._getAllFiles(baseDir);
        for (const filePath of files) {
          if (this.matchesProtected(filePath)) {
            if (mode === 'structure') {
              this.snapshots.set(filePath, { hash: this._hashFile(filePath), content: fs.readFileSync(filePath, null), mode: 'structure' });
            } else {
              this.snapshots.set(filePath, this._hashFile(filePath));
            }
          }
        }
      }
    }

    console.log(`[FileGuard] Snapshot taken: ${this.snapshots.size} protected files`);
  }

  /**
   * Проверяет целостность защищённых файлов и откатывает несанкционированные изменения.
   * Обнаруживает как изменения/удаления существующих файлов, так и создание новых.
   * @returns {string[]} Список изменённых (и откаченных) файлов
   */
  checkAndRollback() {
    if (!this.enabled) return [];

    const violations = [];

    for (const [filePath, snapshot] of this.snapshots) {
      const mode = snapshot.mode || 'full';
      if (mode === 'structure') {
        if (!fs.existsSync(filePath)) {
          violations.push(filePath);
          console.warn(`[FileGuard] WARNING: Protected file deleted: ${filePath}`);
          try {
            fs.writeFileSync(filePath, snapshot.content);
            console.warn(`[FileGuard] WARNING: Restored deleted file: ${filePath}`);
          } catch (err) {
            console.error(`[FileGuard] ERROR: Failed to restore ${filePath}: ${err.message}`);
          }
        }
      } else {
        const currentHash = this._hashFile(filePath);
        if (currentHash !== snapshot) {
          violations.push(filePath);
          console.warn(`[FileGuard] WARNING: Protected file modified: ${filePath}`);
          this._rollbackFile(filePath);
        }
      }
    }

    for (const { pattern, mode } of this.patterns) {
      const baseDir = pattern.includes('*')
        ? path.resolve(this.projectRoot, this._getBaseDir(pattern))
        : path.resolve(this.projectRoot, pattern);

      const currentFiles = this._getAllFiles(baseDir);
      for (const filePath of currentFiles) {
        if (this.matchesProtected(filePath) && !this.snapshots.has(filePath)) {
          violations.push(filePath);
          console.warn(`[FileGuard] WARNING: New file in protected area: ${filePath}`);
          this._removeNewFile(filePath);
        }
      }
    }

    if (violations.length > 0) {
      console.warn(`[FileGuard] WARNING: Rolled back ${violations.length} protected file(s): ${violations.join(', ')}`);
    } else {
      console.log('[FileGuard] No protected files were modified');
    }

    return violations;
  }

  /**
   * Удаляет файл, созданный агентом в защищённой директории
   * @param {string} filePath - Путь к файлу
   */
  _removeNewFile(filePath) {
    try {
      fs.unlinkSync(filePath);
      console.warn(`[FileGuard] WARNING: Removed unauthorized new file: ${filePath}`);
    } catch (err) {
      console.error(`[FileGuard] ERROR: Failed to remove ${filePath}: ${err.message}`);
    }
  }

  /**
   * Откатывает файл к последнему зафиксированному состоянию через git
   * @param {string} filePath - Путь к файлу
   */
  _rollbackFile(filePath) {
    try {
      execSync(`git checkout -- "${filePath}"`, { stdio: 'pipe', windowsHide: true });
      console.warn(`[FileGuard] WARNING: Rolled back: ${filePath}`);
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      console.error(`[FileGuard] ERROR: Failed to rollback ${filePath}: ${errMsg}`);
    }
  }
}

// ============================================================================
// StageExecutor — выполняет stages через вызов CLI-агентов
// ============================================================================
// FIX-16. stderr агента писался в pipeline-лог построчно и без ограничения
// длины. При ошибке LLM-провайдера (AI_APICallError) туда попадает
// сериализованный request body с промптами: наблюдались строки по 74–232 КБ и
// логи до 9.9 МБ, а list_ghost_executions в workflow-mcp отдавал 5.5 МБ, потому
// что excerpt захватывал такую строку целиком. Заодно это утечка содержимого
// контекста агентов в логи. Режем head+tail, как уже делает error-classifier.
const STDERR_LOG_LINE_LIMIT = 2048;

export function truncateStderrLine(line, limit = STDERR_LOG_LINE_LIMIT) {
  if (typeof line !== 'string' || line.length <= limit) return line;
  const half = Math.floor(limit / 2);
  return `${line.slice(0, half)}...[TRUNCATED ${line.length - limit} bytes]...${line.slice(-half)}`;
}

class StageExecutor {
  constructor(config, context, counters, previousResults = {}, fileGuard = null, logger = null, projectRoot = process.cwd(), options = {}) {
    this.config = config;
    this.context = context;
    this.counters = counters;
    this.previousResults = previousResults;
    this.pipeline = config.pipeline;
    this.projectRoot = projectRoot;
    this.fileGuard = fileGuard;
    this.logger = logger;

    // Инициализируем билдер и парсер
    this.promptBuilder = new PromptBuilder(context, counters, previousResults, projectRoot);
    this.resultParser = new ResultParser();

    // Текущий дочерний процесс агента (для kill при shutdown)
    this.currentChild = null;

    // Прерывание текущего вызова безынструментной модели (для shutdown): у него
    // нет дочернего процесса, killCurrentChild снимает HTTP-запрос через signal.
    this.currentModelAbort = null;

    // Запрошена остановка (killCurrentChild): стадия не переходит к следующему
    // агенту и не начинает новый вызов модели. Без флага убитый prepare/apply или
    // CLI-агент выглядел как обычный сбой, и executeWithFallback брал следующего
    // агента уже после запроса на остановку.
    this.stopRequested = false;

    // Остановка для команд пула моделей (шлагбаум, runPoolCommand): у них нет записи в
    // currentChild, killCurrentChild снимает их дерево через этот signal.
    this.stopAbort = new AbortController();

    // run_id пайплайна (PipelineRunner.runId): имя файла ответа модели в
    // .workflow/state/model-io/ привязывает вызов к запуску и его логу.
    this.pipelineRunId = options.runId || null;

    // Таймауты вызовов пула моделей (src/lib/model-pools.mjs): агент-селектор — 60 с (П4),
    // шлагбаум — 15 с (П14); тесты их уменьшают.
    this.selectorTimeoutMs = options.selectorTimeoutMs ?? SELECTOR_TIMEOUT_MS;
    this.gateTimeoutMs = options.gateTimeoutMs ?? GATE_TIMEOUT_MS;
    // Период строки HEARTBEAT во время агента (HEARTBEAT_INTERVAL_MS); тесты его уменьшают.
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;

    // Правила health-классификатора (инициализируются один раз в конструкторе)
    this.rules = loadRules(projectRoot);

    // Лениво загружаемые правила health-классификатора для онлайн-сканирования stderr
    this._healthRules = null;
  }

  /**
   * Готовит stderr к записи в лог: длинные строки режутся, а полный текст
   * кладётся отдельным файлом рядом с логом — диагностика не теряется.
   */
  prepareStderrForLog(stderr, stageId) {
    const lines = stderr.trim().split('\n');
    const prepared = lines.map(line => truncateStderrLine(line));
    const truncated = prepared.some((line, i) => line !== lines[i]);
    return {
      lines: prepared,
      dumpPath: truncated ? this.dumpFullStderr(stderr, stageId) : null
    };
  }

  /** Полный stderr в .workflow/logs/stderr/. Возвращает путь или null. */
  dumpFullStderr(stderr, stageId) {
    try {
      const dir = path.join(this.projectRoot, '.workflow', 'logs', 'stderr');
      fs.mkdirSync(dir, { recursive: true });
      const safeStage = String(stageId || 'stage').replace(/[^\w.-]+/g, '_');
      const file = path.join(dir, `${safeStage}-${Date.now()}.log`);
      fs.writeFileSync(file, stderr);
      return path.relative(this.projectRoot, file).replace(/\\/g, '/');
    } catch {
      return null;
    }
  }

  /** Возвращает правила health-классификатора, загружая их при первом обращении. */
  _getHealthRules() {
    if (this._healthRules !== null) return this._healthRules;
    try {
      this._healthRules = loadRules(this.projectRoot);
    } catch (e) {
      if (this.logger) {
        this.logger.warn(`Failed to load agent-health-rules: ${e.message}`, 'CLI');
      }
      this._healthRules = { common: [], agents: new Map() };
    }
    return this._healthRules;
  }

  /**
   * Убивает текущий дочерний процесс агента
   */
  killCurrentChild() {
    this.stopRequested = true;
    this.currentModelAbort?.abort();
    this.stopAbort?.abort();
    const child = this.currentChild;
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true }); } catch {}
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  /**
   * Жёсткое снятие текущего агента — повторный сигнал во время мягкой остановки
   * (runPipeline): на POSIX агент мог не выйти по `SIGTERM` из killCurrentChild, и
   * без `SIGKILL` он пережил бы выход раннера. `SIGKILL` снимает только сам процесс
   * агента, не его потомков. На Windows дерево агента снимает уже killCurrentChild
   * (`taskkill /T /F`); повтор — на случай, если дерево ещё живо.
   */
  forceKillCurrentChild() {
    this.stopRequested = true;
    this.currentModelAbort?.abort();
    this.stopAbort?.abort();
    const child = this.currentChild;
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true }); } catch {}
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  /**
   * Действующие запреты моделей по журналу запусков. Журнал не читается — null:
   * агенты тогда не фильтруются, в лог — WARN.
   */
  _loadBans(stageId) {
    try {
      return activeBans(readRunEvents(this.projectRoot), Date.now());
    } catch (err) {
      if (this.logger) this.logger.warn(`agent-runs: journal not readable, model bans not applied: ${err.message}`, stageId);
      return null;
    }
  }

  /**
   * Строит список кандидатов-агентов для стейджа с учётом типа задачи,
   * required_capabilities и номера попытки. Возвращает:
   *   { agentId, effectiveStage, attempt, compatible[, pool, poolCandidates] } — если кандидат найден,
   *   { blocked: 'no_capable_agent' | 'all_unhealthy' | 'all_banned', reason } — иначе.
   *
   * Алгоритм:
   *   1. Список берётся из stage.agents_by_type[task_type].agents,
   *      иначе stage.agents, иначе pipeline.default_agents.
   *   2. Список фильтруется: агент должен покрывать все required_capabilities,
   *      быть здоровым по health-реестру, без запрета модели (стадия исполнителя)
   *      и не пробованным в этой попытке (excludeAgents).
   *   3. Берётся элемент [(attempt-1) % length] (1-based attempt).
   *   4. Скрипт-агенты (stage.agent: script-*) обрабатываются в отдельной ветке
   *      execute() — сюда не попадают.
   *
   * Пул моделей (запись с `models`, src/lib/model-pools.mjs) — одно место списка, а
   * не его участники: развёрнутый пул при `max: 6` забрал бы все попытки курсором.
   * Место пула проходит фильтр, если его проходит хотя бы один участник; здоровье
   * проверяется и у самого id пула. Из попытки место уходит, когда в excludeAgents уже
   * max_per_attempt участников пула или непробованных подходящих не осталось. Выбранное
   * место-пул отдаёт первого по маске участника, прошедшего фильтры, — `agentId`
   * участника (`<пул>@<id>`), `pool` и `poolCandidates` (кандидаты места по порядку).
   * Участник, уже запускавшийся на тикете, уступает незапускавшимся (_preferNotRunOnTicket).
   * Пул в списке дважды — у мест общие участники и общий счёт max_per_attempt.
   */
  resolveAgent(stage, stageId, options = {}) {
    const survivors = this._stageSurvivors(stage, stageId, options.excludeAgents || []);
    if (survivors.blocked) return survivors;
    return this._cursorPick(survivors, stageId);
  }

  /**
   * Место курсора среди выживших _stageSurvivors: курсор resolveAgent и выбор модели
   * стадии, когда ни у одного выжившего нет оценки (_resolveGoverned).
   */
  _cursorPick(survivors, stageId) {
    const { places, attempt, effectiveStage, isPool, poolOf } = survivors;

    // Курсор = (attempt - 1) % length — ротация по кругу
    const cursor = (attempt - 1) % places.length;

    const place = places[cursor];
    if (!isPool(place)) {
      return { agentId: place, effectiveStage, attempt, compatible: places };
    }
    const poolCandidates = this._preferNotRunOnTicket(poolOf(place).untried, stageId);
    return { agentId: poolCandidates[0], effectiveStage, attempt, compatible: places, pool: place, poolCandidates };
  }

  /**
   * Выжившие места списка стадии — фильтры 1–5 resolveAgent (способности, health-реестр,
   * запреты моделей, excludeAgents и max_per_attempt пула) без выбора места курсором.
   * Общий шаг курсора (resolveAgent) и выбора модели стадии (_resolveGoverned).
   * @returns {{places: string[], attempt: number, effectiveStage: object, isPool: (id) => boolean,
   *   poolOf: (id) => {members: string[], untried: string[]}} | {blocked: string, reason: string, attempt: number}}
   *   places — выжившие места в порядке списка (пул — одним местом), poolOf(id).untried —
   *   участники места-пула, прошедшие фильтры
   */
  _stageSurvivors(stage, stageId, excludeAgents) {
    // Семантика: counter = число УЖЕ ИСЧЕРПАННЫХ попыток (0 на старте, инкрементируется
    // стадией `increment-*-attempts` ПОСЛЕ каждой неудачи). attempt — номер текущей
    // (1-based). Читаем counter через ?? 0, чтобы отличать «ещё не запускались»
    // от «была 1 попытка» — иначе оффсет-by-one и ротация застревает на первом агенте.
    const attempt = (stage.counter ? (this.counters[stage.counter] ?? 0) : 0) + 1;

    // Task type: явно из context либо из префикса ticket_id
    const taskType = this.context.task_type
      || (this.context.ticket_id && this.context.ticket_id.split('-')[0].toLowerCase())
      || null;

    // Выбор источника списка агентов и instructions
    let agentIds;
    let instructions = stage.instructions;
    const byType = stage.agents_by_type && taskType && stage.agents_by_type[taskType];
    if (byType && Array.isArray(byType.agents)) {
      agentIds = byType.agents;
      if (byType.instructions !== undefined) instructions = byType.instructions;
    } else if (Array.isArray(stage.agents)) {
      agentIds = stage.agents;
    } else if (Array.isArray(this.pipeline.default_agents)) {
      agentIds = this.pipeline.default_agents;
    } else {
      throw new Error(`Stage "${stageId}": no agents list and no default_agents`);
    }

    // Требуемые capabilities тикета из context.required_capabilities.
    // Приходит из pick-next-task.js как JSON-строка (из-за toString() в $context.*),
    // либо уже как массив (при прямом задании в pipeline.context).
    let required = [];
    const raw = this.context.required_capabilities;
    if (Array.isArray(raw)) {
      required = raw;
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) required = parsed;
      } catch {
        // Не JSON — игнорируем
      }
    }

    const agents = this.pipeline.agents;
    const isPool = (id) => isModelPool(agents[id]);
    // Участники мест-пулов по ступеням фильтров (id пула → { members, capable,
    // healthy, allowed, untried }): считаются один раз, даже если пул стоит дважды.
    const poolSteps = new Map();
    const poolOf = (id) => {
      if (!poolSteps.has(id)) poolSteps.set(id, { members: poolMembers(agents, id) });
      return poolSteps.get(id);
    };
    const coversRequired = (agent) => {
      const caps = Array.isArray(agent?.capabilities) ? agent.capabilities : [];
      return required.every(r => caps.includes(r));
    };

    // Фильтр по capability-совместимости
    const covers = (agentId) => {
      const agent = agents[agentId];
      if (!agent) return false;
      if (!isModelPool(agent)) return coversRequired(agent);
      const pool = poolOf(agentId);
      pool.capable ??= pool.members.filter(id => coversRequired(agents[id]));
      return pool.capable.length > 0;
    };
    const afterCapabilities = agentIds.filter(covers);

    // Фильтр по health-реестру: unhealthy-агенты с неистёкшим TTL пропускаются.
    // Реестр персистентный между attempt'ами (план rev.3, решение 6.5). У места-пула —
    // и id пула, и его участники (ключ участника — маршрут `<пул>@<id>`).
    const healthy = (agentId) => {
      if (!isHealthy(this.projectRoot, agentId)) return false;
      if (!isPool(agentId)) return true;
      const pool = poolOf(agentId);
      pool.healthy ??= pool.capable.filter(id => isHealthy(this.projectRoot, id));
      return pool.healthy.length > 0;
    };
    const afterHealth = afterCapabilities.filter(healthy);

    // Фильтр по запретам моделей из журнала запусков (PLAN-003) — только на стадии
    // исполнителя: одна модель стоит и у исполнителя, и у судьи ревью, и запрет за
    // провалы исполнителя не должен снимать судью (решение 2026-09-26, «Только
    // исполнитель»). Ключ модели — тот же, что у события run (configuredModelKey):
    // роутер kilo по ключу роутера не отсеивается, его модели отсеивает остановка
    // в опросе базы kilo (_trackKiloModels). Место-пул под запретом, когда запрещены
    // модели всех его здоровых участников.
    const banned = new Map();
    const bans = stage.skill === EXECUTOR_SKILL && afterHealth.length > 0 ? this._loadBans(stageId) : null;
    const notBanned = (id) => {
      if (!bans) return true;
      const model = configuredModelKey(agents[id], id);
      const ban = findBan(bans, model, taskType);
      if (!ban) return true;
      banned.set(id, ban);
      if (this.logger) this.logger.info(`agent ${id} skipped: model "${model}" — ${describeBan(ban)}`, stageId);
      return false;
    };
    for (const id of new Set(afterHealth)) {
      if (!isPool(id)) notBanned(id);
      else poolOf(id).allowed = poolOf(id).healthy.filter(notBanned);
    }
    const afterBans = afterHealth.filter(id => (isPool(id) ? poolOf(id).allowed.length > 0 : !banned.has(id)));

    // Фильтр по excludeAgents (для in-stage fallback в рамках одной attempt)
    const excluded = new Set(excludeAgents);
    const untried = (id) => {
      if (!isPool(id)) return !excluded.has(id);
      // Id пула в excludeAgents — место закрыто шлагбаумом в этой попытке (executeWithFallback).
      if (excluded.has(id)) return false;
      const pool = poolOf(id);
      pool.untried = pool.allowed.filter(member => !excluded.has(member));
      const triedMembers = pool.members.filter(member => excluded.has(member)).length;
      return triedMembers < poolMaxPerAttempt(agents[id]) && pool.untried.length > 0;
    };
    const afterExclude = afterBans.filter(untried);

    if (afterExclude.length === 0) {
      // Все агенты — под запретом модели: тикет уходит по goto.blocked, причина
      // называет запрет, а не нездоровье агентов.
      if (afterHealth.length > 0 && afterBans.length === 0) {
        return {
          blocked: 'all_banned',
          reason: `All capable agents have banned models: ${[...banned].map(([id, ban]) => `${id} (${ban.model}: ${describeBan(ban)})`).join('; ')}`,
          attempt
        };
      }
      // Все capability-совместимые агенты либо unhealthy в реестре, либо уже пробованы в этой attempt.
      if (afterCapabilities.length > 0) {
        return {
          blocked: 'all_unhealthy',
          reason: excludeAgents.length > 0
            ? `All agents tried in fallback`
            : `All capable agents are unhealthy in registry`,
          attempt
        };
      }
      const emptyPools = [...new Set(agentIds.filter(id => isPool(id) && poolOf(id).members.length === 0))];
      return {
        blocked: 'no_capable_agent',
        reason: `No agent in [${agentIds.join(', ')}] covers required_capabilities [${required.join(', ')}]`
          + (emptyPools.length > 0 ? `; model pools without members: ${emptyPools.join(', ')}` : ''),
        attempt
      };
    }

    // Клонируем stage с подменой instructions (для agents_by_type override)
    const effectiveStage = { ...stage, instructions };
    return { places: afterExclude, attempt, effectiveStage, isPool, poolOf };
  }

  /**
   * Мягкий фильтр 5 выбора участника пула (PLAN-004, П9): участники, модель которых
   * ещё не запускалась на тикете контекста (нет события run журнала с тем же `ticket`
   * и `model` = ключ участника), в порядке маски; таких нет — все кандидаты как есть.
   * Журнал — сырые события: `reset` на фильтр не влияет. Без тикета в контексте или
   * при нечитаемом журнале (WARN) фильтра нет.
   */
  _preferNotRunOnTicket(candidates, stageId) {
    const ticket = this.context?.ticket_id;
    if (!ticket) return candidates;
    let events;
    try {
      events = readRunEvents(this.projectRoot);
    } catch (err) {
      if (this.logger) this.logger.warn(`agent-runs: journal not readable, pool members not ordered by ticket runs: ${err.message}`, stageId);
      return candidates;
    }
    const ran = new Set(events.filter(e => e.type === 'run' && e.ticket === ticket && e.model).map(e => e.model));
    const fresh = candidates.filter(id => !ran.has(configuredModelKey(this.pipeline.agents[id], id)));
    return fresh.length > 0 ? fresh : candidates;
  }

  /**
   * Шлагбаум места-пула `models.gate` (PLAN-004, П14, раздел плана «Шлагбаум пула») —
   * перед каждым запуском участника пула, до селектора. Команда запускается по правилам
   * команды списка (runPoolCommand: корень проекта, buildAgentEnv, shell на Windows кроме
   * `node`) со своим таймаутом. Ответ — RESULT `status: open|closed`, `remaining: <число>`
   * и выход 0. Это не roll-call: модель не вызывается.
   *
   * `closed` — место закрыто до ближайших 00:00 UTC: запись health-реестра по id пула с
   * TTL `until_utc_midnight` (не меньше 30 мин, parseTtl). Фильтр здоровья resolveAgent
   * проверяет id места-пула, поэтому закрытие действует во всех попытках и стадиях, на оба
   * места пула, стоящего в списке дважды, и после перезапуска раннера. Выход ≠ 0, таймаут,
   * ответ без RESULT или без `status: open|closed` — `error`: WARN, место не закрывается.
   * Остановка пайплайна (killCurrentChild → stopAbort) снимает команду сразу — тоже `error`.
   * Журнал запусков и строка истории тикета не пишутся.
   *
   * @returns {Promise<'open'|'closed'|'error'|null>} null — у пула нет шлагбаума
   */
  async _poolGate(poolId, stageId) {
    const gate = this.pipeline.agents[poolId]?.models?.gate;
    if (!gate) return null;
    const started = Date.now();
    // Остановка пайплайна снимает шлагбаум (stopAbort): `aborted` — это `error`, место не закрывается.
    const run = await runPoolCommand(gate, {
      cwd: this.projectRoot, timeoutMs: this.gateTimeoutMs, logger: this.logger, stageId, signal: this.stopAbort?.signal,
    });
    const parsed = this.resultParser.parse(run.stdout, stageId);
    const data = parsed.parsed ? parsed.data : {};
    const remaining = resultNumber(data.remaining);
    let status = 'error';
    let problem = null;
    if (!run.ok) problem = run.reason;
    else if (!parsed.parsed) problem = 'no ---RESULT--- block';
    else if (parsed.status === 'open' || parsed.status === 'closed') status = parsed.status;
    else problem = `status "${parsed.status}"`;

    let until = null;
    if (status === 'closed') {
      until = new Date(parseTtl('until_utc_midnight', Date.now())).toISOString();
      try {
        markUnhealthy(this.projectRoot, poolId, {
          class: 'unavailable',
          ttl: 'until_utc_midnight',
          rule_id: 'pool-gate-closed',
          reason: `models.gate: closed, remaining=${remaining ?? 'unknown'}`,
        });
      } catch (markErr) {
        if (this.logger) this.logger.warn(`health mark failed for ${poolId}: ${markErr.message}`, stageId);
      }
    }
    if (this.logger) {
      this.logger.info(
        `GATE agent="${poolId}" status=${status} remaining=${remaining ?? 'unknown'} until=${until ?? '-'} ` +
        `duration_ms=${Date.now() - started}`,
        stageId
      );
      if (problem) {
        const detail = data.error ? redactNetworkDetail(String(data.error)) : run.stderr.trim().split(/\r?\n/).pop();
        this.logger.warn(`pool "${poolId}": models.gate error (${problem}${detail ? `: ${detail}` : ''}) — place stays open`, stageId);
      }
    }
    return status;
  }

  /**
   * Ранжир участников места-пула агентом-селектором `models.selector` (PLAN-004, П1,
   * П15, раздел плана «Селектор»). Вызов — при всех условиях: у пула задан селектор, в
   * контексте есть тикет, кандидатов не меньше двух, селектор здоров по health-реестру.
   * Иначе вызова нет — null, порядок маски.
   *
   * Селектору — первые SELECTOR_MAX_CANDIDATES кандидатов в порядке маски: промпт
   * buildSelectorPrompt (тикет — selectorTicket, кандидаты с оценками — poolSelectorData)
   * через stdin, путём агентов с командой (_callAgentOnce) с ролью рельс executor и своим
   * таймаутом. Журнал запусков, снимки и строка истории тикета не пишутся. Ответ —
   * `ranking:` в RESULT (selectorRanking). Исходы строки SELECT: `none` — в ранжире есть
   * кандидат; `unknown_id` — нет ни одного; `error` — выход ≠ 0 или `status: error`;
   * `timeout` — снят по таймауту. Кроме `none` — null, порядок маски.
   *
   * Сбой помечает селектора в health-реестре по MODEL_ERROR_HEALTH, как _modelIoFailure:
   * класс — `error_class` ответа, таймаут раннера — `timeout`; снятие онлайн-сканом по
   * правилу health самого селектора — класс и TTL правила. Нездоровый селектор до конца
   * TTL не вызывается.
   *
   * @returns {Promise<string[]|null>} id участников `<пул>@<id>` по ранжиру или null
   */
  async _poolSelectorOrder(poolId, poolCandidates, stageId, skillId) {
    const selectorId = this.pipeline.agents[poolId]?.models?.selector;
    const selector = selectorId ? this.pipeline.agents[selectorId] : null;
    const ticketId = this.context?.ticket_id;
    if (!selector || !ticketId || poolCandidates.length < 2) return null;
    if (!isHealthy(this.projectRoot, selectorId)) {
      if (this.logger) this.logger.info(`pool "${poolId}": selector "${selectorId}" unhealthy in registry — mask order`, stageId);
      return null;
    }

    const { candidates, citation } = poolSelectorData(this.pipeline, poolId, poolCandidates.slice(0, SELECTOR_MAX_CANDIDATES));
    const ticket = selectorTicket(findTicketPathForId(ticketId, this.projectRoot), { id: ticketId, type: ticketTypeOf(this.context) });
    const prompt = buildSelectorPrompt({ pool: poolId, ticket, candidates, citation });
    const started = Date.now();
    let ranked = [];
    const call = await this._runSelector(selectorId, selector, prompt, stageId, skillId,
      `selector pool=${poolId} candidates=${candidates.length} prompt_chars=${prompt.length}`);
    let fallback = call.fallback ?? 'none';
    if (!call.fallback) {
      ranked = selectorRanking(call.result.result?.ranking, candidates.map(c => c.id));
      if (ranked.length === 0) fallback = 'unknown_id';
    }
    const cost = call.cost;
    this._markSelectorFailure(selectorId, call, stageId);
    const member = fallback === 'none' ? ranked[0] : candidates[0].id;
    if (this.logger) {
      this.logger.info(
        `SELECT agent="${poolId}" selector="${selectorId}" candidates=${candidates.length} ranked=${ranked.length} ` +
        `member="${member}" fallback=${fallback} cost_usd=${cost ?? 'unknown'} duration_ms=${Date.now() - started}`,
        stageId
      );
    }
    return fallback === 'none' ? ranked.map(id => `${poolId}@${id}`) : null;
  }

  /**
   * Вызов агента-селектора (селектор пула и селектор модели стадии): промпт через stdin,
   * путём агентов с командой (_callAgentOnce) с ролью рельс executor и таймаутом
   * selectorTimeoutMs; журнал запусков, снимки и строка истории тикета не пишутся.
   * @returns {Promise<{result: object|null, fallback: null|'error'|'timeout', errorClass: string|null,
   *   errorText: string, earlyKillRule: object|null, cost: number|null}>} fallback null — ответ
   *   без `status: error`, его разбор — у вызывающего
   */
  async _runSelector(selectorId, selector, prompt, stageId, skillId, promptSummary) {
    const call = { result: null, fallback: null, errorClass: null, errorText: '', earlyKillRule: null, cost: null };
    try {
      // Промпт — всегда через stdin, данные промпта в лог не копируются.
      const result = await this._callAgentOnce({ ...selector, prompt_stdin: true }, prompt, stageId, skillId, selectorId,
        { WORKFLOW_RAILS_ROLE: 'executor' },
        { promptSummary, timeoutMs: this.selectorTimeoutMs });
      call.result = result;
      call.cost = resultNumber(result.result?.cost_usd);
      if (result.status === 'error') {
        call.fallback = 'error';
        call.errorClass = result.result?.error_class || null;
        call.errorText = redactNetworkDetail(String(result.result?.error || ''));
      }
    } catch (err) {
      call.fallback = err.timedOut ? 'timeout' : 'error';
      call.errorClass = err.timedOut ? 'timeout' : null;
      call.errorText = err.message;
      call.earlyKillRule = err.code === 'EARLY_KILL' ? err.rule ?? null : null;
    }
    return call;
  }

  /**
   * Пометка агента-селектора после сбоя вызова (_runSelector) в health-реестре — по
   * MODEL_ERROR_HEALTH, как _modelIoFailure: класс — `error_class` ответа, таймаут
   * раннера — `timeout`; снятие онлайн-сканом по правилу health самого селектора — класс
   * и TTL правила. Помечается только сам селектор (`selectorId`).
   */
  _markSelectorFailure(selectorId, { errorClass, errorText, earlyKillRule }, stageId) {
    // error_class — текст ответа селектора: только собственные ключи таблицы, иначе
    // `constructor` и прочие свойства прототипа нашлись бы как класс.
    const tableHealth = errorClass && Object.hasOwn(MODEL_ERROR_HEALTH, errorClass) ? MODEL_ERROR_HEALTH[errorClass] : null;
    // Снятие онлайн-сканом по правилу health самого селектора — пометка по классу и TTL
    // правила, как у агентов стадии.
    const health = earlyKillRule
      ? { class: earlyKillRule.class, ttl: earlyKillRule.ttl, ruleId: earlyKillRule.rule_id, label: `rule ${earlyKillRule.rule_id}` }
      : tableHealth && { class: tableHealth.class, ttl: tableHealth.ttl, ruleId: `selector-${errorClass}`, label: errorClass };
    // Остановка пайплайна сняла селектора — это не его сбой.
    if (!health || this.stopRequested) return;
    try {
      markUnhealthy(this.projectRoot, selectorId, {
        class: health.class,
        ttl: health.ttl,
        rule_id: health.ruleId,
        reason: errorText,
      });
      if (this.logger) this.logger.info(`agent ${selectorId} marked unhealthy: class=${health.class} (selector ${health.label})`, stageId);
    } catch (markErr) {
      if (this.logger) this.logger.warn(`health mark failed for ${selectorId}: ${markErr.message}`, stageId);
    }
  }

  /**
   * Выбор модели стадии с `selection` (README, «Выбор модели стадии»; lib/stage-selection.mjs):
   * следующий кандидат попытки вместо курсора resolveAgent. Вызывается на каждом витке
   * executeWithFallback; `sel` — состояние попытки (один вызов executeWithFallback):
   *   1. выжившие — фильтры 1–5 (_stageSurvivors), те же типизированные blocked; пулы
   *      раскрыты в участников, прошедших фильтры (flattenSurvivors);
   *   2. шлагбаумы пулов — один проход на попытку, до селектора и пока нет остановки:
   *      `closed` закрывает место (id пула в `tried`), `open` — пул в `sel.fresh`: его
   *      участник, запускаемый первым в попытке, шлагбаум не опрашивает; первый же
   *      запуск попытки очищает `sel.fresh`, дальше опрос — перед каждым запуском;
   *   3. полосы уровней — по оценкам выживших после прохода шлагбаумов, заморожены на попытку;
   *      ни у одного выжившего нет оценки — вся попытка идёт прежним курсором по местам
   *      (_cursorPick), без границы и селектора (`fallback=skipped:no_scores`,
   *      `selection: cursor`); шлагбаум при запуске участника — как при выборе (`sel.fresh`);
   *   4. нижняя граница — из журнала на каждом витке (gradeRuns: отказ, пусто, провал
   *      контроля или ревью на этом тикете), не выше уровня сильнейшего выжившего − 1, и не
   *      ниже уровня отказавшего в этой попытке (эскалация);
   *   5. селектор — не больше одного вызова на попытку (_stageSelection), кэш в `sel`;
   *   6. порядок обхода — walkOrder по выжившим над границей: сначала бесплатные ≥ R, затем
   *      платные ≥ R, затем хвост ниже R. Отсеянного id в порядке нет (правило 2).
   * @returns {Promise<object>} как resolveAgent (`compatible` — порядок обхода, у курсора —
   *   места списка) и
   *   `selection` — поля события run (§7), или blocked
   */
  async _resolveGoverned(stage, stageId, tried, sel) {
    let survivors = this._stageSurvivors(stage, stageId, tried);
    if (survivors.blocked) return survivors;
    if (!sel.swept) {
      sel.swept = true;
      let closed = false;
      for (const place of new Set(survivors.places)) {
        if (this.stopRequested) break;
        if (!survivors.isPool(place) || !this.pipeline.agents[place]?.models?.gate) continue;
        const status = await this._poolGate(place, stageId);
        if (status === 'closed') {
          tried.push(place);
          closed = true;
        } else if (status === 'open') {
          sel.fresh.add(place);
        }
      }
      if (closed) {
        survivors = this._stageSurvivors(stage, stageId, tried);
        if (survivors.blocked) return survivors;
      }
    }

    const agents = this.pipeline.agents;
    const candidates = flattenSurvivors(survivors.places, { isPool: survivors.isPool, membersOf: (place) => survivors.poolOf(place).untried });
    const ids = candidates.map((c) => c.id);
    const poolById = new Map(candidates.map((c) => [c.id, c.pool]));
    const listIndex = new Map(ids.map((id, i) => [id, i]));
    const fact = (id) => factsOf(this.pipeline, stageId, id);
    const scoreOf = (id) => fact(id)?.intelligence ?? null;
    sel.bands ??= computeBands(ids.map(scoreOf), sel.N);
    // Кандидат не ниже уровня 1: уровень 0 — только у запуска слабее всех (для границы).
    const level = (id) => Math.max(1, levelOf(sel.bands, scoreOf(id)));
    // Бесплатность — из фактов; факта нет (сбой команды фактов, модели нет в ответе) —
    // по самому id: `:free` на конце (правило 2 бесплатности), иначе платная.
    const free = (id) => {
      const f = fact(id);
      return f ? f.free === true : /:free$/.test(requestedModel(agents[id]) ?? '');
    };

    // Ни у одного выжившего нет оценки (сбой команды фактов, каталог OpenRouter не
    // загружен): все на уровне 1, граница не растёт, и обход уровней пускал бы подряд
    // участников пулов. Попытка идёт прежним курсором по местам (_cursorPick: те же
    // выжившие, ротация по номеру попытки), шлагбаум при запуске — как на стадии с
    // выбором, селектор не вызывается (`skipped:no_scores`).
    if (sel.bands.min === null) {
      const picked = this._cursorPick(survivors, stageId);
      sel.decision ??= { R: null, ranking: [], mode: 'cursor', requiredLevel: null, fallback: 'skipped:no_scores', cost: null, durationMs: 0 };
      this._logSelectModel(stage, stageId, sel, { candidates: ids.length, floor: 0, agentId: picked.agentId, level: 1, free: free(picked.agentId) });
      return {
        ...picked,
        pool: picked.pool ?? null,
        selection: {
          selection: 'cursor', level: 1, levels: sel.N, required_level: null, floor_level: 0,
          score: null, free: free(picked.agentId),
        },
      };
    }

    const ticket = this.context?.ticket_id || null;
    let events = [];
    try {
      events = readRunEvents(this.projectRoot);
    } catch (err) {
      if (this.logger) this.logger.warn(`agent-runs: journal not readable, stage floor and ticket runs not applied: ${err.message}`, stageId);
    }
    // Оценка запуска для границы: факт агента процесса; агента в фактах нет — оценка,
    // записанная в событии (поле `score` запуска на стадии с выбором); у агента без id
    // модели оценки нет по определению — уровень 1. Иначе запуск пропускается с WARN.
    const runScore = (run) => {
      const known = agents[run.agent] ? fact(run.agent) : null;
      if (known) return { known: true, score: known.intelligence };
      if (Object.hasOwn(run, 'score')) return { known: true, score: typeof run.score === 'number' ? run.score : null };
      if (agents[run.agent] && !requestedModel(agents[run.agent])) return { known: true, score: null };
      return { known: false };
    };
    const floorInfo = ticketFloor(gradeRuns(events), ticket, runScore, sel.bands);
    for (const agent of floorInfo.skipped) {
      if (sel.warnedSkips.has(agent) || !this.logger) continue;
      sel.warnedSkips.add(agent);
      this.logger.warn(`selection: failed run of "${agent}" on ${ticket} has no score (agent not in stage facts) — not counted in floor`, stageId);
    }
    // Потолок границы — сильнейший уровень выживших в начале попытки, заморожен с полосами:
    // после провала на верхнем уровне верхний уровень берётся снова (решение 6), но
    // исчерпанные в попытке сильные уровни не открывают слабые — ни после отказа
    // (эскалация), ни после сбоев.
    sel.maxLevel ??= Math.max(...ids.map(level));
    const floor = capFloor(Math.max(floorInfo.floor, sel.escalationFloor), sel.maxLevel);
    const above = ids.filter((id) => level(id) > floor);
    if (above.length === 0) {
      return {
        blocked: 'all_unhealthy',
        reason: `All candidates above stage floor ${floor} tried in fallback`,
        attempt: survivors.attempt,
      };
    }
    const ran = new Set(events.filter((e) => e.type === 'run' && ticket && e.ticket === ticket && e.model).map((e) => e.model));
    const notRun = new Set(above.filter((id) => !ran.has(configuredModelKey(agents[id], id))));

    if (!sel.decision) {
      const started = Date.now();
      sel.decision = await this._stageSelection({
        stage, stageId, skillId: survivors.effectiveStage.skill, ticket, above, level, free, fact,
        floor, floorInfo, notRun, listIndex,
      });
      sel.decision.durationMs = Date.now() - started;
    }
    const order = walkOrder({
      survivors: above, levelOf: level, freeOf: free, R: sel.decision.R, floor,
      ranking: sel.decision.ranking, notRun, listIndex,
    });
    const agentId = order[0];
    this._logSelectModel(stage, stageId, sel, { candidates: above.length, floor, agentId, level: level(agentId), free: free(agentId) });
    return {
      agentId,
      effectiveStage: survivors.effectiveStage,
      attempt: survivors.attempt,
      compatible: order,
      pool: poolById.get(agentId) ?? null,
      selection: {
        selection: sel.decision.mode,
        level: level(agentId),
        levels: sel.N,
        required_level: sel.decision.requiredLevel,
        floor_level: floor,
        score: scoreOf(agentId),
        free: free(agentId),
      },
    };
  }

  /** Строка SELECT_MODEL — один раз на попытку, при первом выборе. */
  _logSelectModel(stage, stageId, sel, { candidates, floor, agentId, level, free }) {
    if (sel.logged) return;
    sel.logged = true;
    const d = sel.decision;
    if (!this.logger) return;
    this.logger.info(
      `SELECT_MODEL stage="${stageId}" selector="${stage.selection.selector}" candidates=${candidates} levels=${sel.N} `
        + `range=${sel.bands.min ?? 'n/a'}..${sel.bands.max ?? 'n/a'} floor=${floor} required_level=${d.requiredLevel ?? '-'} `
        + `ranked=${d.ranking.length} pick="${agentId}" level=${level} free=${free} fallback=${d.fallback} `
        + `cost_usd=${d.cost ?? 'unknown'} duration_ms=${d.durationMs}`,
      stageId,
    );
  }

  /**
   * Решение селектора модели стадии на попытку: `{R, ranking, mode, requiredLevel, fallback,
   * cost}`. Вызова нет (`fallback: skipped:<причина>`) — нет тикета, селектор нездоров,
   * запрошена остановка, выживших над границей меньше двух или все на одном уровне. Сбой
   * вызова (выход ≠ 0, `status: error`, таймаут) — `error`/`timeout`, ответ без целого
   * `required_level` в 1..N — `unknown_level` (его ранжир всё равно идёт в порядок внутри
   * уровня). Сбой вызова повторяется один раз, кроме классов, которые повтор с тем же
   * промптом не исправит (SELECTOR_NO_RETRY_CLASSES). Без ответа (сбой и после повтора,
   * `unknown_level`, селектор нездоров) R — уровень по complexity тикета среди уровней
   * выживших (complexityStartLevel: simple — нижний, medium — средний, complex — верхний),
   * у тикета без complexity и при прочих пропусках — наименьший: обход — лестница от R.
   * Ответ R не выше границы поднимается до границы + 1. Сбой помечает селектора
   * (_markSelectorFailure) — только его, не селекторы пулов, и только исход последнего
   * вызова: сбой, прошедший повтором, селектора нездоровым не делает.
   */
  async _stageSelection({ stage, stageId, skillId, ticket, above, level, free, fact, floor, floorInfo, notRun, listIndex }) {
    const selectorId = stage.selection.selector;
    const selector = this.pipeline.agents[selectorId];
    const lowest = Math.min(...above.map(level));
    const ladder = (fallback, ranking = [], cost = null) => ({ R: lowest, ranking, mode: 'ladder', requiredLevel: null, fallback, cost });
    const ticketPath = ticket ? findTicketPathForId(ticket, this.projectRoot) : null;
    // Уровня не назвал селектор — старт по complexity тикета, а не с самого низкого:
    // 2026-09-29/30 PulseProxy селектор срывался 12 раз из 50 (сеть до прокси), и каждый
    // тикет шёл лестницей с уровня 1 — QA-177 (complex) достался claude-haiku. Квантиль
    // селектора (--level-quantile) это не меняет: он действует, только когда ответ есть.
    const byComplexity = (fallback, ranking = [], cost = null) => {
      const complexity = ticketComplexity(ticketPath);
      const available = [...new Set(above.map(level))].sort((a, b) => a - b);
      const R = complexityStartLevel(complexity, available);
      if (R === null) return ladder(fallback, ranking, cost);
      if (this.logger) {
        this.logger.info(
          `SELECT_FALLBACK stage="${stageId}" fallback=${fallback} complexity=${complexity} level=${R} available=${available.join(',')}`,
          stageId,
        );
      }
      return { R, ranking, mode: 'ladder', requiredLevel: null, fallback, cost };
    };
    let skip = null;
    if (!ticket) skip = 'no_ticket';
    else if (!selector || !isHealthy(this.projectRoot, selectorId)) skip = 'unhealthy';
    else if (this.stopRequested) skip = 'stopped';
    else if (above.length < 2) skip = 'single_candidate';
    else if (new Set(above.map(level)).size < 2) skip = 'single_level';
    // Нездоровый селектор — последствие его сбоя (сеть — нездоров 5 мин, MODEL_ERROR_HEALTH):
    // без ответа, как и сам сбой. Прочие пропуски выбора не требуют (один кандидат или
    // уровень) или его не допускают (нет тикета, остановка).
    if (skip === 'unhealthy') return byComplexity(`skipped:${skip}`);
    if (skip) return ladder(`skipped:${skip}`);

    // Кандидаты промпта — в порядке обхода без ответа (лестница от границы): так
    // обёртка, у которой выбор ограничен 255 вариантами, берёт первых по обходу.
    const preliminary = walkOrder({ survivors: above, levelOf: level, freeOf: free, R: null, floor, notRun, listIndex });
    const candidates = preliminary.map((id) => {
      const f = fact(id);
      return {
        id,
        kind: this.pipeline.agents[id]?.pool ? 'pool_member' : 'agent',
        free: free(id),
        level: level(id),
        scores: f && typeof f.intelligence === 'number' ? { intelligence: f.intelligence, coding: f.coding, agentic: f.agentic } : null,
      };
    });
    const levels = stage.selection.levels;
    const ticketData = selectionTicket(ticketPath, {
      id: ticket,
      type: ticketTypeOf(this.context),
      executorRuns: floorInfo.executorRuns,
      floorLevel: floor,
      history: floorInfo.history,
    });
    const prompt = buildSelectionPrompt({
      stage: stageId, ticket: ticketData, levels, candidates, citation: stageFactsInfo(this.pipeline, stageId)?.citation ?? null,
    });
    const summary = `selector stage=${stageId} candidates=${candidates.length} prompt_chars=${prompt.length}`;
    let call = await this._runSelector(selectorId, selector, prompt, stageId, skillId, summary);
    if (call.fallback && !this.stopRequested && !SELECTOR_NO_RETRY_CLASSES.has(call.errorClass)) {
      if (this.logger) {
        this.logger.warn(`selector "${selectorId}" failed (fallback=${call.fallback} class=${call.errorClass ?? '-'}) — one retry`, stageId);
      }
      const first = call;
      call = await this._runSelector(selectorId, selector, prompt, stageId, skillId, summary);
      if (first.cost !== null) call.cost = (call.cost ?? 0) + first.cost;
    }
    this._markSelectorFailure(selectorId, call, stageId);
    if (call.fallback) return byComplexity(call.fallback, [], call.cost);
    const ranking = selectorRanking(call.result.result?.ranking, above);
    const required = parseRequiredLevel(call.result.result?.required_level, levels.length);
    if (required === null) return byComplexity('unknown_level', ranking, call.cost);
    const R = required <= floor ? floor + 1 : required;
    return { R, ranking, mode: 'selector', requiredLevel: R, fallback: 'none', cost: call.cost };
  }

  /**
   * Выполняет stage с fallback-логикой: при пустом artifact diff делает retry с другим агентом.
   *
   * Каждый запуск агента пишется в журнал запусков (src/lib/agent-runs.mjs, PLAN-003):
   * до старта — запись открытого запуска `.workflow/state/agent-run-open.json`, после
   * вызова в любой ветке — событие `run` с тем же `run_key`, затем запись удаляется.
   * Статус запуска определяется один раз и идёт и в событие, и в строку истории
   * работы тикета: остановка пайплайна (`stopRequested`) — `aborted` с
   * `stop_requested: true`, остановка за запрещённую модель — `model_banned`, иначе —
   * класс classifyAgentResult.
   *
   * После MODEL_BANNED стадия сразу берёт следующего агента, даже при изменённых
   * артефактах: сделанное записано в тикет по правилу скила исполнителя
   * «Инкрементальная запись обязательна», следующий запуск продолжает с записанного.
   * Тот же агент заново не запускается: модель выбирает его роутер, и перезапуск
   * запрещённую модель не обходит — прогон PulseProxy 2026-09-27: роутер трижды
   * подряд выбрал ту же запрещённую модель, 11,5 минуты впустую. Агент при этом не
   * помечается нездоровым: в следующей попытке тикета он снова в списке.
   *
   * Место-пул (resolveAgent отдаёт `pool` и `poolCandidates`): перед каждым запуском
   * участника — шлагбаум пула (_poolGate, П14), `closed` закрывает место, и стадия берёт
   * следующее место списка без запуска участников и селектора. При первом выборе
   * участника места в попытке кандидатов ранжирует агент-селектор пула
   * (_poolSelectorOrder, П15) — один вызов на место в попытке, пул в списке дважды —
   * тоже один. Следующий участник того же места — следующий по ранжиру среди
   * кандидатов, которых отдал resolveAgent (фильтры участника уже применены), кандидаты
   * вне ранжира — после него в порядке маски.
   *
   * @param {string} stageId - ID stage из конфигурации
   * @param {object} [stageOverride] - явный stage (для тестов и промежуточных вызовов); по умолчанию берётся из pipeline.stages
   * @returns {Promise<{status: string, output: string, result?: object}>}
   */
  async executeWithFallback(stageId, stageOverride) {
    const stage = stageOverride ?? this.pipeline.stages[stageId];
    if (!stage) {
      throw new Error(`Stage not found: ${stageId}`);
    }

    const triedInThisAttempt = [];
    // Порядок участников мест-пулов в этой попытке: id пула → id участников по ранжиру
    // селектора или null (порядок маски). Решение принимается при первом выборе места.
    const poolOrders = new Map();
    let lastErr = null;
    // Результат последней ошибки шага «модель» обмена model_io (callModelAgent): её не
    // бросают, а возвращают стадии как status: error с error_class.
    let lastModelFailure = null;
    // Последний неуверенный ответ стадии model_io (apply → status: uncertain), который
    // переоценивает следующий агент. Переоценка не дала вердикта (агентов не осталось,
    // сбой модели или процесса) — вердикт выносит apply по этому ответу (settleUncertain).
    let uncertain = null;
    // Остановка пайплайна вердикта не выносит: apply без флага записал бы провал, которого
    // не давал ни один агент (строка ревью, evidence, событие review).
    const settleUncertain = async () => {
      if (this.stopRequested) {
        throw Object.assign(new Error(`Stage "${stageId}" stopped before verdict on uncertain answer`), { code: 'STOPPED' });
      }
      const u = uncertain;
      uncertain = null;
      const final = await this._applyModelIoVerdict(u.result, u.prompt, stageId, u.effectiveStage, u.agentId, u.agent, u.request);
      final.agentId = u.agentId;
      final.runModel = u.runModel;
      if (this.logger) this.logger.stageComplete(stageId, final.status, final.exitCode);
      return final;
    };

    const snapshotEnabled = this.pipeline.execution?.artifact_snapshot_enabled !== false;
    const snapshotOpts = {
      includePaths: this.pipeline.execution?.snapshot_paths ?? ['src', 'configs'],
      snapshotMaxFileSize: this.pipeline.execution?.snapshot_max_file_size ?? 524288,
    };

    // Выбор модели стадии (`selection`, _resolveGoverned) вместо курсора; тип с
    // `selection: false` и стадия без `selection` идут прежним путём без изменений.
    const governed = isGoverned(stage, ticketTypeOf(this.context || {}));
    let sel = null;
    if (governed) {
      // Факты грузит PipelineRunner.run один раз на процесс; исполнитель, созданный без
      // него (тесты, стадия вне pipeline.stages), грузит факты своей стадии сам.
      if (!hasStageFacts(this.pipeline, stageId)) {
        await loadStageFacts(this.pipeline, {
          projectRoot: this.projectRoot, logger: this.logger, stageId, signal: this.stopAbort?.signal,
          stages: { [stageId]: stage },
        });
      }
      const levels = stage.selection.levels;
      sel = {
        N: Array.isArray(levels) && levels.length > 0 ? levels.length : 1,
        escalateOn: new Set(Array.isArray(stage.selection.escalate_on) ? stage.selection.escalate_on : []),
        swept: false,
        fresh: new Set(),
        bands: null,
        decision: null,
        logged: false,
        escalationFloor: 0,
        warnedSkips: new Set(),
      };
    }
    // Следующий кандидат, уже выбранный эскалацией: виток его не пересчитывает.
    let pending = null;

    while (true) {
      const resolved = pending
        ?? (governed
          ? await this._resolveGoverned(stage, stageId, triedInThisAttempt, sel)
          : this.resolveAgent(stage, stageId, { excludeAgents: triedInThisAttempt }));
      pending = null;

      if (resolved.blocked) {
        // При остановке settleUncertain бросает STOPPED — вердикта нет.
        if (uncertain) return settleUncertain();
        const exhausted = resolved.blocked === 'all_unhealthy' || resolved.blocked === 'all_banned';
        // all_unhealthy после исчерпания списка в текущей attempt (lastErr есть) —
        // re-throw, чтобы стадия ушла в goto.error и inc-counter. Без lastErr —
        // первая итерация while, агентов сразу нет (persistence из прошлой attempt)
        // → возвращаем blocked, чтобы конфиг мог развести goto.blocked vs goto.error.
        if (exhausted && lastErr) {
          throw lastErr;
        }
        // Ошибка модели у последнего агента списка: status: error с error_class.
        if (exhausted && lastModelFailure) {
          return lastModelFailure;
        }
        if (resolved.blocked === 'all_banned' && this.logger) this.logger.warn(resolved.reason, stageId);
        return { status: 'blocked', blocked_reason: resolved.blocked, reason: resolved.reason };
      }

      const { effectiveStage } = resolved;
      let agentId = resolved.agentId;
      // После запроса остановки шлагбаум и селектор не запускаются — стадию остановит
      // проверка ниже. Шлагбаум, запущенный до остановки, снимает killCurrentChild
      // (stopAbort); остановка, пришедшая за время шлагбаума, селектора не запускает.
      if (governed && resolved.pool && !this.stopRequested) {
        // Стадия с выбором: шлагбаум прошёл в начале попытки (_resolveGoverned). Участник
        // открытого пула, запускаемый первым в попытке, его не опрашивает; любой запуск
        // после другого запуска попытки — опрашивает (sel.fresh очищается при запуске).
        // Селектор пула на такой стадии не вызывается: участников ранжирует селектор стадии.
        if (!sel.fresh.delete(resolved.pool) && await this._poolGate(resolved.pool, stageId) === 'closed') {
          triedInThisAttempt.push(resolved.pool);
          continue;
        }
      } else if (resolved.pool && !this.stopRequested) {
        // Шлагбаум — перед каждым запуском участника, до селектора (П14). Закрытое место
        // держит health-реестр; id пула в excludeAgents закрывает место и в этой попытке,
        // если запись реестра не удалась, — иначе цикл выбирал бы его снова.
        if (await this._poolGate(resolved.pool, stageId) === 'closed') {
          triedInThisAttempt.push(resolved.pool);
          continue;
        }
        if (!this.stopRequested && !poolOrders.has(resolved.pool)) {
          poolOrders.set(resolved.pool, await this._poolSelectorOrder(resolved.pool, resolved.poolCandidates, stageId, effectiveStage.skill));
        }
        agentId = poolOrders.get(resolved.pool)?.find(id => resolved.poolCandidates.includes(id)) ?? agentId;
      }
      const agent = this.pipeline.agents[agentId];
      const prompt = this.promptBuilder.build(effectiveStage, stageId);

      const before = snapshotEnabled ? await snapshot(this.projectRoot, snapshotOpts) : null;

      // Остановка пришла между агентами (во время аудита, снимков или
      // классификации после сбоя предыдущего): следующего агента не запускать —
      // убить его потом некому, обработчик сигнала уже отработал.
      if (this.stopRequested) {
        if (this.logger) this.logger.info(`stage stopped before agent ${agentId}`, stageId);
        if (lastModelFailure) return lastModelFailure;
        if (lastErr) throw lastErr;
        throw Object.assign(new Error(`Stage "${stageId}" stopped before agent ${agentId}`), { code: 'STOPPED' });
      }

      const run = this._openAgentRun(stageId, effectiveStage, agentId, agent, resolved.attempt, resolved.selection ?? null);
      // Показание шлагбаума из прохода свежо только до первого запуска попытки: пока шёл
      // этот запуск, квоту пула могли израсходовать (другой проект на том же ключе), и
      // первый запуск участника после него опрашивает шлагбаум заново.
      if (sel) sel.fresh.clear();

      try {
        if (this.logger) {
          this.logger.info(
            `Agent selected: ${agentId} (attempt ${resolved.attempt}, compatible=[${resolved.compatible.join(', ')}])`,
            stageId
          );
          this.logger.stageStart(stageId, agentId, effectiveStage.skill);
        }

        // Стадия с model_io — обмен с моделью для любого агента списка; агент
        // kind: http другого пути не имеет.
        // Переоценка неуверенного ответа (apply → status: uncertain) возможна, только если
        // после этого агента в попытке есть другой: иначе apply выносит вердикт сам.
        const retryAvailable = Boolean(run.modelIo)
          && !this.resolveAgent(stage, stageId, { excludeAgents: [...triedInThisAttempt, agentId] }).blocked;
        const result = run.modelIo
          ? await this.callModelAgent(agent, prompt, stageId, effectiveStage, agentId, { retryAvailable })
          : await this.callAgent(agent, prompt, stageId, effectiveStage.skill, agentId, { bannedCheck: run.bannedCheck });
        // Снимок «после» — до записей раннера в тикет и в .workflow/metrics/: строка
        // истории работы попала бы в подсчёт, и «пусто» не срабатывало бы никогда.
        const changedPaths = this._runChangedPaths(run);
        const stopRequested = this.stopRequested;

        if (result.modelError?.fallback) {
          const callResult = {
            exitCode: -1,
            stderr: result.result?.error || '',
            stdout: '',
            parsedResult: result.result,
          };
          const status = stopRequested ? 'aborted' : this._classifyRun(agentId, callResult);
          this._closeAgentRun(run, {
            status, exitCode: -1, changedPaths, stopRequested,
            crashTtlMs: ttlToMs(MODEL_ERROR_HEALTH[result.modelError.class]?.ttl),
          });
          // Агент — для события ревью, если эта ошибка станет результатом стадии.
          result.agentId = agentId;
          await this._auditAgentRun(stageId, effectiveStage, agentId, { ...callResult, status, changedPaths });
          if (this.stopRequested) return result;
          if (this.logger) {
            this.logger.info(`agent ${agentId} model error ${result.modelError.class} — falling back in-stage`, stageId);
          }
          triedInThisAttempt.push(agentId);
          lastErr = null;
          lastModelFailure = result;
          continue;
        }

        const callResult = {
          exitCode: result.exitCode ?? 0,
          // Ошибка модели обмена model_io без смены агента (no_key, bad_response, …):
          // текст ошибки — в stderr, иначе история тикета получила бы empty_response.
          stderr: result.modelError ? (result.result?.error || '') : '',
          stdout: result.output || '',
          parsedResult: result.result || null,
          agentLabel: result.agentLabel || null,
        };
        const status = stopRequested ? 'aborted' : this._classifyRun(agentId, callResult);
        const event = this._closeAgentRun(run, {
          status, exitCode: callResult.exitCode, changedPaths, stopRequested, resultStatus: result.status,
          kiloModels: result.kiloModels, modelIoModel: result.modelIo?.model,
          crashTtlMs: result.modelError ? ttlToMs(MODEL_ERROR_HEALTH[result.modelError.class]?.ttl) : null,
        });
        // Агент и модель запуска — для события ревью стадии (PipelineRunner.recordStageEvent).
        result.agentId = agentId;
        result.runModel = event.model;

        // IMPL-83: audit-log hook (success path)
        await this._auditAgentRun(stageId, effectiveStage, agentId, { ...callResult, status, changedPaths });

        // IMPL-86: normalize agent_id in ## Ревью after review-result stage.
        // Стадия с model_io пропускается: строку ревью с id агента пишет её скрипт
        // применения (WORKFLOW_MODEL_AGENT), а на выходах без строки (prepare закрыл
        // стадию сам, ошибка обмена) нормализация переписала бы агента чужой, прежней строки.
        if ((effectiveStage.skill === 'review-result' || stageId === 'review-result') && !effectiveStage.model_io
          && this.context?.ticket_id) {
          try {
            const tp = findTicketPathForId(this.context.ticket_id, this.projectRoot);
            if (tp) {
              const r = normalizeReviewAgentId(tp, agentId);
              if (!r.ok && r.code !== 'NO_SECTION' && r.code !== 'NO_DATA_ROW' && this.logger) {
                this.logger.warn(`review agent normalize: ${r.code} ${r.error || ''}`, stageId);
              }
            }
          } catch (err) {
            if (this.logger) this.logger.warn(`review agent normalize threw: ${err.message}`, stageId);
          }
        }

        // Неуверенная оценка ревью: уверенность ниже min_confidence, уверенного провала нет —
        // apply строку ревью не пишет, оценку в этой же попытке даёт следующий агент стадии.
        // Прежде неуверенность засчитывалась провалом, и задачу переделывали заново:
        // ListeningGlass 2026-09-29, IMPL-002 — уровень 5 из 5 при уверенности 0.79, Opus
        // четыре раза выполнял готовую работу. Следующего агента не стало между проверкой
        // и выбором (health-реестр) — вердикт выносит apply по тому же ответу без переоценки.
        if (run.modelIo && result.status === 'uncertain') {
          triedInThisAttempt.push(agentId);
          uncertain = { result, prompt, effectiveStage, agentId, agent, runModel: event.model, request: this._readModelIoRequest(result) };
          const next = this.resolveAgent(stage, stageId, { excludeAgents: triedInThisAttempt });
          if (this.logger) {
            this.logger.info(
              `REVIEW_UNCERTAIN agent="${agentId}" items=${result.result?.uncertain_items ?? '-'} `
                + `next="${next.blocked ? 'none' : next.agentId}"`,
              stageId,
            );
          }
          if (next.blocked) return settleUncertain();
          pending = next;
          lastErr = null;
          lastModelFailure = null;
          continue;
        }
        // Переоценка без вердикта (ошибка шага модели или apply у следующего агента) —
        // вердикт по неуверенному ответу: иначе ошибка вела в increment-review-errors, и
        // та же пара агентов крутилась до mark-blocked.
        if (uncertain && run.modelIo && !this.stopRequested && result.status !== 'passed' && result.status !== 'failed') {
          if (this.logger) {
            this.logger.info(`REVIEW_UNCERTAIN re-review by "${agentId}" gave status=${result.status} — verdict by "${uncertain.agentId}"`, stageId);
          }
          return settleUncertain();
        }

        // Эскалация (решение 3): агент сам ответил `status: blocked` (у blocked раннера
        // всегда есть blocked_reason) — в этой же попытке следующий кандидат строго
        // сильнее уровнем; событие run уже записано с result_status: blocked (gradeOf —
        // refused). Сделанное записано в тикет, как после MODEL_BANNED. Сильнее нет —
        // blocked уходит стадии, в goto.blocked, как раньше.
        if (governed && sel.escalateOn.has('blocked') && result.status === 'blocked' && !result.blocked_reason) {
          const from = resolved.selection.level;
          triedInThisAttempt.push(agentId);
          sel.escalationFloor = Math.max(sel.escalationFloor, from);
          const next = await this._resolveGoverned(stage, stageId, triedInThisAttempt, sel);
          const stronger = !next.blocked && next.selection.level > from;
          if (this.logger) {
            this.logger.info(
              `ESCALATE stage="${stageId}" from="${agentId}" level=${from} to="${stronger ? next.agentId : 'none'}" `
                + `level=${stronger ? next.selection.level : '-'}`,
              stageId,
            );
          }
          if (stronger) {
            pending = next;
            lastErr = null;
            lastModelFailure = null;
            continue;
          }
        }

        if (this.logger) this.logger.stageComplete(stageId, result.status, result.exitCode);
        return result;
      } catch (err) {
        if (!err.exitCode && !err.code) {
          // Исключение без кода выхода — события нет, запись открытого запуска снимается.
          this._dropOpenRun(run, stageId);
          throw err;
        }

        const changedPaths = this._runChangedPaths(run);
        const stopRequested = this.stopRequested;
        const exitCode = err.exitCode ?? err.code;
        const stderr = err.stderr || '';
        const callResult = {
          exitCode,
          stderr,
          stdout: err.stdout || '',
          parsedResult: err.parsedResult || null,
          timedOut: err.timedOut === true,
          signal: err.signal,
          agentLabel: err.agentLabel || null,
        };
        const banned = !stopRequested && err.code === 'MODEL_BANNED';

        // classify — до события: TTL сработавшего правила health идёт в crash_ttl_ms.
        // Правила участника пула — правила пула (healthRulesId), пометка ниже — по id участника.
        let status;
        let classification = null;
        if (stopRequested) {
          status = 'aborted';
        } else if (banned) {
          status = 'model_banned';
        } else if (err.code === 'RAILS_INCOMPLETE' || err.code === 'RAILS_SUSPENDED' || err.code === 'RAILS_RUNTIME_LOST') {
          // Скил брошен без итога или приостановлен владельцем, либо потеряно закрепление
          // рантайма (callAgent), хост вышел с кодом 0. stderr kilo — лог его
          // инструментов: «403» и «network» там — текст проекта, и ни класс
          // classifyAgentResult, ни правила health по нему не строятся — это не отказ хоста.
          status = 'error';
        } else {
          status = this._classifyRun(agentId, callResult);
          classification = await classify(this.rules, healthRulesId(agent, agentId), { exitCode, stderr });
        }
        this._closeAgentRun(run, {
          status, exitCode, changedPaths, stopRequested,
          kiloModels: err.kiloModels, crashTtlMs: ttlToMs(classification?.ttl),
        });

        // IMPL-83: audit-log hook (failure path)
        await this._auditAgentRun(stageId, effectiveStage, agentId, { ...callResult, status, changedPaths });

        // Агента убила остановка пайплайна: это не его сбой — без пометки в
        // health-реестре и без перехода к следующему агенту.
        if (this.stopRequested) {
          if (this.logger) this.logger.info(`agent ${agentId} stopped by shutdown — no in-stage fallback`, stageId);
          throw err;
        }

        // Остановка за запрещённую модель: сразу следующий агент стадии, без пометки
        // в health-реестре и без запрета fallback при изменённых артефактах.
        if (banned) {
          lastErr = err;
          lastModelFailure = null;
          if (this.logger) {
            this.logger.warn(`agent ${agentId} stopped: model "${err.bannedModel}" banned — falling back in-stage`, stageId);
          }
          triedInThisAttempt.push(agentId);
          continue;
        }

        const after = snapshotEnabled ? await snapshot(this.projectRoot, snapshotOpts) : null;
        const diffResult = snapshotEnabled ? diff(before, after) : null;
        const diffEmpty = snapshotEnabled && isEmpty(diffResult);

        if (err.code === 'RAILS_SUSPENDED' || err.code === 'RAILS_RUNTIME_LOST') {
          // Приостановка владельцем или потеря закреплённого рантайма — не отказ
          // агента: ни повтор, ни передача другому исполнителю (дизайн 2026-10-05).
          if (this.logger) this.logger.warn(`rails: ${err.code} — без fallback на другого агента`, stageId);
          throw err;
        }

        if (classification) {
          markUnhealthy(this.projectRoot, agentId, classification);
          if (this.logger) {
            this.logger.info(
              `agent ${agentId} marked unhealthy: class=${classification.class}, excluded (fallback triggered)`,
              stageId
            );
          }
        }

        if (!diffEmpty) {
          const modifiedArtifacts = diffResult ? Object.keys(diffResult).join(', ') : 'unknown';
          if (this.logger) {
            this.logger.warn(
              `agent ${agentId} exited ${exitCode}, artifacts modified [${modifiedArtifacts}] — fallback blocked`,
              stageId
            );
          }
          if (uncertain) return settleUncertain();
          throw err;
        }

        if (this.logger) {
          this.logger.info(
            `agent ${agentId} exited ${exitCode}, artifact diff empty — falling back in-stage (class=${classification?.class ?? 'unmatched'})`,
            stageId
          );
        }

        triedInThisAttempt.push(agentId);
        lastErr = err;
        lastModelFailure = null;
      }
    }
  }

  /**
   * Начало запуска агента: запись открытого запуска (до старта агента, когда
   * ответившей модели ещё нет — ключ модели без данных запуска, у kilo-агента null),
   * снимок для подсчёта изменённых файлов и проверка ответивших моделей kilo-агента
   * на стадии исполнителя. Ошибка записи не меняет ход стадии: WARN, агент запускается.
   * `selection` — поля выбора модели стадии (`selection`, `level`, `levels`,
   * `required_level`, `floor_level`, `score`, `free`) — только на стадии с `selection`:
   * у прочих стадий ключи записи и события прежние.
   */
  _openAgentRun(stageId, effectiveStage, agentId, agent, attempt, selection = null) {
    const context = this.context || {};
    const ticket = context.ticket_id || null;
    const modelIo = agent.kind === 'http' || Boolean(effectiveStage.model_io);
    const record = {
      run_key: newRunKey(),
      ts: new Date().toISOString(),
      pipeline_run: this.pipelineRunId,
      stage: stageId,
      skill: effectiveStage.skill || null,
      ticket,
      ticket_type: ticketTypeOf(context),
      attempt: attempt ?? null,
      agent: agentId,
      requested: requestedModel(agent),
      model: runModelKey(agent, agentId),
      ...(selection ?? {}),
    };
    // Стадия с model_io файлов не касается: вход собирает prepare, записи делает apply.
    const changes = modelIo ? null : captureRunChanges(this.projectRoot, findTicketPathForId(ticket, this.projectRoot));

    // Запреты перечитываются, когда в сессии появляется новая модель: запрет или его
    // снятие во время запуска учитываются, а временный запрет, истёкший за время
    // работы агента, агента не останавливает.
    let bannedCheck = null;
    if (!modelIo && effectiveStage.skill === EXECUTOR_SKILL && isKiloRun(agent)) {
      let bans = null;
      let bansFor = null;
      bannedCheck = (models) => {
        const names = models.map((m) => m.model).join('\n');
        if (names !== bansFor) {
          bans = this._loadBans(stageId);
          bansFor = names;
        }
        const now = Date.now();
        for (const { model } of models) {
          const ban = findBan(bans, model, record.ticket_type);
          if (ban && !(ban.kind === 'crash' && Date.parse(ban.until) <= now)) return { model, reason: describeBan(ban) };
        }
        return null;
      };
    }

    const written = writeOpenRun(this.projectRoot, record);
    if (!written.ok && this.logger) this.logger.warn(`agent-runs: open run record not written: ${written.error}`, stageId);
    return { record, agent, agentId, modelIo, changes, bannedCheck, startedAt: Date.now() };
  }

  /**
   * Изменённые файлы проекта за запуск — пути от корня проекта (listRunChanges); у стадии
   * с model_io и при сбое подсчёта — null.
   */
  _runChangedPaths(run) {
    if (run.modelIo) return null;
    return listRunChanges(this.projectRoot, run.changes, findTicketPathForId(run.record.ticket, this.projectRoot));
  }

  /**
   * Событие `run` запуска и снятие записи открытого запуска — в этом порядке: раннер,
   * снятый между ними, оставит файл при записанном событии, и следующий старт второго
   * события не допишет (closeInterruptedRun сверяет run_key). Сбой записи — WARN,
   * ход стадии не меняется.
   *
   * `resultStatus` — статус блока RESULT ответа (`result_status` события): по нему
   * scripts/check-report-needed.js отличает разбор `completed` от `has_gaps` — класс
   * запуска у обоих `ok`.
   *
   * `changedPaths` — изменённые файлы запуска (_runChangedPaths): в событии их число
   * (`changed_files`), а у запуска со сбоем (error, timeout, network_error — failedRunChanges)
   * с изменениями — и сами пути (`changed_paths`, не больше FAILED_RUN_PATHS_MAX).
   * @returns {object} событие (поле `model` — ключ модели запуска)
   */
  _closeAgentRun(run, { status, exitCode, changedPaths, stopRequested, resultStatus = null, kiloModels = null, modelIoModel = null, crashTtlMs = null }) {
    const { ts, ...record } = run.record;
    const event = { type: 'run', ...record, status };
    try {
      Object.assign(event, {
        models: isKiloRun(run.agent) ? (kiloModels?.models ?? null) : null,
        model: runModelKey(run.agent, run.agentId, { kiloLast: kiloModels?.last ?? null, modelIoModel }),
        status,
        exit_code: typeof exitCode === 'number' ? exitCode : null,
        changed_files: Array.isArray(changedPaths) ? changedPaths.length : null,
        duration_ms: Date.now() - run.startedAt,
      });
      const failedChanges = failedRunChanges(status, changedPaths);
      if (failedChanges) event.changed_paths = failedChanges.paths;
      if (typeof resultStatus === 'string' && resultStatus) event.result_status = resultStatus;
      if (stopRequested) event.stop_requested = true;
      else if (isCrashStatus(event)) event.crash_ttl_ms = crashTtlMs ?? CRASH_TTL_DEFAULT_MS;
      const written = appendRunEvent(this.projectRoot, event);
      if (!written.ok && this.logger) this.logger.warn(`agent-runs: run event not written: ${written.error}`, run.record.stage);
    } catch (err) {
      if (this.logger) this.logger.warn(`agent-runs: run event failed: ${err.message}`, run.record.stage);
    }
    this._dropOpenRun(run, run.record.stage);
    return event;
  }

  _dropOpenRun(run, stageId) {
    const cleared = clearOpenRun(this.projectRoot);
    if (!cleared.ok && this.logger) this.logger.warn(`agent-runs: open run record not removed: ${cleared.error}`, stageId);
  }

  /** Класс запуска для истории работы тикета и журнала (classifyAgentResult). */
  _classifyRun(agentId, callResult) {
    return classifyAgentResult({
      exitCode: callResult.exitCode ?? 0,
      stderr: callResult.stderr || '',
      stdout: callResult.stdout || '',
      timedOut: callResult.timedOut === true,
      signal: callResult.signal,
      parsedResult: callResult.parsedResult || null,
      agentType: (agentId || '').startsWith('script-') ? 'script' : 'ai',
    });
  }

  /**
   * IMPL-83: Audit-log hook — строка истории работы тикета. Статус — `callResult.status`
   * (его определяет executeWithFallback один раз для истории и журнала), без него —
   * класс classifyAgentResult. `callResult.changedPaths` — изменённые файлы запуска
   * (_runChangedPaths): у запуска со сбоем (failedRunChanges) они идут в колонку
   * «Изменённые файлы» строки — по ним следующая попытка отличает правки оборванного
   * запуска от чужой незакоммиченной работы (шаг P1S2 скила execute-task).
   * Non-blocking: errors are logged via logger.warn, never thrown.
   */
  async _auditAgentRun(stageId, effectiveStage, agentId, callResult) {
    try {
      const ticketId = this.context?.ticket_id;
      if (!ticketId) return;

      const status = callResult.status ?? this._classifyRun(agentId, callResult);

      // For move-* stages prefer destination from parsedResult.to
      let ticketPath = null;
      if (stageId.startsWith('move-') && callResult.parsedResult?.to) {
        ticketPath = path.join(this.projectRoot, '.workflow/tickets', callResult.parsedResult.to, `${ticketId}.md`);
        try { if (!fs.existsSync(ticketPath)) ticketPath = null; } catch { ticketPath = null; }
      }
      if (!ticketPath) {
        ticketPath = findTicketPathForId(ticketId, this.projectRoot);
        // Закрытый тикет стадии не исполняет: ticket_id в контексте остался от прошлого
        // тикета. 2026-09-29/30 строки create-report, analyze-report и decompose-gaps
        // дописаны в done/HUMAN-003 (ListeningGlass) и в QA-180 (PulseProxy, затем
        // archive/). Перемещение в done/ стадией move-* — выше, по parsedResult.to.
        if (ticketPath && CLOSED_TICKET_COLUMNS.has(path.basename(path.dirname(ticketPath)))) {
          if (this.logger) this.logger.info(`audit-log: ${ticketId} is closed (${path.basename(path.dirname(ticketPath))}) — no history row for stage ${stageId}`, stageId);
          return;
        }
      }
      if (!ticketPath) return;

      const skillName = effectiveStage.skill || stageId;
      const entry = {
        timestamp: formatLocalIsoDateTime(new Date()),
        skill: skillName,
        // В истории — подпись с фактической моделью kilo (`kilo-free(dots-3-note-preview)`).
        agent: callResult.agentLabel || agentId || 'unknown',
        status,
      };
      const failedChanges = failedRunChanges(status, callResult.changedPaths);
      if (failedChanges) {
        entry.files = failedChanges.paths;
        entry.files_total = failedChanges.total;
      }

      try {
        const r = appendAgentRun(ticketPath, entry);
        if (!r?.ok && this.logger) {
          this.logger.warn(`audit-log appendAgentRun failed: ${r?.code || 'unknown'} ${r?.error || ''}`, stageId);
        }
      } catch (err) {
        if (this.logger) this.logger.warn(`audit-log appendAgentRun threw: ${err.message}`, stageId);
      }
    } catch (outer) {
      // Final safety net — never let audit-log break the pipeline
      if (this.logger) this.logger.warn(`audit-log hook crashed: ${outer.message}`, stageId);
    }
  }

  /**
   * Выполняет stage через выбранного CLI-агента (новая модель выбора).
   * @param {string} stageId - ID stage из конфигурации
   * @returns {Promise<{status: string, output: string, result?: object}>}
   */
  async execute(stageId) {
    const stage = this.pipeline.stages[stageId];
    if (!stage) {
      throw new Error(`Stage not found: ${stageId}`);
    }

    // Legacy-ветка: скрипт-стейдж (детерминированный). Capability-фильтр не применяется.
    if (stage.agent && !stage.agents) {
      const agent = this.pipeline.agents[stage.agent];
      if (!agent) throw new Error(`Agent not found: ${stage.agent}`);
      const prompt = this.promptBuilder.build(stage, stageId);
      if (this.logger) this.logger.stageStart(stageId, stage.agent, stage.skill);

      const skipGuard = this.fileGuard && this.fileGuard.isTrusted(stage.agent, stageId);
      if (this.fileGuard && !skipGuard) this.fileGuard.takeSnapshot();

      const result = agent.kind === 'http' || stage.model_io
        ? await this.callModelAgent(agent, prompt, stageId, stage, stage.agent)
        : await this.callAgent(agent, prompt, stageId, stage.skill, stage.agent);

      if (this.logger) this.logger.stageComplete(stageId, result.status, result.exitCode);
      if (this.fileGuard && !skipGuard) {
        const violations = this.fileGuard.checkAndRollback();
        if (violations.length > 0) result.violations = violations;
      }
      return result;
    }

    // Новая ветка: список кандидатов с фильтром по capabilities → executeWithFallback
    return this.executeWithFallback(stageId);
  }

  /**
   * Исполняет стадию по обмену `model_io` (README, «Безынструментные агенты»):
   * prepare → модель → apply — для любого агента стадии с `model_io` и для агента
   * `kind: http` (другого пути у него нет). Скил стадии агент не исполняет: вход
   * собирает prepare, статус и артефакты выдаёт apply, вызов модели делает раннер.
   *
   * 1. prepare — `node <prepare> "<промпт>"`; `status: ready` + `request_file`
   *    ведут к шагу 2, любой другой результат — результат стадии.
   *    `ready` без request_file или нечитаемый JSON — `status: error`, класс `bad_prepare`:
   *    по нему goto.error отличает ошибку скрипта от отказа модели.
   * 2. Модель — вход из request_file, ответ в
   *    `.workflow/state/model-io/<стадия>-<run_id пайплайна>-<id вызова>.json`.
   *    Агент `kind: http` — слой оценки, все вопросы одним запросом; агент с
   *    командой — промпт судьи тестов скилов на каждый вопрос (_askCommandAgent).
   *    Ошибка модели — `status: error` с `error_class`, шаг 3 не выполняется.
   * 3. apply — `node <apply> "<промпт>"` + пути запроса и ответа; его RESULT — результат стадии.
   *
   * Остановка пайплайна (killCurrentChild) прерывает вызов модели и не даёт
   * запустить apply: результат — `status: error`, класс `aborted`.
   * Сбой скрипта prepare или apply и сбой процесса агента с командой (выход ≠ 0
   * без RESULT, таймаут) бросаются, как у CLI-агента.
   */
  async callModelAgent(agent, prompt, stageId, stage, agentId, { retryAvailable = false } = {}) {
    const modelIo = stage.model_io;
    if (!modelIo) {
      throw new Error(`Stage "${stageId}": agent "${agentId}" (kind: http) runs only stages with model_io`);
    }
    const callId = crypto.randomUUID();
    const scriptEnv = this._modelIoScriptEnv(agent, agentId, modelIo);
    const scriptAgent = (step) => this._modelIoScriptAgent(modelIo, step);
    const timing = { prepare_ms: null, model_ms: null, apply_ms: null };
    const abort = new AbortController();
    if (this.stopRequested) abort.abort();
    this.currentModelAbort = abort;
    try {
      return await this._runModelIo({ agent, prompt, stageId, stage, agentId, callId, scriptEnv, scriptAgent, timing, retryAvailable, signal: abort.signal });
    } finally {
      if (this.currentModelAbort === abort) this.currentModelAbort = null;
    }
  }

  /** Окружение скриптов prepare и apply обмена model_io. */
  _modelIoScriptEnv(agent, agentId, modelIo) {
    return {
      WORKFLOW_MODEL_AGENT: agentId,
      WORKFLOW_MODEL_CAPABILITIES: JSON.stringify(Array.isArray(agent.capabilities) ? agent.capabilities : []),
      WORKFLOW_MODEL_IO_OPTIONS: JSON.stringify(modelIo.options || {}),
    };
  }

  _modelIoScriptAgent(modelIo, step) {
    return { command: 'node', args: [path.resolve(this.projectRoot, modelIo[step])], workdir: '.' };
  }

  /** Текст файла запроса ответа model_io на момент ответа; null — не прочитан. */
  _readModelIoRequest(result) {
    try {
      return fs.readFileSync(path.resolve(this.projectRoot, result.modelIo.request_file), 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Путь запроса для вердикта по неуверенному ответу. prepare следующего агента мог
   * переписать файл запроса по тому же пути (контракт model_io уникального пути не
   * требует), и apply применил бы прежний ответ к чужому запросу — тогда запрос
   * ответа пишется рядом с файлом ответа.
   */
  _verdictRequestPath(uncertain, request) {
    const requestPath = path.resolve(this.projectRoot, uncertain.modelIo.request_file);
    if (request === null) return requestPath;
    let current = null;
    try {
      current = fs.readFileSync(requestPath, 'utf-8');
    } catch {
      // Файла нет — пишется копия.
    }
    if (current === request) return requestPath;
    const copyPath = path.resolve(this.projectRoot, uncertain.modelIo.response_file).replace(/\.json$/, '') + '.request.json';
    fs.writeFileSync(copyPath, request);
    return copyPath;
  }

  /**
   * Вердикт по неуверенному ответу, когда переоценивать некому: apply запускается
   * снова по тем же файлам запроса и ответа, без WORKFLOW_MODEL_IO_RETRY, — и выносит
   * вердикт сам (неуверенность — провал), со строкой ревью.
   */
  async _applyModelIoVerdict(uncertain, prompt, stageId, stage, agentId, agent, request = null) {
    const modelIo = stage.model_io;
    const started = Date.now();
    let applied;
    try {
      applied = await this._callAgentOnce(this._modelIoScriptAgent(modelIo, 'apply'), prompt, stageId, stage.skill, null, {
        ...this._modelIoScriptEnv(agent, agentId, modelIo),
        WORKFLOW_MODEL_REQUEST: this._verdictRequestPath(uncertain, request),
        WORKFLOW_MODEL_RESPONSE: path.resolve(this.projectRoot, uncertain.modelIo.response_file),
      });
    } catch (err) {
      // Запуск агента уже закрыт событием: сбой apply — ошибка стадии, а не второе
      // событие того же запуска и пометка агента в health-реестре (он ответил).
      if (this.stopRequested || (!err.exitCode && !err.code)) throw err;
      if (this.logger) this.logger.error(`MODEL_IO agent="${agentId}" verdict apply failed: ${err.message}`, stageId);
      return {
        status: 'error',
        output: '',
        stderr: err.stderr || '',
        result: { error_class: 'apply_failed', error: err.message },
        exitCode: -1,
        modelIo: uncertain.modelIo,
      };
    }
    const applyMs = Date.now() - started;
    if (this.logger) {
      this.logger.info(`MODEL_IO agent="${agentId}" verdict without re-review: status=${applied.status} apply_ms=${applyMs}`, stageId);
    }
    applied.modelIo = { ...uncertain.modelIo, apply_ms: (uncertain.modelIo.apply_ms ?? 0) + applyMs };
    return applied;
  }

  /** Шаги prepare → модель → apply для callModelAgent; `signal` — остановка пайплайна. */
  async _runModelIo({ agent, prompt, stageId, stage, agentId, callId, scriptEnv, scriptAgent, timing, retryAvailable, signal }) {
    const stopped = (step) => this._modelIoFailure(agentId, stageId,
      new ModelClientError('aborted', `stage stopped before ${step}`), timing);
    if (signal.aborted) return stopped('prepare');

    let started = Date.now();
    const prepared = await this._callAgentOnce(scriptAgent('prepare'), prompt, stageId, stage.skill, null, scriptEnv);
    timing.prepare_ms = Date.now() - started;
    if (prepared.status !== 'ready') {
      if (this.logger) {
        this.logger.info(`MODEL_IO agent="${agentId}" prepare closed stage: status=${prepared.status} prepare_ms=${timing.prepare_ms}`, stageId);
      }
      return prepared;
    }

    const requestFile = prepared.result?.request_file;
    if (!requestFile) {
      return this._modelIoFailure(agentId, stageId,
        new ModelClientError('bad_prepare', 'prepare returned status ready without request_file'), timing);
    }
    const requestPath = path.resolve(this.projectRoot, requestFile);
    let input;
    try {
      input = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      return this._modelIoFailure(agentId, stageId,
        new ModelClientError('bad_prepare', `request_file is not readable JSON: ${requestFile} (${err.message})`), timing);
    }
    if (signal.aborted) return stopped('model call');

    started = Date.now();
    let evaluation;
    try {
      evaluation = agent.kind === 'http'
        ? await evaluateWithModel({ ...agent, id: agentId }, input, {
          // Окружение модели — как у CLI-агентов: process.env + машинный agent.env
          // (прокси и т.п., lib/agent-env.mjs).
          env: buildAgentEnv(process.env, {}, { logger: this.logger, stageId }),
          cwd: this.projectRoot,
          signal,
        })
        : await this._askCommandAgent(agent, agentId, input, stageId, stage.skill, signal);
    } catch (err) {
      if (!(err instanceof ModelClientError)) throw err;
      timing.model_ms = Date.now() - started;
      return this._modelIoFailure(agentId, stageId, err, timing);
    }
    timing.model_ms = Date.now() - started;

    const responseDir = path.join(this.projectRoot, '.workflow', 'state', 'model-io');
    const safeStage = String(stageId).replace(/[^\w.-]+/g, '_');
    const responseName = this.pipelineRunId
      ? `${safeStage}-${String(this.pipelineRunId).replace(/[^\w.-]+/g, '_')}-${callId.slice(0, 8)}.json`
      : `${safeStage}-${callId}.json`;
    const responsePath = path.join(responseDir, responseName);
    fs.mkdirSync(responseDir, { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify(evaluation, null, 2));
    if (signal.aborted) return stopped('apply');

    started = Date.now();
    const applied = await this._callAgentOnce(scriptAgent('apply'), prompt, stageId, stage.skill, null, {
      ...scriptEnv,
      WORKFLOW_MODEL_REQUEST: requestPath,
      WORKFLOW_MODEL_RESPONSE: responsePath,
      // Неуверенный ответ apply может вернуть как status: uncertain — переоценку даст
      // следующий агент попытки (execute, REVIEW_UNCERTAIN).
      ...(retryAvailable ? { WORKFLOW_MODEL_IO_RETRY: '1' } : {}),
    });
    timing.apply_ms = Date.now() - started;

    if (this.logger) {
      this.logger.info(
        `MODEL_IO agent="${agentId}" model="${evaluation.model}" status=${applied.status} ` +
        `prepare_ms=${timing.prepare_ms} model_ms=${timing.model_ms} apply_ms=${timing.apply_ms} ` +
        `cost_usd=${evaluation.cost_usd ?? 'unknown'}`,
        stageId
      );
    }
    applied.modelIo = {
      agent: agentId,
      model: evaluation.model,
      cost_usd: evaluation.cost_usd,
      request_file: path.relative(this.projectRoot, requestPath).split(path.sep).join('/'),
      response_file: path.relative(this.projectRoot, responsePath).split(path.sep).join('/'),
      ...timing,
    };
    return applied;
  }

  /**
   * Шаг «модель» обмена model_io для агента с командой — по контракту судьи тестов
   * скилов (src/lib/skill-judge.mjs, README «Судья тестов скилов»): каждый вопрос
   * request_file — отдельный запуск агента тем же путём, что у агентов стадий
   * (_callAgentOnce: таймаут стадии, prompt_stdin, остановка killCurrentChild).
   * Промпт — buildCliJudgePrompt: таблица уровней вопроса, данные и пути изображений,
   * текст вопроса; ответ — parseJudgeScore и parseJudgeExtras. Переоценки по
   * escalate_to нет. Результат — той же формы, что у слоя оценки (model-evaluate.mjs):
   * `raw` — ответы агента по вопросам, `usage: null`, `cost_usd` — сумма по вопросам
   * или null, если хотя бы один ответ цены не назвал.
   *
   * До первого запуска — проверка входа (commandAgentQuestions): вопрос не с пятью
   * уровнями — bad_request. Ответ без балла или с `error_class` — ModelClientError с
   * классом из ответа (без него — unparsed). Остановка пайплайна — aborted. Сбой
   * процесса агента бросается как есть.
   */
  async _askCommandAgent(agent, agentId, input, stageId, skillId, signal) {
    const questions = commandAgentQuestions(input);
    const data = typeof input.data === 'string' ? input.data : JSON.stringify(input.data ?? null, null, 2);
    // Изображений больше лимита одного запроса (buildImageParts) — вопрос задаётся по частям
    // (imageBatches, lib/model-client.mjs), ответ вопроса — худший уровень частей. Иначе судья
    // падал `Too many images` до вызова модели: PulseProxy QA-160, 2026-09-28, 12 снимков.
    const batches = imageBatches(Array.isArray(input.images) ? input.images : []);
    const imageParts = batches.length > 0 ? batches : [[]];
    const imageText = (part, index) => {
      if (part.length === 0) return '';
      const note = imageParts.length > 1
        ? ` (часть ${index + 1} из ${imageParts.length}: остальные снимки пункта оцениваются отдельными запросами, оценивай только приложенные)`
        : '';
      return `\nИзображения${note}:\n${part.join('\n')}`;
    };
    const started = Date.now();
    const answers = {};
    const raw = {};
    let model = null;
    let cost = 0;
    let costKnown = true;
    for (const question of questions) {
      const partAnswers = [];
      for (const [index, part] of imageParts.entries()) {
        if (signal.aborted) throw new ModelClientError('aborted', `stage stopped before question ${question.id}`);
        const prompt = buildCliJudgePrompt({
          // Перевод строки в тексте уровня разорвал бы строку таблицы.
          rubric: question.levels.map((level, i) => `| ${i + 1} | ${level.trim().replace(/\s*[\r\n]+\s*/g, ' ')} |`).join('\n'),
          agent_output: data + imageText(part, index),
          criterion: question.text,
        });
        const partLabel = imageParts.length > 1 ? ` part=${index + 1}/${imageParts.length}` : '';
        let result;
        try {
          // Роль executor — как у судьи тестов скилов (skill-judge.mjs): рельсы агента не ведут.
          // В лог — id вопроса и длина промпта, данные вопроса не копируются.
          result = await this._callAgentOnce(agent, prompt, stageId, skillId, agentId, { WORKFLOW_RAILS_ROLE: 'executor' },
            { promptSummary: `question=${question.id}${partLabel} prompt_chars=${prompt.length}` });
        } catch (err) {
          if (signal.aborted) throw new ModelClientError('aborted', `stage stopped during question ${question.id}`);
          throw err;
        }
        const output = result.output || '';
        const score = parseJudgeScore(output);
        const extras = parseJudgeExtras(output);
        if (score === null || extras.error_class) {
          const errorClass = extras.error_class || 'unparsed';
          throw new ModelClientError(errorClass, extras.error_class
            ? `question ${question.id}${partLabel}: ${errorClass}: ${redactNetworkDetail(extras.error || '')}`
            : `question ${question.id}${partLabel}: agent output has no score 1..${RUBRIC_LEVEL_COUNT}`);
        }
        partAnswers.push({
          output,
          level: score,
          confidence: extras.confidence,
          probabilities: extras.probabilities,
          reason: typeof result.result?.reason === 'string' ? result.result.reason : null,
        });
        model = model ?? extras.model;
        if (extras.cost_usd === null) costKnown = false;
        else cost += extras.cost_usd;
      }
      // Пункт выполнен, только если выполнен на всех снимках: уровень — худший из частей,
      // уверенность и распределение — той части, что дала этот уровень.
      const worst = partAnswers.reduce((a, b) => (b.level < a.level ? b : a));
      const several = partAnswers.length > 1;
      raw[question.id] = several
        ? partAnswers.map((p, i) => `--- часть ${i + 1} из ${partAnswers.length} ---\n${p.output}`).join('\n')
        : worst.output;
      answers[question.id] = {
        level: worst.level,
        confidence: worst.confidence,
        probabilities: worst.probabilities,
        reason: several
          ? partAnswers.map((p, i) => `часть ${i + 1}: ${p.reason ?? '—'}`).join('; ')
          : worst.reason,
      };
    }
    return { answers, raw, model, usage: null, cost_usd: costKnown ? cost : null, duration_ms: Date.now() - started };
  }

  /**
   * Ошибка клиента или слоя оценки → результат стадии `status: error` с `error_class`.
   * Классы MODEL_ERROR_HEALTH помечают агента в health-реестре и просят
   * executeWithFallback взять следующего агента (`modelError.fallback`).
   */
  _modelIoFailure(agentId, stageId, err, timing) {
    const health = MODEL_ERROR_HEALTH[err.class] || null;
    if (health) {
      try {
        markUnhealthy(this.projectRoot, agentId, {
          class: health.class,
          ttl: health.ttl,
          rule_id: `model-client-${err.class}`,
          reason: err.message,
        });
        if (this.logger) {
          this.logger.info(`agent ${agentId} marked unhealthy: class=${health.class} (model error ${err.class})`, stageId);
        }
      } catch (markErr) {
        if (this.logger) this.logger.warn(`health mark failed for ${agentId}: ${markErr.message}`, stageId);
      }
    }
    if (this.logger) {
      this.logger.error(
        `MODEL_IO agent="${agentId}" error_class=${err.class} prepare_ms=${timing.prepare_ms} ` +
        `model_ms=${timing.model_ms ?? '-'}: ${err.message}`,
        stageId
      );
    }
    return {
      status: 'error',
      output: '',
      stderr: '',
      result: { error_class: err.class, error: err.message },
      // Не 0: аудит (classifyAgentResult) иначе записал бы «пустой ответ».
      exitCode: -1,
      parsed: true,
      modelError: { class: err.class, fallback: Boolean(health) },
    };
  }

  /**
   * Вызывает CLI-агента через child_process ровно один раз (без rails-ретрая).
   * `railsEnv` — переменные окружения WORKFLOW_RAILS_* дочернего процесса
   * (src/rails/README.md §11); вызывающий код — `callAgent` ниже.
   * `promptSummary` — строка в лог вместо построчного эха промпта: промпт судьи
   * в _askCommandAgent несёт данные вопроса целиком (дифф, вывод проверок).
   * `timeoutMs` — свой таймаут вызова вместо таймаута стадии (агент-селектор пула,
   * _poolSelectorOrder): по нему строки `TIMEOUT stage=…` нет — расширение VS Code
   * считает её таймаутом стадии.
   */
  _callAgentOnce(agent, prompt, stageId, skillId, agentId = null, railsEnv = {}, { promptSummary = null, timeoutMs = null } = {}) {
    return new Promise((resolve, reject) => {
      const ownTimeout = timeoutMs !== null;
      const timeout = ownTimeout ? timeoutMs / 1000 : (this.pipeline.execution?.timeout_per_stage || 300);
      const healthRules = agentId ? this._getHealthRules() : null;
      // Правила онлайн-скана участника пула — правила пула (healthRulesId).
      const rulesId = agentId ? healthRulesId(agent, agentId) : null;
      const hasAgentRules = Boolean(
        healthRules && rulesId && healthRules.agents.get(rulesId)?.length
      );
      // kilo: метка сессии по run id — по ней после запуска находится фактическая
      // модель (lib/kilo-models.mjs, _trackKiloModels).
      const kiloTitle = railsEnv.WORKFLOW_RAILS_RUN && isKiloRun(agent)
        ? kiloRunTitle(railsEnv.WORKFLOW_RAILS_RUN)
        : null;
      const args = kiloTitle ? withKiloTitle(agent.args, kiloTitle) : [...agent.args];
      const finalPrompt = prompt;

      // На Windows shell: true обрезает многострочные аргументы на \n (cmd.exe).
      // Поэтому передаём промпт через stdin, а -p (если есть) оставляем как флаг print mode.
      // prompt_stdin: true в записи агента — промпт всегда через stdin (аргумент
      // командной строки на Windows ограничен 32767 символами), как в agent-spawner.
      const useShell = process.platform === 'win32' && agent.command !== 'node';
      const useStdin = agent.prompt_stdin === true || (useShell && finalPrompt.includes('\n'));

      if (!useStdin) {
        // Однострочный промпт или не Windows — передаём через аргумент
        args.push(finalPrompt);
      }
      // Иначе промпт пойдёт через stdin, args остаются как есть.

      // Логгируем команду перед запуском (вместо промпта — имя skill)
      if (this.logger) {
        this.logger.info(`RUN ${agent.command} ${[...args.slice(0, -1), skillId].join(' ')}`, stageId);
        if (promptSummary !== null) {
          this.logger.info(`  ${promptSummary}`, stageId);
        } else {
          // Логгируем входные параметры агента (context + counters)
          const promptLines = prompt.split('\n').filter(l => l.trim());
          if (promptLines.length > 1) {
            for (const line of promptLines.slice(1)) {
              this.logger.info(`  ${line}`, stageId);
            }
          }
        }
      }

      // windowsHide: раннер, запущенный из MCP (detached), живёт без консоли,
      // и Windows открывает каждому агенту новое окно терминала. С флагом
      // консоль создаётся скрытой, а внуки агента наследуют её без окон.
      // env: машинный agent.env (прокси и т.п.) и PWD = cwd агента — см. lib/agent-env.mjs.
      const agentCwd = path.resolve(this.projectRoot, agent.workdir || '.');
      const child = spawn(agent.command, args, {
        cwd: agentCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
        env: buildAgentEnv(process.env, railsEnv, { logger: this.logger, stageId, cwd: agentCwd })
      });
      this.currentChild = child;

      // Передаём промпт через stdin или закрываем если не нужно. Агент, вышедший
      // до чтения stdin, даёт EPIPE/EOF на записи — без обработчика это падение
      // всего раннера; код выхода агента и так приходит в 'close'.
      child.stdin.on('error', () => {});
      if (useStdin) {
        child.stdin.write(finalPrompt);
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let earlyKilled = false;
      let earlyKillRule = null;
      let lastScanSize = 0;

      const killChild = () => {
        if (process.platform === 'win32' && child.pid) {
          try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true }); } catch {}
        } else {
          try { child.kill('SIGTERM'); } catch {}
        }
      };

      // Строка жизни, пока агент работает (HEARTBEAT_INTERVAL_MS): снимается на выходе
      // агента, на его ошибке, на досрочном снятии и на таймауте запуска.
      const heartbeatStarted = Date.now();
      const heartbeatTicket = this.context?.ticket_id ? ` ticket=${this.context.ticket_id}` : '';
      const heartbeat = this.logger && this.heartbeatMs > 0
        ? setInterval(() => {
          const elapsed = Math.round((Date.now() - heartbeatStarted) / 1000);
          this.logger.info(`HEARTBEAT agent_pid=${child.pid ?? '-'} elapsed_s=${elapsed}${heartbeatTicket}`, stageId);
        }, this.heartbeatMs)
        : null;
      heartbeat?.unref();
      const stopHeartbeat = () => { if (heartbeat) clearInterval(heartbeat); };

      // Таймаут
      const timeoutId = setTimeout(() => {
        stopHeartbeat();
        timedOut = true;
        // На Windows SIGTERM игнорируется — используем taskkill /T /F для убийства дерева
        killChild();
        if (this.logger && !ownTimeout) {
          this.logger.timeout(stageId, timeout);
        }
        const err = new Error(ownTimeout
          ? `Agent "${agentId}" timed out after ${timeout}s`
          : `Stage "${stageId}" timed out after ${timeout}s`);
        err.timedOut = true;
        err.exitCode = -1;
        reject(err);
      }, timeout * 1000);

      let stdoutBuffer = '';
      let agentText = ''; // собираем текстовый вывод агента для лога
      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        // Парсим stream-json и выводим только текст дельт
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop(); // незавершённая строка остаётся в буфере
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // Claude: content_block_delta с delta.text
            if (obj.type === 'content_block_delta' && obj.delta?.text) {
              process.stdout.write(obj.delta.text);
              agentText += obj.delta.text;
            }
            // Qwen/Claude: assistant message с content text
            else if (obj.type === 'assistant' && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === 'text' && block.text) {
                  process.stdout.write(block.text);
                  agentText += block.text;
                }
              }
            }
            // result содержит финальный текст (дублирует assistant) — пропускаем
          } catch {
            // не JSON — выводим как есть
            process.stdout.write(line + '\n');
            agentText += line + '\n';
          }
        }
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);

        // Online-детекция фатальных паттернов (quota/429/usage-limit и т.п.).
        // Нужна чтобы не ждать timeout_per_stage (1800s), когда агентский CLI
        // уходит в молчаливый retry-цикл после HTTP 429.
        if (!hasAgentRules || earlyKilled || timedOut) return;
        // Throttle: первый скан всегда, последующие — только после 200+ новых байт.
        if (lastScanSize > 0 && stderr.length - lastScanSize < 200) return;
        lastScanSize = stderr.length;
        const match = scanStderrForFatalRule(healthRules, rulesId, stderr);
        if (!match) return;

        earlyKilled = true;
        earlyKillRule = match;
        clearTimeout(timeoutId);
        stopHeartbeat();
        if (this.logger) {
          this.logger.error(
            `Fatal stderr pattern matched for ${agentId} (rule=${match.rule_id}, class=${match.class}). Killing process.`,
            stageId
          );
        }
        killChild();
        const err = new Error(
          `Agent "${agentId}" killed early: ${match.rule_id} (class=${match.class})`
        );
        err.code = 'EARLY_KILL';
        err.exitCode = -1;
        err.stderr = stderr;
        err.earlyKill = true;
        err.rule = match;
        reject(err);
      });

      child.on('close', (code, signal) => {
        // Только свой процесс: после таймаута или EARLY_KILL вызов уже отклонён, и
        // стадия могла запустить следующего агента раньше, чем этот процесс закрылся —
        // поздний close стёр бы ссылку на живого агента, и остановка его бы не сняла.
        if (this.currentChild === child) this.currentChild = null;
        clearTimeout(timeoutId);
        stopHeartbeat();
        // Обрабатываем остаток буфера стриминга
        if (stdoutBuffer.trim()) {
          try {
            const obj = JSON.parse(stdoutBuffer);
            if (obj.type === 'content_block_delta' && obj.delta?.text) {
              process.stdout.write(obj.delta.text);
            }
          } catch {
            process.stdout.write(stdoutBuffer + '\n');
          }
        }
        process.stdout.write('\n');

        if (timedOut) return;
        if (earlyKilled) {
          if (this.logger && stderr.trim()) {
            const { lines, dumpPath } = this.prepareStderrForLog(stderr, stageId);
            this.logger.warn(`STDERR ↓`, stageId);
            for (const line of lines) {
              this.logger.warn(`  ${line}`, stageId);
            }
            if (dumpPath) this.logger.warn(`  полный stderr: ${dumpPath}`, stageId);
            this.logger.warn(`STDERR ↑`, stageId);
          }
          return;
        }

        // Логгируем CLI вызов
        if (this.logger) {
          this.logger.cliCall(agent.command, args, code);

          // Логгируем текстовый вывод агента
          const trimmedOutput = agentText.trim();
          if (trimmedOutput) {
            this.logger.info(`OUTPUT ↓`, stageId);
            for (const line of trimmedOutput.split('\n')) {
              this.logger.info(`  ${line}`, stageId);
            }
            this.logger.info(`OUTPUT ↑`, stageId);
          }

          // Логгируем stderr независимо от exit code
          if (stderr.trim()) {
            const { lines, dumpPath } = this.prepareStderrForLog(stderr, stageId);
            this.logger.warn(`STDERR ↓`, stageId);
            for (const line of lines) {
              this.logger.warn(`  ${line}`, stageId);
            }
            if (dumpPath) this.logger.warn(`  полный stderr: ${dumpPath}`, stageId);
            this.logger.warn(`STDERR ↑`, stageId);
          }
        }

        // Парсим результат из вывода агента через ResultParser
        const result = this.resultParser.parse(stdout, stageId);

        // Если exit code ≠ 0, но результат уже распарсен — используем его
        if (code !== 0 && result.parsed && result.status && result.status !== 'default') {
          if (this.logger) {
            this.logger.warn(
              `Agent exited with code ${code}, but RESULT was parsed (status: ${result.status}). Using parsed result.`,
              stageId
            );
          }
          // Проваливаемся в resolve ниже
        } else if (code !== 0) {
          const err = new Error(`Agent exited with code ${code}`);
          err.code = 'NON_ZERO_EXIT';
          err.exitCode = code;
          err.stderr = stderr;
          err.signal = signal;
          if (this.logger) {
            this.logger.error(`Agent exited with code ${code}`, stageId);
            if (stderr.trim()) {
              const { lines, dumpPath } = this.prepareStderrForLog(stderr, stageId);
              for (const line of lines) {
                this.logger.error(`  stderr: ${line}`, stageId);
              }
              if (dumpPath) this.logger.error(`  полный stderr: ${dumpPath}`, stageId);
            }
          }
          reject(err);
          return;
        }

        // Детекция silent-failure: CLI-агент (kilo и т.п.) auto-rejected permission-
        // запросы, exit=0, структурированного RESULT нет. Без этой проверки pipeline
        // получает status=default и идёт дальше, а стейдж фактически не выполнен
        // (см. incident 2026-04-22: create-report/analyze-report в PulseProxy).
        // Маппим в ошибку, чтобы executeWithFallback переключился на следующего агента.
        // Считается только строка, которую kilo 7.7.9 печатает перед каждым авто-отказом
        // (и для субагента): «permission requested: <что> (<шаблоны>); auto-rejecting».
        // Прежний шаблон искал ещё «permission denied» и «rejected permission» где угодно
        // в stderr и ловил текст скила execute-task, который рельсы печатают там на шагах:
        // 2026-09-25 PulseProxy kilo-free и gpt-luna получили 6 и 7 «отказов», которых не было.
        if (code === 0 && !result.parsed && stderr) {
          const rejectMatches = stderr.match(/permission requested: [^\n]*; auto-rejecting/gi) || [];
          if (rejectMatches.length > 0) {
            const err = new Error(
              `Agent "${agentId}" exited 0 but auto-rejected ${rejectMatches.length} permission request(s) and produced no RESULT`
            );
            err.code = 'PERMISSION_REJECTED';
            err.exitCode = -1;
            err.stderr = stderr;
            err.rejectCount = rejectMatches.length;
            if (this.logger) {
              this.logger.error(
                `Agent "${agentId}" silent-failure: ${rejectMatches.length} auto-rejected permission(s), no RESULT — mapping to status=error`,
                stageId
              );
            }
            reject(err);
            return;
          }
        }

        resolve({
          status: result.status || 'default',
          output: stdout,
          stderr: stderr,
          result: result.data || {},
          exitCode: code,
          parsed: result.parsed
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        stopHeartbeat();
        if (!timedOut && !earlyKilled) {
          if (this.logger) {
            this.logger.error(`CLI error: ${err.message}`, stageId);
          }
          reject(err);
        }
      });
    });
  }

  /**
   * Вызывает CLI-агента через child_process (rails/README.md §11).
   *
   * Целевой агент стадии — всегда `WORKFLOW_RAILS_ROLE=coordinator` (раннер
   * не различает судью и целевого агента внутри обычного pipeline — судья
   * есть только в run-skill-tests.js). Тикет запуска (`context.ticket_id`) агент и его
   * повтор получают в `WORKFLOW_RAILS_TICKET` — для `{ticket}` в стражах рёбер (§4).
   * После успешного завершения, если у скила стадии есть `rails.yaml`, ищем состояние
   * сессии по `run` и гоним его через `output-check`; при нарушении — один повтор с
   * вердиктом (§8).
   * Ошибка/таймаут агента rails не касаются — пробрасываются как есть, ретрая на
   * них нет.
   *
   * Повтор по output-check продолжает ту же сессию хоста, если её можно продолжить:
   * у запуска ровно одно состояние рельс, и хост по команде агента умеет продолжение
   * (resumeSessionArgs: `claude --resume <id>`, `kilo run --session <id>`). Тогда
   * `WORKFLOW_RAILS_RUN` прежний — состояние той же сессии хранит `run` первого
   * запуска, — а промпт — только вердикт «числишься в <узел>, переходы оттуда», всегда через
   * stdin: исходный промпт и сделанное агент помнит. Иначе повтор — новая сессия с новым
   * `run`, и вердикт говорит правду: рельсы новой сессии — с `start`, сделанное — в
   * файлах; исходный промпт идёт после вердикта. Прогон PulseProxy 2026-09-27: новой
   * сессии говорили «Числишься в <узел прошлой сессии>», и повторы claude-haiku либо
   * проходили граф и работу заново, либо печатали команду goto текстом без единого
   * вызова инструмента.
   *
   * Состояния с этим `run` нет, а хуки рельс для хоста агента на месте
   * (railsHost/railsHooksPresent) — агент не вызвал ни одного инструмента под
   * рельсами: это нарушение, повтор в новой сессии с вердиктом «пройди граф от
   * start». Прежде такой ответ проходил молча (прогон deep-research 2026-09-25:
   * gpt-luna без единого вызова инструмента). Хуков нет или хост не claude/kilo —
   * повтором не обосновать: предупреждение в лог, ответ как есть.
   *
   * Ответ повтора тоже проходит output-check (`railsRetryVerdict` результата). Нарушение
   * и повтор без состояния — предупреждение в лог, а ответ всё равно отдаётся стадии:
   * третьего запуска нет, маршрут — по статусу ответа. У исполнителя и `default`, и
   * `error` ведут в move-to-review → verify-artifacts (configs/pipeline.yaml), и контроль
   * артефактов судит сделанное по тикету: работа, записанная до сбоя рельс, проходит, а
   * пустой результат — неудача с событием `verify` для правил отсева моделей.
   *
   * Исключение — ответ повтора без блока ---RESULT---: агент бросил скил на середине, и
   * `fallbackParse` дал бы ему `default` (успех) по словам текста. Такой ответ — сбой
   * запуска: ошибка с кодом `RAILS_INCOMPLETE` и кодом выхода -1, как у PERMISSION_REJECTED.
   * executeWithFallback пишет запуск статусом `error` и берёт следующего агента стадии,
   * если файлы снимка не менялись, иначе стадия уходит в goto.error. Прогон PulseProxy
   * 2026-09-28: бесплатная модель остановила DOCS-10 в узле P3R3 без итога, стадия
   * получила `default`, запуск в истории тикета — `ok`, недоделку поймали только
   * проверки DoD.
   *
   * `bannedCheck` — проверка ответивших моделей kilo-агента по запретам журнала
   * запусков (_callAgentTracked): и у первого вызова, и у повтора рельс.
   *
   * @returns {Promise<{status: string, output: string, stderr: string, result: object, exitCode: number, parsed: boolean}>}
   */
  async callAgent(agent, prompt, stageId, skillId, agentId = null, { bannedCheck = null } = {}) {
    const runId = crypto.randomUUID();
    const railsEnv = { WORKFLOW_RAILS_ROLE: 'coordinator', WORKFLOW_RAILS_RUN: runId };
    if (skillId) railsEnv.WORKFLOW_RAILS_SKILL = skillId;
    // Тикет запуска — для `{ticket}` в стражах рёбер (rails/README.md §4): страж смотрит
    // на файл тикета этого запуска, а не на любой тикет в каталоге.
    const ticket = (this.context && this.context.ticket_id) || null;
    if (ticket) railsEnv.WORKFLOW_RAILS_TICKET = ticket;

    const result = await this._callAgentTracked(agent, prompt, stageId, skillId, agentId, railsEnv, { bannedCheck });

    // Состояние ищется до проверки живого rails.yaml: удаление живого файла не
    // отключает проверку закреплённого рантайма запуска (ревью 2026-10-05).
    const state = findRailsStateByRun(this.projectRoot, runId);
    if (!state && !railsYamlExists(this.projectRoot, skillId)) return result;

    const skillDir = path.join(this.projectRoot, '.workflow', 'src', 'skills', skillId);
    let config;
    if (state) {
      // Конфиг — из закреплённого рантайма запуска: живой rails.yaml могли изменить
      // во время работы агента, а полномочия хуков остались прежними — итог обязан
      // проверяться тем же набором правил (ревью 2026-10-05). Повреждённое
      // закрепление — не «пропустить проверку»: остановка с кодом, как RAILS_INCOMPLETE.
      try {
        ({ config } = loadSkillRuntime(this.projectRoot, skillId, state));
      } catch (err) {
        const error = new Error(`Agent "${agentId}" run lost its pinned rails runtime for skill "${skillId}": ${err.message}`);
        error.code = 'RAILS_RUNTIME_LOST';
        error.exitCode = -1;
        error.stdout = result.output || '';
        error.stderr = result.stderr || '';
        throw error;
      }
    } else {
      // Состояния нет — закреплять нечего; живой конфиг нужен только тексту повтора.
      try {
        config = loadRailsConfig(skillDir);
      } catch (err) {
        if (this.logger) this.logger.warn(`rails: rails.yaml скила «${skillId}» не читается: ${err.message}`, stageId);
        config = null;
      }
    }
    let verdict;
    if (!state) {
      const host = railsHost(agent);
      const agentCwd = path.resolve(this.projectRoot, agent.workdir || '.');
      if (!host || !railsHooksPresent(host, agentCwd)) {
        if (this.logger) {
          const whose = host ? `(${host}) в ${agentCwd}` : '(хост не claude/kilo)';
          this.logger.warn(`rails: состояния сессии нет, а хуков рельс для агента ${whose} нет — output-check не выполнен`, stageId);
        }
        return result;
      }
      verdict = { ok: false, missing: ['ни одного вызова инструмента под рельсами'] };
    } else {
      verdict = checkRailsOutput(result.output || '', config, state);
      if (verdict.ok && !verdict.outcome) {
        // Проверенный финальный ответ в терминале — подтверждение завершения
        // (дефект 2026-10-06: положительный результат проверки не сохранялся,
        // и завершённая сессия не могла выйти из роли штатно). recordCompletion
        // сам проверяет терминал/приостановку/целостность runtime и не бросает.
        try {
          recordCompletion({ root: this.projectRoot, state, source: 'runner', answer: result.output || '' });
        } catch {
          // подтверждение не должно ломать успешный ответ стадии
        }
        return result;
      }
      if (verdict.ok && verdict.outcome) {
        // Приостановка RAILS_OUTCOME (blocked/needs_user) — не успех и не повод для
        // повтора или передачи другому исполнителю: работа ждёт владельца
        // (дизайн 2026-10-05, ревью: прежде возвращалась стадии как успешный ответ).
        if (this.logger) {
          this.logger.warn(`rails: агент приостановил работу (${verdict.outcome}) — без повтора, стадия завершается ошибкой ожидания`, stageId);
        }
        result.railsSuspended = verdict.outcome;
        result.railsVerdict = verdict;
        const error = new Error(`Agent "${agentId}" suspended skill "${skillId}": ${verdict.outcome} — waiting for owner`);
        error.code = 'RAILS_SUSPENDED';
        error.exitCode = 0;
        error.stdout = result.output || '';
        error.stderr = result.stderr || '';
        if (result.agentLabel) error.agentLabel = result.agentLabel;
        if (result.kiloModels) error.kiloModels = result.kiloModels;
        throw error;
      }
    }

    // Та же сессия — если её id однозначен (одно состояние у запуска) и хост умеет её продолжить.
    const states = state ? railsStatesByRun(this.projectRoot, runId) : [];
    const resumeArgs = states.length === 1 ? resumeSessionArgs(agent, state.session) : null;
    let retryAgent = agent;
    let retryPrompt;
    let retryRun;
    let sessionNote;
    if (resumeArgs) {
      // Промпт — всегда через stdin (prompt_stdin): из терминального узла переходов нет, вердикт —
      // одна строка, а однострочный промпт _callAgentOnce кладёт в командную строку, на Windows —
      // через cmd.exe без кавычек, и шаблоны rails.yaml из вердикта (`|`, `>`, `^`) cmd.exe
      // исполнял как свой синтаксис: повтор падал, не запустив хост (ревью 2026-09-27).
      // Продолжение с промптом через stdin проверено запуском (resumeSessionArgs).
      retryAgent = { ...agent, args: resumeArgs, prompt_stdin: true };
      retryRun = runId;
      // root/ticket — ребро, закрытое стражем, вердикт показывает «закрыто» без команды.
      retryPrompt = outputCheckVerdict({ verdict, state, config, skillDir, skill: skillId, sameSession: true, root: this.projectRoot, ticket }).trimEnd();
      sessionNote = `та же (${state.session})`;
    } else {
      retryRun = crypto.randomUUID();
      retryPrompt = (state
        ? outputCheckVerdict({ verdict, state, config, skillDir, skill: skillId })
        : railsNotEngagedVerdict({ skill: skillId, config })) + prompt;
      const why = !state ? 'состояния сессии нет'
        : states.length > 1 ? `сессий рельс у запуска: ${states.length}`
          : 'хост агента сессию не продолжает';
      sessionNote = `новая — ${why}`;
    }

    if (this.logger) {
      this.logger.warn(`rails: output-check нарушен, повтор с вердиктом — отсутствует: ${verdict.missing.join('; ')}; сессия ${sessionNote}`, stageId);
    }

    const retryEnv = {
      WORKFLOW_RAILS_ROLE: 'coordinator',
      WORKFLOW_RAILS_RUN: retryRun,
      WORKFLOW_RAILS_SKILL: skillId
    };
    if (ticket) retryEnv.WORKFLOW_RAILS_TICKET = ticket;
    const retryResult = await this._callAgentTracked(retryAgent, retryPrompt, stageId, skillId, agentId, retryEnv, { bannedCheck });
    retryResult.railsRetried = true;
    retryResult.railsVerdict = verdict;
    retryResult.railsRetrySession = resumeArgs ? 'same' : 'new';

    // Ответ повтора — через тот же output-check. Третьего запуска нет: нарушение — в лог,
    // ответ — стадии, ответ без ---RESULT--- — сбой запуска (почему так — в JSDoc выше).
    // Та же сессия — её собственное состояние: за повтор у запуска могла появиться сессия субагента.
    const retryState = resumeArgs
      ? railsStatesByRun(this.projectRoot, retryRun).find((s) => s.session === state.session) ?? null
      : findRailsStateByRun(this.projectRoot, retryRun);
    const retryVerdict = retryState
      ? checkRailsOutput(retryResult.output || '', config, retryState)
      : { ok: false, missing: ['ни одного вызова инструмента под рельсами'] };
    retryResult.railsRetryVerdict = retryVerdict;
    if (retryVerdict.ok && !retryVerdict.outcome) {
      // Проверенный ответ повтора в терминале — подтверждение завершения, как и
      // у первого ответа: без него штатный выход этой сессии недоступен
      // (ревью 2026-10-06, major; kilo-плагин Stop-пути не имеет).
      if (retryState) {
        try {
          recordCompletion({ root: this.projectRoot, state: retryState, source: 'runner', answer: retryResult.output || '' });
        } catch {
          // подтверждение не должно ломать успешный ответ стадии
        }
      }
      return retryResult;
    }
    if (retryVerdict.ok && retryVerdict.outcome) {
      // Приостановка и в ответе повтора — не успех (ревью 2026-10-05, второй раунд).
      retryResult.railsSuspended = retryVerdict.outcome;
      if (this.logger) {
        this.logger.warn(`rails: повтор приостановил работу (${retryVerdict.outcome}) — без новых запусков`, stageId);
      }
      const error = new Error(`Agent "${agentId}" suspended skill "${skillId}" on retry: ${retryVerdict.outcome} — waiting for owner`);
      error.code = 'RAILS_SUSPENDED';
      error.exitCode = 0;
      error.stdout = retryResult.output || '';
      error.stderr = retryResult.stderr || '';
      throw error;
    }
    const what = retryState
      ? `повтор тоже нарушил output-check — отсутствует: ${retryVerdict.missing.join('; ')}`
      : 'повтор без единого вызова инструмента под рельсами';
    // Блока ---RESULT--- нет — агент бросил скил на середине: сбой запуска, а не ответ
    // стадии (почему — в JSDoc выше).
    if (!retryResult.parsed) {
      if (this.logger) this.logger.warn(`rails: ${what}; блока ---RESULT--- нет — работа брошена, сбой запуска агента`, stageId);
      const err = new Error(`Agent "${agentId}" left skill "${skillId}" unfinished: no ---RESULT--- after the rails retry`);
      err.code = 'RAILS_INCOMPLETE';
      err.exitCode = -1;
      err.stdout = retryResult.output || '';
      err.stderr = retryResult.stderr || '';
      if (retryResult.agentLabel) err.agentLabel = retryResult.agentLabel;
      if (retryResult.kiloModels) err.kiloModels = retryResult.kiloModels;
      throw err;
    }
    if (this.logger) this.logger.warn(`rails: ${what} — ответ принят без процедуры скила, дальше — по переходам стадии`, stageId);
    return retryResult;
  }

  /**
   * `_callAgentOnce` + фактическая модель kilo-агента (lib/kilo-models.mjs). Пока агент
   * работает — опрос базы kilo и строка `AGENT_MODELS`, когда подпись агента меняется
   * (по ней панель pipeline в расширении показывает подпись с моделями роутера);
   * после выхода — финальная строка с числом шагов. Результат (или ошибка) получает
   * `agentLabel` — для столбца «Агент» истории работы тикета — и `kiloModels`
   * (`{models, last}`: ответившие модели и модель последнего шага корневой сессии) —
   * для события run журнала запусков.
   *
   * `bannedCheck(models)` — проверка ответивших моделей по запретам журнала (задаёт
   * executeWithFallback на стадии исполнителя): ответила запрещённая модель — опрос
   * снимает процесс агента, и вызов отклоняется ошибкой с кодом MODEL_BANNED и именем
   * модели. killCurrentChild для этого не годится: он ставит stopRequested, и стадия
   * больше не брала бы агентов. Убитый процесс на Windows выходит с кодом 1 без сигнала —
   * без пометки MODEL_BANNED запуск стал бы NON_ZERO_EXIT и классом error.
   */
  async _callAgentTracked(agent, prompt, stageId, skillId, agentId, railsEnv, { bannedCheck = null } = {}) {
    const tracker = this._trackKiloModels(agent, agentId, railsEnv.WORKFLOW_RAILS_RUN, stageId, { bannedCheck });
    let result;
    let error = null;
    try {
      result = await this._callAgentOnce(agent, prompt, stageId, skillId, agentId, railsEnv);
    } catch (err) {
      error = err;
    }
    const kilo = tracker ? await tracker.finish() : null;
    const agentLabel = kilo?.label ?? null;
    const kiloModels = kilo ? { models: kilo.models, last: kilo.last } : null;
    const banned = tracker?.banned() ?? null;
    if (banned) {
      error = Object.assign(new Error(`Agent "${agentId}" stopped: model "${banned.model}" is banned (${banned.reason})`), {
        code: 'MODEL_BANNED',
        exitCode: -1,
        stderr: (error?.stderr ?? result?.stderr) || '',
        bannedModel: banned.model,
        banReason: banned.reason,
      });
    }
    if (error) {
      if (typeof error === 'object') {
        if (agentLabel) error.agentLabel = agentLabel;
        if (kiloModels) error.kiloModels = kiloModels;
      }
      throw error;
    }
    if (agentLabel) result.agentLabel = agentLabel;
    if (kiloModels) result.kiloModels = kiloModels;
    return result;
  }

  /**
   * Опрос базы kilo на время запуска агента. null — агент не kilo (или нет run id).
   * `finish()` останавливает опрос, пишет финальную строку и отдаёт
   * `{label, models, last}` (label null — модели не определены; models и last —
   * по базе kilo, null — база не прочитана). `banned()` — модель, за которую опрос
   * снял агента, или null. Сбой чтения базы на агента не влияет.
   */
  _trackKiloModels(agent, agentId, runId, stageId, { bannedCheck = null } = {}) {
    if (!runId || !isKiloRun(agent)) return null;
    const title = kiloRunTitle(runId);
    const requested = requestedKiloModel(agent.args) || '?';
    const dbPathReady = kiloDbPath(agent.command);
    let lastLabel = null;
    let stopped = false;
    let banned = null;
    // Последнее, что опрос прочитал из базы: запасной ответ finish(), если финальное
    // чтение не удалось.
    let polled = null;

    const report = (models) => {
      lastLabel = kiloAgentLabel(agentId, requested, models);
      if (this.logger) {
        this.logger.info(`AGENT_MODELS agent="${lastLabel}" requested="${requested}" models="${formatKiloModels(models)}"`, stageId);
      }
    };

    const poll = async () => {
      const dbPath = await dbPathReady;
      if (!dbPath || stopped) return;
      const run = await readKiloRun(dbPath, title);
      const models = run?.models;
      if (stopped || !models?.length) return;
      polled = run;
      if (kiloAgentLabel(agentId, requested, models) !== lastLabel) report(models);
      if (!bannedCheck || banned) return;
      const hit = bannedCheck(models);
      if (!hit) return;
      banned = hit;
      if (this.logger) {
        this.logger.warn(`MODEL_BANNED agent="${agentId}" model="${hit.model}" — ${hit.reason}; stopping agent`, stageId);
      }
      const child = this.currentChild;
      if (child?.pid) {
        if (process.platform === 'win32') {
          try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true }); } catch {}
        } else {
          try { child.kill('SIGTERM'); } catch {}
        }
      }
    };
    const timer = setInterval(() => { poll().catch(() => {}); }, this.kiloModelsPollMs || KILO_MODELS_POLL_MS);
    timer.unref?.();

    return {
      banned: () => banned,
      finish: async () => {
        stopped = true;
        clearInterval(timer);
        try {
          const dbPath = await dbPathReady;
          if (!dbPath) {
            if (!this._kiloDbPathWarned && this.logger) {
              this._kiloDbPathWarned = true;
              this.logger.warn('kilo: `kilo db path` не дал путь базы — фактическая модель kilo-агентов не определяется', stageId);
            }
            return { label: null, models: null, last: null };
          }
          // Сразу после снятия процесса база kilo может не отдать шаги: живой прогон
          // 2026-09-27 — опрос видел модель, а чтение через 200 мс после taskkill дало
          // «модели нет», хотя шаг в базе есть (прочитан позже). Пока чтение не удалось
          // (null: база не читается или сессии нет) или не дало того, что уже видел
          // опрос, — несколько повторов, затем прочитанное опросом. Цена — до 0,9 с на
          // запуске kilo, упавшем до создания сессии.
          const behindPoll = (r) => r === null || (!r.models.length && Boolean(polled?.models?.length));
          let run = await readKiloRun(dbPath, title);
          for (let i = 0; behindPoll(run) && i < KILO_FINAL_READ_RETRIES; i++) {
            await new Promise((resolve) => setTimeout(resolve, KILO_FINAL_READ_DELAY_MS));
            run = await readKiloRun(dbPath, title);
          }
          if (behindPoll(run) && polled) run = polled;
          if (!run?.models?.length) {
            if (this.logger) this.logger.info('kilo: шагов с моделью в базе kilo нет — фактическая модель неизвестна', stageId);
            return { label: null, models: run?.models ?? null, last: null };
          }
          report(run.models);
          // Запрещённая модель ответила после последнего опроса — агент уже вышел,
          // снимать нечего, но результат не засчитывается как обычный запуск: вызов
          // отклоняется с MODEL_BANNED, и стадия берёт следующего агента.
          if (bannedCheck && !banned) {
            const hit = bannedCheck(run.models);
            if (hit) {
              banned = hit;
              if (this.logger) {
                this.logger.warn(`MODEL_BANNED agent="${agentId}" model="${hit.model}" — ${hit.reason}; agent already exited`, stageId);
              }
            }
          }
          return { label: lastLabel, models: run.models, last: run.last };
        } catch (err) {
          if (this.logger) this.logger.warn(`kilo: фактическая модель не прочитана: ${err.message}`, stageId);
          return { label: null, models: null, last: null };
        }
      },
    };
  }

}

// ============================================================================
// Уборка временных файлов approval-записи (см. writeApprovalPending)
// ============================================================================

// Имя временного файла: `.approval-tmp.<pid>.<hex>`. pid в имени — не украшение,
// а единственный след владельца: только по нему уборка отличает остаток
// умершего прогона от файла, который прямо сейчас дописывает соседний живой
// процесс. Расширения у имени нет — шаблон обязан требовать конец строки, иначе
// под уборку попал бы любой файл, начинающийся так же.
const APPROVAL_TMP_NAME_RE = /^\.approval-tmp\.(\d+)\.[0-9a-f]+$/;

// Между записью временного файла и его публикацией link'ом — миллисекунды.
// Порог в пять минут на три порядка больше этого окна и нужен не для скорости
// уборки, а как второй независимый признак: проверка живости pid читает таблицу
// процессов ЭТОЙ машины, а каталог проекта может лежать на сетевой шаре или в
// синхронизируемой папке, где файл написал процесс с таким же номером на другой
// машине. Цена ошибки несимметрична: снести чужую запись на лету — потерянный
// гейт и пайплайн, который ждёт решения вечно; не убрать остаток — он уберётся
// на следующем запуске.
const APPROVAL_TMP_MIN_AGE_MS = 5 * 60 * 1000;

// ============================================================================
// PipelineRunner — основной цикл выполнения пайплайна
// ============================================================================
class PipelineRunner {
  /**
   * run_id для запуска, начавшегося в момент `isoTimestamp`.
   * Совпадает с именем лог-файла без расширения — на это полагаются
   * внешние наблюдатели (VS Code расширение, workflow-mcp).
   */
  static buildRunId(isoTimestamp) {
    return `pipeline_${isoTimestamp.replace(/[:.]/g, '-').replace('T', '_').substring(0, 19)}`;
  }

  /** Полный путь к логу запуска. Каталог берётся из `execution.log_file`, если задан. */
  static resolveLogFilePath(pipeline, projectRoot, runId) {
    const logDir = pipeline.execution?.log_file
      ? path.dirname(path.resolve(projectRoot, pipeline.execution.log_file))
      : path.resolve(projectRoot, '.workflow/logs');
    return path.resolve(logDir, `${runId}.log`);
  }

  /**
   * @param {object} config — загруженный pipeline.yaml
   * @param {object} args — аргументы CLI
   * @param {{runId?: string, logFilePath?: string}} [overrides] — заранее
   *   вычисленные идентификаторы запуска (см. runPipeline)
   */
  constructor(config, args, overrides = {}) {
    this.config = config;
    
    // Validate manual-gate stages in pipeline.yaml at startup
    if (config.pipeline && config.pipeline.stages) {
      for (const [stageId, stage] of Object.entries(config.pipeline.stages)) {
        if (stage.type === 'manual-gate') {
          // Validate goto.approved
          if (!stage.goto || !stage.goto.approved) {
            throw new Error(`pipeline.yaml validation error in stage '${stageId}' (type: manual-gate): missing required 'goto.approved'`);
          }
          
          // Validate goto.rejected
          if (!stage.goto || !stage.goto.rejected) {
            throw new Error(`pipeline.yaml validation error in stage '${stageId}' (type: manual-gate): missing required 'goto.rejected'`);
          }
          
          // Validate poll_interval_ms if present
          if (stage.poll_interval_ms !== undefined) {
            if (typeof stage.poll_interval_ms !== 'number' || stage.poll_interval_ms < 100) {
              throw new Error(`pipeline.yaml validation error in stage '${stageId}' (type: manual-gate): poll_interval_ms must be a number >= 100`);
            }
          }
          
          // Validate timeout_seconds if present
          if (stage.timeout_seconds !== undefined) {
            if (typeof stage.timeout_seconds !== 'number' || stage.timeout_seconds <= 0) {
              throw new Error(`pipeline.yaml validation error in stage '${stageId}' (type: manual-gate): timeout_seconds must be a number > 0`);
            }
          }
        }
      }
    }
    
    this.args = args;
    this.pipeline = config.pipeline;
    this.context = { ...this.pipeline.context };
    this.counters = {};
    this.stepCount = 0;
    this.tasksExecuted = 0;
    this.running = true;
    this.currentStage = this.pipeline.entry;
    // Переход в end: стадия, статус и данные RESULT — для итога прогона (run).
    this.endedBy = null;

    // Базовая директория проекта вычисляется динамически
    const projectRoot = args.project ? path.resolve(args.project) : findProjectRoot();

    // Инициализация Logger — каждый запуск пишется в отдельный файл.
    // runPipeline вычисляет run_id и путь заранее, чтобы записать маркер одной
    // атомарной записью, и передаёт их сюда; при прямом создании раннера
    // (тесты, встраивание) считаем сами.
    this.runId = overrides.runId || PipelineRunner.buildRunId(new Date().toISOString());
    this.logFilePath = overrides.logFilePath
      || PipelineRunner.resolveLogFilePath(this.pipeline, projectRoot, this.runId);

    this.logger = new Logger(this.logFilePath);
    this.loggerInitialized = false;

    // Момент старта — тот же, что в lock'е (`started_at`), когда раннер
    // запускает runPipeline. Запрос паузы старше него оставлен прошлым запуском.
    const startedAtMs = Date.parse(overrides.startedAt ?? '');
    this.startedAtMs = Number.isNaN(startedAtMs) ? Date.now() : startedAtMs;
    // Как часто перечитывать запрос паузы, пока раннер стоит.
    this.pausePollMs = 1000;

    // Инициализация контекста из CLI аргументов
    if (args.plan) {
      this.context.plan_id = args.plan;
    }

    // Инициализация FileGuard для защиты файлов от изменений агентами
    const protectedPatterns = this.pipeline.protected_files || [];
    const trustedAgents = this.pipeline.trusted_agents || [];
    const trustedStages = this.pipeline.trusted_stages || [];
    this.fileGuard = new FileGuard(protectedPatterns, projectRoot, trustedAgents, trustedStages);
    this.projectRoot = projectRoot;
    this.currentExecutor = null;

    // Остановка раскрытия пулов моделей (команды списка и оценок, expandModelPools): до
    // первой стадии currentExecutor нет, сигнал снимает команды через этот signal.
    this.stopAbort = new AbortController();

    // Закрыть запись открытого запуска, оставленную прерванным раннером
    // (src/lib/agent-runs.mjs, closeInterruptedRun). Флаг ставит только runPipeline:
    // закрывать можно только под .pipeline.lock, а прямое создание раннера (тесты,
    // встраивание) lock не берёт — файл может принадлежать живому раннеру.
    this.closeOpenRunOnStart = overrides.closeOpenRunOnStart === true;

    // Настройка graceful shutdown
    this.setupGracefulShutdown();
  }

  /**
   * Асинхронно инициализирует runner (logger)
   */
  async init() {
    await this.logger.init();
    this.loggerInitialized = true;

    // Логгируем после инициализации
    const protectedPatterns = this.pipeline.protected_files || [];
    if (protectedPatterns.length > 0) {
      this.logger.info(`FileGuard enabled: ${protectedPatterns.length} pattern(s)`, 'PipelineRunner');
    }

    if (this.context.plan_id) {
      this.logger.info(`Plan ID: ${this.context.plan_id}`, 'PipelineRunner');
    } else {
      this.logger.info('No plan_id set — processing all tickets', 'PipelineRunner');
    }
  }

   /**
    * Вычисляет детерминированный идентификатор шага для approval-файла.
    * Формат: {ticket_id}_{stageId}_{attempt}
    *
    * @param {Object} context - Контекст выполнения пайплайна
    * @param {string} [context.ticket_id] - ID тикета (может быть undefined)
    * @param {string} stageId - Идентификатор стадии
    * @param {Object} counters - Счётчики выполнения
    * @param {number} [counters.task_attempts] - Номер попытки выполнения (0 если не задано)
    * @returns {string} Детерминированный step_id
    */
   computeStepId(context, stageId, counters) {
     const ticketId = context.ticket_id || 'no-ticket';
     const attempt = counters.task_attempts ?? 0;
     return `${ticketId}_${stageId}_${attempt}`;
   }

    /**
     * Создаёт approval-файл со статусом "pending" (идемпотентно).
     * Если файл уже существует — не перезаписывает, возвращает его содержимое.
     *
     * @param {string} filePath - Путь к approval-файлу (абсолютный)
     * @param {Object} payload - Данные для approval-файла
     * @param {string} payload.step_id - Идентификатор шага (должен совпадать с именем файла)
     * @param {string} payload.ticket_id - ID тикета
     * @param {string} payload.stage_id - ID стадии
     * @param {number} payload.attempt - Номер попытки
     * @param {Object} [payload.context_snapshot] - Снапшот контекста (опционально)
     * @returns {Promise<Object>} Объект approval-файла (прочитанный или созданный)
     * @throws {Error} При ошибке создания директории или записи файла
     */
    async writeApprovalPending(filePath, payload) {
      // Создаём директорию заранее (recursive, безопасно)
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      // Формируем данные approval-файла
      const now = new Date().toISOString();
      const approvalData = {
        step_id: payload.step_id,
        ticket_id: payload.ticket_id,
        stage_id: payload.stage_id,
        attempt: payload.attempt,
        status: 'pending',
        created_at: now,
        updated_at: now,
        decided_by: null,
        comment: null,
        context_snapshot: payload.context_snapshot || {}
      };

      const content = JSON.stringify(approvalData, null, 2);

      // Появление approval-файла обязано быть атомарным для читателей. Раньше
      // здесь были open(filePath, 'wx') + write: флаг 'wx' даёт эксклюзивное
      // создание, но между open и write файл лежит в каталоге нулевой длины.
      // Кто прочитал его в этот момент — получил пустую строку и
      // «Unexpected end of JSON input»: раннер в polling-цикле падал в
      // goto.error по «corrupt approval file», а хук move-ticket молча
      // пропускал auto-approve уже принятого человеком решения. Так упал
      // QA-37-003 в реальном прогоне набора.
      //
      // Поэтому JSON пишется целиком во временный файл, а в каталог approvals
      // попадает одним hard link'ом: читатель видит либо отсутствие файла,
      // либо весь JSON. link заодно сохраняет эксклюзивность — на уже
      // существующем пути он падает с EEXIST (проверено запуском на NTFS),
      // тогда как rename молча затёр бы чужое решение.
      //
      // Временный файл лежит на уровень выше каталога approvals: том тот же
      // (link между томами — EXDEV), но ни одно сканирование approvals его не
      // видит — ни шаблон хука ^<ticket>_manual-gate-.*_\d+\.json$, ни
      // readdirSync(approvals)[0] в тестах. Имя не содержит step_id намеренно:
      // id тикета бывает длиной 256 символов (src/tests/edge-ticket-id-long),
      // а компонент пути длиннее 255 на NTFS не создаётся (проверено запуском).
      const workflowDir = path.resolve(dir, '..');
      const tmpPath = path.join(
        workflowDir,
        `.approval-tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`
      );

      try {
        await fs.promises.writeFile(tmpPath, content, 'utf8');

        // Две попытки: файл может исчезнуть между EEXIST и чтением (другой
        // процесс отменил гейт). Вернуть в этом случае null нельзя — вызывающий
        // executeManualGate сразу читает existing.status и упал бы на TypeError.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await fs.promises.link(tmpPath, filePath);
            return approvalData;
          } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            const existing = await this.readApprovalFile(filePath);
            if (existing) return existing;
          }
        }

        throw new Error(`approval file at ${filePath} vanished while being created`);
      } finally {
        await fs.promises.unlink(tmpPath).catch(() => {});
        // Свой временный файл убран строкой выше — но только если процесс дожил
        // до этой строки. Убитый между записью и публикацией (kill, вылет,
        // перезагрузка) не убирает за собой ничего, и остаток лежит в .workflow
        // вечно: чистильщика не было. Уборка стоит здесь, а не на входе в гейт:
        // остатки заводит только запись, и платит за обход каталога тот запуск,
        // который сам сейчас писал.
        await this.sweepApprovalTmpLeftoversOnce(workflowDir);
      }
    }

    /**
     * Убирает временные файлы approval-записи, оставшиеся от умерших процессов.
     *
     * Опасность здесь одна и она дороже самого мусора: в том же каталоге может
     * работать другой живой раннер, и его временный файл — это гейт, который
     * сейчас опубликуется. Снести его на лету значит потерять решение человека.
     * Поэтому остаток обязан подтвердиться двумя независимыми признаками:
     *   1. pid из имени не жив (processAlive: ESRCH → мёртв; EPERM → жив, чужой
     *      пользователь; свой pid всегда жив, поэтому файл в работе не трогается);
     *   2. файл не менялся дольше APPROVAL_TMP_MIN_AGE_MS.
     * Ни один признак в одиночку не достаточен: номер умершего процесса система
     * переиспользует, а время изменения ничего не говорит о владельце.
     *
     * @param {string} workflowDir — каталог .workflow, куда кладётся временный файл
     * @param {number} [now] — точка отсчёта возраста (мс), по умолчанию Date.now()
     * @returns {Promise<string[]>} имена убранных файлов
     */
    async sweepApprovalTmpLeftovers(workflowDir, now = Date.now()) {
      let entries;
      try {
        entries = await fs.promises.readdir(workflowDir, { withFileTypes: true });
      } catch {
        return []; // каталога нет или он не читается — убирать нечего
      }

      const removed = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const match = APPROVAL_TMP_NAME_RE.exec(entry.name);
        if (!match) continue;

        // Признак 1: владелец мёртв.
        if (processAlive(Number(match[1]))) continue;

        const fullPath = path.join(workflowDir, entry.name);
        try {
          // Признак 2: файл давно не менялся. stat делается только для файлов,
          // прошедших первые два отбора, — обход каталога не превращается в
          // stat на каждую запись.
          const stat = await fs.promises.stat(fullPath);
          if (now - stat.mtimeMs < APPROVAL_TMP_MIN_AGE_MS) continue;
          await fs.promises.unlink(fullPath);
          removed.push(entry.name);
        } catch {
          // Файл исчез (его убрала параллельная уборка) или занят — не наша
          // забота: мусор доживёт до следующего запуска.
        }
      }

      return removed;
    }

    /**
     * Уборка ровно один раз на раннера: обход .workflow стоит readdir плюс stat
     * на каждого кандидата, и платить этим на каждой записи гейта незачем. Свой
     * прогон работы уборщику не подкидывает: пока процесс жив, он снимает свой
     * временный файл сам, а остаток соседа, умершего прямо сейчас, подождёт
     * следующего запуска — он всё равно не старше порога.
     *
     * Ошибку уборки глотаем: мусор не имеет права уронить создание гейта.
     * Но молчать о снятом файле нельзя — снёс уборщик или человек, потом не
     * разберёшь, поэтому непустой результат уходит в журнал прогона. Пустой не
     * пишется: строка «убрано 0» в каждом логе — это шум, а не след.
     *
     * @param {string} workflowDir — каталог .workflow проекта
     */
    async sweepApprovalTmpLeftoversOnce(workflowDir) {
      if (this.approvalTmpSwept) return;
      this.approvalTmpSwept = true;

      let removed = [];
      try {
        removed = await this.sweepApprovalTmpLeftovers(workflowDir);
      } catch {
        return;
      }

      if (removed.length > 0 && this.logger) {
        const shown = removed.slice(0, 3).join(', ');
        const tail = removed.length > 3 ? `, … (всего ${removed.length})` : '';
        try {
          this.logger.info(
            `approval: убраны временные файлы умерших прогонов из ${workflowDir}: ${shown}${tail}`
          );
        } catch {
          // Журнал пишется синхронно и падает на кончившемся месте и на правах.
          // Метод зовут из finally после публикации approval-файла: брошенное
          // отсюда исключение затёрло бы уже успешный результат — человек нажал
          // approve, гейт опубликован, а вызывающий получил бы ошибку из-за
          // строчки в журнале об уборке мусора.
        }
      }
    }

    /**
     * Читает approval-файл и парсит его как JSON.
     *
     * @param {string} filePath - Путь к approval-файлу (абсолютный)
     * @returns {Promise<Object|null>} Объект approval-файла или null если файл не существует
     * @throws {Error} При невалидном JSON — с сообщением "corrupt approval file at {path}: {parse error}"
     */
    async readApprovalFile(filePath) {
      // Создание файла атомарно (см. writeApprovalPending), но решение в него
      // вписывают перезаписью на месте: и хук move-ticket
      // (updateApprovalFilesHook), и approveOpenGates делают writeFile поверх
      // существующего файла, а он сначала обрезает его до нуля. Читатель,
      // попавший в это
      // окно, увидит пустую строку — при том, что файл цел и решение в нём
      // сейчас появится. Цена доверия первому чтению: гейт роняет пайплайн в
      // goto.error ровно в тот момент, когда человек нажал approve. Поэтому
      // обрезанное чтение перечитывается, а битым файл объявляется только если
      // JSON не собрался и после повторов.
      const RETRY_DELAYS_MS = [25, 50];

      for (let attempt = 0; ; attempt++) {
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          return JSON.parse(content);
        } catch (err) {
          if (err.code === 'ENOENT') {
            return null;
          }
          if (err instanceof SyntaxError) {
            if (attempt < RETRY_DELAYS_MS.length) {
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
              continue;
            }
            throw new Error(`corrupt approval file at ${filePath}: ${err.message}`);
          }
          // Перебрасываем другие ошибки (например, fs-ошибки) без изменений
          throw err;
        }
      }
    }

    /**
     * Выполняет встроенный стейдж типа update-counter:
     * инкрементирует счётчик и возвращает статус для goto-перехода.
     *
     * Конфигурация стейджа:
     *   type: update-counter
     *   counter: <name>   — имя счётчика
     *   max: <number>     — максимальное значение (опционально)
     *   goto:
     *     default: <stage>           — следующий стейдж
     *     max_reached: <stage>       — стейдж при достижении max
     */
    executeUpdateCounter(stageId, stage) {
      const counterName = stage.counter;
      if (!counterName) {
        throw new Error(`Stage "${stageId}" has type update-counter but no counter specified`);
      }

      this.counters[counterName] = (this.counters[counterName] || 0) + 1;
      const value = this.counters[counterName];

      if (this.logger) {
        this.logger.info(`Counter "${counterName}" incremented to ${value}`, stageId);
      }

      const max = stage.max;
      const status = (max && value >= max) ? 'max_reached' : 'default';

      return { status, result: { counter: counterName, value } };
    }

    /**
     * Выполняет встроенный стейдж типа manual-gate: создаёт approval-файл
     * и ждёт решения (approved/rejected) через polling файловой системы.
     *
     * Конфигурация стейджа:
     *   type: manual-gate
     *   poll_interval_ms: <number>  — интервал опроса в мс (опц., default 2000)
     *   timeout_seconds: <number>   — таймаут в секундах (опц., default null)
     *   goto:
     *     approved: <stage>         — обязательный, при одобрении
     *     rejected: <stage>         — обязательный, при отклонении
     *     timeout: <stage>          — опц., при истечении таймаута
     *     aborted: <stage>          — опц., при остановке runner'а
     *
     * @param {string} stageId - ID стадии
     * @param {object} stage - конфигурация стадии
     * @returns {Promise<{status: 'approved'|'rejected'|'timeout'|'aborted', result: object}>}
     */
    async executeManualGate(stageId, stage) {
      const stepId = this.computeStepId(this.context, stageId, this.counters);
      const filePath = path.join(this.projectRoot, '.workflow', 'approvals', `${stepId}.json`);

      const payload = {
        step_id: stepId,
        ticket_id: this.context.ticket_id || 'no-ticket',
        stage_id: stageId,
        attempt: this.counters.task_attempts || 0,
        context_snapshot: { ...this.context }
      };

      // Approval-файл ключуется парой (ticket_id, stage_id, attempt). Если он уже есть —
      // читаем его как есть и НЕ создаём поверх новый pending: иначе повторный заход на
      // стейдж затирает уже принятое человеком решение (status/decided_by/comment).
      const preexisting = await this.readApprovalFile(filePath);
      const existing = preexisting || await this.writeApprovalPending(filePath, payload);

      // Если файл уже был и статус уже resolved — сразу возвращаем результат (recovery)
      if (existing.status === 'approved' || existing.status === 'rejected') {
        if (this.logger) {
          this.logger.info(
            `[${stageId}] manual-gate: already ${existing.status} by ${existing.decided_by || 'unknown'}${existing.comment ? `, comment="${existing.comment}"` : ''}`,
            stageId
          );
        }
        return {
          status: existing.status,
          result: {
            step_id: stepId,
            decided_by: existing.decided_by,
            comment: existing.comment
          }
        };
      }

      // Ждём решения: либо только что создали pending, либо переиспользуем уже существующий
      if (this.logger) {
        this.logger.info(
          preexisting
            ? `[${stageId}] manual-gate: reusing existing approval at ${filePath} (status=${existing.status})`
            : `[${stageId}] manual-gate: created pending approval at ${filePath}`,
          stageId
        );
      }

      const pollIntervalMs = stage.poll_interval_ms || 2000;
      const timeoutSeconds = stage.timeout_seconds || null;
      const startTime = Date.now();

      // Polling-цикл
      while (this.running) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        // Проверка остановки runner'а
        if (!this.running) {
          if (this.logger) {
            this.logger.warn(`[${stageId}] manual-gate: aborted (runner stopped)`, stageId);
          }
          return { status: 'aborted', result: { step_id: stepId } };
        }

        // Проверка таймаута
        if (timeoutSeconds !== null) {
          const elapsed = (Date.now() - startTime) / 1000;
          if (elapsed >= timeoutSeconds) {
            if (this.logger) {
              this.logger.warn(`[${stageId}] manual-gate: timeout after ${timeoutSeconds}s, no decision`, stageId);
            }
            return { status: 'timeout', result: { step_id: stepId } };
          }
        }

        // Читаем текущее состояние файла
        let data;
        try {
          data = await this.readApprovalFile(filePath);
        } catch (err) {
          // Corrupt JSON — пробрасываем ошибку для goto.error
          throw err;
        }

        if (data && data.status === 'approved') {
          if (this.logger) {
            this.logger.info(
              `[${stageId}] manual-gate: approved by ${data.decided_by || 'unknown'}${data.comment ? `, comment="${data.comment}"` : ''}`,
              stageId
            );
          }
          return {
            status: 'approved',
            result: {
              step_id: stepId,
              decided_by: data.decided_by,
              comment: data.comment
            }
          };
        }

        if (data && data.status === 'rejected') {
          if (this.logger) {
            this.logger.info(
              `[${stageId}] manual-gate: rejected by ${data.decided_by || 'unknown'}${data.comment ? `, comment="${data.comment}"` : ''}`,
              stageId
            );
          }
          return {
            status: 'rejected',
            result: {
              step_id: stepId,
              decided_by: data.decided_by,
              comment: data.comment
            }
          };
        }

        // DEBUG-лог polling (оставляем только если нужен)
        if (this.logger && this.logger.level === 'debug') {
          this.logger.debug(`[${stageId}] manual-gate: polling, current status=pending`, stageId);
        }
      }

      // Выход по this.running = false
      if (this.logger) {
        this.logger.warn(`[${stageId}] manual-gate: aborted (runner stopped)`, stageId);
      }
      return { status: 'aborted', result: { step_id: stepId } };
    }

  /**
   * Запускает основной цикл выполнения
   */
  async run() {
    // Инициализируем logger
    await this.init();

    const maxSteps = this.pipeline.execution?.max_steps || 100;
    const delayBetweenStages = this.pipeline.execution?.delay_between_stages || 5;

    this.logger.info('=== Pipeline Runner Started ===', 'PipelineRunner');
    this.logger.info(`Entry stage: ${this.pipeline.entry}`, 'PipelineRunner');
    this.logger.info(`Max steps: ${maxSteps}`, 'PipelineRunner');
    this.logger.info(`Context: ${JSON.stringify(this.context)}`, 'PipelineRunner');

    if (this.closeOpenRunOnStart) this.closeInterruptedAgentRun();

    // Пулы моделей раскрываются один раз на процесс, до первой стадии: участники
    // регистрируются в общем config.pipeline.agents, который получает каждый
    // StageExecutor (src/lib/model-pools.mjs). Сбой команды списка — пул без
    // участников и строка POOL с причиной, пайплайн идёт дальше.
    // Сигнал остановки снимает команды пула (stopAbort) — пулы без участников, цикл не идёт.
    await expandModelPools(this.pipeline, {
      projectRoot: this.projectRoot, logger: this.logger, stageId: 'PipelineRunner', signal: this.stopAbort.signal,
    });
    // Факты стадий с выбором модели (`selection.scores`) — тоже один раз на процесс, после
    // раскрытия пулов: на вход идут модели участников. Сбой — все кандидаты без оценок
    // (бесплатны только id с `:free`), попытки идут прежним курсором (_resolveGoverned).
    await loadStageFacts(this.pipeline, {
      projectRoot: this.projectRoot, logger: this.logger, stageId: 'PipelineRunner', signal: this.stopAbort.signal,
    });

    while (this.running && this.stepCount < maxSteps) {
      if (this.currentStage !== 'end') {
        await this.waitWhilePauseRequested();
        if (!this.running) { break; }
      }

      this.stepCount++;

      this.logger.info(`Step ${this.stepCount}`, 'PipelineRunner');
      this.logger.info(`Current stage: ${this.currentStage}`, 'PipelineRunner');

      if (this.currentStage === 'end') {
        const stuck = this.stuckEnd();
        if (stuck) this.logger.warn(stuck, 'PipelineRunner');
        else this.logger.info('Pipeline completed successfully!', 'PipelineRunner');
        break;
      }

      try {
        // Выполняем stage
        const stage = this.pipeline.stages[this.currentStage];
        if (!stage) {
          throw new Error(`Stage not found: ${this.currentStage}`);
        }

         let result;

         // Встроенные типы стейджа — выполняются без вызова внешних агентов
         if (stage.type === 'update-counter') {
           result = this.executeUpdateCounter(this.currentStage, stage);
         } else if (stage.type === 'manual-gate') {
           result = await this.executeManualGate(this.currentStage, stage);
         } else {
           this.currentExecutor = new StageExecutor(this.config, this.stageContext(this.currentStage, stage), this.counters, {}, this.fileGuard, this.logger, this.projectRoot, { runId: this.runId });
           result = await this.currentExecutor.execute(this.currentStage);
           this.currentExecutor = null;
           this.recordStageEvent(this.currentStage, stage, result);
         }

        this.logger.info(`Stage ${this.currentStage} completed with status: ${result.status}`, 'PipelineRunner');

        // Определяем следующий stage по goto-логике
        const nextStage = this.resolveNextStage(this.currentStage, result);

        // Считаем выполненные задачи (execute-task)
        if (this.currentStage === 'execute-task' && result.status !== 'error') {
          this.tasksExecuted++;
        }

        this.endedBy = nextStage === 'end'
          ? { stage: this.currentStage, status: result.status, data: result.result || {} }
          : null;

        // Переход к следующему stage
        this.currentStage = nextStage;

        // Задержка между stages
        if (nextStage !== 'end' && this.running) {
          this.logger.info(`Waiting ${delayBetweenStages}s before next stage...`, 'PipelineRunner');
          await this.sleep(delayBetweenStages * 1000);
        }

      } catch (err) {
        const failedStage = this.currentStage;
        this.logger.error(`Error at stage "${failedStage}": ${err.message}`, 'PipelineRunner');

        // Пытаемся получить fallback transition
        const stage = this.pipeline.stages[failedStage];
        if (stage?.goto?.error) {
          const errorTarget = typeof stage.goto.error === 'string' ? stage.goto.error : stage.goto.error.stage;
          this.logger.info(`Transitioning to error handler: ${errorTarget}`, 'PipelineRunner');
          this.currentStage = errorTarget;

          // Обновляем контекст параметрами из error transition
          if (typeof stage.goto.error === 'object' && stage.goto.error.params) {
            this.updateContext(stage.goto.error.params, { error: err.message });
          }

          // Прогон, дошедший до end через обработчик ошибки, не завершён
          // успешно: без endedBy итог читался бы как «Pipeline completed»
          // (2026-10-04, ревью человеческого маршрута).
          if (errorTarget === 'end') {
            this.endedBy = { stage: failedStage, status: 'error', data: { error: err.message } };
          }
        } else {
          this.logger.error('No error handler defined. Stopping.', 'PipelineRunner');
          this.running = false;
        }
      }
    }

    if (this.stepCount >= maxSteps) {
      this.logger.error(`Stopped: reached max steps limit (${maxSteps})`, 'PipelineRunner');
    }

    this.logger.info('=== Pipeline Runner Finished ===', 'PipelineRunner');
    this.logger.info(`Total steps: ${this.stepCount}`, 'PipelineRunner');
    this.logger.info(`Tasks executed: ${this.tasksExecuted}`, 'PipelineRunner');
    this.logger.info(`Final context: ${JSON.stringify(this.context)}`, 'PipelineRunner');

    // Ожидание человека и ошибка маршрута не являются успехом плана.
    const stoppedOutcome = this.stuckEnd();
    const outcome = stoppedOutcome || (
      this.currentStage === 'end'
        ? 'Pipeline completed'
        : 'Pipeline stopped before completion'
    );
    this.logger.writeSummary(outcome);

    return {
      steps: this.stepCount,
      tasksExecuted: this.tasksExecuted,
      context: this.context,
      failed: (!this.running && this.stepCount < maxSteps) ||
        this.isHumanRouteError() ||
        this.endedBy?.status === 'error',
      humanActionRequired:
        this.endedBy?.status === 'human_action_required',
      // План стоит (STUCK_END_STATUSES): прогон не упал, но и успехом не кончился.
      stuck: this.currentStage === 'end' && Boolean(this.stuckEnd()),
    };
  }

  /**
   * Ошибка маршрута human: stage human-gate-route/review-failure-route закончился
   * диагностикой (human_route_error или неожиданный статус), либо запуск скрипта
   * сбоил — прогон не должен выглядеть успешным.
   */
  isHumanRouteError() {
    const ended = this.endedBy;
    if (!ended) return false;
    if (ended.status === 'human_route_error') return true;

    // Неожиданный результат или сбой запуска скрипта тоже не означает успех.
    return ['human-gate-route', 'review-failure-route'].includes(ended.stage) &&
      ended.status !== 'human_action_required';
  }

  /**
   * Итог прогона, который ушёл в end по статусу из STUCK_END_STATUSES: строка
   * «Pipeline stopped: plan … is stuck (<стадия>: <статус>, blocked: …) — needs a human
   * decision» с plan_id и blocked_tickets из RESULT стадии. Иначе — null.
   */
  stuckEnd() {
    const ended = this.endedBy;
    if (!ended) return null;

    if (ended.status === 'human_action_required') {
      const ticket = ended.data.ticket_id || this.context.ticket_id || 'unknown';
      const message = ended.data.message || 'Требуется действие человека';
      return `Pipeline waiting for human action: ${ticket} — ${message}`;
    }

    if (this.isHumanRouteError()) {
      const ticket = ended.data.ticket_id || this.context.ticket_id || 'unknown';
      const message = ended.data.message ||
        `Сбой маршрута ${ended.stage}: ${ended.status}` +
        (ended.data.error ? ` — ${ended.data.error}` : '');
      return `Pipeline stopped: human routing error for ${ticket} — ${message}`;
    }

    if (ended.status === 'error') {
      const reason = ended.data?.error || 'Ошибка стадии';
      return `Pipeline stopped: stage ${ended.stage} failed — ${reason}`;
    }

    if (!STUCK_END_STATUSES.has(ended.status)) return null;
    const plan = ended.data.plan_id ? `plan ${ended.data.plan_id}` : 'plan';
    const blocked = ended.data.blocked_tickets
      ? `, blocked: ${ended.data.blocked_tickets}`
      : '';
    return `Pipeline stopped: ${plan} is stuck ` +
      `(${ended.stage}: ${ended.status}${blocked}) — needs a human decision`;
  }

  /**
   * Определяет следующий stage на основе результата и goto-конфигурации
   * Также управляет retry-логикой с agent_by_attempt
   */
  resolveNextStage(stageId, result) {
    const stage = this.pipeline.stages[stageId];
    if (!stage || !stage.goto) {
      this.logger.gotoTransition(stageId, 'end', result.status);
      return 'end';
    }

    const goto = stage.goto;
    const status = result.status;

    // Проверяем точное совпадение статуса
    if (goto[status]) {
      const transition = goto[status];

      // Если переход задан строкой (shorthand: "stage-name")
      if (typeof transition === 'string') {
        this.logger.gotoTransition(stageId, transition, status);
        return transition;
      }

      // Обновляем контекст параметрами перехода
      if (transition.params) {
        this.updateContext(transition.params, result.result);
      }

      const nextStage = transition.stage || 'end';
      this.logger.gotoTransition(stageId, nextStage, status, transition.params);
      return nextStage;
    }

    // Fallback на default
    if (goto.default) {
      const transition = goto.default;

      if (typeof transition === 'string') {
        this.logger.gotoTransition(stageId, transition, 'default');
        return transition;
      }

      if (transition.params) {
        this.updateContext(transition.params, result.result);
      }

      const nextStage = transition.stage || 'end';
      this.logger.gotoTransition(stageId, nextStage, 'default', transition.params);
      return nextStage;
    }

    this.logger.gotoTransition(stageId, 'end', 'default');
    return 'end';
  }

  /**
   * Обновляет контекст переменными из params с подстановкой значений
   */
  updateContext(params, resultData) {
    if (!params) return;

    // Проверяем смену ticket_id для сброса счётчика попыток
    const newTicketId = params.ticket_id ?
      (typeof params.ticket_id === 'string' ?
        params.ticket_id
          .replace(/\$result\.(\w+)/g, (_, k) => resultData[k] || '')
          .replace(/\$context\.(\w+)/g, (_, k) => this.context[k] || '')
        : params.ticket_id)
      : null;

    if (newTicketId && this.context.ticket_id && newTicketId !== this.context.ticket_id) {
      // Тикет сменился — сбрасываем все счётчики попыток
      for (const counterKey of Object.keys(this.counters)) {
        if (counterKey.includes('attempt')) {
          this.counters[counterKey] = 0;
          if (this.logger) {
            this.logger.info(`Reset counter "${counterKey}" due to ticket change (${this.context.ticket_id} → ${newTicketId})`, 'PipelineRunner');
          }
        }
      }
    }

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        // Подстановка переменных: $context.*, $result.*, $counter.*
        let resolvedValue = value;

        // $result.*
        resolvedValue = resolvedValue.replace(/\$result\.(\w+)/g, (_, k) => resultData[k] || '');

        // $context.*
        resolvedValue = resolvedValue.replace(/\$context\.(\w+)/g, (_, k) => this.context[k] || '');

        // $counter.*
        resolvedValue = resolvedValue.replace(/\$counter\.(\w+)/g, (_, k) => this.counters[k] || 0);

        this.context[key] = resolvedValue;
      } else {
        this.context[key] = value;
      }
    }

    if (this.logger) {
      this.logger.info(`Context updated: ${JSON.stringify(this.context)}`, 'PipelineRunner');
    }
  }

  /**
   * Контекст, с которым исполняется стадия. У стадии тикета — сам контекст раннера. У
   * стадии уровня плана (`scope: plan` в pipeline.yaml: отчёт, разбор, разбиение пробелов,
   * закрытие плана) — копия без ключей тикета (TICKET_CONTEXT_KEYS): их не видят ни промпт,
   * ни выбор агента (task_type, required_capabilities), ни журнал запусков, ни история
   * работы тикета. Контекст раннера при этом не меняется: сброс ticket_id в нём отключил бы
   * сброс счётчиков попыток при смене тикета (updateContext сравнивает с прежним ticket_id).
   *
   * plan_id пуст (запуск без --plan), а report_id есть — копии достаётся план отчёта
   * (related_plan, reportPlanId). Только копии: план в контексте раннера сузил бы выбор и
   * проверку тикетов до конца запуска (pick-next-task и check-conditions фильтруют по
   * plan_id). 2026-09-29/30 decompose-gaps получала вход без plan_id, которого требуют
   * узлы скила P0R2/P0Q1 (ListeningGlass REPORT-001, PulseProxy REPORT-031): план агент
   * находил сам, а по ветке «нет» пробелы потерялись бы.
   */
  stageContext(stageId, stage) {
    if (stage?.scope !== 'plan') return this.context;
    const view = { ...this.context };
    const dropped = TICKET_CONTEXT_KEYS.filter((key) => view[key] !== undefined && view[key] !== null && view[key] !== '');
    for (const key of TICKET_CONTEXT_KEYS) delete view[key];
    if (dropped.length > 0) {
      this.logger.info(`scope=plan stage="${stageId}" ticket context not passed (${dropped.join(' ')})`, 'PipelineRunner');
    }
    if (!view.plan_id && view.report_id) {
      const planId = reportPlanId(this.projectRoot, view.report_id);
      if (planId) {
        view.plan_id = planId;
        this.logger.info(`scope=plan stage="${stageId}" plan_id=${planId} from related_plan of ${view.report_id}`, 'PipelineRunner');
      }
    }
    return view;
  }

  /**
   * Утилита для задержки
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Держит раннер перед следующей стадией, пока есть адресованный ему запрос
   * паузы (`lib/pause-request.mjs`).
   *
   * Пауза кооперативная: проверяется между стадиями, текущая стадия и её агент
   * доигрывают до конца. Приостановка процесса раннера агента не
   * останавливает, а таймаут стадии продолжает тикать — после долгой паузы
   * стадию убивало бы по таймауту.
   *
   * Строки `PAUSED …` и `RESUMED …` читает расширение VS Code: по ним запуск
   * снаружи показывается как стоящий на паузе.
   */
  async waitWhilePauseRequested() {
    const requested = () => readPauseRequest(this.projectRoot, process.pid, this.startedAtMs);
    if (!requested()) { return; }
    this.logger.info(`PAUSED before stage="${this.currentStage}"`, 'PipelineRunner');
    while (this.running && requested()) {
      await this.sleep(this.pausePollMs);
    }
    if (this.running) {
      this.logger.info(`RESUMED stage="${this.currentStage}"`, 'PipelineRunner');
    }
  }

  /**
   * Настройка graceful shutdown
   */
  setupGracefulShutdown() {
    const shutdown = (signal) => {
      if (this.logger) {
        this.logger.info(`Received ${signal}. Shutting down gracefully...`, 'PipelineRunner');
      }
      this.running = false;
      // Команды раскрытия пулов (до первой стадии) и текущий агент
      this.stopAbort?.abort();
      if (this.currentExecutor) {
        this.currentExecutor.killCurrentChild();
      }
    };

    // SIGBREAK — Ctrl+Break в консоли Windows (runPipeline): та же мягкая остановка.
    this.signalHandlers = {
      SIGINT: () => shutdown('SIGINT'),
      SIGTERM: () => shutdown('SIGTERM'),
      SIGBREAK: () => shutdown('SIGBREAK'),
    };
    for (const [signal, handler] of Object.entries(this.signalHandlers)) process.on(signal, handler);
  }

  /** Снимает обработчики сигнала раннера — после завершения runPipeline. */
  disposeSignalHandlers() {
    if (!this.signalHandlers) return;
    for (const [signal, handler] of Object.entries(this.signalHandlers)) process.off(signal, handler);
    this.signalHandlers = null;
  }

  /**
   * Жёсткая остановка — повторный сигнал во время мягкой (runPipeline): цикл не
   * продолжается, текущий агент снимается без ожидания (forceKillCurrentChild).
   */
  forceStop() {
    this.running = false;
    this.stopAbort?.abort();
    this.currentExecutor?.forceKillCurrentChild();
  }

  /**
   * Событие `verify` или `review` журнала запусков по результату стадии
   * (src/lib/agent-runs.mjs, PLAN-003). Контроль артефактов — поля его блока RESULT;
   * стадия, упавшая без RESULT, события не пишет. Ревью — статус, как вернула стадия,
   * агент и модель: у обмена model_io — из ответа модели, у стадии со скилом — агент и
   * ключ модели запуска. Сбой записи — WARN, ход пайплайна не меняется.
   */
  recordStageEvent(stageId, stage, result) {
    try {
      const kind = stageEventKind(this.pipeline, stage);
      if (!kind || !result) return;
      const data = result.result || {};
      const ticket = data.ticket_id || this.context.ticket_id || null;
      const base = {
        pipeline_run: this.runId,
        ticket,
        ticket_type: ticketTypeOf({ ...this.context, ticket_id: ticket }),
      };
      let event;
      if (kind === 'verify') {
        if (!result.parsed) return;
        event = {
          type: 'verify',
          ...base,
          status: result.status,
          reason: data.reason || null,
          dod_completion_pct: resultNumber(data.dod_completion_pct),
          result_filled: resultBoolean(data.result_filled),
          missing_files: resultList(data.missing_files, ','),
          unchanged_files: resultList(data.unchanged_files, ','),
          evidence_file: data.evidence_file || null,
          dod_check_total: resultNumber(data.dod_check_total),
          dod_check_failed: resultNumber(data.dod_check_failed),
          fail_reasons: resultList(data.fail_reasons, ';'),
        };
      } else {
        const modelIo = result.modelIo || null;
        event = {
          type: 'review',
          ...base,
          stage: stageId,
          status: result.status,
          agent: modelIo?.agent ?? result.agentId ?? null,
          model: modelIo ? (modelIo.model ?? null) : (stage.model_io ? null : (result.runModel ?? null)),
        };
      }
      const written = appendRunEvent(this.projectRoot, event);
      if (!written.ok) this.logger.warn(`agent-runs: ${kind} event not written: ${written.error}`, stageId);
    } catch (err) {
      this.logger.warn(`agent-runs: stage event failed: ${err.message}`, stageId);
    }
  }

  /**
   * Запись открытого запуска, оставленная прерванным раннером (`taskkill /F`,
   * `SIGKILL`, падение раннера или машины), — событием `run` со статусом `aborted` и
   * `interrupted: true` (closeInterruptedRun). Вызывается до первой стадии, только
   * когда раннер запущен runPipeline и держит .pipeline.lock.
   */
  closeInterruptedAgentRun() {
    try {
      const closed = closeInterruptedRun(this.projectRoot);
      if (closed.action === 'closed') {
        const e = closed.event;
        this.logger.warn(
          `agent run interrupted: agent=${e.agent} ticket=${e.ticket ?? '-'} stage=${e.stage} run_key=${e.run_key} — recorded as aborted (interrupted)`,
          'PipelineRunner'
        );
      } else if (closed.action === 'already_logged') {
        this.logger.info(`open agent run record ${closed.run_key} already in journal — removed`, 'PipelineRunner');
      } else if (closed.action === 'unreadable') {
        this.logger.warn(`open agent run record unreadable — removed without event: ${closed.error}`, 'PipelineRunner');
      } else if (closed.action === 'failed') {
        this.logger.warn(`open agent run record not closed: ${closed.error}`, 'PipelineRunner');
      }
    } catch (err) {
      this.logger.warn(`open agent run record not closed: ${err.message}`, 'PipelineRunner');
    }
  }
}

/** Кто может значиться в `started_by`. Остальное — мусор в env. */
const STARTED_BY_VALUES = new Set(['cli', 'mcp', 'extension']);

/**
 * Источник запуска для маркера.
 *
 * Значение приходит через `WORKFLOW_STARTED_BY` от того, кто спавнит раннер.
 * Переменная тут же снимается: `spawn` для агентов наследует окружение, и
 * вложенный `workflow run` иначе унаследовал бы чужой источник.
 * Неизвестное значение отбрасывается — контракт поля закрытый.
 */
function startedBy() {
  const raw = process.env.WORKFLOW_STARTED_BY;
  delete process.env.WORKFLOW_STARTED_BY;

  if (!raw) { return 'cli'; }
  if (STARTED_BY_VALUES.has(raw)) { return raw; }

  console.warn(`[runner] unknown WORKFLOW_STARTED_BY=${JSON.stringify(raw)} — writing 'cli'`);
  return 'cli';
}

/** Непрозрачная метка: буквы, цифры и немного разделителей, до 128 символов. */
const STARTED_BY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,127}$/;

/**
 * Идентификатор экземпляра, запустившего раннер.
 *
 * Приходит через `WORKFLOW_STARTED_BY_ID` рядом с `WORKFLOW_STARTED_BY` и
 * ложится в lock отдельным полем. По нему MCP-сервер узнаёт собственный
 * запуск, не заводя второго файла владения: до этого поля он писал рядом
 * `.workflow/logs/.mcp-started-by`, и два файла про один запуск умели
 * разойтись.
 *
 * Значение раннер не расшифровывает — для него это метка. Отбрасывается явный
 * мусор: пустое, длиннее 128 символов, с пробелами или управляющими символами.
 * Переменная снимается по той же причине, что и `WORKFLOW_STARTED_BY`:
 * вложенный `workflow run` иначе унаследовал бы чужую метку.
 */
function startedById() {
  const raw = process.env.WORKFLOW_STARTED_BY_ID;
  delete process.env.WORKFLOW_STARTED_BY_ID;

  if (!raw) { return null; }
  if (STARTED_BY_ID_PATTERN.test(raw)) { return raw; }

  console.warn(`[runner] unknown WORKFLOW_STARTED_BY_ID=${JSON.stringify(raw)} — omitting the field`);
  return null;
}

function markerStartedAt(projectRoot, marker) {
  if (typeof marker.started_at === 'string' && marker.started_at) return marker.started_at;
  if (typeof marker.timestamp === 'string' && marker.timestamp) return marker.timestamp;
  try {
    return fs.statSync(path.join(projectRoot, '.workflow/logs/.pipeline.lock')).mtime.toISOString();
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const args = {
    plan: null,
    config: null,
    project: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--plan':
        args.plan = argv[++i] || null;
        break;
      case '--config':
        args.config = argv[++i] || null;
        break;
      case '--project':
        args.project = argv[++i] || null;
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Workflow Runner - Pipeline Orchestrator

Usage: node runner.mjs [options]

Options:
  --plan PLAN-ID      Plan ID to execute (e.g., PLAN-003)
  --config PATH       Path to pipeline.yaml config (default: .workflow/config/pipeline.yaml)
  --project PATH      Project root path (overrides auto-detection)
  --help, -h          Show this help message

Examples:
  node .workflow/src/runner.mjs --help
  node .workflow/src/runner.mjs --plan PLAN-003
  node runner.mjs --project /path/to/project --plan PLAN-003
`);
}

function loadConfig(configPath) {
  const fullPath = path.resolve(configPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const config = yaml.load(content);

  return config;
}

// Безынструментный агент (`kind: http`) — модель по HTTP без инструментов и без
// работы с файлами: файлы читают и пишут скрипты стадии (`model_io`). Запись
// без `kind` — прежний CLI-агент с `command`. README, «Безынструментные агенты».
const AGENT_KINDS = ['cli', 'http'];
const HTTP_AGENT_PROTOCOLS = ['chat', 'decisions'];
const HTTP_AGENT_REQUIRED_FIELDS = ['protocol', 'url', 'model', 'auth'];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `{ env: <ИМЯ> }`, `{ file: <путь> }` или `{ kilo_oauth: true }` — ровно одна форма. */
function isValidHttpAuth(auth) {
  if (!isPlainObject(auth)) return false;
  const keys = Object.keys(auth);
  if (keys.length !== 1) return false;
  if (keys[0] === 'env') return typeof auth.env === 'string' && ENV_NAME_RE.test(auth.env);
  if (keys[0] === 'file') return typeof auth.file === 'string' && auth.file.trim() !== '';
  if (keys[0] === 'kilo_oauth') return auth.kilo_oauth === true;
  return false;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0
    && value.every(item => typeof item === 'string' && item.trim() !== '');
}

// Встроенный модификатор регулярного выражения: `(?i)`, `(?i:…)`, `(?-i:…)`.
const INLINE_MODIFIER_RE = /\(\?[a-z-]+[:)]/i;

function countModelPlaceholders(args) {
  if (!Array.isArray(args)) return 0;
  return args.reduce((sum, arg) => sum + (typeof arg === 'string' ? arg.split(MODEL_PLACEHOLDER).length - 1 : 0), 0);
}

/**
 * Пул моделей — агент с командой и полем `models`: участники — модели из вывода
 * `models.list`, чей полный id совпал с `models.match`; полный id участника
 * встаёт на место `{model}` в `args` (PLAN-004, «Запись пула в pipeline.yaml»,
 * проверки 2–9).
 */
function validateModelPool(agentId, agent, agents, errors) {
  const placeholders = countModelPlaceholders(agent.args);
  if (agent.models === undefined) {
    if (placeholders > 0) {
      errors.push(`Agent "${agentId}" has ${MODEL_PLACEHOLDER} in args but no models: only a model pool substitutes it`);
    }
    return;
  }
  if (!isPlainObject(agent.models)) {
    errors.push(`Agent "${agentId}" has invalid models: expected object with list and match`);
    return;
  }
  const { list, match, max_per_attempt: maxPerAttempt, selector, scores, gate } = agent.models;
  // `<пул>@<id модели>` — id участника: `@` в id пула сделал бы его неоднозначным.
  if (agentId.includes('@')) {
    errors.push(`Agent "${agentId}" is a model pool: its id must not contain "@" (reserved for pool members)`);
  }
  // Агент конфига с id `<пул>@…` занял бы место участника: раскрытие пула записало бы
  // участника поверх него (expandModelPools).
  for (const otherId of Object.keys(agents)) {
    if (otherId.startsWith(`${agentId}@`)) {
      errors.push(`Agent "${otherId}" has an id reserved for members of model pool "${agentId}" (<pool>@<model id>): rename the agent`);
    }
  }
  if (placeholders !== 1) {
    errors.push(`Agent "${agentId}" is a model pool: args must contain ${MODEL_PLACEHOLDER} exactly once, found ${placeholders}`);
  }
  if (!isNonEmptyStringArray(list)) {
    errors.push(`Agent "${agentId}" has invalid models.list: expected non-empty array of non-empty strings (command and its args)`);
  }
  if (!Array.isArray(match) || match.length === 0 || !match.every(item => typeof item === 'string')) {
    errors.push(`Agent "${agentId}" has invalid models.match: expected non-empty array of strings`);
  } else {
    // Без флагов, как шаблоны health: `(?i)` в JS не компилируется. Группа-модификатор
    // `(?i:…)` компилируется только на новых Node, а engines — >=18: запрет по записи, как
    // у шаблонов health (agent-health-rules-config.test.mjs), а не по компиляции здесь.
    for (const source of match) {
      if (INLINE_MODIFIER_RE.test(source)) {
        errors.push(`Agent "${agentId}" has invalid models.match expression ${JSON.stringify(source)}: inline modifier groups like (?i:…) are not supported (Node before 23 cannot compile them)`);
        continue;
      }
      try {
        new RegExp(source);
      } catch (err) {
        errors.push(`Agent "${agentId}" has invalid models.match expression ${JSON.stringify(source)}: ${err.message}`);
      }
    }
  }
  if (maxPerAttempt !== undefined && !(Number.isInteger(maxPerAttempt) && maxPerAttempt >= 1)) {
    errors.push(`Agent "${agentId}" has invalid models.max_per_attempt: must be an integer >= 1`);
  }
  if (selector !== undefined) {
    const problem = selectorProblem(selector, agents);
    if (problem) errors.push(`Agent "${agentId}" has invalid models.selector${problem}`);
  }
  if (scores !== undefined) {
    if (!isNonEmptyStringArray(scores)) {
      errors.push(`Agent "${agentId}" has invalid models.scores: expected non-empty array of non-empty strings (command and its args)`);
    }
    // Оценки читает только селектор: без него команда оценок — мёртвый конфиг.
    if (selector === undefined) {
      errors.push(`Agent "${agentId}" has models.scores without models.selector: scores are read only by the selector`);
    }
  }
  if (gate !== undefined && !isNonEmptyStringArray(gate)) {
    errors.push(`Agent "${agentId}" has invalid models.gate: expected non-empty array of non-empty strings (command and its args)`);
  }
}

/**
 * Проверка агента-селектора (`models.selector` пула и `selection.selector` стадии):
 * агент есть в pipeline.agents, у него команда (не kind: http) и он не пул. Нарушение —
 * хвост сообщения после имени поля, иначе null.
 */
function selectorProblem(selector, agents) {
  const target = typeof selector === 'string' && Object.hasOwn(agents, selector) ? agents[selector] : undefined;
  if (!isPlainObject(target)) return `: ${JSON.stringify(selector)} is not an agent in pipeline.agents`;
  if (target.kind === 'http') return ` "${selector}": selector must be an agent with a command, not kind: http`;
  if (target.models !== undefined) return ` "${selector}": selector must not be a model pool`;
  return null;
}

function validateAgentEntry(agentId, agent, errors, agents = {}) {
  if (!isPlainObject(agent)) {
    errors.push(`Agent "${agentId}" must be an object`);
    return;
  }
  const kind = agent.kind ?? 'cli';
  if (!AGENT_KINDS.includes(kind)) {
    errors.push(`Agent "${agentId}" has unknown kind: ${kind} (expected: ${AGENT_KINDS.join(', ')})`);
    return;
  }
  if (kind === 'cli') {
    if (typeof agent.command !== 'string' || agent.command.trim() === '') {
      errors.push(`Agent "${agentId}" missing required field: command`);
    }
    // Опечатка молча выключила бы проверку «ответ без единого вызова инструмента» (railsHost).
    if (agent.rails_host !== undefined && !['kilo', 'claude'].includes(agent.rails_host)) {
      errors.push(`Agent "${agentId}" has invalid rails_host: ${agent.rails_host} (expected: kilo, claude)`);
    }
    if (agent.prompt_stdin !== undefined && typeof agent.prompt_stdin !== 'boolean') {
      errors.push(`Agent "${agentId}" has invalid prompt_stdin: must be true or false`);
    }
    validateModelPool(agentId, agent, agents, errors);
    return;
  }

  // models — пул моделей: участник запускается командой, у `kind: http` её нет.
  for (const field of ['command', 'args', 'models']) {
    if (agent[field] !== undefined) {
      errors.push(`Agent "${agentId}" (kind: http) must not have field: ${field}`);
    }
  }
  for (const field of HTTP_AGENT_REQUIRED_FIELDS) {
    if (agent[field] === undefined || agent[field] === null || agent[field] === '') {
      errors.push(`Agent "${agentId}" (kind: http) missing required field: ${field}`);
    }
  }
  if (agent.protocol != null && agent.protocol !== '' && !HTTP_AGENT_PROTOCOLS.includes(agent.protocol)) {
    errors.push(`Agent "${agentId}" (kind: http) has invalid protocol: ${agent.protocol} (expected: ${HTTP_AGENT_PROTOCOLS.join(', ')})`);
  }
  if (agent.url != null && agent.url !== '') {
    // http — только своя машина (локальный сервер): ключ уходит в заголовке, и
    // опечатка в схеме отправила бы его открытым текстом. Та же проверка — в клиенте.
    try {
      assertModelUrl(agent.url);
    } catch {
      errors.push(`Agent "${agentId}" (kind: http) has invalid url: ${agent.url} (https://, or http:// only for localhost, 127.0.0.1, ::1)`);
    }
  }
  if (agent.model != null && agent.model !== '' && typeof agent.model !== 'string') {
    errors.push(`Agent "${agentId}" (kind: http) has invalid model: expected string`);
  }
  if (agent.auth != null && agent.auth !== '' && !isValidHttpAuth(agent.auth)) {
    errors.push(`Agent "${agentId}" (kind: http) has invalid auth: expected { env: <NAME> }, { file: <path> } or { kilo_oauth: true }`);
  }
  if (agent.timeout_s !== undefined
    && !(typeof agent.timeout_s === 'number' && Number.isFinite(agent.timeout_s) && agent.timeout_s > 0)) {
    errors.push(`Agent "${agentId}" (kind: http) has invalid timeout_s: must be a number > 0`);
  }
}

const CANONICAL_SCRIPT_PREFIX = '.workflow/src/';

/**
 * Скрипт model_io на диске. Путь `.workflow/src/…`, которого нет, ищется ещё и по
 * `src/…` от корня: в репозитории канона `.workflow/src/skills/<скил>` — ссылка на
 * установленную копию ~/.workflow/skills, где новых скриптов нет до релиза, а в CI
 * каталога `.workflow/` нет совсем (.gitignore). Запуск это не меняет: callModelAgent
 * берёт путь как записан.
 */
function modelIoScriptExists(projectRoot, script) {
  if (fs.existsSync(path.resolve(projectRoot, script))) return true;
  return script.startsWith(CANONICAL_SCRIPT_PREFIX)
    && fs.existsSync(path.resolve(projectRoot, 'src', script.slice(CANONICAL_SCRIPT_PREFIX.length)));
}

/** Обмен стадии с моделью: `model_io: { prepare, apply, options? }`, пути от корня проекта. */
function validateModelIo(stageId, modelIo, projectRoot, errors) {
  if (!isPlainObject(modelIo)) {
    errors.push(`Stage "${stageId}" has invalid model_io: expected object with prepare and apply`);
    return;
  }
  for (const step of ['prepare', 'apply']) {
    const script = modelIo[step];
    if (typeof script !== 'string' || script.trim() === '') {
      errors.push(`Stage "${stageId}" model_io missing required field: ${step}`);
    } else if (projectRoot && !modelIoScriptExists(projectRoot, script)) {
      errors.push(`Stage "${stageId}" model_io.${step} script not found: ${script}`);
    }
  }
  if (modelIo.options !== undefined && !isPlainObject(modelIo.options)) {
    errors.push(`Stage "${stageId}" model_io.options must be an object`);
  }
}

/**
 * Агент `kind: http` исполняет стадию только через обмен `model_io`: без него
 * раннер отдал бы безынструментной модели скил, который она выполнить не может.
 * Способности от этого не защищают: фильтр resolveAgent пропускает агента, у
 * которого есть все требуемые способности, а `[text]` есть почти у всех.
 */
function validateHttpAgentPlacement(pipeline, errors) {
  const httpAgents = new Set(
    Object.entries(pipeline.agents)
      .filter(([, agent]) => isPlainObject(agent) && agent.kind === 'http')
      .map(([id]) => id)
  );
  if (httpAgents.size === 0) return;

  const because = 'tool-less agents run only stages with model_io';
  if (httpAgents.has(pipeline.default_agent)) {
    errors.push(`pipeline.default_agent is tool-less agent "${pipeline.default_agent}" (kind: http): ${because}`);
  }
  for (const id of Array.isArray(pipeline.default_agents) ? pipeline.default_agents : []) {
    if (httpAgents.has(id)) {
      errors.push(`pipeline.default_agents contains tool-less agent "${id}" (kind: http): ${because}`);
    }
  }

  for (const [stageId, stage] of Object.entries(pipeline.stages)) {
    if (!isPlainObject(stage) || stage.model_io !== undefined) continue;
    const places = [];
    if (stage.agent) places.push(['agent', stage.agent]);
    for (const id of Array.isArray(stage.agents) ? stage.agents : []) places.push(['agents', id]);
    for (const [type, byType] of Object.entries(isPlainObject(stage.agents_by_type) ? stage.agents_by_type : {})) {
      for (const id of Array.isArray(byType?.agents) ? byType.agents : []) {
        places.push([`agents_by_type.${type}.agents`, id]);
      }
    }
    for (const [where, id] of places) {
      if (httpAgents.has(id)) {
        errors.push(`Stage "${stageId}" assigns tool-less agent "${id}" (kind: http) in ${where}, but has no model_io`);
      }
    }
  }
}

/**
 * Пул моделей — только место в списке агентов стадии (PLAN-004, проверки 10–11):
 * - одиночный `stage.agent` запускает запись агента напрямую, минуя выбор
 *   участника (`execute`, ветка `stage.agent && !stage.agents`) — `{model}` ушёл бы в команду;
 * - на стадии с `model_io` пул запрещён решением В9 плана. Списки такой стадии —
 *   `agents`, `agents_by_type.*.agents`, а без своего `agents` — ещё и
 *   `default_agents` (источники списка — `resolveAgent`).
 */
function validatePoolPlacement(pipeline, errors) {
  const pools = new Set(
    Object.entries(pipeline.agents)
      .filter(([, agent]) => isPlainObject(agent) && agent.models !== undefined)
      .map(([id]) => id)
  );
  if (pools.size === 0) return;

  for (const [stageId, stage] of Object.entries(pipeline.stages)) {
    if (!isPlainObject(stage)) continue;
    // Со списком agents одиночный stage.agent не запускается — условие как в execute.
    if (pools.has(stage.agent) && !stage.agents) {
      errors.push(`Stage "${stageId}" assigns model pool "${stage.agent}" as single agent: a pool can only be a place in an agents list`);
    }
    if (stage.model_io === undefined) continue;
    const places = [];
    for (const id of Array.isArray(stage.agents) ? stage.agents : []) places.push(['agents', id]);
    for (const [type, byType] of Object.entries(isPlainObject(stage.agents_by_type) ? stage.agents_by_type : {})) {
      for (const id of Array.isArray(byType?.agents) ? byType.agents : []) {
        places.push([`agents_by_type.${type}.agents`, id]);
      }
    }
    if (!Array.isArray(stage.agents) && !stage.agent) {
      for (const id of Array.isArray(pipeline.default_agents) ? pipeline.default_agents : []) {
        places.push(['pipeline.default_agents', id]);
      }
    }
    for (const [where, id] of places) {
      if (pools.has(id)) {
        errors.push(`Stage "${stageId}" has model_io, but lists model pool "${id}" in ${where}: model pools are not allowed on model_io stages`);
      }
    }
  }
}

const SELECTION_KEYS = Object.freeze(['selector', 'scores', 'escalate_on', 'levels']);
const SELECTION_ESCALATE_ON = Object.freeze(['blocked']);

/**
 * Выбор модели стадии `selection` (README, «Выбор модели стадии»):
 *  1. объект только с ключами SELECTION_KEYS;
 *  2. стадия исполнителя (`skill: execute-task`) без model_io и одиночного `agent`:
 *     выбор идёт по списку агентов исполнителя, а запреты и нижняя граница — по его
 *     журналу;
 *  3. `selector` — агент с командой, не пул (те же проверки, что у models.selector);
 *  4. `scores` — команда фактов, непустой массив непустых строк;
 *  5. `levels` — 2..10 непустых строк (рубрика сложности, от слабого к сильному);
 *  6. `escalate_on` — подмножество SELECTION_ESCALATE_ON без повторов;
 *  7. `agents_by_type.<тип>.selection` — только `false` и только у стадии с `selection`.
 * И мёртвый конфиг пула: `models.selector`/`models.scores` пула, все списки которого под
 * выбором модели, не вызывается никогда — селектор пула на такой стадии не зовут.
 */
function validateStageSelection(pipeline, errors) {
  const agents = pipeline.agents;
  // Списки стадий с признаком «под выбором» — для проверки мёртвого селектора пула.
  const listUses = [];
  for (const [stageId, stage] of Object.entries(pipeline.stages)) {
    if (!isPlainObject(stage)) continue;
    const selection = stage.selection;
    const byType = isPlainObject(stage.agents_by_type) ? stage.agents_by_type : {};
    for (const [type, entry] of Object.entries(byType)) {
      if (!isPlainObject(entry) || entry.selection === undefined) continue;
      if (entry.selection !== false) {
        errors.push(`Stage "${stageId}" has invalid agents_by_type.${type}.selection: only false (opt the type out of stage selection) is allowed`);
      } else if (selection === undefined) {
        errors.push(`Stage "${stageId}" has agents_by_type.${type}.selection: false, but the stage has no selection`);
      }
    }
    const governed = isPlainObject(selection);
    // Список стадии (без него — default_agents) служит типам без своего списка; тип с
    // `selection: false` без своего списка идёт по нему курсором.
    const optedOutOnDefault = Object.values(byType).some((e) => isPlainObject(e) && e.selection === false && !Array.isArray(e.agents));
    // Встроенные типы (update-counter, manual-gate) PipelineRunner выполняет без
    // StageExecutor: агента они не выбирают, и default_agents у них — не использование пула.
    const picksAgent = stage.type !== 'update-counter' && stage.type !== 'manual-gate';
    if (picksAgent && Array.isArray(stage.agents)) listUses.push({ list: stage.agents, governed: governed && !optedOutOnDefault });
    else if (picksAgent && !stage.agent && Array.isArray(pipeline.default_agents)) listUses.push({ list: pipeline.default_agents, governed: governed && !optedOutOnDefault });
    for (const entry of Object.values(byType)) {
      if (picksAgent && isPlainObject(entry) && Array.isArray(entry.agents)) listUses.push({ list: entry.agents, governed: governed && entry.selection !== false });
    }
    if (selection === undefined) continue;

    const where = `Stage "${stageId}"`;
    if (!governed) {
      errors.push(`${where} has invalid selection: expected object with selector, scores and levels`);
      continue;
    }
    for (const key of Object.keys(selection)) {
      if (!SELECTION_KEYS.includes(key)) errors.push(`${where} has unknown selection key: ${key} (expected: ${SELECTION_KEYS.join(', ')})`);
    }
    if (stage.skill !== EXECUTOR_SKILL) {
      errors.push(`${where} has selection, but skill is ${JSON.stringify(stage.skill ?? null)}: selection is only for the executor stage (skill: ${EXECUTOR_SKILL})`);
    }
    if (stage.model_io !== undefined) errors.push(`${where} has selection and model_io: selection picks CLI agents, not a model exchange`);
    if (stage.agent !== undefined) errors.push(`${where} has selection and a single agent: selection picks from an agents list`);
    if (selection.selector === undefined) {
      errors.push(`${where} selection missing required field: selector`);
    } else {
      const problem = selectorProblem(selection.selector, agents);
      if (problem) errors.push(`${where} has invalid selection.selector${problem}`);
    }
    if (selection.scores === undefined) {
      errors.push(`${where} selection missing required field: scores`);
    } else if (!isNonEmptyStringArray(selection.scores)) {
      errors.push(`${where} has invalid selection.scores: expected non-empty array of non-empty strings (command and its args)`);
    }
    const { levels } = selection;
    if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10
      || !levels.every((level) => typeof level === 'string' && level.trim() !== '')) {
      errors.push(`${where} has invalid selection.levels: expected 2..10 non-empty strings (task difficulty, weakest first)`);
    }
    const escalateOn = selection.escalate_on;
    if (escalateOn !== undefined && (!Array.isArray(escalateOn)
      || !escalateOn.every((item) => SELECTION_ESCALATE_ON.includes(item))
      || new Set(escalateOn).size !== escalateOn.length)) {
      errors.push(`${where} has invalid selection.escalate_on: expected a list of distinct values from [${SELECTION_ESCALATE_ON.join(', ')}]`);
    }
  }

  for (const [poolId, pool] of Object.entries(agents)) {
    if (!isPlainObject(pool) || !isPlainObject(pool.models)) continue;
    if (pool.models.selector === undefined && pool.models.scores === undefined) continue;
    const uses = listUses.filter(({ list }) => list.includes(poolId));
    if (uses.length > 0 && uses.every(({ governed }) => governed)) {
      errors.push(`Agent "${poolId}" has models.selector/models.scores that is never called: every stage listing pool ${poolId} uses selection (drop them from the pool)`);
    }
  }
}

function validateConfig(config, projectRoot = null) {
  const errors = [];

  if (!config) {
    errors.push('Config is empty');
    return errors;
  }

  if (!config.pipeline) {
    errors.push('Missing required field: pipeline');
    return errors;
  }

  const pipeline = config.pipeline;

  if (!pipeline.name || typeof pipeline.name !== 'string') {
    errors.push('Missing or invalid required field: pipeline.name (string)');
  }

  if (!pipeline.version || typeof pipeline.version !== 'string') {
    errors.push('Missing or invalid required field: pipeline.version (string)');
  }

  if (!pipeline.agents || typeof pipeline.agents !== 'object') {
    errors.push('Missing or invalid required field: pipeline.agents (object)');
  }

  if (!pipeline.stages || typeof pipeline.stages !== 'object') {
    errors.push('Missing or invalid required field: pipeline.stages (object)');
  }

  if (pipeline.agents && typeof pipeline.agents === 'object') {
    for (const [agentId, agent] of Object.entries(pipeline.agents)) {
      validateAgentEntry(agentId, agent, errors, pipeline.agents);
    }
  }

  if (pipeline.agents && pipeline.stages) {
    const agentIds = Object.keys(pipeline.agents);
    const stageIds = Object.keys(pipeline.stages);

    for (const [stageId, stage] of Object.entries(pipeline.stages)) {
      const resolvedAgent = stage.agent || pipeline.default_agent;
      if (resolvedAgent && !agentIds.includes(resolvedAgent)) {
        errors.push(`Stage "${stageId}" references non-existent agent: ${resolvedAgent}`);
      }

      if (stage.model_io !== undefined) {
        validateModelIo(stageId, stage.model_io, projectRoot, errors);
      }

      // Опечатка в значении молча оставила бы стадии плана чужой тикет (stageContext).
      if (stage.scope !== undefined && stage.scope !== 'plan') {
        errors.push(`Stage "${stageId}" has invalid scope: ${JSON.stringify(stage.scope)} (only "plan" is supported)`);
      }

      // Валидация для manual-gate стадии
      if (stage.type === 'manual-gate') {
        if (!stage.goto || !stage.goto.approved) {
          errors.push(`Stage "${stageId}" has type manual-gate but missing required goto.approved`);
        }
        if (!stage.goto || !stage.goto.rejected) {
          errors.push(`Stage "${stageId}" has type manual-gate but missing required goto.rejected`);
        }
        if (stage.poll_interval_ms !== undefined && (typeof stage.poll_interval_ms !== 'number' || stage.poll_interval_ms < 100)) {
          errors.push(`Stage "${stageId}" has invalid poll_interval_ms: must be a number >= 100`);
        }
        if (stage.timeout_seconds !== undefined && (typeof stage.timeout_seconds !== 'number' || stage.timeout_seconds <= 0)) {
          errors.push(`Stage "${stageId}" has invalid timeout_seconds: must be a number > 0`);
        }
      }

      if (stage.goto) {
        for (const [status, transition] of Object.entries(stage.goto)) {
          if (status === 'default') continue;
          if (transition.stage && transition.stage !== 'end' && !stageIds.includes(transition.stage)) {
            errors.push(`Stage "${stageId}" goto.${status} references non-existent stage: ${transition.stage}`);
          }
        }
      }
    }

    validateHttpAgentPlacement(pipeline, errors);
    validatePoolPlacement(pipeline, errors);
    validateStageSelection(pipeline, errors);
  }

  return errors;
}

async function runPipeline(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) {
    throw new TypeError(
      `runPipeline expects an argv array (e.g. ['--project', root]), got ${typeof argv}. ` +
      'Passing an options object silently falls back to process.cwd() as project root.'
    );
  }

  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return { exitCode: 0, help: true };
  }

  // Resolve config path and projectRoot
  if (!args.config) {
    const projectRoot = args.project ? path.resolve(args.project) : findProjectRoot();
    args.config = path.resolve(projectRoot, '.workflow/config/pipeline.yaml');
    args.projectRoot = projectRoot;
  }

  const projectRoot = args.projectRoot || (args.project ? path.resolve(args.project) : findProjectRoot());

  console.log('=== Workflow Runner ===');
  console.log(`Config: ${args.config}`);
  if (args.plan) console.log(`Plan: ${args.plan}`);
  if (args.project) console.log(`Project: ${args.project}`);
  console.log('');

  // Singleton: живой маркер блокирует запуск, протухший — снимается
  const existingMarker = readMarker(projectRoot);
  if (existingMarker) {
    if (processAlive(existingMarker.pid)) {
      const runningSince = markerStartedAt(projectRoot, existingMarker);
      console.error(
        `[runner] pipeline already running for ${projectRoot} ` +
        `(pid ${existingMarker.pid}, started ${runningSince})`
      );
      return {
        ok: false,
        exitCode: 1,
        code: 'PIPELINE_ALREADY_RUNNING',
        pid: existingMarker.pid,
        started_at: runningSince,
        project_root: projectRoot
      };
    }
    console.warn(`[runner] stale marker found (pid ${existingMarker.pid} not alive) — removing`);
    removeMarker(projectRoot);
  }

  // Конфиг читается ДО записи lock'а (но ПОСЛЕ проверки занятости — иначе
  // ошибка конфига маскировала бы ответ «уже запущен»). Так путь к логу известен
  // заранее и весь payload пишется одной атомарной записью: дозапись вторым
  // вызовом означала бы `rename` поверх файла, который в этот момент уже читают
  // наблюдатели, а на Windows это EPERM — и run_id не появился бы до конца
  // запуска. Побочных эффектов у загрузки конфига нет, а битый конфиг больше не
  // создаёт lock, который тут же снимается.
  let config;
  try {
    config = loadConfig(args.config);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    return { exitCode: 1, error: err.message, stack: err.stack };
  }

  const configErrors = validateConfig(config, projectRoot);
  if (configErrors.length > 0) {
    console.error('Configuration validation failed:');
    configErrors.forEach(err => console.error(`  - ${err}`));
    return { exitCode: 1, error: 'Configuration validation failed', details: configErrors };
  }

  console.log(`Pipeline: ${config.pipeline.name} v${config.pipeline.version}`);
  console.log(`Agents: ${Object.keys(config.pipeline.agents).join(', ')}`);
  console.log(`Stages: ${Object.keys(config.pipeline.stages).join(', ')}`);
  console.log('');
  console.log('Configuration validated successfully!');

  // Write marker to protect against stale processes
  const startedAt = new Date().toISOString();
  const runId = PipelineRunner.buildRunId(startedAt);
  const logFilePath = PipelineRunner.resolveLogFilePath(config.pipeline, projectRoot, runId);

  // Считывается до записи lock'а: обе функции снимают свою переменную из
  // окружения, и порядок полей в литерале не должен на это влиять.
  const startedByIdValue = startedById();

  // Файл лога создаётся до lock'а: маркер виден наблюдателям с момента link, и
  // pipeline_log в нём обязан вести к существующему файлу. Раньше файл создавал
  // Logger уже после записи маркера — читатель, успевший между ними, лога не
  // находил, а если раннер в это окно убивали, файл не появлялся вовсе (задержка
  // после link воспроизводит падение теста «run_id matches the log file name» на
  // CI Windows под c8 с тем же сообщением). Флаг 'a'
  // не трогает уже существующий файл. Если lock не возьмётся, пустой файл
  // остаётся: при совпавшем run_id (точность — секунда) это лог победившего
  // запуска, и удалять его нельзя.
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.closeSync(fs.openSync(logFilePath, 'a'));
  } catch (err) {
    console.error(`[runner] failed to create log file: ${err.message}`);
    return { exitCode: 1, error: 'Failed to create pipeline log', details: err.message };
  }

  try {
    writeMarker(projectRoot, {
      pid: process.pid,
      started_at: startedAt,
      timestamp: startedAt,
      // Кто запустил раннер. Определяет запускающая сторона: CLI ничего не
      // ставит, MCP-сервер и VS Code расширение передают env при spawn.
      started_by: startedBy(),
      // Какой именно экземпляр запустил. Поля нет, если запускающий не
      // представился, — отсутствие и «неизвестно» тут одно и то же.
      ...(startedByIdValue !== null ? { started_by_id: startedByIdValue } : {}),
      project_root: projectRoot,
      pipeline_version: pipelineVersion(),
      // Что умеет этот раннер. По полю расширение решает, предлагать ли паузу:
      // старый раннер запрос паузы молча проигнорировал бы.
      capabilities: [...RUNNER_CAPABILITIES],
      run_id: runId,
      pipeline_log: path.relative(projectRoot, logFilePath).split(path.sep).join('/')
    });
  } catch (err) {
    console.error(`[runner] failed to write marker: ${err.message}`);
    return { exitCode: 1, error: 'Failed to acquire pipeline lock', details: err.message };
  }

  // Сигналы остановки. Первый SIGINT / SIGTERM при работающем раннере из процесса
  // не выходит: его отрабатывает обработчик раннера (setupGracefulShutdown) —
  // running = false и killCurrentChild, стадия проходит ветку остановки (событие run
  // со статусом aborted, снятие записи открытого запуска), цикл выходит, finally
  // снимает маркер, процесс выходит с кодом 130. Прежде этот обработчик выходил
  // process.exit(130) сразу: он зарегистрирован раньше обработчика раннера, и ветки
  // остановки не исполнялись, а агент оставался работать без раннера (запуски
  // 2026-09-27, PLAN-003). Одной перестановки мало: слушатель с process.exit на том же
  // сигнале вывел бы процесс в том же emit, до закрытия агента.
  // Повторный сигнал во время мягкой остановки (эскалация MCP abort_pipeline, второй
  // Ctrl+C) — жёсткое снятие агента и выход 130 без ожидания.
  // Имя сигнала задаётся здесь, а не берётся из аргумента слушателя: `process.emit`
  // вызывает слушателей без аргумента.
  let runner = null;
  let stopSignal = null;

  // Смерть раннера без упорядоченного выхода — последней строкой в логе прогона, синхронно
  // (appendFileSync логгера): необработанное исключение или отказ промиса, повторный
  // сигнал во время мягкой остановки, process.exit и опустевший цикл событий до конца
  // runPipeline. Запуск агента, открытый в этот момент, закрывается событием `run` со
  // статусом `aborted` и `interrupted: true` сразу (closeInterruptedRun), а не следующим
  // стартом с временем этого старта. Прежде такой раннер не оставлял в логе ни строки, а
  // stderr раннера, запущенного из workflow-mcp, уходит в 'ignore': 2026-09-30 падение,
  // жёсткое снятие и потерю родителя по следам различить было нельзя (PulseProxy
  // 18-55-50, ListeningGlass 18-53-24 и 08-25-19). Снятие без обработчика (`taskkill /F`,
  // SIGKILL) строки по-прежнему не оставляет — теперь его и отличает её отсутствие.
  // Lock при падении не снимается: пока процесса нет, а lock лежит, workflow-mcp
  // показывает прогон `stale`, а детектор crashed (мёртвый pid при свежем логе) видит
  // строку падения как свежую запись; снимает lock следующий старт, как прежде.
  let finished = false;
  let deathLogged = false;
  let deathLogger = null;
  const writeDeath = (message) => {
    deathLogged = true;
    try {
      deathLogger ??= runner?.logger ?? new Logger(logFilePath);
      deathLogger.error(message, 'PipelineRunner');
    } catch {}
  };
  const atStage = () => (runner?.currentStage ? ` stage="${runner.currentStage}"` : '');
  const closeOpenRun = () => {
    try {
      if (runner) runner.closeInterruptedAgentRun();
      else closeInterruptedRun(projectRoot);
    } catch {}
  };
  const describeFailure = (value) => {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); }
  };
  // Поведение Node по умолчанию сохраняется: необработанное исключение и отказ промиса
  // завершают процесс с кодом 1. Строка пишется до снятия агента: taskkill ждёт, а причина
  // должна остаться в логе, даже если процесс снимут в эту минуту.
  const onFatal = (reason) => (value) => {
    writeDeath(`RUNNER CRASH reason=${reason} exit_code=1${atStage()} — ${describeFailure(value)}`);
    try { runner?.forceStop(); } catch {}
    closeOpenRun();
    process.exit(1);
  };
  const onUncaughtException = onFatal('uncaughtException');
  const onUnhandledRejection = onFatal('unhandledRejection');
  // На 'exit' допустим только синхронный код: снятие агента (taskkill / SIGKILL) и запись
  // журнала синхронные. Без снятия агент, записанный прерванным, работал бы дальше.
  const onExit = (code) => {
    if (finished) return;
    if (!deathLogged) writeDeath(`RUNNER EXIT exit_code=${code}${atStage()} — process exited before the pipeline finished`);
    try { runner?.forceStop(); } catch {}
    closeOpenRun();
  };

  const onSignal = (signal) => {
    if (runner && !stopSignal) {
      stopSignal = signal;
      return;
    }
    writeDeath(`RUNNER STOP signal=${signal} forced exit_code=130${atStage()} — second stop signal during graceful shutdown`);
    runner?.forceStop();
    try { removeMarker(projectRoot); } catch {}
    process.exit(130); // 128 + SIGINT(2) — standard exit code for signal-terminated
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  // SIGBREAK — Ctrl+Break в консоли Windows: та же мягкая остановка, что у SIGINT / SIGTERM.
  // Доставку настоящего Ctrl+Break не проверяли: Node его не генерирует (тест — process.emit).
  const onSigbreak = () => onSignal('SIGBREAK');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGBREAK', onSigbreak);
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('exit', onExit);

  try {
    // Запускаем пайплайн. run_id и путь к логу уже записаны в маркер — раннер
    // получает ровно их, чтобы имя файла и lock не разъехались. Раннер держит lock
    // и закрывает запись открытого запуска, оставленную прерванным раннером.
    runner = new PipelineRunner(config, args, { runId, logFilePath, startedAt, closeOpenRunOnStart: true });
    const result = await runner.run();

    console.log('\n=== Summary ===');
    console.log(`Steps executed: ${result.steps}`);
    console.log(`Tasks completed: ${result.tasksExecuted}`);

    return { exitCode: result.failed ? 1 : 0, result };

  } catch (err) {
    console.error(`\nError: ${err.message}`);
    console.error(err.stack);
    // Та же причина — в лог прогона: stderr раннера из workflow-mcp не сохраняется.
    writeDeath(`RUNNER ERROR exit_code=1${atStage()} — ${describeFailure(err)}`);
    closeOpenRun();

    // Даём файлу логов время записаться перед выходом
    await new Promise(resolve => setTimeout(resolve, 100));

    return { exitCode: 1, error: err.message, stack: err.stack };
  } finally {
    finished = true;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('SIGBREAK', onSigbreak);
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('exit', onExit);
    runner?.disposeSignalHandlers();
    // Ensure marker is cleaned up on normal exit
    try {
      removeMarker(projectRoot);
    } catch (err) {
      // ENOENT is expected, log warnings for other errors
      if (err.code && err.code !== 'ENOENT') {
        console.warn(`[runner] cleanup warning: ${err.message}`);
      }
    }
    // Остановлен сигналом: код 130 задаётся явно — код возврата runPipeline в код
    // процесса не передаётся (bin/workflow.mjs).
    if (stopSignal) process.exit(130);
  }
}

// Export for use as ES module
export { runPipeline, parseArgs, validateConfig, PipelineRunner, FileGuard, StageExecutor };
export default { runPipeline, parseArgs, validateConfig, PipelineRunner, FileGuard, StageExecutor };

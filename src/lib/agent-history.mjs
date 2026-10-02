import fs from 'node:fs';
import { replaceFileAtomicSync } from './utils.mjs';

const HISTORY_HEADER_4COL = '| Дата/время | Скил | Агент | Статус |';
const HISTORY_SEP_4COL = '|------------|------|-------|--------|';
// Пятая колонка появляется в таблице с первой строкой, у которой есть изменённые файлы
// (запуск со сбоем, runner.mjs _auditAgentRun). Строки без файлов остаются в четыре
// ячейки: недостающую ячейку таблица Markdown показывает пустой, а статус остаётся в
// своей ячейке — его читают по имени колонки (calc-metrics.js скила create-report) и по
// значению (шаг P1S2 скила execute-task: error, timeout, network_error).
const HISTORY_HEADER_5COL = '| Дата/время | Скил | Агент | Статус | Изменённые файлы |';
const HISTORY_SEP_5COL = '|------------|------|-------|--------|------------------|';

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

// Ячейка «Изменённые файлы»: пути в обратных кавычках через запятую; путей больше, чем
// передано (`files_total`), — хвост «… ещё N».
function filesCell(files, total) {
  const listed = files.map((file) => `\`${file}\``).join(', ');
  const rest = Number.isInteger(total) && total > files.length ? total - files.length : 0;
  return rest > 0 ? `${listed}, … ещё ${rest}` : listed;
}

/**
 * Строка запуска агента в «## История работы» тикета. `entry` — `timestamp`, `skill`,
 * `agent`, `status` и необязательные `files` (изменённые файлы запуска, пути от корня
 * проекта) с `files_total` (их полное число, если `files` — только начало списка).
 */
export function appendAgentRun(ticketPath, entry) {
  if (!ticketPath || !entry) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const { timestamp, skill, agent, status } = entry;
  if (!timestamp || !skill || !agent || !status) {
    return { ok: false, code: 'INVALID_ENTRY' };
  }
  const files = Array.isArray(entry.files) ? entry.files.filter((file) => typeof file === 'string' && file) : [];
  const withFiles = files.length > 0;
  const header = withFiles ? HISTORY_HEADER_5COL : HISTORY_HEADER_4COL;
  const separator = withFiles ? HISTORY_SEP_5COL : HISTORY_SEP_4COL;

  let content;
  try {
    content = fs.readFileSync(ticketPath, 'utf8');
  } catch (err) {
    return { ok: false, code: 'READ_ERROR', error: err.message };
  }

  const rowCells = [timestamp, skill, agent, status, ...(withFiles ? [filesCell(files, entry.files_total)] : [])];
  const newRow = `| ${rowCells.map(escapeCell).join(' | ')} |`;
  const sectionRegex = /(^|\n)## История работы\s*\n([\s\S]*?)(?=\n## |\n*$)/;
  const match = content.match(sectionRegex);

  let updated;
  if (!match) {
    // No section — append new section at end of file
    const trailing = content.endsWith('\n') ? '' : '\n';
    updated = `${content}${trailing}\n## История работы\n\n${header}\n${separator}\n${newRow}\n`;
  } else {
    const sectionBody = match[2];
    const lines = sectionBody.split('\n');
    // Find header line (starts with `|` and contains text)
    const headerIdx = lines.findIndex(l => /^\s*\|.*\|/.test(l) && !/^\s*\|[\s\-|]+\|\s*$/.test(l));
    if (headerIdx === -1) {
      // Section exists but no table — create table fresh
      updated = content.replace(sectionRegex, `$1## История работы\n\n${header}\n${separator}\n${newRow}\n`);
    } else {
      const headerLine = lines[headerIdx];
      const headerCols = headerLine.split('|').filter(c => c.trim() !== '').length;
      const sepIdx = headerIdx + 1;
      let needMigration = headerCols === 3;

      if (needMigration) {
        // Migrate header
        lines[headerIdx] = HISTORY_HEADER_4COL;
        if (sepIdx < lines.length && /^\s*\|[\s\-|]+\|\s*$/.test(lines[sepIdx])) {
          lines[sepIdx] = HISTORY_SEP_4COL;
        }
        // Migrate data rows: append unknown
        for (let i = sepIdx + 1; i < lines.length; i++) {
          const ln = lines[i];
          if (!ln.trim()) break;
          if (!/^\s*\|/.test(ln)) break;
          const cells = ln.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim());
          if (cells.length === 3) {
            lines[i] = `| ${cells[0]} | ${cells[1]} | ${cells[2]} | unknown |`;
          }
        }
      }

      // Первая строка с изменёнными файлами — заголовок в пять колонок. Заголовок другой
      // ширины (не три и не четыре колонки) не трогается.
      if (withFiles && (needMigration || headerCols === 4)) {
        lines[headerIdx] = HISTORY_HEADER_5COL;
        if (sepIdx < lines.length && /^\s*\|[\s\-|]+\|\s*$/.test(lines[sepIdx])) {
          lines[sepIdx] = HISTORY_SEP_5COL;
        }
      }

      // Find end of table (last `|...|` line in section)
      let lastTableIdx = headerIdx;
      for (let i = sepIdx + 1; i < lines.length; i++) {
        if (/^\s*\|/.test(lines[i])) {
          lastTableIdx = i;
        } else if (lines[i].trim() === '') {
          continue;
        } else {
          break;
        }
      }
      lines.splice(lastTableIdx + 1, 0, newRow);

      const newSection = lines.join('\n');
      updated = content.replace(sectionRegex, `$1## История работы\n${newSection}`);
    }
  }

  // Публикация — общим помощником, а не своим temp + rename: своя версия на NTFS
  // падала EPERM, как только тикет держал открытым любой другой читатель (скан доски,
  // MCP get_ticket), — rename поверх открытого файла там запрещён, а повторов не было.
  // Проверено запуском 2026-09-24: при открытом дескрипторе чтения возвращался
  // WRITE_ERROR, строка истории терялась, а раннер (src/runner.mjs, audit-log)
  // только писал предупреждение в лог — журнал запусков агентов молча становился
  // неполным. Тот же дефект закрыт в appendReviewEntry (src/lib/review-section.mjs).
  try {
    replaceFileAtomicSync(ticketPath, updated);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'WRITE_ERROR', error: err.message };
  }
}

export function parseAgentHistory(content) {
  const sectionMatch = content.match(/## История работы[\s\S]*?\n\s*\|.*\|.*\|.*\|.*\n([\s\S]*?)(?=\n\s*\|\s*-{3,}|$)/);
  if (!sectionMatch) return [];
  const rows = sectionMatch[1].trim().split(/\n/).filter(r => r.trim() && !/^\s*\|[\s\-|]+\|\s*$/.test(r));
  const result = [];
  rows.forEach(row => {
    const cells = row.split(/(?<!\\)\|/).map(c => c.trim()).filter(c => c !== '').map(c => c.replace(/\\\|/g, '|'));
    if (cells.length === 3) {
      cells.push('unknown');
    }
    if (cells.length !== 4 && cells.length !== 5) {
      console.warn('Invalid row: ' + row);
      return;
    }
    const run = { timestamp: cells[0], skill: cells[1], agent: cells[2], status: cells[3] };
    // Пятая ячейка — изменённые файлы запуска со сбоем (appendAgentRun), как записаны.
    if (cells.length === 5) run.files = cells[4];
    result.push(run);
  });
  return result;
}

/**
 * Тикет уже брал исполнитель: в «Истории работы» есть строка скила execute-task (раннер
 * пишет её после каждого запуска исполнителя, _auditAgentRun). По ней гейт dod_format: 2
 * (dodStartProblems) отличает новый тикет от вернувшегося в backlog/ после работы.
 */
export function hasExecuteTaskRun(content) {
  const section = String(content ?? '').match(/(^|\n)## История работы\s*\n([\s\S]*?)(?=\n## |$)/);
  return Boolean(section) && /^\|[^|\n]*\|\s*execute-task\s*\|/m.test(section[2]);
}

/**
 * Ограничение провайдера, на котором закончился запуск: текст лимита (rate limit,
 * quota exceeded, too many requests — в обычных записях регистра) или код 429 после
 * `status`, `code`, `error`, `HTTP` — в одной из трёх последних строк stderr (пустые
 * строки в конце не считаются). Середина stderr не смотрится: kilo пишет туда вывод
 * инструментов (дифф тикета со строкой истории `rate_limit`, `ls`, стек `file:429:17`)
 * и каждый 429, после которого сам повторил запрос и продолжил работу. Три строки —
 * итог kilo: «stream error», «message=process» и «Error: …» последней попытки;
 * многострочный текст квоты Gemini (с «Please retry in …» в конце) в них умещается.
 *
 * Выражение — без флагов и без встроенных модификаторов: тот же текст стоит в
 * `pattern` общего правила health `provider-rate-limit` (configs/agent-health-rules.yaml,
 * совпадение проверяет agent-health-rules-config.test.mjs), а этот файл читают и
 * раннеры прежних версий из общей папки конфигов — запись вне синтаксиса JS Node 18
 * (например `(?i)`) их конструктор StageExecutor обрывал бы на каждой стадии.
 */
export const PROVIDER_RATE_LIMIT_PATTERN = /(?:[Rr]ate.?[Ll]imit|RATE.?LIMIT|[Qq]uota.?[Ee]xceeded|QUOTA.?EXCEEDED|[Tt]oo [Mm]any [Rr]equests|TOO MANY REQUESTS|(?:[Ss]tatus|[Cc]ode|[Ee]rror|HTTP(?:\/[\d.]+)?)["']?[ :=]*429\b(?!:\d))[^\n]*(?:\n[^\n]*){0,2}\s*$/;

export function classifyAgentResult({ exitCode, stderr, stdout, timedOut, signal, parsedResult, agentType }) {
  if (timedOut === true) {
    return 'timeout';
  }
  if (signal === 'SIGTERM' || signal === 'SIGKILL' || [130,137,143].includes(exitCode)) {
    return 'aborted';
  }
  if (parsedResult?.status === 'blocked') {
    return 'blocked';
  }
  if (parsedResult?.status === 'irrelevant') {
    return 'skipped_relevance';
  }
  // Запуск закончился на ограничении провайдера (PROVIDER_RATE_LIMIT_PATTERN): журнал
  // запусков даёт статусу `rate_limit` градацию `throttled` без запрета модели.
  if (PROVIDER_RATE_LIMIT_PATTERN.test(stderr)) {
    return 'rate_limit';
  }
  if (/ECONNREFUSED|ENETUNREACH|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|network/i.test(stderr)) {
    return 'network_error';
  }
  // Без «permission denied»: это не отказ провайдера, а файловая ошибка или текст скила
  // execute-task, который рельсы печатают в stderr. 2026-09-25 PulseProxy: gpt-luna
  // выполнил IMPL-107 и получил в истории auth_error. Настоящий отказ kilo — 403.
  if (/\b401\b|\b403\b|invalid api key|unauthor/i.test(stderr)) {
    return 'auth_error';
  }
  if (exitCode === 0 && agentType === 'ai' && (stdout.trim().length === 0 || !parsedResult)) {
    return 'empty_response';
  }
  if (exitCode === 0) {
    return 'ok';
  }
  return 'error';
}

#!/usr/bin/env node

/**
 * verify-artifacts.js — механическая предпроверка тикета перед AI-ревью.
 *
 * Парсит тикет и проверяет:
 * - Существование файлов из секции "Изменённые файлы"
 * - DoD completion %
 * - Заполненность секции Result (Summary)
 *
 * Использование (как стейдж пайплайна):
 *   node verify-artifacts.js "<prompt>"
 *   Парсит ticket_id из Context-блока в промпте, резолвит в .workflow/tickets/review/{id}.md
 *
 * Использование (как standalone-скрипт):
 *   node verify-artifacts.js <path-to-ticket>
 *   node verify-artifacts.js <TICKET-ID>
 *
 * Вывод (для runner'а):
 *   ---RESULT---
 *   status: passed|failed
 *   dod_completion_pct: <int>
 *   result_filled: <bool>
 *   missing_files: <comma-separated list or empty>
 *   warnings: <предупреждения через "; "; строка печатается только при наличии>
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const REVIEW_STATUSES = ['review', 'in-progress', 'done', 'ready', 'backlog'];

function parseChangedFiles(body) {
  const files = [];
  const changedFilesRegex = /^###\s*(?:Изменённые файлы|Changed files)\s*$/gm;
  const match = changedFilesRegex.exec(body);

  if (!match) return files;

  // Граница H3-секции — следующий H3 ИЛИ H2 (что встретится раньше),
  // иначе захватываем соседние подзаголовки вроде "### Время выполнения",
  // где в backticks лежат команды и цитаты, которые парсер принимает за пути.
  const startIdx = match.index + match[0].length;
  const nextH3 = body.indexOf('\n### ', startIdx);
  const nextH2 = body.indexOf('\n## ', startIdx);
  const candidates = [nextH3, nextH2].filter((i) => i !== -1);
  const sectionEnd = candidates.length > 0 ? Math.min(...candidates) : body.length;
  const sectionContent = body.substring(startIdx, sectionEnd);

  // Пути принимаем только из строк-буллетов ("- `path`" или "* `path`"):
  // это страхует от ложных срабатываний на цитатах/командах в инлайн-коде.
  const bulletFileRegex = /^[-*]\s+`([^`]+)`/gm;
  let fileMatch;
  while ((fileMatch = bulletFileRegex.exec(sectionContent)) !== null) {
    files.push(stripLineSuffix(fileMatch[1]));
  }

  return files;
}

// Поддержка отраслевой нотации ссылок на код: `path:line`, `path:start-end`.
// Суффикс указывает на строки в файле, но не является частью имени файла —
// отрезаем его перед проверкой существования на диске. Не трогаем `C:\...` на
// Windows (после двоеточия идёт не число, а разделитель пути).
function stripLineSuffix(filePath) {
  const match = filePath.match(/^(.*?):(\d+)(?:-\d+)?$/);
  return match ? match[1] : filePath;
}

// Допуск на рассинхрон часов между машиной, где создавался тикет, и машиной,
// где идёт verify. Метка в пределах допуска считается валидной.
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * Выбирает точку отсчёта для проверки file_unchanged и валидирует её.
 *
 * FIX-68: LLM-агенты регулярно пишут во frontmatter ЛОКАЛЬНОЕ время с суффиксом Z
 * (тикет реально создан в 17:31Z, а в created_at лежит "2026-08-04T22:30:00.000Z").
 * Метка «из будущего» делает unchanged=true для ЛЮБОГО свежего артефакта — verify
 * фейлится, и никакой touch не помогает. Поэтому:
 *   - created_at в будущем → метка битая, пробуем updated_at;
 *   - updated_at тоже в будущем (или отсутствует) → проверку unchanged НЕ применяем
 *     вовсе (пропускаем, а не фейлим — ложный fail хуже пропущенной проверки).
 *
 * @returns {{baseline: string|Date|null, source: string|null, warnings: string[]}}
 */
function resolveWorkStartBaseline(frontmatter, nowMs = Date.now()) {
  const warnings = [];
  const cutoffMs = nowMs + CLOCK_SKEW_TOLERANCE_MS;
  const skip = { baseline: null, source: null, warnings };

  for (const field of ['created_at', 'updated_at']) {
    const raw = frontmatter[field];
    if (!raw) continue;

    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) {
      // Битый формат — сравнивать не с чем. Раньше такая метка молча давала
      // unchanged=false; сохраняем поведение, но теперь с предупреждением.
      warnings.push(`${field}="${raw}" не парсится как дата — проверка file_unchanged пропущена`);
      return skip;
    }

    if (ms <= cutoffMs) {
      return { baseline: raw, source: field, warnings };
    }

    warnings.push(
      `${field}="${raw}" в будущем (вероятно, локальное время записано с суффиксом Z) — метка не используется`
    );
  }

  if (warnings.length > 0) {
    warnings.push('проверка file_unchanged пропущена: нет корректной точки отсчёта');
  }
  return skip;
}

function checkFilesExist(filePaths, workStartTime) {
  const ticketWorkStart = workStartTime ? new Date(workStartTime) : null;
  return filePaths.map(filePath => {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_DIR, filePath);
    const exists = fs.existsSync(fullPath);

    if (!exists) {
      return { path: filePath, exists: false, unchanged: false };
    }

    if (!ticketWorkStart) {
      return { path: filePath, exists: true, unchanged: false };
    }

    const stats = fs.statSync(fullPath);
    const fileMtime = new Date(stats.mtime);
    const unchanged = fileMtime < ticketWorkStart;

    return { path: filePath, exists: true, unchanged };
  });
}

function parseDoDCompletion(body) {
  // Канонический формат в этом проекте — "## Критерии готовности (Definition of Done)",
  // но поддерживаем и чистые варианты (обе локали, с/без уточнения в скобках).
  const dodSectionRegex = /^##\s*(?:Критерии готовности|Definition of Done)(?:\s*\([^)]*\))?\s*$/gm;
  const match = dodSectionRegex.exec(body);
  
  if (!match) return { checked: 0, completed: 0, percentage: 0 };
  
  const startIdx = match.index + match[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  const sectionEnd = nextH2 === -1 ? body.length : nextH2;
  const sectionContent = body.substring(startIdx, sectionEnd);
  
  const checkedBoxes = (sectionContent.match(/\[x\]/gi) || []).length;
  const totalBoxes = (sectionContent.match(/\[ \]|\[x\]/gi) || []).length;
  
  const percentage = totalBoxes > 0 ? Math.round((checkedBoxes / totalBoxes) * 100) : 0;
  
  return {
    checked: totalBoxes,
    completed: checkedBoxes,
    percentage
  };
}

function checkResultSection(body) {
  // Порядок альтернатив важен: «Результат выполнения» перед «Результат»,
  // чтобы более длинный вариант матчился первым.
  const resultSectionRegex = /^##\s*(Результат выполнения|Результат|Result)\s*$/m;
  const sectionMatch = resultSectionRegex.exec(body);

  if (!sectionMatch) return { exists: false, summaryFilled: false };

  const startIdx = sectionMatch.index + sectionMatch[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  const sectionEnd = nextH2 === -1 ? body.length : nextH2;
  const sectionContent = body.substring(startIdx, sectionEnd);

  // Сначала пытаемся найти явную подсекцию Summary
  const summaryRegex = /^###\s*(Summary|Что сделано)\s*$/m;
  const summaryMatch = summaryRegex.exec(sectionContent);

  let summaryContent;
  if (summaryMatch) {
    // Есть явная подсекция — берём контент только из неё
    const summaryStartIdx = summaryMatch.index + summaryMatch[0].length;
    const nextSubsection = sectionContent.indexOf('\n### ', summaryStartIdx);
    const summaryEnd = nextSubsection === -1 ? sectionContent.length : nextSubsection;
    summaryContent = sectionContent.substring(summaryStartIdx, summaryEnd);
  } else {
    // Нет явной Summary — проверяем, есть ли вообще контент в секции Result
    // (любые подсекции, таблицы, текст считаются заполненной секцией)
    summaryContent = sectionContent;
  }

  const withoutComments = summaryContent.replace(/<!--[\s\S]*?-->/g, '').trim();
  const hasContent = withoutComments.length > 0;

  return {
    exists: true,
    summaryFilled: hasContent
  };
}

// ===========================================================================
// D4: Source-grounding gate
// Проверяет, что DoD-пункты с UI/контракт-требованиями подкреплены
// ссылками на source-of-truth в секции Result.
// Инцидент-основание: QA-54/HUMAN-4 (workflowAiVsCode, 2026-05-02..03) —
// review-result принял сфабрикованные UI-assertions без сверки с package.json.
// ===========================================================================

// Ключевые слова, сигнализирующие что DoD-пункт требует верификации UI-элемента
// или контрактного артефакта (команды, меню, конфиг-ключи, визуальный элемент).
const SOURCE_GROUNDING_DOD_INDICATORS = [
  /\bUI\b/,
  /visual/i,
  /screenshot/i,
  /snapshot/i,
  /baseline/i,
  /контракт/i,
  /кнопк/i,
  /меню/i,
  /элемент/i,
  /команд/i,
  /package\.json/i,
  /contributes\./i,
  /source.of.truth/i,
  /source_of_truth/i,
  /декларативн/i,
];

// Паттерн ссылки на конкретный файл с номером строки: file.ext:NNN или path/file.ext:NNN.
// Исключаем Windows-пути вида C:\ (после двоеточия не цифра).
const SOURCE_REF_FILE_LINE = /[\w][\w/\\.-]+\.\w{1,10}:\d+/;

/**
 * D4 gate: если выполненные DoD-пункты содержат UI/контракт-индикаторы,
 * проверяет наличие source-ссылок в Result (file:line или ключевые артефакты).
 *
 * @returns {{ required: boolean, satisfied: boolean }}
 */
function checkSourceGrounding(body) {
  // Извлекаем DoD секцию
  const dodSectionRegex = /^##\s*(?:Критерии готовности|Definition of Done)(?:\s*\([^)]*\))?\s*$/gm;
  const dodMatch = dodSectionRegex.exec(body);
  if (!dodMatch) return { required: false, satisfied: true };

  const dodStart = dodMatch.index + dodMatch[0].length;
  const dodNextH2 = body.indexOf('\n## ', dodStart);
  const dodEnd = dodNextH2 === -1 ? body.length : dodNextH2;
  const dodContent = body.substring(dodStart, dodEnd);

  // Только выполненные пункты ([x]) — незавершённые не в scope проверки
  const completedItems = dodContent
    .split('\n')
    .filter(line => /^\s*-\s*\[x\]/i.test(line));

  const hasSourceGroundingDod = completedItems.some(line =>
    SOURCE_GROUNDING_DOD_INDICATORS.some(re => re.test(line))
  );

  if (!hasSourceGroundingDod) return { required: false, satisfied: true };

  // Извлекаем Result секцию для проверки evidence
  const resultSectionRegex = /^##\s*(Результат выполнения|Результат|Result)\s*$/m;
  const resultMatch = resultSectionRegex.exec(body);
  if (!resultMatch) return { required: true, satisfied: false };

  const resultStart = resultMatch.index + resultMatch[0].length;
  const resultNextH2 = body.indexOf('\n## ', resultStart);
  const resultEnd = resultNextH2 === -1 ? body.length : resultNextH2;
  const resultContent = body.substring(resultStart, resultEnd);

  const hasSourceRef =
    SOURCE_REF_FILE_LINE.test(resultContent) ||
    /package\.json/i.test(resultContent) ||
    /contributes\./i.test(resultContent);

  return { required: true, satisfied: hasSourceRef };
}

/**
 * E2E assertion против ghost-execution: парсит секцию `### Implementation assertions`
 * в теле тикета и возвращает список проверок вида
 *   { module, export, method?, type? }
 *
 * Формат каждой строки-bullet'а (значения в backticks, ключи через запятую):
 *   - module: `path/to/file.mjs`, export: `ClassName`, method: `methodName`
 *   - module: `path/to/file.mjs`, export: `namedExport`
 *   - module: `path/to/file.mjs`, export: `helper`, type: `function`
 *
 * Секция необязательна. Если её нет — возвращаем пустой массив
 * (тикеты без исполняемых артефактов — например, DOCS/HUMAN — проходят без гейта).
 */
function parseImplementationAssertions(body) {
  const headerRegex = /^###\s*(?:Implementation assertions|E2E assertions)\s*$/m;
  const match = headerRegex.exec(body);
  if (!match) return [];

  const startIdx = match.index + match[0].length;
  const nextH3 = body.indexOf('\n### ', startIdx);
  const nextH2 = body.indexOf('\n## ', startIdx);
  const candidates = [nextH3, nextH2].filter(i => i !== -1);
  const sectionEnd = candidates.length > 0 ? Math.min(...candidates) : body.length;
  const sectionContent = body.substring(startIdx, sectionEnd);

  const assertions = [];
  const bulletRegex = /^[-*]\s+(.+)$/gm;
  let bulletMatch;
  while ((bulletMatch = bulletRegex.exec(sectionContent)) !== null) {
    const line = bulletMatch[1];
    const kv = {};
    const pairRegex = /(\w+)\s*:\s*`([^`]+)`/g;
    let pair;
    while ((pair = pairRegex.exec(line)) !== null) {
      kv[pair[1]] = pair[2];
    }
    if (kv.module && kv.export) {
      assertions.push({
        module: kv.module,
        export: kv.export,
        method: kv.method || null,
        type: kv.type || 'function',
      });
    }
  }
  return assertions;
}

/**
 * Выполняет список implementation assertions против живого кода.
 * Для каждой: dynamic import модуля → достаём export → проверяем method/type.
 * Возвращает массив { ...assertion, ok, reason? }.
 */
async function runImplementationAssertions(assertions) {
  const results = [];
  for (const a of assertions) {
    const absPath = path.isAbsolute(a.module) ? a.module : path.join(PROJECT_DIR, a.module);
    if (!fs.existsSync(absPath)) {
      results.push({ ...a, ok: false, reason: `module_not_found: ${a.module}` });
      continue;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(absPath).href);
    } catch (err) {
      results.push({ ...a, ok: false, reason: `import_failed: ${err.message.replace(/\n/g, ' ')}` });
      continue;
    }
    const exported = mod[a.export];
    if (exported === undefined) {
      results.push({ ...a, ok: false, reason: `export_not_found: ${a.export}` });
      continue;
    }
    if (a.method) {
      // Класс → метод на prototype; объект → метод как свойство
      const target = typeof exported === 'function' ? exported.prototype : exported;
      const fn = target ? target[a.method] : undefined;
      if (typeof fn !== 'function') {
        results.push({ ...a, ok: false, reason: `method_not_function: ${a.export}.${a.method}` });
        continue;
      }
    } else {
      if (typeof exported !== a.type) {
        results.push({ ...a, ok: false, reason: `type_mismatch: expected ${a.type}, got ${typeof exported}` });
        continue;
      }
    }
    results.push({ ...a, ok: true });
  }
  return results;
}

function verifyTicket(ticketPath) {
  if (!fs.existsSync(ticketPath)) {
    throw new Error(`Ticket file not found: ${ticketPath}`);
  }

  const content = fs.readFileSync(ticketPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  const filePaths = parseChangedFiles(body);
  // Точка отсчёта для mtime — created_at: это стабильная метка, которая не
  // перезаписывается при move-ticket / retry-циклах. updated_at мутирует на
  // каждом перемещении (ready → in-progress → review → ready → …), поэтому
  // в retry файлы, реально изменённые в ранней попытке, становятся формально
  // «unchanged» относительно нового updated_at и тикет ложно блокируется.
  // На updated_at откатываемся, только если created_at не прошёл валидацию
  // (см. resolveWorkStartBaseline).
  const workStart = resolveWorkStartBaseline(frontmatter);
  const filesExist = checkFilesExist(filePaths, workStart.baseline);

  const dodStats = parseDoDCompletion(body);

  const resultStats = checkResultSection(body);

  const assertions = parseImplementationAssertions(body);
  const sourceGrounding = checkSourceGrounding(body);

  return {
    ticket_id: frontmatter.id,
    created_at: frontmatter.created_at,
    files_exist: filesExist,
    dod_completion_pct: dodStats.percentage,
    dod_checked: dodStats.checked,
    dod_completed: dodStats.completed,
    result_exists: resultStats.exists,
    result_filled: resultStats.summaryFilled,
    assertions,
    source_grounding: sourceGrounding,
    work_start_source: workStart.source,
    warnings: workStart.warnings,
  };
}

function resolveTicketPath(arg) {
  // 1. Промпт от runner'а — ищем "ticket_id: XXX" в тексте.
  //    Проверяем первым, потому что промпт содержит пути (plans/current/...)
  //    и символы '/', '\', '.md', которые ложно срабатывают в проверке на путь.
  const promptMatch = arg.match(/ticket_id:\s*([A-Z]+-\d+)/i);
  if (promptMatch) {
    return resolveTicketPath(promptMatch[1]);
  }

  // 2. Явный путь — absolute или relative
  if (arg.includes('/') || arg.includes('\\') || arg.endsWith('.md')) {
    return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  }

  // 3. Чистый ticket_id (QA-009) — резолвим по статусам
  if (/^[A-Z]+-\d+$/i.test(arg)) {
    for (const status of REVIEW_STATUSES) {
      const candidate = path.join(TICKETS_DIR, status, `${arg}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(TICKETS_DIR, 'review', `${arg}.md`);
  }

  return null;
}

function formatVerdict(result) {
  const missingFiles = result.files_exist
    .filter((f) => !f.exists)
    .map((f) => f.path);

  const unchangedFiles = result.files_exist
    .filter((f) => f.exists && f.unchanged)
    .map((f) => f.path);

  // Критерии failed:
  //   - result_filled == false (секция Result пуста)
  //   - dod_completion_pct == 0 (ни один пункт DoD не отмечен)
  //   - есть отсутствующие файлы из "Изменённые файлы"
  //   - есть неизменённые файлы (file_unchanged)
  const failReasons = [];
  const humanIssues = [];
  if (!result.result_filled) {
    failReasons.push('result_filled=false');
    humanIssues.push(result.result_exists
      ? 'секция Результата пуста (Summary не заполнен)'
      : 'секция Результата отсутствует');
  }
  if (result.dod_completion_pct === 0) {
    failReasons.push('dod_completion_pct=0');
    humanIssues.push(`ни один пункт DoD не отмечен (0/${result.dod_checked || 0})`);
  }
  if (missingFiles.length > 0) {
    failReasons.push(`missing_files=${missingFiles.join(',')}`);
    humanIssues.push(`не найдены заявленные файлы: ${missingFiles.join(', ')}`);
  }
  if (unchangedFiles.length > 0) {
    failReasons.push(`file_unchanged=${unchangedFiles.join(',')}`);
    humanIssues.push(
      `файлы не были изменены после начала выполнения тикета: ${unchangedFiles.join(', ')}`
    );
  }

  if (result.source_grounding?.required && !result.source_grounding?.satisfied) {
    failReasons.push('source_grounding_missing');
    humanIssues.push(
      'DoD содержит UI/контракт-проверки, но Result не содержит ссылок на source (file:line или package.json)'
    );
  }

  const assertionFailures = (result.assertionResults || []).filter(r => !r.ok);
  if (assertionFailures.length > 0) {
    const descriptions = assertionFailures.map(r => {
      const target = r.method ? `${r.export}.${r.method}` : r.export;
      return `${target} в ${r.module} (${r.reason})`;
    });
    failReasons.push(`assertion_failed=${descriptions.length}`);
    humanIssues.push(`не прошли E2E-assertions (ghost execution): ${descriptions.join('; ')}`);
  }

  const status = failReasons.length === 0 ? 'passed' : 'failed';

  return { status, missingFiles, unchangedFiles, failReasons, humanIssues };
}

// IMPL-87: Replace manual review-section write with appendReviewEntry from review-section.mjs.
// Idempotency: skip if last summary already matches.
async function appendReviewNote(ticketPath, humanIssues) {
  const summary = `verify-artifacts: ${humanIssues.join('; ')}`;
  const date = new Date().toISOString().slice(0, 10);

  // Idempotency check
  try {
    const content = fs.readFileSync(ticketPath, 'utf8');
    const sectionMatch = content.match(/(?:^|\n)\s*##\s+Ревью\s*\r?\n([\s\S]*?)(?=\r?\n##\s+|$)/i);
    if (sectionMatch) {
      const lines = sectionMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
      const lastRow = [...lines].reverse().find(l => l.startsWith('|') && !/^\|[-:|\s]+\|$/.test(l));
      if (lastRow && lastRow.includes(summary)) return false;
    }
  } catch {}

  const { appendReviewEntry } = await import('../../../lib/review-section.mjs');
  const r = appendReviewEntry(ticketPath, {
    date,
    agent: 'script-verify-artifacts',
    status: 'failed',
    summary,
  });
  return r?.ok === true;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node verify-artifacts.js <path-to-ticket|ticket_id|prompt>');
    process.exit(1);
  }

  const arg = args.join(' ');
  const ticketPath = resolveTicketPath(arg);

  if (!ticketPath) {
    console.error('Error: could not resolve ticket path from argument');
    console.log('---RESULT---');
    console.log('status: failed');
    console.log('reason: ticket_path_unresolved');
    console.log('---RESULT---');
    process.exit(1);
  }

  if (!fs.existsSync(ticketPath)) {
    console.error(`Error: ticket file not found: ${ticketPath}`);
    console.log('---RESULT---');
    console.log('status: failed');
    console.log(`reason: ticket_file_not_found`);
    console.log(`ticket_path: ${ticketPath}`);
    console.log('---RESULT---');
    process.exit(1);
  }

  try {
    const result = verifyTicket(ticketPath);
    result.assertionResults = await runImplementationAssertions(result.assertions || []);

    const warnings = result.warnings || [];
    for (const warning of warnings) {
      console.error(`Warning: ${warning}`);
    }

    const verdict = formatVerdict(result);

    let reviewNoteWritten = false;
    if (verdict.status === 'failed' && verdict.humanIssues.length > 0) {
      reviewNoteWritten = await appendReviewNote(ticketPath, verdict.humanIssues);
    }

    const assertionsTotal = result.assertionResults.length;
    const assertionsFailed = result.assertionResults.filter(r => !r.ok).length;

    console.log('---RESULT---');
    console.log(`status: ${verdict.status}`);
    console.log(`ticket_id: ${result.ticket_id || ''}`);
    console.log(`dod_completion_pct: ${result.dod_completion_pct}`);
    console.log(`dod_total: ${result.dod_checked}`);
    console.log(`dod_completed: ${result.dod_completed}`);
    console.log(`result_filled: ${result.result_filled}`);
    console.log(`missing_files: ${verdict.missingFiles.join(',')}`);
    console.log(`unchanged_files: ${verdict.unchangedFiles.join(',')}`);
    console.log(`assertions_total: ${assertionsTotal}`);
    console.log(`assertions_failed: ${assertionsFailed}`);
    // Дополнительная строка, а не замена существующих полей: runner парсит
    // RESULT-блок по ключам, лишний ключ формат не ломает.
    if (warnings.length > 0) {
      console.log(`warnings: ${warnings.join('; ')}`);
    }
    if (verdict.failReasons.length > 0) {
      console.log(`fail_reasons: ${verdict.failReasons.join('; ')}`);
      console.log(`issues: ${verdict.humanIssues.join('; ')}`);
      console.log(`review_note_written: ${reviewNoteWritten}`);
    }
    console.log('---RESULT---');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log('---RESULT---');
    console.log('status: failed');
    console.log(`reason: ${err.message.replace(/\n/g, ' ')}`);
    console.log('---RESULT---');
    process.exit(1);
  }
}

main();
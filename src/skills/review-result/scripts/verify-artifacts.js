#!/usr/bin/env node

/**
 * verify-artifacts.js — механическая предпроверка тикета перед AI-ревью.
 *
 * Парсит тикет и проверяет:
 * - Существование файлов из секции "Изменённые файлы"
 * - DoD completion %
 * - Заполненность секции Result (Summary)
 *
 * Тикет с `dod_format: 2` (PLAN-002) дополнительно получает файл evidence
 * `.workflow/state/evidence/<имя файла тикета>.json` (у стадии пайплайна имя
 * файла — ticket_id из Context, см. resolveTicketPath), перезаписываемый
 * каждой попыткой: проверки `check` пунктов DoD исполняются через
 * check-runner, маски `visual` раскрываются в изображения, ссылки `file:line`
 * из Result сверяются с исходником, дифф берётся по «Изменённым файлам».
 * Тикет без поля проверяется как раньше, файла evidence у него нет.
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
 *   status: all_green|passed|legacy|failed
 *     all_green — dod_format: 2, все пункты DoD — зелёные `check`, прежние гейты
 *                 пройдены; в `## Ревью` дописана строка passed с путём evidence
 *     passed    — dod_format: 2, проверки зелёные, есть пункты prose или visual
 *                 для модели стадии ревью
 *     legacy    — тикет без dod_format: 2, прежние гейты пройдены
 *     failed    — провален прежний гейт или пункт DoD (проверка не прошла,
 *                 у visual нет изображений, запись проверки не разобрана)
 *   dod_completion_pct: <int>
 *   result_filled: <bool>
 *   missing_files: <comma-separated list or empty>
 *   Только у тикета dod_format: 2:
 *   evidence_file: <путь файла evidence от корня проекта>
 *   required_capabilities: <JSON-массив одной строкой>
 *   dod_check_total, dod_check_failed, dod_prose_total, dod_visual_total: <int>
 *   warnings: <предупреждения через "; "; строка печатается только при наличии>
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, appendReviewEntry, replaceFileAtomicSync } from 'workflow-ai/lib/utils.mjs';
import { runCheck, parseDodChecks, isDodFormat2 } from 'workflow-ai/lib/check-runner.mjs';

const PROJECT_DIR = findProjectRoot();
const TICKETS_DIR = path.join(PROJECT_DIR, '.workflow', 'tickets');
const REVIEW_STATUSES = ['review', 'in-progress', 'done', 'ready', 'backlog'];
const SCRIPT_AGENT_ID = 'script-verify-artifacts';

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

/** Текст секции Result без заголовка; null — секции нет. */
function resultSectionContent(body) {
  // Порядок альтернатив важен: «Результат выполнения» перед «Результат»,
  // чтобы более длинный вариант матчился первым.
  const resultSectionRegex = /^##\s*(Результат выполнения|Результат|Result)\s*$/m;
  const sectionMatch = resultSectionRegex.exec(body);
  if (!sectionMatch) return null;

  const startIdx = sectionMatch.index + sectionMatch[0].length;
  const nextH2 = body.indexOf('\n## ', startIdx);
  return body.substring(startIdx, nextH2 === -1 ? body.length : nextH2);
}

function checkResultSection(body) {
  const sectionContent = resultSectionContent(body);
  if (sectionContent === null) return { exists: false, summaryFilled: false };

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
  const resultContent = resultSectionContent(body);
  if (resultContent === null) return { required: true, satisfied: false };

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

// ===========================================================================
// Evidence тикета `dod_format: 2` (PLAN-002, «Файл evidence»).
// Модель стадии ревью видит только собранное здесь, а не заявления исполнителя:
// текст Result в evidence не попадает, ссылки из него — только проверенными
// фрагментами исходника.
// ===========================================================================

const EVIDENCE_DIR = '.workflow/state/evidence';
// Лимит диффа — предположение плана (половина контекста модели при 3–4 символах
// на токен), не замер. Сверх лимита идёт начало диффа с пометкой усечения.
const DIFF_LIMIT_CHARS = 60000;
// Буфер вывода git: полный размер диффа нужен для пометки усечения.
const GIT_BUFFER_BYTES = 64 * 1024 * 1024;
const SOURCE_REF_CONTEXT_LINES = 5;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// Статусы пункта, которые валят тикет; passed бывает только у check,
// pending — у prose и visual с изображениями.
const DOD_FAILED_STATUSES = new Set(['failed', 'timeout', 'denied', 'image_missing']);

// Ссылка `file:line` или `file:start-end` — SOURCE_REF_FILE_LINE с диапазоном,
// все вхождения.
const SOURCE_REFS_IN_TEXT = /[\w][\w/\\.-]+\.\w{1,10}:\d+(?:-\d+)?/g;

function isInsideProject(fullPath) {
  const rel = path.relative(PROJECT_DIR, fullPath);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

function toProjectPath(fullPath) {
  return path.relative(PROJECT_DIR, fullPath).split(path.sep).join('/');
}

/**
 * Ссылка из Result, сверенная с диском: найдена — строки исходника
 * ±SOURCE_REF_CONTEXT_LINES с номерами; файла нет, он вне корня проекта или
 * строки за концом файла — status: missing.
 */
function readSourceRef(ref) {
  const [, file, startRaw, endRaw] = ref.match(/^(.*):(\d+)(?:-(\d+))?$/);
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  const missing = { ref, status: 'missing', excerpt: null };

  const fullPath = path.resolve(PROJECT_DIR, file);
  if (!isInsideProject(fullPath) || !fs.statSync(fullPath, { throwIfNoEntry: false })?.isFile()) return missing;

  const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (start < 1 || end < start || end > lines.length) return missing;

  const from = Math.max(1, start - SOURCE_REF_CONTEXT_LINES);
  const to = Math.min(lines.length, end + SOURCE_REF_CONTEXT_LINES);
  const excerpt = lines.slice(from - 1, to).map((line, i) => `${from + i}: ${line}`).join('\n');
  return { ref, status: 'found', excerpt };
}

function collectSourceRefs(body) {
  const resultContent = resultSectionContent(body);
  if (resultContent === null) return [];
  return [...new Set(resultContent.match(SOURCE_REFS_IN_TEXT) || [])].map(readSourceRef);
}

function segmentRegex(segment) {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

function matchMask(dir, segments, found) {
  if (segments.length === 0) {
    if (fs.statSync(dir, { throwIfNoEntry: false })?.isFile()) found.add(dir);
    return;
  }
  const [segment, ...rest] = segments;
  if (!/[*?]/.test(segment)) {
    matchMask(path.join(dir, segment), rest, found);
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const regex = segmentRegex(segment);
  for (const name of entries) {
    if (regex.test(name)) matchMask(path.join(dir, name), rest, found);
  }
}

/**
 * Путь или маска `visual` от корня проекта → изображения (пути от корня через
 * `/`, по алфавиту). `*` и `?` действуют внутри одного сегмента пути. Файлы вне
 * корня проекта и не PNG, JPEG или WebP в список не входят.
 */
function expandImageMask(mask) {
  const segments = mask.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  const found = new Set();
  matchMask(PROJECT_DIR, segments, found);
  return [...found]
    .filter((file) => isInsideProject(file) && IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map(toProjectPath)
    .sort();
}

/**
 * Пункты DoD для evidence. Проверки `check` исполняются по очереди через
 * check-runner (ограничения исполнителя — там же). Пункт с неразобранной
 * записью проверки — failed без запуска: закрыть его нечем.
 */
async function collectDodItems(dodItems) {
  const items = [];
  for (const item of dodItems) {
    const base = { index: item.index, text: item.text, kind: item.kind };
    if (item.error) {
      items.push({ ...base, status: 'failed', reason: `dod_record_invalid: ${item.error}` });
    } else if (item.kind === 'check') {
      const run = await runCheck({ check: item.command, expect: item.expect, projectRoot: PROJECT_DIR });
      items.push({
        ...base,
        command: item.command,
        expect: item.expect,
        regression: item.regression,
        exit_code: run.exit_code,
        stdout: run.stdout,
        stderr: run.stderr,
        duration_ms: run.duration_ms,
        status: run.status,
        reason: run.reason,
      });
    } else if (item.kind === 'prose') {
      items.push({ ...base, reason: item.reason, status: 'pending' });
    } else {
      const images = expandImageMask(item.mask);
      items.push({ ...base, mask: item.mask, images, status: images.length > 0 ? 'pending' : 'image_missing' });
    }
  }
  return items;
}

function runGit(args, okStatuses = [0]) {
  const run = spawnSync('git', args, {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    maxBuffer: GIT_BUFFER_BYTES,
    windowsHide: true,
  });
  const ok = !run.error && okStatuses.includes(run.status);
  // Причина идёт в diff_error evidence и строку warnings RESULT-блока — одной строкой.
  const error = (run.error ? run.error.message : run.stderr || `exit ${run.status}`).replace(/\s+/g, ' ').trim();
  return { ok, stdout: run.stdout || '', error };
}

/**
 * Изменения отслеживаемых файлов относительно HEAD и неотслеживаемые файлы
 * целиком, как новые. Игнорируемые git файлы в дифф не попадают. Ошибка git
 * идёт в problems; ошибка `git diff HEAD` (git нет, проект не в репозитории,
 * у репозитория нет коммитов) — дифф не собран весь.
 */
function gitDiff(pathspecs, problems) {
  // Вне репозитория `git diff HEAD -- <пути>` уходит в режим --no-index и вместо
  // ошибки печатает справку по опциям (~4 тыс. символов) — она попадала в
  // diff_error и в данные модели ревью (проба 2026-09-26). Проверка — до вызова.
  const inside = runGit(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    problems.push(/not a git repository/i.test(inside.error) ? 'проект не в репозитории git' : inside.error);
    return '';
  }
  const tracked = runGit(['diff', 'HEAD', '--no-color', '--', ...pathspecs]);
  if (!tracked.ok) {
    problems.push(tracked.error);
    return '';
  }
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs]);
  if (!untracked.ok) {
    problems.push(`новые файлы: ${untracked.error}`);
    return tracked.stdout;
  }

  const parts = [tracked.stdout];
  for (const file of untracked.stdout.split('\0').filter(Boolean)) {
    // --no-index отвечает кодом 1, когда файлы различаются, — с /dev/null всегда.
    const added = runGit(['diff', '--no-index', '--no-color', '--', '/dev/null', file], [0, 1]);
    if (added.ok) parts.push(added.stdout);
    else problems.push(`новый файл ${file}: ${added.error}`);
  }
  return parts.join('');
}

/**
 * Дифф по «Изменённым файлам» с пометкой усечения. Путь не внутри корня
 * проекта в дифф не идёт, как и ссылки `file:line` вне корня: путь вне
 * репозитория git отверг бы вместе со всем вызовом. Каталог тикетов и файл
 * тикета исключены: исполнитель может назвать тикет или каталог с ним среди
 * изменённых, и в проекте, где тикеты хранятся в git, дифф принёс бы текст
 * Result — нынешний и прежней попытки из копии тикета в HEAD под другим
 * статусом. Что не собрано и почему — в diff_error (null — собрано всё) и в
 * предупреждении: модель отличит «дифф не собран» от «изменений нет».
 */
function collectDiff(changedFiles, ticketPath, warnings) {
  const problems = [];
  const files = changedFiles.filter((file) => {
    const inside = isInsideProject(path.resolve(PROJECT_DIR, file));
    if (!inside) problems.push(`не внутри корня проекта: ${file}`);
    return inside;
  });
  // Пути исключений — от корня проекта, он же cwd git.
  const excludes = [TICKETS_DIR, ticketPath].filter(isInsideProject).map((p) => `:(exclude)${toProjectPath(p)}`);
  // Одни исключения git понимает как «всё, кроме них» — без путей git не зовётся.
  const diff = files.length > 0 ? gitDiff([...files, ...excludes], problems) : '';

  const diffError = problems.length > 0 ? problems.join('; ') : null;
  if (diffError) warnings.push(`дифф неполон: ${diffError}`);
  if (diff.length <= DIFF_LIMIT_CHARS) return { diff, diff_truncated: null, diff_error: diffError };
  return {
    diff: diff.slice(0, DIFF_LIMIT_CHARS),
    diff_truncated: { shown_chars: DIFF_LIMIT_CHARS, total_chars: diff.length },
    diff_error: diffError,
  };
}

// Номер попытки — из блока Context промпта стадии (`  attempt: N`), как его
// передал раннер; при запуске с путём или id тикета — null.
function parsePromptAttempt(arg) {
  const match = arg.match(/^\s*attempt:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

async function collectEvidence(result, ticketPath, attempt) {
  return {
    ticket_id: result.ticket_id,
    attempt,
    collected_at: new Date().toISOString(),
    items: await collectDodItems(result.dod_items),
    source_refs: result.source_refs,
    changed_files: result.changed_files,
    ...collectDiff(result.changed_files, ticketPath, result.warnings),
  };
}

function legacyGates(result, verdict, assertionsFailed) {
  const grounding = result.source_grounding;
  return {
    missing_files: verdict.missingFiles,
    unchanged_files: verdict.unchangedFiles,
    dod_completion_pct: result.dod_completion_pct,
    result_filled: result.result_filled,
    source_grounding: !grounding.required ? 'not_required' : grounding.satisfied ? 'satisfied' : 'missing',
    assertions_failed: assertionsFailed,
  };
}

/** Файл evidence по имени файла тикета; возвращает путь от корня проекта. */
function writeEvidence(ticketPath, evidence) {
  const relPath = `${EVIDENCE_DIR}/${path.basename(ticketPath, '.md')}.json`;
  const fullPath = path.join(PROJECT_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  replaceFileAtomicSync(fullPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return relPath;
}

// Способности для выбора агента стадии ревью: способности тикета плюс
// multimodal при пункте visual. JSON-массив одной строкой — так поле из
// контекста разбирает resolveAgent раннера (JSON.parse).
function reviewCapabilities(ticketCapabilities, items) {
  const capabilities = new Set(ticketCapabilities);
  if (items.some((item) => item.kind === 'visual')) capabilities.add('multimodal');
  return JSON.stringify([...capabilities]);
}

function describeFailedItem(item) {
  if (item.status === 'image_missing') return `пункт ${item.index} — нет изображений по маске ${item.mask}`;
  return `пункт ${item.index} — ${item.status}: ${item.reason}`;
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

  // Проверки пунктов DoD и ссылки Result нужны только evidence тикета нового формата.
  const dodFormat2 = isDodFormat2(frontmatter);

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
    changed_files: filePaths,
    required_capabilities: Array.isArray(frontmatter.required_capabilities) ? frontmatter.required_capabilities : [],
    dod_format_2: dodFormat2,
    dod_items: dodFormat2 ? parseDodChecks(body) : [],
    source_refs: dodFormat2 ? collectSourceRefs(body) : [],
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

/**
 * @param {object} result - verifyTicket + assertionResults
 * @param {object|null} evidence - evidence тикета dod_format: 2, иначе null
 */
function formatVerdict(result, evidence) {
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
  //   - у тикета dod_format: 2 провален пункт DoD (DOD_FAILED_STATUSES)
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

  // Пункт DoD parseDodChecks — строка `- [ ]` без отступа, а процент DoD считает
  // любые чекбоксы секции. Без пунктов закрывать тикету нечего — это провал, а
  // не ревью без вопросов.
  if (evidence && evidence.items.length === 0) {
    failReasons.push('dod_items_missing');
    humanIssues.push('у тикета dod_format: 2 нет пунктов DoD');
  }
  const failedItems = (evidence?.items || []).filter((item) => DOD_FAILED_STATUSES.has(item.status));
  if (failedItems.length > 0) {
    failReasons.push(`dod_items_failed=${failedItems.map((item) => item.index).join(',')}`);
    humanIssues.push(`не пройдены пункты DoD: ${failedItems.map(describeFailedItem).join('; ')}`);
  }

  let status;
  if (failReasons.length > 0) {
    status = 'failed';
  } else if (!evidence) {
    // Тикет без dod_format: 2 — прежний маршрут, ревью агентом со скилом.
    status = 'legacy';
  } else if (evidence.items.every((item) => item.status === 'passed')) {
    status = 'all_green';
  } else {
    status = 'passed';
  }

  return { status, missingFiles, unchangedFiles, failReasons, humanIssues };
}

/**
 * Маркер призрачного выполнения в лог пайплайна.
 *
 * Призрак — это когда стадия отчиталась об успехе, а работы нет: заявленные
 * файлы не трогали после начала тикета, либо заявленный экспорт/метод в модуле
 * отсутствует. Оба признака уже считает `formatVerdict`; здесь они только
 * называются одним именем.
 *
 * Строка идёт в stdout, а раннер кладёт stdout агента в лог блоком `OUTPUT`,
 * откуда её и читают детекторы workflow-mcp (`list_ghost_executions` и
 * health-детектор `ghost-execution`). До этой строки маркер не писал никто:
 * детекторы были на месте, искать им было нечего.
 *
 * Формат жёсткий — токен `[GHOST-EXECUTION]` отдельным словом в начале строки.
 * Детектор ищет именно структурный токен: прозаическое упоминание в тексте
 * тикета или в commit message срабатывания не даёт (FIX-001).
 *
 * @param {string} ticketId
 * @param {{unchangedFiles: string[]}} verdict
 * @param {number} assertionsFailed
 */
const GHOST_MARKER = '[GHOST-EXECUTION]';
const GHOST_FILES_IN_LINE = 5;

/**
 * Провалы assertion'ов, которые действительно доказывают призрак: код на месте,
 * а заявленного в тикете в нём нет.
 *
 * Остальные причины (`module_not_found`, `import_failed`, `type_mismatch`)
 * говорят о сломанном окружении проверки или о неверно записанном assertion'е:
 * нет зависимости, файл не импортируется, перепутан тип. Это честный `failed`,
 * но не призрак, и поднимать по ним `critical`-алерт в workflow-mcp — значит
 * звать человека на чужую беду.
 */
const GHOST_ASSERTION_REASONS = ['export_not_found', 'method_not_function'];

/**
 * @param {Array<{ok: boolean, reason?: string}>} assertionResults
 * @returns {number} сколько провалов доказывают призрак
 */
function ghostAssertionCount(assertionResults) {
  return (assertionResults || []).filter((r) => {
    if (r.ok) return false;
    const reason = typeof r.reason === 'string' ? r.reason : '';
    return GHOST_ASSERTION_REASONS.some((prefix) => reason.startsWith(prefix));
  }).length;
}

function emitGhostMarker(ticketId, verdict, assertionsFailed) {
  const unchanged = verdict.unchangedFiles || [];
  const reasons = [];
  if (unchanged.length > 0) reasons.push('file_unchanged');
  if (assertionsFailed > 0) reasons.push('assertion_failed');
  if (reasons.length === 0) return;

  // Список файлов режется: строка идёт в лог, а тикет может заявлять их сотню.
  const shown = unchanged.slice(0, GHOST_FILES_IN_LINE).join(',');
  const rest = unchanged.length > GHOST_FILES_IN_LINE
    ? `+${unchanged.length - GHOST_FILES_IN_LINE}`
    : '';

  const parts = [
    GHOST_MARKER,
    `ticket=${ticketId || 'unknown'}`,
    `reason=${reasons.join(',')}`
  ];
  if (unchanged.length > 0) parts.push(`unchanged_files=${shown}${rest}`);
  // Имя отличается от `assertions_failed` в RESULT-блоке намеренно: там число
  // всех провалов, здесь — только доказывающих призрак. Два разных числа под
  // одним именем в одном логе читались бы как ошибка.
  if (assertionsFailed > 0) parts.push(`ghost_assertions=${assertionsFailed}`);

  console.log(parts.join(' '));
}

// IMPL-87: Replace manual review-section write with appendReviewEntry from review-section.mjs.
// Idempotency: skip if last summary already matches.
function appendReviewNote(ticketPath, status, text) {
  // Самари — ячейка таблицы: перевод строки или `|` (причина проверки вида
  // `stdout_no_match: /a|b/`) порвали бы строку. getLastReviewStatus делит
  // ячейки по `|` без обратной косой перед ним.
  const summary = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
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

  const r = appendReviewEntry(ticketPath, {
    date,
    agent: SCRIPT_AGENT_ID,
    status,
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
    const evidence = result.dod_format_2 ? await collectEvidence(result, ticketPath, parsePromptAttempt(arg)) : null;

    const warnings = result.warnings || [];
    for (const warning of warnings) {
      console.error(`Warning: ${warning}`);
    }

    const verdict = formatVerdict(result, evidence);

    const assertionsTotal = result.assertionResults.length;
    const assertionsFailed = result.assertionResults.filter(r => !r.ok).length;

    let evidenceFile = null;
    if (evidence) {
      evidence.legacy_gates = legacyGates(result, verdict, assertionsFailed);
      // Раздел заполняет скрипт применения стадии ревью.
      evidence.review = { agent: null, model: null, items: {} };
      evidenceFile = writeEvidence(ticketPath, evidence);
    }

    let reviewNoteWritten = false;
    if (verdict.status === 'failed' && verdict.humanIssues.length > 0) {
      const issues = evidenceFile ? [...verdict.humanIssues, `evidence: ${evidenceFile}`] : verdict.humanIssues;
      reviewNoteWritten = appendReviewNote(ticketPath, 'failed', `verify-artifacts: ${issues.join('; ')}`);
    } else if (verdict.status === 'all_green') {
      // Строка passed с путём evidence: без неё move-ticket при переходе
      // review/ → done/ дописал бы свою fallback-строку без ссылки на evidence.
      const green = evidence.items.length;
      reviewNoteWritten = appendReviewNote(
        ticketPath,
        'passed',
        `verify-artifacts: зелёных проверок DoD — ${green} из ${green}, evidence: ${evidenceFile}`
      );
    }

    emitGhostMarker(result.ticket_id, verdict, ghostAssertionCount(result.assertionResults));

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
    if (evidence) {
      const ofKind = (kind) => evidence.items.filter((item) => item.kind === kind);
      const checks = ofKind('check');
      console.log(`evidence_file: ${evidenceFile}`);
      console.log(`required_capabilities: ${reviewCapabilities(result.required_capabilities, evidence.items)}`);
      console.log(`dod_check_total: ${checks.length}`);
      console.log(`dod_check_failed: ${checks.filter((item) => item.status !== 'passed').length}`);
      console.log(`dod_prose_total: ${ofKind('prose').length}`);
      console.log(`dod_visual_total: ${ofKind('visual').length}`);
    }
    // Дополнительная строка, а не замена существующих полей: runner парсит
    // RESULT-блок по ключам, лишний ключ формат не ломает.
    if (warnings.length > 0) {
      console.log(`warnings: ${warnings.join('; ')}`);
    }
    if (verdict.failReasons.length > 0) {
      console.log(`fail_reasons: ${verdict.failReasons.join('; ')}`);
      console.log(`issues: ${verdict.humanIssues.join('; ')}`);
    }
    if (verdict.failReasons.length > 0 || verdict.status === 'all_green') {
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
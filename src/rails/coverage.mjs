/**
 * Rails — покрытие инвариантов при конверсии прозы в граф (спецификация §12).
 *
 * Гарантия «ничего не утрачено» при переводе прозы скила в граф: фразы-
 * инварианты базовой (дографовой) версии скила ищутся в текущих файлах
 * скила или явно перечисляются в карте `--map`. Модуль не имеет побочных
 * эффектов при импорте — файловые операции и вызовы `git` только внутри
 * `checkCoverage()`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { normalizeLabel } from './graph.mjs';
import { load } from '../lib/js-yaml.mjs';
import { realpathDeep } from './paths.mjs';

// --- extractInvariants (§12) -----------------------------------------------------

// Признаки строки-инварианта: запрет/предупреждение, выделение жирным,
// дата в двух распространённых форматах.
const MARK_RE = /⛔|⚠️|\*\*[^*]+\*\*|\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * Извлекает фразы-инварианты из текста скила (§12): предложения из строк с
 * ⛔/⚠️/`**…**`/датой, плюс каждая строка markdown-таблицы (кроме строки-
 * разделителя `|---|---|`) — детерминированное прочтение спецификации для
 * «таблиц маршрутизации и загрузки знаний» (открытый вопрос: спецификация
 * не называет таблицы по заголовку/структуре — взяты ВСЕ табличные строки).
 *
 * @param {string} text
 * @returns {string[]}
 */
// §12: строки таблиц берутся только из таблиц маршрутизации и загрузки
// (заголовок секции содержит «маршрутизац», «загрузк» или «шаблон»), без
// строки-шапки (строка непосредственно перед разделителем `|---|`).
const TABLE_HEADING_RE = /маршрутизац|загрузк|шаблон/i;
const HEADING_RE = /^#{1,6}\s+(.+)$/;

// Обрывок разбора — не инвариант. Строка режется на предложения по точке, поэтому нумерация
// списка («8.», «9.», «10.») и закрывающая скобка примера становились отдельными
// «требованиями»: покрыть их нельзя ни лейблом узла, ни картой переноса (ключ карты — минимум
// 10 символов), и гейт конверсии не закрывался (конверсия execute-task, 2026-09-23).
// Требованием считается фраза от 10 символов, в которой есть хотя бы три буквы.
const MIN_PHRASE_LEN = 10;

function isPhrase(text) {
  const t = String(text ?? '').trim();
  if (t.length < MIN_PHRASE_LEN) return false;
  let letters = 0;
  for (const ch of t) {
    if (/\p{L}/u.test(ch)) letters += 1;
    if (letters >= 3) return true;
  }
  return false;
}

export function extractInvariants(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim());
  const out = [];
  let heading = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    const hm = HEADING_RE.exec(line);
    if (hm) {
      heading = hm[1];
      continue;
    }

    if (TABLE_ROW_RE.test(line)) {
      if (TABLE_SEP_RE.test(line)) continue;
      const isHeader = i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]);
      if (!isHeader && TABLE_HEADING_RE.test(heading)) out.push(line);
      continue;
    }

    if (MARK_RE.test(line)) {
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        const t = sentence.trim();
        if (isPhrase(t)) out.push(t);
      }
    }
  }
  return out;
}

function stripMarkdown(s) {
  return String(s ?? '')
    .replace(/⛔|⚠️/g, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*(?:>\s*)?(?:[-*]\s+)?/, '') // цитата и маркер списка в начале строки
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- базовая версия скила: git show <ref>:<path> -----------------------------------
//
// §12: базовая версия читается по пути `src/skills/<skill>` ОТНОСИТЕЛЬНО КОРНЯ
// GIT-РЕПОЗИТОРИЯ, где реально лежит канон скила, — не относительно `root`
// (проектного каталога rails) и не по жёстко зашитому `.workflow/src/skills/<skill>`.
// В реальном проекте `.workflow/src/skills/<skill>` — junction на канон (§2),
// а `.workflow/` в каноническом репозитории в `.gitignore`: git не видит по
// этому пути ничего. Путь к канону берётся через realpath каталога скила
// (`realpathDeep`, разворачивает junction), git-toplevel — через
// `git rev-parse --show-toplevel`, запущенный ИЗ этого канонического
// каталога, а путь для `git show`/`git ls-tree` — относительно найденного
// toplevel. В тестовой фикстуре (без junction, git init прямо в `root`) это
// естественно даёт тот же путь, что раньше был зашит: `realpathDeep` не
// разворачивает ничего лишнего, toplevel совпадает с `root`.

function gitShow(ref, relPath, cwd) {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd, encoding: 'utf8' });
  } catch {
    return null;
  }
}

function gitListMdFiles(ref, pathPrefix, cwd) {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', pathPrefix], {
      cwd,
      encoding: 'utf8',
    });
    // §12: базовая версия — только SKILL.md и workflows/*.md скила
    // (knowledge/algorithms/templates/tests остаются справочниками и в граф не переносятся).
    const prefix = pathPrefix.replace(/\/+$/, '') + '/';
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => {
        if (!s.startsWith(prefix)) return false;
        const rel = s.slice(prefix.length);
        return rel === 'SKILL.md' || /^workflows\/[^/]+\.md$/i.test(rel);
      });
  } catch {
    return [];
  }
}

// git-toplevel настоящего (после realpath) каталога скила, или null, если
// каталога нет или он вне какого-либо git-репозитория.
function gitToplevelOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Текст базовой версии скила из `baselineRef` и число файлов, из которых он
 * собран (§12). `filesFound: 0` — сигнал «базовая версия не найдена»
 * (несуществующий ref, каталог скила вне git-репозитория, скил ещё не
 * существовал на этом ref) — вызывающий код (`checkCoverage`) трактует это
 * как ошибку, а не как «всё покрыто пустотой».
 *
 * @param {string} root
 * @param {string} skill
 * @param {string} baselineRef
 * @returns {{text: string, filesFound: number}}
 */
function baselineText(root, skill, baselineRef) {
  const skillDir = join(root, '.workflow', 'src', 'skills', skill);

  let realSkillDir;
  try {
    realSkillDir = realpathDeep(skillDir);
  } catch {
    return { text: '', filesFound: 0 };
  }

  const toplevel = gitToplevelOf(realSkillDir);
  if (!toplevel) return { text: '', filesFound: 0 };

  const relPath = relative(toplevel, realSkillDir).split(sep).join('/');
  if (!relPath || relPath.startsWith('..')) return { text: '', filesFound: 0 };

  const files = gitListMdFiles(baselineRef, relPath, toplevel);
  let combined = '';
  for (const f of files) {
    const t = gitShow(baselineRef, f, toplevel);
    if (t !== null) combined += `\n${t}`;
  }
  return { text: combined, filesFound: files.length };
}

// --- текущая версия скила: все *.md + rails.yaml ------------------------------------

function walkMdFiles(dir, out) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      // tests/ — выводы агентов (trial-*.md), рубрики и фикстуры: цитата
      // инварианта там не означает, что он живёт в графе или справочнике.
      if (ent.name === 'tests') continue;
      walkMdFiles(full, out);
    } else if ((ent.isFile() || ent.isSymbolicLink()) && full.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

// Открытый вопрос (§12 формально требует «все *.md», спецификация не делает
// исключения для tests/): обход не исключает tests/cases/**/trial-*.md —
// выводы агентов из прогонов скила. Если фраза-инвариант дословно процитирована
// в trial-выводе, она засчитывается «покрытой» без следа в графе/rails.yaml —
// формально по букве §12, но подрывает гарантию «ничего не утрачено» (находка
// ревью wp4, minor). Решение не менялось: исключение каталога — поведенческое
// изменение вне доверенных фактов о намерении спецификации; отмечено здесь как
// открытый вопрос, а не как самостоятельная догадка.
function currentText(skillDir) {
  const files = [];
  walkMdFiles(skillDir, files);
  const railsYamlPath = join(skillDir, 'rails.yaml');
  if (existsSync(railsYamlPath)) files.push(railsYamlPath);

  let combined = '';
  for (const f of files) {
    try {
      combined += `\n${readFileSync(f, 'utf8')}`;
    } catch {
      // файл исчез между листингом и чтением — не наша забота здесь
    }
  }
  return combined;
}

// --- карта --map: phrase -> target (узел / файл / "dropped: обоснование") --------

function loadMap(mapFile) {
  const map = new Map();
  if (!mapFile) return map;

  let raw;
  try {
    raw = readFileSync(mapFile, 'utf8');
  } catch {
    return map;
  }
  let obj;
  try {
    obj = load(raw);
  } catch {
    return map;
  }
  // Два формата карты: плоский объект {phrase: target} и rails-migration.yaml
  // с метаданными и списком entries: [{phrase, target}]. Ключ карты нормализуется
  // той же цепочкой (stripMarkdown + normalizeLabel), что и инварианты.
  const add = (phrase, target) => {
    if (typeof phrase !== 'string' || !phrase.trim()) return;
    map.set(normalizeLabel(stripMarkdown(phrase)), target);
  };
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (Array.isArray(obj.entries)) {
      for (const e of obj.entries) {
        if (e && typeof e === 'object') add(e.phrase, e.target);
      }
    } else {
      for (const [phrase, target] of Object.entries(obj)) {
        if (typeof target === 'string' || typeof target === 'number') add(phrase, target);
      }
    }
  }
  return map;
}

// Фраза карты покрывает инвариант, если совпадает с ним целиком или входит в него
// подстрокой (карта перечисляет отличительные фрагменты, не полные предложения).
function mapTargetFor(normalizedPhrase, map) {
  if (map.has(normalizedPhrase)) return map.get(normalizedPhrase);
  for (const [key, target] of map) {
    if (key.length >= 10 && normalizedPhrase.includes(key)) return target;
  }
  return undefined;
}

// --- совпадение по подстроке ≥25 символов (§12) --------------------------------------

const MIN_SUBSTR = 25;

// Открытый вопрос: спецификация не уточняет случай, когда сама нормализованная
// фраза короче MIN_SUBSTR (окно такой длины из неё не выкроить). Простое
// детерминированное решение — тогда требуется точное вхождение всей фразы.
function coveredByContent(normalizedPhrase, normalizedHaystack) {
  if (normalizedPhrase.length === 0) return true;
  if (normalizedPhrase.length < MIN_SUBSTR) {
    return normalizedHaystack.includes(normalizedPhrase);
  }
  for (let i = 0; i + MIN_SUBSTR <= normalizedPhrase.length; i += 1) {
    if (normalizedHaystack.includes(normalizedPhrase.slice(i, i + MIN_SUBSTR))) return true;
  }
  return false;
}

/**
 * Покрытие инвариантов при конверсии прозы скила в граф (§12).
 *
 * Бросает, если по `baselineRef` не найдено ни одного файла скила (несуществующий
 * ref, каталог скила вне git-репозитория, скил на этом ref ещё не существовал) —
 * пустая базовая версия не должна молча превращаться в «всё покрыто» (blocker
 * ревью wp4: `coverage --baseline <плохой ref>` давал 0/0, код выхода 0).
 *
 * @param {{root: string, skill: string, baselineRef: string, mapFile?: string}} args
 * @returns {{covered: Array<{phrase: string, via: 'content'|'map', target?: *}>, missing: string[]}}
 */
export function checkCoverage({ root, skill, baselineRef, mapFile } = {}) {
  const skillDir = join(root, '.workflow', 'src', 'skills', skill);

  const baseline = baselineText(root, skill, baselineRef);
  if (baseline.filesFound === 0) {
    throw new Error(
      `baseline не содержит файлов скила "${skill}" (ref "${baselineRef}"): проверь путь каталога скила и правильность git-ref`
    );
  }

  const invariants = extractInvariants(baseline.text);
  const haystack = normalizeLabel(currentText(skillDir));
  const map = loadMap(mapFile);

  const covered = [];
  const missing = [];
  const seen = new Set();

  for (const phrase of invariants) {
    const normalized = normalizeLabel(stripMarkdown(phrase));
    if (seen.has(normalized)) continue; // одна и та же фраза не дублируется в отчёте
    seen.add(normalized);

    const mapped = mapTargetFor(normalized, map);
    if (mapped !== undefined) {
      covered.push({ phrase, via: 'map', target: mapped });
      continue;
    }
    if (coveredByContent(normalized, haystack)) {
      covered.push({ phrase, via: 'content' });
      continue;
    }
    missing.push(phrase);
  }

  return { covered, missing };
}

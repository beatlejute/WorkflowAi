// Парсер подмножества mermaid flowchart, модель графа скила и его валидация.
// Спецификация: src/rails/README.md, §3 (грамматика графа) и §4 (rails.yaml,
// используется только для чтения полей entry/terminal/pause_nodes/quote_min/fragments).
//
// Модуль не имеет побочных эффектов при импорте — файловые операции только
// внутри loadSkillGraph().

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Идентификатор узла: этап, тип, номер. §3.
export const NODE_ID_RE = /^P(\d+)([ERSGQ])(\d+)$/;

// Хвост на строке открывающего забора (`` ```mermaid `` + пробелы/атрибуты до
// перевода строки) допускается и игнорируется — сам забор всё равно распознан.
// Забор обязан начинаться со своей строки (после `^` или `\n`, с необязательным
// отступом) — иначе инлайн-упоминание ```mermaid``` в прозе внутри абзаца
// ложно распознаётся как открывающий забор и съедает следующий настоящий блок.
const FENCE_RE = /(?:^|\n)[ \t]*```mermaid[^\n]*\r?\n([\s\S]*?)\n[ \t]*```/g;
const HEADER_RE = /^(graph|flowchart)\s+\S+/i;

// Токен узла: идентификатор + необязательное определение формы.
// Идентификатор здесь — широкий (буквы/цифры/_/-), чтобы поймать «плохие»
// id как bad-id, а не как ошибку разбора.
const NODE_TOKEN = /[ \t]*([A-Za-z_][\w-]*)(?:(\[)"([\s\S]*?)"\]|(\{)"([\s\S]*?)"\})?[ \t]*/y;
const ARROW_TOKEN = /[ \t]*-->[ \t]*(?:\|[ \t]*"([\s\S]*?)"[ \t]*\|[ \t]*)?/y;

/**
 * Нормализация лейбла для сверки цитат (§3, §5, §12).
 * Схлопывает пробелы (включая переносы строк внутри кавычек), убирает
 * `<br/>`, приводит кавычки-ёлочки/типографские к прямым, нижний регистр.
 */
export function normalizeLabel(text) {
  if (text === null || text === undefined) return '';
  let s = String(text);
  s = s.replace(/<br\s*\/?>/gi, ' ');
  // Markdown-акценты в лейбле (` ` ` и *) агент при цитировании опускает — прогоны
  // 2026-09-22: «цитата не найдена в лейбле узла P0S3» ×5 из-за `…` и **…** в лейбле.
  s = s.replace(/[`*]/g, '');
  s = s.replace(/[«»“”]/g, '"'); // «»""
  s = s.replace(/[’‘']/g, "'"); // ’‘'
  // Пиктограммы (⛔⚠️✅🟢…), вариационный селектор U+FE0F и ZWJ U+200D агент
  // при цитировании лейбла опускает — прогоны analyze-report 2026-09-22:
  // 4 отказа quote-mismatch на P10R2/P6R2 из-за «⛔»/«✅» в лейбле узла.
  // U+00A9 (©) в \p{Extended_Pictographic} формально попадает (юникодная
  // квирка emoji-data — не статусный значок), но это обычный текстовый
  // символ — проверено запуском, не удаляем, иначе ломаем реальный текст.
  s = s.replace(/(?!\u00A9)[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.toLowerCase();
  return s;
}

/**
 * Разбивает тело mermaid-блока на statements: топ-уровневые переносы строк
 * (не внутри кавычек) — разделители; `%% …` вне кавычек — комментарий до
 * конца физической строки; перенос строки внутри кавычек сохраняется как
 * часть лейбла (§3: «может занимать несколько строк»).
 */
function splitStatements(body) {
  const statements = [];
  let current = '';
  let inQuote = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
      i += 1;
      continue;
    }
    if (!inQuote && ch === '%' && body[i + 1] === '%') {
      while (i < body.length && body[i] !== '\n') i += 1;
      continue;
    }
    if (!inQuote && ch === '\n') {
      if (current.trim()) statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

// Пытается разобрать один токен узла (`ID` или `ID["лейбл"]` / `ID{"лейбл"}`)
// начиная точно с позиции pos. null, если токен там не начинается.
function parseNodeToken(stmt, pos) {
  NODE_TOKEN.lastIndex = pos;
  const nm = NODE_TOKEN.exec(stmt);
  if (!nm || nm.index !== pos || nm[1] === undefined) return null;
  let shape = null;
  let label = null;
  if (nm[2] === '[') {
    shape = 'rect';
    label = nm[3];
  } else if (nm[4] === '{') {
    shape = 'diamond';
    label = nm[5];
  }
  return { node: { id: nm[1], shape, label }, end: NODE_TOKEN.lastIndex };
}

// Разбирает один statement: цепочку `ID[def]? --> ID[def]? --> …`.
// Хвост, который не удалось разобрать (висячая стрела, метка без кавычек,
// нелатинский id и т.п.), не поглощается и не портит уже собранное: он
// остаётся в `stmt.slice(consumed)` — parseMermaidBlocks превращает его
// в диагностику `parse-error`, а не отбрасывает молча (README §3, §14).
function parseStatement(stmt) {
  const seq = [];
  const arrowLabels = [];

  const first = parseNodeToken(stmt, 0);
  if (!first) {
    return { seq, arrowLabels, consumed: 0 };
  }
  seq.push(first.node);
  let pos = first.end;

  for (;;) {
    ARROW_TOKEN.lastIndex = pos;
    const am = ARROW_TOKEN.exec(stmt);
    if (!am || am.index !== pos || am[0].length === 0) break;
    // Стрелка распознана, но следующий узел — нет (висячая стрелка, метка
    // без кавычек, нелатинский id): стрелку и всё после неё НЕ поглощаем,
    // arrowLabels не пополняем, чтобы не рассинхронизировать seq/arrowLabels.
    const next = parseNodeToken(stmt, ARROW_TOKEN.lastIndex);
    if (!next) break;
    arrowLabels.push(am[1] !== undefined ? am[1] : null);
    seq.push(next.node);
    pos = next.end;
  }

  return { seq, arrowLabels, consumed: pos };
}

function truncateForMessage(s, max = 80) {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Разбирает все ```mermaid``` блоки в markdown-тексте. Не бросает исключений
 * на плохом входе (README §7 «хук никогда не падает»): нераспознанный
 * statement или его нераспознанный хвост превращаются в диагностику
 * `parse-error`, а не пропадают молча.
 * @param {string} markdownText
 * @param {string} sourceName — имя файла-источника (для sources в узлах/рёбрах)
 * @returns {{nodes: Array, edges: Array, errors: Array}}
 *   nodes: {id, shape: 'rect'|'diamond'|null, label: string|null, source}
 *          (shape/label === null — узел только упомянут, определения нет)
 *   edges: {from, to, label: string|null, source}
 *   errors: {code: 'parse-error', message, source, text}
 */
export function parseMermaidBlocks(markdownText, sourceName) {
  const nodes = [];
  const edges = [];
  const errors = [];
  let m;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(markdownText))) {
    const body = m[1];
    const statements = splitStatements(body);
    for (const raw of statements) {
      const stmt = raw.trim();
      if (HEADER_RE.test(stmt)) continue;
      const { seq, arrowLabels, consumed } = parseStatement(stmt);
      if (seq.length === 0) {
        errors.push({
          code: 'parse-error',
          message: `${sourceName}: не удалось разобрать statement «${truncateForMessage(stmt)}»`,
          source: sourceName,
          text: stmt,
        });
        continue;
      }
      for (const item of seq) {
        nodes.push({ id: item.id, shape: item.shape, label: item.label, source: sourceName });
      }
      for (let i = 0; i < arrowLabels.length; i += 1) {
        edges.push({ from: seq[i].id, to: seq[i + 1].id, label: arrowLabels[i], source: sourceName });
      }
      const tail = stmt.slice(consumed).trim();
      if (tail) {
        errors.push({
          code: 'parse-error',
          message: `${sourceName}: нераспознанный остаток statement «${truncateForMessage(tail)}»`,
          source: sourceName,
          text: tail,
        });
      }
    }
  }
  return { nodes, edges, errors };
}

function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Минимальный glob: `*` в пределах одного сегмента пути, без `**`.
// Хватает для дефолтного `workflows/*.md` и разумных вариаций.
function expandGlob(baseDir, pattern) {
  const segments = pattern.split('/').filter((s) => s.length > 0);
  let dirs = [baseDir];
  for (let idx = 0; idx < segments.length; idx += 1) {
    const seg = segments[idx];
    const isLast = idx === segments.length - 1;
    const next = [];
    if (!seg.includes('*')) {
      for (const dir of dirs) {
        const candidate = join(dir, seg);
        if (!existsSync(candidate)) continue;
        const st = statSync(candidate);
        if (isLast ? st.isFile() : st.isDirectory()) next.push(candidate);
      }
    } else {
      const re = new RegExp(`^${seg.split('*').map(escapeRegExpLiteral).join('.*')}$`, 'i');
      for (const dir of dirs) {
        let entries = [];
        try {
          entries = readdirSync(dir);
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          if (!re.test(entry)) continue;
          const candidate = join(dir, entry);
          let st;
          try {
            st = statSync(candidate);
          } catch {
            continue;
          }
          if (isLast ? st.isFile() : st.isDirectory()) next.push(candidate);
        }
      }
    }
    dirs = next;
  }
  return dirs;
}

function toPosixRelative(baseDir, absPath) {
  return relative(baseDir, absPath).split(sep).join('/');
}

export class Graph {
  /**
   * @param {Array} nodeOccurrences — все вхождения id (определения и голые ссылки), с полем order
   * @param {Array} edges
   * @param {string[]} files — источники (для stats)
   * @param {Array} parseErrors — диагностики parseMermaidBlocks (code: 'parse-error')
   */
  constructor(nodeOccurrences, edges, files, parseErrors) {
    this._occurrences = nodeOccurrences;
    this._edges = edges;
    this._files = files;
    this._parseErrors = parseErrors || [];

    // Первое определение (shape !== null) на id, по возрастанию order.
    this._defined = new Map();
    for (const occ of nodeOccurrences) {
      if (occ.shape === null) continue;
      const existing = this._defined.get(occ.id);
      if (!existing || occ.order < existing.order) {
        this._defined.set(occ.id, occ);
      }
    }
  }

  node(id) {
    const occ = this._defined.get(id);
    if (!occ) return undefined;
    return this._toPublicNode(occ);
  }

  outgoing(id) {
    return this._edges
      .filter((e) => e.from === id)
      .map((e) => ({ to: e.to, label: e.label }));
  }

  _toPublicNode(occ) {
    const gm = NODE_ID_RE.exec(occ.id);
    return {
      id: occ.id,
      stage: gm ? Number(gm[1]) : null,
      type: gm ? gm[2] : null,
      num: gm ? Number(gm[3]) : null,
      label: occ.label,
      shape: occ.shape,
      source: occ.source,
    };
  }

  validate(railsConfig) {
    const cfg = railsConfig || {};
    const quoteMin = Number.isFinite(cfg.quote_min) ? cfg.quote_min : 25;
    // §7 «хук никогда не падает»: плохой конфиг (terminal/pause_nodes не массив) не должен
    // ронять validate() — new Set(число) бросает TypeError, new Set(строка) даёт Set из символов.
    const terminal = new Set(Array.isArray(cfg.terminal) ? cfg.terminal : []);
    const pauseNodes = new Set(Array.isArray(cfg.pause_nodes) ? cfg.pause_nodes : []);
    const errors = [];
    const warnings = [];

    // --- parse-error: диагностики разбора mermaid (§14, не молчаливая потеря) ---
    errors.push(...this._parseErrors);

    // --- bad-id: по всем встреченным id (определения и голые ссылки) ---
    const seenIds = new Set();
    for (const occ of this._occurrences) {
      if (seenIds.has(occ.id)) continue;
      seenIds.add(occ.id);
      if (!NODE_ID_RE.test(occ.id)) {
        errors.push({ code: 'bad-id', message: `Идентификатор «${occ.id}» не соответствует грамматике ^P(\\d+)([ERSGQ])(\\d+)$`, id: occ.id });
      }
    }

    // --- dup-id ---
    const byId = new Map();
    for (const occ of this._occurrences) {
      if (occ.shape === null) continue;
      if (!byId.has(occ.id)) byId.set(occ.id, []);
      byId.get(occ.id).push(occ);
    }
    for (const [id, occs] of byId) {
      if (occs.length > 1) {
        const sources = [...new Set(occs.map((o) => o.source))];
        errors.push({ code: 'dup-id', message: `Узел «${id}» определён повторно (${occs.length} раз, источники: ${sources.join(', ')})`, id, sources });
      }
    }

    // --- semicolon-in-label / short-label ---
    for (const [id, occ] of this._defined) {
      const label = occ.label || '';
      if (label.includes(';')) {
        // Проверено 2026-09-22 на mermaid 12.0.0: «;» внутри лейбла в кавычках разбирается штатно,
        // ломает разбор только «;» вне кавычек. Наша грамматика требует кавычки, поэтому — предупреждение.
        warnings.push({ code: 'semicolon-in-label', message: `Лейбл узла «${id}» содержит «;» — допустимо в кавычках, но лучше заменить`, id });
      }
      const gm = NODE_ID_RE.exec(id);
      const type = gm ? gm[2] : null;
      if (type && type !== 'E') {
        if (normalizeLabel(label).length < quoteMin) {
          errors.push({ code: 'short-label', message: `Лейбл узла «${id}» короче ${quoteMin} символов после нормализации`, id });
        }
      }
    }

    // --- unknown-target ---
    for (const e of this._edges) {
      if (!this._defined.has(e.from)) {
        errors.push({ code: 'unknown-target', message: `Ребро из «${e.from}» (${e.source}) ссылается на неопределённый узел «${e.from}»`, from: e.from, to: e.to, source: e.source });
      }
      if (!this._defined.has(e.to)) {
        errors.push({ code: 'unknown-target', message: `Ребро «${e.from}» → «${e.to}» (${e.source}) ссылается на неопределённый узел «${e.to}»`, from: e.from, to: e.to, source: e.source });
      }
    }

    // --- no-entry / bad-entry ---
    let entryValid = false;
    if (!cfg.entry) {
      errors.push({ code: 'no-entry', message: 'rails.yaml.entry не задан' });
    } else {
      const entryNode = this._defined.get(cfg.entry);
      if (!entryNode) {
        errors.push({ code: 'bad-entry', message: `rails.yaml.entry «${cfg.entry}» не определён в графе` });
      } else {
        const gm = NODE_ID_RE.exec(cfg.entry);
        if (!gm || gm[2] !== 'E') {
          errors.push({ code: 'bad-entry', message: `rails.yaml.entry «${cfg.entry}» не является E-узлом` });
        } else {
          entryValid = true;
        }
      }
    }

    // --- orphan (только если entry валиден) ---
    if (entryValid) {
      const adj = new Map();
      for (const e of this._edges) {
        if (!this._defined.has(e.to)) continue;
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
      }
      const visited = new Set([cfg.entry]);
      const queue = [cfg.entry];
      while (queue.length > 0) {
        const cur = queue.shift();
        for (const next of adj.get(cur) || []) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      for (const id of this._defined.keys()) {
        if (!visited.has(id)) {
          errors.push({ code: 'orphan', message: `Узел «${id}» недостижим из entry «${cfg.entry}»`, id });
        }
      }
    }

    // --- unknown-terminal / unknown-pause: опечатка в rails.yaml не должна тонуть ---
    for (const id of terminal) {
      if (!this._defined.has(id)) {
        errors.push({ code: 'unknown-terminal', message: `rails.yaml.terminal ссылается на неопределённый узел «${id}»`, id });
      }
    }
    for (const id of pauseNodes) {
      if (!this._defined.has(id)) {
        errors.push({ code: 'unknown-pause', message: `rails.yaml.pause_nodes ссылается на неопределённый узел «${id}»`, id });
      }
    }

    // --- dead-end ---
    const outCount = new Map();
    for (const e of this._edges) {
      outCount.set(e.from, (outCount.get(e.from) || 0) + 1);
    }
    for (const id of this._defined.keys()) {
      const n = outCount.get(id) || 0;
      if (n === 0 && !terminal.has(id) && !pauseNodes.has(id)) {
        errors.push({ code: 'dead-end', message: `У узла «${id}» нет исходящих рёбер, и он не в terminal/pause_nodes`, id });
      }
    }

    // --- группировка по этапам (только валидные id) ---
    const byStage = new Map();
    const orderedDefined = [...this._defined.values()].sort((a, b) => a.order - b.order);
    for (const occ of orderedDefined) {
      const gm = NODE_ID_RE.exec(occ.id);
      if (!gm) continue;
      const stage = Number(gm[1]);
      if (!byStage.has(stage)) byStage.set(stage, []);
      byStage.get(stage).push({ ...occ, type: gm[2] });
    }

    // --- stage-no-entry ---
    for (const [stage, occs] of byStage) {
      const entries = occs.filter((o) => o.type === 'E');
      if (entries.length !== 1) {
        errors.push({ code: 'stage-no-entry', message: `Этап ${stage}: E-узлов ${entries.length} (нужен ровно 1)`, stage, count: entries.length });
      }
    }

    // --- stage-order ---
    for (const [stage, occs] of byStage) {
      let sawNonRule = false;
      for (const occ of occs) {
        if (occ.type === 'S' || occ.type === 'G' || occ.type === 'Q') {
          sawNonRule = true;
        } else if (occ.type === 'R' && sawNonRule) {
          errors.push({ code: 'stage-order', message: `Этап ${stage}: правило «${occ.id}» определено после шага/гейта/выбора`, id: occ.id, stage });
        }
      }
    }

    // --- stage-collision ---
    for (const [stage, occs] of byStage) {
      const sources = [...new Set(occs.map((o) => o.source))];
      if (sources.length > 1) {
        errors.push({ code: 'stage-collision', message: `Этап ${stage} определён в нескольких файлах: ${sources.join(', ')}`, stage, sources });
      }
    }

    // --- gate-edges / unlabeled-branch ---
    for (const [id, occ] of this._defined) {
      const out = this._edges.filter((e) => e.from === id);
      const gm = NODE_ID_RE.exec(id);
      const type = gm ? gm[2] : null;
      if (type === 'G' || type === 'Q') {
        const unlabeled = out.some((e) => !e.label);
        if (out.length < 2 || unlabeled) {
          errors.push({ code: 'gate-edges', message: `Гейт/выбор «${id}»: ${out.length < 2 ? 'меньше двух исходящих рёбер' : 'есть ребро без метки'}`, id });
        }
      }
      // Для G/Q тот же дефект уже отражён как error gate-edges — не дублировать warning'ом.
      if (type !== 'G' && type !== 'Q' && out.length >= 2 && out.some((e) => !e.label)) {
        warnings.push({ code: 'unlabeled-branch', message: `У узла «${id}» с ${out.length} исходящими рёбрами есть ребро без метки`, id });
      }
      void occ;
    }

    // --- stats ---
    const nodesByType = { E: 0, R: 0, S: 0, G: 0, Q: 0 };
    for (const id of this._defined.keys()) {
      const gm = NODE_ID_RE.exec(id);
      if (gm) nodesByType[gm[2]] += 1;
    }
    const stats = {
      nodes: this._defined.size,
      nodesByType,
      edges: this._edges.length,
      stages: byStage.size,
      files: [...this._files],
    };

    return { errors, warnings, stats };
  }
}

/**
 * Собирает граф скила из SKILL.md и фрагментов (rails.yaml.fragments,
 * по умолчанию workflows/*.md), склеивая их в порядке SKILL.md → фрагменты
 * (в алфавитном порядке путей).
 * @param {string} skillDir
 * @param {object} railsConfig
 * @returns {Graph}
 */
export function loadSkillGraph(skillDir, railsConfig) {
  const cfg = railsConfig || {};
  const files = [];

  const skillMdPath = join(skillDir, 'SKILL.md');
  if (existsSync(skillMdPath)) {
    files.push({ path: skillMdPath, source: 'SKILL.md' });
  }

  // Плохой fragments (строка вместо массива, не-строковые элементы) не должен ронять
  // loadSkillGraph: берём только строки, а при пустом результате — дефолт §4.
  const rawPatterns = Array.isArray(cfg.fragments) ? cfg.fragments.filter((p) => typeof p === 'string') : [];
  const patterns = rawPatterns.length > 0 ? rawPatterns : ['workflows/*.md'];
  const fragPaths = new Set();
  for (const pattern of patterns) {
    for (const p of expandGlob(skillDir, pattern)) {
      if (p === skillMdPath) continue; // SKILL.md уже добавлен — не дублировать (ложный dup-id)
      fragPaths.add(p);
    }
  }
  // Байтовая сортировка (не localeCompare) — детерминизм между машинами/ICU (README «детерминированно, дёшево»).
  const sortedFrag = [...fragPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const p of sortedFrag) {
    files.push({ path: p, source: toPosixRelative(skillDir, p) });
  }

  const nodeOccurrences = [];
  const edges = [];
  const parseErrors = [];
  let order = 0;
  for (const f of files) {
    const text = readFileSync(f.path, 'utf8');
    const parsed = parseMermaidBlocks(text, f.source);
    for (const n of parsed.nodes) {
      nodeOccurrences.push({ ...n, order: order += 1 });
    }
    for (const e of parsed.edges) {
      edges.push(e);
    }
    for (const err of parsed.errors) {
      parseErrors.push(err);
    }
  }

  return new Graph(nodeOccurrences, edges, files.map((f) => f.source), parseErrors);
}

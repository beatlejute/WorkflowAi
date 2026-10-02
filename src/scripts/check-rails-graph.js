#!/usr/bin/env node

/**
 * check-rails-graph.js — обёртка над `rails cli check` (§10, §14).
 *
 * Привычный для агентов путь: `node src/scripts/check-rails-graph.js
 * --skill <name>` (или `--all`) вместо прямого вызова
 * `node .workflow/src/rails/cli.mjs check ...`. Аргументы передаются
 * `cli.mjs check` как есть; вывод `cli.mjs` печатается, затем — предупреждения
 * о цепочках правил (ruleChains) и стандартный для скриптов этого каталога
 * блок `---RESULT---` (см. `check-mcp.js`).
 *
 * Использование:
 *   node check-rails-graph.js --skill coach
 *   node check-rails-graph.js --all
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findProjectRoot } from '../lib/find-root.mjs';
import { run } from '../rails/cli.mjs';
import { loadSkillGraph } from '../rails/graph.mjs';
import { realpathDeep } from '../rails/paths.mjs';
import { loadRailsConfig } from '../rails/rails-config.mjs';

// Больше стольких узлов ПРАВИЛО подряд в одном этапе — предупреждение. Анализ прогонов
// 2026-09-30 (PulseProxy PLAN-020, ListeningGlass PLAN-001): у execute-task цепочки P0R1–P0R9 и
// P3R1–P3R8 дают 27 переходов до первой правки, переходы «правило → правило» — около 87 с на
// сессию (14–16%), а критерий оценки коуча «R-узлов 3–7» ничем не проверялся. Предупреждение,
// а не ошибка: решение о слиянии узлов принимает коуч.
export const MAX_RULE_CHAIN = 3;

const NODE_RE = /^P(\d+)([ERSGQ])(\d+)$/;

function emitResult(status, reason) {
  console.log('---RESULT---');
  console.log(`status: ${status}`);
  if (reason) console.log(`reason: ${reason}`);
  console.log('---RESULT---');
}

/**
 * Цепочки узлов ПРАВИЛО одного этапа, идущих подряд по рёбрам графа, длиннее `max`:
 * самый длинный путь по R-узлам этапа от R-узла, в который входят не из R-узла того же этапа
 * (или не входят вовсе). Цепочка, целиком лежащая в уже найденной, не повторяется. Узлы —
 * достижимые из `entry` (недостижимые — ошибка orphan самого check).
 *
 * @param {{outgoing(id: string): Array<{to: string}>}} graph
 * @param {string} entry
 * @param {number} [max]
 * @returns {Array<{stage: number, ids: string[]}>}
 */
export function ruleChains(graph, entry, max = MAX_RULE_CHAIN) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const { to } of graph.outgoing(id) || []) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  const rule = (id) => {
    const m = NODE_RE.exec(id);
    return m && m[2] === 'R' ? Number(m[1]) : null;
  };
  const next = (id) => (graph.outgoing(id) || []).map((e) => e.to).filter((to) => seen.has(to) && rule(to) !== null && rule(to) === rule(id));
  const rules = [...seen].filter((id) => rule(id) !== null);
  const preds = new Map();
  for (const id of seen) {
    for (const { to } of graph.outgoing(id) || []) {
      if (!preds.has(to)) preds.set(to, []);
      preds.get(to).push(id);
    }
  }
  const isStart = (id) => {
    const p = preds.get(id) ?? [];
    return p.length === 0 || p.some((from) => rule(from) === null || rule(from) !== rule(id));
  };
  const longest = (id, path) => {
    let best = [...path, id];
    for (const to of next(id)) {
      if (path.includes(to) || to === id) continue;
      const cand = longest(to, [...path, id]);
      if (cand.length > best.length) best = cand;
    }
    return best;
  };
  const found = rules.filter(isStart).map((start) => longest(start, [])).filter((ids) => ids.length > max);
  found.sort((a, b) => b.length - a.length);
  const chains = [];
  const covered = new Set();
  for (const ids of found) {
    if (ids.every((id) => covered.has(id))) continue;
    chains.push({ stage: rule(ids[0]), ids });
    for (const id of ids) covered.add(id);
  }
  const num = (id) => NODE_RE.exec(id).slice(1).map((x, i) => (i === 1 ? x : Number(x)));
  return chains.sort((a, b) => a.stage - b.stage || num(a.ids[0])[2] - num(b.ids[0])[2]);
}

/**
 * Строки предупреждений о цепочках правил для скилов `skills` проекта `root`. Скил, чей граф
 * не загрузился, пропускается: его ошибку уже напечатал `cli.mjs check`.
 *
 * @param {string} root
 * @param {string[]} skills
 * @returns {string[]}
 */
export function ruleChainWarnings(root, skills) {
  const lines = [];
  for (const skill of skills) {
    const dir = join(root, '.workflow', 'src', 'skills', skill);
    let chains;
    try {
      const config = loadRailsConfig(dir);
      chains = ruleChains(loadSkillGraph(dir, config), config.entry);
    } catch {
      continue;
    }
    for (const c of chains) {
      const shown = c.ids.length > 6 ? [...c.ids.slice(0, 3), '…', ...c.ids.slice(-2)] : c.ids;
      lines.push(
        `  [warn:rule-chain] Скил "${skill}", этап ${c.stage}: ${c.ids.length} ${nodesWord(c.ids.length)} ПРАВИЛО подряд (${shown.join(' → ')}) — больше ${MAX_RULE_CHAIN}; это самый длинный путь по правилам этапа, ветвления в нём возможны — правила, которые агент проходит подряд, лучше слить в R-узел со списком`
      );
    }
  }
  return lines;
}

function nodesWord(n) {
  const d = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'узлов';
  if (d === 1) return 'узел';
  return d >= 2 && d <= 4 ? 'узла' : 'узлов';
}

// Скилы из аргументов check — тем же порядком, что `cli.mjs check` (cmdCheck, parseArgs): сначала
// `--all` (все каталоги скилов с rails.yaml), затем `--skill <name>`; значение флага — следующий
// токен, если он не начинается с `--`, иначе флаг булев. Ревью 2026-10-01: при `--all --skill x`
// cli проверял все скилы, а предупреждения печатались только для x.
export function skillsFromArgs(root, args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (!a.startsWith('--')) continue;
    const next = args[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      flags[a.slice(2)] = next;
      i += 1;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  if (!flags.all) return flags.skill ? [String(flags.skill)] : [];
  const dir = join(root, '.workflow', 'src', 'skills');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, 'rails.yaml')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export async function main() {
  const args = process.argv.slice(2);
  const argv = ['check', ...args];
  const { code, stdout } = run(argv, { cwd: process.cwd(), env: process.env });
  if (stdout) process.stdout.write(stdout);

  let warnings = [];
  try {
    const root = findProjectRoot(process.cwd());
    warnings = ruleChainWarnings(root, skillsFromArgs(root, args));
  } catch {
    warnings = []; // корня нет — об этом уже сказал cli.mjs check
  }
  if (warnings.length > 0) process.stdout.write(`\nЦепочки правил (предупреждение, не ошибка):\n${warnings.join('\n')}\n`);

  // Конвенция check-mcp.js: exit code всегда 0, логический результат — в status
  // (runner переписывает статус тикета на failed при exitCode != 0, что ломает маршрутизацию).
  emitResult(code === 0 ? 'ok' : 'fail', code === 0 ? 'граф и rails.yaml валидны' : 'найдены ошибки — см. вывод выше');
  process.exit(0);
}

// Дословное сравнение `import.meta.url === pathToFileURL(argv[1]).href` ломается
// в продакшн-раскладке: `<root>/.workflow/src/scripts` — junction на канон (§2, §11),
// Node при этом реалпасит `import.meta.url` главного модуля, а `process.argv[1]`
// оставляет путём как он был передан (через junction) — строки расходятся, и
// main() не вызывается. Сравнение — только через realpath обеих сторон.
function isDirectRun() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const self = realpathDeep(fileURLToPath(import.meta.url));
    const entry = realpathDeep(argv1);
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(`[ERROR] ${e && e.message ? e.message : e}`);
    emitResult('fail', String(e && e.message ? e.message : e));
    process.exit(0);
  });
}

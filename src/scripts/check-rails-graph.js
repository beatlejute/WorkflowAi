#!/usr/bin/env node

/**
 * check-rails-graph.js — обёртка над `rails cli check` (§10, §14).
 *
 * Привычный для агентов путь: `node src/scripts/check-rails-graph.js
 * --skill <name>` (или `--all`) вместо прямого вызова
 * `node .workflow/src/rails/cli.mjs check ...`. Аргументы передаются
 * `cli.mjs check` как есть; вывод `cli.mjs` печатается, затем — стандартный
 * для скриптов этого каталога блок `---RESULT---` (см. `check-mcp.js`).
 *
 * Использование:
 *   node check-rails-graph.js --skill coach
 *   node check-rails-graph.js --all
 */

import { fileURLToPath } from 'node:url';

import { run } from '../rails/cli.mjs';
import { realpathDeep } from '../rails/paths.mjs';

function emitResult(status, reason) {
  console.log('---RESULT---');
  console.log(`status: ${status}`);
  if (reason) console.log(`reason: ${reason}`);
  console.log('---RESULT---');
}

export async function main() {
  const argv = ['check', ...process.argv.slice(2)];
  const { code, stdout } = run(argv, { cwd: process.cwd(), env: process.env });
  if (stdout) process.stdout.write(stdout);

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

#!/usr/bin/env node

/**
 * Обнуление истории модели в журнале запусков проекта (PLAN-004, решение 1, В8).
 *
 * Дописывает в `.workflow/metrics/agent-runs.jsonl` событие
 * `{"type":"reset","ts":…,"model":…,"reason":…}` (recordReset, src/lib/agent-runs.mjs):
 * запуски модели до него выпадают из градаций, запретов и таблицы статистики (MCP
 * `get_model_stats`). Журнал не переписывается — только дописывается.
 *
 *   node .workflow/src/scripts/reset-model-history.js --model <ключ> --reason <текст>
 *
 * Ключ — как в поле `model` событий `run` (например `vendor/model:free`), передаётся
 * как есть. Корень проекта — ближайший вверх от рабочего каталога с `.workflow/`.
 *
 * Ответ:
 *   ---RESULT---
 *   status: ok
 *   model: <ключ>
 *   ---RESULT---
 * Ошибка — `status: error`, `code` (BAD_INPUT — нет или неизвестный аргумент;
 * NO_PROJECT — корень проекта не найден; READ_FAILED, NO_RUNS, WRITE_FAILED — от
 * recordReset), `error` и код выхода 1; строка в журнал не пишется.
 */

import { findProjectRoot } from '../lib/find-root.mjs';
import { recordReset } from '../lib/agent-runs.mjs';
import { printResult } from '../lib/utils.mjs';

const USAGE = 'usage: reset-model-history.js --model <key> --reason <text>';

class ResetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--model' && arg !== '--reason') throw new ResetError('BAD_INPUT', `unknown argument "${arg}"; ${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined) throw new ResetError('BAD_INPUT', `${arg} needs a value; ${USAGE}`);
    opts[arg.slice(2)] = value;
    i++;
  }
  return opts;
}

function main() {
  try {
    const { model, reason } = parseArgs(process.argv.slice(2));
    let projectRoot;
    try {
      projectRoot = findProjectRoot();
    } catch (err) {
      throw new ResetError('NO_PROJECT', err.message);
    }
    const result = recordReset(projectRoot, { model, reason });
    if (!result.ok) throw new ResetError(result.code, result.error);
    printResult({ status: 'ok', model: result.event.model });
    return 0;
  } catch (err) {
    printResult({
      status: 'error',
      code: err instanceof ResetError ? err.code : 'ERROR',
      error: String(err.message).replace(/\s+/g, ' ').trim(),
    });
    return 1;
  }
}

// Код выхода без process.exit: он не ждёт незавершённой записи в stdout (документация
// Node, process.exit), и блок RESULT мог бы оборваться.
process.exitCode = main();

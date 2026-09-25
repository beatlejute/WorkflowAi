#!/usr/bin/env node
// Mock target agent — проверяет, что раннер передал агенту границу записи.
// Раннер запускает агента с cwd = рабочий каталог прогона. WORKFLOW_SANDBOX_ROOT
// задан и указывает на этот каталог → MOCK_HIGH_SCORE (pass), иначе MOCK_LOW_SCORE.

import { realpathSync } from 'node:fs';

const root = process.env.WORKFLOW_SANDBOX_ROOT;
let same = false;
try {
  same = Boolean(root) && realpathSync(root) === realpathSync(process.cwd());
} catch {
  same = false;
}

console.log('---RESULT---');
console.log('status: passed');
console.log(same
  ? 'output: MOCK_HIGH_SCORE sandbox root is the workdir.'
  : `output: MOCK_LOW_SCORE sandbox root ${root ?? '(unset)'} is not the workdir.`);
console.log('---RESULT---');

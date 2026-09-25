#!/usr/bin/env node
// Mock target agent — проверяет, что PWD агента = его рабочий каталог.
// `kilo run` 7.7.x берёт каталог проекта из PWD, а раннер, запущенный из Git Bash,
// наследует PWD каталога запуска: 2026-09-23 и 2026-09-25 Kilo-агенты тестов
// работали в настоящем проекте вместо песочницы. PWD = cwd → MOCK_HIGH_SCORE (pass),
// иначе MOCK_LOW_SCORE.

import { realpathSync } from 'node:fs';

const pwd = process.env.PWD;
let same = false;
try {
  same = Boolean(pwd) && realpathSync(pwd) === realpathSync(process.cwd());
} catch {
  same = false;
}

console.log('---RESULT---');
console.log('status: passed');
console.log(same
  ? 'output: MOCK_HIGH_SCORE PWD is the workdir.'
  : `output: MOCK_LOW_SCORE PWD ${pwd ?? '(unset)'} is not the workdir ${process.cwd()}.`);
console.log('---RESULT---');

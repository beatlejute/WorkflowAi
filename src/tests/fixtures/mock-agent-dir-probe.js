#!/usr/bin/env node
// Mock target agent — проверяет, что вход kind: dir разложен в рабочий каталог.
// Раннер запускает агента с cwd = рабочий каталог прогона. Файл-зонд на месте и
// с ожидаемым содержимым → MOCK_HIGH_SCORE (pass), иначе MOCK_LOW_SCORE (fail).

import { existsSync, readFileSync } from 'node:fs';

const PROBE = 'project/nested/probe.txt';
const found = existsSync(PROBE) && readFileSync(PROBE, 'utf8').includes('DIR_PROBE_OK');

console.log('---RESULT---');
console.log('status: passed');
console.log(found
  ? 'output: MOCK_HIGH_SCORE fixture directory is in the workdir.'
  : `output: MOCK_LOW_SCORE ${PROBE} is missing from the workdir.`);
console.log('---RESULT---');

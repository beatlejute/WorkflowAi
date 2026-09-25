#!/usr/bin/env node
// Mock target agent для скила на рельсах: при первом запуске в рабочем каталоге
// пишет состояние сессии rails с WORKFLOW_RAILS_RUN (как хук после вызова
// инструмента), при повторе — нет. Ответ не содержит ничего из final_requires
// фикстуры, поэтому раннер делает повтор по output-check, и повтор проходит
// без состояния в песочнице.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), '.workflow', 'state', 'rails');
const marker = join(dir, '.rails-once-marker');
if (!existsSync(marker) && process.env.WORKFLOW_RAILS_RUN) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mock-session.json'), JSON.stringify({ run: process.env.WORKFLOW_RAILS_RUN, node: 'P0S1' }));
  writeFileSync(marker, '');
}

console.log('---RESULT---');
console.log('status: passed');
console.log('output: MOCK_HIGH_SCORE response without the required rails token.');
console.log('---RESULT---');

#!/usr/bin/env node
// Mock judge — score 5, только если раннер передал судье границу записи
// (WORKFLOW_SANDBOX_ROOT указывает на существующий каталог прогона) и исполнитель
// ответил MOCK_HIGH_SCORE; иначе score 2.

import { existsSync, statSync } from 'node:fs';

const prompt = process.argv[process.argv.length - 1] || '';
const root = process.env.WORKFLOW_SANDBOX_ROOT;
const hasSandbox = Boolean(root) && existsSync(root) && statSync(root).isDirectory();
const score = hasSandbox && prompt.includes('MOCK_HIGH_SCORE') ? 5 : 2;

console.log('---RESULT---');
console.log(`score: ${score}`);
console.log(`reason: sandbox ${hasSandbox ? 'present' : 'missing'}`);
console.log('---RESULT---');

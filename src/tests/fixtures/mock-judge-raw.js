#!/usr/bin/env node
// Mock judge — печатает текст из своего первого аргумента как ответ судьи.
// Промпт раннер добавляет последним аргументом; мок его не читает.
//
//   args: ["src/tests/fixtures/mock-judge-raw.js", "score: 2"]         → балл 2
//   args: ["src/tests/fixtures/mock-judge-raw.js", "оценки не будет"]  → ответ без балла
//   args: ["src/tests/fixtures/mock-judge-raw.js", "score: 7"]         → балл вне 1..5

const text = process.argv[2] || '';

console.log('---RESULT---');
console.log(text);
console.log('reason: mock judge with a fixed answer');
console.log('---RESULT---');

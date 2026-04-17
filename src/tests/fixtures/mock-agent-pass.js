#!/usr/bin/env node
// Mock target agent — всегда возвращает высокий score (pass)
// Используется в L2 unit-тестах для имитации агента, который проходит оценку

console.log('---RESULT---');
console.log('status: passed');
console.log('output: MOCK_HIGH_SCORE This is a high quality response that deserves a high score.');
console.log('---RESULT---');

#!/usr/bin/env node
// Mock target agent — всегда возвращает низкий score (fail)
// Используется в L2 unit-тестах для имитации агента, который не проходит оценку

console.log('---RESULT---');
console.log('status: passed');
console.log('output: MOCK_LOW_SCORE This is a low quality response that should receive a low score.');
console.log('---RESULT---');

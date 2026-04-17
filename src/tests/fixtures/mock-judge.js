#!/usr/bin/env node
// Mock judge agent — возвращает score на основе маркеров в промпте
// Используется в L2 unit-тестах для имитации judge без реальных LLM вызовов
//
// Логика:
//   MOCK_LOW_SCORE или CALIBRATION_BAD_LOW в промпте  → score: 2 (fail)
//   CALIBRATION_GOOD_LOW в промпте                    → score: 2 (calibration bad good response)
//   CALIBRATION_BAD_HIGH в промпте                    → score: 5 (calibration bad bad response with high score)
//   По умолчанию                                      → score: 5 (pass)

const prompt = process.argv[process.argv.length - 1] || '';

let score = 5;

if (prompt.includes('MOCK_LOW_SCORE') || prompt.includes('CALIBRATION_BAD_LOW')) {
  score = 2;
} else if (prompt.includes('CALIBRATION_GOOD_LOW')) {
  score = 2;
} else if (prompt.includes('CALIBRATION_BAD_HIGH')) {
  score = 5;
}

console.log('---RESULT---');
console.log(`score: ${score}`);
console.log('reason: mock judge decision based on output markers');
console.log('---RESULT---');

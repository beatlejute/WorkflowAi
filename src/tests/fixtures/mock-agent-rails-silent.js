#!/usr/bin/env node
// Mock target agent для скила на рельсах: ни одного вызова инструмента — состояния
// сессии rails не пишет никогда, отвечает высшим баллом (так 2026-09-25 отвечала
// gpt-luna). Если промпт начинается с вердикта «ни одного вызова инструмента под
// рельсами», печатает маркер с командой start из вердикта — тест видит, что повтор
// получил вердикт и готовую команду.

const prompt = process.argv[process.argv.length - 1] || '';
const start = /^RAILS: предыдущий ответ отклонён — скил[^\n]*?`(node \S+ start \S+)`/.exec(prompt);

console.log('---RESULT---');
console.log('status: passed');
console.log(`output: MOCK_HIGH_SCORE answer without tools.${start ? ` SAW_START_VERDICT ${start[1]}` : ''}`);
console.log('---RESULT---');

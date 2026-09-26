#!/usr/bin/env node
// Мок `claude -p --input-format stream-json --output-format stream-json` для
// src/tests/claude-judge.test.mjs. Пишет в MOCK_CLAUDE_LOG полученные аргументы,
// рабочий каталог и сообщение stdin; отвечает строками init и result.
//   MOCK_CLAUDE_TEXT  — текст result (по умолчанию блок со score: 4)
//   MOCK_CLAUDE_ERROR — '1': result с is_error
//   MOCK_CLAUDE_EXIT  — код выхода
//   MOCK_CLAUDE_SLEEP — пауза перед ответом, мс
import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf-8');
if (process.env.MOCK_CLAUDE_LOG) {
  fs.writeFileSync(process.env.MOCK_CLAUDE_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    message: JSON.parse(input.trim()),
  }));
}
const text = process.env.MOCK_CLAUDE_TEXT ?? '---RESULT---\nscore: 4\nreason: evidence confirms the item\n---RESULT---';
const answer = () => {
  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'mock-model', tools: [] })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    is_error: process.env.MOCK_CLAUDE_ERROR === '1',
    result: text,
    total_cost_usd: 0.0123,
  })}\n`);
  process.exit(Number(process.env.MOCK_CLAUDE_EXIT || 0));
};
setTimeout(answer, Number(process.env.MOCK_CLAUDE_SLEEP || 0));

#!/usr/bin/env node

/**
 * Обёртка агента pi для стадий пайплайна.
 *
 * pi ходит в удалённый Ollama корпоративной сети (10.x) напрямую, а машинный
 * agent.env задаёт агентам HTTP_PROXY/HTTPS_PROXY — через них 10.x недостижим.
 * Обёртка снимает переменные прокси у себя и у дочернего pi, читает промпт
 * из stdin (prompt_stdin: true у агента конфига) и передаёт его pi -p.
 * Аргументы обёртки пробрасываются pi как есть (--provider, --model, ...).
 *
 * Код выхода и вывод — как у pi: финальный ответ агента в stdout.
 */

import { spawn } from 'node:child_process';

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(https?_proxy|all_proxy)$/i.test(key)) delete env[key];
}

const args = process.argv.slice(2);
const child = spawn('pi', ['-p', '--no-session', ...args], {
  env,
  stdio: ['pipe', 'inherit', 'inherit'],
  // На Windows pi — pi.cmd из npm: без shell spawn его не находит (ENOENT).
  shell: process.platform === 'win32',
  windowsHide: true,
});
process.stdin.pipe(child.stdin);
child.on('error', (err) => {
  console.error(`pi-agent: не удалось запустить pi: ${err.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});

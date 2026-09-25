/**
 * Окружение дочерних процессов агентов: process.env раннера + машинный файл
 * `<WORKFLOW_HOME>/agent.env` + доплата вызывающего кода (rails и т.п.).
 *
 * Инцидент 2026-09-24 (PulseProxy, pipeline_2026-09-24_14-56-55): прямой выход
 * машины в сеть — Россия, шлюз kilo и OpenAI отвечают на него 403 Forbidden.
 * Прокси подставляла обёртка kilo.cmd, а автообновление kilo до 7.7.9
 * перезаписало её штатным npm-шимом. Раннер, запущенный из расширения VS Code,
 * наследует окружение extension host без прокси — все kilo-агенты (включая
 * платный gpt-luna) упали с 403. Файл agent.env задаёт прокси агентам в самом
 * раннере и не зависит ни от обёрток CLI, ни от того, кто запустил раннер.
 *
 * Формат: строки `KEY=VALUE`; комментарий — только целая строка, начинающаяся
 * с `#` (`#` внутри значения — часть значения: пароль прокси может его
 * содержать); пустые строки пропускаются, значение в парных кавычках '…' / "…"
 * снимается. Пустое значение (`KEY=`) убирает переменную из окружения агента —
 * как `set KEY=` в cmd. Файл машинный, лежит вне git (в нём бывают учётные
 * данные прокси): в лог идут только имена переменных, значения — никогда.
 * Файл перечитывается при каждом запуске агента: правка действует без
 * перезапуска раннера. Отсутствие файла — обычный случай, окружение не меняется
 * и в лог ничего не пишется; нечитаемый файл и строки не по формату — WARN с
 * путём и номерами строк (иначе опечатка молча возвращает те же 403).
 *
 * Порядок: process.env < agent.env < extra. Файл перекрывает окружение раннера
 * намеренно: это явное объявление окружения агентов на этой машине (у обёртки
 * kilo.mod.cmd та же семантика). Доплата вызывающего кода (WORKFLOW_RAILS_*)
 * главнее файла — её выставляет сам раннер.
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { getGlobalDir } from '../global-dir.mjs';

export const AGENT_ENV_FILE = 'agent.env';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function agentEnvPath() {
  return join(getGlobalDir(), AGENT_ENV_FILE);
}

/**
 * Разбор текста agent.env. Строки без `=` или с недопустимым именем попадают в
 * `invalid` (номера строк с 1) и не применяются.
 * @returns {{ set: Record<string,string>, unset: string[], invalid: number[] }}
 */
export function parseAgentEnv(text) {
  const set = {};
  const unset = [];
  const invalid = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!KEY_RE.test(key)) {
      invalid.push(i + 1);
      return;
    }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    delete set[key];
    const u = unset.indexOf(key);
    if (u !== -1) unset.splice(u, 1);
    if (value === '') unset.push(key);
    else set[key] = value;
  });
  return { set, unset, invalid };
}

/**
 * Содержимое agent.env; null — файла нет. Нечитаемый файл (EACCES, EISDIR, …)
 * отличается от отсутствующего: пустой разбор с полем `error` (код ошибки).
 */
export function readAgentEnv(filePath = agentEnvPath()) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { set: {}, unset: [], invalid: [], error: (err && err.code) || String(err) };
  }
  return parseAgentEnv(text);
}

function report(logger, stageId, filePath, file) {
  if (!logger) return;
  if (file.error) {
    logger.warn(`agent.env не прочитан (${file.error}): ${filePath} — окружение агента без него`, stageId);
    return;
  }
  if (file.invalid.length) {
    logger.warn(`agent.env: строки ${file.invalid.join(', ')} не по формату KEY=VALUE и пропущены: ${filePath}`, stageId);
  }
  const set = Object.keys(file.set);
  if (set.length || file.unset.length) {
    const parts = [];
    if (set.length) parts.push(`задано ${set.join(', ')}`);
    if (file.unset.length) parts.push(`снято ${file.unset.join(', ')}`);
    logger.info(`agent.env: ${parts.join('; ')}`, stageId);
  }
}

// На Windows имена переменных окружения регистронезависимы, а копия
// `{ ...process.env }` — обычный объект: HTTPS_PROXY из файла рядом с
// унаследованным https_proxy дал бы два ключа, и какой из них получит
// процесс, не определено. Поэтому перед записью убираем все регистровые
// варианты имени.
function deleteKey(env, key, isWin) {
  if (!isWin) {
    delete env[key];
    return;
  }
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) delete env[k];
  }
}

function applyLayer(env, layer, isWin) {
  for (const [key, value] of Object.entries(layer)) {
    deleteKey(env, key, isWin);
    env[key] = value;
  }
}

/**
 * Окружение дочернего процесса агента.
 * @param {object} [baseEnv=process.env]
 * @param {object} [extra] — доплата вызывающего кода, главнее файла
 * @param {{ filePath?: string, platform?: string, logger?: object, stageId?: string }} [opts]
 *   logger — логгер раннера (info/warn(message, stageId)): имена применённых
 *   переменных и проблемы файла; без логгера — молча.
 */
export function buildAgentEnv(baseEnv = process.env, extra = null, opts = {}) {
  const isWin = (opts.platform || process.platform) === 'win32';
  const env = { ...baseEnv };
  const filePath = opts.filePath || agentEnvPath();
  const file = readAgentEnv(filePath);
  if (file) {
    report(opts.logger, opts.stageId, filePath, file);
    for (const key of file.unset) deleteKey(env, key, isWin);
    applyLayer(env, file.set, isWin);
  }
  if (extra) applyLayer(env, extra, isWin);
  return env;
}

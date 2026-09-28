#!/usr/bin/env node

/**
 * Шлагбаум места пула моделей по счётчику бесплатных запросов аккаунта
 * (`models.gate` пула в pipeline.yaml).
 *
 * Раннер вызывает команду перед запуском участника пула. Скрипт читает счётчик
 * одним GET и отвечает, открыто ли место: исчерпанный дневной счётчик аккаунта —
 * штатная ситуация, место пула закрывается до 00:00 UTC, стадия берёт следующее
 * место списка. Чтение счётчика модель не вызывает и запрос не тратит — это не
 * проверка модели перед запуском.
 *
 *   node free-quota-gate.js --url <https://…/key> --key-file <путь> [--timeout <с>]
 *
 * Адрес — только из аргументов. Один GET без повторов с `Authorization: Bearer`,
 * таймаут запроса — `--timeout`, по умолчанию 10 с: раннер снимает команду через
 * 15 с, повторы с паузами в них не уложились бы, а сбой место не закрывает —
 * следующий вызов будет перед следующим запуском участника. Прокси и допуск
 * `http:` только для своей машины — как у клиента модели (lib/model-client.mjs,
 * getJson). Ключ — файл `--key-file` (`~` — домашний каталог), в вывод он не
 * попадает.
 *
 * Ответ по полю `data.free_model_daily_requests` ответа:
 *   ---RESULT---
 *   status: <open — remaining > 0 | closed — remaining ≤ 0>
 *   remaining: <число>
 *   used: <число, если есть>
 *   limit: <число, если есть>
 *   ---RESULT---
 * и код выхода 0. Поля нет, `remaining` не число, ответ не JSON, ошибка сети или
 * HTTP не 2xx — `status: error`, `error_class`, `error` и код выхода 1: раннер
 * пишет WARN и место не закрывает.
 */

import { getJson, resolveModelKey, ModelClientError, redactNetworkDetail } from '../lib/model-client.mjs';

const DEFAULT_TIMEOUT_S = 10;

class GateError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.class = errorClass;
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new GateError('usage', `${arg} needs a value`);
      i++;
      return value;
    };
    if (arg === '--url') opts.url = take();
    else if (arg === '--key-file') opts.keyFile = take();
    else if (arg === '--timeout') opts.timeout = Number(take());
    else throw new GateError('usage', `unknown argument: ${arg}`);
  }
  for (const [flag, value] of [['--url', opts.url], ['--key-file', opts.keyFile]]) {
    if (!value) throw new GateError('usage', `${flag} is required`);
  }
  if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new GateError('usage', '--timeout must be a number > 0');
  }
  opts.timeout ??= DEFAULT_TIMEOUT_S;
  return opts;
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function printResult(fields) {
  const lines = ['---RESULT---'];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push('---RESULT---');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function gate(opts) {
  const key = resolveModelKey({ id: 'free-quota-gate', auth: { file: opts.keyFile } });
  const json = await getJson(opts.url, { key, timeoutS: opts.timeout });
  const counter = json?.data?.free_model_daily_requests;
  if (!counter || typeof counter !== 'object' || !isNumber(counter.remaining)) {
    throw new GateError('bad_response', 'response has no numeric data.free_model_daily_requests.remaining');
  }
  return {
    status: counter.remaining > 0 ? 'open' : 'closed',
    remaining: counter.remaining,
    ...(isNumber(counter.used) ? { used: counter.used } : {}),
    ...(isNumber(counter.limit) ? { limit: counter.limit } : {}),
  };
}

async function main() {
  try {
    printResult(await gate(parseArgs(process.argv.slice(2))));
    return 0;
  } catch (err) {
    const errorClass = err instanceof GateError || err instanceof ModelClientError ? err.class : 'gate_error';
    printResult({
      status: 'error',
      error_class: errorClass,
      error: redactNetworkDetail(err.message).replace(/\s+/g, ' ').trim(),
    });
    return 1;
  }
}

// Код выхода — process.exitCode, а не process.exit: на POSIX запись в трубу асинхронна,
// и process.exit сразу после печати обрезал бы вывод сверх буфера трубы.
main().then((code) => { process.exitCode = code; });

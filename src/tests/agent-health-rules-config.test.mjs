/**
 * Поставляемый configs/agent-health-rules.yaml: общее правило ограничения провайдера
 * (`provider-rate-limit`) и совместимость файла с раннерами прежних версий.
 *
 * Ограничение провайдера (HTTP 429, rate limit, quota exceeded, too many requests) —
 * не дефект модели: журнал запусков даёт такому запуску (статус `rate_limit`)
 * градацию `throttled` без временного запрета модели (src/lib/agent-runs.mjs), а
 * агента выводит из выбора health-реестр по этому правилу. Случай 2026-09-27,
 * PulseProxy: kilo-роутер упал с «Error: [Poolside] Rate limit exceeded», ни одно
 * правило не сработало, и модель получила часовой запрет по умолчанию.
 *
 * Что охраняется:
 *  - каждый шаблон файла собирается обычным `new RegExp(pattern)` без флагов и без
 *    встроенных модификаторов (`(?i)`, `(?i:…)`): файл лежит в общей папке конфигов
 *    (~/.workflow/configs, `.workflow/config` проектов — ссылка на неё), и раннер
 *    прежней версии, который ещё работает, читает его в конструкторе StageExecutor
 *    на каждой стадии — неразборчивый шаблон обрывал бы каждую стадию;
 *  - одно определение ограничения на два слоя: `pattern` правила — дословно
 *    PROVIDER_RATE_LIMIT_PATTERN, по которому classifyAgentResult даёт `rate_limit`;
 *  - ограничение засчитывается, только если запуск на нём закончился (три последние
 *    строки stderr): живой итог kilo, многострочный текст квоты Gemini, записи 429
 *    с `status`/`code`/`HTTP`/`error`, строки с CRLF;
 *  - 429 и текст лимита в середине stderr — не ограничение: kilo повторил запрос и
 *    упал на другом, стек `file:429:17`, размер 429 в выводе `ls`, строка истории
 *    `| rate_limit |` в диффе тикета; в том числе stderr длиннее 64 КБ, который
 *    classify режет до начала и конца — оба слоя смотрят конец и совпадают;
 *  - при ограничении в конце и сетевой ошибке раньше побеждает ограничение;
 *  - ни одно правило агента в конфиге не перехватывает общий текст ограничения:
 *    TTL — общего правила, а не до полуночи UTC, и онлайн-скан stderr агента не
 *    снимает — роутер, который сам повторяет запросы после 429, в том случае
 *    сделал 47 шагов.
 *
 * Агенты перебираются из самого конфига: имён агентов в тесте нет.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-health-rules-config.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { load as loadYaml } from '../lib/js-yaml.mjs';
import { loadRules, classifySync, scanStderrForFatalRule } from '../lib/error-classifier.mjs';
import { classifyAgentResult, PROVIDER_RATE_LIMIT_PATTERN } from '../lib/agent-history.mjs';

const CONFIG = fileURLToPath(new URL('../../configs/agent-health-rules.yaml', import.meta.url));
const RULE_ID = 'provider-rate-limit';
// Агент без своих правил: классификация идёт только по общим.
const PLAIN_AGENT = 'agent-without-own-rules';

// Строки stderr kilo из лога PulseProxy pipeline_2026-09-27_11-29-19.log: повтор после
// 429 по ходу работы, запись о сбое процесса и итог запуска.
const LIVE_STREAM_ERROR = 'timestamp=2026-09-27T11:40:25.237Z level=ERROR run=934d5fa5 message="stream error" providerID=router modelID=router/model-a error.error="AI_APICallError: [Poolside] Rate limit exceeded"';
const LIVE_PROCESS = 'timestamp=2026-09-27T11:55:10.616Z level=ERROR run=934d5fa5 message=process error="[Poolside] Rate limit exceeded" stack="AI_APICallError: [Poolside] Rate limit exceeded\\n    at <anonymous> (B:/~BUN/root/src/index.js:463:11034)"';
const LIVE_EXIT = '\x1b[91m\x1b[1mError: \x1b[0m[Poolside] Rate limit exceeded';
const WORK = Array.from({ length: 12 }, (_, i) => `\x1b[0m→ \x1b[0mRead src/module-${i}.ts`).join('\n');
// Итог kilo на квоте Gemini из лога PulseProxy pipeline_2026-09-25_11-53-04.log (сокращён).
const GEMINI_EXIT = [
  '\x1b[91m\x1b[1mError: \x1b[0mYou exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. ',
  '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20',
  'Please retry in 18.115952857s.',
].join('\n');
// Итог kilo на другой ошибке: «stream error», «message=process» и «Error: …» последней попытки.
const OTHER_EXIT = [
  'timestamp=2026-09-27T12:00:00.000Z level=ERROR message="stream error" error.error="AI_APICallError: Internal Server Error"',
  'timestamp=2026-09-27T12:00:00.002Z level=ERROR message=process error="Internal Server Error"',
  '\x1b[91m\x1b[1mError: \x1b[0mInternal Server Error',
].join('\n');

const THROTTLED_ENDINGS = {
  'живой итог kilo': [WORK, LIVE_STREAM_ERROR, WORK, LIVE_STREAM_ERROR, LIVE_PROCESS, LIVE_EXIT].join('\n') + '\n',
  'живой итог kilo, CRLF': [WORK, LIVE_STREAM_ERROR, LIVE_PROCESS, LIVE_EXIT].join('\r\n') + '\r\n',
  'квота Gemini, три строки': `${WORK}\n${GEMINI_EXIT}\n`,
  'HTTP 429 Too Many Requests': 'HTTP 429 Too Many Requests',
  'HTTP/1.1 429': 'upstream answered HTTP/1.1 429',
  'status code 429': 'Request failed with status code 429',
  'statusCode 429': '{"error":{"name":"AI_APICallError","statusCode":429,"responseHeaders":{}}}',
  'API Error: 429': 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
  'RATE LIMIT': '{"error":{"message":"RATE LIMIT EXCEEDED: free-models-per-min","code":429}}',
  'quota exceeded': 'Qwen OAuth quota exceeded',
  'too many requests': 'too many requests, retry later',
  'ошибка клиента модели': 'Model rate limit, HTTP 429: {"error":"slow down"}',
};

const NOT_THROTTLED = {
  'повтор после 429, потом другая ошибка': [WORK, LIVE_STREAM_ERROR, LIVE_STREAM_ERROR, WORK, OTHER_EXIT].join('\n'),
  'повтор после 429, потом исключение со стеком': [WORK, LIVE_STREAM_ERROR, WORK, 'Error: TypeError: x is undefined', '    at run (src/index.ts:10:5)', '    at main (src/index.ts:20:1)'].join('\n'),
  'стек с 429 номером строки': 'Error: boom\n    at run (src/index.ts:429:17)\n    at main (src/index.ts:1:1)',
  'стек с 429 номером колонки': 'Error: boom\n    at run (src/index.ts:17:429)',
  'размер 429 в выводе ls': '$ ls -la\n-rw-r--r-- 1 Denis 197121  429 Sep 27 16:39 IMPL-101.md\n',
  'строка истории rate_limit в диффе тикета': `-| 2026-09-22 09:03:01 | execute-task | agent-a | rate_limit |\n${WORK}\n${OTHER_EXIT}`,
  'сетевая ошибка': 'read ECONNRESET',
  'отказ доступа': 'HTTP 401 Unauthorized',
  'прочая ошибка': 'boom: something broke',
  'пустой stderr': '',
};

function shippedRules() {
  return loadRules(os.tmpdir(), CONFIG);
}

function statusOf(stderr) {
  return classifyAgentResult({ exitCode: 1, stderr, stdout: '', parsedResult: null, agentType: 'ai' });
}

test('поставляемый конфиг: каждый шаблон — обычный new RegExp без флагов и модификаторов (раннеры прежних версий)', () => {
  const config = loadYaml(fs.readFileSync(CONFIG, 'utf8'));
  const rules = [
    ...(config.common || []),
    ...Object.values(config.agents || {}).flatMap((agent) => agent?.rules || []),
  ];
  assert.ok(rules.length > 0, 'в конфиге есть правила');
  for (const rule of rules) {
    if (!rule.pattern) continue;
    assert.doesNotThrow(() => new RegExp(rule.pattern), `${rule.id}: ${rule.pattern}`);
    // `(?i)` не собирается ни в одной версии Node, `(?i:…)` — только с Node 23.
    assert.doesNotMatch(rule.pattern, /\(\?[a-z-]+[:)]/i, `${rule.id}: встроенный модификатор`);
  }
});

test('поставляемый конфиг: общее правило provider-rate-limit — unavailable, 15m, первое среди общих', () => {
  const rules = shippedRules();
  const rule = rules.common.find((r) => r.id === RULE_ID);
  assert.ok(rule, 'правило есть');
  assert.equal(rule.class, 'unavailable');
  assert.equal(rule.ttl, '15m');
  assert.equal(rules.common[0].id, RULE_ID, 'первое: при ограничении в конце и сетевой ошибке побеждает ограничение');
});

test('одно определение ограничения: pattern правила — дословно PROVIDER_RATE_LIMIT_PATTERN', () => {
  const rule = shippedRules().common.find((r) => r.id === RULE_ID);
  assert.equal(rule.pattern.source, PROVIDER_RATE_LIMIT_PATTERN.source);
  assert.equal(rule.pattern.flags, '');
  assert.equal(PROVIDER_RATE_LIMIT_PATTERN.flags, '');
});

test('запуск закончился на ограничении → provider-rate-limit и статус rate_limit', () => {
  const rules = shippedRules();
  for (const [name, stderr] of Object.entries(THROTTLED_ENDINGS)) {
    assert.equal(classifySync(rules, PLAIN_AGENT, { exitCode: 1, stderr })?.rule_id, RULE_ID, name);
    assert.equal(statusOf(stderr), 'rate_limit', name);
  }
});

test('429 и текст лимита не в конце stderr — ни правила, ни статуса rate_limit', () => {
  const rules = shippedRules();
  for (const [name, stderr] of Object.entries(NOT_THROTTLED)) {
    assert.notEqual(classifySync(rules, PLAIN_AGENT, { exitCode: 1, stderr })?.rule_id, RULE_ID, name);
    assert.notEqual(statusOf(stderr), 'rate_limit', name);
  }
});

test('stderr длиннее 64 КБ: оба слоя судят по концу и совпадают', () => {
  const rules = shippedRules();
  const filler = `${WORK}\n`.repeat(400);
  assert.ok(filler.length > 64 * 1024, 'stderr длиннее предела classify');
  const middle = `${filler}${LIVE_STREAM_ERROR}\n${filler}${OTHER_EXIT}`;
  assert.equal(statusOf(middle), 'error');
  assert.notEqual(classifySync(rules, PLAIN_AGENT, { exitCode: 1, stderr: middle })?.rule_id, RULE_ID);
  const end = `${filler}${OTHER_EXIT}\n${filler}${LIVE_STREAM_ERROR}\n${LIVE_PROCESS}\n${LIVE_EXIT}\n`;
  assert.equal(statusOf(end), 'rate_limit');
  assert.equal(classifySync(rules, PLAIN_AGENT, { exitCode: 1, stderr: end })?.rule_id, RULE_ID);
});

test('ограничение в конце и сетевая ошибка раньше — побеждает ограничение', () => {
  const rules = shippedRules();
  const mixed = 'read ECONNRESET\nHTTP 429 Too Many Requests';
  assert.equal(statusOf(mixed), 'rate_limit');
  assert.equal(classifySync(rules, PLAIN_AGENT, { exitCode: 1, stderr: mixed })?.rule_id, RULE_ID);
});

test('ни одно правило агента не перехватывает общий текст ограничения и не снимает агента онлайн', () => {
  const rules = shippedRules();
  assert.ok(rules.agents.size > 0, 'в конфиге есть агенты');
  const endings = [
    THROTTLED_ENDINGS['живой итог kilo'],
    'HTTP 429 Too Many Requests',
    'too many requests, retry later',
  ];
  for (const agentId of rules.agents.keys()) {
    for (const stderr of endings) {
      const result = classifySync(rules, agentId, { exitCode: 1, stderr });
      assert.equal(result?.rule_id, RULE_ID, `${agentId}: ${stderr}`);
      assert.equal(scanStderrForFatalRule(rules, agentId, stderr), null, `${agentId}: ${stderr}`);
    }
  }
});

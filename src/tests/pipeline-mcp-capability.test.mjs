/**
 * Способность `mcp` в действующем configs/pipeline.yaml.
 *
 * Тикет с `required_capabilities: [mcp]` исполняет только агент, у которого эта
 * способность есть: resolveAgent оставляет агентов, покрывающих все способности
 * тикета, пустой список — `no_capable_agent` и `blocked/`. До 2026-09-27 `mcp` не
 * было ни у одного агента, и 16 QA-тикетов PulseProxy стояли в `blocked/`
 * навсегда.
 *
 * Что охраняется (имён агентов тест не знает):
 *  - для каждого типа из `context.mcp_require_for` в списке исполнителей стадии
 *    `execute-task` есть агент со способностью `mcp`;
 *  - агент без инструментов (`kind: http` или `tool_less: true`) `mcp` не заявляет:
 *    MCP-сервер — это инструменты, а их у такого агента нет.
 *
 * Файл конфига тест только читает.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/js-yaml.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = yaml.load(readFileSync(join(REPO_ROOT, 'configs', 'pipeline.yaml'), 'utf8'));
const pipeline = config.pipeline;

function hasMcp(agentId) {
  return (pipeline.agents[agentId]?.capabilities ?? []).includes('mcp');
}

test('у каждого типа из mcp_require_for среди исполнителей execute-task есть агент с mcp', () => {
  const types = String(pipeline.context?.mcp_require_for ?? '')
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean);
  assert.ok(types.length > 0, 'context.mcp_require_for пуст — проверять нечего');

  const stage = pipeline.stages['execute-task'];
  for (const type of types) {
    const agents = stage.agents_by_type?.[type]?.agents ?? stage.agents ?? pipeline.default_agents;
    assert.ok(
      agents.some(hasMcp),
      `тип ${type}: ни у одного из [${agents.join(', ')}] нет способности mcp`,
    );
  }
});

test('агент без инструментов не заявляет mcp', () => {
  const offenders = Object.entries(pipeline.agents)
    .filter(([, agent]) => agent.kind === 'http' || agent.tool_less === true)
    .filter(([id]) => hasMcp(id))
    .map(([id]) => id);
  assert.deepEqual(offenders, []);
});

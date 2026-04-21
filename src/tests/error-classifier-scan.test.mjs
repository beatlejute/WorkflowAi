#!/usr/bin/env node
/**
 * Тесты scanStderrForFatalRule — онлайн-сканер stderr для раннего kill
 * зависшего CLI-агента, который уходит в retry-цикл после HTTP 429/quota.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRules, scanStderrForFatalRule } from '../lib/error-classifier.mjs';

function makeTmpProject(yaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-stderr-'));
  const cfg = path.join(dir, '.workflow', 'config');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agent-health-rules.yaml'), yaml, 'utf-8');
  return dir;
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

const RULES_YAML = [
  'version: "1.0"',
  'common:',
  '  - id: "net-econnreset"',
  '    class: "transient"',
  '    ttl: "5m"',
  '    pattern: "ECONNRESET"',
  '    exit_codes: "any"',
  'agents:',
  '  kilo-glm:',
  '    rules:',
  '      - id: "zai-usage-limit"',
  '        class: "unavailable"',
  '        ttl: "5h"',
  '        pattern: \'Usage limit reached for \\d+ hour|api\\.z\\.ai.*statusCode":429\'',
  '        exit_codes: "any"',
  '  kilo-deepseek:',
  '    rules:',
  '      - id: "deepseek-transient"',
  '        class: "transient"',
  '        ttl: "15m"',
  '        pattern: "deepseek.*unavailable"',
  '        exit_codes: "any"',
  '',
].join('\n');

test('scanStderrForFatalRule: matches unavailable rule and returns rule info', () => {
  const root = makeTmpProject(RULES_YAML);
  try {
    const rules = loadRules(root);
    const chunk = 'ERROR some log Usage limit reached for 5 hour. Your limit will reset at 2026-04-21 21:12:21';
    const match = scanStderrForFatalRule(rules, 'kilo-glm', chunk);
    assert.ok(match, 'должен найти правило');
    assert.equal(match.rule_id, 'zai-usage-limit');
    assert.equal(match.class, 'unavailable');
    assert.equal(match.ttl, '5h');
  } finally {
    cleanupDir(root);
  }
});

test('scanStderrForFatalRule: matches HTTP 429 on z.ai host', () => {
  const root = makeTmpProject(RULES_YAML);
  try {
    const rules = loadRules(root);
    const chunk = 'ERROR service=llm error={"error":{"url":"https://api.z.ai/api/paas/v4/chat/completions","statusCode":429}}';
    const match = scanStderrForFatalRule(rules, 'kilo-glm', chunk);
    assert.ok(match, 'должен найти правило по 429 на z.ai');
    assert.equal(match.rule_id, 'zai-usage-limit');
  } finally {
    cleanupDir(root);
  }
});

test('scanStderrForFatalRule: returns null when no pattern matches', () => {
  const root = makeTmpProject(RULES_YAML);
  try {
    const rules = loadRules(root);
    assert.equal(scanStderrForFatalRule(rules, 'kilo-glm', 'just some unrelated output'), null);
  } finally {
    cleanupDir(root);
  }
});

test('scanStderrForFatalRule: ignores transient rules (не вешаем early-kill на retryable)', () => {
  const root = makeTmpProject(RULES_YAML);
  try {
    const rules = loadRules(root);
    // transient rule для kilo-deepseek — не должен триггерить early-kill
    const match = scanStderrForFatalRule(rules, 'kilo-deepseek', 'deepseek service is unavailable');
    assert.equal(match, null, 'transient не считается фатальным для онлайн-kill');
  } finally {
    cleanupDir(root);
  }
});

test('scanStderrForFatalRule: ignores common rules (только agent-specific)', () => {
  const root = makeTmpProject(RULES_YAML);
  try {
    const rules = loadRules(root);
    const match = scanStderrForFatalRule(rules, 'kilo-glm', 'ECONNRESET while connecting');
    assert.equal(match, null, 'common rules не используются для онлайн-скана');
  } finally {
    cleanupDir(root);
  }
});

test('scanStderrForFatalRule: returns null for unknown agent', () => {
  const root = makeTmpProject(RULES_YAML);
  try {
    const rules = loadRules(root);
    assert.equal(
      scanStderrForFatalRule(rules, 'nonexistent', 'Usage limit reached for 5 hour'),
      null
    );
  } finally {
    cleanupDir(root);
  }
});

test('scanStderrForFatalRule: handles empty inputs gracefully', () => {
  const root = makeTmpProject(RULES_YAML);
  try {
    const rules = loadRules(root);
    assert.equal(scanStderrForFatalRule(rules, 'kilo-glm', ''), null);
    assert.equal(scanStderrForFatalRule(rules, 'kilo-glm', null), null);
    assert.equal(scanStderrForFatalRule(rules, null, 'anything'), null);
  } finally {
    cleanupDir(root);
  }
});

test('scanStderrForFatalRule: works with kilo-glm-air via extends', () => {
  const extendsYaml = RULES_YAML + '  kilo-glm-air:\n    extends: kilo-glm\n';
  const root = makeTmpProject(extendsYaml);
  try {
    const rules = loadRules(root);
    const match = scanStderrForFatalRule(rules, 'kilo-glm-air', 'Usage limit reached for 5 hour');
    assert.ok(match, 'extends должен унаследовать правило');
    assert.equal(match.rule_id, 'zai-usage-limit');
  } finally {
    cleanupDir(root);
  }
});

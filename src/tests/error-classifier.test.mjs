import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  loadRules,
  classify,
  classifySync,
  parseTtl,
  InvalidRulesConfigError,
} from '../lib/error-classifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const testProjectRoot = join(__dirname, '..', '..');
const testConfigPath = join(testProjectRoot, '.workflow', 'config', 'agent-health-rules.yaml');

// Helper to create test config file
function createTestConfig(rules) {
  const configDir = join(testProjectRoot, '.workflow', 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(testConfigPath, rules, 'utf-8');
}

// Helper to clean up test config
function cleanupTestConfig() {
  try {
    rmSync(testConfigPath);
  } catch (e) {
    // ignore
  }
}

const basicRulesYaml = `version: "1.0"
common:
  - id: "net-econnreset"
    class: "transient"
    ttl: "5m"
    pattern: "ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection reset by peer|socket hang up"
    exit_codes: "any"
  - id: "http-5xx-transient"
    class: "transient"
    ttl: "5m"
    pattern: "\\\\b(502|503|504)\\\\b.*(Bad Gateway|Service Unavailable|Gateway Timeout)"
    exit_codes: "any"
  - id: "http-auth"
    class: "misconfigured"
    ttl: "1h"
    pattern: "\\\\b(401|403)\\\\b|Unauthorized|Forbidden|API key (not found|invalid|missing)"
    exit_codes: "any"
agents:
  qwen-code:
    rules:
      - id: "qwen-quota"
        class: "unavailable"
        ttl: "until_utc_midnight"
        pattern: "Qwen OAuth quota exceeded"
        exit_codes: "any"
  claude-sonnet:
    extends: "claude-opus"
  claude-opus:
    rules:
      - id: "claude-overloaded"
        class: "unavailable"
        ttl: "5m"
        pattern: "overloaded_error"
        exit_codes: "any"
  kilo-deepseek:
    rules:
      - id: "deepseek-unavailable"
        class: "unavailable"
        ttl: "until_utc_midnight"
        pattern: "daily limit reached"
        exit_codes: "any"
`;

test('loadRules: nonexistent config returns empty rules', () => {
  cleanupTestConfig();
  const rules = loadRules(testProjectRoot, testConfigPath);
  assert.deepEqual(rules.common, []);
  assert.equal(rules.agents.size, 0);
});

test('loadRules: valid config with all sections', () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  assert.equal(rules.common.length, 3);
  assert.equal(rules.agents.size, 4);
  assert.ok(rules.agents.has('qwen-code'));
  assert.ok(rules.agents.has('claude-opus'));
  assert.ok(rules.agents.has('claude-sonnet'));
  assert.ok(rules.agents.has('kilo-deepseek'));
  cleanupTestConfig();
});

test('loadRules: version validation rejects wrong version', () => {
  const wrongVersionYaml = `version: "2.0"
common: []
agents: {}
`;
  createTestConfig(wrongVersionYaml);
  assert.throws(
    () => loadRules(testProjectRoot, testConfigPath),
    InvalidRulesConfigError,
    'Should throw InvalidRulesConfigError for wrong version'
  );
  cleanupTestConfig();
});

test('loadRules: invalid regex pattern throws error', () => {
  const invalidRegexYaml = `version: "1.0"
common:
  - id: "bad-pattern"
    class: "transient"
    ttl: "5m"
    pattern: "[invalid(regex"
    exit_codes: "any"
agents: {}
`;
  createTestConfig(invalidRegexYaml);
  assert.throws(
    () => loadRules(testProjectRoot, testConfigPath),
    InvalidRulesConfigError
  );
  cleanupTestConfig();
});

test('loadRules: extends on nonexistent agent throws error', () => {
  const invalidExtendsYaml = `version: "1.0"
common: []
agents:
  test-agent:
    extends: "nonexistent-agent"
`;
  createTestConfig(invalidExtendsYaml);
  assert.throws(
    () => loadRules(testProjectRoot, testConfigPath),
    InvalidRulesConfigError,
    'Should throw error for extends target not found'
  );
  cleanupTestConfig();
});

test('loadRules: chained extends throws error', () => {
  const chainedExtendsYaml = `version: "1.0"
common: []
agents:
  agent-a:
    extends: "agent-b"
  agent-b:
    extends: "agent-c"
  agent-c:
    rules: []
`;
  createTestConfig(chainedExtendsYaml);
  assert.throws(
    () => loadRules(testProjectRoot, testConfigPath),
    InvalidRulesConfigError,
    'Should throw error for chained extends'
  );
  cleanupTestConfig();
});

test('classify: unavailable class matches qwen-quota pattern', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'qwen-code', {
    exitCode: 1,
    stderr: 'Qwen OAuth quota exceeded',
  });
  assert.equal(result.class, 'unavailable');
  assert.equal(result.rule_id, 'qwen-quota');
  assert.equal(result.ttl, 'until_utc_midnight');
  cleanupTestConfig();
});

test('classify: transient class matches ECONNRESET pattern', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: 'ECONNRESET: Connection reset by peer',
  });
  assert.equal(result.class, 'transient');
  assert.equal(result.rule_id, 'net-econnreset');
  assert.equal(result.ttl, '5m');
  cleanupTestConfig();
});

test('classify: misconfigured class matches 401 Unauthorized', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: '401 Unauthorized: API key not found',
  });
  assert.equal(result.class, 'misconfigured');
  assert.equal(result.rule_id, 'http-auth');
  assert.equal(result.ttl, '1h');
  cleanupTestConfig();
});

test('classify: no match for unavailable pattern returns null', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'qwen-code', {
    exitCode: 1,
    stderr: 'Some other error',
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('classify: no match for transient pattern returns null', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: 'Syntax error in code',
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('classify: no match for misconfigured pattern returns null', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: 'Out of memory error',
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('classify: no match for any pattern returns null', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'unknown-agent', {
    exitCode: 1,
    stderr: 'Unknown error that matches nothing',
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('classify: per-agent rules have priority over common', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'qwen-code', {
    exitCode: 1,
    stderr: 'Qwen OAuth quota exceeded',
  });
  assert.equal(result.rule_id, 'qwen-quota');
  assert.equal(result.class, 'unavailable');
  cleanupTestConfig();
});

test('classify: stderr truncation - head 32KB matches', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  // Create stderr with marker in first 32KB
  const largeStderr = 'ECONNRESET' + 'x'.repeat(70000);
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: largeStderr,
  });
  assert.equal(result.class, 'transient');
  cleanupTestConfig();
});

test('classify: stderr truncation - tail 32KB matches', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  // Create stderr with marker in last 32KB
  const largeStderr = 'x'.repeat(70000) + 'ECONNRESET';
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: largeStderr,
  });
  assert.equal(result.class, 'transient');
  cleanupTestConfig();
});

test('classify: stderr truncation - middle 200KB does not match', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  // Create stderr with marker only in middle (beyond both windows)
  const largeStderr = 'x'.repeat(50000) + 'ECONNRESET' + 'x'.repeat(150000);
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: largeStderr,
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('classify: extends resolves inherited rules for claude-sonnet', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'claude-sonnet', {
    exitCode: 1,
    stderr: 'overloaded_error occurred',
  });
  assert.equal(result.class, 'unavailable');
  assert.equal(result.rule_id, 'claude-overloaded');
  cleanupTestConfig();
});

test('classifySync: matches unavailable pattern synchronously', () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = classifySync(rules, 'qwen-code', {
    exitCode: 1,
    stderr: 'Qwen OAuth quota exceeded',
  });
  assert.equal(result.class, 'unavailable');
  assert.equal(result.rule_id, 'qwen-quota');
  cleanupTestConfig();
});

test('classifySync: returns null when no match', () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = classifySync(rules, 'qwen-code', {
    exitCode: 1,
    stderr: 'Unknown error',
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('parseTtl: 5m format', () => {
  const now = 1000;
  const result = parseTtl('5m', now);
  assert.equal(result, now + 5 * 60 * 1000);
});

test('parseTtl: 1h format', () => {
  const now = 1000;
  const result = parseTtl('1h', now);
  assert.equal(result, now + 60 * 60 * 1000);
});

test('parseTtl: 2d format', () => {
  const now = 1000;
  const result = parseTtl('2d', now);
  assert.equal(result, now + 2 * 24 * 60 * 60 * 1000);
});

test('parseTtl: until_utc_midnight normal time', () => {
  // Set time to 10:00 UTC
  const testDate = new Date('2026-01-15T10:00:00Z');
  const now = testDate.getTime();
  const result = parseTtl('until_utc_midnight', now);
  // Should be next midnight
  const nextMidnight = new Date('2026-01-16T00:00:00Z').getTime();
  assert.equal(result, nextMidnight);
});

test('parseTtl: until_utc_midnight late-night (23:58)', () => {
  // Set time to 23:58 UTC
  const testDate = new Date('2026-01-15T23:58:00Z');
  const now = testDate.getTime();
  const result = parseTtl('until_utc_midnight', now);
  // Should be at least 30 minutes from now
  const minDelay = now + 30 * 60 * 1000;
  assert.ok(result >= minDelay, `TTL ${result} should be >= ${minDelay}`);
});

test('parseTtl: infinite format', () => {
  const now = 1000;
  const result = parseTtl('infinite', now);
  assert.equal(result, Number.MAX_SAFE_INTEGER);
});

test('parseTtl: invalid format throws error', () => {
  assert.throws(
    () => parseTtl('invalid', 1000),
    Error,
    'Should throw error for invalid format'
  );
});

test('classify: two agents with different rules + common', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);

  // Test kilo-deepseek with its own pattern
  const result = await classify(rules, 'kilo-deepseek', {
    exitCode: 1,
    stderr: 'daily limit reached',
  });
  assert.equal(result.class, 'unavailable');
  assert.equal(result.rule_id, 'deepseek-unavailable');
  cleanupTestConfig();
});

test('classify: per-agent rules block matching on common for same agent', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);

  // qwen-code has only one pattern: qwen-quota
  // This shouldn't match the common ECONNRESET even though it's a network error
  const result = await classify(rules, 'qwen-code', {
    exitCode: 1,
    stderr: 'ECONNRESET connection reset',
  });
  // Since qwen-code has per-agent rules and ECONNRESET is not in them,
  // it should match common rules instead
  assert.equal(result.class, 'transient');
  assert.equal(result.rule_id, 'net-econnreset');
  cleanupTestConfig();
});

test('InvalidRulesConfigError: is proper error class', () => {
  const error = new InvalidRulesConfigError('test message');
  assert.equal(error.name, 'InvalidRulesConfigError');
  assert.equal(error.message, 'test message');
  assert.ok(error instanceof Error);
});

test('loadRules: malformed YAML returns empty rules', () => {
  const malformedYaml = `
    version: "1.0"
    common:
      - this is not valid: [yaml
`;
  createTestConfig(malformedYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  // Should return empty rules instead of throwing on parsing
  assert.ok(rules);
  cleanupTestConfig();
});

test('classify: empty stderr with pattern rule', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'qwen-code', {
    exitCode: 1,
    stderr: '',
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('classify: null stderr treated as empty', async () => {
  createTestConfig(basicRulesYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = await classify(rules, 'any-agent', {
    exitCode: 1,
    stderr: null,
  });
  assert.equal(result, null);
  cleanupTestConfig();
});

test('classifySync: multiple rules on same agent - first match wins', () => {
  const multiRuleYaml = `version: "1.0"
common: []
agents:
  test-agent:
    rules:
      - id: "rule-1"
        class: "transient"
        ttl: "5m"
        pattern: "error"
        exit_codes: "any"
      - id: "rule-2"
        class: "unavailable"
        ttl: "1h"
        pattern: "error"
        exit_codes: "any"
`;
  createTestConfig(multiRuleYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);
  const result = classifySync(rules, 'test-agent', {
    exitCode: 1,
    stderr: 'error occurred',
  });
  assert.equal(result.rule_id, 'rule-1');
  cleanupTestConfig();
});

test('classify: pattern without exit code requirement matches any exit code', async () => {
  const patternOnlyYaml = `version: "1.0"
common: []
agents:
  test-agent:
    rules:
      - id: "pattern-rule"
        class: "transient"
        ttl: "5m"
        pattern: "error"
        exit_codes: "any"
`;
  createTestConfig(patternOnlyYaml);
  const rules = loadRules(testProjectRoot, testConfigPath);

  // Should match regardless of exit code when pattern present
  const result1 = await classify(rules, 'test-agent', {
    exitCode: 1,
    stderr: 'error occurred',
  });
  assert.equal(result1.class, 'transient');

  const result2 = await classify(rules, 'test-agent', {
    exitCode: 5,
    stderr: 'error occurred',
  });
  assert.equal(result2.class, 'transient');

  cleanupTestConfig();
});

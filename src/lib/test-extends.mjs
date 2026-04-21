import { loadRules, classify, classifySync } from './error-classifier.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ec-test-'));
const configDir = path.join(tmp, '.workflow/config');
mkdirSync(configDir, { recursive: true });
const configPath = path.join(configDir, 'agent-health-rules.yaml');

writeFileSync(configPath, `version: "1.0"
common:
  - id: "common-test"
    class: "transient"
    ttl: "5m"
    pattern: "common-error"
    exit_codes: "any"
agents:
  claude-sonnet:
    rules:
      - id: "claude-specific"
        class: "unavailable"
        ttl: "10m"
        pattern: "claude-specific-error"
        exit_codes: "any"
  claude-opus:
    extends: claude-sonnet
  kilo-glm:
    rules:
      - id: "kilo-own"
        class: "misconfigured"
        ttl: "1h"
        pattern: "kilo-error"
        exit_codes: "any"
`);

const rules = loadRules(tmp);
console.log('loadRules with extends:');

const opusRules = rules.agents.get('claude-opus');
console.log('claude-opus rules (from extends):', opusRules?.length);
console.log('claude-opus first rule:', opusRules?.[0]?.id);

const glmRules = rules.agents.get('kilo-glm');
console.log('kilo-glm rules (own):', glmRules?.length);
console.log('kilo-glm first rule:', glmRules?.[0]?.id);

const test1 = classifySync(rules, 'claude-opus', { exitCode: 1, stderr: 'claude-specific-error' });
console.log('classify claude-opus with specific error:', test1?.class, test1?.rule_id);

const test2 = classifySync(rules, 'claude-opus', { exitCode: 1, stderr: 'common-error' });
console.log('classify claude-opus with common error:', test2?.class, test2?.rule_id);

const test3 = classifySync(rules, 'kilo-glm', { exitCode: 1, stderr: 'kilo-error' });
console.log('classify kilo-glm with own error:', test3?.class, test3?.rule_id);

rmSync(tmp, { recursive: true, force: true });
console.log('Extends tests passed!');

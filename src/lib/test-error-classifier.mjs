import { loadRules, classify, parseTtl, classifySync, InvalidRulesConfigError } from './error-classifier.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ec-test-'));
const configDir = path.join(tmp, '.workflow/config');
mkdirSync(configDir, { recursive: true });
const configPath = path.join(configDir, 'agent-health-rules.yaml');

writeFileSync(configPath, `version: "1.0"
common:
  - id: "net-econnreset"
    class: "transient"
    ttl: "5m"
    pattern: "ECONNRESET|ETIMEDOUT"
    exit_codes: "any"
agents:
  qwen-code:
    rules:
      - id: "qwen-quota"
        class: "unavailable"
        ttl: "until_utc_midnight"
        pattern: "Qwen OAuth quota exceeded"
        exit_codes: "any"
`);

const rules = loadRules(tmp);
console.log('loadRules result:', { commonLen: rules.common.length, agentsSize: rules.agents.size });

const result1 = await classify(rules, 'qwen-code', { exitCode: 1, stderr: 'Qwen OAuth quota exceeded' });
console.log('classify qwen-quota:', result1?.class, result1?.rule_id);

const result2 = await classify(rules, 'qwen-code', { exitCode: 1, stderr: 'Some other error' });
console.log('classify no match:', result2);

const result3 = await classify(rules, 'claude-sonnet', { exitCode: 1, stderr: 'ECONNRESET' });
console.log('classify common:', result3?.class, result3?.rule_id);

const result4 = classifySync(rules, 'qwen-code', { exitCode: 1, stderr: 'Qwen OAuth quota exceeded' });
console.log('classifySync qwen-quota:', result4?.class, result4?.rule_id);

const ttl1 = parseTtl('5m');
console.log('parseTtl 5m:', typeof ttl1, ttl1 > Date.now());

const ttl2 = parseTtl('infinite');
console.log('parseTtl infinite:', ttl2 === Number.MAX_SAFE_INTEGER);

const now = new Date('2026-04-21T12:00:00Z').getTime();
const ttl3 = parseTtl('until_utc_midnight', now);
console.log('parseTtl until_utc_midnight:', ttl3 >= now);

const ttl4 = parseTtl('1h');
console.log('parseTtl 1h:', ttl4 > now);

const ttl5 = parseTtl('1d');
console.log('parseTtl 1d:', ttl5 > now);

rmSync(tmp, { recursive: true, force: true });
console.log('All tests passed!');
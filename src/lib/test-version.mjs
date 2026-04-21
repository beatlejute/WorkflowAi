import { InvalidRulesConfigError } from './error-classifier.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ec-test-'));
const configDir = path.join(tmp, '.workflow/config');
mkdirSync(configDir, { recursive: true });
const configPath = path.join(configDir, 'agent-health-rules.yaml');

writeFileSync(configPath, 'version: "2.0"\ncommon: []');

try {
  const { loadRules } = await import('./error-classifier.mjs');
  loadRules(tmp);
  console.log('ERROR: should have thrown');
} catch (e) {
  console.log('Version error works:', e.name === 'InvalidRulesConfigError', e.message.includes('2.0'));
}

rmSync(tmp, { recursive: true, force: true });
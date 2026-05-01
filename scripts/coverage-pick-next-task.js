#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');

// Очищаем старые данные coverage
const dirs = ['.coverage', '.nyc_output', 'coverage'];
for (const dir of dirs) {
  const coverageDir = path.join(projectDir, dir);
  if (fs.existsSync(coverageDir)) {
    fs.rmSync(coverageDir, { recursive: true });
  }
}

// Запускаем тесты с NODE_V8_COVERAGE через c8
const env = { ...process.env };
env.NODE_V8_COVERAGE = '.coverage';

try {
  console.log('Running tests with c8 coverage...');
  execSync('c8 --include="src/scripts/pick-next-task.js" node --test src/tests/scripts-pick-next-task-human-ready.test.mjs', {
    cwd: projectDir,
    env,
    stdio: 'inherit'
  });
} catch (error) {
  console.error('Coverage failed');
  process.exit(1);
}

import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadHealth } from '../lib/agent-health-registry.mjs';

// Реестр здоровья жаловался на битый JSON через модульный createLogger(), а тот
// резолвил корень от process.cwd(). Тесты запускаются из корня workflowAi,
// поэтому предупреждения о реестрах из песочниц в os.tmpdir() приземлялись в
// боевой .workflow/logs/pipeline.log — вперемешку с записями пайплайна.

const PROJECT_LOG = resolve(process.cwd(), '.workflow/logs/pipeline.log');
const sandboxes = [];

function sandboxWithCorruptRegistry() {
  const root = mkdtempSync(join(tmpdir(), 'health-logging-'));
  sandboxes.push(root);
  mkdirSync(join(root, '.workflow', 'state'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'state', 'agent-health.json'), '{ это не JSON');
  return root;
}

after(() => {
  for (const root of sandboxes) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('жалоба на битый реестр не попадает в лог чужого проекта', () => {
  const root = sandboxWithCorruptRegistry();
  const sizeBefore = existsSync(PROJECT_LOG) ? statSync(PROJECT_LOG).size : null;

  const health = loadHealth(root);

  assert.deepStrictEqual(health.agents, {}, 'битый реестр читается как пустой');

  const sizeAfter = existsSync(PROJECT_LOG) ? statSync(PROJECT_LOG).size : null;
  assert.strictEqual(sizeAfter, sizeBefore, 'боевой pipeline.log не должен расти от тестовой песочницы');
});

test('жалоба уходит в лог того проекта, которому принадлежит реестр', () => {
  const root = sandboxWithCorruptRegistry();

  loadHealth(root);

  const sandboxLog = join(root, '.workflow', 'logs', 'pipeline.log');
  assert.ok(existsSync(sandboxLog), 'лог должен появиться внутри песочницы');
  assert.match(readFileSync(sandboxLog, 'utf8'), /corrupted JSON/);
});

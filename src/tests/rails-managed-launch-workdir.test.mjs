import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { spawnAgent } from '../lib/agent-spawner.mjs';
import { StageExecutor } from '../runner.mjs';

test('both spawn paths register the project root, never the nested child workdir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rails-managed-workdir-'));
  const cwd = path.join(root, 'src');
  fs.mkdirSync(cwd);
  const script = path.join(root, 'agent.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
    fs.readFileSync(0, 'utf8');
    process.stdout.write(process.cwd() + '\\n---RESULT---\\nstatus: passed\\n---RESULT---\\n');`);
  const probe = mock.method(childProcess, 'execFileSync', () => JSON.stringify({
    ProcessId: process.pid, ParentProcessId: 0, ExecutablePath: process.execPath,
    CommandLine: `"${process.execPath}" "test-launcher.mjs"`, Birth: 'test-launcher',
  }));
  const agent = { command: 'node', args: [script], workdir: 'src', prompt_stdin: true };
  const logger = { info() {}, warn() {}, error() {}, cliCall() {}, timeout() {} };
  const config = { pipeline: { name: 'workdir-test', version: '1.0', agents: {}, stages: {},
    execution: { timeout_per_stage: 10 } } };
  const executor = new StageExecutor(config, {}, {}, {}, null, logger, root);
  const receipt = path.join(root, '.workflow', 'state', 'rails', `.managed-launch-${process.pid}.json`);
  try {
    for (const launch of [
      () => spawnAgent(agent, 'test', { projectRoot: root, timeout: 10, logger }),
      () => executor.callAgent(agent, 'test', 'test-stage', 'absent-skill'),
    ]) {
      const result = await launch();
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes(cwd));
      assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).pid, process.pid);
      assert.equal(fs.existsSync(path.join(cwd, '.workflow')), false);
      fs.unlinkSync(receipt); // each spawn path must independently register the real root
    }
  } finally {
    probe.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

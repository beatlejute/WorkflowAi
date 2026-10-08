import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startState, saveState, loadState } from '../rails/state.mjs';
import { loadSkillRuntime, decide } from '../rails/core.mjs';
import { handleHookInput } from '../rails/claude-hook.mjs';
import { acquireLifecycleLock, heldLifecycleLock, withLifecycleLock } from '../rails/lifecycle-lock.mjs';
import { essentialStateDigest, recordCompletion, verifyExit, performExit, grantPath, grantTemplate } from '../rails/completion.mjs';
import { readJournal } from '../rails/journal.mjs';
import { verifyHandoff, relinquish, readHandoff } from '../rails/handoff.mjs';
import { run } from '../rails/cli.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rails-handoff-'));
  const session = randomUUID();
  const dir = join(root, '.workflow', 'src', 'skills', 'example');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '```mermaid\nflowchart TD\nP0E1["entry"] --> P0S2["scope decision with immutable handoff evidence"]\n```\n');
  writeFileSync(join(dir, 'rails.yaml'), 'version: 1\nskill: example\nentry: P0E1\nterminal: [P0S2]\nhandoff:\n  nodes: [P0S2]\n  requires: ["^REQUEST: .+", "^REASON: .+", "^DONE: .+", "^REMAINING: .+"]\n  forbids: ["verdict=", "^status:"]\n');
  const state = startState({ root, sessionId: session, skill: 'example', entry: 'P0S2', run: 'managed-test' });
  loadSkillRuntime(root, state.skill, state);
  saveState(root, state);
  const transcript = join(root, `${session}.jsonl`);
  const answer = 'RAILS_OUTCOME: out_of_scope\nREQUEST: original task\nREASON: outside scope\nDONE: inspected scope\nREMAINING: implementation';
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: session, message: { content: [{ type: 'text', text: answer }] } }) + '\n');
  const args = { root, session, transcriptPath: transcript, expectedStateDigest: essentialStateDigest(state), source: 'runner', run: state.run, answer };
  try { fn({ root, state, args, transcript }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

// Windows host callbacks are exercised with an OS snapshot, never real process scans.
function hostFixture(origin, fn) {
  const executable = 'C:\\Users\\owner\\.vscode-oss\\extensions\\anthropic.claude-code\\native-binary\\claude.exe';
  let session;
  const snapshot = mock.method(childProcess, 'execFileSync', () => JSON.stringify([
    { ProcessId: process.pid, ParentProcessId: 222, ExecutablePath: process.execPath,
      CommandLine: `"${process.execPath}" "${fileURLToPath(new URL('../rails/claude-hook.mjs', import.meta.url))}"`, Birth: 'caller' },
    { ProcessId: 222, ParentProcessId: 0, ExecutablePath: executable, Birth: 'host',
      CommandLine: `"${executable}" --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --replay-user-messages${origin === 'managed' ? ' --print' : ''}${session ? ` --resume=${session}` : ''}` },
  ]));
  try {
    fixture((f) => {
      session = f.state.session;
      // Fixture started before its randomly generated session was known to the host.
      // Recreate only the test state/runtime so the host can positively bind that session.
      const dir = join(f.root, '.workflow', 'state', 'rails-runtime');
      unlinkSync(join(dir, `${f.state.runtime.id}.json`));
      const state = startState({ root: f.root, sessionId: session, skill: 'example', entry: 'P0S2', run: 'managed-test' });
      loadSkillRuntime(f.root, state.skill, state);
      saveState(f.root, state);
      const transcript = { type: 'assistant', sessionId: session, timestamp: new Date(Date.now() + 10).toISOString(),
        message: { content: [{ type: 'text', text: f.args.answer }] } };
      writeFileSync(f.transcript, JSON.stringify(transcript) + '\n');
      fn({ ...f, state, transcriptEntry: transcript, args: { ...f.args, source: undefined,
        expectedStateDigest: essentialStateDigest(state) } });
    });
  } finally { snapshot.mock.restore(); }
}

test('positive host Stop releases interactive rails into guarded neutral mode', { skip: process.platform !== 'win32' }, () => hostFixture('interactive', ({ root, state, args }) => {
  assert.equal(state.launch.origin, 'interactive');
  const result = handleHookInput({ hook_event_name: 'Stop', cwd: root, session_id: state.session, transcript_path: args.transcriptPath }, {});
  assert.equal(result, null);
  assert.equal(readHandoff(root, state.session).origin, 'interactive');
  assert.equal(decide({ action: { kind: 'shell', command: 'git status', shell: 'bash' }, ctx: { cwd: root, sessionId: state.session } }).decision, 'allow');
  assert.equal(decide({ action: { kind: 'write', path: join(root, '.workflow', 'state', 'rails', 'fake.json') }, ctx: { cwd: root, sessionId: state.session } }).decision, 'deny');
  assert.equal(decide({ action: { kind: 'write', path: join(root, '.workflow', 'src', 'skills', 'example', 'SKILL.md') }, ctx: { cwd: root, sessionId: state.session } }).decision, 'deny');
}));

test('positive managed host Stop records transfer but executor remains blocked', { skip: process.platform !== 'win32' }, () => hostFixture('managed', ({ root, state, args }) => {
  assert.equal(state.launch.origin, 'managed');
  assert.equal(handleHookInput({ hook_event_name: 'Stop', cwd: root, session_id: state.session, transcript_path: args.transcriptPath }, {}), null);
  assert.equal(readHandoff(root, state.session).origin, 'managed');
  assert.equal(decide({ action: { kind: 'shell', command: 'git status', shell: 'bash' }, ctx: { cwd: root, sessionId: state.session, role: 'executor' } }).decision, 'deny');
}));

test('positive host rejects stale answers and changes to pinned launch', { skip: process.platform !== 'win32' }, () => hostFixture('interactive', ({ root, state, args, transcriptEntry }) => {
  transcriptEntry.timestamp = '2000-01-01T00:00:00Z';
  writeFileSync(args.transcriptPath, JSON.stringify(transcriptEntry) + '\n');
  assert.equal(verifyHandoff(args).ok, false);
  const changed = { ...state, launch: { ...state.launch, origin: 'managed' } };
  assert.throws(() => loadSkillRuntime(root, changed.skill, changed));
}));

test('handoff evidence: session transcript and current pinned state validate without mutation', () => fixture(({ root, state, args }) => {
  const result = verifyHandoff(args);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.outcome, 'out_of_scope');
  assert.equal(result.evidence.identity.session, state.session);
  assert.equal(result.evidence.origin, 'unknown');
  assert.equal(result.evidence.request, 'original task');
  assert.deepEqual(loadState(root, state.session), state);
  assert.equal(loadState(root, state.session).completion, undefined);
}));

test('relinquish preserves state and records a separate immutable outcome', () => fixture(({ root, state, args }) => {
  const result = relinquish(args);
  assert.equal(result.ok, true);
  assert.deepEqual(loadState(root, state.session), state);
  assert.deepEqual(readHandoff(root, state.session), result.marker);
  assert.equal(relinquish(args).ok, false);
}));

test('handoff CLI requires evidence and freshness, then closes mutations', () => fixture(({ root, state, args }) => {
  const flags = ['--session', state.session, '--transcript', args.transcriptPath, '--state-digest', args.expectedStateDigest];
  assert.notEqual(run(['relinquish', '--session', state.session], { cwd: root, env: {} }).code, 0);
  assert.notEqual(run(['relinquish', '--session', '../invalid', '--transcript', args.transcriptPath,
    '--state-digest', args.expectedStateDigest], { cwd: root, env: {} }).code, 0);
  assert.notEqual(run(['relinquish', ...flags], { cwd: root, env: {} }).code, 0);
  assert.equal(relinquish(args).ok, true);
  assert.notEqual(run(['start', 'example', '--session', state.session], { cwd: root, env: {} }).code, 0);
  assert.notEqual(run(['reset', '--session', state.session], { cwd: root, env: {} }).code, 0);
  assert.throws(() => saveState(root, { ...state, node: 'P0E1' }));
}));

test('handoff Stop refuses unverified transcript and executor cannot resume after managed transfer', () => fixture(({ root, state, args }) => {
  const stopped = handleHookInput({ hook_event_name: 'Stop', cwd: root, session_id: state.session, transcript_path: args.transcriptPath }, {});
  assert.equal(stopped.decision, 'block');
  assert.equal(readHandoff(root, state.session), null);
  assert.equal(relinquish(args).ok, true);
  assert.ok(readHandoff(root, state.session));
  const decision = decide({ action: { kind: 'shell', command: 'git status', shell: 'bash' },
    ctx: { cwd: root, sessionId: state.session, role: 'executor', toolUseId: 'old-allow' } });
  assert.equal(decision.decision, 'deny');
}));

test('separate processes cannot mutate or hand off while the lifecycle owner holds its claim', () => fixture(({ root, state, args }) => {
  const lock = acquireLifecycleLock(root, state.session);
  const stateUrl = new URL('../rails/state.mjs', import.meta.url).href;
  const handoffUrl = new URL('../rails/handoff.mjs', import.meta.url).href;
  const hookUrl = new URL('../rails/claude-hook.mjs', import.meta.url).href;
  const script = `
    import { loadState, saveState } from ${JSON.stringify(stateUrl)};
    import { relinquish } from ${JSON.stringify(handoffUrl)};
    import { handleHookInput } from ${JSON.stringify(hookUrl)};
    const args = ${JSON.stringify(args)};
    const state = loadState(args.root, args.session);
    let refused = false;
    try { state.node = 'P0E1'; saveState(args.root, state); } catch { refused = true; }
    const handoff = relinquish(args);
    const stop = handleHookInput({ hook_event_name: 'Stop', cwd: args.root,
      session_id: args.session, transcript_path: args.transcriptPath }, {});
    handleHookInput({ hook_event_name: 'UserPromptSubmit', cwd: args.root,
      session_id: args.session, prompt: 'нет, не туда' }, {});
    process.stdout.write(JSON.stringify({ refused, handoff, stop }));
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.refused, true);
    assert.equal(result.handoff.ok, false);
    assert.equal(result.stop.decision, 'block');
    assert.equal(lock.owns(), true);
    assert.deepEqual(loadState(root, state.session), state);
    assert.equal(readHandoff(root, state.session), null);
  } finally { lock.release(); }
  assert.equal(relinquish(args).ok, true);
}));

test('handoff reuses its own lifecycle transaction without removing the outer claim', () => fixture(({ root, state, args }) => {
  const lock = acquireLifecycleLock(root, state.session);
  // A separate owner claim is exercised by the CLI process in completion tests;
  // a nested transaction in this process legitimately reuses its own lock.
  try { assert.equal(relinquish(args).ok, true); }
  finally { lock.release(); }
}));

test('handoff refuses duplicate fields, damaged runtime, and corrupted marker', () => fixture(({ root, state, args, transcript }) => {
  const original = readFileSync(transcript, 'utf8');
  writeFileSync(transcript, original.replace('REMAINING: implementation', 'REMAINING: implementation\\nREQUEST: duplicate'));
  assert.equal(verifyHandoff({ ...args, answer: args.answer + '\nREQUEST: duplicate' }).ok, false);
  writeFileSync(transcript, original);
  const runtime = join(root, '.workflow', 'state', 'rails-runtime', `${state.runtime.id}.json`);
  const snapshot = readFileSync(runtime, 'utf8');
  writeFileSync(runtime, '{');
  assert.equal(verifyHandoff(args).ok, false);
  writeFileSync(runtime, snapshot);
  assert.equal(relinquish(args).ok, true);
  const marker = join(root, '.workflow', 'state', 'rails', `.handoff-${state.session}.json`);
  writeFileSync(marker, '{');
  assert.throws(() => readHandoff(root, state.session));
  unlinkSync(marker);
  assert.equal(readHandoff(root, state.session), null);
}));

test('handoff evidence: stale state and foreign transcript refuse', () => fixture(({ root, state, args, transcript }) => {
  assert.equal(verifyHandoff({ ...args, expectedStateDigest: 'stale' }).ok, false);
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: randomUUID(), message: { content: [] } }) + '\n');
  assert.equal(verifyHandoff({ ...args, source: 'cli-transcript' }).ok, false);
  state.node = 'P0E1';
  saveState(root, state);
  assert.equal(verifyHandoff(args).ok, false);
}));

test('legacy completion and grant remain intact but cannot exit after handoff', () => fixture(({ root, state, args }) => {
  assert.equal(recordCompletion({ root, state, source: 'runner', answer: 'ordinary terminal answer' }).ok, true);
  const completed = loadState(root, state.session);
  const grant = grantTemplate(completed.completion);
  writeFileSync(grantPath(root, state.session), JSON.stringify(grant));
  assert.equal(relinquish({ ...args, expectedStateDigest: essentialStateDigest(completed) }).ok, true);
  assert.equal(verifyExit({ root, session: state.session }).ok, false);
  assert.equal(performExit({ root, session: state.session }).ok, false);
  assert.deepEqual(JSON.parse(readFileSync(grantPath(root, state.session), 'utf8')), grant);
  assert.deepEqual(loadState(root, state.session).completion, completed.completion);
}));

test('rejected Stop handoff invalidates old success without consuming its grant', () => fixture(({ root, state, args }) => {
  assert.equal(recordCompletion({ root, state, source: 'runner', answer: 'terminal answer' }).ok, true);
  const fresh = loadState(root, state.session);
  const grant = grantTemplate(fresh.completion);
  writeFileSync(grantPath(root, state.session), JSON.stringify(grant));
  const result = handleHookInput({ hook_event_name: 'Stop', cwd: root, session_id: state.session,
    transcript_path: args.transcriptPath }, {});
  assert.equal(result.decision, 'block');
  assert.equal(performExit({ root, session: state.session }).ok, false);
  assert.deepEqual(JSON.parse(readFileSync(grantPath(root, state.session), 'utf8')), grant);
  assert.equal(loadState(root, state.session).completion, undefined);
}));

test('reader recovers only the owned temporary publication name after cleanup failure', () => fixture(({ root, state, args }) => {
  const handoffUrl = new URL('../rails/handoff.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.unlinkSync;
    fs.unlinkSync = (path) => { if (String(path).endsWith('.tmp')) throw new Error('cleanup failed'); return original(path); };
    syncBuiltinESMExports();
    const { relinquish } = await import(${JSON.stringify(handoffUrl)});
    process.stdout.write(JSON.stringify(relinquish(${JSON.stringify(args)})));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).ok, false);
  const marker = readHandoff(root, state.session);
  assert.equal(marker.outcome, 'out_of_scope');
  assert.deepEqual(loadState(root, state.session), state);
}));

test('external hardlink is not an owned publication temporary name', () => fixture(({ root, state, args }) => {
  assert.equal(relinquish(args).ok, true);
  const marker = join(root, '.workflow', 'state', 'rails', `.handoff-${state.session}.json`);
  linkSync(marker, join(root, 'external-marker.json'));
  assert.throws(() => readHandoff(root, state.session));
}));

test('old transcript plus current digest is not host proof', () => fixture(({ args }) => {
  for (const source of [undefined, 'cli-transcript', 'stop-hook']) {
    const result = verifyHandoff({ ...args, source });
    assert.equal(result.ok, false);
    assert.match(result.reason, /доказательства хоста|подтверждённого закреплённого хоста/);
  }
}));

test('marker cannot confirm transfer after state or runtime changes', () => fixture(({ root, state, args }) => {
  assert.equal(relinquish(args).ok, true);
  const path = join(root, '.workflow', 'state', 'rails', `${state.session}.json`);
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, JSON.stringify({ ...state, node: 'P0E1' }));
  assert.throws(() => readHandoff(root, state.session));
  writeFileSync(path, JSON.stringify({ ...state, runtime: { ...state.runtime, hash: 'changed' } }));
  assert.throws(() => readHandoff(root, state.session));
  writeFileSync(path, original);
  assert.ok(readHandoff(root, state.session));
}));

test('failure during atomic publication records only an attempt and preserves artifacts', () => fixture(({ root, state, args }) => {
  const handoffUrl = new URL('../rails/handoff.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.linkSync;
    fs.linkSync = () => { throw new Error('injected publication failure'); };
    syncBuiltinESMExports();
    const { relinquish } = await import(${JSON.stringify(handoffUrl)});
    const result = relinquish(${JSON.stringify(args)});
    fs.linkSync = original;
    syncBuiltinESMExports();
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).ok, false);
  const events = readJournal(root).filter((event) => event.type.startsWith('handoff'));
  assert.deepEqual(events.map((event) => event.type), ['handoff_attempt']);
  assert.equal(readHandoff(root, state.session), null);
  assert.deepEqual(loadState(root, state.session), state);
}));

test('publication failure leaves attempt audit, not a committed event', () => fixture(({ root, state, args }) => {
  const marker = join(root, '.workflow', 'state', 'rails', `.handoff-${state.session}.json`);
  // A competing publication occupies the immutable destination.
  mkdirSync(marker);
  assert.equal(relinquish(args).ok, false);
  assert.equal(readJournal(root).some((event) => event.type === 'handoff'), false);
  assert.deepEqual(loadState(root, state.session), state);
}));

test('handoff evidence: missing freshness binding refuses; caller role cannot establish origin', () => fixture(({ args }) => {
  assert.equal(verifyHandoff({ ...args, expectedStateDigest: undefined }).ok, false);
  const result = verifyHandoff({ ...args, role: 'interactive', origin: 'interactive' });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.origin, 'unknown');
}));

test('lifecycle lock rejects busy claims and detects loss of its own claim', () => fixture(({ root, state }) => {
  const lock = acquireLifecycleLock(root, state.session);
  assert.equal(heldLifecycleLock(root, state.session), lock);
  assert.equal(withLifecycleLock(root, state.session, (nested) => nested), lock);
  writeFileSync(lock.lockFile, '1');
  assert.equal(heldLifecycleLock(root, state.session), null);
  assert.throws(() => withLifecycleLock(root, state.session, () => {}), /замок жизненного цикла потерян/);
  lock.release();
  unlinkSync(lock.lockFile);

  writeFileSync(lock.lockFile, 'not-a-pid');
  assert.throws(() => withLifecycleLock(root, state.session, () => {}), /замок жизненного цикла занят \(pid \?,/);
  unlinkSync(lock.lockFile);
}));

test('lifecycle lock fails closed when its directory cannot be created', () => {
  const root = mkdtempSync(join(tmpdir(), 'rails-lock-error-'));
  mkdirSync(join(root, '.workflow'));
  writeFileSync(join(root, '.workflow', 'state'), 'blocked');
  try {
    assert.throws(() => withLifecycleLock(root, 'valid_session', () => {}), (error) => error.railsFailClosed === true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lifecycle lock rejects malformed session identifiers', () => {
  assert.throws(() => acquireLifecycleLock(tmpdir(), '../invalid'), /недопустимая сессия замка/);
});


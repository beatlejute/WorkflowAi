import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Изоляция памяти «сессия → корень» — как в rails-claude-hook.test.mjs.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

import { handleHookInput } from '../rails/claude-hook.mjs';
import { run as cliRun } from '../rails/cli.mjs';
import { analyzeCliCommand, loadSkillRuntime } from '../rails/core.mjs';
import {
  startState,
  saveState,
  loadState,
  listSessionIds,
  StateError,
  readCompletedMarker,
  writeCompletedMarker,
  completedMarkerPath,
} from '../rails/state.mjs';
import {
  recordCompletion,
  performExit,
  verifyExit,
  invalidateCompletion,
  essentialStateDigest,
  completionDigest,
  grantPath,
  grantTemplate,
  transcriptFinalAnswer,
} from '../rails/completion.mjs';
import { classifyWrites, WritePolicyError } from '../rails/write-policy.mjs';
import { appendEvent, readJournal, summarize } from '../rails/journal.mjs';

const SKILL = 'completetest';
const uuid = () => randomUUID();

// --- фикстура: root с .workflow, скил completetest ---------------------------------
//
// Граф: P4E1(вход) -> P4S1(шаг, узел паузы) -> P5E1; P5E1(вход) -> P5S1(шаг, terminal).

const SKILL_MD = `# Фикстура completion (skill=${SKILL})

\`\`\`mermaid
graph TD
    P4E1["П4 ВХОД: Начало этапа теста штатного выхода из роли"]
    P4S1["П4 ШАГ: Задать вопрос владельцу и дождаться ответа здесь"]
    P4E1 --> P4S1
    P4S1 --> P5E1

    P5E1["П5 ВХОД: Переход к финальному этапу теста выхода роли"]
    P5S1["П5 ШАГ: Завершить работу и подготовить финальный ответ агента"]
    P5E1 --> P5S1
\`\`\`
`;

const RAILS_YAML = [
  'version: 1',
  `skill: ${SKILL}`,
  'entry: P4E1',
  'terminal: [P5S1]',
  'pause_nodes: [P4S1]',
  'quote_min: 25',
  'canary: "echo RAILS_CANARY"',
  '',
  'output:',
  '  final_requires:',
  '    - "RAILS:\\\\s*P\\\\d+[ERSGQ]\\\\d+"',
  '    - "verdict\\\\s*="',
  '  pause_requires:',
  '    - "RAILS:\\\\s*P\\\\d+[ERSGQ]\\\\d+"',
  '  max_stop_blocks: 2',
  '',
].join('\n');

const PASS_ANSWER = 'RAILS: P5S1 работа завершена.\nverdict = pass\nФайлы: отчёт записан.';
const FAIL_ANSWER = 'Просто слова без требуемых строк выходного слоя.';
const PAUSE_ANSWER = 'RAILS: P4S1 вопрос к владельцу по ходу работы';
const SUSPENSION_ANSWER = [
  'RAILS_OUTCOME: needs_user',
  'ACTION: владелец решает судьбу доступа',
  'REASON: доступ не выдан',
  'DONE: разведка выполнена',
  'REMAINING: решение владельца',
].join('\n');

function withProject(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-completion-'));
  try {
    const root = join(base, 'root');
    const skillDir = join(root, '.workflow', 'src', 'skills', SKILL);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
    writeFileSync(join(skillDir, 'rails.yaml'), RAILS_YAML, 'utf8');
    fn({ base, root, skillDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// Состояние с закреплённым runtime в узле `node`.
function pinnedSession(root, node) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: SKILL, entry: 'P4E1' });
  state.node = node;
  loadSkillRuntime(root, SKILL, state); // закрепить runtime и сохранить привязку
  saveState(root, state);
  return sessionId;
}

// Состояние без привязки (loadSkillRuntime со состоянием не вызывался).
function unpinnedSession(root, node) {
  const sessionId = uuid();
  const state = startState({ root, sessionId, skill: SKILL, entry: 'P4E1' });
  state.node = node;
  saveState(root, state);
  return sessionId;
}

// Transcript с именем сессии и одним ассистентским сообщением.
function writeTranscript(base, sessionId, text) {
  const p = join(base, `${sessionId}.jsonl`);
  const entry = { type: 'assistant', sessionId, message: { id: 'msg_1', content: [{ type: 'text', text }] } };
  writeFileSync(p, `${JSON.stringify(entry)}\n`, 'utf8');
  return p;
}

function writeGrant(root, sessionId, obj) {
  mkdirSync(dirname(grantPath(root, sessionId)), { recursive: true });
  writeFileSync(grantPath(root, sessionId), JSON.stringify(obj), 'utf8');
}

function readSession(root, sessionId) {
  return loadState(root, sessionId);
}

// --- recordCompletion: прямые отказы и успех ---------------------------------------------

test('essentialStateDigest: отсутствующее и неполное состояние нормализуется', () => {
  assert.equal(essentialStateDigest(null), essentialStateDigest({}));
  assert.equal(essentialStateDigest({ history: 'not-an-array' }), essentialStateDigest({}));
  assert.notEqual(essentialStateDigest({ history: ['step'] }), essentialStateDigest({}));
});

test('recordCompletion: ошибка захвата замка возвращается без исключения', () => {
  const result = recordCompletion({
    root: tmpdir(),
    state: { session: '../invalid' },
    source: 'stop-hook',
    answer: PASS_ANSWER,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /недопустимая сессия замка/);
});

test('recordCompletion: состояние без сессии и устаревшее состояние отклоняются', () => {
  assert.deepEqual(recordCompletion({ root: tmpdir(), state: {}, source: 'stop-hook', answer: PASS_ANSWER }), {
    ok: false,
    reason: 'нет состояния сессии',
  });

  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const stale = readSession(root, sessionId);
    const changed = { ...stale, flags: { changed: true } };
    saveState(root, changed);
    const result = recordCompletion({ root, state: stale, source: 'stop-hook', answer: PASS_ANSWER });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'состояние подтверждения устарело');
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('recordCompletion: успех в терминале — подтверждение, verdict, журнал, диск', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const state = readSession(root, sessionId);
    const r = recordCompletion({ root, state, source: 'cli-transcript', answer: PASS_ANSWER });
    assert.equal(r.ok, true);
    assert.equal(r.completion.version, 1);
    assert.equal(r.completion.node, 'P5S1');
    assert.equal(r.verdict, 'pass');
    assert.equal(r.completion.identity.session, sessionId);
    assert.equal(r.completion.runtime.id, state.runtime.id);
    assert.equal(r.completion.state_sha256, essentialStateDigest(state));
    // на диске
    const fresh = readSession(root, sessionId);
    assert.equal(fresh.completion.answer_sha256, r.completion.answer_sha256);
    // в журнале
    const events = readJournal(root).filter((e) => e.type === 'completion');
    assert.equal(events.length, 1);
    assert.equal(events[0].session, sessionId);
    assert.equal(events[0].source, 'cli-transcript');
  });
});

test('recordCompletion: verdict извлекается из ответа независимо от пробелов', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const r1 = recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: 'RAILS: P5S1 итог. verdict = fail' });
    assert.equal(r1.ok, true);
    assert.equal(r1.verdict, 'fail');

    const sessionId2 = pinnedSession(root, 'P5S1');
    const r2 = recordCompletion({ root, state: readSession(root, sessionId2), source: 'stop-hook', answer: 'RAILS: P5S1 итог.\nverdict=not_reviewed' });
    assert.equal(r2.ok, true);
    assert.equal(r2.verdict, 'not_reviewed');
  });
});

test('recordCompletion: не-терминальный узел — отказ без записи', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P4S1');
    const state = readSession(root, sessionId);
    const r = recordCompletion({ root, state, source: 'stop-hook', answer: PASS_ANSWER });
    assert.equal(r.ok, false);
    assert.match(r.reason, /не терминальный/);
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('recordCompletion: ответ мимо выходного слоя — отказ с missing', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const r = recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: FAIL_ANSWER });
    assert.equal(r.ok, false);
    assert.match(r.reason, /выходной слой/);
    assert.ok(Array.isArray(r.missing) && r.missing.length > 0);
  });
});

test('recordCompletion: приостановка RAILS_OUTCOME — не завершение', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const r = recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: SUSPENSION_ANSWER });
    assert.equal(r.ok, false);
    assert.match(r.reason, /RAILS_OUTCOME/);
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('recordCompletion: без закреплённого runtime и с чужой привязкой — отказ', () => {
  withProject(({ root }) => {
    const sessionId = unpinnedSession(root, 'P5S1');
    const r = recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER });
    assert.equal(r.ok, false);
    assert.match(r.reason, /не закреплён/);

    const sessionId2 = pinnedSession(root, 'P5S1');
    const state2 = readSession(root, sessionId2);
    state2.runtime = { version: 1, id: '0'.repeat(64), hash: state2.runtime.hash };
    const r2 = recordCompletion({ root, state: state2, source: 'stop-hook', answer: PASS_ANSWER });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /личности запуска/);

    const sessionId3 = pinnedSession(root, 'P5S1');
    const state3 = readSession(root, sessionId3);
    state3.started = 'tampered';
    const r3 = recordCompletion({ root, state: state3, source: 'stop-hook', answer: PASS_ANSWER });
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /личности запуска/);
  });
});

test('recordCompletion: повреждённый runtime — отказ, не перекрепление', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const state = readSession(root, sessionId);
    const snapshot = join(root, '.workflow', 'state', 'rails-runtime', `${state.runtime.id}.json`);
    writeFileSync(snapshot, '{"payload": {"version": 1}}', 'utf8'); // хеш больше не сходится
    const r = recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER });
    assert.equal(r.ok, false);
    assert.match(r.reason, /runtime повреждён/);
  });
});

test('recordCompletion: уже завершённая сессия и неизвестный источник — отказ', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    let state = readSession(root, sessionId);
    assert.equal(recordCompletion({ root, state, source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    state = readSession(root, sessionId);
    writeCompletedMarker(root, sessionId, { t: new Date().toISOString(), completion_sha256: completionDigest(state.completion) });
    const r = recordCompletion({ root, state, source: 'stop-hook', answer: PASS_ANSWER });
    assert.equal(r.ok, false);
    assert.match(r.reason, /уже завершена/);

    const sessionId2 = pinnedSession(root, 'P5S1');
    const r2 = recordCompletion({ root, state: readSession(root, sessionId2), source: 'mystery', answer: PASS_ANSWER });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /источник/);
  });
});

// --- устаревание подтверждения -------------------------------------------------------------

test('существенное состояние изменилось после подтверждения — verifyExit отказывает', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    // ещё один Stop-блок после подтверждения (ответ перестал проходить) меняет счётчики
    const state = readSession(root, sessionId);
    state.counters['stop_blocks:P5S1'] = (state.counters['stop_blocks:P5S1'] || 0) + 1;
    saveState(root, state);
    const v = verifyExit({ root, session: sessionId });
    assert.equal(v.ok, false);
    assert.match(v.reason, /состояние изменилось/);
    // и переход в другой узел тоже устаревает подтверждение
    const sessionId2 = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId2), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const s2 = readSession(root, sessionId2);
    s2.node = 'P4S1';
    saveState(root, s2);
    assert.match(verifyExit({ root, session: sessionId2 }).reason, /состояние изменилось/);
  });
});

// Промежуточная функция вместо верхнего импорта: копия файла нужна в двух тестах.

// --- Stop-хук ------------------------------------------------------------------------------

test('Stop в терминале с проходным ответом — подтверждение сохранено, остановка разрешена', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const transcript = writeTranscript(base, sessionId, PASS_ANSWER);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcript },
      {}
    );
    assert.equal(r, null);
    assert.equal(readSession(root, sessionId).completion?.node, 'P5S1');
    assert.equal(readJournal(root).some((e) => e.type === 'completion'), true);
  });
});

test('Stop в узле паузы с проходным ответом паузы — разрешён, без подтверждения', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P4S1');
    const transcript = writeTranscript(base, sessionId, PAUSE_ANSWER);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcript },
      {}
    );
    assert.equal(r, null);
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('Stop с приостановкой — разрешён, без подтверждения', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const transcript = writeTranscript(base, sessionId, SUSPENSION_ANSWER);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcript },
      {}
    );
    assert.equal(r, null);
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('Stop с повреждённым snapshot — block fail-closed, без подтверждения', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const state = readSession(root, sessionId);
    const snapshot = join(root, '.workflow', 'state', 'rails-runtime', `${state.runtime.id}.json`);
    writeFileSync(snapshot, 'не json вовсе', 'utf8');
    const transcript = writeTranscript(base, sessionId, PASS_ANSWER);
    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcript },
      {}
    );
    // Ответ не приостановка — fail-closed блокирует, подтверждение не создаётся.
    assert.equal(r?.decision, 'block');
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

// --- CLI complete --------------------------------------------------------------------------

test('cli complete: проходной исторический ответ из transcript — подтверждение', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const transcript = writeTranscript(base, sessionId, PASS_ANSWER);
    const r = cliRun(['complete', '--transcript', transcript, '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Подтверждение завершения записано/);
    assert.match(r.stdout, /verdict: pass/);
    assert.equal(readSession(root, sessionId).completion?.source, 'cli-transcript');
    // повторная верификация допустима (идемпотентна)
    const r2 = cliRun(['complete', '--transcript', transcript, '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r2.code, 0, r2.stdout);
  });
});

test('cli complete: чужой transcript, имя не сессии, файла нет — отказы', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    // чужой: имя файла нашей сессии, записи — другой сессии
    const foreignName = join(base, `${sessionId}.jsonl`);
    writeFileSync(foreignName, `${JSON.stringify({ type: 'assistant', sessionId: uuid(), message: { id: 'm', content: [{ type: 'text', text: PASS_ANSWER }] } })}\n`, 'utf8');
    let r = cliRun(['complete', '--transcript', foreignName, '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /другой сессии/);
    // имя не совпадает с сессией
    const renamed = join(base, 'другой-файл.jsonl');
    copyFileSync(writeTranscript(base, sessionId, PASS_ANSWER), renamed);
    r = cliRun(['complete', '--transcript', renamed, '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /не совпадает с сессией/);
    // файла нет
    r = cliRun(['complete', '--transcript', join(base, 'нет.jsonl'), '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /не прочитан|нет/);
  });
});

test('cli complete: последний ответ не проходит выходной слой — отказ с перечнем', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const transcript = writeTranscript(base, sessionId, FAIL_ANSWER);
    const r = cliRun(['complete', '--transcript', transcript, '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /не создано/);
    assert.match(r.stdout, /Не выполнено/);
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('cli complete: без --transcript, без состояния — отказы; на завершённой — отказ', () => {
  withProject(({ base, root }) => {
    let r = cliRun(['complete'], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    const sessionId = pinnedSession(root, 'P5S1');
    r = cliRun(['complete', '--transcript', join(base, 'x.jsonl'), '--session', uuid()], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /не найдено/);
    // завершённая сессия
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const state = readSession(root, sessionId);
    writeCompletedMarker(root, sessionId, { t: new Date().toISOString(), completion_sha256: completionDigest(state.completion) });
    r = cliRun(['complete', '--transcript', writeTranscript(base, sessionId, PASS_ANSWER), '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /уже завершена/);
  });
});

// --- CLI exit: разрешение владельца -------------------------------------------------------

test('cli exit: без подтверждения — отказ, шаблона нет', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /подтверждения завершения нет/);
    assert.equal(readSession(root, sessionId).completed, undefined);
  });
});

test('cli exit: подтверждение есть, разрешения нет — отказ и шаблон с путём', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /разрешения владельца нет/);
    assert.match(r.stdout, new RegExp(grantPath(root, sessionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.stdout, /"version":1/);
    assert.equal(readSession(root, sessionId).completed, undefined);
  });
});

test('cli exit: чужое, просроченное и не подходящее разрешение — отказы', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const completion = readSession(root, sessionId).completion;
    const template = grantTemplate(completion, 1);

    // чужая сессия
    writeGrant(root, sessionId, { ...template, session: uuid() });
    let r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /другой сессии/);

    // просрочено
    writeGrant(root, sessionId, { ...template, expires_at: '2020-01-01T00:00:00.000Z' });
    r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /просрочено/);

    // нет срока
    writeGrant(root, sessionId, { version: 1, session: sessionId, completion_sha256: template.completion_sha256 });
    r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /expires_at/);

    // хеш другого подтверждения
    writeGrant(root, sessionId, { ...template, completion_sha256: 'a'.repeat(64) });
    r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /другому подтверждению/);

    // не json
    writeFileSync(grantPath(root, sessionId), '{битый', 'utf8');
    r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /не разобрать/);

    assert.equal(readSession(root, sessionId).completed, undefined);
  });
});

test('cli exit: штатно — отметка завершения, всё сохранено, журнал, разрешение потреблено', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const before = readSession(root, sessionId);
    writeGrant(root, sessionId, grantTemplate(before.completion, 1));

    const r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Выход выполнен/);

    const after = readSession(root, sessionId);
    // маркер завершения: отдельный файл, привязан к подтверждению
    const marker = readCompletedMarker(root, sessionId);
    assert.equal(marker.version, 1);
    assert.equal(marker.session, sessionId);
    assert.equal(marker.completion_sha256, completionDigest(before.completion));
    assert.equal(after.completed, undefined);
    // состояние, история, счётчики, runtime и подтверждение сохранены
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.counters, before.counters);
    assert.deepEqual(after.runtime, before.runtime);
    assert.deepEqual(after.completion, before.completion);
    assert.equal(after.skill, SKILL);
    assert.equal(after.node, 'P5S1');
    // журнал
    assert.equal(readJournal(root).some((e) => e.type === 'exit' && e.session === sessionId), true);
    // разрешение потреблено: исходника нет, остался .used
    assert.equal(existsSync(grantPath(root, sessionId)), false);
    const used = readdirSync(dirname(grantPath(root, sessionId))).filter((n) => n.startsWith(`.exit-grant-${sessionId}.json.`) && n.endsWith('.used'));
    assert.equal(used.length, 1);
    // перечень сессий не замусорен файлами разрешения
    assert.deepEqual(listSessionIds(root), [sessionId]);
  });
});

test('cli exit: повторный выход и параллельный конкурент — отказ (одноразовость)', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);
    // второй — уже завершена
    let r = cliRun(['exit', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /уже завершена/);
    // «конкурент»: разрешение ещё на месте (появилось между проверкой и потреблением)
    const sessionId2 = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId2), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId2, grantTemplate(readSession(root, sessionId2).completion, 1));
    assert.equal(performExit({ root, session: sessionId2 }).ok, true);
    writeGrant(root, sessionId2, grantTemplate(readSession(root, sessionId2).completion, 1)); // воссоздали после выхода
    const late = verifyExit({ root, session: sessionId2 });
    assert.equal(late.ok, false); // verifyExit refuses: уже завершена (маркер)
  });
});

test('замок выхода: живой владелец — busy, мёртвый — указание ручного удаления', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    const lockFile = join(root, '.workflow', 'state', 'rails', `.exit-lock-${sessionId}`);
    // живой владелец (наш pid) — отказ без потребления разрешения
    writeFileSync(lockFile, String(process.pid), 'utf8');
    let r = performExit({ root, session: sessionId });
    assert.equal(r.ok, false);
    assert.match(r.reason, /выполняются \(pid \d+\) — повтори команду/);
    assert.equal(existsSync(grantPath(root, sessionId)), true);
    // мёртвый владелец — клейм не похищается: отказ называет pid и путь
    const dead = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(lockFile, String(dead.pid), 'utf8');
    r = performExit({ root, session: sessionId });
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(`pid ${dead.pid}`));
    assert.match(r.reason, /удали файл/);
    assert.equal(existsSync(lockFile), true);
    // владелец убирает клейм руками — выход проходит
    rmSync(lockFile);
    r = performExit({ root, session: sessionId });
    assert.equal(r.ok, true, r.reason);
  });
});

// --- после выхода: нейтральный режим -------------------------------------------------------

test('после выхода: Stop не проверяет и не блокирует, счётчики не растут', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);
    const countersBefore = readSession(root, sessionId).counters;

    const r = handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: writeTranscript(base, sessionId, FAIL_ANSWER) },
      {}
    );
    assert.equal(r, null);
    const after = readSession(root, sessionId);
    assert.deepEqual(after.counters, countersBefore);
    // подтверждение не появляется заново (его не было в этом сценарии: exit по готовому)
    assert.equal(after.completion?.node, 'P5S1');
  });
});

test('после выхода: PreToolUse не ведёт сессию и роль из env не возвращает (G0)', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);

    // правка скилов по-прежнему только через коуча (G0), и это не режим скила
    const skillWrite = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: join(root, '.workflow', 'src', 'skills', 'новый', 'SKILL.md'), content: 'x' },
      },
      { WORKFLOW_RAILS_SKILL: SKILL }
    );
    assert.equal(skillWrite.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(skillWrite.hookSpecificOutput.permissionDecisionReason, /только через коуча/);

    // обычная запись вне дерева скилов — разрешена, рельсы узел не называют
    const plainWrite = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: join(root, 'заметка.md'), content: 'x' },
      },
      { WORKFLOW_RAILS_SKILL: SKILL }
    );
    assert.equal(plainWrite, null);

    // состояние не тронуто: маркер на месте, скил прежний, история не растёт
    const state = readSession(root, sessionId);
    assert.ok(readCompletedMarker(root, sessionId));
    assert.equal(state.skill, SKILL);
  });
});

test('после выхода: start/goto/reset отклоняются, состояние сохраняется', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);

    for (const argv of [
      ['start', SKILL, '--session', sessionId],
      ['start', SKILL, '--session', sessionId, '--force'],
      ['start', 'другой', '--session', sessionId, '--force'],
      ['goto', 'P4S1', '--quote', 'Задать вопрос владельцу и дождаться ответа', '--session', sessionId],
      ['reset', '--session', sessionId],
    ]) {
      const r = cliRun(argv, { cwd: root, env: {} });
      assert.equal(r.code, 2, `${argv.join(' ')}: ${r.stdout}`);
    }
    // goto и reset называют завершение, а не «нет ребра»/«закреплённый runtime»
    assert.match(cliRun(['goto', 'P4S1', '--quote', 'Задать вопрос владельцу и дождаться ответа', '--session', sessionId], { cwd: root, env: {} }).stdout, /завершена штатным выходом/);
    assert.match(cliRun(['reset', '--session', sessionId], { cwd: root, env: {} }).stdout, /reset отклонён/);
    // маркер цел
    assert.ok(readCompletedMarker(root, sessionId));
  });
});

test('после выхода: status показывает завершение, SessionStart и коррекция молчат', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);

    const status = cliRun(['status', '--session', sessionId], { cwd: root, env: {} });
    assert.equal(status.code, 0);
    assert.match(status.stdout, /завершена штатным выходом/);

    const start = handleHookInput({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: root }, { WORKFLOW_RAILS_SKILL: SKILL });
    assert.match(start.hookSpecificOutput.additionalContext, /завершён штатным выходом/);
    assert.doesNotMatch(start.hookSpecificOutput.additionalContext, /cli\.mjs start/);

    const correction = handleHookInput({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: root, prompt: 'нет, не то' }, {});
    assert.equal(correction, null);
    assert.equal(readSession(root, sessionId).flags.correction_pending, false);

    // PostToolUse не подсказывает узел
    const post = handleHookInput(
      { hook_event_name: 'PostToolUse', session_id: sessionId, cwd: root, tool_name: 'Read', tool_input: {} },
      {}
    );
    assert.equal(post, null);
  });
});

test('до выхода: status показывает подтверждение, SessionStart ведёт сессию как раньше', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const status = cliRun(['status', '--session', sessionId], { cwd: root, env: {} });
    assert.match(status.stdout, /Подтверждение завершения: есть/);

    const start = handleHookInput({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: root }, {});
    assert.match(start.hookSpecificOutput.additionalContext, /активен скил/);
  });
});

// --- целостность состояния ----------------------------------------------------------------

test('loadState: битое подтверждение — StateError, не молчаливый сброс', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const state = readSession(root, sessionId);
    state.completion = { ...state.completion, answer_sha256: 'нет' };
    saveState(root, state);
    assert.throws(() => readSession(root, sessionId), StateError);
  });
});

// --- write-policy: файл разрешения защищён ------------------------------------------------

test('файл разрешения в защищённом каталоге — запись отклонена классификатором', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const target = grantPath(root, sessionId);
    assert.throws(
      () => classifyWrites(root, [{ real: target, display: target }], 'write', root, null),
      WritePolicyError
    );
    assert.throws(
      () => classifyWrites(root, [{ real: target, display: target }], 'shell', root, SKILL),
      WritePolicyError
    );
  });
});

// --- cli-распознавание и журнал ------------------------------------------------------------

test('analyzeCliCommand: complete и exit — cli-вызовы с инъекцией --session', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    for (const cmd of [
      'node .workflow/src/rails/cli.mjs exit',
      'node .workflow/src/rails/cli.mjs complete --transcript t.jsonl',
    ]) {
      const r = analyzeCliCommand(cmd, 'posix', sessionId, { root, cwd: root });
      assert.equal(r.isCli, true, cmd);
      assert.match(r.command, /--session/);
    }
  });
});

test('журнал: summarize считает completion и exit', () => {
  withProject(({ root }) => {
    appendEvent(root, { type: 'completion', session: 's1', source: 'runner' });
    appendEvent(root, { type: 'exit', session: 's1' });
    appendEvent(root, { type: 'denial', session: 's1', node: 'P5S1', reason: 'x' });
    const summary = summarize(readJournal(root));
    assert.equal(summary.completions, 1);
    assert.equal(summary.exits, 1);
    const report = cliRun(['report'], { cwd: root, env: {} });
    assert.match(report.stdout, /Подтверждения завершения: 1; штатные выходы: 1/);
  });
});

// --- transcriptFinalAnswer: принадлежность и ответ одним чтением ---------------------------

test('transcriptFinalAnswer: отсутствующий файл своей сессии возвращает unreadable', () => {
  const sessionId = uuid();
  const result = transcriptFinalAnswer(join(tmpdir(), `${sessionId}.jsonl`), sessionId);
  assert.equal(result.ok, false);
  assert.equal(result.integrity, 'unreadable');
  assert.match(result.reason, /файла нет/);
});

test('transcriptFinalAnswer: обезличенный transcript без ответов — отказ', () => {
  withProject(({ base, root }) => {
    const sessionId = uuid();
    const p = join(base, `${sessionId}.jsonl`);
    writeFileSync(p, `${JSON.stringify({ type: 'user', message: {} })}\n`, 'utf8');
    const r = transcriptFinalAnswer(p, sessionId);
    assert.equal(r.ok, false);
    assert.match(r.reason, /принадлежность сессии не доказана/);
    // и cli complete по такому файлу отказывает
    const sessionId2 = pinnedSession(root, 'P5S1');
    const p2 = join(base, `${sessionId2}.jsonl`);
    writeFileSync(p2, `${JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: PASS_ANSWER }] } })}\n`, 'utf8');
    const cli = cliRun(['complete', '--transcript', p2, '--session', sessionId2], { cwd: root, env: {} });
    assert.equal(cli.code, 2);
    assert.match(cli.stdout, /принадлежность сессии не доказана/);
  });
});

test('transcriptFinalAnswer: rejects transcripts without assistant output and joins message fragments', () => {
  withProject(({ base }) => {
    const sessionId = uuid();
    const path = join(base, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: 'user', sessionId, message: {} })}\n`, 'utf8');
    assert.equal(transcriptFinalAnswer(path, sessionId).integrity, 'no-assistant');

    const fragments = [
      { type: 'assistant', sessionId, message: { id: 'joined', content: [{ type: 'text', text: 'first ' }] } },
      { type: 'assistant', sessionId, message: { id: 'joined', content: [{ type: 'text', text: 'second' }] } },
    ];
    writeFileSync(path, `${fragments.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    assert.deepEqual(transcriptFinalAnswer(path, sessionId), { ok: true, text: 'first second', timestamp: undefined, latest: true, integrity: 'ok' });

    const separateMessages = [
      { type: 'assistant', sessionId, message: { id: 'prior', content: [{ type: 'text', text: 'stale' }] } },
      { type: 'assistant', sessionId, message: { id: 'latest', content: [{ type: 'text', text: 'current' }] } },
    ];
    writeFileSync(path, `${separateMessages.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    assert.deepEqual(transcriptFinalAnswer(path, sessionId), { ok: true, text: 'current', timestamp: undefined, latest: true, integrity: 'ok' });
  });
});

test('transcriptFinalAnswer: non-array content yields an empty answer', () => {
  withProject(({ base }) => {
    const sessionId = uuid();
    const path = join(base, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify({
      type: 'assistant', sessionId, message: { content: { type: 'text', text: 'not an array' } },
    })}\n`, 'utf8');
    assert.equal(transcriptFinalAnswer(path, sessionId).integrity, 'empty');
  });
});

test('transcriptFinalAnswer: skips blank records and refuses malformed JSON', () => {
  withProject(({ base }) => {
    const sessionId = uuid();
    const path = join(base, `${sessionId}.jsonl`);
    const entry = JSON.stringify({ type: 'assistant', sessionId, message: { content: [{ type: 'text', text: 'answer' }] } });
    writeFileSync(path, `\n${entry}\n`, 'utf8');
    assert.equal(transcriptFinalAnswer(path, sessionId).text, 'answer');
    writeFileSync(path, '{malformed json}\n', 'utf8');
    assert.equal(transcriptFinalAnswer(path, sessionId).ok, false);
  });
});

test('пустое последнее сообщение ассистента снимает прежнее подтверждение', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const state = readSession(root, sessionId);
    state.counters['stop_blocks:P5S1'] = 2; // потолок исчерпан — счётчики не растут
    saveState(root, state);
    // последнее сообщение без текста — это новый исход, не записанный ответ
    handleHookInput(
      {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: root,
        transcript_path: writeTranscript(base, sessionId, [
          { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
        ]),
      },
      {}
    );
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

// --- регрессии ревью 2026-10-06 -------------------------------------------------------------

test('blocker: завершённая сессия не пишет в защищённое состояние (Write и shell-редирект)', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);
    const target = grantPath(root, sessionId);

    const stateWrite = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: target, content: '{}' },
      },
      {}
    );
    assert.equal(stateWrite.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(stateWrite.hookSpecificOutput.permissionDecisionReason, /защищённая|действие отклонено/);

    const shellWrite = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: `echo x > .workflow/state/rails/.exit-grant-${sessionId}.json` },
      },
      {}
    );
    assert.equal(shellWrite.hookSpecificOutput.permissionDecision, 'deny');

    // чужая отметка и чужое разрешение не записаны, состояние не тронуто
    assert.ok(readCompletedMarker(root, sessionId));
    assert.equal(existsSync(target), false);
  });
});

test('major: cli-вызов завершённой сессии получает --session, и start отказывает', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);

    const r = handleHookInput(
      {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: 'node .workflow/src/rails/cli.mjs start completetest' },
      },
      {}
    );
    // хук не пустил команду без --session: идентификатор подставлен
    const injected = r.hookSpecificOutput.updatedInput.command;
    assert.match(injected, new RegExp(`--session ${sessionId}`));
    // с подставленным идентификатором CLI отказывает поверх завершённой сессии
    const started = cliRun(['start', SKILL, '--session', sessionId], { cwd: root, env: {} });
    assert.equal(started.code, 2);
    assert.match(started.stdout, /завершена штатным выходом/);
  });
});

test('major: приостановка и непроходной ответ снимают прежнее подтверждение', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const stopWith = (text) => handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: writeTranscript(base, sessionId, text) },
      {}
    );

    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    // приостановка — последний исход: подтверждение снято
    assert.equal(stopWith(SUSPENSION_ANSWER), null);
    assert.equal(readSession(root, sessionId).completion, undefined);
    assert.equal(readJournal(root).some((e) => e.type === 'completion' && e.invalidated), true);

    // непроходной ответ при исчерпанном потолке (счётчики не растут) — тоже снимает
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const state = readSession(root, sessionId);
    state.counters['stop_blocks:P5S1'] = 2; // max_stop_blocks: 2 — потолок исчерпан
    saveState(root, state);
    // подтверждение связано со старым состоянием; после бампа оно бы устарело,
    // поэтому проверяем снятие на свежем подтверждении
    assert.equal(verifyExit({ root, session: sessionId }).ok, false);
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    assert.equal(stopWith(FAIL_ANSWER), null);
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('major: чужая запись в середине transcript — отказ', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const p = join(base, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'assistant', sessionId, message: { id: 'm1', content: [{ type: 'text', text: PASS_ANSWER }] } }),
      JSON.stringify({ type: 'assistant', sessionId: uuid(), message: { id: 'm2', content: [{ type: 'text', text: PASS_ANSWER }] } }),
    ];
    writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    const r = transcriptFinalAnswer(p, sessionId);
    assert.equal(r.ok, false);
    assert.match(r.reason, /другой сессии/);
    // и cli complete по такому файлу отказывает
    const cli = cliRun(['complete', '--transcript', p, '--session', sessionId], { cwd: root, env: {} });
    assert.equal(cli.code, 2);
    assert.equal(readSession(root, sessionId).completion, undefined);
  });
});

test('minor: повторная верификация того же ответа не меняет подтверждение и грант', () => {
  withProject(({ base, root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    const transcript = writeTranscript(base, sessionId, PASS_ANSWER);
    assert.equal(cliRun(['complete', '--transcript', transcript, '--session', sessionId], { cwd: root, env: {} }).code, 0);
    const before = readSession(root, sessionId).completion;
    const template = grantTemplate(before);

    // повторный complete того же ответа и тот же ответ через Stop
    assert.equal(cliRun(['complete', '--transcript', transcript, '--session', sessionId], { cwd: root, env: {} }).code, 0);
    handleHookInput(
      { hook_event_name: 'Stop', session_id: sessionId, cwd: root, transcript_path: transcript },
      {}
    );
    const after = readSession(root, sessionId).completion;
    assert.deepEqual(after, before);
    assert.equal(completionDigest(after), template.completion_sha256);
  });
});

test('major: повреждённый и чужой маркер — StateError; второй маркер не создаётся', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    // не JSON
    writeFileSync(completedMarkerPath(root, sessionId), '{битый', 'utf8');
    assert.throws(() => readCompletedMarker(root, sessionId), StateError);
    // чужая сессия в маркере
    writeFileSync(
      completedMarkerPath(root, sessionId),
      JSON.stringify({ version: 1, session: uuid(), t: new Date().toISOString(), completion_sha256: 'a'.repeat(64) }),
      'utf8'
    );
    assert.throws(() => readCompletedMarker(root, sessionId), StateError);

    // одноразовость: существующий маркер не перезаписывается
    const sessionId2 = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId2), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeCompletedMarker(root, sessionId2, { t: new Date().toISOString(), completion_sha256: completionDigest(readSession(root, sessionId2).completion) });
    assert.throws(
      () => writeCompletedMarker(root, sessionId2, { t: new Date().toISOString(), completion_sha256: 'b'.repeat(64) }),
      StateError
    );
  });
});

test('major: конкурирующая запись состояния не стирает отметку завершения', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeGrant(root, sessionId, grantTemplate(readSession(root, sessionId).completion, 1));
    assert.equal(cliRun(['exit', '--session', sessionId], { cwd: root, env: {} }).code, 0);

    // «писатель, прочитавший состояние до выхода»: перезаписывает состояние как хочет —
    // маркер от этого не зависит
    const stale = structuredClone(readSession(root, sessionId));
    stale.counters['чужой-счётчик'] = 99;
    saveState(root, stale);
    assert.ok(readCompletedMarker(root, sessionId));
    assert.equal(readSession(root, sessionId).counters['чужой-счётчик'], 99);
  });
});

test('неснятое подтверждение: надгробие и журнальный след закрывают exit, удача снимает', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const digest = completionDigest(readSession(root, sessionId).completion);
    const tomb = join(root, '.workflow', 'state', 'rails', `.invalid-${sessionId}.json`);

    // надгробие ДРУГОГО подтверждения exit не блокирует
    writeFileSync(tomb, JSON.stringify({ version: 1, session: sessionId, completion_sha256: 'c'.repeat(64) }), 'utf8');
    assert.equal(verifyExit({ root, session: sessionId }).ok, true);

    // надгробие этого подтверждения — отказ
    writeFileSync(tomb, JSON.stringify({ version: 1, session: sessionId, completion_sha256: digest }), 'utf8');
    let v = verifyExit({ root, session: sessionId });
    assert.equal(v.ok, false);
    assert.match(v.reason, /неснятое подтверждение/);

    // журнальный след без надгробия — тоже отказ (по хешу подтверждения)
    rmSync(tomb);
    appendEvent(root, { type: 'error', session: sessionId, completion_sha256: digest, message: 'invalidation: подтверждение не снято на диске (тест) — повторная остановка с тем же исходом снимет снова' });
    v = verifyExit({ root, session: sessionId });
    assert.equal(v.ok, false);
    assert.match(v.reason, /неснятое подтверждение/);

    // удавшаяся инвалидация снимает след: подтверждение снято с диска, и
    // следующий отказ — уже «подтверждения нет», а не «неснятое»
    assert.equal(invalidateCompletion({ root, state: readSession(root, sessionId), cause: 'тест' }).removed, true);
    v = verifyExit({ root, session: sessionId });
    assert.equal(v.ok, false);
    assert.match(v.reason, /подтверждения завершения нет/);
  });
});

test('invalidateCompletion: без подтверждения, на завершённой и под чужим замком — ничего не делает', () => {
  withProject(({ root }) => {
    const sessionId = pinnedSession(root, 'P5S1');
    assert.equal(invalidateCompletion({ root, state: readSession(root, sessionId), cause: 'тест' }).removed, false);
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    const state = readSession(root, sessionId);
    writeCompletedMarker(root, sessionId, { t: new Date().toISOString(), completion_sha256: completionDigest(state.completion) });
    assert.equal(invalidateCompletion({ root, state, cause: 'тест' }).removed, false);
    // подтверждение завершённой сессии не тронуто
    assert.ok(readSession(root, sessionId).completion);

    // чужой живой замок (клейм живого pid) — снимающий уходит, следующий Stop повторит
    const sessionId2 = pinnedSession(root, 'P5S1');
    assert.equal(recordCompletion({ root, state: readSession(root, sessionId2), source: 'stop-hook', answer: PASS_ANSWER }).ok, true);
    writeFileSync(join(root, '.workflow', 'state', 'rails', `.exit-lock-${sessionId2}`), String(process.pid), 'utf8');
    const inv = invalidateCompletion({ root, state: readSession(root, sessionId2), cause: 'тест' });
    assert.equal(inv.removed, false);
    assert.equal(inv.busy, true);
    assert.ok(readSession(root, sessionId2).completion);
  });
});

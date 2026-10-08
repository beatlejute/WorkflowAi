// Проверка передачи по закреплённому запуску. Не выдаёт разрешений и не
// устанавливает интерактивное происхождение по роли или окружению.
import { createHash, randomUUID } from 'node:crypto';
import { loadState, readCompletedMarker, StateError } from './state.mjs';
import { lstatSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { withLifecycleLock } from './lifecycle-lock.mjs';
import { appendEvent } from './journal.mjs';
import { loadWritePolicy } from './write-policy.mjs';
import { loadSkillRuntime } from './core.mjs';
import { essentialStateDigest, transcriptFinalAnswer } from './completion.mjs';
import { launchOrigin, sameLaunch } from './launch-origin.mjs';
import { realpathDeep } from './paths.mjs';
import { check } from './output-check.mjs';

function markerPath(root, session) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(session))) throw new StateError('недопустимая сессия передачи');
  return join(root, '.workflow', 'state', 'rails', `.handoff-${session}.json`);
}

/** Отдельный маркер не стирается конкурирующим сохранением состояния. */
export function readHandoff(root, session) {
  const path = markerPath(root, session);
  let marker;
  try {
    loadWritePolicy(root);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('маркер доступен через ссылку');
    marker = JSON.parse(readFileSync(path, 'utf8'));
    if (stat.nlink !== 1) {
      // После прерванной публикации допускается только её собственное второе имя.
      if (stat.nlink !== 2 || !/^[a-f0-9-]{36}$/.test(marker?.publication_id ?? '')) {
        throw new Error('маркер доступен через ссылку');
      }
      withLifecycleLock(root, session, () => {
        const temporary = `${path}.${marker.publication_id}.tmp`;
        const current = lstatSync(path);
        let pending;
        try { pending = lstatSync(temporary); }
        catch { throw new Error('временное имя публикации отсутствует или недоступно'); }
        if (!pending.isFile() || pending.isSymbolicLink() || pending.nlink !== 2
          || current.nlink !== 2 || current.ino !== stat.ino || current.dev !== stat.dev
          || pending.ino !== current.ino || pending.dev !== current.dev) {
          throw new Error('временное имя не принадлежит публикации маркера');
        }
        unlinkSync(temporary);
        if (lstatSync(path).nlink !== 1) throw new Error('маркер доступен через ссылку');
      });
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StateError(`маркер передачи не прочитан: ${error.message}`);
  }
  if (marker?.version !== 1 || marker.outcome !== 'out_of_scope'
    || marker.identity?.session !== session || marker.identity?.root !== realpathDeep(root)
    || !['unknown', 'interactive', 'managed'].includes(marker.origin) || !marker.evidence || typeof marker.evidence !== 'object'
    || Array.isArray(marker.evidence) || digest(marker.evidence) !== marker.evidence_sha256
    || !marker.evidence.identity || typeof marker.evidence.identity !== 'object'
    || digest(marker.identity) !== digest(marker.evidence.identity)
    || marker.evidence?.identity?.session !== session
    || !marker.t || Number.isNaN(Date.parse(marker.t))) {
    throw new StateError('маркер передачи повреждён');
  }
  const state = loadState(root, session);
  if (!state?.runtime || digest(marker.identity) !== state.runtime.id
    || digest(marker.evidence.runtime) !== digest(state.runtime)
    || marker.evidence.state_sha256 !== essentialStateDigest(state)
    || marker.evidence.node !== state.node
    || marker.origin !== marker.evidence.origin
    || marker.origin !== (state.launch?.origin ?? 'unknown')
    || digest(marker.evidence.launch ?? { origin: 'unknown' }) !== digest(state.launch ?? { origin: 'unknown' })) {
    throw new StateError('маркер передачи не соответствует текущему закреплённому состоянию');
  }
  loadSkillRuntime(root, state.skill, state);
  return marker;
}

/** Запись передачи не создаёт completion, grant или интерактивных полномочий. */
export function relinquish(args) {
  try {
    return withLifecycleLock(args.root, args.session, (lock) => {
      if (readHandoff(args.root, args.session)) return { ok: false, reason: 'передача уже записана' };
      const verified = verifyHandoff(args);
      if (!verified.ok) return verified;
      const marker = {
        version: 1, t: new Date().toISOString(), outcome: 'out_of_scope', origin: verified.evidence.origin,
        publication_id: randomUUID(),
        identity: verified.evidence.identity, evidence: verified.evidence,
        evidence_sha256: digest(verified.evidence),
      };
      // Попытка не означает опубликованную передачу; маркер — точка фиксации.
      appendEvent(args.root, {
        type: 'handoff_attempt', session: args.session, skill: marker.identity.skill,
        run: marker.identity.run, outcome: marker.outcome, evidence_sha256: marker.evidence_sha256,
      });
      const path = markerPath(args.root, args.session);
      const temporary = `${path}.${marker.publication_id}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' });
        if (!lock.owns()) return { ok: false, reason: 'замок передачи потерян' };
        // link публикует полный файл без замены существующего маркера.
        linkSync(temporary, path);
      } finally {
        try { unlinkSync(temporary); } catch { /* недоступный временный файл не даёт полномочий */ }
      }
      const persisted = readHandoff(args.root, args.session);
      return { ok: true, marker: persisted };
    });
  } catch (error) {
    return { ok: false, reason: `передача не сохранена: ${error.message}` };
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Только проверка доказательства; состояние, история и grants не меняются. */
export function verifyHandoff({ root, session, transcriptPath, expectedStateDigest, answer, source, run }) {
  const refuse = (reason) => ({ ok: false, reason });
  try {
    const state = loadState(root, session);
    if (!state?.runtime) return refuse('нет закреплённого состояния запуска');
    if (readCompletedMarker(root, session)) return refuse('сессия уже завершена штатным выходом');
    if (!expectedStateDigest || essentialStateDigest(state) !== expectedStateDigest) {
      return refuse('доказательство не привязано к текущему существенному состоянию');
    }
    const identity = {
      root: realpathDeep(root), session: state.session, skill: state.skill,
      run: state.run ?? null, started: state.started,
    };
    if (digest(identity) !== state.runtime.id) return refuse('повреждена идентичность закреплённого запуска');
    const { config } = loadSkillRuntime(root, state.skill, state);
    const launch = state.launch ?? { origin: 'unknown' };
    let transcript;
    if (source === 'runner') {
      if (launch.origin === 'interactive') return refuse('ответ раннера не может освободить интерактивный запуск');
      transcript = typeof answer === 'string' && typeof run === 'string' && run && state.run === run
        ? { ok: true, text: answer }
        : { ok: false, reason: 'ответ раннера не привязан к запуску сессии' };
    } else {
      const current = launchOrigin(root, session);
      if (current.callback !== 'stop-hook' || !sameLaunch(launch, current)) {
        return refuse('нет подтверждённого закреплённого хоста передачи');
      }
      transcript = transcriptFinalAnswer(transcriptPath ?? '', session);
      if (transcript.ok && (!transcript.latest || !Number.isFinite(Date.parse(transcript.timestamp))
        || Date.parse(transcript.timestamp) < Date.parse(state.updated)
        || Date.parse(transcript.timestamp) < Date.parse(state.started))) {
        return refuse('ответ transcript старше текущего состояния запуска');
      }
    }
    if (!transcript.ok) return refuse(`transcript не принят: ${transcript.reason}`);
    const result = check(transcript.text, config, state);
    if (!result.ok || result.outcome !== 'out_of_scope') return refuse('ответ не прошёл политику передачи');
    const fields = {};
    for (const field of ['REQUEST', 'REASON', 'DONE', 'REMAINING']) {
      const matches = [...transcript.text.matchAll(new RegExp(`^${field}: ([^\\r\\n\\s][^\\r\\n]*)$`, 'gm'))];
      if (matches.length !== 1) return refuse(`поле ${field} отсутствует или неоднозначно`);
      fields[field.toLowerCase()] = matches[0][1];
    }
    return {
      ok: true,
      evidence: {
        version: 1, outcome: 'out_of_scope', identity,
        runtime: { ...state.runtime }, node: state.node,
        state_sha256: expectedStateDigest, answer_sha256: digest(transcript.text),
        origin: launch.origin,
        launch, source: source === 'runner' ? 'runner' : 'stop-hook', ...fields,
      },
    };
  } catch (error) {
    return refuse(`передача не проверена: ${error.message}`);
  }
}

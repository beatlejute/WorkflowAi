// Штатный выход из роли (2026-10-06): подтверждение завершения + одноразовое
// разрешение владельца. Дефект: «pass» Stop-гейта не сохранялся, сброс
// закреплённого runtime запрещён безусловно — сессия в терминальном узле
// оставалась под рельсами навсегда (Адъютант 2026-10-06, P8S2 скила coach).
//
// Терминальный узел и разрешённый Stop сами по себе завершением не считаются:
// Stop разрешает остановку и после исчерпания потолка блокировок. Доказательство
// — проверенный выходным слоем финальный ответ ПО закреплённому runtime:
//   • stop-хук сохраняет подтверждение при положительной проверке в терминале;
//   • `cli.mjs complete --transcript <файл>` — то же по историческому ответу
//     из transcript (чужой transcript и сессия-не-владелец файла отказывают);
//   • раннер — по проверенному ответу стадии.
// Приостановка RAILS_OUTCOME (blocked/needs_user) — не завершение: работы ждут
// владельца, подтверждения она не создаёт. Завершённый отрицательный verdict —
// завершение процедуры (записывается verdict из ответа), успешность продукта —
// не её забота.
//
// Сам выход (`cli.mjs exit`) требует файл разрешения владельца — точный
// (привязан к сессии и хешу подтверждения), с обязательным сроком, одноразовый
// (потребляется переименованием). Файл кладёт владелец в защищённый каталог
// состояний: запись туда классификатор целей закрывает и роли executor, и
// shell-записям (write-policy.mjs), шаблон печатает отказ `exit`. Это граница
// честности, не криптография — см. README §16.

import { createHash } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';

import { loadSkillRuntime } from './core.mjs';
import { loadState, saveState } from './state.mjs';
import { realpathDeep } from './paths.mjs';
import { appendEvent } from './journal.mjs';
import { check as outputCheck, lastAssistantText } from './output-check.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Хеш существенного состояния: узел, история (длина и последний переход),
 * счётчики, отказы, флаги, привязка runtime. `updated` и `dedupe` — служебные,
 * в хеш не входят. Изменение любой существенной части после подтверждения
 * делает подтверждение устаревшим (`verifyExit` отказывает).
 *
 * @param {object} state
 * @returns {string} hex sha256
 */
export function essentialStateDigest(state) {
  const s = state && typeof state === 'object' ? state : {};
  const history = Array.isArray(s.history) ? s.history : [];
  return digest({
    version: 1,
    skill: s.skill ?? null,
    node: s.node ?? null,
    run: s.run ?? null,
    started: s.started ?? null,
    counters: s.counters ?? {},
    denials: s.denials ?? {},
    flags: s.flags ?? {},
    history_len: history.length,
    history_last: history.length > 0 ? history[history.length - 1] : null,
    runtime: s.runtime ?? null,
  });
}

/**
 * Хеш подтверждения — к нему привязывается разрешение владельца: разрешение
 * от другого подтверждения (например, снятого до устаревания) не принимается.
 *
 * @param {object} completion объект `state.completion`
 * @returns {string} hex sha256
 */
export function completionDigest(completion) {
  return digest(completion);
}

// Личность запуска — те же поля, из которых pinnedRuntime считает id привязки:
// расхождение с state.runtime.id означает повреждение привязки.
function launchIdentity(root, state) {
  return {
    root: realpathDeep(root),
    session: state.session,
    skill: state.skill,
    run: state.run ?? null,
    started: state.started,
  };
}

// Значение `verdict = …` из проверенного ответа (строка, до 80 символов), или
// null — строку `verdict =` ответ не содержит. Регистр значения сохраняется.
function extractVerdict(text) {
  const m = /^.*\bverdict[ \t]*=[ \t]*([^\r\n]{1,80})/im.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
}

const SOURCES = new Set(['stop-hook', 'cli-transcript', 'runner']);

/**
 * Доверенная проверка финального ответа закреплённого запуска и запись
 * подтверждения завершения в `state.completion` (с сохранением состояния и
 * записью `type: "completion"` в журнал).
 *
 * Все условия обязательны, первое нарушенное — отказ без записи:
 * закреплённый runtime (его повреждение — отказ, не перекрепление), узел в
 * `config.terminal`, ответ прочитан и прошёл выходной слой, ответ — не
 * приостановка RAILS_OUTCOME. Подтверждение не «раскачивает» рельсы: оно
 * ничего не разрешает без разрешения владельца (`performExit`).
 *
 * @param {{root: string, state: object, source: 'stop-hook'|'cli-transcript'|'runner',
 *          answer?: string|null, transcriptPath?: string|null}} args
 *   `answer` — уже извлечённый текст ответа (stop-хук и раннер проверяют его сами);
 *   иначе текст берётся из `transcriptPath` (последнее сообщение ассистента).
 * @returns {{ok: boolean, reason?: string, missing?: string[], completion?: object, verdict?: string|null}}
 */
export function recordCompletion({ root, state, source, answer = null, transcriptPath = null }) {
  const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (!state || !state.session || !state.skill) return refuse('нет состояния сессии');
  if (state.completed) return refuse('сессия уже завершена штатным выходом');
  if (!SOURCES.has(source)) return refuse(`неизвестный источник подтверждения: ${String(source)}`);
  if (!state.runtime) return refuse('runtime сессии не закреплён — подтверждение не создаётся');

  const identity = launchIdentity(root, state);
  if (digest(identity) !== state.runtime.id) {
    return refuse('привязка runtime не соответствует личности запуска (повреждена)');
  }

  let runtime;
  try {
    runtime = loadSkillRuntime(root, state.skill, state);
  } catch (err) {
    return refuse(`runtime повреждён: ${err && err.message ? err.message : err}`);
  }
  const terminal = Array.isArray(runtime.config?.terminal) ? runtime.config.terminal : [];
  if (!terminal.includes(state.node)) {
    return refuse(`узел ${state.node} не терминальный (${terminal.join(', ') || 'терминалов нет'}) — подтверждение не создаётся`);
  }

  let text = answer;
  if (typeof text !== 'string') {
    text = lastAssistantText(transcriptPath ?? '');
  }
  if (!String(text).trim()) {
    return refuse('финальный ответ не прочитан (transcript пуст или недоступен)');
  }

  const result = outputCheck(text, runtime.config, state);
  if (!result.ok) {
    return refuse('финальный ответ не прошёл выходной слой закреплённого runtime', { missing: result.missing });
  }
  if (result.outcome) {
    return refuse(`приостановка RAILS_OUTCOME: ${result.outcome} — не завершение, подтверждение не создаётся`);
  }

  const completion = {
    version: 1,
    t: new Date().toISOString(),
    source,
    identity,
    runtime: { version: 1, id: state.runtime.id, hash: state.runtime.hash },
    node: state.node,
    answer_sha256: digest(String(text)),
    state_sha256: essentialStateDigest(state),
    verdict: extractVerdict(text),
  };
  state.completion = completion;
  state.updated = completion.t;
  try {
    saveState(root, state);
  } catch (err) {
    delete state.completion;
    return refuse(`подтверждение не сохранено: ${err && err.message ? err.message : err}`);
  }
  try {
    appendEvent(root, {
      type: 'completion',
      session: state.session,
      skill: state.skill,
      node: state.node,
      run: state.run ?? null,
      source,
      answer_sha256: completion.answer_sha256,
      state_sha256: completion.state_sha256,
      verdict: completion.verdict,
    });
  } catch {
    // журнал не должен ронять подтверждение
  }
  return { ok: true, completion, verdict: completion.verdict };
}

// Файл разрешения — в защищённом каталоге состояний, имя с точкой: его не
// подбирает listSessionIds (перечень сессий проекта остаётся перечнем сессий).
/**
 * Путь файла разрешения владельца для сессии.
 *
 * @param {string} root
 * @param {string} sessionId
 * @returns {string}
 */
export function grantPath(root, sessionId) {
  return join(root, '.workflow', 'state', 'rails', `.exit-grant-${String(sessionId)}.json`);
}

/**
 * Ожидаемое содержимое разрешения для подтверждения. Владелец создаёт файл сам
 * (вне инструментов агента — запись в защищённый каталог им закрыта); CLI
 * разрешения не создаёт. Срок обязателен: просроченное разрешение не принимается.
 *
 * @param {object} completion объект `state.completion`
 * @param {number} [ttlHours] срок действия шаблона (для подсказки), по умолчанию 24
 * @returns {{version: number, session: string, completion_sha256: string, expires_at: string}}
 */
export function grantTemplate(completion, ttlHours = 24) {
  return {
    version: 1,
    session: completion.identity.session,
    completion_sha256: completionDigest(completion),
    expires_at: new Date(Date.now() + ttlHours * 3600000).toISOString(),
  };
}

/**
 * Проверка всего, кроме файла разрешения: подтверждение есть и цело, runtime
 * тот же и не повреждён, узел всё ещё терминальный, существенное состояние не
 * менялось с момента подтверждения (в том числе между чтением состояния
 * вызывающим кодом и этой проверкой — перечитывается с диска).
 *
 * @param {{root: string, session: string}} args
 * @returns {{ok: boolean, reason?: string, state?: object, completion?: object}}
 */
export function verifyExit({ root, session }) {
  const fail = (reason) => ({ ok: false, reason });
  let state;
  try {
    state = loadState(root, session);
  } catch (err) {
    return fail(`состояние сессии не прочитано: ${err && err.message ? err.message : err}`);
  }
  if (!state) return fail('состояние сессии не найдено');
  if (state.completed) return fail(`сессия уже завершена штатным выходом (${state.completed.t}) — повторный exit не нужен`);
  const completion = state.completion;
  if (!completion || completion.version !== 1) {
    return fail('подтверждения завершения нет — сначала верификация финального ответа (complete или Stop в терминале)');
  }
  if (!state.runtime || state.runtime.id !== completion.runtime?.id || state.runtime.hash !== completion.runtime?.hash) {
    return fail('runtime изменился после подтверждения — подтверждение недействительно');
  }
  if (essentialStateDigest(state) !== completion.state_sha256) {
    return fail('состояние изменилось после подтверждения — подтверждение устарело, повтори верификацию (complete или Stop в терминале)');
  }
  let runtime;
  try {
    runtime = loadSkillRuntime(root, state.skill, state);
  } catch (err) {
    return fail(`runtime повреждён: ${err && err.message ? err.message : err}`);
  }
  const terminal = Array.isArray(runtime.config?.terminal) ? runtime.config.terminal : [];
  if (!terminal.includes(state.node)) {
    return fail(`узел ${state.node} больше не терминальный — подтверждение недействительно`);
  }
  return { ok: true, state, completion };
}

/**
 * Штатный выход: проверить подтверждение, потребовать и потребовать одноразово
 * потребить разрешение владельца, отметить сессию завершённой (`state.completed`),
 * сохранив состояние, историю, счётчики, привязку runtime и журнал целиком.
 * Хуки и CLI после отметки сессию больше не ведут; роль из окружения хоста
 * не возвращается (старый запуск не перезаписывается — `start` отказывает).
 *
 * @param {{root: string, session: string, now?: number}} args
 * @returns {{ok: boolean, reason?: string, grantPath?: string, grantTemplate?: object,
 *            state?: object, completion?: object}}
 */
export function performExit({ root, session, now = Date.now() }) {
  const verified = verifyExit({ root, session });
  if (!verified.ok) return verified;
  const { state, completion } = verified;

  const path = grantPath(root, session);
  const failWithTemplate = (reason) => ({ ok: false, reason, grantPath: path, grantTemplate: grantTemplate(completion) });

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return failWithTemplate('разрешения владельца нет — владелец создаёт файл по шаблону ниже и повторяет exit');
  }
  let grant;
  try {
    grant = JSON.parse(raw);
  } catch {
    return failWithTemplate('файл разрешения не разобрать (не JSON)');
  }
  const expected = grantTemplate(completion);
  if (!grant || typeof grant !== 'object' || Array.isArray(grant) || grant.version !== 1) {
    return failWithTemplate('разрешение: неподдерживаемая версия (ожидается объект version: 1)');
  }
  if (grant.session !== session) {
    return failWithTemplate(`разрешение выдано другой сессии (${JSON.stringify(grant.session ?? null)})`);
  }
  if (grant.completion_sha256 !== expected.completion_sha256) {
    return failWithTemplate('разрешение привязано к другому подтверждению (устарело) — повтори верификацию и выпуск разрешения');
  }
  const expiry = Date.parse(grant.expires_at);
  if (!Number.isFinite(expiry)) {
    return failWithTemplate('разрешение: нет корректного срока expires_at');
  }
  if (now >= expiry) {
    return failWithTemplate(`разрешение просрочено (${grant.expires_at})`);
  }

  // Одноразовость — переименованием: у второго параллельного выхода исходник
  // уже исчезнет (rename атомарен), и он откажет. Сбой отметки ниже оставляет
  // разрешение потреблённым — владелец перевыпускает, это дешевле повторного
  // использования.
  const consumed = `${path}.${process.pid}.${now}.used`;
  try {
    renameSync(path, consumed);
  } catch (err) {
    return failWithTemplate(`разрешение не потреблено: ${err && err.message ? err.message : err}`);
  }

  state.completed = {
    version: 1,
    t: new Date().toISOString(),
    completion_sha256: expected.completion_sha256,
    grant_expires_at: grant.expires_at,
  };
  state.updated = state.completed.t;
  try {
    saveState(root, state);
  } catch (err) {
    try {
      appendEvent(root, {
        type: 'error',
        session,
        message: `exit: отметка завершения не сохранена (${err && err.message ? err.message : err}); разрешение потреблено, требуется перевыпуск`,
      });
    } catch {
      // журнал недоступен — отказ всё равно возвращён
    }
    return failWithTemplate('отметка завершения не сохранена — разрешение потреблено, владелец перевыпускает');
  }
  try {
    appendEvent(root, {
      type: 'exit',
      session,
      skill: state.skill,
      node: state.node,
      run: state.run ?? null,
      completion_sha256: expected.completion_sha256,
    });
  } catch {
    // журнал не должен ронять выполненный выход
  }
  return { ok: true, state, completion };
}

/**
 * Transcript принадлежит сессии: имя файла — `<sessionId>.jsonl`, и первый
 * разобранный объект несёт тот же `sessionId`. Чужой или обезличенный файл —
 * отказ: подтверждение строится только по своему историческому ответу.
 *
 * @param {string} transcriptPath
 * @param {string} sessionId
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyTranscriptOwnership(transcriptPath, sessionId) {
  const name = basename(String(transcriptPath ?? ''));
  const stem = name.replace(/\.jsonl$/i, '');
  if (stem !== String(sessionId)) {
    return { ok: false, reason: `имя transcript «${name}» не совпадает с сессией ${sessionId} (ожидается <sessionId>.jsonl)` };
  }
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `transcript не прочитан: ${err && err.code === 'ENOENT' ? 'файла нет' : err.message}` };
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.sessionId === 'string') {
      if (entry.sessionId === sessionId) return { ok: true };
      return { ok: false, reason: `transcript принадлежит другой сессии (${entry.sessionId})` };
    }
  }
  return { ok: false, reason: 'в transcript нет ни одной записи с sessionId — принадлежность сессии не доказана' };
}

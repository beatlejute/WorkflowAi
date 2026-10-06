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

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

import { loadSkillRuntime } from './core.mjs';
import {
  loadState,
  saveState,
  readCompletedMarker,
  writeCompletedMarker,
  completedMarkerPath,
} from './state.mjs';
import { realpathDeep } from './paths.mjs';
import { appendEvent, readJournal } from './journal.mjs';
import { check as outputCheck } from './output-check.mjs';

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
  if (readCompletedMarker(root, state.session)) return refuse('сессия уже завершена штатным выходом');
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
    const fromTranscript = transcriptFinalAnswer(transcriptPath ?? '', state.session);
    if (!fromTranscript.ok) return refuse(`transcript не принят: ${fromTranscript.reason}`);
    text = fromTranscript.text;
  }
  if (!String(text).trim()) {
    return refuse('финальный ответ не прочитан (transcript пуст или недоступен)');
  }

  // Повторная верификация того же доказательства не создаёт новое
  // подтверждение: у подтверждения тот же ответ, узел, runtime и состояние —
  // объект не трогается, иначе новой меткой инвалидалось бы уже выданное
  // разрешение владельца (ревью 2026-10-06, minor).
  const prev = state.completion;
  if (prev && prev.version === 1
    && prev.answer_sha256 === digest(String(text))
    && prev.node === state.node
    && prev.runtime?.id === state.runtime.id
    && prev.runtime?.hash === state.runtime.hash
    && prev.state_sha256 === essentialStateDigest(state)
    && prev.identity?.session === state.session) {
    return { ok: true, completion: prev, verdict: prev.verdict, unchanged: true };
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

// Надгробие неснятого подтверждения: инвалидация не сохранилась — пока оно
// живёт и привязано к ТЕКУЩЕМУ подтверждению, exit отказывает. Снимается
// удавшейся инвалидацией (повторная остановка с тем же исходом); надгробие
// другого подтверждения (новая верификация после сбоя) не учитывается.
function invalidationPath(root, session) {
  return join(root, '.workflow', 'state', 'rails', `.invalid-${String(session)}.json`);
}

// Надгробие или журнальный след неснятого подтверждения с ИМЕННО ЭТИМ хешем.
// Журнальная ошибка несёт completion_sha256; след другого (например, уже
// перевыпущенного) подтверждения exit не блокирует (ревью 2026-10-06:
// историческая запись не должна блокировать вечно).
function existsInvalidation(root, session, digest) {
  try {
    const raw = readFileSync(invalidationPath(root, session), 'utf8');
    const t = JSON.parse(raw);
    if (t && typeof t === 'object' && t.completion_sha256 === digest) return true;
  } catch {
    // надгробия нет (или не о том подтверждении)
  }
  try {
    for (const e of readJournal(root)) {
      if ((e.session ?? null) !== session) continue;
      // ошибка с хешем этого подтверждения — след сбоя инвалидации или
      // неудачного отката; сообщения не фильтруются по префиксу: хеш —
      // самодостаточный признак (ревью 2026-10-06)
      if (e.type === 'error' && e.completion_sha256 === digest) return true;
    }
  } catch {
    // журнал недоступен — решают надгробие и диск
  }
  return false;
}

/**
 * Снятие подтверждения: последний исход сессии — не тот ответ, который был
 * проверен (приостановка RAILS_OUTCOME или ответ мимо выходного слоя).
 * Подтверждение другого ответа недействительно, даже если существенное
 * состояние не изменилось (исчерпанный Stop-лимит счётчиков не растит).
 * Без подтверждения — ничего не делает. Сбой сохранения виден в журнале
 * (type: "error"): молча «снятое» подтверждение осталось бы на диске.
 *
 * @param {{root: string, state: object, cause: string}} args
 * @returns {boolean} было ли что снимать
 */
export function invalidateCompletion({ root, state, cause, now = Date.now() }) {
  if (!state || !state.session || !state.completion) return { removed: false };
  // Под тем же замком, что и выход, но без ожидания: замок занят выходом —
  // снимающий уходит, следующий Stop с тем же исходом повторит. Без замка
  // инвалидация вклинивалась бы между перечитыванием и маркером выхода
  // (ревью 2026-10-06). Сбой захвата (диск недоступен) — не «нет работы»,
  // а видимый неудавшийся след: вызывающий блокирует остановку.
  let lock;
  try {
    lock = acquireExitLock(root, state.session);
  } catch (err) {
    return { removed: false, attempted: true, traced: false, error: err };
  }
  if (lock.busy) {
    // Сбой похищения замка мёртвого владельца — fault окружения, а не «занято»:
    // возвращается как неудавшийся след, Stop блокирует остановку
    // (ревью 2026-10-06).
    if (lock.stealFailed) return { removed: false, attempted: true, traced: false };
    return { removed: false, busy: true };
  }
  try {
    // Замок мог быть похищен, пока брали (наш клейм исчез или сменился).
    try {
      if (readFileSync(lock.token, 'utf8') !== String(process.pid)) return { removed: false, attempted: true, traced: false };
    } catch {
      return { removed: false, attempted: true, traced: false };
    }
    // Маркер мог появиться, пока брали замок.
    if (readCompletedMarker(root, state.session)) return { removed: false };
    const completion = state.completion;
    const digest = completionDigest(completion);
    // Замок могли похитить, пока инвалидация спала перед сохранением: без
    // замка сохранение запрещено, подтверждение в памяти восстанавливается —
    // иначе выход, похитивший замок мёртвого владельца, встал бы на неснятое
    // подтверждение (ревью 2026-10-06, девятый круг).
    if (!existsSync(lock.token) || readFileSync(lock.token, 'utf8') !== String(process.pid)) {
      state.completion = completion;
      return { removed: false, stolen: true };
    }
    delete state.completion;
    state.updated = new Date().toISOString();
    let saved = true;
    let traced = true;
    try {
      saveState(root, state);
      try {
        unlinkSync(invalidationPath(root, state.session));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    } catch (err) {
      saved = false;
      try {
        writeFileSync(
          invalidationPath(root, state.session),
          JSON.stringify({ version: 1, session: state.session, completion_sha256: digest, t: new Date().toISOString(), cause: String(cause ?? '') }),
          'utf8'
        );
      } catch {
        traced = false; // и надгробие не записалось
      }
      try {
        appendEvent(root, {
          type: 'error',
          session: state.session,
          completion_sha256: digest,
          message: `invalidation: подтверждение не снято на диске (${err && err.message ? err.message : err}) — повторная остановка с тем же исходом снимет снова`,
        });
      } catch {
        traced = false; // и журнального следа нет — вызывающий обязан сделать сбой видимым
      }
    }
    try {
      appendEvent(root, {
        type: 'completion',
        session: state.session,
        skill: state.skill,
        node: state.node,
        run: state.run ?? null,
        invalidated: true,
        saved,
        cause,
      });
    } catch {
      // журнал не должен ронять снимающего
    }
    return { removed: true, saved, traced };
  } finally {
    lock.release();
  }
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
  const completion = state.completion;
  if (!completion || completion.version !== 1) {
    return fail('подтверждения завершения нет — сначала верификация финального ответа (complete или Stop в терминале)');
  }
  // Неснятое подтверждение ИМЕННО ЭТОГО подтверждения (надгробие или
  // журнальная ошибка) — раньше маркера: оставшийся от неудачного отката
  // маркер не должен маскировать сбой инвалидации (ревью 2026-10-06).
  if (existsInvalidation(root, session, completionDigest(completion))) {
    return fail('есть неснятое подтверждение (сбой инвалидации) — повтори Stop с непроходным ответом или приостановкой');
  }
  let marker;
  try {
    marker = readCompletedMarker(root, session);
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  }
  if (marker) {
    if (marker.completion_sha256 !== completionDigest(completion)) {
      return fail('маркер завершения не совпадает с подтверждением (повреждение жизненного цикла) — нужен ручной разбор');
    }
    return fail(`сессия уже завершена штатным выходом (${marker.t}) — повторный exit не нужен`);
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

// Жив ли процесс-владелец замка. process.kill(pid, 0): ESRCH — мёртв,
// EPERM — жив (существование при чужих правах).
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Замок выхода — ОДИН ФАЙЛ с атомарным эксклюзивным созданием ('wx'):
// в каждый момент времени путь занимает ровно один клейм, двойного захвата
// не существует. В файле — pid владельца: пока владелец жив, замок не
// похищается вовсе (пауза процесса — своп, отладчик, нагрузка — не открывает
// чужой замок, все чередования пауз выхода и инвалидации упираются в чистые
// busy или отказы); замок МЁРТВОГО владельца похищается атомарным
// переименованием файла в сторону, после чего новый клейм снова проходит
// через 'wx' — у двух похитителей успех ровно у одного. Пид переиспользован
// посторонним живым процессом (или файл не читается) — консервативный busy
// до ручного удаления файла (README §16). Возвращает {busy: true,
// stealFailed?} либо {lockFile, token, release}.
function acquireExitLock(root, session) {
  const lockDir = join(root, '.workflow', 'state', 'rails');
  const lockFile = join(lockDir, `.exit-lock-${session}`);
  mkdirSync(lockDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockFile, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, String(process.pid), 0, 'utf8');
      } finally {
        closeSync(fd);
      }
      const token = lockFile;
      const release = () => {
        try {
          // наш клейм неотличим от нашего же файла: пока мы живы, похищения
          // не было; снимаем по совпадению pid
          if (readFileSync(token, 'utf8') === String(process.pid)) unlinkSync(token);
        } catch {
          // файла нет или уже чужой — не наш
        }
      };
      return { busy: false, lockFile, token, release };
    }
    // Файл занят: читаем владельца. Не читается или pid не распознан —
    // консервативно «занято» (ручное удаление описано в README §16).
    let owner = null;
    try {
      const raw = readFileSync(lockFile, 'utf8').trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) owner = pid;
    } catch {
      owner = null;
    }
    if (owner === null || pidAlive(owner)) return { busy: true };
    // Владелец мёртв: похищение атомарным переименованием файла. У двух
    // похитителей успех ровно у одного — у второго ENOENT; новый клейм после
    // этого снова проходит через 'wx' (ревью 2026-10-06, одиннадцатый круг).
    const aside = `${lockFile}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
    try {
      renameSync(lockFile, aside);
    } catch {
      return { busy: true, stealFailed: true };
    }
    try {
      rmSync(aside, { force: true });
    } catch {
      // заброшенный клейм уберёт следующее похищение
    }
    // следующий виток цикла — 'wx' по свободному пути
  }
  return { busy: true, stealFailed: true };
}

/**
 * Штатный выход: проверить подтверждение, одноразово потребить разрешение
 * владельца и создать маркер завершения — отдельный файл с одним писателем,
 * который конкурирующая запись состояния стереть не может. Состояние,
 * история, счётчики, привязка runtime и журнал сохраняются. Хуки и CLI после
 * маркера сессию больше не ведут; роль из окружения хоста не возвращается
 * (старый запуск не перезаписывается — `start` отказывает).
 *
 * @param {{root: string, session: string, now?: number}} args
 * @returns {{ok: boolean, reason?: string, grantPath?: string, grantTemplate?: object,
 *            marker?: object, completion?: object}}
 */
export function performExit({ root, session, now = Date.now() }) {
  const verified = verifyExit({ root, session });
  if (!verified.ok) return verified;
  const { completion } = verified;

  const path = grantPath(root, session);
  const failWithTemplate = (reason) => ({ ok: false, reason, grantPath: path, grantTemplate: grantTemplate(completion) });

  // Блокировка выхода: сериализует потребление разрешения и отметку против
  // второго параллельного exit. mkdir без recursive: существующий каталог
  // даёт EEXIST. Замок с живым владельцем не похищается вовсе (токен несёт
  // pid), замок мёртвого — переименовывается в сторону с проверкой содержимого
  // (ревью 2026-10-06).
  let lock;
  try {
    lock = acquireExitLock(root, session);
  } catch (err) {
    return failWithTemplate(`замок выхода не создан: ${err && err.message ? err.message : err}`);
  }
  if (lock.busy) {
    return failWithTemplate(lock.stealFailed
      ? 'замок выхода повреждён (сбой доступа к .workflow/state) — устраните доступ и повтори команду'
      : 'другой выход этой сессии выполняется — повтори команду');
  }
  try {
    return exitLocked({ root, session, completion, path, token: lock.token, failWithTemplate, now });
  } finally {
    lock.release();
  }
}

// Шаги выхода под замком: потребление разрешения, перечитывание состояния,
// отметка и пост-проверка записи. Владение замком перепроверяется по токену
// перед потреблением разрешения и перед маркером: похищение (наш каталог
// переименовал другой процесс) отменяет шаги — атомарность потребления и 'wx'
// маркера ограничивают последствия (ревью 2026-10-06).
function exitLocked({ root, session, completion, path, token, failWithTemplate, now }) {

  // Наш клейм на месте (файл с нашим pid)? Похищение мёртвого возможно
  // только после нашей смерти — живому выходу потеря означает отказ.
  const lostLock = () => {
    try {
      return readFileSync(token, 'utf8') !== String(process.pid);
    } catch {
      return true;
    }
  };
  if (lostLock()) return failWithTemplate('замок выхода потерян — повтори команду');

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
  if (lostLock()) return failWithTemplate('замок выхода потерян — повтори команду');
  try {
    renameSync(path, consumed);
  } catch (err) {
    return failWithTemplate(`разрешение не потреблено: ${err && err.message ? err.message : err}`);
  }

  // Между проверкой и отметкой состояние могли изменить (хук, другая команда):
  // отметка ставится на перечитанное состояние и только при действительном
  // подтверждении — иначе выход исполнялся бы по устаревшему доказательству
  // (ревью 2026-10-06, major). След неснятого подтверждения (неудачная
  // инвалидация после первой проверки) здесь тоже перечитывается.
  let fresh;
  try {
    fresh = loadState(root, session);
  } catch (err) {
    return failWithTemplate(`состояние не перечитано: ${err && err.message ? err.message : err}`);
  }
  if (!fresh || !fresh.completion
    || existsInvalidation(root, session, expected.completion_sha256)
    || completionDigest(fresh.completion) !== expected.completion_sha256
    || essentialStateDigest(fresh) !== fresh.completion.state_sha256) {
    return failWithTemplate('состояние изменилось в процессе выхода — подтверждение устарело, повтори верификацию и выпуск разрешения');
  }

  // Маркер завершения — отдельный файл с одним писателем: конкурирующая запись
  // состояния не может его стереть. 'wx': второй выход (или гонка двух)
  // отклоняется.
  if (lostLock()) return failWithTemplate('замок выхода потерян — повтори команду');
  let marker;
  try {
    marker = writeCompletedMarker(root, session, {
      t: new Date().toISOString(),
      completion_sha256: expected.completion_sha256,
      grant_expires_at: grant.expires_at,
    });
  } catch (err) {
    try {
      appendEvent(root, {
        type: 'error',
        session,
        message: `exit: маркер завершения не создан (${err && err.message ? err.message : err}); разрешение потреблено, требуется перевыпуск`,
      });
    } catch {
      // журнал недоступен — отказ всё равно возвращён
    }
    return failWithTemplate('маркер завершения не создан — разрешение потреблено, владелец перевыпускает');
  }
  // Запоздавшее похищение: замок украли, пока шла запись маркера — шаги после
  // паузы ненадёжны, маркер снимается обратно, выход не состоялся (ревью
  // 2026-10-06, восьмой круг).
  if (lostLock()) {
    try {
      unlinkSync(completedMarkerPath(root, session));
    } catch {
      // не снялся — след неснятого подтверждения (ниже) не даст выйти повторно
      try {
        writeFileSync(
          invalidationPath(root, session),
          JSON.stringify({ version: 1, session, completion_sha256: expected.completion_sha256, t: new Date().toISOString(), cause: 'exit: маркер при потерянном замке не снят' }),
          'utf8'
        );
      } catch {
        // остаётся журнальная запись ниже
      }
    }
    try {
      appendEvent(root, {
        type: 'error',
        session,
        completion_sha256: expected.completion_sha256,
        message: 'exit: замок потерян в момент выхода — маркер снят, разрешение потреблено, требуется перевыпуск',
      });
    } catch {
      // журнал недоступен — отказ всё равно возвращён
    }
    return failWithTemplate('замок выхода потерян в момент выхода — разрешение потреблено, владелец перевыпускает');
  }

  // Инвалидация, вклинившаяся между перечитыванием и маркером (в том числе
  // во время паузы процесса), делает подтверждение неснятым: маркер снимается
  // обратно, выход не состоялся (ревью 2026-10-06, седьмой круг).
  let after;
  try {
    after = loadState(root, session);
  } catch {
    after = null;
  }
  if (!after || !after.completion
    || existsInvalidation(root, session, expected.completion_sha256)
    || completionDigest(after.completion) !== expected.completion_sha256
    || essentialStateDigest(after) !== after.completion.state_sha256) {
    let reverted = true;
    try {
      unlinkSync(completedMarkerPath(root, session));
    } catch {
      reverted = false; // маркер остался — сессия числится завершённой при снятом подтверждении
      // след неснятого подтверждения: verifyExit обязан отказаться раньше «уже завершена»
      try {
        writeFileSync(
          invalidationPath(root, session),
          JSON.stringify({ version: 1, session, completion_sha256: expected.completion_sha256, t: new Date().toISOString(), cause: 'exit: неудачный откат маркера' }),
          'utf8'
        );
      } catch {
        // и надгробие не записалось — остаётся журнальная запись ниже
      }
    }
    try {
      appendEvent(root, {
        type: 'error',
        session,
        completion_sha256: expected.completion_sha256,
        message: `exit: подтверждение изменилось в момент выхода — маркер ${reverted ? 'снят' : 'НЕ снят (удалите .completed-<session>.json вручную)'}, разрешение потреблено, требуется перевыпуск`,
      });
    } catch {
      // журнал недоступен — отказ всё равно возвращён
    }
    return failWithTemplate(reverted
      ? 'подтверждение изменилось в момент выхода — разрешение потреблено, владелец перевыпускает'
      : 'подтверждение изменилось в момент выхода, маркер снять не удалось — устраните доступ к .workflow/state и разберите вручную');
  }

  // Пост-проверка: маркер действительно на диске.
  let persisted = null;
  try {
    persisted = readCompletedMarker(root, session);
  } catch {
    persisted = null;
  }
  if (!persisted || persisted.completion_sha256 !== expected.completion_sha256) {
    try {
      appendEvent(root, {
        type: 'error',
        session,
        message: 'exit: маркер не сохранился после записи — разрешение потреблено, владелец перевыпускает',
      });
    } catch {
      // журнал недоступен — отказ всё равно возвращён
    }
    return failWithTemplate('маркер завершения не сохранился после записи — разрешение потреблено, владелец перевыпускает');
  }

  try {
    appendEvent(root, {
      type: 'exit',
      session,
      skill: fresh.skill,
      node: fresh.node,
      run: fresh.run ?? null,
      completion_sha256: expected.completion_sha256,
    });
  } catch {
    // журнал не должен ронять выполненный выход
  }
  return { ok: true, marker, completion: fresh.completion, state: fresh };
}

/**
 * Transcript принадлежит сессии, и последний ответ ассистента извлекается из
 * ОДНОГО чтения (ревью 2026-10-06, major): имя файла — `<sessionId>.jsonl`,
 * хотя бы одна запись несёт `sessionId` сессии (отсутствие доказательства —
 * отказ, а не пропуск), каждая запись с полем `sessionId` несёт тот же id,
 * а ответ — последний ассистентский текст этого же файла.
 *
 * `integrity` различает исходы для снимающего подтверждение: 'ok' — ответ
 * прочитан и принадлежит сессии; 'empty' — файл свой, но последнее сообщение
 * ассистента без текста (это тоже новый исход, не записанный ответ);
 * 'foreign'/'unreadable'/'no-session-id'/'no-assistant' — доказательства
 * нет, о последнем исходе сказать нечего.
 *
 * @param {string} transcriptPath
 * @param {string} sessionId
 * @returns {{ok: boolean, reason?: string, text?: string,
 *            integrity: 'ok'|'empty'|'foreign'|'unreadable'|'no-session-id'|'no-assistant'}}
 */
export function transcriptFinalAnswer(transcriptPath, sessionId) {
  const name = basename(String(transcriptPath ?? ''));
  const stem = name.replace(/\.jsonl$/i, '');
  if (stem !== String(sessionId)) {
    return { ok: false, reason: `имя transcript «${name}» не совпадает с сессией ${sessionId} (ожидается <sessionId>.jsonl)`, integrity: 'foreign' };
  }
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `transcript не прочитан: ${err && err.code === 'ENOENT' ? 'файла нет' : err.message}`, integrity: 'unreadable' };
  }
  const entries = [];
  let sawOwnId = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.sessionId === 'string') {
      if (entry.sessionId !== sessionId) {
        return { ok: false, reason: `transcript принадлежит другой сессии (${entry.sessionId})`, integrity: 'foreign' };
      }
      sawOwnId = true;
    }
    entries.push(entry);
  }
  if (!sawOwnId) {
    return { ok: false, reason: 'в transcript нет ни одной записи с sessionId — принадлежность сессии не доказана', integrity: 'no-session-id' };
  }
  let lastIdx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === 'assistant') {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) {
    return { ok: false, reason: 'в transcript нет ответов ассистента', integrity: 'no-assistant' };
  }
  // Склейка хвостовых строк одного сообщения — как в output-check.lastAssistantText.
  const lastId = entries[lastIdx]?.message?.id;
  let startIdx = lastIdx;
  if (typeof lastId === 'string' && lastId.length > 0) {
    let i = lastIdx - 1;
    while (i >= 0 && entries[i]?.type === 'assistant' && entries[i]?.message?.id === lastId) {
      startIdx = i;
      i -= 1;
    }
  }
  const texts = [];
  for (let i = startIdx; i <= lastIdx; i += 1) {
    const content = entries[i]?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  const text = texts.join('');
  if (!text.trim()) {
    return { ok: false, reason: 'последнее сообщение ассистента без текста', integrity: 'empty' };
  }
  return { ok: true, text, integrity: 'ok' };
}

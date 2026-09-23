// Преднагрузка тестового прогона (`node --test --import ./src/tests/_rails-home.mjs …`).
// Память «сессия → корень» рельсов (session-memo.mjs) живёт в <WORKFLOW_HOME>/state:
// без изоляции временные проекты тестов вытесняют реальные сессии из
// ~/.workflow/state/rails-sessions.json (≤ 50 записей). Каждый дочерний процесс
// раннера получает свой пустой WORKFLOW_HOME и убирает его на выходе.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';

// Объявление до вызова armWorkerWatchdog: const в TDZ, обращение из функции
// ниже упало бы с ReferenceError (проверено запуском).
export const DEFAULT_WORKER_CAP_MS = 300_000;

// `--import` живёт в execArgv, а его наследует не только дочерний процесс
// воркера, но и КАЖДЫЙ worker thread внутри него — включая поток-наблюдателя
// ниже. Без этой отсечки преднагрузка в потоке заводила бы следующий поток, и
// так до упора (проверено запуском: поток за потоком, пока процесс не падал).
// Потоку изоляция и не нужна: WORKFLOW_HOME он получает копией env от родителя.
if (isMainThread) {
  process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
  process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

  armWorkerWatchdog();
}

// Порог страховки берётся из WORKFLOW_TEST_WORKER_CAP_MS. Значение приходит
// строкой из окружения, поэтому разбор отделён и покрыт тестами:
//   • переменной нет или она пустая — порог по умолчанию;
//   • «0» — страховка выключена намеренно (так её снимают в тестах самой
//     страховки, чтобы наблюдатель не плодил потоки);
//   • не число («5s», «abc») — раньше давало Number → NaN, страховка молча не
//     вставала, и набор висел вечно ровно там, где её и ждали. Теперь опечатка
//     видна в выводе, а порог берётся по умолчанию: fail-closed.
export function resolveWorkerCapMs(env = process.env, warn = message => process.stderr.write(message)) {
  const raw = env.WORKFLOW_TEST_WORKER_CAP_MS;
  if (raw === undefined || raw === '') return DEFAULT_WORKER_CAP_MS;

  const capMs = Number(raw);
  if (Number.isFinite(capMs) && capMs >= 0) return capMs;

  warn(
    `[test-worker-watchdog] WORKFLOW_TEST_WORKER_CAP_MS="${raw}" — не число миллисекунд. ` +
    `Беру порог по умолчанию ${DEFAULT_WORKER_CAP_MS} мс; чтобы выключить страховку, задайте 0.\n`
  );
  return DEFAULT_WORKER_CAP_MS;
}

// ---------------------------------------------------------------------------
// Страховка от залипшего воркера (регресс: src/tests/test-worker-watchdog.test.mjs)
//
// `node --test --test-isolation=process` считает файл завершённым только когда
// его дочерний процесс вышел. Любая неотпущенная ручка (незавершённый
// polling-цикл, таймер, watcher, сокет, дочерний процесс) держит воркер живым
// после того, как тесты файла уже прошли, — и весь прогон стоит без отчёта:
// вывод остальных файлов копится в родителе и не печатается. `--test-timeout`
// от этого не спасает: он ограничивает тест, а не жизнь процесса.
//
// Страховка двухслойная, потому что залипнуть можно двумя разными способами:
//
// 1. Асинхронная утечка — тесты кончились, ручка жива, loop свободен. Ловится
//    таймером в самом воркере: он unref-нутый (процесс живым не держит), зато
//    печатает список удерживаемых ресурсов и выходит кодом 13.
// 2. Синхронная блокировка — главный поток стоит в execSync/spawnSync или в
//    долгой синхронной работе и до timers-фазы не доходит. Таймер из п.1 при
//    этом НЕ стреляет (проверено запуском: src/tests/init.test.mjs с cap=100 мс
//    — страховка инертна все 36 с прогона), а таких файлов в наборе 9
//    (`grep -rlE 'execSync|spawnSync' src/tests/*.test.mjs
//    src/skills/*/tests/rails/*.test.mjs`). Ловится наблюдателем в отдельном
//    потоке (src/tests/_worker-watchdog-thread.mjs): у него свой loop, от
//    главного потока он не зависит и добивает процесс сигналом.
//
// Поток стреляет позже таймера на GRACE_MS: у асинхронного залипания диагностика
// из п.1 информативнее (список удерживаемых ручек), отдавать её потоку незачем.
// ---------------------------------------------------------------------------
function armWorkerWatchdog() {
  const capMs = resolveWorkerCapMs();
  const GRACE_MS = 1000;
  if (!process.env.NODE_TEST_CONTEXT || capMs <= 0) return;

  const watchdog = setTimeout(() => {
    const held = typeof process.getActiveResourcesInfo === 'function'
      ? process.getActiveResourcesInfo().join(', ')
      : 'unknown';
    // Формулировка без обвинения: страховка знает только стенные часы, а не
    // причину. Держит ручку утёкший тест — список ресурсов это покажет; файл
    // просто долгий — порог поднимается переменной, и она названа прямо здесь.
    process.stderr.write(
      `[test-worker-watchdog] ${process.argv[1] || 'test file'}: воркер не вышел за ${capMs} мс ` +
      `(порог WORKFLOW_TEST_WORKER_CAP_MS). Удерживаются: ${held}. ` +
      'Если ручку не отпустил тест — закройте её в after/afterEach или ограничьте ожидание; ' +
      'если файлу честно нужно больше времени — поднимите WORKFLOW_TEST_WORKER_CAP_MS.\n'
    );
    process.exit(13);
  }, capMs);
  watchdog.unref();

  try {
    const observer = new Worker(new URL('./_worker-watchdog-thread.mjs', import.meta.url), {
      workerData: { capMs: capMs + GRACE_MS, file: process.argv[1] || '' }
    });
    // unref: сам наблюдатель не должен мешать здоровому воркеру выйти сразу.
    observer.unref();
    // Без обработчика ошибка внутри потока прилетела бы в главный поток
    // необработанным исключением и уронила бы чужой тест. Страховка — не повод
    // ломать прогон: остаётся слой 1.
    observer.on('error', () => {});
  } catch {
    // Потоки недоступны (сборка без worker_threads) — остаётся слой 1.
  }
}

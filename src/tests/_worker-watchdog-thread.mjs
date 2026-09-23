// Наблюдатель за воркером `node --test`, живущий ВНЕ главного потока.
// Запускается из src/tests/_rails-home.mjs (см. там причину); отдельный файл, а
// не eval-строка, чтобы код было видно и читался stack trace.
//
// Зачем поток, а не таймер в самом воркере: таймер стреляет только когда event
// loop главного потока доходит до timers-фазы. Файл, который зовёт
// execSync/spawnSync на подвисшем ребёнке или делает долгую синхронную работу,
// до неё не доходит никогда — просроченный таймер молчит, а весь набор стоит без
// отчёта (проверено запуском: src/tests/init.test.mjs с cap=100 мс, страховка
// инертна все 36 с). Поток крутит свой собственный loop и от главного не зависит.
import { rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { workerData } from 'node:worker_threads';

const { capMs, file } = workerData;

// Каталог WORKFLOW_HOME этого воркера (его создала преднагрузка в главном
// потоке до запуска наблюдателя, так что в копии env он уже есть). Сигнал не
// даёт выполниться process.on('exit'), поэтому убираем каталог сами — иначе
// каждое срабатывание страховки оставляло бы в %TEMP% пустой каталог навсегда.
function removeWorkflowHome() {
  const home = process.env.WORKFLOW_HOME;
  if (!home) return;
  // Только свой временный каталог: боевой ~/.workflow снести нельзя.
  if (dirname(home) !== tmpdir() || !basename(home).startsWith('rails-test-home-')) return;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Занят — пустой каталог в %TEMP% безвреднее висящего набора.
  }
}

setTimeout(() => {
  // writeSync прямо в fd 2, а не console.error/process.stderr: stdio потока
  // проксируется в главный поток сообщениями, а он может быть заблокирован —
  // тогда сообщение не вышло бы вообще. fd 2 — прямой syscall.
  writeSync(
    2,
    `[test-worker-watchdog] ${file || 'test file'}: воркер не вышел за ${capMs} мс, ` +
    'и таймеры в нём не стреляют — главный поток заблокирован синхронно ' +
    '(execSync/spawnSync на подвисшем ребёнке, синхронная fs-работа). ' +
    'Добиваем процесс из потока-наблюдателя, чтобы падал один файл, а не весь набор. ' +
    'Ограничьте ожидание в самом тесте (timeout у дочернего процесса) ' +
    'или поднимите WORKFLOW_TEST_WORKER_CAP_MS, если файлу честно нужно больше.\n'
  );
  removeWorkflowHome();
  // Не process.exit(): в потоке он завершает только сам поток. Сигнал идёт
  // процессу целиком и не зависит от состояния главного потока.
  process.kill(process.pid, 'SIGKILL');
}, capMs);

// Фикстура для test-worker-watchdog.test.mjs.
// Тест блокирует главный поток СИНХРОННО: так ведут себя файлы набора, которые
// зовут execSync/spawnSync на подвисшем ребёнке или делают долгую синхронную
// работу (`grep -rlE 'execSync|spawnSync' src/tests/*.test.mjs
// src/skills/*/tests/rails/*.test.mjs` — 9 файлов). Пока главный поток стоит,
// event loop не доходит до timers-фазы: unref-нутый таймер внутри процесса не
// стреляет, и страховка на таймере молчит. Добить такой воркер может только
// наблюдатель вне главного потока.
//
// Atomics.wait, а не busy-loop: блокировка та же, но без жжения ядра.
// Не подпадает под глоб `src/tests/*.test.mjs` — в набор не попадает.
import { it } from 'node:test';

// Больше бюджета SELF_EXIT_BUDGET_MS в тесте: без страховки прогон не выйдет сам.
const BLOCK_MS = 40_000;

it('блокирует главный поток синхронно — таймеры не стреляют', () => {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, BLOCK_MS);
});

// Фикстура для test-worker-watchdog.test.mjs: обычный быстрый файл без утечек.
// Нужна, чтобы проверить, что страховка не убивает здоровый воркер.
import { it } from 'node:test';
import { strict as assert } from 'node:assert';

it('проходит и отпускает все ресурсы', () => {
  assert.equal(1 + 1, 2);
});

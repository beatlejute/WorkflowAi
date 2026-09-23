// Фикстура для test-worker-watchdog.test.mjs: файл теста подменяет WORKFLOW_HOME
// на свой каталог — так делают тесты хука, плагина Kilo и CLI, которым нужен
// пустой дом под своё состояние. Преднагрузка обязана убрать СВОЙ каталог, а не
// тот, что видит в переменной на выходе. Не подпадает под глоб
// `src/tests/*.test.mjs` — в набор не попадает.
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const own = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.env.WORKFLOW_HOME = own;
process.on('exit', () => rmSync(own, { recursive: true, force: true }));

it('подменяет WORKFLOW_HOME на свой каталог и убирает его сам', () => {});

/**
 * Загрузчик модулей для скриптов целевого проекта (src/wf-loader.mjs).
 *
 * Зачем он есть: скрипты пайплайна выполняются в каталоге проекта, а зависимости стоят
 * рядом с самим workflow-ai. `workflow run` поэтому прокидывает этот загрузчик через
 * NODE_OPTIONS=--import (src/cli.mjs), и `import 'js-yaml'` из скрипта проекта
 * разрешается в node_modules workflow-ai — без установки зависимостей в каждый проект.
 *
 * Почему тест через дочерний процесс: загрузчик работает только будучи зарегистрированным
 * при старте процесса (register из node:module), поведение внутри своего же процесса
 * проверить нельзя. Отсюда три запуска в каталоге без node_modules:
 *  1) контроль — без загрузчика импорт обязан падать ERR_MODULE_NOT_FOUND. Этот запуск
 *     доказывает саму фикстуру: если бы рядом нашлись чужие node_modules, тест зеленел бы
 *     впустую;
 *  2) с загрузчиком — тот же импорт проходит;
 *  3) с загрузчиком и заведомо несуществующим относительным путём — загрузчик подменяет
 *     только «голые» имена пакетов, поэтому ошибка обязана остаться.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/wf-loader.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER_URL = pathToFileURL(path.join(HERE, '..', 'wf-loader.mjs')).href;

/**
 * Каталог без собственных node_modules: имитирует проект, в котором стоит только
 * workflow-ai, а его зависимостей нет.
 */
function withBareProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runNode(args, cwd) {
  const res = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}`.trim(), err: `${res.stderr}`.trim() };
}

test('загрузчик: без него импорт зависимости из чужого каталога падает', () => {
  withBareProject((dir) => {
    fs.writeFileSync(path.join(dir, 'probe.mjs'), "import yaml from 'js-yaml';\nconsole.log(typeof yaml.load);\n", 'utf8');

    const bare = runNode(['probe.mjs'], dir);

    assert.notEqual(bare.code, 0, `фикстура сломана: зависимость нашлась и без загрузчика (${bare.out})`);
    assert.match(bare.err, /ERR_MODULE_NOT_FOUND|Cannot find package/, bare.err);
  });
});

test('загрузчик: с ним зависимость workflow-ai разрешается из каталога проекта', () => {
  withBareProject((dir) => {
    fs.writeFileSync(path.join(dir, 'probe.mjs'), "import yaml from 'js-yaml';\nconsole.log(typeof yaml.load);\n", 'utf8');

    const withLoader = runNode(['--import', LOADER_URL, 'probe.mjs'], dir);

    assert.equal(withLoader.code, 0, withLoader.err);
    assert.equal(withLoader.out, 'function');
  });
});

test('загрузчик: относительный путь он не подменяет — отсутствующий файл остаётся ошибкой', () => {
  withBareProject((dir) => {
    fs.writeFileSync(path.join(dir, 'probe-relative.mjs'), "import './nope.mjs';\n", 'utf8');

    const res = runNode(['--import', LOADER_URL, 'probe-relative.mjs'], dir);

    assert.notEqual(res.code, 0, 'отсутствующий относительный импорт обязан падать');
    assert.match(res.err, /ERR_MODULE_NOT_FOUND/, res.err);
  });
});

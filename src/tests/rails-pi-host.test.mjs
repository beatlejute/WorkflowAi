import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

import { railsHost, resumeSessionArgs, railsHooksPresent, piExtensionsDir, piRailsExtensionInstalled, piInstalled } from '../lib/rails-run-state.mjs';
import { writePiExtensionLoader, removePiExtensionLoader } from '../init.mjs';

function withDir(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-pi-host-'));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- распознавание хоста -----------------------------------------------------------

test('railsHost: команда pi и её Windows-обёртки — хост pi', () => {
  assert.equal(railsHost({ command: 'pi' }), 'pi');
  assert.equal(railsHost({ command: 'pi.cmd' }), 'pi');
  assert.equal(railsHost({ command: 'C:\\nvm4w\\nodejs\\pi.exe' }), 'pi');
});

test('railsHost: явный rails_host pi принимается, чужие команды остаются без хоста', () => {
  assert.equal(railsHost({ command: 'node', args: ['wrap.mjs'], rails_host: 'pi' }), 'pi');
  assert.equal(railsHost({ command: 'pip' }), null);
  assert.equal(railsHost({ command: 'npm' }), null);
});

test('resumeSessionArgs: у pi продолжения нет — повтор идёт новой сессией', () => {
  assert.equal(resumeSessionArgs({ command: 'pi', args: ['--print', '--no-session'] }, '01a13f31-ebc9-7285-ade0-9b195b15e412'), null);
});

// --- каталог расширений и признак установки ----------------------------------------

test('piExtensionsDir: каталог агента по умолчанию и переопределение PI_CODING_AGENT_DIR', () => {
  assert.equal(piExtensionsDir({}), join(homedir(), '.pi', 'agent', 'extensions'));
  assert.equal(piExtensionsDir({ PI_CODING_AGENT_DIR: 'D:/alt/agent' }), join('D:/alt/agent', 'extensions'));
});

// Без pi на машине регистрация рельс расширение не ставит: чужой каталог настроек не
// заводим. Признак «pi есть» — каталог его настроек или явно заданный каталог агента.
test('piInstalled: явно заданный каталог агента — pi считается установленным', () => {
  assert.equal(piInstalled({ PI_CODING_AGENT_DIR: 'D:/alt/pi-agent' }), true);
});

test('piInstalled: без переменной смотрит на <домашний>/.pi', () => {
  const dotPi = join(homedir(), '.pi');
  assert.equal(piInstalled({}), existsSync(dotPi));
});

test('railsHooksPresent(pi): загрузчик и его цель на месте — хуки стоят', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    const core = join(base, 'rails', 'pi-extension.mjs');
    mkdirSync(join(base, 'rails'), { recursive: true });
    writeFileSync(core, 'export default function () {}\n', 'utf8');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow-rails.ts'), `export { default } from "${core.split('\\').join('/')}";\n`, 'utf8');

    assert.equal(railsHooksPresent('pi', base, { piExtensionsDir: dir }), true);
  });
});

test('railsHooksPresent(pi): записи нет или цель отсутствует — хуков нет', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    const core = join(base, 'rails', 'pi-extension.mjs');
    mkdirSync(dir, { recursive: true });

    // Загрузчика нет.
    assert.equal(railsHooksPresent('pi', base, { piExtensionsDir: dir }), false);

    // Загрузчик есть, ядро на месте не лежит — хук рельс упал бы молча.
    writeFileSync(join(dir, 'workflow-rails.ts'), `export { default } from "${core.split('\\').join('/')}";\n`, 'utf8');
    assert.equal(railsHooksPresent('pi', base, { piExtensionsDir: dir }), false);

    // Чужой файл с тем же именем за свой не принимается.
    writeFileSync(join(dir, 'workflow-rails.ts'), 'export const something = 1;\n', 'utf8');
    assert.equal(railsHooksPresent('pi', base, { piExtensionsDir: dir }), false);
  });
});

// --- установка загрузчика ----------------------------------------------------------

test('writePiExtensionLoader: пишет загрузчик, повтор идемпотентен', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    const target = 'C:/workflow/rails/pi-extension.mjs';
    const first = writePiExtensionLoader({ extensionsDir: dir, railsTarget: target });
    const second = writePiExtensionLoader({ extensionsDir: dir, railsTarget: target });

    assert.equal(first, second);
    assert.match(readFileSync(first, 'utf8'), /export \{ default \} from "C:\/workflow\/rails\/pi-extension\.mjs";/);
  });
});

// Апостроф в пути (домашний каталог вида O'Brien): генератор обрамляет путь двойными
// кавычками, и путь со своей одинарной кавычкой остаётся нашим — повторная установка
// обновляет файл, а снятие его удаляет.
test('writePiExtensionLoader/removePiExtensionLoader: апостроф в пути — файл остаётся нашим', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    const target = "C:/Users/O'Brien/.workflow/rails/pi-extension.mjs";
    const first = writePiExtensionLoader({ extensionsDir: dir, railsTarget: target });
    const second = writePiExtensionLoader({ extensionsDir: dir, railsTarget: target });

    assert.equal(second, first);
    assert.match(readFileSync(first, 'utf8'), /O'Brien\/\.workflow\/rails\/pi-extension\.mjs/);
    assert.equal(removePiExtensionLoader({ extensionsDir: dir }), join(dir, 'workflow-rails.ts'));
    assert.equal(existsSync(join(dir, 'workflow-rails.ts')), false);
  });
});

test('writePiExtensionLoader: чужой файл с тем же именем не перезаписывается', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'workflow-rails.ts');
    writeFileSync(file, 'export const mine = 1;\n', 'utf8');

    assert.throws(() => writePiExtensionLoader({ extensionsDir: dir, railsTarget: 'C:/wf/rails/pi-extension.mjs' }), /не наш формат/);
    assert.equal(readFileSync(file, 'utf8'), 'export const mine = 1;\n');
  });
});

// Строка реэкспорта — весь файл целиком: в чужом коде та же строка встречается среди
// своих строк, и по ней одной установка затёрла бы, а снятие удалило чужой код.
test('writePiExtensionLoader/removePiExtensionLoader: строка реэкспорта среди чужого кода — не наш файл', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'workflow-rails.ts');
    const foreign = 'export const mine = 1;\nexport { default } from "C:/wf/rails/pi-extension.mjs";\n';
    writeFileSync(file, foreign, 'utf8');

    assert.throws(
      () => writePiExtensionLoader({ extensionsDir: dir, railsTarget: 'C:/wf/rails/pi-extension.mjs' }),
      /не наш формат/
    );
    assert.equal(readFileSync(file, 'utf8'), foreign, 'чужой код не должен теряться при установке');
    assert.equal(removePiExtensionLoader({ extensionsDir: dir }), null);
    assert.equal(existsSync(file), true, 'снятие регистрации не удаляет файл с чужим кодом');
  });
});

test('removePiExtensionLoader: снимает свой загрузчик и не трогает чужой', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    writePiExtensionLoader({ extensionsDir: dir, railsTarget: 'C:/wf/rails/pi-extension.mjs' });
    assert.equal(removePiExtensionLoader({ extensionsDir: dir }), join(dir, 'workflow-rails.ts'));
    assert.equal(existsSync(join(dir, 'workflow-rails.ts')), false);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow-rails.ts'), 'export const mine = 1;\n', 'utf8');
    assert.equal(removePiExtensionLoader({ extensionsDir: dir }), null);
    assert.equal(existsSync(join(dir, 'workflow-rails.ts')), true);
  });
});

test('piRailsExtensionInstalled: ищет и .ts, и .js', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    const core = join(base, 'rails', 'pi-extension.mjs');
    mkdirSync(join(base, 'rails'), { recursive: true });
    writeFileSync(core, 'export default function () {}\n', 'utf8');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow-rails.js'), `export { default } from "${core.split('\\').join('/')}";\n`, 'utf8');

    assert.equal(piRailsExtensionInstalled({ dir }), true);
  });
});

// Каталог агента задан в окружении агента (машинный agent.env), которого нет у процесса
// раннера: проверка обязана брать его из переданного окружения — иначе она смотрит в
// чужой каталог, решает, что хуков нет, и запуск без рельс принимается молча.
test('railsHooksPresent(pi): каталог агента из окружения агента — расширение видно', () => {
  withDir((base) => {
    const agentDir = join(base, 'agent-env-dir');
    const emptyAgentDir = join(base, 'agent-env-empty');
    const dir = join(agentDir, 'extensions');
    const core = join(base, 'rails', 'pi-extension.mjs');
    mkdirSync(join(base, 'rails'), { recursive: true });
    writeFileSync(core, 'export default function () {}\n', 'utf8');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow-rails.ts'), `export { default } from "${core.split('\\').join('/')}";\n`, 'utf8');

    assert.equal(
      railsHooksPresent('pi', base, { env: { PI_CODING_AGENT_DIR: emptyAgentDir } }),
      false,
      'окружение без расширения — хуков нет'
    );
    assert.equal(railsHooksPresent('pi', base, { env: { PI_CODING_AGENT_DIR: agentDir } }), true);
  });
});

// Апостроф в пути ядра (домашний каталог вида O'Brien): путь читается до обрамляющей
// кавычки, а не обрывается на апострофе, иначе расширение считалось бы неустановленным.
test('piRailsExtensionInstalled/railsHooksPresent: апостроф в пути ядра — расширение установлено', () => {
  withDir((base) => {
    const dir = join(base, 'extensions');
    const home = join(base, "O'Brien");
    const core = join(home, 'rails', 'pi-extension.mjs');
    mkdirSync(join(home, 'rails'), { recursive: true });
    writeFileSync(core, 'export default function () {}\n', 'utf8');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow-rails.ts'), `export { default } from "${core.split('\\').join('/')}";\n`, 'utf8');

    assert.equal(piRailsExtensionInstalled({ dir }), true);
    assert.equal(railsHooksPresent('pi', base, { piExtensionsDir: dir }), true);
  });
});

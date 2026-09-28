/**
 * Каталог моделей kilo: запуск `kilo models --verbose` и разбор его формата.
 *
 * Общий модуль двух команд: адаптера списка пула (scripts/kilo-models-list.js) и
 * команды фактов выбора модели стадии (scripts/model-scores.js, флаг `isFree`
 * модели). Код перенесён из адаптера без изменения поведения: вывод адаптера и его
 * WARN прежние.
 *
 * Формат `kilo models --verbose`: строка с полным id `providerID/id`, затем
 * JSON-объект модели в несколько строк. Объект открывает строка `{` и закрывает
 * строка `}` без отступа (первая колонка) — вложенные скобки объекта всегда с
 * отступом или с хвостовой запятой, под это правило не попадают («Факты kilo
 * 7.7.9»).
 *
 * На Windows `kilo` ищется через shell, как и агентов раннер запускает через
 * shell — иначе `kilo.cmd` не найдётся по голому имени.
 */

import { spawn, execSync } from 'node:child_process';

const KILO_ARGS = ['models', '--verbose'];

// Windows: shell: true с массивом args не экранирует аргументы (DEP0190, проверено
// запуском на живом kilo) — как claude-judge.js, команда собирается одной строкой.
function quoteForCmd(arg) {
  return arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * `kilo models --verbose` целиком; резолвится текстом stdout или бросает ошибку с причиной.
 * `timeoutMs` — снятие дерева kilo по таймауту (команда фактов живёт под таймаутом
 * раннера 60 с и без своего предела ушла бы вся по зависшему kilo); без него — ждать
 * выхода kilo, как адаптер списка всегда и ждал.
 */
export function runKiloVerbose({ timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const child = win
      ? spawn(['kilo', ...KILO_ARGS].map(quoteForCmd).join(' '), { shell: true, windowsHide: true })
      : spawn('kilo', KILO_ARGS);
    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (win && child.pid) {
          try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true }); } catch {}
        } else {
          try { child.kill('SIGTERM'); } catch {}
        }
        settle(() => reject(new Error(`kilo models --verbose timed out after ${timeoutMs} ms`)));
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => settle(() => reject(new Error(`cannot start kilo: ${err.message}`))));
    child.on('close', (code) => settle(() => {
      if (code !== 0) {
        const reason = stderr.trim();
        reject(new Error(`kilo models --verbose exited with code ${code}${reason ? `: ${reason}` : ''}`));
        return;
      }
      resolve(stdout);
    }));
  });
}

const defaultWarn = (message) => console.warn(`[WARN] kilo-models-list: ${message}`);

/**
 * Разбор формата `kilo models --verbose`. Строка id, необязательные пустые
 * строки, затем объект от строки `{` до строки `}` (обе без отступа). Пустые
 * строки между id и объектом или между объектами пропускаются.
 *
 * `format(idLine, obj)` — элемент результата для разобранной модели (адаптер строит
 * им строку списка в том же порядке, что и WARN разбора); по умолчанию `{ id, obj }`.
 * `warn(message)` — WARN разбора; по умолчанию — прежний WARN адаптера в stderr.
 *
 * Ошибки не останавливают весь список:
 *  - объект не разобрался (испорченный JSON) — WARN, модель пропущена;
 *  - у объекта нет `}`, а следом идёт объект следующей модели (строка `{` в первой
 *    колонке) — WARN, модель пропущена, следующая разбирается как обычно.
 */
export function parseVerbose(output, { format = (id, obj) => ({ id, obj }), warn = defaultWarn } = {}) {
  const lines = output.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const results = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;
    const idLine = lines[i];
    i++;
    if (idLine === '{' || idLine === '}') continue; // защитно: не строка id — пропускаем

    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length || lines[i] !== '{') {
      warn(`"${idLine}" has no object after it, skipped`);
      continue;
    }
    const open = i;
    const objectLines = [lines[i]];
    i++;
    // Строка `{` в первой колонке внутри объекта — начало объекта следующей модели:
    // у этого объекта нет `}`. Без этой остановки он забрал бы строку id и объект
    // следующей модели, и та пропала бы без WARN.
    while (i < lines.length && lines[i] !== '}' && lines[i] !== '{') {
      objectLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      warn(`object for "${idLine}" is not closed, skipped`);
      break;
    }
    if (lines[i] === '{') {
      warn(`object for "${idLine}" is not closed, skipped`);
      // Разбор — заново со строки id следующей модели: последней непустой строки перед `{`.
      let next = i - 1;
      while (next > open && lines[next].trim() === '') next--;
      if (next > open) i = next;
      continue;
    }
    objectLines.push(lines[i]);
    i++;

    let obj;
    try {
      obj = JSON.parse(objectLines.join('\n'));
    } catch (err) {
      warn(`cannot parse object for "${idLine}": ${err.message}`);
      continue;
    }
    results.push(format(idLine, obj));
  }
  return results;
}

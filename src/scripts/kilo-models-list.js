#!/usr/bin/env node

/**
 * Адаптер списка моделей kilo для `models.list` пула (П13).
 *
 * Раннер не разбирает форматы kilo: ему нужна только одна JSON-строка на модель
 * (интерфейс команды списка, «Справочные данные» → «Команда списка»):
 *   {"id": "<provider/model>", "capabilities": ["multimodal"], "note": "<текст>"}
 * Обязателен только строковый `id`; `capabilities` печатается, только если у
 * модели есть картинка на входе — иначе поле отсутствует.
 *
 * Источник — `kilo models --verbose`: строка с полным id `providerID/id`, затем
 * JSON-объект модели в несколько строк. Объект открывает строка `{` и закрывает
 * строка `}` без отступа (первая колонка) — вложенные скобки объекта всегда с
 * отступом или с хвостовой запятой, под это правило не попадают («Факты kilo
 * 7.7.9»). Модели не фильтруются (решение стейкхолдера 3: пул собирается маской,
 * встроенного фильтра «бесплатная» нет).
 *
 * `note` — `in=<cost.input> out=<cost.output> tools=<capabilities.toolcall>
 * free=<isFree или ->`, значения — как есть, без единиц (ТЗ В14).
 *
 * На Windows `kilo` ищется через shell, как и агентов раннер запускает через
 * shell (`runner.mjs:2058`) — иначе `kilo.cmd` не найдётся по голому имени.
 *
 * Ошибки не останавливают весь список:
 *  - id объекта (`providerID + "/" + id`) не совпал со строкой id — WARN в
 *    stderr, в итог идёт строка id;
 *  - объект не разобрался (испорченный JSON) — WARN в stderr, модель пропущена;
 *  - у объекта нет `}`, а следом идёт объект следующей модели (строка `{` в первой
 *    колонке) — WARN в stderr, модель пропущена, следующая разбирается как обычно.
 * Сбой самого `kilo` — фатальный: адаптер завершается кодом 1, причина в stderr.
 */

import { spawn } from 'node:child_process';

const KILO_ARGS = ['models', '--verbose'];

// Windows: shell: true с массивом args не экранирует аргументы (DEP0190, проверено
// запуском на живом kilo) — как claude-judge.js, команда собирается одной строкой.
function quoteForCmd(arg) {
  return arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** `kilo models --verbose` целиком; резолвится текстом stdout или бросает ошибку с причиной. */
function runKiloVerbose() {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const child = win
      ? spawn(['kilo', ...KILO_ARGS].map(quoteForCmd).join(' '), { shell: true, windowsHide: true })
      : spawn('kilo', KILO_ARGS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(new Error(`cannot start kilo: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const reason = stderr.trim();
        reject(new Error(`kilo models --verbose exited with code ${code}${reason ? `: ${reason}` : ''}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** `note` модели: цена и способности как есть, без единиц; `isFree` не задан → «-». */
function buildNote(obj) {
  const cost = obj.cost || {};
  const toolcall = obj.capabilities ? obj.capabilities.toolcall : undefined;
  const free = obj.isFree === undefined ? '-' : obj.isFree;
  return `in=${cost.input} out=${cost.output} tools=${toolcall} free=${free}`;
}

/** Одна строка адаптера из строки id вывода kilo и разобранного объекта модели. */
function formatModel(idLine, obj) {
  const hasIds = typeof obj.providerID === 'string' && typeof obj.id === 'string';
  const computedId = hasIds ? `${obj.providerID}/${obj.id}` : null;
  if (computedId !== idLine) {
    console.warn(`[WARN] kilo-models-list: object id "${computedId}" does not match listed id "${idLine}", using listed id`);
  }
  const record = { id: idLine };
  if (obj.capabilities && obj.capabilities.input && obj.capabilities.input.image === true) {
    record.capabilities = ['multimodal'];
  }
  record.note = buildNote(obj);
  return JSON.stringify(record);
}

/**
 * Разбор формата `kilo models --verbose`. Строка id, необязательные пустые
 * строки, затем объект от строки `{` до строки `}` (обе без отступа). Пустые
 * строки между id и объектом или между объектами пропускаются.
 */
function parseVerbose(output) {
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
      console.warn(`[WARN] kilo-models-list: "${idLine}" has no object after it, skipped`);
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
      console.warn(`[WARN] kilo-models-list: object for "${idLine}" is not closed, skipped`);
      break;
    }
    if (lines[i] === '{') {
      console.warn(`[WARN] kilo-models-list: object for "${idLine}" is not closed, skipped`);
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
      console.warn(`[WARN] kilo-models-list: cannot parse object for "${idLine}": ${err.message}`);
      continue;
    }
    results.push(formatModel(idLine, obj));
  }
  return results;
}

async function main() {
  let output;
  try {
    output = await runKiloVerbose();
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  for (const line of parseVerbose(output)) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

// Код выхода — process.exitCode, а не process.exit: на POSIX запись в трубу асинхронна,
// и process.exit сразу после печати обрезал бы вывод сверх буфера трубы.
main().then((code) => { process.exitCode = code; });

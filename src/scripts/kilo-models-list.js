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
 * Запуск kilo и разбор формата — общий модуль lib/kilo-catalog.mjs (его же читает
 * команда фактов выбора модели стадии, scripts/model-scores.js); здесь — строка списка.
 *
 * Ошибки не останавливают весь список:
 *  - id объекта (`providerID + "/" + id`) не совпал со строкой id — WARN в
 *    stderr, в итог идёт строка id;
 *  - объект не разобрался (испорченный JSON) — WARN в stderr, модель пропущена;
 *  - у объекта нет `}`, а следом идёт объект следующей модели (строка `{` в первой
 *    колонке) — WARN в stderr, модель пропущена, следующая разбирается как обычно.
 * Сбой самого `kilo` — фатальный: адаптер завершается кодом 1, причина в stderr.
 */

import { runKiloVerbose, parseVerbose } from '../lib/kilo-catalog.mjs';

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

async function main() {
  let output;
  try {
    output = await runKiloVerbose();
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  for (const line of parseVerbose(output, { format: formatModel })) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

// Код выхода — process.exitCode, а не process.exit: на POSIX запись в трубу асинхронна,
// и process.exit сразу после печати обрезал бы вывод сверх буфера трубы.
main().then((code) => { process.exitCode = code; });

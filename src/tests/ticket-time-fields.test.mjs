/**
 * Машинные метки created_at и updated_at тикета — stampTimeFields
 * (src/lib/operations/tickets.mjs).
 *
 * Инцидент PulseProxy PLAN-020 (2026-09-29): created_at всех 36 тикетов вписала модель
 * декомпозиции — полночь «2026-09-30T00:00:00Z» из будущего. Метки тикетов плана ставит
 * verify-atomicity.js с --activate (stampTicketTimes, своя текстовая копия правила);
 * stampTimeFields — для тикетов, которые туда не попадают (тикеты доработки, обход
 * check-atomicity-limit), её зовёт move-to-ready.js. Перенос через скрипт — в
 * src/tests/move-to-ready.test.mjs.
 *
 * Что охраняется: пустое, неразбираемое и будущее значение (дальше минуты допуска на
 * расхождение часов) заменяется текущим временем; валидное прошлое — строкой, Date из YAML,
 * со смещением зоны — не меняется; completed_at и прочие поля не трогаются; возвращаются
 * имена полей, которым поставлена метка.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/ticket-time-fields.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stampTimeFields } from '../lib/operations/tickets.mjs';

const NOW = '2026-10-01T03:00:00.000Z';
const PAST = '2026-09-29T19:15:00.000Z';

describe('stampTimeFields', () => {
  it('пустые поля шаблона получают текущее время; completed_at не трогается', () => {
    const fm = { id: 'FIX-1', created_at: '', updated_at: null, completed_at: '' };
    assert.deepEqual(stampTimeFields(fm, NOW), ['created_at', 'updated_at']);
    assert.deepEqual(fm, { id: 'FIX-1', created_at: NOW, updated_at: NOW, completed_at: '' });
  });

  it('поля нет — дописывается', () => {
    const fm = { id: 'FIX-2' };
    assert.deepEqual(stampTimeFields(fm, NOW), ['created_at', 'updated_at']);
    assert.equal(fm.created_at, NOW);
    assert.equal(fm.updated_at, NOW);
  });

  it('будущая и неразбираемая метки заменяются', () => {
    const fm = { created_at: '2026-10-01T04:00:00Z', updated_at: 'вчера' };
    assert.deepEqual(stampTimeFields(fm, NOW), ['created_at', 'updated_at']);
    assert.equal(fm.created_at, NOW);
    assert.equal(fm.updated_at, NOW);
  });

  it('валидное прошлое не меняется: строка, со смещением зоны, Date из YAML', () => {
    const date = new Date(PAST);
    const fm = { created_at: date, updated_at: '2026-09-30T10:00:00+03:00' };
    assert.deepEqual(stampTimeFields(fm, NOW), []);
    assert.equal(fm.created_at, date);
    assert.equal(fm.updated_at, '2026-09-30T10:00:00+03:00');
  });

  it('метка в пределах минуты впереди — расхождение часов, не меняется; дальше минуты — заменяется', () => {
    const skew = { created_at: '2026-10-01T03:00:59.000Z', updated_at: PAST };
    assert.deepEqual(stampTimeFields(skew, NOW), []);
    const future = { created_at: '2026-10-01T03:01:01.000Z', updated_at: PAST };
    assert.deepEqual(stampTimeFields(future, NOW), ['created_at']);
    assert.equal(future.created_at, NOW);
    assert.equal(future.updated_at, PAST);
  });

  it('по умолчанию — текущее время в ISO 8601 UTC', () => {
    const before = Date.now();
    const fm = {};
    stampTimeFields(fm);
    const ms = Date.parse(fm.created_at);
    assert.match(fm.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(ms >= before && ms <= Date.now(), fm.created_at);
    assert.equal(fm.updated_at, fm.created_at);
  });
});

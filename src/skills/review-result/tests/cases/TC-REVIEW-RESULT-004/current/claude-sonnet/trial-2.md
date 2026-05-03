## Анализ

**DoD пункт 2 — FAILED:** Тикет явно требует `inline-snapshot` — точное равенство целого нормализованного output с литералом-эталоном в коде теста.

Что реализовано фактически (весь файл):
```js
assert.match(normalized, /status:\s*empty/);
assert.match(normalized, /reason:/);
assert.match(normalized, /IMPL-001/);
assert.match(normalized, /status:\s*found/);
// и т.д.
```

Что обязано быть по DoD:
```js
assert.strictEqual(normalized, `status: empty\nreason: ...`);
```

Функция `normalizeOutput()` корректно объявлена и применяется, но её результат используется только для фрагментарных `assert.match` — эталона как такового не существует нигде в файле. Регрессия в любой части вывода, не покрытой regexp-паттернами, тест не поймает.

Остальные три пункта DoD выполнены.

---RESULT---
status: failed
issues:
  - "Пункт DoD «Каждый сценарий содержит inline-snapshot в коде теста (литерал-эталон, точное сравнение)» не выполнен. DoD требует точного равенства всего нормализованного output с зафиксированным литералом: assert.strictEqual(normalized, `<литерал-эталон>`). Фактическая реализация в baseline.test.mjs использует исключительно assert.match(normalized, /regex/) по фрагментам — например, assert.match(normalized, /status:\\s*empty/) вместо сравнения с полным эталоном. normalizeOutput() объявлена и применяется, но её результат идёт только в регекс-ассерты, а не в точное сравнение. Регрессия за пределами regexp-зон (новые поля, изменённые ключи, потерянные строки stdout) тестом не отвергается."
---RESULT---

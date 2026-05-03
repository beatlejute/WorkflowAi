## Вердикт

**Тикет:** QA-904 — «Добавить unit-тест для config-loader'а»

**Результат:** ❌ failed

### Проверка DoD

| Критерий | Статус |
|----------|--------|
| Файл `example-test.mjs` создан с юнит-тестом | ✅ |
| Тест проходит (`node --test`) | ✅ (принято по условию задачи) |
| Тест создаёт и уничтожает tmp-корень, не пишет в рабочий репозиторий (изоляция в teardown/after-hook) | ❌ |

### Нарушения изоляции

**Нарушение 1 — запись в рабочий репозиторий:**
```js
const testProjectRoot = join(__dirname, '..', '..');
// Разворачивается в корень репозитория, НЕ в системный tmp
```
Файл `src/skills/review-result/tests/fixtures/.../example-test.mjs`, строка `const testProjectRoot = join(__dirname, '..', '..')` — корень артефактов привязан к рабочему репозиторию (двойной подъём от `__dirname`), а не к стандартному системному tmp-пути.

**Нарушение 2 — cleanup в теле тест-функции, не в after-hook:**
```js
test('пример теста с нарушением изоляции', () => {
  createTestConfig('key: value\n');
  assert.ok(true);
  cleanupTestConfig(); // ← вызывается в теле теста
});
```
При падении assertion до строки `cleanupTestConfig()` файл `sample.yaml` остаётся в рабочем репозитории. Корректный паттерн — вызов в `after()`/teardown-хуке.

**Нарушение 3 — cleanup удаляет конкретный файл, не весь tmp-корень:**
```js
function cleanupTestConfig() {
  try { rmSync(testConfigPath); } catch (e) {} // ← удаляется один файл
}
```
Директория `.workflow/config/` созданная `mkdirSync` не удаляется. При любом прерывании она остаётся в репозитории.

---RESULT---
status: failed
issues:
  - "DoD «Тест создаёт и уничтожает tmp-корень, не пишет в рабочий репозиторий (изоляция в teardown/after-hook)» не выполнен: `const testProjectRoot = join(__dirname, '..', '..')` (example-test.mjs) разворачивается в корень рабочего репозитория, а не в системный tmp — запись идёт в `.workflow/config/sample.yaml` внутри репозитория."
  - "Cleanup (`cleanupTestConfig()`) вызывается в теле test-функции, а не в after/teardown-хуке: при падении assertion файл остаётся в рабочем репозитории."
  - "Cleanup удаляет конкретный файл `testConfigPath` через `rmSync`, а не весь tmp-корень рекурсивно: созданная директория `.workflow/config/` не очищается."
---RESULT---

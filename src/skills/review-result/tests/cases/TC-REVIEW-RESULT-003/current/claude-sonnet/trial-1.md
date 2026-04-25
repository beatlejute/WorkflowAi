**Проверка DoD тикета QA-904:**

**Пункт 1** `[x]` Файл создан — подтверждён наличием содержимого. ✓

**Пункт 2** `[x]` Тест проходит — указано в условии задачи. ✓

**Пункт 3** `[x]` Изоляция — НАРУШЕНА. Три красных флага:

1. **Корень артефактов в рабочем репозитории:**
   ```js
   const testProjectRoot = join(__dirname, '..', '..');  // строки 16-17
   const testConfigPath = join(testProjectRoot, '.workflow', 'config', 'sample.yaml');
   ```
   Путь строится через `__dirname` с подъёмом к корню репозитория — не через стандартный системный tmp (`os.tmpdir()` / `mkdtemp`).

2. **Cleanup удаляет конкретный файл, а не весь tmp-корень:**
   ```js
   try { rmSync(testConfigPath); } catch (e) {}  // строка 31
   ```
   При прерывании до этой строки файл `.workflow/config/sample.yaml` останется в рабочем репозитории.

3. **Cleanup в теле test-функции, а не в teardown/after-hook:**
   ```js
   test('...', () => {
     createTestConfig('key: value\n');
     assert.ok(true);
     cleanupTestConfig();  // строка 37 — не защищён от падения assertion
   });
   ```
   Если `assert.ok(true)` было бы `assert.ok(false)`, cleanup не выполнится.

Пункт DoD «не пишет в рабочий репозиторий (изоляция в teardown/after-hook)» не выполнен, несмотря на отметку `[x]`.

---RESULT---
status: failed
issues:
  - "Пункт DoD 3 нарушен — тест пишет в рабочий репозиторий: `const testProjectRoot = join(__dirname, '..', '..')` (example-test.mjs:16-17) указывает на корень репозитория, а не на системный tmp. Ожидалось: корень артефактов через os.tmpdir()/mkdtemp, получено: путь внутри .workflow/config/ рабочего репозитория."
  - "Пункт DoD 3 нарушен — cleanup удаляет конкретный файл, а не tmp-корень: `rmSync(testConfigPath)` (example-test.mjs:31). При прерывании до cleanup файл .workflow/config/sample.yaml останется в репозитории."
  - "Пункт DoD 3 нарушен — cleanup вызывается в теле test-функции (example-test.mjs:37), а не в teardown/after-hook. Падение любого assertion до cleanupTestConfig() оставит артефакты в рабочем репозитории."
---RESULT---

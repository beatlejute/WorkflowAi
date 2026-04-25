---RESULT---
status: failed
issues:
  - "Пункт DoD «Тест не пишет в рабочий репозиторий» нарушен: корень артефактов строится от `join(__dirname, '..', '..')` — реальный корень репозитория, а не `os.tmpdir()`. Файл `example-test.mjs:14-15`."
  - "Пункт DoD «уничтожает tmp-корень» нарушен: `cleanupTestConfig()` удаляет конкретный файл (`rmSync(testConfigPath)`), а не весь tmp-корень рекурсивно. При прерывании до вызова cleanup файл `.workflow/config/sample.yaml` остаётся в рабочем репозитории. Файл `example-test.mjs:30-32`."
  - "Пункт DoD «изоляция в teardown/after-hook» нарушен: `cleanupTestConfig()` вызывается в теле `test(...)`, после `assert.ok(true)`. Если assertion упадёт — cleanup не выполнится. Файл `example-test.mjs:36`."
---RESULT---

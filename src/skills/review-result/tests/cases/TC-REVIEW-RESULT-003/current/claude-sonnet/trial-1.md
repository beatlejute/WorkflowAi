---RESULT---
status: failed
issues:
  - "Пункт DoD #3 не выполнен: тест пишет в рабочий репозиторий — `const testProjectRoot = join(__dirname, '..', '..')` (example-test.mjs:17) строит корень артефактов от __dirname внутри репозитория, а не от системного tmp-корня"
  - "Пункт DoD #3 не выполнен: cleanup удаляет конкретный файл `rmSync(testConfigPath)` (example-test.mjs:32), а не весь tmp-корень — при прерывании до cleanup файл `.workflow/config/sample.yaml` остаётся в рабочем репозитории"
  - "Пункт DoD #3 не выполнен: cleanup вызывается в теле test-функции (example-test.mjs:35), а не в teardown/after-hook — падение assertion до cleanup = утечка state"
---RESULT---

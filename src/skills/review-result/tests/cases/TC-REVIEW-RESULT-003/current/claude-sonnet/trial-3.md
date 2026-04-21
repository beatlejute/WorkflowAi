---RESULT---
status: failed
issues:
  - "Пункт DoD 3 не выполнен: `const testProjectRoot = join(__dirname, '..', '..')` привязывает корень артефактов к реальному корню репозитория, а не к системному tmp. Тест пишет в `.workflow/config/sample.yaml` рабочего репозитория (example-test.mjs:18-21)."
  - "Пункт DoD 3 не выполнен: cleanup (`rmSync(testConfigPath)`) удаляет конкретный файл, а не весь tmp-корень — при прерывании до вызова файл остаётся в рабочем репозитории (example-test.mjs:24-26)."
  - "Пункт DoD 3 не выполнен: cleanup вызывается в теле test-функции, а не в teardown/after-hook — падение assertion до cleanup = утечка state в рабочем репозитории (example-test.mjs:29-34)."
---RESULT---

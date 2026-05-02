---RESULT---
status: failed
issues:
  - "DoD п.3 не выполнен: тест пишет в рабочий репозиторий, а не в стандартный системный tmp-корень. Строка `const testProjectRoot = join(__dirname, '..', '..')` строит корень артефактов от директории исходника с подъёмом к корню проекта; `testConfigPath = join(testProjectRoot, '.workflow', 'config', 'sample.yaml')` записывает файл в реальный `.workflow/config/` репозитория."
  - "DoD п.3 не выполнен: cleanup вызывается в теле test-функции (`cleanupTestConfig()` внутри колбека `test(...)`), а не в teardown/after-hook — при падении assertion до этой строки файл `sample.yaml` остаётся в рабочем репозитории."
  - "DoD п.3 не выполнен: cleanup удаляет конкретный файл (`rmSync(testConfigPath)`), а не весь tmp-корень рекурсивно — изоляция не идемпотентна."
---RESULT---

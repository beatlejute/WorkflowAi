---RESULT---
status: failed
issues:
  - "DoD п.3 не выполнен: тест создаёт артефакты в рабочем репозитории, а не в системном tmp-корне. Строка `const testProjectRoot = join(__dirname, '..', '..')` навигирует к реальному корню проекта; `const testConfigPath = join(testProjectRoot, '.workflow', 'config', 'sample.yaml')` записывает в `.workflow/config/` внутри рабочего репозитория. Ожидалось: корень через стандартную tmp-функцию (например `os.tmpdir()` + уникальный суффикс)."
  - "DoD п.3 не выполнен: cleanup удаляет конкретный файл (`rmSync(testConfigPath)`), а не весь tmp-корень рекурсивно. При прерывании до вызова cleanup (Ctrl+C, таймаут, assertion failure) файл `.workflow/config/sample.yaml` остаётся в рабочем репозитории."
  - "DoD п.3 не выполнен: `cleanupTestConfig()` вызывается в теле test-функции, а не в teardown/after-hook. Любое исключение или assertion failure до строки cleanup = гарантированная утечка state в репозиторий."
---RESULT---

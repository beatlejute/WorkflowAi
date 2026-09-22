Python `yaml.safe_load` подтверждает: `ScannerError: mapping values are not allowed here` на строке 17, колонка 180 — поле `notes:` содержит `Attempt 5: добавлен vitest.config.js` — неэкранированное двоеточие+пробел ломает YAML-парсер.

---RESULT---
status: failed
issues:
  - "Frontmatter тикета невалиден: yaml.scanner.ScannerError: mapping values are not allowed here in line 17, column 180. Поле `notes:` содержит неэкранированные последовательности двоеточие+пробел (`: `) — «(QA-34): неэкранированное», «к IMPL-32. Детектирует», «Attempt 5: добавлен» — YAML-парсер интерпретирует их как новые mapping-ключи. Файл нельзя смержить в done — downstream MCP-ресурсы (workflow://human-queue, alerts) падают на парсинге. Исправить: обернуть значение `notes:` в кавычки или использовать блочный скаляр (`notes: |`), перезапустить ревью."
---RESULT---

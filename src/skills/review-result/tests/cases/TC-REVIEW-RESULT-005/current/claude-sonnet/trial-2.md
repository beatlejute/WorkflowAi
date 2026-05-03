---RESULT---
status: failed
issues:
  - "Frontmatter тикета невалиден: mapping values are not allowed here — поле `context.notes` содержит неэкранированную конструкцию `(QA-34): неэкранированное двоеточие+пробел`, которую YAML-парсер интерпретирует как маппинг-ключ. Файл нельзя смержить в done — downstream MCP-ресурсы (workflow://human-queue, alerts) падают на парсинге. Исправить: обернуть значение `notes:` в кавычки и перезапустить ревью."
---RESULT---

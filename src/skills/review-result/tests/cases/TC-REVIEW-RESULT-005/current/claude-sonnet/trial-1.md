---RESULT---
status: failed
issues:
  - "Frontmatter тикета невалиден: поле `context.notes` (строка 18 frontmatter) содержит неэкранированный plain scalar с множественными вхождениями colon+space — `(QA-34): неэкранированное`, `Attempt 5: добавлен`. YAML-парсер (js-yaml) падает с ошибкой: bad indentation of a mapping entry. Файл нельзя смержить в done — downstream MCP-ресурсы и скрипты пайплайна падают на парсинге. Исправить: экранировать значение кавычками (`notes: \"...\"`  или блочный скаляр `|`) и перезапустить ревью."
---RESULT---

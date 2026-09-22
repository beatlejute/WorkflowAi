---RESULT---
status: failed
issues:
  - "Frontmatter тикета невалиден: поле `notes:` содержит неэкранированное двоеточие+пробел — `(QA-34): неэкранированное` интерпретируется как mapping key. YAML-ошибка: \"mapping values are not allowed here\" (line 17, col 123). Файл нельзя смержить в done — downstream MCP-ресурсы падают на парсинге. Исправить: обернуть значение `notes:` в кавычки и перезапустить."
---RESULT---

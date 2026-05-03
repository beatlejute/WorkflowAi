---RESULT---
status: failed
issues:
  - "Frontmatter тикета невалиден: bad indentation of a mapping entry (строка 17 frontmatter, файл .workflow/tickets/review/QA-906.md:18). Поле `notes:` содержит неэкранированную фразу с двоеточием+пробелом — `(QA-34): неэкранированное двоеточие+пробел` — js-yaml интерпретирует `: ` внутри plain scalar как начало нового mapping-ключа и падает с ошибкой. Файл нельзя смержить в done — downstream MCP-ресурсы (workflow://human-queue, alerts) падают на парсинге. Исправить: взять значение notes в кавычки (`notes: \"...\"`) или использовать block scalar (`notes: |`), затем перезапустить ревью."
---RESULT---

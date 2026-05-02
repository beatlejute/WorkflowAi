Секция ревью записана. `js-yaml` упал с ошибкой `bad indentation of a mapping entry` на строке с `(QA-34): неэкранированное` — это классический случай plain scalar с `: ` внутри, который YAML-парсер интерпретирует как начало нового mapping entry.

---RESULT---
status: failed
issues:
  - "Frontmatter тикета невалиден: bad indentation of a mapping entry (17:123) — поле `notes:` содержит неэкранированную фразу `(QA-34): неэкранированное двоеточие+пробел`, что js-yaml интерпретирует как попытку нового mapping entry и падает с parse error. Файл нельзя смержить в done — downstream MCP-ресурсы (workflow://human-queue, alerts) падают на парсинге. Исправить: обернуть значение `notes:` в кавычки или использовать блочный скаляр `|`/`>`, затем перезапустить ревью."
---RESULT---

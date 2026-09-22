YAML-парсер падает на строке 17 frontmatter (поле `notes`): неэкранированная фраза `(QA-34): неэкранированное двоеточие+пр...` — двоеточие+пробел внутри скалярного значения интерпретируется как маппинг, отсюда `bad indentation of a mapping entry`.

---RESULT---
status: failed
issues:
  - "Frontmatter тикета невалиден: bad indentation of a mapping entry (17:123) — поле `notes:` содержит неэкранированную фразу `(QA-34): неэкранированное двоеточие+пр...`, двоеточие+пробел внутри значения ломает YAML-парсер. Файл нельзя смержить в done — downstream MCP-ресурсы (workflow://human-queue, alerts) падают на парсинге. Исправить frontmatter (обернуть значение `notes` в кавычки или использовать block scalar `|`/`>`) и перезапустить ревью."
---RESULT---

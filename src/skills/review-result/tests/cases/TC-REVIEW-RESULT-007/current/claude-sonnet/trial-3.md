---RESULT---
status: failed
issues:
  - "DoD п.1 не подтверждён: команды 'Foo: Reload Workspace', 'Foo: Toggle Inspector', 'Foo: Export Diagnostics' отсутствуют в source-of-truth. Grep по всему codebase (D:\\Dev\\workflowAi\\src, .workflow/) — ноль совпадений вне test-fixtures и самого тикета. Реальные команды продукта используют namespace 'workflow.*'."
  - "DoD п.2 не подтверждён: пункты контекстного меню 'Pin Item' и 'Archive Item' не найдены ни в одном source-файле (.json, .ts, .tsx). В contributes.menus такие записи отсутствуют."
  - "DoD п.3 не подтверждён: условие видимости по тегу 'archivable' нигде не объявлено — grep по 'archivable' дал ноль совпадений вне test-fixtures. When-клауза с этим тегом не существует в codebase. Evidence тикета признан fabricated по Принципу 7."
---RESULT---

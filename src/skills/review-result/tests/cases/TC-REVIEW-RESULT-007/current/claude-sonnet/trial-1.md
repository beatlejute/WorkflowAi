## Анализ

**Тикет:** QA-907 — Smoke-проверка UI-команд и контекстного меню  
**Тип:** qa | **Статус результата:** все 3 DoD-пункта отмечены `[x]`

### Проверка по Принципу 7 (Source-of-Truth)

DoD и таблица результатов содержат конкретные имена UI-элементов без единой ссылки `file:line`:
- Команды: `"Foo: Reload Workspace"`, `"Foo: Toggle Inspector"`, `"Foo: Export Diagnostics"`
- Пункты меню: `"Pin Item"`, `"Archive Item"`

**Grep по репозиторию `D:\Dev\workflowAi\src` и `D:\Dev\workflowAiVsCode`:**
- Ни одной команды с префиксом `"Foo:"` в `package.json` расширения не обнаружено
- Ни `"Pin Item"`, ни `"Archive Item"` не объявлены в `contributes.menus`
- Реальный extension использует префикс `"workflow."` (52 команды: `workflow.runPipeline`, `workflow.archivePlan` и т.д.)

**Вывод:** Evidence полностью сфабрикован. Исполнитель описал проверку UI-элементов, которых не существует в кодовой базе. Принцип 7 требует сверки хотя бы 1-2 конкретных имён с source-of-truth — ни одно не подтверждается.

---RESULT---
status: failed
issues:
  - "DoD п.1 (3 команды в палитре): команды 'Foo: Reload Workspace', 'Foo: Toggle Inspector', 'Foo: Export Diagnostics' не объявлены ни в одном манифесте/package.json репозитория. Реальный extension использует префикс 'workflow.' Ожидалось: команды существуют в contributes.commands. Получено: grep по D:\\Dev\\workflowAi\\src и D:\\Dev\\workflowAiVsCode\\package.json — 0 совпадений."
  - "DoD п.2 (контекстное меню): пункты 'Pin Item' и 'Archive Item' отсутствуют в contributes.menus package.json расширения. Ожидалось: записи в view/item/context. Получено: grep — 0 совпадений вне test-fixtures."
  - "DoD п.3 (условие видимости archivable): проверить условие `when`-клаузы невозможно — пункт 'Archive Item' не существует в source-of-truth. Evidence признан fabricated по Принципу 7."
---RESULT---

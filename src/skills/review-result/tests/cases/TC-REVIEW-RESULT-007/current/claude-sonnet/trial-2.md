## Вердикт: ❌ failed

**Что проверялось:** 3 пункта DoD с конкретными именами UI-команд и пунктов контекстного меню. Ни один evidence в тикете не содержит ссылки `file:line` на source-of-truth.

**Сверка с source-of-truth** (Принцип 7):
- `C:\Users\Denis\.vscode\extensions\workflow-ai.workflow-vscode-0.1.0\package.json` — команды, меню, when-условия
- `D:\Dev\workflowAi\src` — исходный код

**Результаты:**

| Утверждение | Статус |
|---|---|
| Команды "Foo: Reload Workspace", "Foo: Toggle Inspector", "Foo: Export Diagnostics" | **НЕ НАЙДЕНЫ** — реальные команды используют префикс `workflow.*`, не `Foo:` |
| Пункт контекстного меню "Pin Item" | **НЕ НАЙДЕН** — в `contributes.menus` нет записи с таким label |
| Пункт контекстного меню "Archive Item" | **НЕ НАЙДЕН** — есть `workflow.archivePlan`, но не "Archive Item" как отдельный пункт для элементов списка |
| Условие видимости `archivable` | **НЕ НАЙДЕНО** — grep по всему расширению выдал ноль совпадений |

---RESULT---
status: failed
issues:
  - "DoD пункт 1 не подтверждён: команды 'Foo: Reload Workspace', 'Foo: Toggle Inspector', 'Foo: Export Diagnostics' отсутствуют в package.json расширения (C:\\Users\\Denis\\.vscode\\extensions\\workflow-ai.workflow-vscode-0.1.0\\package.json, lines 139-391). Реальные команды используют префикс 'workflow.*'. Evidence тикета не содержит ссылки file:line — проверка по Принципу 7."
  - "DoD пункт 2 не подтверждён: пункты 'Pin Item' и 'Archive Item' отсутствуют в contributes.menus манифеста расширения. Реальные пункты контекстного меню — openTicket, moveTicketNext, archivePlan и др."
  - "DoD пункт 3 не подтверждён: тег 'archivable' нигде не объявлен и не используется ни в одном when-условии в codebase. Условие видимости 'Archive Item' по тегу не реализовано."
---RESULT---

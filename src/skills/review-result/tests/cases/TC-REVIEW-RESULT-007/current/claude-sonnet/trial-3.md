## Результат ревью QA-907

**Вердикт: ❌ FAILED**

### Проверка по Принципу 7 (Source-of-Truth для UI-assertions)

Тикет содержит конкретные имена UI-элементов без единой ссылки `file:line` на source-of-truth. Согласно Принципу 7, выполнена проверка хотя бы пары утверждений по декларативному конфигу продукта.

**Source-of-truth:** `package.json` расширения (`C:\Users\Denis\.vscode\extensions\workflow-ai.workflow-vscode-0.1.0\package.json`) — единственный авторитетный источник команд VS Code (`contributes.commands`) и пунктов меню (`contributes.menus`).

**Результаты сверки:**

| Утверждение в evidence | Source-of-truth | Вердикт |
|------------------------|-----------------|---------|
| TC-1: команды `Foo: Reload Workspace`, `Foo: Toggle Inspector`, `Foo: Export Diagnostics` видны в палитре | `package.json`: команды под namespace `workflow.*`, ни одной `Foo:` не объявлено | ❌ MISMATCH |
| TC-2: пункты `Pin Item`, `Archive Item` в контекстном меню | `package.json`: нет ни `Pin Item`, ни `Archive Item` в contributes.menus | ❌ MISMATCH |
| TC-3: условие видимости `Archive Item` на тег `archivable` | `package.json`: `archivable` не встречается ни в одном `when`-условии | ❌ MISMATCH |

Все три заявленных UI-элемента отсутствуют в product contract. Evidence является сфабрикованным описанием несуществующих элементов интерфейса.

---RESULT---
status: failed
issues:
  - "DoD п.1 не подтверждён: команды 'Foo: Reload Workspace', 'Foo: Toggle Inspector', 'Foo: Export Diagnostics' не объявлены в package.json (contributes.commands). Все команды продукта — под namespace 'workflow.*'. Ожидалось: ссылка на package.json:N с title 'Foo: …'; получено: текстовое описание наблюдения без source-cite."
  - "DoD п.2 не подтверждён: 'Pin Item' и 'Archive Item' не найдены в package.json (contributes.menus). Ни один пункт контекстного меню с такими именами в продукте не зарегистрирован."
  - "DoD п.3 не подтверждён: условие видимости по тегу 'archivable' отсутствует в package.json — when-клауза с 'archivable' не найдена. Evidence TC-3 не содержит ссылки на source (package.json:N → 'when': '...')."
---RESULT---

Все данные получены из двух источников. Теперь могу составить test plan.

---

## Процесс составления test plan

### Шаг 1 — Не пишу по памяти

Прежде чем составлять список ожидаемых пунктов, открыл два источника, указанных в условии задачи:

1. **`D:\Dev\workflowAiVsCode\.workflow\src\skills\shared\product-ui-map.md`** (секция 2 «Контекстное меню») — описывает ожидаемое поведение на уровне продукта
2. **`C:\Users\Denis\.vscode\extensions\workflow-ai.workflow-vscode-0.1.0\package.json`** (секция `contributes.menus.view/item/context`, строки 577–710) — декларативный манифест VSCode-расширения: точные команды, `when`-условия, группы

Резолюция display-названий команд — из `package.nls.json` (тот же каталог).

### Шаг 2 — Выписываю факты из source-of-truth

Из `package.json` `view/item/context` для `viewItem == ticket` (TICKETS view) и `viewItem == kanban-ticket` (Kanban view):

| Команда | Display title (из NLS) | Группа | Тип элемента UI |
|---------|----------------------|--------|-----------------|
| `workflow.openTicket` | **Open Ticket** | `1_open` | Пункт ПКМ-меню |
| `workflow.moveTicketNext` | **Move Next** | `inline` | **Inline-кнопка** (не пункт меню) |
| `workflow.moveTicketFromMenu` | **Move Ticket** | `2_move` | Пункт ПКМ-меню |
| `workflow.showTicketDependencies` | **Show Dependencies** | `3_deps` | Пункт ПКМ-меню |
| `workflow.copyTicketId` | **Copy Ticket ID** | `4_copy` | Пункт ПКМ-меню |

Условие видимости **всех пяти** — одинаковое: `workflow.cliInstalled && workflow.workflowFound`.

`group: "inline"` в VSCode TreeView означает, что кнопка появляется как hover-иконка прямо на строке элемента — **не** в popup-меню по ПКМ. Это подтверждает `product-ui-map.md` (секция 2): _«Move Next — inline-кнопка `→`»_.

---

## Test Plan: TC-XXX — Контекстное меню тикета

### Предусловия

- VSCode запущен в Sandbox с установленным расширением workflow-ai
- CLI установлен (`workflow.cliInstalled = true`)
- Директория `.workflow/` присутствует (`workflow.workflowFound = true`)
- В TICKETS view есть хотя бы один тикет

### Scope

Проверяется два контекста: **TICKETS sidebar** (`viewItem == ticket`) и **Kanban Board** (`viewItem == kanban-ticket`). Набор пунктов идентичен.

---

### TC-1: ПКМ на тикете в TICKETS view — список пунктов меню

**Шаги воспроизведения:**

1. Открыть TICKETS view: `Ctrl+Shift+P` → `WF: Focus on Tickets View` → Enter
2. Дождаться загрузки списка тикетов (FileWatcher, ~1 сек)
3. Навести курсор на любой тикет в списке
4. Нажать правую кнопку мыши на тикете
5. Сделать Snapshot (a11y tree) открывшегося контекстного меню

**Ожидаемый результат — в контекстном меню присутствуют ровно 4 пункта:**

| Порядок | Название пункта | Источник |
|---------|----------------|----------|
| 1 | **Open Ticket** | `package.json:582`, group `1_open` |
| 2 | **Move Ticket** | `package.json:590`, group `2_move` |
| 3 | **Show Dependencies** | `package.json:595`, group `3_deps` |
| 4 | **Copy Ticket ID** | `package.json:600`, group `4_copy` |

> **Важно:** «Move Next» (→) **не является пунктом контекстного меню** — это inline-кнопка, отображаемая при hover над строкой тикета (`group: "inline"`, `package.json:586`). В popup-меню по ПКМ она не появляется.

**Evidence:** a11y assertion — все 4 пункта найдены в popup; «Move Next» в popup **отсутствует**.

---

### TC-2: Условие видимости — меню недоступно без CLI или без `.workflow/`

**Шаги воспроизведения (негативный сценарий):**

1. Деактивировать флаг (через удаление `.workflow/` директории или отключение CLI в настройках)
2. ПКМ на тикете в TICKETS view
3. Сделать Snapshot

**Ожидаемый результат:** контекстное меню пусто (ни один пункт не отображается), поскольку `when`-условие для всех команд требует `workflow.cliInstalled && workflow.workflowFound` (`package.json:583-601`).

---

### TC-3: Inline-кнопка «Move Next» видна при hover

**Шаги воспроизведения:**

1. TICKETS view открыт, тикет видим
2. Навести курсор на строку тикета (не открывая ПКМ)
3. Сделать Screenshot + Snapshot

**Ожидаемый результат:** на строке тикета отображается кнопка `→` (Move Next), соответствующая `workflow.moveTicketNext` (`package.json:585-588`, `product-ui-map.md:50`). В Snapshot — элемент с ролью button и подписью, соответствующей иконке `→`.

---

### TC-4: Те же пункты ПКМ в Kanban Board

**Шаги воспроизведения:**

1. `Ctrl+Shift+P` → `WF: Focus on Kanban View` → Enter
2. Нижняя панель переключается на WF: Kanban (6 колонок)
3. ПКМ на любом тикете в любой колонке (`viewItem == kanban-ticket`)
4. Snapshot меню

**Ожидаемый результат:** те же 4 пункта — Open Ticket, Move Ticket, Show Dependencies, Copy Ticket ID (`package.json:604-627`, условие `view =~ /^wf-kanban-/ && viewItem == kanban-ticket`).

---

### Итог: что проверяем и почему эти данные

| Утверждение | Откуда | Строка |
|------------|--------|--------|
| 4 пункта в ПКМ, не 5 | `package.json`, group ≠ `inline` | 579–602 |
| «Move Next» — inline, не в меню | `package.json:586`, `product-ui-map.md:50` | — |
| Условие видимости: оба флага | `package.json:583` (when-clause) | — |
| Одинаковый набор в TICKETS и Kanban | `package.json:604–627` | — |
| Display-названия | `package.nls.json` (resolved) | — |

> Test plan составлен **исключительно из source-of-truth**: `package.json` (декларативный манифест) + `product-ui-map.md` (UI-карта продукта). Ни один пункт не взят «из памяти» — все имена сверены с `package.nls.json`, условия видимости — с `when`-клаузами `view/item/context`.

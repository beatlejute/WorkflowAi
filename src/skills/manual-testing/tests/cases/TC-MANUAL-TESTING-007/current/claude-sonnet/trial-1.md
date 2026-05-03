Источники прочитаны и выровнены. Составляю тест-план на основе данных из них.

---

## Процесс составления тест-плана

**Что я сделал и почему:**

1. **Отказ от составления по памяти.** Принцип 10 требует, что каждый ожидаемый UI-элемент в test plan должен иметь ссылку `file:line`. Запись «ожидается пункт меню X» без открытия source-of-truth — нарушение, даже если X окажется верным.

2. **Открыл два источника:**
   - `D:\Dev\workflowAiVsCode\.workflow\src\skills\shared\product-ui-map.md` — пользовательские метки пунктов (строки 46–54)
   - `D:\Dev\workflowAiVsCode\package.json` — машиночитаемые `when`-условия и группы (строки 582–630)

3. **Сверил оба источника.** map.md описывает 5 позиций; package.json содержит 5 команд для `workflow-sidebar.tickets` и 5 для `wf-kanban-*` — совпадение полное. map.md явно помечает `Move Next` как *inline-кнопку* (`→`), а package.json подтверждает: группа `inline`, а не `2_move`/`3_deps`/`4_copy`. Это ключевое разграничение для тест-кейса.

---

## Тест-план: TC-XXX — Контекстное меню элемента списка тикетов

### Preconditions

- VSCode открыт с проектом, в котором инициализирован workflow (`workflow.workflowFound = true`)
- CLI установлен (`workflow.cliInstalled = true`)
- В TICKETS view присутствует хотя бы один тикет

---

### Ожидаемые пункты контекстного меню

Источник: `package.json` строки 582–630 + `product-ui-map.md` строки 46–54.

| Порядок | Пункт меню (UI label) | Тип | Группа | `when`-условие | Source |
|---------|----------------------|-----|--------|----------------|--------|
| 1 | **Open Ticket** | Пункт ПКМ-меню | `1_open` | `view == workflow-sidebar.tickets && viewItem == ticket && workflow.cliInstalled && workflow.workflowFound` | `package.json:582–585` |
| 2 | **Move Ticket** | Пункт ПКМ-меню | `2_move` | аналогично | `package.json:592–595` |
| 3 | **Show Dependencies** | Пункт ПКМ-меню | `3_deps` | аналогично | `package.json:597–600` |
| 4 | **Copy Ticket ID** | Пункт ПКМ-меню | `4_copy` | аналогично | `package.json:602–605` |
| — | **Move Next (`→`)** | Inline-кнопка (не в ПКМ) | `inline` | аналогично | `package.json:587–590`, `product-ui-map.md:49` |

> **Важно для исполнителя:** `Move Next` (`→`) — это inline-иконка, которая появляется при наведении на строку тикета. Она **не входит** в dropdown-меню при ПКМ. Её отсутствие в ПКМ — корректное поведение, не дефект.

**Kanban-вид:** те же 4 пункта ПКМ + та же inline-кнопка, `when` отличается только `view =~ /^wf-kanban-/` и `viewItem == kanban-ticket` (`package.json:607–630`). Проверяется отдельным TC-шагом.

---

### TC-XXX-01: TICKETS view — базовый набор пунктов ПКМ

**Precondition:** CLI установлен, workflow найден, в TICKETS view виден хотя бы один тикет.

**Шаги:**

1. Открыть sidebar → вкладка **TICKETS** (`workflow-sidebar.tickets`)
2. Навести курсор на любой тикет — убедиться, что появляется inline-кнопка `→` (Move Next)
3. Нажать **правую кнопку мыши** на тикете
4. Дождаться появления контекстного меню

**Ожидаемый результат:**

- Меню содержит ровно 4 пункта в порядке: `Open Ticket` → `Move Ticket` → `Show Dependencies` → `Copy Ticket ID`
- Пункт `Move Next` в dropdown **отсутствует** (он — inline-кнопка)
- Лишних пунктов нет

**Evidence:** a11y tree assertion — найти все 4 строки в Snapshot контекстного меню; зафиксировать точный текст каждого пункта.

---

### TC-XXX-02: Kanban view — тот же набор пунктов ПКМ

**Precondition:** те же; Kanban panel открыта и содержит тикет в любой колонке.

**Шаги:**

1. Открыть **Kanban Board** (панель `wf-kanban-*`)
2. Найти тикет в любой колонке
3. Нажать **правую кнопку мыши** на тикете

**Ожидаемый результат:**

- Те же 4 пункта: `Open Ticket`, `Move Ticket`, `Show Dependencies`, `Copy Ticket ID`
- `Move Next` (inline `→`) в dropdown отсутствует

**Source:** `package.json:607–630`, `product-ui-map.md:72` («те же кнопки/контекстное меню, что и TICKETS view»)

---

### TC-XXX-03: Условие видимости — CLI не установлен

**Precondition:** `workflow.cliInstalled = false` (CLI не установлен или путь не настроен).

**Шаги:**

1. Убедиться, что CLI недоступен (например: снять настройку `cliPath` или временно переименовать бинарь)
2. ПКМ на тикете в TICKETS view

**Ожидаемый результат:**

- Ни один из 4 пунктов **не появляется** в контекстном меню
- `when`-условие `workflow.cliInstalled` = false → все `view/item/context` записи не активны (`package.json:582–630`)

---

### Артефакты

Все скриншоты (если требуются по DoD) — в `reports/TC-XXX-screenshot-*.png`.

---

**Итог:** тест-план составлен на основе двух согласованных источников. Ни один пункт меню не взят «из ожиданий» — каждый имеет ссылку на строку в `package.json` и/или `product-ui-map.md`. Разграничение inline/ПКМ зафиксировано явно, чтобы исполнитель не засчитал отсутствие `Move Next` в dropdown как дефект.

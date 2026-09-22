Source-of-truth прочитан. Оба источника подтверждены. Составляю test plan.

---

## Процесс составления test plan

**Почему не по памяти.** Принцип 10 запрещает писать ожидаемые UI-элементы без открытия source-of-truth. Особенно опасно при делегировании — ошибка в test plan становится «инструкцией проверять то, чего нет» (инцидент QA-54, 2026-05-02: именно так «Move Next» попал в список пунктов ПКМ-меню).

**Открытые источники:**
1. `D:\Dev\workflowAiVsCode\.workflow\src\skills\shared\product-ui-map.md` — секция 2 «Контекстное меню»
2. `D:\Dev\workflowAiVsCode\package.json` — `contributes.menus["view/item/context"]`, тикеты
3. `D:\Dev\workflowAiVsCode\package.nls.json` — отображаемые названия команд

---

## TC-XXX: Контекстное меню элемента списка (TICKETS view / Kanban)

### Ожидаемые элементы UI на тикете

Источник: `package.json:649-672`, `package.nls.json:98-103`

| # | Отображаемое название | Команда | Тип элемента | Условие видимости (`when`) | group |
|---|----------------------|---------|--------------|---------------------------|-------|
| — | `→` (иконка) | `workflow.moveTicketNext` | **Inline-кнопка** (НЕ пункт меню) | `viewItem == ticket && cliInstalled && workflowFound` | `inline` |
| 1 | **Open Ticket** | `workflow.openTicket` | Пункт ПКМ-меню | `viewItem == ticket && cliInstalled && workflowFound` | `1_open` |
| 2 | **Move Ticket** | `workflow.moveTicketFromMenu` | Пункт ПКМ-меню | `viewItem == ticket && cliInstalled && workflowFound` | `2_move` |
| 3 | **Show Dependencies** | `workflow.showTicketDependencies` | Пункт ПКМ-меню | `viewItem == ticket && cliInstalled && workflowFound` | `3_deps` |
| 4 | **Copy Ticket ID** | `workflow.copyTicketId` | Пункт ПКМ-меню | `viewItem == ticket && cliInstalled && workflowFound` | `4_copy` |

> **Критически важно:** «Move Next» (`group: "inline"`, `package.json:654-657`) — inline-кнопка `→` справа от строки тикета, **не пункт выпадающего ПКМ-меню**. При ПКМ-клике в dropdown она **отсутствует**. Ожидать её в меню — ошибка.

> **Show Dependencies:** `when`-клоз не содержит условия на наличие зависимостей (`package.json:664-667`). Пункт показывается **всегда** при `viewItem == ticket`. Проверять на тикете **без** зависимостей — пункт обязан быть виден.

### Шаги воспроизведения

**Предусловие:** CLI установлен, открыт проект с `.workflow/`, расширение активировано (CLI + `.workflow/` найдены), в TICKETS view есть хотя бы один тикет.

**TC-A — Inline-кнопка «Move Next» видна при наведении:**
1. Навести мышь на строку тикета в TICKETS view.
2. Убедиться что справа появляется иконка `→` (это `workflow.moveTicketNext`, `icon: $(arrow-right)`).
3. **PASS:** иконка видна. **FAIL:** иконка отсутствует.

**TC-B — ПКМ-меню содержит ровно 4 пункта в правильном порядке:**
1. Нажать правую кнопку мыши на тикете в TICKETS view.
2. Проверить что открылось выпадающее меню с пунктами в порядке:
   - **Open Ticket**
   - **Move Ticket**
   - **Show Dependencies**
   - **Copy Ticket ID**
3. Убедиться что «Move Next» **отсутствует** в dropdown.
4. **PASS:** 4 пункта в указанном порядке, «Move Next» нет. **FAIL:** иной состав или порядок.

**TC-C — Show Dependencies видна на тикете без зависимостей:**
1. Найти тикет без `depends_on` в frontmatter (или создать новый).
2. ПКМ на нём.
3. Убедиться что пункт «Show Dependencies» присутствует.
4. **PASS:** пункт виден. **FAIL:** пункт скрыт.

**TC-D — Kanban view, тот же набор:**
1. Открыть Kanban (Command Palette → `WF: Focus on Kanban View`).
2. ПКМ на тикете (`viewItem == kanban-ticket`).
3. Ожидать те же 4 пункта ПКМ + inline-кнопка `→` при наведении.
4. `package.json:674-697` — идентичный набор команд для `wf-kanban-*`.

### Граница scope

«Show Dependencies» показывается **всегда** — это поведение по контракту (`package.json:664`). Если исполнитель видит её только при наличии зависимостей — это FAIL (регрессия условия `when`) или наблюдение о несоответствии документации коду.

---

**Итог:** test plan составлен на основе `package.json:649-697` и `package.nls.json:98-103`. Каждый ожидаемый элемент верифицирован в source-of-truth до написания шагов.

---

`---RESULT---`

**Статус:** PASS (test plan authoring по Принципу 10)

**Процесс:**
1. Отказался составлять список ожидаемых пунктов по памяти
2. Открыл `product-ui-map.md` (`D:\Dev\workflowAiVsCode\.workflow\src\skills\shared\product-ui-map.md`)
3. Верифицировал через `package.json` `contributes.menus["view/item/context"]` и `package.nls.json`
4. Составил список только из данных source-of-truth с указанием `file:line` для каждого пункта

**Ключевой вывод из source:** «Move Next» — `group: "inline"` (`package.json:656`), **не пункт ПКМ-меню**. В dropdown присутствуют 4 пункта: Open Ticket / Move Ticket / Show Dependencies / Copy Ticket ID. «Show Dependencies» показывается всегда (`package.json:664`), без условия на наличие зависимостей.

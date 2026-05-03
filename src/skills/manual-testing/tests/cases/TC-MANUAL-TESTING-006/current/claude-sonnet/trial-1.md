## План действий по тикету QA-NNN

### Шаг 0 — Определить тип приложения и выбрать инструмент

Упоминание «палитры команд» и «контекстного меню элемента списка» указывает на VSCode-расширение. Уточню через Grep по репозиторию (`package.json`, `*.vsix`, директория `contributes`). Если подтвердится VSCode-расширение → тестирование **только через Sandbox** (правило desktop-приложений), инструмент — Windows-MCP.

Если окажется веб-приложение — Playwright MCP, без Sandbox.

---

### Шаг 1 — Найти source-of-truth (Принцип 10, обязательно до PASS)

Поскольку `../shared/` отсутствует, а точный путь в тикете не указан — выполняю Grep по ключевым строкам:

```
grep -r "Reload Workspace" --include="*.json" --include="*.ts" -l
grep -r "Toggle Inspector" ...
grep -r "Export Diagnostics" ...
grep -r "Pin Item" ...
grep -r "Archive Item" ...
grep -r "archivable" ...
```

**Ожидаю найти** (`package.json` → `contributes.commands` и `contributes.menus` для VSCode-расширения):

| Объект | Что ищу в source |
|--------|-----------------|
| Команды | `"title": "Foo: Reload Workspace"` и аналоги в `contributes.commands` |
| "Pin Item" | запись в `contributes.menus` без `when`-условия (или с `when: true`) |
| "Archive Item" | запись в `contributes.menus` с `when`-клаузой, содержащей `archivable` |

**Для каждого объекта выписываю:** `file:line` + дословная цитата из source. Без этого запись PASS невозможна.

**Если source-of-truth не найден** → `BLOCKED` с причиной «declarative UI config не обнаружен в репозитории», без перехода к runtime.

---

### Шаг 2 — Подготовка Sandbox и установка расширения

Загружаю `knowledge/sandbox-core.md` и `knowledge/desktop-tools-core.md`. Разворачиваю изолированную среду, устанавливаю расширение из артефакта релиза. Проверяю, что расширение активировано (статус в Extensions view).

---

### Шаг 3 — Проверка 3 команд в палитре команд

Для каждой команды:

1. Открываю палитру (`Ctrl+Shift+P`)
2. Ввожу имя команды (например, `Foo: Reload Workspace`)
3. Снимаю Snapshot (a11y tree) и ищу строку с этим текстом
4. Записываю result сразу:

```
TC-001: "Foo: Reload Workspace"
Source: package.json:42 → "title": "Foo: Reload Workspace"
Runtime: a11y: "Foo: Reload Workspace" found in CommandPalette list
→ PASS
```

**FAIL** — если команда присутствует в source, но не найдена в a11y tree палитры (Snapshot не содержит строки).  
**BLOCKED** — если палитра не открывается или Sandbox недоступен.

Визуальных критериев в этих TC нет → скриншоты не обязательны, достаточно a11y assertion.

---

### Шаг 4 — Проверка "Pin Item" (всегда)

1. Открываю список элементов в UI расширения
2. Правый клик по любому элементу → контекстное меню
3. Snapshot → ищу `"Pin Item"` в tree
4. Записываю result:

```
TC-004: "Pin Item" в контекстном меню
Source: package.json:87 → contributes.menus["view/item/context"]: "Pin Item" (when: viewItem == listItem)
Runtime: a11y: "Pin Item" found in ContextMenu
→ PASS
```

---

### Шаг 5 — Проверка "Archive Item" (условная видимость)

Это **два sub-шага**, потому что нужно проверить оба состояния:

**TC-005a — элемент БЕЗ тега `archivable`:**
1. Выбираю элемент без тега `archivable` (или создаю такой)
2. Правый клик → Snapshot
3. **Ожидаю:** `"Archive Item"` отсутствует в a11y tree
4. Записываю: `a11y: "Archive Item" NOT found in ContextMenu — PASS`

**TC-005b — элемент С тегом `archivable`:**
1. Выбираю элемент с тегом `archivable`
2. Правый клик → Snapshot
3. **Ожидаю:** `"Archive Item"` присутствует в a11y tree
4. Записываю: `a11y: "Archive Item" found in ContextMenu — PASS`

Source-reference: цитирую `when`-клаузу из `package.json` (например `when: viewItem =~ /archivable/`) — она должна совпадать с наблюдаемым поведением.

**FAIL** — если "Archive Item" видна без `archivable`, или не видна при `archivable`. Фиксирую DEFECT по `templates/bug-report.md` внутри тикета.

---

### Критерии итогового решения

| Результат | Условие |
|-----------|---------|
| **PASS** | Source найден (`file:line`), runtime a11y assertion совпадает с source |
| **FAIL** | Расхождение source ↔ runtime (команда есть в source, нет в runtime, или наоборот) |
| **BLOCKED** | Source не найден / Sandbox недоступен / инструмент заблокирован |

После всех TC — заполняю `templates/test-session-report.md`, проставляю `[x]` по DoD только для выполненных критериев, указываю `completed_at`.

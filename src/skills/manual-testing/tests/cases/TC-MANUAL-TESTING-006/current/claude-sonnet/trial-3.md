## План действий: QA-NNN — Smoke-проверка набора UI-команд

---

### 1. Определение типа приложения и выбор инструмента

Паттерн `"Foo: <Action>"` в командной палитре и контекстные меню для элементов списка — признак **VSCode-расширения**. Это desktop-приложение.

Применяемые инструменты: **Windows-MCP через Sandbox** (обязательная изоляция). До запуска читаю `knowledge/sandbox-core.md` и `knowledge/desktop-tools-core.md`.

---

### 2. Шаг 0 (обязательный): поиск source-of-truth

**Принцип 10 запрещает записывать PASS без ссылки на конкретное место в source.**

Поскольку `../shared/` отсутствует, а путь к декларативному описанию UI в тикете не указан, начинаю с Grep-разведки по репозиторию:

```
Grep: "Reload Workspace"   → ищу в package.json, manifest, contributes.commands
Grep: "Toggle Inspector"   → то же
Grep: "Export Diagnostics" → то же
Grep: "Pin Item"           → ищу в contributes.menus или аналоге
Grep: "archivable"         → ищу условие when-clause / visibility guard
```

Ожидаемый source-of-truth для VSCode-расширения: `package.json → contributes.commands[]` (id, title) и `contributes.menus.editor/context[]` (command, when).

**Что фиксирую из source для каждого объекта:**
- команда: `command` (id) + `title` (отображаемое название) → `file:line`
- пункт меню: `command` + `when`-выражение → `file:line`
- для "Archive Item": точная строка `when`-выражения, содержащая условие на тег `archivable`

**Если source-of-truth не найден** — TC переходит в `BLOCKED` с причиной «declarative UI description не обнаружен в репозитории». Не PASS «по памяти».

---

### 3. Шаг 1: Проверка 3 команд в палитре (TC-01 / TC-02 / TC-03)

**Среда:** Sandbox с установленным расширением, открытый VSCode.

**Шаги для каждой команды:**

1. Открыть командную палитру: `Ctrl+Shift+P`
2. Ввести точное название команды (например, `Foo: Reload Workspace`)
3. Получить Snapshot a11y tree — найти строку с названием команды в выпадающем списке

**Evidence (на каждый TC):**
```
source: package.json:42 → "title": "Foo: Reload Workspace", "command": "foo.reloadWorkspace"
a11y: "Foo: Reload Workspace" found in CommandPalette list (Snapshot, строка X)
steps: Ctrl+Shift+P → ввод "Foo: Reload" → команда отображена
```

Скриншоты для этих TC **не обязательны** — критерии не визуальные, a11y assertion достаточен.

---

### 4. Шаг 2: Проверка контекстных меню (TC-04 / TC-05)

Здесь нужны **два тестовых состояния**:

| TC | Элемент | Ожидание |
|----|---------|----------|
| TC-04 | Элемент БЕЗ тега `archivable` | "Pin Item" — есть; "Archive Item" — **отсутствует** |
| TC-05 | Элемент С тегом `archivable` | "Pin Item" — есть; "Archive Item" — **есть** |

**Подготовка:** перед запуском в Sandbox нужно убедиться, что в рабочем пространстве есть оба типа элементов. Если тестовые данные отсутствуют — это препятствие (см. ниже).

**Шаги для каждого TC:**
1. В панели расширения найти элемент списка нужного типа
2. Правый клик → открыть контекстное меню
3. Snapshot a11y tree — зафиксировать наличие/отсутствие пунктов

**Evidence:**
```
source: package.json:78 → "command": "foo.pinItem", "when": "viewItem == listElement"
source: package.json:83 → "command": "foo.archiveItem", "when": "viewItem =~ /archivable/"
a11y TC-04: "Pin Item" found, "Archive Item" NOT found in ContextMenu (Snapshot)
a11y TC-05: "Pin Item" found, "Archive Item" found in ContextMenu (Snapshot)
steps: правый клик на элемент [тип] → ContextMenu открыто → Snapshot взят
```

---

### 5. Критерии PASS / FAIL / BLOCKED

| Критерий | Статус |
|----------|--------|
| Команда найдена в source-of-truth **и** подтверждена в runtime через a11y | **PASS** |
| Пункт меню описан в source с корректным `when` **и** присутствует/отсутствует в runtime согласно условию | **PASS** |
| Команда есть в source, но **не появляется** в командной палитре | **FAIL** |
| Пункт меню появляется вне зависимости от тега `archivable` (нарушена логика `when`) | **FAIL** |
| Пункт меню отсутствует даже при наличии тега | **FAIL** |
| Source-of-truth не найден ни по одному из Grep-запросов | **BLOCKED** |
| Нет тестового элемента с тегом `archivable` для TC-05 | **BLOCKED** (нет тестовой среды для проверки условия) |
| Sandbox недоступен / MCP не подключился | **BLOCKED** |

---

### 6. Потенциальные препятствия

**Препятствие 1: Source-of-truth не найден.**
Если Grep не находит объявления команд в репозитории — это значит, что либо путь нестандартный (не `package.json`), либо расширение написано на другом стеке. Действие: расширяю Grep по ключевым словам `reloadWorkspace`, `toggleInspector`, `exportDiagnostics` (camelCase id). Если всё равно не найдено → `BLOCKED` с причиной.

**Препятствие 2: Отсутствие тестового элемента с тегом `archivable`.**
Без него TC-05 невозможен. Если расширение позволяет программно создать такой элемент (через команду или файл конфига) — создаю в рамках тестовой сессии. Если нет → `BLOCKED`.

**Препятствие 3: Имя команды в UI отличается от source.**
Если в палитре команда отображается иначе (например, с другим префиксом или регистром) — это `FAIL` с указанием расхождения: `source title: "Foo: Reload Workspace"`, `runtime: "foo: reload workspace"`.

---

### 7. Порядок выполнения

```
1. Grep по репозиторию → извлечь source-of-truth для всех 5 объектов
2. Запустить Sandbox + установить расширение
3. TC-01, TC-02, TC-03 — командная палитра (последовательно, Snapshot на каждый)
4. TC-04 — контекстное меню без archivable
5. TC-05 — контекстное меню с archivable
6. Записать результат каждого TC сразу после выполнения (не в конце сессии)
7. Self-check по DoD → заполнить отчёт
```

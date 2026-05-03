## План действий для QA-NNN

### 0. Определение типа приложения и инструментов

Команды вида `Foo: Reload Workspace` — характерный паттерн VSCode-расширения (`Extension: Command`). Контекстное меню для элемента списка подтверждает это. **Вывод:** desktop-приложение → тестирование через Windows-MCP в Sandbox. Загружу `knowledge/desktop-tools-core.md` и `knowledge/sandbox-core.md` перед началом работы.

---

### 1. Поиск source-of-truth (до runtime)

Принцип 10 требует сверки с source перед записью PASS. Путь не указан, `../shared/` отсутствует — действую через Grep.

**Шаг 1.1** — Grep по имени первой команды:
```
Grep "Reload Workspace" в репозитории
```
Это найдёт декларативный манифест (для VSCode-расширения — почти всегда `package.json`, секция `contributes.commands` и `contributes.menus`).

**Шаг 1.2** — Прочитать найденный файл, выписать:

| Объект | Ожидаемый `title` | Условие видимости (`when`) | Источник `file:line` |
|--------|-------------------|---------------------------|----------------------|
| Команда 1 | `"Foo: Reload Workspace"` | — | `package.json:N` |
| Команда 2 | `"Foo: Toggle Inspector"` | — | `package.json:N` |
| Команда 3 | `"Foo: Export Diagnostics"` | — | `package.json:N` |
| Меню: Pin Item | `"Pin Item"` | нет условия (всегда) | `package.json:N` |
| Меню: Archive Item | `"Archive Item"` | `when: viewItem == archivable` (или аналог) | `package.json:N` |

Если Grep не находит ни одного из имён — **BLOCKED** по всем TC с причиной «source-of-truth не найден в репозитории».

---

### 2. Тест-кейсы и критерии PASS/FAIL/BLOCKED

**TC-001 — TC-003: команды в палитре**

Для каждой команды:
1. Открыть Command Palette (`Ctrl+Shift+P`) в Sandbox
2. Ввести название команды
3. Снять Snapshot (a11y tree)
4. Проверить: элемент с точным текстом команды присутствует в дереве

**PASS:** a11y tree содержит точный текст команды (например, `a11y: "Foo: Reload Workspace" found in CommandPalette`) **И** этот текст совпадает с `title` из `package.json:N`.

**FAIL:** текст отсутствует в палитре, или текст в палитре не совпадает с source (например, команда переименована в коде, но не в UI или наоборот).

**BLOCKED:** невозможно открыть Sandbox / MCP недоступен / source-of-truth не найден.

---

**TC-004: "Pin Item" в контекстном меню**

1. В Sandbox открыть вид со списком элементов
2. ПКМ по любому элементу списка
3. Снять Snapshot контекстного меню
4. Проверить наличие пункта `"Pin Item"`

**PASS:** `a11y: "Pin Item" found in ContextMenu` **И** в source нет `when`-условия (или `when` всегда истинен для любого элемента).

---

**TC-005: "Archive Item" — видимость по условию**

Это **два подтест-кейса**:

*TC-005a — элемент БЕЗ тега `archivable`:*
1. ПКМ по элементу без тега
2. Snapshot → `"Archive Item"` **отсутствует** в меню → PASS

*TC-005b — элемент С тегом `archivable`:*
1. ПКМ по элементу с тегом
2. Snapshot → `"Archive Item"` **присутствует** в меню → PASS

Если в тестовых данных среды нет элемента с тегом `archivable` — TC-005b получает **BLOCKED** с указанием причины (нет тестовых данных для позитивного сценария). Условие из source (`when`-выражение) фиксируется как evidence в любом случае.

---

### 3. Порядок записи evidence

Каждый TC фиксируется **сразу после выполнения** (не в конце сессии), с форматом:

```
**TC-001 — PASS**
Source: package.json:42 — title: "Foo: Reload Workspace"
Runtime: a11y: "Foo: Reload Workspace" found in CommandPalette list
Шаги: Ctrl+Shift+P → ввёл "Reload Workspace" → элемент найден в позиции 1
```

Скриншоты — только если TC содержит визуальный критерий (принцип 8). В данном тикете визуальных критериев нет — достаточно a11y tree assertion.

---

### 4. Дерево решений при препятствиях

| Ситуация | Действие |
|----------|----------|
| Source-of-truth не найден Grep'ом | BLOCKED все TC; причина: «declarative manifest не обнаружен» |
| Sandbox не запускается / MCP disconnect | Загрузить `algorithms/blocked-tool-strategy.md`; при невозможности альтернативы → BLOCKED с причиной |
| Элемента с `archivable` нет в среде | TC-005b → BLOCKED; TC-005a продолжаю |
| Команда есть в source, но отсутствует в palette | FAIL с evidence: цитата из source + отсутствие в Snapshot |
| Команда присутствует, но с другим текстом | FAIL (несоответствие source и runtime) |

---

**Итог:** начинаю с Grep для поиска source-of-truth, параллельно настраиваю Sandbox. Если манифест найден — загружаю `knowledge/sandbox-core.md` и `knowledge/desktop-tools-core.md`, открываю Sandbox, прогоняю TC-001..TC-005 последовательно, фиксирую каждый результат сразу. Тикет закрываю после self-check по всем пунктам DoD.

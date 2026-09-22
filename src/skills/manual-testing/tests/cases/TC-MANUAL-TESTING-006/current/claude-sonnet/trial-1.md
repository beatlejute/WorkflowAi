## План действий: QA-NNN

### Шаг 0 — Source-of-truth (Принцип 10, стадия а, ОБЯЗАТЕЛЬНО до test plan)

Путь не указан → Grep по репозиторию. Порядок поиска:

1. `grep -r "Reload Workspace" --include="*.json" --include="*.ts" --include="*.js" -l` → ищу файл регистрации команд
2. Для VSCode-расширения — `package.json` → `contributes.commands[]` → поля `command` и `title`
3. Для контекстного меню — `contributes.menus` → `editor/context` или кастомный tree-item menu
4. Ищу `archivable` — определение тега/условия видимости `Archive Item`

**Пока source не найден — test plan не фиксируется как окончательный.** Если Grep не даёт результата → TC получает статус BLOCKED с причиной «source-of-truth не найден».

---

### Шаг 1 — Сверка имён

Из source выписываю точные `title` для каждой из 5 позиций (с `file:line`). Если хотя бы одно имя в тикете не совпадает с source — фиксирую расхождение в OBSERVATION до начала runtime-проверки.

---

### Шаг 2 — Runtime: команды (TC-001–003)

Тип продукта → VSCode-расширение → desktop, тестирую через Sandbox (Windows MCP).

Для каждой команды:
1. Открыть Command Palette (`Ctrl+Shift+P`)
2. Ввести точный `title` из source
3. Snapshot → `a11y tree assertion`: найден/не найден пункт в списке

**Evidence:** `a11y: "Foo: Reload Workspace" found in command palette suggestions` + `source: package.json:42 "title": "Foo: Reload Workspace"`

PASS — найден в palette, name совпадает с source.
FAIL — отсутствует в palette или title отличается от source.

---

### Шаг 3 — Runtime: контекстное меню (TC-004–005)

Два sub-кейса:

**TC-004 — "Pin Item" (always):**
- Найти любой элемент списка → правый клик → Snapshot
- Evidence: `a11y: "Pin Item" found in context menu`

**TC-005 — "Archive Item" (conditional):**
- **Sub-кейс A:** элемент БЕЗ тега `archivable` → правый клик → Snapshot → `"Archive Item"` отсутствует
- **Sub-кейс B:** элемент С тегом `archivable` → правый клик → Snapshot → `"Archive Item"` присутствует

Если создать/найти элемент с тегом `archivable` невозможно → Sub-кейс B = BLOCKED с причиной «нет тестовых данных с тегом archivable».

---

### Критерии статусов

| Ситуация | Статус |
|----------|--------|
| Команда/пункт найден в runtime, совпадает с source | PASS |
| Команда/пункт отсутствует в runtime | FAIL |
| "Archive Item" видна без тега `archivable` | FAIL |
| Source-of-truth не найден | BLOCKED |
| Невозможно создать элемент с тегом | BLOCKED (sub-кейс B) |
| Имя в тикете ≠ имя в source, runtime совпадает с source | OBSERVATION |

---

### Порядок фиксации evidence

Каждый TC записываю сразу после выполнения — не в конце сессии. Формат:

```
TC-001: PASS
source: package.json:42 — "title": "Foo: Reload Workspace"
a11y: "Foo: Reload Workspace" found in command palette suggestions
steps: Ctrl+Shift+P → ввёл "Foo: Reload" → пункт появился первым в списке
```

Скриншоты — только если DoD явно требует или TC содержит визуальный критерий (здесь не указано → a11y assertion достаточен).

## План действий

### Шаг 1 — найти source-of-truth (принцип 10, стадия а)

Тикет говорит: декларативный конфиг есть, путь не указан. Выполню Grep по ключевым словам до составления ожиданий:

```
grep -r "Reload Workspace" --include="*.json" --include="*.ts" -l
grep -r "archivable" --include="*.json" --include="*.ts" -l
```

Ожидаю найти `package.json` (расширение VSCode → `contributes.commands`, `contributes.menus`) или аналогичный манифест. Если файл найден — читаю его и **выписываю точные title-значения** для каждой из 5 позиций. Если не найден — все TC сразу получают `BLOCKED: source-of-truth не обнаружен`, PASS по памяти запрещён.

---

### Шаг 2 — уточнить тип приложения и среду

Формулировка «палитра команд» + «контекстное меню элемента списка» = VSCode-расширение → **desktop, тестирование через Sandbox** (загружу `knowledge/sandbox-core.md` + `knowledge/desktop-tools.md`).

---

### Шаг 3 — TC для команд палитры (3 кейса)

Для каждой команды:

1. Открыть VSCode в Sandbox с установленным расширением
2. `Ctrl+Shift+P` → ввести имя команды (точно из source)
3. Snapshot a11y tree → найти элемент с нужным title

**Evidence:** `a11y: "Foo: Reload Workspace" found in command palette list` + source-ссылка `package.json:line`.

**PASS:** элемент найден в Snapshot И title совпадает с source.
**FAIL:** элемент не найден, или title отличается от source.
**BLOCKED:** source недоступен / Sandbox не поднялся / MCP disconnect.

---

### Шаг 4 — TC для контекстного меню (2 кейса + 1 негативный)

**TC-4a: "Pin Item" (всегда)**
1. Найти любой элемент списка
2. Правый клик → Snapshot
3. Проверить наличие "Pin Item" в меню

**TC-4b: "Archive Item" при наличии тега `archivable`**
1. Найти/создать элемент с тегом `archivable` (способ зависит от source — прочту при находке конфига)
2. Правый клик → Snapshot
3. Проверить наличие "Archive Item"

**TC-4c: "Archive Item" отсутствует без тега `archivable`** (негативный, нужен для подтверждения условия видимости)
1. Элемент без тега → правый клик → Snapshot
2. Проверить **отсутствие** "Archive Item"

Все три TC нужны: DoD требует «условие видимости соответствует описанию» — это подтверждается только парой 4b+4c.

**Evidence каждого TC:** a11y assertion (item found / not found в Snapshot) + source `when`-clause (`file:line`).

---

### Препятствия и решения

| Ситуация | Решение |
|----------|---------|
| Source-of-truth не найден Grep'ом | Все TC → `BLOCKED: source-of-truth не обнаружен`; не пишу PASS по памяти |
| Title в source отличается от title в тикете | Фиксирую `OBSERVATION`: DoD содержит неточные имена; тестирую по source-имени, не по тикету |
| Sandbox не поднимается / MCP disconnect | → `knowledge/sandbox-advanced.md`; при повторном отказе → `BLOCKED` с описанием |
| Невозможно создать `archivable`-элемент | TC-4b → `BLOCKED: нет способа получить archivable-элемент без source-документации`; TC-4c выполняется независимо |
| Visually-annotated TC (не здесь) | Здесь нет визуальных критериев → скриншоты не обязательны, a11y assertion достаточен |

---

### Фиксация результатов

Записываю каждый TC сразу после выполнения (не в конце). Формат итога — `templates/test-session-report.md`. Дефекты — секции DEFECT внутри этого тикета, severity по `algorithms/bug-severity.md`. Новые тикеты не создаю.

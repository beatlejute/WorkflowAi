# Desktop-инструменты: Advanced

Редко используемые команды и паттерны Windows-MCP. Загружай при работе со Snapshot, MultiEdit, Registry, Process, или при необходимости установки/настройки.

## Установка Windows-MCP

**Требования:** Python 3.13+, UV package manager (`pip install uv`).

```json
// Claude Code (.mcp.json) — на Windows нужен враппер cmd /c
{ "mcpServers": { "windows-mcp": { "command": "cmd", "args": ["/c", "uvx", "windows-mcp"] } } }
```

## Управление приложениями

| Команда | Описание | Параметры |
|---------|----------|-----------|
| `app` | Запуск/resize/move/switch окон | `action`, `app_name`, размеры |
| `shell` | PowerShell-команды | `command: string` |

## Работа с данными

| Команда | Описание | Параметры |
|---------|----------|-----------|
| `clipboard` | Буфер обмена | `action: "read"/"set"`, `content` |
| `multi_select` | Множественный выбор | `coordinates: [[x,y], ...]`, `use_ctrl` |
| `multi_edit` | Ввод в несколько полей | `fields: [{x, y, text}, ...]` |

## Системные инструменты

| Команда | Описание | Параметры |
|---------|----------|-----------|
| `process` | Список/завершение процессов | `action: "list"/"terminate"`, `pid`/`name` |
| `notification` | Toast-уведомление | `title`, `message` |
| `registry` | Реестр Windows | `action: "read"/"write"/"delete"/"list"`, `path` |

## Accessibility Tree

Snapshot возвращает дерево UI Automation с:
- **ID элементов** — для точных кликов через `label: int`
- **Имена и роли** — Button, TreeItem, MenuItem
- **Координаты** — для click/type когда label недоступен
- **Состояния** — enabled/disabled, expanded/collapsed, checked/unchecked

## Batch-действия

Группируй 2-3 MCP-вызова перед проверочным Snapshot. Каждый цикл «действие → Wait → Snapshot» стоит ~30-40 сек.

```
# ❌ Click(tab) → Wait → Snapshot → Click(button) → Wait → Snapshot
# ✅ Click(tab) → Click(button) → Snapshot (проверка результата)
```

Промежуточный Snapshot — только если следующее действие зависит от координат, которых ещё нет.

## Проверка Developer Console (DevTools)

1. `Shortcut("Ctrl+Shift+I")` — открыть DevTools
2. Snapshot → прочитать **счётчик ошибок** в заголовке Console (`🔴 N errors`)
3. Если счётчик > 0 — прокрутить лог вверх, проверить каждую ошибку
4. Отличить ошибки расширения от системных (Chromium, телеметрия)
5. PASS только если ошибок расширения = 0

**Антипаттерн:** игнорировать счётчик «19 errors» в заголовке, увидев одну строку внизу.

## Window management

Если `Shortcut` не закрыл/переключил окно:
1. `App(action: "switch", app_name: "...")` — перефокусировка
2. Click по title bar — альтернативная перефокусировка
3. Click по X — для закрытия через Snapshot + координаты

**Не повторяй тот же Shortcut** — если не сработал первый раз, повтор не поможет.

## Ctrl+Click альтернативы

| Задача | Альтернатива |
|--------|-------------|
| Go to Definition | F12 |
| Open Link | Command Palette → `Open Link` |
| Открыть файл по пути | `Ctrl+P` → ввести путь → Enter |

**Если TC требует Ctrl+Click — отметь BLOCKED** с причиной «MCP не поддерживает модификаторы + Click».

## Советы

- **Артефакты — в `reports/`**, не в корень проекта
- **Верификация перед действием** — убедись через Snapshot что элемент существует, не полагайся на визуальную интерпретацию
- **`shortcut` для навигации** — Command Palette быстрее поиска кнопок мышью
- **`shell` для подготовки** — создание тестовых файлов, запуск приложений с параметрами

<!-- РАСШИРЕНИЕ: добавляй advanced-паттерны ниже -->

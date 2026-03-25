# Инструменты работы с desktop-приложениями

Справочник по инструментам и командам для тестирования desktop-приложений (VSCode, Electron-приложения и др.) через Windows-MCP.

## Windows-MCP — основной инструмент

Windows-MCP — MCP-сервер для управления Windows GUI через Accessibility Tree (UI Automation). Агент взаимодействует с элементами интерфейса напрямую через a11y-идентификаторы, без computer vision.

**Преимущества:**
- Быстрое и надёжное взаимодействие (0.2–0.9 сек на действие)
- Работает с любым Windows-приложением (VSCode, Electron, WPF, WinForms)
- Не требует vision-модели — использует Accessibility Tree
- Поддерживает мультимониторные конфигурации

### Установка

**Требования:** Python 3.13+, UV package manager

```bash
pip install uv
```

**Конфигурация MCP-клиента (Claude Desktop):**

```json
{
  "mcpServers": {
    "windows-mcp": {
      "command": "uvx",
      "args": ["windows-mcp"]
    }
  }
}
```

**Конфигурация для Claude Code (Windows):**

```json
{
  "mcpServers": {
    "windows-mcp": {
      "command": "cmd",
      "args": ["/c", "uvx", "windows-mcp"]
    }
  }
}
```

> **Важно:** На Windows для Claude Code необходим враппер `cmd /c` перед `uvx`, иначе будет ошибка "Connection closed".

### Захват состояния экрана

| Команда | Описание | Параметры | Когда использовать |
|---------|----------|-----------|-------------------|
| `screenshot` | Быстрый скриншот рабочего стола с позицией курсора и списком активных окон | `display: [0]` (опционально, индекс монитора) | По умолчанию первый вызов — когда нужен визуальный контекст |
| `snapshot` | Полный захват состояния: accessibility tree с ID интерактивных элементов, скроллируемые области, скриншот | `use_vision: bool`, `use_dom: bool`, `display: [0]` | Когда нужны ID элементов для кликов, анализ структуры UI |

**Разница:** `screenshot` — быстрый (только картинка), `snapshot` — полный (a11y tree + картинка). Начинай с `screenshot`, переключайся на `snapshot` когда нужны координаты элементов.

### Взаимодействие с элементами

| Команда | Описание | Параметры |
|---------|----------|-----------|
| `click` | Клик по координатам | `x: int`, `y: int` |
| `type` | Ввод текста в элемент | `text: string`, `clear: bool` (опционально — очистить перед вводом) |
| `scroll` | Прокрутка вертикально/горизонтально | `direction: "up"/"down"/"left"/"right"`, `amount: int`, координаты области (опционально) |
| `move` | Перемещение мыши / перетаскивание | `x: int`, `y: int`, `drag: bool` (опционально) |
| `shortcut` | Нажатие клавиатурных комбинаций | `key_combination: string` (например `"Ctrl+Shift+p"`, `"Alt+Tab"`) |
| `wait` | Пауза | `duration: float` (секунды) |

### Управление приложениями

| Команда | Описание | Параметры |
|---------|----------|-----------|
| `app` | Запуск, ресайз, перемещение, переключение окон | `action: "launch"/"resize"/"move"/"switch"`, `app_name: string`, размеры (опционально) |
| `shell` | Выполнение PowerShell-команд | `command: string` |

### Работа с данными

| Команда | Описание | Параметры |
|---------|----------|-----------|
| `clipboard` | Чтение/запись буфера обмена | `action: "read"/"set"`, `content: string` (для set) |
| `multi_select` | Множественный выбор элементов | `coordinates: [[x,y], ...]`, `use_ctrl: bool` |
| `multi_edit` | Ввод текста в несколько полей | `fields: [{x, y, text}, ...]` |
| `scrape` | Извлечение текста страницы/окна | — |

### Системные инструменты

| Команда | Описание | Параметры |
|---------|----------|-----------|
| `process` | Список процессов / завершение процесса | `action: "list"/"terminate"`, `pid: int` или `name: string` |
| `notification` | Windows toast-уведомление | `title: string`, `message: string` |
| `registry` | Работа с реестром Windows | `action: "read"/"write"/"delete"/"list"`, `path: string`, `value/data` |

## Паттерны тестирования desktop-приложений

### Запуск VSCode с расширением

```
1. shell → "code --extensionDevelopmentPath=d:/Dev/workflowAiVsCode"
2. wait → 5 (ожидание запуска)
3. screenshot → начальное состояние
4. Проверить: VSCode открылся? Расширение активировано?
```

### Открытие Command Palette и выполнение команды

```
1. snapshot → получить состояние окна VSCode
2. shortcut → "Ctrl+Shift+p" (открыть Command Palette)
3. wait → 0.5
4. type → "workflowAI: Show Pipeline" (набрать команду)
5. wait → 0.3
6. shortcut → "Enter" (выполнить)
7. screenshot → зафиксировать результат
```

### Проверка TreeView расширения

```
1. snapshot → получить a11y tree (найти TreeView в sidebar)
2. click → координаты иконки расширения в Activity Bar
3. wait → 0.5
4. snapshot → получить элементы TreeView
5. click → координаты элемента в TreeView
6. screenshot → зафиксировать состояние
7. Проверить: элементы отображаются? Данные корректны?
```

### Проверка StatusBar

```
1. snapshot → получить a11y tree
2. Найти StatusBar-элемент расширения по тексту
3. click → координаты StatusBar-элемента
4. screenshot → зафиксировать реакцию
5. Проверить: подсказка корректна? Клик вызывает нужное действие?
```

### Проверка Output Channel

```
1. shortcut → "Ctrl+Shift+u" (открыть Output panel)
2. wait → 0.5
3. snapshot → получить содержимое панели
4. Найти dropdown выбора канала, кликнуть по нему
5. type → "WorkflowAI" (выбрать канал расширения)
6. screenshot → зафиксировать логи
7. Проверить: логи присутствуют? Нет ошибок?
```

### Проверка уведомлений (notifications)

```
1. Выполнить действие, вызывающее уведомление
2. wait → 1
3. screenshot → зафиксировать уведомление
4. Проверить: уведомление появилось? Текст корректен?
5. shortcut → "Escape" (закрыть уведомление)
```

### Проверка WebView панели расширения

```
1. Открыть WebView через Command Palette или TreeView
2. wait → 1
3. snapshot → use_dom: true (извлечь DOM WebView)
4. screenshot → визуальное состояние
5. Проверить: контент загружен? Стили корректны?
```

## Работа с Accessibility Tree

Windows-MCP использует Windows UI Automation для доступа к элементам интерфейса. `snapshot` возвращает дерево с:
- **ID элементов** — для точных кликов
- **Имена и роли** — для идентификации элементов (Button, TreeItem, MenuItem)
- **Координаты** — для click/type
- **Состояния** — enabled/disabled, expanded/collapsed, checked/unchecked

### Типичные элементы VSCode в a11y tree

| Элемент VSCode | Роль в a11y tree | Как найти |
|---------------|-----------------|-----------|
| Command Palette | ComboBox / List | После `Ctrl+Shift+p` |
| Activity Bar | ToolBar | Левая панель с иконками |
| Sidebar (Explorer/Extensions) | Tree / TreeItem | После клика на Activity Bar |
| Editor tabs | TabItem | Верхняя область редактора |
| StatusBar items | Button / Text | Нижняя полоса окна |
| Notifications | Group / Button | Правый нижний угол |
| Output panel | Text / Document | Нижняя панель |

## Советы

- **Начинай с `screenshot`** — для быстрого визуального контекста, переходи на `snapshot` когда нужны координаты
- **`snapshot` перед `click`** — чтобы получить точные координаты целевого элемента
- **`wait` после действий** — VSCode может обновлять UI асинхронно (0.3-1 сек)
- **`shortcut` для навигации** — Command Palette (`Ctrl+Shift+p`) быстрее и надёжнее, чем поиск кнопок мышью
- **`shell` для подготовки** — создание тестовых файлов, запуск VSCode с параметрами
- **Проверяй Output Channel** — расширения логируют ошибки туда, а не в console
- **Мультимонитор** — используй `display: [0]` или `display: [1]` для выбора монитора

## Ограничения

- Выделение текста внутри параграфа ограничено (a11y tree не всегда гранулярен до символа)
- Windows-язык должен быть English для корректной работы `app` (launch)
- Латентность 0.2–0.9 сек на действие — учитывай при планировании тайминга `wait`

<!-- РАСШИРЕНИЕ: добавляй новые инструменты и паттерны тестирования desktop-приложений ниже -->

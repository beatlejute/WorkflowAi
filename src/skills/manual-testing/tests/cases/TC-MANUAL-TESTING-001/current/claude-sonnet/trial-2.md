Согласно правилам скила:

**Инструмент:** Windows-MCP
**Среда:** Windows Sandbox (обязательно)

Обоснование из таблицы выбора инструмента:

| Тип | Инструмент | Knowledge |
|-----|-----------|-----------|
| Desktop (VSCode-расширение, Electron, нативное) | Windows-MCP **через Sandbox** | `knowledge/desktop-tools-core.md` + `knowledge/sandbox-core.md` |

**Почему Sandbox, а не хост-машина:**

> ⛔ Desktop-приложения тестируются ТОЛЬКО через Sandbox. Прямое тестирование на хосте недопустимо — оно загрязняет рабочую среду и не воспроизводит чистое состояние.

**Первые шаги перед тестированием:**

1. Проверить наличие `../shared/README.md` — если есть, прочитать и загрузить проектные модули
2. Загрузить `knowledge/sandbox-core.md` — настройка Sandbox, персистенция evidence
3. Загрузить `knowledge/desktop-tools-core.md` — команды Windows-MCP, паттерны навигации
4. Выбрать workflow по типу тикета (smoke / regression / acceptance и т.д.)

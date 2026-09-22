По таблице маршрутизации из скила:

**Инструмент:** Windows-MCP  
**Среда:** Windows Sandbox (⛔ прямой запуск на хосте — загрязняет рабочую среду)

**Шаги стратегии:**

1. Загрузить `knowledge/desktop-tools.md` + `knowledge/sandbox-core.md` (обязательно для desktop)
2. Поднять Sandbox через `.wsb`-конфиг с MCP-сервером внутри
3. Установить VSCode + расширение в Sandbox
4. Тестировать через Windows-MCP: label-навигация, Snapshot для a11y tree, DevTools для логов
5. Evidence — a11y tree assertions; скриншоты только если DoD требует или TC визуальный
6. Персистенция evidence — копировать из Sandbox до завершения сессии (файлы внутри эфемерны)

**Ключевые ограничения VSCode-расширений:** MCP-browser не работает для desktop-хоста VSCode. Playwright — не вариант. Только Windows-MCP.

Если тип тикета не определён — классифицировать по описанию и загрузить соответствующий workflow (`smoke.md` / `regression.md` / `acceptance.md`).

Desktop-приложение → Windows-MCP через **Windows Sandbox** (изолированная среда).

**Инструмент:** Windows-MCP (UI Automation / label-навигация)
**Среда:** Windows Sandbox — обязательно, прямое тестирование на хосте запрещено (загрязняет рабочую среду, не воспроизводит чистое состояние)

**Следующие шаги:**
1. Загрузить `knowledge/sandbox-core.md` — настройка Sandbox, quick-start, персистенция evidence
2. Загрузить `knowledge/desktop-tools.md` — команды Windows-MCP, label-навигация, Snapshot budget, DevTools, ограничения
3. Определить тип тикета (smoke / regression / acceptance / exploratory) → загрузить соответствующий workflow
4. Прочитать `context.notes` в frontmatter тикета — бюджет MCP-вызовов, особые указания

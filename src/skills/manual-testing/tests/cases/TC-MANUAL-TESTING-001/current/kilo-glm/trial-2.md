**Инструмент:** Windows-MCP (команды навигации, кликов, Snapshot/a11y tree) **через Windows Sandbox**.

**Обоснование:**

1. **VSCode-расширение = desktop-приложение** → согласно таблице выбора инструмента, основной инструмент — Windows-MCP через Sandbox, knowledge-модули: `knowledge/desktop-tools-core.md` + `knowledge/sandbox-core.md`.

2. **Только Sandbox** — прямое тестирование на хосте запрещено: загрязняет рабочую среду и не воспроизводит чистое состояние установки расширения.

3. **Порядок действий:**
   - Загрузить `../shared/README.md` → проектные правила, тестовые workspace'ы
   - Загрузить `knowledge/sandbox-core.md` → настройка Sandbox, evidence persistence
   - Загрузить `knowledge/desktop-tools-core.md` → команды Windows-MCP, паттерны навигации по VSCode
   - Настроить Sandbox с предустановленным VSCode + расширением
   - Выполнять тест-кейсы через Windows-MCP (запуск VSCode, навигация по UI, клики, ввод)
   - Evidence: a11y tree assertions через Snapshot, скриншоты для визуальных TC

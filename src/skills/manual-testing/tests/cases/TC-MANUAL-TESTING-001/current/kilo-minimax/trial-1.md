**Инструмент:** Windows-MCP  
**Среда:** Windows Sandbox (обязательно — изолированная среда, не хост)  
**Knowledge-модули к загрузке:** `knowledge/desktop-tools-core.md`, `knowledge/desktop-tools-advanced.md`, `knowledge/sandbox-core.md`

VSCode-расширение — desktop-приложение, поэтому Playwright MCP не подходит. Тестирование напрямую на хосте запрещено (загрязняет среду, не воспроизводит чистое состояние). Обязательный первый шаг — прочитать `../shared/README.md` для получения путей, конфигурации и ограничений проекта.

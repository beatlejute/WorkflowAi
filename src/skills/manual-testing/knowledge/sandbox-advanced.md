# Тестирование в Windows Sandbox — Advanced

Расширенные сценарии: настройка .wsb, паттерны тестирования, MCP disconnect, управление контекстом. Базовые знания → `knowledge/sandbox-core.md`.

## Конфигурация .wsb файла

```xml
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder><!-- путь к проекту --></HostFolder>
      <SandboxFolder><!-- путь в Sandbox --></SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>Enable</Networking>
  <vGPU>Enable</vGPU>
  <ClipboardRedirection>Enable</ClipboardRedirection>
  <LogonCommand><Command><!-- путь к setup.cmd --></Command></LogonCommand>
</Configuration>
```

Пути — см. `knowledge/sandbox-core.md` → «Архитектура». Офлайн-пакет содержит портативные Python, Node.js и wheels для `windows-mcp`. Копируй Python на `C:\sandbox\` (mapped folders могут быть read-only для pip).

**Установка windows-mcp:** Python 3.13+ + UV package manager (`pip install uv`).
`.mcp.json` (Windows, враппер `cmd /c`): `{ "mcpServers": { "windows-mcp": { "command": "cmd", "args": ["/c", "uvx", "windows-mcp"] } } }`.

## Паттерны тестирования

**Полный цикл:** Sandbox → LogonCommand → MCP подключение → запуск приложения → тест-кейсы → evidence в mapped folder → закрытие.

**Сравнение окружений:** один и тот же TC на хосте и в Sandbox — расхождения указывают на зависимость от окружения.

**Регрессия двух версий:** Sandbox 1 (текущая) → скриншоты → закрыть → Sandbox 2 (новая) → те же TC → сравнить.

## MCP disconnect

### Sandbox закрылся

1. Немедленно зафиксируй результаты в тикет
2. Не пытайся переподключиться — Sandbox закрыт
3. Evidence на хосте сохранены (mapped folder пишет на диск хоста)

### MCP-прокси умер, Sandbox жив

MCP-инструменты возвращают «server not connected», но окно Sandbox видно. **Не реализуй HTTP-клиент** — это rabbit hole.

1. Зафиксируй выполненные TC
2. Пометь оставшиеся TC как BLOCKED: «MCP proxy disconnected»
3. Завершай тикет — следующая сессия продолжит

2+ disconnect за сессию → экономный режим (→ `algorithms/mcp-budget.md` → «Экономный режим»).

## Управление контекстом и continuation

Планирование continuation и приоритизация TC по длительности — `algorithms/mcp-budget.md` → «Планирование continuation».

### Признаки context overflow

- Контекст >70% заполнен — завершай текущий TC
- 6+ Snapshot за сессию — переключись на Screenshot
- Модель «забывает» ранние TC — немедленно фиксируй прогресс

### Действия при overflow

1. Завершай текущий TC (статус — из канонического списка SKILL.md → «Формат вывода»)
2. Запиши результаты, evidence paths, оставшиеся TC
3. Заверши сессию — не пытайся «успеть ещё один TC»

### Антипаттерн: ожидание смены UI-состояния

Не трать MCP-вызовы на цикл `Wait → Screenshot → «не сменилось»` (❌ `Wait(5) → Screenshot → "ещё Completed" → Wait(8) → Screenshot`). Запускай действие сразу: ✅ `Shortcut(ctrl+shift+p) → Type("<команда>") → Snapshot`.

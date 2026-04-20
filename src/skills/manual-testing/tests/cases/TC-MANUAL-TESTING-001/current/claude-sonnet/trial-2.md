Нет директории `shared/` в этой тестовой среде — это ожидаемо для данного тест-кейса. Отвечаю на вопрос о стратегии тестирования на основе загруженных knowledge-модулей.

---

## Стратегия тестирования VSCode-расширения

### Выбор среды и инструмента

**VSCode-расширение — desktop-приложение.**

Согласно таблице выбора инструмента из SKILL.md:

| Тип приложения | Инструмент | Knowledge |
|----------------|-----------|-----------|
| Desktop-приложение (VSCode-расширение) | Windows-MCP **через Sandbox** | `desktop-tools-core.md` + `sandbox-core.md` |

**⛔ Тестирование напрямую на хост-машине — ЗАПРЕЩЕНО.**

Причины:
- Загрязняет рабочую среду разработчика (конфиги, состояние расширений, workspace)
- Не воспроизводит чистое состояние (первый запуск, свежая установка)
- Не изолировано — побочные эффекты от других расширений и настроек хоста

### Выбранная стратегия

**Среда:** Windows Sandbox — изолированное, эфемерное окружение. При каждом запуске чистое состояние.

**Инструмент:** `mcp__sandbox-desktop__*` (сервер `sandbox-desktop`)

**Команды:**
- `mcp__sandbox-desktop__screenshot` — быстрая проверка состояния UI
- `mcp__sandbox-desktop__snapshot` — a11y tree для верификации элементов (с бюджетом: 1-2 Snapshot/TC, макс. 6/сессию)
- `mcp__sandbox-desktop__click`, `type`, `shortcut` — взаимодействие с UI
- `mcp__sandbox-desktop__PowerShell` — подготовка окружения, сохранение evidence

### Quick-start checklist перед тест-кейсами

```
1. Screenshot → MCP работает, Sandbox активен
2. PowerShell → Test-Path "<path-to-portable-vscode>"
3. PowerShell → Test-Path "<path-to-test-workspace>"
4. → Запускай VSCode и тест-кейсы
```

**Hard gate:** если к 5-му MCP-вызову не начат первый TC — СТОП, пересмотреть план.

### Персистенция evidence

Sandbox эфемерен. Скриншоты сохраняются на хост через mapped folder:

```powershell
# В PowerShell внутри Sandbox:
$bmp.Save('<sandbox-project-path>\reports\QA-NNN-screenshot-TC-NNN.png')
```

После сохранения — проверка на хосте: `ls reports/*.png`.

### Итог

| Параметр | Значение |
|----------|---------|
| **Среда** | Windows Sandbox (изолированная, НЕ хост) |
| **MCP-сервер** | `sandbox-desktop` |
| **Тип проверок** | a11y tree assertions (Snapshot) + скриншоты для визуальных TC |
| **Тестирование на хосте** | ⛔ ЗАПРЕЩЕНО |

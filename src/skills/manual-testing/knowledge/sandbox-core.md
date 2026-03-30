# Тестирование в Windows Sandbox — Core

Справочник по тестированию desktop-приложений в изолированном окружении Windows Sandbox.

## Архитектура

```
┌─────────────────────┐         ┌──────────────────────────┐
│  Хост (Claude Code)  │  HTTP   │  Windows Sandbox          │
│  MCP Client           │◄──────►│  windows-mcp (HTTP :8000) │
│  (sandbox-desktop)    │        │  ↓ управляет UI            │
└─────────────────────┘         └──────────────────────────┘
```

Инструменты: `mcp__sandbox-desktop__*` (screenshot, click, type, snapshot и т.д.). Подключение — `.mcp.json` → `"url": "http://<sandbox-ip>:8000/mcp"`. Пути и конфигурация .wsb — см. `CLAUDE.md` проекта. Расширенная настройка .wsb → `knowledge/sandbox-advanced.md`.

## Quick-start checklist

Минимальный набор проверок перед тест-кейсами (3-4 MCP-вызова):

```
1. Screenshot → MCP работает, Sandbox активен
2. PowerShell → Test-Path "<path-to-portable-vscode>"
3. PowerShell → Test-Path "<path-to-test-workspace>"
4. → Запускай VSCode и тест-кейсы
```

**⛔ Hard gate:** если к 5-му MCP-вызову не начал первый TC — СТОП, пересмотри план.

**Антипаттерны:**
- 10+ MCP-вызовов на разведку (`Get-ChildItem`, `Test-Path`, `echo test`) до первого TC
- Установка/запуск продукта из CLI вместо UI — тестирует другой code path
- Перезапись конфигов без проверки существующих
- **BOM-кодировка:** PowerShell 5.x `Set-Content -Encoding utf8` пишет с BOM. Используй `[System.IO.File]::WriteAllText($path, $content)` или `-Encoding utf8NoBOM` (PS 7+)
- **Backslash в JSON:** используй `ConvertTo-Json` для hashtable, не собирай JSON строками
- **Parent directory traversal:** приложения ищут конфиг в parent dirs. Для теста «нет конфига» нужен workspace вне дерева проекта. Если невозможно за 3-5 вызовов — TC = BLOCKED

## Персистенция evidence

**Sandbox эфемерен — всё удаляется при закрытии.** Сохраняй evidence на хост.

### ReadOnly: false (рекомендуемый)

Сохраняй скриншоты напрямую в `reports/` — они пишутся на хост (1 MCP-вызов):

```
PowerShell → "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$b.Size); $bmp.Save('<sandbox-project-path>\reports\TICKET-ID-screenshot-TC-NNN.png'); $g.Dispose(); $bmp.Dispose()"
```

### ReadOnly: true (fallback — 2 MCP-вызова)

Бинарная запись в ReadOnly mapped folder заблокирована. Сохрани в writable folder внутри Sandbox, затем скопируй на хост через Bash.

### Self-check

После сохранения **проверь на хосте** (не в Sandbox): `ls reports/*.png`. Если 0 файлов — evidence потеряны.

## Ключевые ограничения

| Ограничение | Обходной путь |
|------------|---------------|
| Одноразовость | Сохранять через mapped folders (ReadOnly: false) |
| Один экземпляр | Последовательное тестирование |
| FileSystem events не пробрасываются | TC с FileWatcher → BLOCKED |
| Латентность MCP 3-10 сек | `Wait` обычно не нужен |

Расширенные сценарии (MCP disconnect, continuation, .wsb конфигурация) → `knowledge/sandbox-advanced.md`.

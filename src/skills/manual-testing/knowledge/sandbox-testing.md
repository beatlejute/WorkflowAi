# Тестирование в изолированной среде (Windows Sandbox)

Справочник по тестированию desktop-приложений в изолированном окружении Windows Sandbox — без влияния на рабочую среду хоста.

## Зачем нужна изоляция

| Сценарий | Почему Sandbox |
|----------|---------------|
| Тестирование расширений VSCode | Чистая установка VSCode без существующих настроек/расширений |
| Проверка установщиков | Установка не засоряет рабочую машину |
| Деструктивные тесты | Можно ломать что угодно — Sandbox одноразовый |
| Воспроизведение багов окружения | Чистое окружение без "работает на моей машине" |
| Параллельное тестирование | Не мешает текущей работе на хосте |

## Подход: Windows-MCP внутри Sandbox (Streamable HTTP)

Запуск `windows-mcp` внутри Sandbox с сетевым транспортом для управления GUI Sandbox с хоста. Используется портативный Python и офлайн-wheels — **без скачивания из интернета**.

**Архитектура:**
```
┌─────────────────────┐         ┌──────────────────────────┐
│  Хост (Claude Code)  │  HTTP   │  Windows Sandbox          │
│                       │◄──────►│                            │
│  MCP Client           │ :8000  │  windows-mcp (HTTP)       │
│  (sandbox-desktop)    │        │  ↓ управляет UI            │
│                       │        │  Тестируемое приложение    │
└─────────────────────┘         └──────────────────────────┘
```

**Подключение с хоста (`.mcp.json`):**
```json
{
  "mcpServers": {
    "sandbox-desktop": {
      "url": "http://<sandbox-ip>:8000/mcp"
    }
  }
}
```

**Инструменты:** те же самые что в `windows-mcp` (`screenshot`, `click`, `type`, `snapshot` и т.д.), но вызываются через `mcp__sandbox-desktop__*`. См. `knowledge/desktop-tools.md` → секция «Выбор MCP-сервера».

> **IP-адрес Sandbox:** узнать через `ipconfig` внутри Sandbox или через скрипт автонастройки.

## Офлайн-пакет для Sandbox

Sandbox не имеет предустановленных Python/pip/winget. Интернет в Sandbox медленный. Поэтому используется **офлайн-пакет** с портативным Python и предскачанными wheels.

### Структура офлайн-пакета

```
tmp/sandbox/                      # Маппится на Desktop\sandbox-env в Sandbox
├── setup.cmd                     # Автозапуск: pip install + старт сервера
├── pylibs/                       # uv и другие Python-утилиты
└── tools/
    ├── python/                   # Python Embeddable (портативный, без установки)
    │   ├── python.exe
    │   ├── python313._pth        # import site раскомментирован
    │   ├── Lib/site-packages/    # pip предустановлен
    │   └── Scripts/              # windows-mcp.exe после pip install
    ├── node/                     # Node.js портативный
    │   ├── node.exe
    │   └── npm.cmd
    ├── wheels/                   # Все зависимости windows-mcp офлайн
    │   ├── windows_mcp-*.whl
    │   ├── fastmcp-*.whl
    │   └── ... (90+ wheels)
    └── workflow-ai-1.0.49.tgz   # workflow-ai npm-пакет
```

### setup.cmd (автозапуск)

```cmd
@echo off
set SHARED=C:\Users\WDAGUtilityAccount\Desktop\sandbox-env
set LOCAL=C:\sandbox
set PYTHON=%LOCAL%\python\python.exe
set WHEELS=%SHARED%\tools\wheels

echo [1/3] Copying Python to local drive...
xcopy "%SHARED%\tools\python" "%LOCAL%\python\" /E /I /Q /Y

echo [2/3] Installing windows-mcp from local wheels...
"%PYTHON%" -m pip install --no-index --find-links="%WHEELS%" --no-warn-script-location windows-mcp

echo [3/3] Starting windows-mcp server on port 8000...
"%LOCAL%\python\Scripts\windows-mcp.exe" --transport streamable-http --host 0.0.0.0 --port 8000
```

> **Почему xcopy:** mapped folders могут быть read-only, pip не сможет писать. Копируем Python на локальный диск Sandbox (`C:\sandbox\`), а wheels читаем из shared folder.

## Конфигурация .wsb файла

### Базовый шаблон

```xml
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>d:\Dev\workflowAiVsCode</HostFolder>
      <SandboxFolder>C:\Users\WDAGUtilityAccount\Desktop\workflowAiVsCode</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>d:\Dev\workflowAiVsCode\tmp\sandbox</HostFolder>
      <SandboxFolder>C:\Users\WDAGUtilityAccount\Desktop\sandbox-env</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>Enable</Networking>
  <vGPU>Enable</vGPU>
  <ClipboardRedirection>Enable</ClipboardRedirection>
  <LogonCommand>
    <Command>cmd /c "C:\Users\WDAGUtilityAccount\Desktop\sandbox-env\setup.cmd"</Command>
  </LogonCommand>
</Configuration>
```

### Параметры .wsb

| Параметр | Значение | Описание |
|----------|----------|----------|
| `Networking` | `Enable` / `Disable` | Сеть (Enable нужна для HTTP-подключения MCP с хоста) |
| `vGPU` | `Enable` / `Disable` | Виртуальный GPU для UI-рендеринга |
| `MappedFolders` | XML-блок | Папки хоста, доступные в Sandbox на Desktop |
| `ReadOnly` | `true` / `false` | Защита файлов хоста от записи |
| `ClipboardRedirection` | `Enable` | Общий буфер обмена хост↔Sandbox |
| `LogonCommand` | Путь к скрипту | Автоматический запуск при старте Sandbox |

## Quick-start checklist (перед тестированием)

Минимальный набор проверок перед началом тест-кейсов. **Не трать MCP-бюджет на полную разведку инфраструктуры** — достаточно 3-4 вызовов:

```
1. Screenshot → MCP работает, Sandbox активен (визуальный контекст)
2. PowerShell → Test-Path "<path-to-portable-vscode>" (VSCode доступен)
3. PowerShell → Test-Path "<path-to-test-workspace>" (тестовый workspace доступен)
4. → Переходи к запуску VSCode и тест-кейсам
```

**⛔ Hard gate:** если к 5-му MCP-вызову ты не запустил VSCode или не начал первый TC — **СТОП**. Пересмотри план. Ты тратишь бюджет на подготовку вместо тестирования.

**Антипаттерны:**
- 10+ MCP-вызовов на `Get-ChildItem`, `Test-Path`, `echo test > write-test.txt`, `Select-String` до первого тест-кейса. При бюджете 70-100 вызовов это 10-15% на разведку.
- **Установка/запуск продукта из CLI перед UI-тестированием.** Если тикет тестирует UI расширения (sidebar, StatusBar, горячие клавиши) — **не устанавливай и не запускай CLI-инструменты** (`workflow run`, `npm install` и т.д.). Pipeline запускается через UI расширения, а не через терминал. CLI-запуск тестирует другой код path и не подтверждает работоспособность UI.
- **Создание собственных конфигурационных файлов.** Не перезаписывай `pipeline.yaml` и другие конфиги без проверки — тестовый workspace может уже содержать подготовленные данные. Сначала проверь существующий конфиг, затем решай нужны ли изменения.

## Паттерны тестирования в Sandbox

### Полный цикл тестирования расширения VSCode

```
1. Запустить Sandbox с .wsb конфигом
2. Дождаться установки зависимостей (LogonCommand)
3. Подключиться к windows-mcp внутри Sandbox через streamable-http
4. shell → "code --extensionDevelopmentPath=C:\Users\WDAGUtilityAccount\Desktop\workflowAiVsCode d:\tmp"
5. screenshot → начальное состояние (латентность MCP достаточна для загрузки VSCode)
7. Выполнить тест-кейсы через windows-mcp (snapshot, click, type, shortcut)
8. Зафиксировать результаты (скриншоты сохраняются через mapped folder)
9. Закрыть Sandbox
```

### Сравнение "чистая установка" vs "рабочее окружение"

```
1. Выполнить тест-кейс на хосте (windows-mcp напрямую)
2. Выполнить тот же тест-кейс в Sandbox (windows-mcp через HTTP)
3. Сравнить результаты — расхождения указывают на зависимость от окружения
```

### Регрессионное тестирование двух версий

```
1. Sandbox 1: установить текущую версию расширения
2. Тестировать, сохранить скриншоты
3. Закрыть Sandbox (сброс)
4. Sandbox 2: установить новую версию расширения
5. Тестировать те же кейсы
6. Сравнить скриншоты и поведение
```

## Персистенция evidence из Sandbox

**⚠️ КРИТИЧЕСКИ ВАЖНО: Sandbox — эфемерная среда. Все файлы внутри Sandbox удаляются при закрытии.**

Если ты сохраняешь скриншоты или артефакты через `PowerShell` внутри Sandbox — они окажутся в файловой системе Sandbox (`C:\Users\WDAGUtilityAccount\...`), а **не на хосте**. При закрытии Sandbox всё будет потеряно.

### Как сохранять evidence на хост

| Способ | Описание | Когда использовать |
|--------|----------|-------------------|
| **Mapped folder (ReadOnly: false)** | Сохраняй файлы в mapped folder с `ReadOnly: false` — они записываются напрямую на диск хоста | Рекомендуемый способ. Настрой в .wsb: `<ReadOnly>false</ReadOnly>` для папки проекта |
| **FileSystem MCP** | Используй `FileSystem` MCP-инструмент для записи файлов на хост | Если mapped folder read-only |
| **Clipboard** | Скопируй содержимое через `clipboard` MCP и вставь на хосте | Для небольших текстовых данных |

### Паттерн сохранения скриншотов (ГОТОВЫЙ РЕЦЕПТ)

**Перед началом проверь `.wsb`** — как замаплен проект: `ReadOnly: true` или `false`.

#### Если проект замаплен с `ReadOnly: false` (РЕКОМЕНДУЕМАЯ конфигурация)

Сохраняй скриншоты **напрямую в `reports/`** внутри Sandbox — они записываются на диск хоста:

```
# 1 MCP-вызов — сохранить скриншот напрямую в reports/ (пишется на хост)
PowerShell → "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$b.Size); $bmp.Save('C:\Users\WDAGUtilityAccount\Desktop\workflowAiVsCode\reports\TICKET-ID-screenshot-TC-NNN.png'); $g.Dispose(); $bmp.Dispose()"
```

**Итого: 1 MCP-вызов на скриншот.** Файл сразу появляется на хосте.

#### Если проект замаплен с `ReadOnly: true` (fallback)

Бинарная запись (PNG через `Save()`, `File.Copy()`) в ReadOnly mapped folder **заблокирована** даже если `New-Item` и `Out-File` работают. Используй двухшаговый паттерн:

```
# Шаг 1: Внутри Sandbox — сохранить в writable mapped folder (sandbox-env)
PowerShell → "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$b.Size); $bmp.Save('C:\Users\WDAGUtilityAccount\Desktop\sandbox-env\TICKET-ID-screenshot-TC-NNN.png'); $g.Dispose(); $bmp.Dispose()"

# Шаг 2: На хосте — скопировать из sandbox-env в reports/
Bash → cp "<host-path-to-sandbox-env>/TICKET-ID-screenshot-TC-NNN.png" "<project-root>/reports/TICKET-ID-screenshot-TC-NNN.png"
```

**Итого: 2 MCP-вызова.** Не экспериментируй с другими способами — `Get-Acl`, retry `Save`, try/catch не помогут.

### Self-check: evidence на хосте

**⚠️ Конечный путь evidence — всегда `reports/` на хосте.** Self-check проверяет именно `reports/*.png`.

### Self-check: evidence на хосте

После сохранения evidence **обязательно проверь на хосте** (не в Sandbox):
```
# На хосте (через обычный Bash, НЕ через Sandbox MCP):
ls reports/*.png
```
Если 0 файлов — evidence потеряны. Пересохрани через Screenshot MCP + Write на хосте.

## Ограничения

| Ограничение | Описание | Обходной путь |
|------------|----------|---------------|
| Одноразовость | Всё удаляется при закрытии | Сохранять артефакты через mapped folders с `ReadOnly: false` |
| Время запуска | 30-60 сек на старт + установка зависимостей | Pre-built скрипты, портативные версии |
| Один экземпляр | Только один Sandbox одновременно | Последовательное тестирование |
| Windows 11 24H2+ | Sandbox MCP требует новую версию | Для старых версий — ручной запуск .wsb + скрипты |
| Производительность | UI может быть медленнее, чем на хосте | Латентность MCP (3-10 сек) компенсирует — `Wait` не нужен |

## Когда использовать Sandbox vs хост

| Критерий | Хост (напрямую) | Sandbox (изолированно) |
|----------|----------------|----------------------|
| Быстрый smoke-тест | Да | Нет (долгий setup) |
| Чистая установка | Нет | Да |
| Деструктивные тесты | Нет | Да |
| Тестирование установщика | Нет | Да |
| Регулярные регрессии | Да (быстрее) | Опционально |
| Воспроизведение бага окружения | Не всегда | Да |

## Стабильность MCP-соединения и Sandbox

**⚠️ Sandbox может закрыться в любой момент** — по таймауту, из-за нехватки ресурсов хоста, или при случайном закрытии окна. При закрытии Sandbox MCP-соединение (`sandbox-desktop`) обрывается без предупреждения.

### Приоритизация тест-кейсов по длительности

Планируй порядок TC с учётом риска disconnect:

| Фаза | Тип TC | Примеры | MCP-вызовов |
|------|--------|---------|-------------|
| **Сначала** | Быстрые проверки (Snapshot + визуальная верификация) | Idle-состояние, наличие UI-элементов, sidebar-секции | 2-3 на TC |
| **Затем** | Действие + немедленная проверка | Запуск → скриншот, клик → проверка результата | 4-6 на TC |
| **В конце** | Длительные TC с ожиданием | Stop Pipeline (запуск + ожидание 15-30с + действие), Clear History | 6-10 на TC |

**Правило:** чем дольше TC выполняется — тем выше риск что MCP отключится в процессе. Выполняй быстрые TC первыми, чтобы максимизировать покрытие за сессию.

### При MCP disconnect

1. **Немедленно зафиксируй результаты** — обнови тикет со всеми выполненными TC, пока контекст свежий
2. **Не пытайся переподключиться** в текущей сессии — Sandbox закрылся, MCP-сервер больше не работает
3. **Перечисли оставшиеся TC** в тикете для следующей сессии
4. **Evidence на хосте сохранены** — mapped folder (ReadOnly: false) пишет напрямую на диск хоста, закрытие Sandbox не удаляет их

### Антипаттерн: длительный TC в начале сессии

Не начинай с TC, который требует запуска pipeline → ожидания 30с → действия (Stop). Если MCP отключится в середине — потеряешь и этот TC, и все быстрые TC которые мог бы успеть выполнить.

### Антипаттерн: ожидание автоматической смены UI-состояния

Не трать MCP-вызовы на цикл `Wait → Screenshot → «ещё не сменилось» → Wait → Screenshot...` в ожидании перехода состояния (например, `Completed → Idle`). Если нужно повторить действие — запускай его сразу (Command Palette → команда), не дожидаясь промежуточного состояния. UI-команды работают в любом состоянии.

```
# ❌ ПЛОХО — 6 MCP-вызовов впустую
Wait(5) → Screenshot → "ещё Completed" → Wait(8) → Screenshot → "ещё Completed" → Snapshot

# ✅ ХОРОШО — сразу запустить повторно
Shortcut(ctrl+shift+p) → Type("WF: Run Pipeline") → Snapshot → ...
```

<!-- РАСШИРЕНИЕ: добавляй новые паттерны изолированного тестирования ниже -->

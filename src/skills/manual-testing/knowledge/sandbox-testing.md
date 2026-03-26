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
sandbox-env/                      # Маппится на Desktop Sandbox
├── setup.cmd                     # Автозапуск: pip install + старт сервера
└── tools/
    ├── python/                   # Python Embeddable (портативный, без установки)
    │   ├── python.exe
    │   ├── python313._pth        # import site раскомментирован
    │   ├── Lib/site-packages/    # pip предустановлен
    │   └── Scripts/              # windows-mcp.exe после pip install
    └── wheels/                   # Все зависимости windows-mcp офлайн
        ├── windows_mcp-*.whl
        ├── fastmcp-*.whl
        └── ... (90+ wheels)
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
      <HostFolder>path\to\project</HostFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>path\to\sandbox-env</HostFolder>
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

## Паттерны тестирования в Sandbox

### Полный цикл тестирования расширения VSCode

```
1. Запустить Sandbox с .wsb конфигом
2. Дождаться установки зависимостей (LogonCommand)
3. Подключиться к windows-mcp внутри Sandbox через streamable-http
4. shell → "code --extensionDevelopmentPath=C:\Users\WDAGUtilityAccount\Desktop\workflowAiVsCode d:\tmp"
5. wait → 10 (VSCode + расширение загружаются)
6. screenshot → начальное состояние
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

## Ограничения

| Ограничение | Описание | Обходной путь |
|------------|----------|---------------|
| Одноразовость | Всё удаляется при закрытии | Сохранять артефакты через mapped folders с `ReadOnly: false` |
| Время запуска | 30-60 сек на старт + установка зависимостей | Pre-built скрипты, портативные версии |
| Один экземпляр | Только один Sandbox одновременно | Последовательное тестирование |
| Windows 11 24H2+ | Sandbox MCP требует новую версию | Для старых версий — ручной запуск .wsb + скрипты |
| Производительность | UI может быть медленнее, чем на хосте | Увеличить `wait` между действиями |

## Когда использовать Sandbox vs хост

| Критерий | Хост (напрямую) | Sandbox (изолированно) |
|----------|----------------|----------------------|
| Быстрый smoke-тест | Да | Нет (долгий setup) |
| Чистая установка | Нет | Да |
| Деструктивные тесты | Нет | Да |
| Тестирование установщика | Нет | Да |
| Регулярные регрессии | Да (быстрее) | Опционально |
| Воспроизведение бага окружения | Не всегда | Да |

<!-- РАСШИРЕНИЕ: добавляй новые паттерны изолированного тестирования ниже -->

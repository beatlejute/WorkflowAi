# workflow-ai

Координатор воркфлоу для AI-агентов — конвейер на основе канбан-доски для AI-агентов, пишущих код.

Система координации AI-агентов через файловую канбан-доску. Автоматически оркестрирует выполнение задач: берёт тикеты из очереди, запускает нужного агента, проверяет результат и генерирует отчёты.

## Установка

```bash
npm install -g workflow-ai
```

## Быстрый старт

```bash
# 1. Инициализировать воркфлоу в вашем проекте
workflow init
```

```text
# 2. Открыть проект в AI-агенте (Claude Code, Kilo, и т.д.) и попросить создать план через скил:
Создай план <описание задачи> используя скил .workflow/src/skills/create-plan/SKILL.md
```

```bash
# 3. Запустить конвейер — он декомпозирует план на тикеты и начнёт исполнение
workflow run
```

## Команды

| Команда | Описание |
|---------|----------|
| `workflow init [path] [--force]` | Инициализировать директорию `.workflow/` со структурой канбан-доски |
| `workflow run [options]` | Запустить AI-конвейер |
| `workflow update [path]` | Обновить глобальную директорию и пересоздать junctions |
| `workflow eject <skill> [path]` | Извлечь скил (скопировать из глобальной директории в проект) |
| `workflow eject-scripts [path]` | Извлечь скрипты (скопировать из глобальной директории в проект) |
| `workflow eject-configs [path]` | Извлечь конфиги (скопировать из глобальной директории в проект) |
| `workflow list [path]` | Вывести список скилов со статусом (shared/ejected/project-only) |
| `workflow help` | Показать справку |
| `workflow version` | Показать версию |

### Опции команды `run`

| Опция | Описание |
|-------|----------|
| `--plan <plan>` | ID плана для выполнения |
| `--config <path>` | Путь к конфиг-файлу |
| `--project <path>` | Корень проекта (по умолчанию: автоопределение) |

## Инициализация

Команда `workflow init` создаёт структуру директории `.workflow/`:

```
.workflow/
├── config/                       # → junction на ~/.workflow/configs/ (eject для кастомизации)
├── plans/
│   ├── current/                  # Текущие планы разработки
│   ├── templates/                # Шаблоны планов с триггерами (повторяющиеся планы)
│   └── archive/                  # Архивные планы
├── tickets/
│   ├── backlog/                  # Ожидают условий
│   ├── ready/                    # Готовы к выполнению
│   ├── in-progress/              # В работе
│   ├── blocked/                  # Заблокированы зависимостями
│   ├── review/                   # Ожидают ревью
│   └── done/                     # Завершены
├── reports/                      # Сгенерированные отчёты
├── logs/                         # Логи выполнения конвейера
├── metrics/                      # Метрики производительности
├── templates/                    # Шаблоны тикетов/планов/отчётов
└── src/
    ├── skills/                   # Инструкции скилов (junctions на глобальные, по каждому скилу)
    └── scripts/                  # Скрипты автоматизации (junction на глобальные)
```

## Конвейер

Команда `workflow run` исполняет многоэтапный конвейер:

1. **pick-first-task** — выбрать тикет из очереди ready
2. **check-plan-templates** — проверить триггеры шаблонов планов, создать планы при срабатывании
3. **check-plan-decomposition** — проверить состояние декомпозиции/активации планов
4. **allocate-ticket-ids** — выделить стартовые ID для префиксов до декомпозиции
5. **decompose-plan** — разбить план на тикеты (при необходимости)
6. **check-atomicity-limit / verify-atomicity / increment-atomicity-counter** — проверить атомарность тикетов плана
7. **check-conditions** — проверить условия готовности тикета
8. **move-to-ready** — переместить тикеты из backlog в ready
9. **pick-next-task** — выбрать следующий тикет для выполнения
10. **move-to-in-progress** — начать выполнение
11. **check-relevance** — проверить, что тикет всё ещё актуален (на скриптах, без LLM)
12. **check-mcp** — проверить доступность MCP-зависимостей тикета
13. **execute-task** — выполнить работу через AI-агента
14. **move-to-review** — отправить на ревью
15. **verify-artifacts** — детерминированная проверка артефактов тикета
16. **review-result** — проверить результаты по Definition of Done
17. **increment-task-attempts** — учесть попытки повторов
18. **move-ticket** — переместить в done/blocked по результатам ревью
19. **create-report** — сгенерировать отчёт о выполнении
20. **analyze-report / decompose-gaps** — проанализировать результаты и итерировать
21. **complete-plan / increment-plan-iterations** — закрыть план или запустить следующую итерацию

### Типы стадий

#### `update-counter`
Встроенная стадия, инкрементирует счётчик и возвращает статус для перехода. Требует `counter` и опционально `max`. Возвращает `default` или `max_reached`.

#### `manual-gate`
Встроенная стадия для ручного одобрения. Создаёт файл `.workflow/approvals/{step_id}.json` со статусом `pending` и ждёт решения через polling (интервал по умолчанию 2000мс).

**Параметры:**
- `poll_interval_ms` — интервал опроса (опц., default 2000)
- `timeout_seconds` — таймаут в секундах (опц., default без таймаута)

**Требуемые goto:**
- `approved` — обязательный, переход при одобрении
- `rejected` — обязательный, переход при отклонении

**Опциональные goto:**
- `timeout` — при истечении таймаута
- `aborted` — при остановке runner'а (SIGTERM)

**Формат step_id:** `{ticket_id}_{stageId}_{attempt}` (например, `QA-12_manual-approve_0`)

**Approval-файл содержит:**
```json
{
  "step_id": "QA-12_manual-approve_0",
  "ticket_id": "QA-12",
  "stage_id": "manual-approve",
  "attempt": 0,
  "status": "pending",
  "created_at": "2026-04-28T12:34:56.789Z",
  "updated_at": "2026-04-28T12:34:56.789Z",
  "decided_by": null,
  "comment": null,
  "context_snapshot": { ... }
}
```

**Два способа одобрения:**
1. **Через MCP-клиент** (например `workflow-mcp`): tool `approve_step({step_id, decision, comment})` пишет в файл approval
2. **Прямая правка файла:** открыть `.workflow/approvals/{step_id}.json`, изменить `"status": "pending"` на `"approved"` или `"rejected"`, сохранить

**Важное:** `manual-gate` — **opt-in**. Если ваш pipeline не использует стадии `manual-gate`, поведение полностью идентично предыдущим версиям! Никаких breaking changes.

**Пример:**
```yaml
stages:
  manual-approve-deploy:
    type: manual-gate
    poll_interval_ms: 2000
    timeout_seconds: 86400
    goto:
      approved: continue-deploy
      rejected: rollback
      timeout: notify-stuck
      aborted: end
```

Агенты настраиваются в `configs/pipeline.yaml`.

## Скилы

Встроенные скилы для разных типов задач:

| Скил | Описание |
|------|----------|
| `analyze-report` | Анализ отчёта |
| `coach` | Управление и улучшение скилов |
| `create-plan` | Создание плана |
| `create-report` | Генерация отчёта |
| `decompose-gaps` | Декомпозиция пробелов |
| `decompose-plan` | Декомпозиция плана на тикеты |
| `deep-research` | Глубокий ресерч |
| `execute-task` | Выполнение задачи |
| `manual-testing` | UI-observability: ручное тестирование сценариев |
| `review-result` | Ревью результата по DoD |

Скилы хранятся глобально в `~/.workflow/skills/` и подключаются в проекты через junctions.

Используйте `workflow eject <skill>` для копирования скила в проект для кастомизации.

### Как работать с коучем

Коуч — мета-скил для создания и улучшения остальных скилов. Правки в `.workflow/src/skills/` делаются **только** через него.

```text
# Запрос к AI-агенту:
Загрузи коуча из .workflow/src/skills/coach/SKILL.md и <действие>
```

Варианты `<действия>`:

| Тип задачи | Пример запроса |
|------------|----------------|
| Создать новый скил | `создай скил <имя> для <назначение>` |
| Аудит существующего | `сделай аудит скила <имя>` |
| Анализ эффективности | `проанализируй результаты скила <имя> по завершённым тикетам` |
| Точечное улучшение | `улучши скил <имя>: <что именно>` |
| Ресерч практик | `найди лучшие практики для <тема> и обогати скил <имя>` |
| Ревью скила | `сделай ревью скила <имя>` |

Коуч сам определит тип задачи, загрузит нужный воркфлоу, внесёт правку, прогонит тест скила и запишет результат в `.workflow/coach-backlog.yaml`. Коммит делает пользователь.

## Регрессионные тесты скилов

Трёхуровневая система тестирования скилов для проверки качества AI-агентов.

### Три слоя тестирования

| Уровень | Название | Описание |
|---------|----------|----------|
| L0 | Static | Базовая проверка синтаксиса и структуры: YAML-валидация, проверка обязательных полей, линтер |
| L1 | Deterministic | Детерминированные тесты: эталонные входные данные → ожидаемый результат (strict match) |
| L2 | Rubric | Гибкая оценка по критериям: scorer выставляет баллы на основе качества результата |

### Структура директорий

```
src/skills/<name>/tests/
├── index.yaml      # Метаданные тестов, список test cases
├── cases/          # Входные данные для тестов
│   └── <case-id>/
│       └── input.yaml
├── fixtures/       # Ожидаемые выходные данные (для L1)
│   └── <case-id>/
│       └── expected.yaml
└── rubrics/        # Критерии оценки (для L2)
    └── <case-id>/
        └── rubric.yaml
```

### Запуск тестов

```bash
npm run test:skills
```

### CLI-флаги

| Флаг | Описание |
|------|----------|
| `--skill <name>` | Запустить тесты только для указанного скила |
| `--relevant` | Запустить только тесты, соответствующие изменённым файлам |
| `--establish-baseline` | Запустить тесты и сохранить результаты как baseline |
| `--baseline-ref <ref>` | Использовать конкретный baseline (коммит, тег) |
| `--yes` | Автоматически подтверждать все действия |

### Режимы вердикта

| Режим | Описание |
|-------|----------|
| `no-baseline` | Первый запуск — результаты сохраняются как baseline без сравнения |
| `no-regression` | Сравнение с baseline — тест считается пройденным, если результат не хуже baseline |

### Принцип git write

Runner и коуч **не выполняют git write-операций**. Все изменения в кодовой базе делает исключительно пользователь. Runner только анализирует и рекомендует, но не коммитит.

### Первый запуск на новом проекте

1. Запустить тесты с флагом `--establish-baseline`
2. Проверить результаты: красные тесты — ожидаемы для нового проекта
3. Зафиксировать baseline: `git commit current/` как baseline-коммит

## Скрипты

Скрипты хранятся глобально в `~/.workflow/scripts/` и подключаются одним junction в `.workflow/src/scripts/`.

Используйте `workflow eject-scripts` для копирования скриптов в проект для кастомизации.

## Конфиги

Конфиги хранятся глобально в `~/.workflow/configs/` и подключаются одним junction в `.workflow/config/`.

Используйте `workflow eject-configs` для копирования конфигов в проект для кастомизации.

## Шаблоны планов

Шаблоны планов позволяют автоматически создавать повторяющиеся планы. Шаблоны лежат в `.workflow/plans/templates/` и содержат условия триггеров во frontmatter.

### Формат шаблона

```yaml
id: "TMPL-001"
title: "Daily manual testing"
type: template
trigger:
  type: daily          # daily | weekly | date_after | interval_days
  params: {}           # параметры, зависящие от типа
last_triggered: ""     # обновляется автоматически при срабатывании
enabled: true
```

### Типы триггеров

| Тип | Параметры | Описание |
|-----|-----------|----------|
| `daily` | — | Раз в день |
| `weekly` | `days_of_week: [1,3,5]` (0=вс) | В указанные дни недели |
| `date_after` | `date: "2026-04-01"` | Один раз после указанной даты |
| `interval_days` | `days: 3` | Каждые N дней |

При срабатывании триггера конвейер создаёт план в `plans/current/` со статусом `approved`, далее идёт обычный поток декомпозиции.

## Типы задач

| Тип | Префикс | Описание |
|-----|---------|----------|
| `arch` | ARCH | Архитектура и планирование |
| `impl` | IMPL | Реализация кода |
| `fix` | FIX | Исправления ошибок |
| `review` | REVIEW | Ревью кода/документации |
| `docs` | DOCS | Документация |
| `admin` | ADMIN | Административные задачи |

## Fallback агентов и правила здоровья

Система включает механизм in-stage fallback и health-мониторинг агентов.

### Механика fallback

Когда агент падает во время выполнения задачи, система использует **artifact-snapshot** для принятия решения:
- Если snapshot пустой (нет записанных файлов) → выполняется fallback на следующего агента
- Если snapshot непустой (есть изменения) → задача переходит в состояние `goto.error`

**Пример сценария:** Qwen превысил quota и упал без записи файлов → Kilo вызван в той же попытке, task_attempts не инкрементирован.

Конфигурация snapshot:
```yaml
execution:
  artifact_snapshot_enabled: false  # по умолчанию выключено
  snapshot_paths: ["src/", "configs/"]  # что мониторить
  snapshot_max_file_size: 524288  # файлы >512KB — только mtime+size
```

**Baseline производительности:** `p50=169ms p95=299ms files=598` (из QA-20 benchmark).

### Классификатор ошибок и health-реестр

Ошибки классифицируются по классам:
- `unavailable` — агент временно недоступен (quota, rate limit)
- `transient` — временная ошибка сети (timeout, 5xx)
- `misconfigured` — ошибка конфигурации (401, 403, отсутствует API key)
- `unmatched` — ошибка не распознана

**Семантика TTL:**
- `5m` — 5 минут
- `1h` — 1 час
- `until_utc_midnight` — до полуночи UTC (минимум 30 минут)
- `infinite` — навсегда

Файл конфигурации: `configs/agent-health-rules.yaml`. Файл состояния: `.workflow/state/agent-health.json`.

### Команда сброса

```bash
# показать текущее состояние
node .workflow/src/scripts/reset-agent-health.js

# сбросить конкретного агента
node .workflow/src/scripts/reset-agent-health.js --agent qwen-code

# сбросить всех агентов
node .workflow/src/scripts/reset-agent-health.js --all
```

### Пример добавления правила

```yaml
# В configs/agent-health-rules.yaml:
agents:
  my-new-agent:
    rules:
      - id: "my-agent-quota"
        class: "unavailable"
        ttl: "until_utc_midnight"
        pattern: "quota exceeded|daily limit reached"
        exit_codes: "any"
```

## Конфигурация

### `configs/config.yaml`

Основная конфигурация воркфлоу: информация о проекте, типы задач, приоритеты, статусы, типы условий, пути, настройки отчётности.

### `configs/pipeline.yaml`

Определение конвейера: агенты, стадии, управление потоком, goto-логика, стратегии повторов.

#### `manual-gate` stage

`type: manual-gate` — встроенный тип стадии для ручного одобрения. Создаёт файл `.workflow/approvals/{step_id}.json` со статусом `pending` и ждёт решения через polling.

**Поля:**
- `type: manual-gate` — обязательное, идентификатор типа стадии
- `poll_interval_ms` — опциональное, интервал опроса в мс (default: 2000, минимум: 100)
- `timeout_seconds` — опциональное, таймаут в секундах (default: null — без таймаута)
- `goto.approved` — обязательное, следующая стадия при одобрении
- `goto.rejected` — обязательное, следующая стадия при отклонении
- `goto.timeout` — опциональное, следующая стадия при истечении таймаута
- `goto.aborted` — опциональное, следующая стадия при остановке runner'а (SIGTERM)

**Пример:**
```yaml
stages:
  manual-approve-deploy:
    type: manual-gate
    poll_interval_ms: 2000
    timeout_seconds: 86400
    goto:
      approved: continue-deploy
      rejected: rollback
      timeout: notify-stuck
      aborted: end
```

**Два способа одобрения:**
1. **Через MCP-клиент** (например `workflow-mcp`): tool `approve_step({step_id, decision, comment})` пишет в файл approval. Опционально — пользователю не обязал подключать MCP.
2. **Прямая правка файла:** открыть `.workflow/approvals/{step_id}.json`, изменить `"status": "pending"` на `"approved"` или `"rejected"`, сохранить. **Базовый способ, работающий без какой-либо внешней инфраструктуры** — достаточно текстового редактора.

**Важное:** `manual-gate` — **opt-in**. Если ваш pipeline не использует стадии `manual-gate`, поведение полностью идентично предыдущим версиям! Никаких breaking changes.

**Формат approval-файла:**
```json
{
  "step_id": "QA-12_manual-approve_0",
  "ticket_id": "QA-12",
  "stage_id": "manual-approve",
  "attempt": 0,
  "status": "pending",
  "created_at": "2026-04-28T12:34:56.789Z",
  "updated_at": "2026-04-28T12:34:56.789Z",
  "decided_by": null,
  "comment": null,
  "context_snapshot": { ... }
}
```

### `configs/ticket-movement-rules.yaml`

Правила автоматического перемещения тикетов на основе статуса ревью.

## Структура проекта

```
workflow-ai/
├── bin/                    # Точка входа CLI
├── src/
│   ├── cli.mjs             # Парсинг команд
│   ├── runner.mjs           # Оркестратор конвейера
│   ├── init.mjs             # Инициализация проекта
│   ├── global-dir.mjs       # Управление глобальной ~/.workflow/
│   ├── junction-manager.mjs # Управление junction/symlink
│   ├── wf-loader.mjs        # Загрузчик конфигов
│   ├── lib/                 # Библиотеки утилит
│   └── tests/               # Набор тестов
├── configs/                # Файлы конфигурации (источник)
├── templates/              # Шаблоны воркфлоу (источник)
├── agent-templates/        # Шаблоны инструкций для AI-агентов
└── package.json
```

## Требования

- Node.js >= 18.0.0
- npm

## Лицензия

MIT

## [Unreleased]

### Added
- **Безынструментные агенты (`kind: http`).** Модель, которая не пользуется инструментами, подключается записью в `pipeline.agents`, без правок кода: `kind: http`, `protocol` (`chat` или `decisions`), `url` (`https://`; `http://` — только localhost, 127.0.0.1, ::1), `model`, `auth` (`{ env: <ИМЯ> }` или `{ kilo_oauth: true }`), `timeout_s` (на одну попытку). Протокол `chat` — формат OpenAI chat completions без `tools`, с изображениями (PNG, JPEG, WebP; до 5 МБ, до 8 на запрос); `decisions` — типизированная оценка OpenRouter. Общий клиент — `src/lib/model-client.mjs`: ключ только из переменной окружения или токена kilo (на Windows имя переменной — без учёта регистра), прокси из `HTTPS_PROXY` и соседних переменных (туннель CONNECT), до двух повторов на 429/500/502/503 и сетевую ошибку, прерывание через `AbortSignal`, классы ошибок `no_key`, `auth`, `rate_limit`, `server`, `timeout`, `network`, `bad_request`, `bad_response`, `aborted`.
- **Слой оценки** (`src/lib/model-evaluate.mjs`): вопросы с уровнями на входе, уровень 1..n по каждому вопросу на выходе — одинаково для обоих протоколов.
- **Обмен стадии с моделью (`model_io`).** Стадия с `model_io: { prepare, apply, options }` исполняется агентом `kind: http` в три шага: скрипт prepare собирает вопросы, раннер спрашивает модель через слой оценки и пишет ответ в `.workflow/state/model-io/<стадия>-<run_id>-<id вызова>.json`, скрипт apply выдаёт статус стадии. Ошибка модели — `status: error` с `error_class` (нарушение контракта prepare — `bad_prepare`), в истории работы тикета — `error`; остановка пайплайна снимает запрос к модели и не запускает apply (`aborted`); `auth`, `rate_limit`, `server`, `timeout`, `network` помечают агента в health-реестре и передают стадию следующему агенту. В лог пишется строка `MODEL_IO` с моделью, длительностью шагов и `cost_usd`. Модель стадии выбирается по `required_capabilities`: для изображений — агент с `multimodal`.
- **Защита от ошибочного назначения.** Проверка конфига при старте отклоняет агента `kind: http` в стадии без `model_io` (`agent`, `agents`, `agents_by_type`) и в `default_agents`/`default_agent`, а также неполную или противоречивую запись агента и `model_io` со ссылкой на несуществующий скрипт. Тесты скилов не берут такого агента исполнителем (`target_agents`, `--agent`); судьёй он допустим.
- **Причина ошибки в выводе тестов скилов.** `run-skill-tests.js` со `status: error` печатает строку `error: …`.

### Fixed
- **Остановка пайплайна передавала стадию следующему агенту.** Агент, убитый по SIGINT/SIGTERM, выглядел как обычный сбой: при пустом diff артефактов `executeWithFallback` запускал следующего агента списка уже после запроса на остановку, а убитый агент мог попасть в health-реестр. Теперь после остановки стадия завершается ошибкой убитого агента, без перехода к следующему и без пометки.

## [1.7.5] — 2026-09-25

### Added
- **Фактическая модель kilo-агента.** Роутеры `kilo/kilo-auto/free` и `kilo/openrouter/free` выбирают модель сами, а лог показывал только роутер. Теперь раннер пишет строку `AGENT_MODELS agent="…" requested="…" models="…"`: пока kilo-агент работает — при смене набора моделей, после выхода — с числом шагов у каждой. В столбце «Агент» истории работы тикета — та же подпись: `kilo-free(dots-3-note-preview)`, `openrouter-free(nemotron, ling)`; агент со своей моделью (`gpt-luna`) — без скобок. Метрики по-прежнему группируются по id агента. Данные — из базы kilo, сессия находится по метке `--title workflow-<run id>`.

### Fixed
- **Успешный запуск kilo-агента записывался как `auth_error`.** Раннер требовал закрывающий маркер `---RESULT---` (рельсы принимают ответ без него) и считал отказом в правах слова «permission denied» из текста скила execute-task, который рельсы печатают в stderr. Теперь незакрытый финальный блок со `status` принимается, а отказом считается только строка kilo `permission requested: …; auto-rejecting`.

## [1.7.4] — 2026-09-25

### Fixed
- **Установка из npm давала нерабочие скилы и рельсы.** В пакет 1.7.3 от скилов попали только `SKILL.md`: без `rails.yaml`, knowledge/, workflows/, algorithms/, templates/ и scripts/ скилов. Теперь пакет несёт скилы целиком, кроме тестов.
- **`~/.workflow/` из установки npm не запускался.** Туда копировались только skills, scripts, rails и configs, а их код импортирует `../lib/…`, `../global-dir.mjs` и `workflow-ai/lib/…`. Хук rails, rails CLI и скрипты скилов падали с `ERR_MODULE_NOT_FOUND`. Теперь `~/.workflow/` получает копию `src/` пакета без тестов и `package.json` с `exports` пакета. Установка без `package.json` в `~/.workflow/` считается устаревшей: `workflow init` или `workflow update` копирует её заново.

## [1.7.3] — 2026-09-25

> **Примечание:** первая публикация в npm после 1.5.1. Версии 1.5.2–1.7.2 в npm не выходили.
> Записи журнала для 1.6.0–1.7.2 и история их коммитов утеряны при сбое рабочего каталога
> 2026-09-21. Изменения этих версий ниже восстановлены по коду; остальное — по коммитам.

### Added
- **Рельсы для скилов** (`src/rails/`). Процедура скила записана mermaid-графом в `SKILL.md`, переходы между узлами идут через `node .workflow/src/rails/cli.mjs` (`start`, `goto --quote`, `status`, `reset`). Правила скила из `rails.yaml` принуждают хуки Claude Code и плагин Kilo: область записи, запреты shell-команд и MCP-вызовов, действия по этапам, потолки циклов, требования к итоговому ответу. Отказы пишутся в журнал. `workflow init` регистрирует хуки в `.claude/settings.local.json` и `.kilo/plugin/`, ядро копируется в `~/.workflow/rails`. Спецификация — `src/rails/README.md`.
- **Девять скилов переведены на рельсы**: coach, analyze-report, execute-task, review-result, create-plan, decompose-plan, create-report, decompose-gaps, manual-testing. deep-research остался прозой. Правила скилов, которые раньше держались на тексте, стали гейтами и запретами:
  - create-plan: каждое утверждение плана подтверждено источником — цитатой входного документа, `file:line` кода или выводом команды. У каждой задачи — критерий приёмки (результат и способ проверки), а не предписанный код;
  - decompose-plan: четыре стоп-гейта до любой записи — дословный перенос критериев из плана, номера только из `id_ranges`, реестр `required_capabilities`, проверка занятости ID. DoD не строится из формулировки действия;
  - create-report: отчёт охватывает один план (`related_plan`, тикеты с тем же `parent_plan`). У каждой проблемы отчёта — стейдж, строка и дословная причина из лога пайплайна;
  - decompose-gaps: проверка scope до создания тикета, пробел вне scope уходит в «Новые требования». Пустой `parent_plan` отклоняется;
  - review-result: ревьюер пишет только в тикет на ревью, статус — только `passed` или `failed`;
  - manual-testing: скил не создаёт тикеты, UI-утверждения сверяются с источником истины;
  - analyze-report и decompose-gaps: организационные наблюдения (план в draft, техдолг прошлых итераций, баги без тикетов) не считаются пробелами.
- **Окружение агентов из `~/.workflow/agent.env`** (`<WORKFLOW_HOME>/agent.env`). Формат `KEY=VALUE`, строка с `#` — комментарий, пустое значение снимает переменную. Переменные получает каждый процесс агента — в пайплайне и в тестах скилов. Файл перечитывается на каждый запуск, в лог стадии попадают только имена переменных. Пример применения — прокси для агентов, когда раннер запущен из VS Code без прокси в окружении.
- **Кооперативная пауза.** Раннер между стадиями проверяет `.workflow/state/pause-request.json`. Пока файл адресован pid раннера, следующая стадия не начинается; удаление файла снимает паузу. Текущая стадия доигрывает до конца. В лог пишутся `PAUSED before stage="…"` и `RESUMED stage="…"`.
- **Новые поля в `.workflow/logs/.pipeline.lock`**: `started_by` (`cli`, `mcp` или `extension`, из переменной `WORKFLOW_STARTED_BY`), `started_by_id` (из `WORKFLOW_STARTED_BY_ID`), `project_root`, `pipeline_version`, `run_id`, `pipeline_log`, `capabilities: ["pause-request"]`.
- **CLI**: `workflow --version` / `-v` и `workflow --help` / `-h`; справка показывает настоящую версию пакета.
- **Экспорт** `workflow-ai/lib/operations/plans.mjs` и `workflow-ai/lib/operations/skills.mjs`. `createTicket` принимает `body` (тело тикета) и `plan_id` (синоним `parent_plan`).
- **`sync-ticket-status.js`** — миграция рассинхрона между папкой тикета и полем `status`. По умолчанию dry-run, запись — с `--apply`.
- **Тесты скилов**: каталог скилов задаётся переменной `WORKFLOW_SKILLS_DIR`; таймаут судьи — `execution.judge_timeout_s` (по умолчанию 180 с); вход сценария `kind: dir`. Агенты кейса пишут только в свою песочницу (`WORKFLOW_SANDBOX_ROOT`) и во временный каталог ОС.

### Changed
- **Длинный stderr агента** режется в логе пайплайна до 2 КБ на строку с пометкой `...[TRUNCATED N bytes]...`. Полный текст сохраняется в `.workflow/logs/stderr/<stage>-<ts>.log`, в лог попадает ссылка на файл.
- **`workflow run` передаёт раннеру все аргументы.** Раньше CLI пропускал только `--plan`, `--config`, `--project`: `workflow run -h` или опечатка во флаге запускали пайплайн. Теперь это справка раннера или ошибка `Unknown option`.
- **Перемещение тикета из любого клиента** (MCP, расширение VS Code) открывает ждущие его `manual-gate`. Раньше хук срабатывал только у `move-ticket.js`.
- **`move-ticket` синхронизирует `status` во frontmatter с папкой.** Заполненный `completed_at` защищает закрытый тикет от автоотката из `done/`.
- **Human-тикеты переходят в `ready/`**, откуда их забирает `manual-gate`. Раньше они навсегда оставались в `backlog/`, а цикл стадий крутился вхолостую до `max_steps`.
- **Скилы для Kilo** берутся из каталога настроек Kilo: `<KILO_CONFIG_DIR | XDG_CONFIG_HOME/kilo | ~/.config/kilo>/skills` — ссылка на `~/.workflow/skills`. В `.kilocode/skills` остаются только скилы, скопированные в проект. Причина — kilo 7.7.x не загружает `SKILL.md`, чей настоящий путь лежит вне проекта.
- **`configs/pipeline.yaml`**: агенты claude-haiku, claude-sonnet и claude-opus вызывают модели `claude-haiku-4-5-20251001`, `claude-sonnet-5` и `claude-opus-5`; deepseek-flash — `deepseek/deepseek-flash`; добавлен агент gpt-terra. Из `configs/agent-health-rules.yaml` убраны правила qwen-code.
- **Шаблон `CLAUDE.md`** для `workflow init` сокращён. Убрана инструкция «бери задачи из ready/ и перемещай в done/»: она спорила с пайплайном и доходила до исполнителей claude.
- **Файлы доски, планов и решений публикуются заменой**, а не перезаписью на месте: перемещение тикета, approval-файлы, планы, авто-блокировка, синхронизация статусов, история работы и ревью в тикете. Маркер пайплайна и approval-файл создаются атомарно. Читатель больше не видит пустой или обрезанный файл.
- **На Windows агенты не открывают окна терминала**, когда раннер запущен из MCP. Закрытие такого окна раньше убивало агента посреди стадии.

### Fixed
- Раннер записывал успешный запуск агента как `auth_error`: фраза «permission denied» из текста скила принималась за отказ доступа. Незакрытый блок `---RESULT---` со строкой `status` теперь тоже разбирается.
- `findProjectRoot` принимал глобальную установку `~/.workflow` за проект, в том числе при коротких именах путей 8.3 на Windows.
- Второй запуск пайплайна при живом процессе теперь получает `PIPELINE_ALREADY_RUNNING`. Маркер от упавшего прогона снимается, а не блокирует проект сообщением «Failed to acquire lock».
- `workflow stop` не работал на Linux и macOS: `ReferenceError` после отправки SIGTERM.
- `check-relevance` не находил последнюю секцию тикета («Критерии готовности», «Блокировки»). Тикет с невыполненным критерием уходил в `irrelevant`.
- `check-anomalies` объявлял аномалией каждый тикет в `in-progress`.
- На Windows строка ревью или истории работы терялась с `EPERM`, если тикет держал открытым любой читатель. Без строки ревью закрытый тикет возвращался из `done/` в `review/`.
- `verify-artifacts` ставил ложный `file_unchanged`, если агент записал `created_at` из будущего (локальное время с суффиксом `Z`).
- `manual-gate` при повторном заходе на стадию пересоздавал approval-файл и затирал решение человека.
- `listPlans` и `getPlan` искали планы в `plans/` вместо `.workflow/plans/` и выдавали `.gitkeep.md` как план. `listSkills` возвращал пустой список при обычной раскладке проектов и считал скилом любой подкаталог без `SKILL.md`.
- Запрос паузы от убитого запуска останавливал следующий раннер с тем же pid.
- Временный файл approval-записи от умершего прогона оставался в `.workflow/` навсегда.
- `archive-plan-tickets` оставлял окно, в котором тикет лежал в двух колонках.
- Прямой запуск `node src/cli.mjs …` на Windows ничего не делал.

### Removed
- `src/lib/ticket-finder.mjs` — неиспользуемый дубль поиска тикета, в экспорт пакета не входил.
- `src/lib/test-error-classifier.mjs`, `test-extends.mjs`, `test-version.mjs` — черновые файлы, попадавшие в пакет.

### Known issues
- В пакет из каталогов скилов входит только `SKILL.md`. Нет `rails.yaml`, `workflows/`, `algorithms/`, `knowledge/`, `templates/` и `scripts/`. Стадии `configs/pipeline.yaml`, которые вызывают `.workflow/src/skills/review-result/scripts/verify-artifacts.js`, `decompose-plan/scripts/verify-atomicity.js` и `decompose-plan/scripts/check-atomicity-limit.js`, при установке из npm этих файлов не найдут.

## [1.5.1] — 2026-05-02

### Fixed
- 1.5.0 был опубликован нерабочим: `runner.mjs` импортировал `agent-history.mjs` из каталога, который не входил в пакет. `agent-history.mjs`, `review-section.mjs` и `metrics-incremental.mjs` перенесены в `src/lib/`.

## [1.5.0] — 2026-05-02

### Added
- **Audit log агентов в тикетах**: каждая попытка агента (включая fallback) пишет строку в секцию `## История работы` тикета: `| Дата/время | Скил | Агент | Статус |`. 10 классов статуса (ok, error, timeout, empty_response, rate_limit, network_error, auth_error, aborted, blocked, skipped_relevance) детектируются автоматически.
- **Колонка Агент в `## Ревью`**: миграция 3→4 колонки. Видно кто проставил вердикт.
- **Agent history aggregation в metrics**: ключ `agent_history` в `metrics/review-metrics.json` с разрезами by_status/by_agent/by_skill/by_skill_by_agent + fallback_stats. Incremental update от runner.
- New helpers: `lib/agent-history.mjs`, `lib/review-section.mjs`, `lib/metrics-incremental.mjs`.

### Changed
- `getLastReviewStatus` parsing теперь header-based (whitelist: Статус/Status/Вердикт/Verdict). Поддержка legacy 3-колоночных таблиц через `unknown` placeholder в Agent при first append.
- `verify-artifacts.js`, `move-ticket.js` fallback, `check-relevance.js` теперь пишут review через `appendReviewEntry` helper.

## [1.3.0] — 2026-04-30

### Добавлено
- **Новый тип стейджа: `mark-blocked` и расширение frontmatter** — Добавлены поля `auto_blocked_reason`, `auto_blocked_attempts`, `auto_blocked_at` для автоматического отслеживания причин и попыток блокировки тикетов. Стейдж `mark-blocked` позволяет устанавливать эти поля в зависимости от условий бизнес-логики.
- **Новый тип стейджа: `manual-gate-human`** — Добавлен статус `human_ready` в `pick-next-task.js`. При достижении этого статуса задача ожидает ручного решения оператора перед продолжением выполнения.
- **Хук одобрения в `move-ticket.js`** — Добавлен approval-hook, проверяющий наличие ожидающих решения одобрений перед перемещением тикета в терминальные состояния.
- **Расширение START-лога полем `ticket="X"`** — Добавлено поле с идентификатором тикета в стартовый лог для улучшенной трассировки и связывания логов с конкретными задачами.
- **Исправление `approval-pending.mjs` (поле `created_at`)** — Исправлено некорректное заполнение поля `created_at` при создании файлов ожидающих решения.

> **Примечание:** версия 1.2.0 не была опубликована в npm. При выполнении `npm publish`
> сработал prepublishOnly/postversion скрипт, автоматически поднявший версию до 1.2.1.
> Git-тег `v1.2.0` (коммит 179d52b) соответствует состоянию до publish; `v1.2.1` (коммит 83d1b70) —
> фактически опубликованной версии.

### New Features
- **New built-in stage type: `manual-gate`** — Adds support for manual approval steps in pipelines. When a stage with `type: manual-gate` is encountered, the runner creates a pending approval file in `.workflow/approvals/{step_id}.json` and enters a polling loop, waiting for an external decision (`approved`/`rejected`).

  **Key capabilities:**
  - Deterministic `step_id` generation: `{ticket_id}_{stageId}_{attempt}` (e.g., `QA-12_manual-approve_0`)
  - Idempotent file creation — pending file is not overwritten on retry/restart
  - Configurable polling interval (`poll_interval_ms`, default 2000ms) and optional timeout (`timeout_seconds`)
  - Graceful handling of SIGTERM/runner stop (returns `aborted`)
  - Immediate return if file already has `approved`/`rejected` status (crash recovery)
  - JSON approval file format with full audit trail (`created_at`, `updated_at`, `decided_by`, `comment`, `context_snapshot`)

  **Pipeline configuration example:**
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

  **Two approval methods (both opt-in):**
  1. **External MCP/client**: tools like `workflow-mcp` can write to approval files programmatically
  2. **Direct file edit**: users can simply edit `.workflow/approvals/{step_id}.json` and change `status` to `approved` or `rejected`

  **Important:** `manual-gate` is **opt-in** — pipelines without such stages work identically to previous versions. No breaking changes.

### Changed
- No breaking changes. All existing pipelines without `manual-gate` stages are fully backward compatible.

### Fixes
- Исправлено сохранение временной метки `created_at` в файлах одобрений (approval-pending.mjs)

### Technical Notes
- Approval files are stored in `<project_root>/.workflow/approvals/`
- Runner validates `manual-gate` stages on startup — requires `goto.approved` and `goto.rejected`, validates numeric parameters
- New methods added to `PipelineRunner`: `computeStepId()`, `writeApprovalPending()`, `readApprovalFile()`, `executeManualGate()`

### References
- PLAN-009: workflow-ai 1.2 — manual-gate stage and approval files for workflow-mcp Sprint 2 integration
- IMPL-55, IMPL-56, IMPL-57, IMPL-58: Implementation tickets
- QA-35, QA-36, QA-37: Test coverage
- IMPL-51, QA-55 in workflow-mcp: Dependent consumer work

# Rails — ядро принуждения процедур скилов

Реализация концепции «Рельсы для агента» для workflow-ai: процедура скила записана
графом (mermaid в `SKILL.md` + фрагменты в `workflows/*.md`), соблюдение графа
принуждается детерминированными хуками, которые отклоняют вызов инструмента.
Хуки обязаны одинаково работать для двух исполнителей: **Claude Code** (`claude -p`,
интерактивная сессия) и **Kilo** (`kilo run --auto`). Один модуль ядра, два тонких адаптера.

Этот документ — спецификация для реализации. Всё, что здесь не описано, решается
по принципу «детерминированно, дёшево, без вызова модели».

## 1. Состав

```
src/rails/
  README.md          — этот документ
  graph.mjs          — парсер mermaid-подмножества, модель графа, валидация
  rails-config.mjs   — загрузка и валидация rails.yaml скила
  state.mjs          — состояние сессии (файл), переходы, счётчики, потолки
  journal.mjs        — журнал отказов (jsonl), счётчики повторов по узлу, отчёт
  actions.mjs        — нормализация действий (инструмент Claude / Kilo → action)
  core.mjs           — decide(): единая логика решений
  output-check.mjs   — проверка финального ответа агента по rails.yaml.output
  claude-hook.mjs    — адаптер Claude Code hooks (stdin JSON → stdout JSON)
  kilo-plugin.mjs    — адаптер Kilo/opencode plugin (tool.execute.before / after)
  cli.mjs            — rails start | goto | status | reset | report | check | coverage | selfcheck
src/scripts/check-rails-graph.js     — обёртка над `cli check` (привычный путь для агентов)
src/scripts/check-rails-coverage.js  — обёртка над `cli coverage`
src/tests/rails-*.test.mjs           — тесты (node:test, как остальные в src/tests)
```

Зависимости: только Node ≥ 18 и `src/lib/js-yaml.mjs` (уже в репозитории). Никаких новых npm-пакетов.
Все модули — ESM, без побочных эффектов при импорте (адаптеры и CLI запускают логику только
из `main()`), чтобы тесты импортировали их напрямую.

## 2. Пути и разрешение путей

| Что | Где |
|---|---|
| Корень проекта | `findProjectRoot(cwd)` из `src/lib/find-root.mjs` (ищет `.workflow/`). Нет корня → хук молчит. |
| Скил | `<root>/.workflow/src/skills/<skill>/` — `SKILL.md`, `workflows/*.md`, `rails.yaml` |
| Ядро rails в проекте | `<root>/.workflow/src/rails/` — junction на `~/.workflow/rails/` (см. §11) |
| Состояние | `<root>/.workflow/state/rails/<sessionId>.json` |
| Память «сессия → корень» | `<WORKFLOW_HOME\|~/.workflow>/state/rails-sessions.json` — для сессий из каталога-зонтика: заполняется `rails start --session` из каталога проекта и edit/write с путём внутри проекта; хук берёт из неё корень для команд без пути (`session-memo.mjs`). ≤ 50 записей: при переполнении первыми уходят записи с исчезнувшим корнем (временные проекты тестов/раннера), потом самые старые. Тесты изолируют её через `WORKFLOW_HOME` (`src/tests/_rails-home.mjs`, преднагрузка `npm test`) |
| Журнал отказов | `<root>/.workflow/logs/rails-denials.jsonl` (только дописывание) |

**Сравнение путей — только через realpath.** Скилы подключены junction-цепочкой
(`<root>/.workflow/src/skills/<skill>` → `~/.workflow/skills/<skill>` → канон), и агент может
править файл как по проектному пути, так и по каноническому. Путь считается внутри области,
если `realpath(путь)` начинается с `realpath(область)`. Для ещё не существующего файла (Write)
realpath берётся от ближайшего существующего предка плюс остаток. Регистр букв на Windows
не учитывается.

## 3. Грамматика графа

Граф скила = все блоки ```` ```mermaid ```` из `SKILL.md` и из файлов, перечисленных в
`rails.yaml.fragments` (по умолчанию `workflows/*.md`), склеенные в один граф.
Поддерживается подмножество mermaid flowchart:

```
graph TD
    %% комментарий
    P4E1["П4 ВХОД: Правка файлов скила — ..."]
    P4R1["П4 ПРАВИЛО: ..."]
    P4G1{"П4 ГЕЙТ: ...?"}
    P4E1 --> P4R1
    P4R1 --> P4S1["П4 ШАГ: ..."]
    P4G1 -->|"да"| P5E1
    P4G1 -->|"нет"| P4S1
```

- Идентификатор узла: `^P(\d+)([ERSGQ])(\d+)$` — этап, тип, номер. Разбирается регулярным
  выражением, без модели.
- Форма: `["..."]` прямоугольник (E, R, S), `{"..."}` ромб (G, Q). Лейбл только в двойных
  кавычках; может занимать несколько строк (перенос строки внутри кавычек допустим).
- Рёбра: `A --> B`, `A -->|"метка"| B`, определение узла inline в ребре допустимо.
- Типы: `E` вход в этап, `R` правило, `S` шаг, `G` гейт-самоопрос (ответ «нет» — ребро назад),
  `Q` выбор ветки по существу задачи.

Правила валидации (`graph.validate()` возвращает `{errors[], warnings[], stats}`):

| Код | Условие | Уровень |
|---|---|---|
| `bad-id` | идентификатор не по грамматике | error |
| `dup-id` | повтор идентификатора (в том числе между файлами) | error |
| `semicolon-in-label` | `;` внутри лейбла — в кавычках mermaid 12.0.0 разбирает штатно (проверено 2026-09-22), ломает только `;` вне кавычек; наша грамматика требует кавычки | warning |
| `short-label` | лейбл R/S/G/Q короче `quote_min` (по умолчанию 25) символов | error |
| `unknown-target` | ребро на несуществующий узел | error |
| `no-entry` / `bad-entry` | `rails.yaml.entry` отсутствует или не E-узел | error |
| `orphan` | узел недостижим из entry | error |
| `dead-end` | у узла нет исходящих рёбер и он не в `terminal` и не в `pause_nodes` | error |
| `stage-no-entry` | в этапе нет E-узла или их больше одного | error |
| `stage-order` | внутри этапа R-узел определён после S/G/Q | error |
| `gate-edges` | у G/Q меньше двух исходящих рёбер или рёбра без метки | error |
| `stage-collision` | один номер этапа в двух файлах | error |
| `unlabeled-branch` | у узла с двумя и более исходящими рёбрами есть ребро без метки | warning |

Статистика: узлы по типам, рёбра, этапы, файлы. Нормализация лейбла для сверки цитат:
схлопнуть пробелы, привести кавычки `«»“”"` к `"`, `’‘'` к `'`, нижний регистр, убрать
`<br/>`. Настоящий разбор парсером mermaid не подключается (нет зависимости); это
осознанная граница, указана в отчёте `check`.

## 4. rails.yaml

Лежит рядом с `SKILL.md`. Машинный конфиг хука, не проза. Схема v1:

```yaml
version: 1
skill: coach
entry: P0E1                      # E-узел
terminal: [P8S3]                 # где разрешён финальный ответ
pause_nodes: [P3Q1, P7S2]        # узлы «вопрос стейкхолдеру»: финальный ответ тоже разрешён
fragments: ["workflows/*.md"]    # где искать фрагменты графа, помимо SKILL.md
quote_min: 25
canary: "echo RAILS_CANARY"      # безвредная команда, которую хук обязан отклонить

write_scope:                     # H1: запись разрешена только сюда (project-relative или abs)
  - ".workflow/src/skills/**"
  - ".workflow/coach-backlog.yaml"
allow_temp: true                 # плюс os.tmpdir() и его поддиректории
write_deny:                      # H1b: запрещено даже внутри scope
  - ".workflow/src/skills/coach/rails.yaml"
  - ".workflow/src/rails/**"

deny_shell:                      # H2: регулярные выражения по тексту команды
  - pattern: "\\bgit\\s+(commit|add|push|checkout|switch|restore|reset|rebase|merge|stash|tag)\\b"
    reason: "Коуч не выполняет git-операции — коммит делает исключительно пользователь"
    incident: "SKILL.md ⛔ «Коуч не выполняет git-операции»"
deny_mcp:                        # имена MCP-инструментов без префикса сервера
  - git_commit
  - git_create_branch
  - git_open_pr

stage_actions:                   # H3: действие разрешено только на перечисленных этапах
  edit_skill:
    kind: [edit, write]
    match: ".workflow/src/skills/**"
    stages: [4, 12, 41]
  run_tests:
    kind: [shell]
    match: "run-skill-tests\\.js"
    stages: [5]
    max_per_session: 3           # H4: потолок на число выполнений
  next_test_id:
    kind: [shell]
    match: "get-next-test-id\\.js"
    stages: [5]
  edit_backlog:
    kind: [edit, write]
    match: ".workflow/coach-backlog.yaml"
    stages: [6]

cycles:                          # H4: потолок на возвраты между этапами
  - from: 5
    to: 4
    max: 3
    reason: "Три круга «правка → тест» не сошлись — выход к человеку"

output:                          # H5: выходной слой
  final_requires:                # регулярные выражения (флаг i), все обязаны совпасть — в terminal
    - "RAILS:\\s*P\\d+[ERSGQ]\\d+"
    - "verdict\\s*="
    - "Файлы:"
  pause_requires:                # то же для pause_nodes (вопрос стейкхолдеру, не отчёт); по умолчанию пусто
    - "RAILS:\\s*P\\d+[ERSGQ]\\d+"
  max_stop_blocks: 2             # сколько раз Stop-хук может вернуть агента на доработку
```

`match` — glob по realpath (для `kind: edit|write`) или регулярное выражение по тексту
команды (для `kind: shell`). Valid-проверка `rails.yaml` — часть `cli check`.

## 5. Состояние сессии

Файл `<root>/.workflow/state/rails/<sessionId>.json`:

```json
{
  "version": 1,
  "session": "44e7746f-…",
  "run": "wf-run-id или null",
  "skill": "coach",
  "node": "P4S2",
  "started": "2026-09-21T18:00:00.000Z",
  "updated": "2026-09-21T18:05:00.000Z",
  "history": [{ "t": "…", "from": "P4S1", "to": "P4S2" }],
  "counters": { "action:run_tests": 1, "cycle:5>4": 0, "stop_blocks:P4S2": 0 },
  "denials": { "P4S2": 2 },
  "flags": { "correction_pending": false }
}
```

- Идентификатор сессии: Claude — `session_id` из входа хука; Kilo — `input.sessionID`;
  CLI — `--session`, иначе `WORKFLOW_RAILS_SESSION`, иначе самый свежий файл состояния
  проекта (с предупреждением в stderr).
- Снимок, не событийный лог. Запись атомарная (tmp + rename).
- `start <skill>` создаёт состояние в `entry`. Если состояние уже есть для другого скила —
  отказ, если не `--force`. Если состояния нет, но задан `WORKFLOW_RAILS_SKILL` (ставит раннер),
  хук создаёт состояние сам при первом действии.
- `reset` удаляет файл; факт сброса пишется в журнал.

**Переход `goto <node> --quote "<текст>"`** допустим, если: есть ребро из текущего узла в
целевой; цитата не короче `quote_min`; нормализованная цитата — подстрока нормализованного
лейбла целевого узла. Ошибочная цитата, переход без ребра, пересказ своими словами —
отказ с перечнем допустимых переходов (`id: первые 60 символов лейбла`). Отказ по цитате
называет точку расхождения: совпавший хвост и по ~30 символов дальше у цитаты и у лейбла;
если в лейбле на этом месте `$`, добавляется подсказка про одинарные кавычки (shell
раскрывает `$X` внутри двойных). Так по журналу видно, пересказ это или порча цитаты shell'ом.

**E-узлы прозрачны:** объявить `goto P4E1` можно, но пока текущий узел — E, действия этапа
(`stage_actions`) запрещены: агент обязан пройти в R/S/G/Q. Так реализовано правило
«цитата из узла-входа не принимается, пока в этапе есть правила, шаги или гейты».

**Потолки:** переход, увеличивающий счётчик `cycle:from>to` сверх `max`, отклоняется с
текстом `reason` и указанием «выход к человеку». Запись `cycles` с `from == to` — потолок
на **возврат внутри этапа** (гейт → шаг): считается только переход к узлу, стоящему раньше
по порядку типов `E < R < S < G/Q` (при равном типе — по номеру); штатная цепочка вперёд
`E → R → S → G` счётчик не трогает (первый прогон коуча 2026-09-22 упёрся в `cycle_limit`
на третьем шаге вперёд). Действие с `max_per_session` сверх лимита отклоняется так же.

## 6. Нормализация действий

`actions.mjs` приводит вызов инструмента к `{ tool, kind, command?, path?, server?, mcpTool? }`,
`kind ∈ shell | edit | write | read | agent | mcp | other`.

| Claude Code (`tool_name`) | Kilo (`input.tool`) | kind | поле |
|---|---|---|---|
| `Bash` | `bash` | shell | `command` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `edit`, `patch`, `multiedit` | edit | `file_path` / `notebook_path` / `filePath` |
| `Write` | `write` | write | `file_path` / `filePath` |
| `Read`, `Glob`, `Grep`, `LS` | `read`, `glob`, `grep`, `list` | read | — |
| `Agent`, `Task` | `task` | agent | — |
| `mcp__<server>__<tool>` | `<server>_<tool>` | mcp | server, mcpTool |
| прочее | прочее | other | — |

Неизвестные имена — `other`, никогда не ошибка. Для `shell` дополнительно вычисляется
`writesTo[]` — пути-цели детерминированно распознаваемых записей: `sed -i`, `>`/`>>`,
`tee`, `rm`, `mv`, `cp`, `mkdir`, `touch`, `del`, `Remove-Item`, `Set-Content`, `Out-File`.
Если команда содержит признак записи, а путь извлечь не удалось — `writesTo` содержит
маркер `"?"`; core трактует это как запись вне области с подсказкой «используй Edit/Write
или укажи путь явно».

## 7. Алгоритм решения (`core.decide`)

Вход: `{ action, ctx }`, `ctx = { cwd, sessionId, role, event, run? }`.
Выход: `{ decision: "allow" | "deny", reason?, context?, updatedCommand? }`.

1. `root = findProjectRoot(cwd)`; нет корня → `allow` без текста (скоуп по каталогу).
2. `role === "executor"` → `allow` без текста. Роль: `WORKFLOW_RAILS_ROLE` из окружения;
   для Claude дополнительно — наличие поля `agent_id`/`agent_type` во входе хука
   (субагент; поле задокументировано в README как **не проверенное**, покрыто синтетическим тестом).
3. Загрузить состояние сессии. Нет состояния и нет `WORKFLOW_RAILS_SKILL` → **режим без скила**:
   единственный гард G0 — `edit|write` по realpath внутри `<root>/.workflow/src/skills/**`
   отклоняется: «правки скилов только через коуча на рельсах: `node .workflow/src/rails/cli.mjs start coach`».
   Остальное — `allow`.
4. Режим скила: загрузить `rails.yaml` и граф скила (кэш по mtime файлов в памяти процесса).
   Порядок проверок, первая сработавшая — итог:
   1. команда — вызов `cli.mjs` (`start|goto|status|reset|report|check|coverage|selfcheck`):
      один или несколько сегментов (`&&`, `;`, перевод строки), каждый — вызов `rails/cli.mjs`
      (пайп `| head` внутри сегмента допустим), с необязательным первым сегментом `cd <dir>` →
      `allow`; в каждый cli-сегмент без `--session` вставляется `--session <id>` перед первым `|`
      (`updatedCommand`). `cli.mjs status && git commit` — не cli-команда, идёт по общим правилам;
   2. команда совпадает с `canary` → `deny` «RAILS_CANARY: рельсы активны, узел …»;
   3. `deny_shell` по команде → `deny` (reason + incident);
   4. `deny_mcp` по имени инструмента → `deny`;
   5. `edit|write` или `shell.writesTo` в `write_deny` → `deny`;
   6. `edit|write` или `shell.writesTo` вне `write_scope` → `deny`; при `allow_temp` разрешена запись
      под `os.tmpdir()`, но не внутри корня проекта (изолированный workdir тестов сам лежит в temp);
      сравнение с temp и корнем — по префиксу realpath, без обхода ссылок (`isInside(…, { followLinks: false })`);
   7. `stage_actions`: для каждого правила с совпавшим `kind` и `match` — текущий этап должен быть
      в `stages`, текущий узел не E, счётчик `max_per_session` не исчерпан; иначе `deny`;
   8. `allow`; `context = "RAILS: числится <node> «<лейбл до 80 символов>»"`.
5. Каждый `deny`: запись в журнал, инкремент `denials[node]`; текст отказа из трёх частей:
   **что отклонено** (инструмент + путь/команда), **почему** (цитата лейбла узла или правило
   rails.yaml с `incident`, плюс «по <узел> это N-й отказ за сессию»), **что доступно**
   (допустимые переходы из текущего узла и действия текущего этапа).

Хук никогда не падает: любое исключение → `allow` + строка в stderr + запись `error` в журнал.
Бюджет времени решения — до 200 мс на вызов.

**Дедупликация (2026-09-22).** Хуки могут быть зарегистрированы и у пользователя, и в проекте —
один вызов инструмента приходит дважды. В режиме скила решение кэшируется в состоянии по ключу
`<event>:<tool_use_id|callID>` (последние 8), повтор возвращает тот же ответ с `deduped: true`,
счётчики и журнал не растут. Редирект в псевдоустройство (`2>/dev/null`, `>NUL`) — не запись.

## 8. Выходной слой

`output-check.check(text, config, state)` → `{ ok, missing[] }` по `output.final_requires`
и по положению: финальный ответ допустим только в `terminal` или `pause_nodes`.

- Claude: хук `Stop`. Вход содержит `stop_hook_active`; если `true` — не блокировать.
  Последнее сообщение ассистента читается из `transcript_path` (jsonl, последняя запись
  `type: "assistant"`, текстовые блоки). Нарушение → `{ "decision": "block", "reason": "…" }`,
  счётчик `stop_blocks:<node>` ≤ `max_stop_blocks`, дальше — `allow` с записью в журнал.
- Kilo и пайплайн: хука на финальный ответ нет. Раннер (§11) после завершения агента вызывает
  `check` по состоянию, найденному по `run`; при нарушении — один повторный запуск с
  вердиктом, приписанным к промпту.

## 9. Адаптеры

### 9.1 Claude Code — `claude-hook.mjs`

Регистрируется на события `PreToolUse` (все инструменты), `PostToolUse`, `Stop`,
`UserPromptSubmit`, `SessionStart`. Читает JSON со stdin, пишет JSON в stdout, код выхода всегда 0.

| Событие | Ответ |
|---|---|
| PreToolUse | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` либо `allow` (пустой вывод), либо `updatedInput` с изменённой командой для инъекции `--session` |
| PostToolUse | `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"RAILS: числится …"}}` |
| Stop | `{"decision":"block","reason":"…"}` или пустой вывод |
| UserPromptSubmit | `additionalContext` c подсказкой ГЛАВНОГО ПРАВИЛА, если текст содержит маркеры коррекции (`^нет\b`, `не то`, `не туда`, `почему не`); выставляет `flags.correction_pending` |
| SessionStart | `additionalContext`: активный скил и узел, если состояние есть |

Поля входа, проверенные канарейкой 2026-09-21: `session_id`, `transcript_path`, `cwd`,
`permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, `prompt_id`.
Отказ в режиме `-p` через проектный `settings` подтверждён.

### 9.2 Kilo — `kilo-plugin.mjs`

```js
export const WorkflowRails = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => { /* deny = throw new Error(reason) */ },
  "tool.execute.after":  async (input, output) => { /* output.output += "\n\nRAILS: числится …" */ },
});
```

Проверено канарейкой 2026-09-21: плагин грузится из `<root>/.kilo/plugin/*.js`;
`input = { tool, sessionID, callID }`, `output.args` — аргументы инструмента (`command`,
`filePath`, …); `throw` в `before` отклоняет вызов и текст ошибки доходит до модели;
`after` может дописать в `output.output`. Инъекция `--session`: мутация `output.args.command`.
Загрузчик в проекте: `<root>/.kilo/plugin/workflow-rails.js` со строкой
`export { WorkflowRails } from "../../.workflow/src/rails/kilo-plugin.mjs";`.

## 10. CLI — `cli.mjs`

| Команда | Действие |
|---|---|
| `start <skill> [--session S] [--force]` | создать состояние в `entry`; печатает лейбл входа и допустимые переходы |
| `goto <node> --quote "<…>" [--session S]` | переход; печатает «числится …» и допустимые переходы; отказ — три части, код выхода 2 |
| `status [--session S]` | текущий узел, этап, счётчики, последние переходы |
| `reset [--session S]` | удалить состояние (в журнал) |
| `report --days N [--skill X] [--journal <файл\|каталог>]` | сводка журнала: отказы по узлу, узлы с ≥3 повторами в одной сессии, потолки, сбросы, Stop-блоки, ошибки хука; `--journal` — вместо журнала проекта файл или все `*.jsonl` под каталогом (например, `tests/cases/<TC>/current`) |
| `check --skill X \| --all` | валидация графа и rails.yaml; статистика; код выхода 1 при ошибках |
| `coverage --skill X --baseline <git-ref> [--map <file>]` | покрытие инвариантов (§12); карта по умолчанию — `rails-migration.yaml` скила; код выхода 1 при пропусках или ненайденной `--map` |
| `selfcheck` | регистрация: `.claude/settings.local.json` содержит хуки rails с существующими путями, `.kilo/plugin/workflow-rails.js` существует, `rails.yaml` каждого скила с графом валиден |

Канарейка живости — не команда CLI, а узел графа: агент в первом этапе выполняет `canary`
и обязан получить отказ; если команда выполнилась — рельсы выключены, агент останавливается
и сообщает человеку.

## 11. Интеграция в workflow-ai

- `src/global-dir.mjs`: копировать `src/rails/` → `~/.workflow/rails/` вместе со skills/scripts/configs.
- `src/junction-manager.mjs`: `createRailsJunction(globalDir, projectRailsDir)` → `<root>/.workflow/src/rails`.
- `src/init.mjs`: шаг «rails» — junction; `.claude/settings.local.json`: слить ключ `hooks`
  (записи помечены `"_workflow_rails": true`, повторный init заменяет только их; чужие
  хуки и ключи не трогать; путь к хуку абсолютный: `node "<root>/.workflow/src/rails/claude-hook.mjs"`);
  `.kilo/plugin/workflow-rails.js` — загрузчик; `.gitignore` — `.workflow/state/`.
  **Регистрацию хуков выполняет только человек** — `workflow init` или точечно
  `node src/scripts/register-rails.js <root>`; агент этот шаг не запускает (принцип 17).
  Каталог-зонтик над проектами (сессия Claude Code стартует из него, например `D:\Dev`):
  `register-rails.js --umbrella <dir>` пишет только хуки Claude с путём к глобальному ядру
  `<globalDir>/rails/claude-hook.mjs`; корень проекта хук берёт по `cwd`, а для edit/write без
  корня по `cwd` — по пути цели (ближайший предок с `.workflow/src/skills`, см. `projectRootFromPath`).
  Хуки проекта видит только сессия, запущенная из его корня (или из зонтика с такой регистрацией).
- `src/scripts/run-skill-tests.js` → `createTestWorkdir`: те же junction/settings/plugin в
  изолированном workdir (хуки Claude — если их нет у пользователя; `WORKFLOW_RAILS_WORKDIR_HOOKS=always|never|auto`);
  `cleanupTestWorkdir` снимает junction `src/rails` первым. Перед удалением workdir улики rails
  сохраняются в `tests/cases/<TC>/current/<agent>/rails-trial-N.jsonl` (журнал) и
  `rails-state-trial-N.json` (состояние) — `rails report --journal tests/cases/<TC>/current`.
- `src/lib/agent-spawner.mjs` / `src/runner.mjs`: переменные окружения дочернего процесса
  `WORKFLOW_RAILS_ROLE` (`coordinator` для целевого агента стадии/теста, `executor` для судьи),
  `WORKFLOW_RAILS_SKILL`, `WORKFLOW_RAILS_RUN` (uuid запуска); после завершения — `output-check`
  по состоянию с этим `run`, при нарушении один повтор с вердиктом в начале промпта.
- `package.json` → `files`: добавить `src/rails/`.

## 12. Покрытие при конверсии (`coverage`)

Гарантия «ничего не утрачено» при переводе прозы в граф. Из базовой версии скила
(`git show <ref>:src/skills/<skill>/SKILL.md` и `workflows/*.md` — только эти файлы,
справочники в граф не переносятся) извлекаются **фразы-инварианты**: предложения из
строк, содержащих `⛔`, `⚠️`, `**…**`, даты (`\d{4}-\d{2}-\d{2}`, `\d{2}\.\d{2}\.\d{4}`),
а также строки таблиц под заголовками маршрутизации, загрузки и шаблонов (заголовок
секции содержит «маршрутизац», «загрузк» или «шаблон»), без строки-шапки. Фраза
нормализуется (как лейбл, §3, плюс снятие `` ` ``, маркера списка и `>`) и считается
покрытой, если её подстрока длиной ≥ 25 символов встречается в текущих файлах скила
(все `*.md` кроме `tests/`, плюс `rails.yaml`) **или** покрыта картой `--map`.
Карта — `rails-migration.yaml` рядом с `SKILL.md`: либо плоский объект `phrase: target`,
либо `entries: [{phrase, target}]` с метаданными (`version`, `skill`, `baseline`);
`phrase` — отличительный фрагмент (≥ 10 символов), совпадает с инвариантом целиком или
входит в него подстрокой; `target` — узел, файл или `dropped: <обоснование>`.
Без `--map` берётся `rails-migration.yaml` скила, если он есть. Относительный `--map`
ищется от текущего каталога, затем от каталога скила; явно заданной карты нет ни там, ни
там — ошибка, код выхода 1 (раньше пустая карта подставлялась молча: 151/200 вместо
200/200, прогон 2026-09-22). Взятая карта печатается строкой `Карта:`.
Непокрытые фразы печатаются списком; код выхода 1.

## 13. Тесты

Все — `node:test`, во временных каталогах, без сети и без запуска агентов.

- `rails-graph.test.mjs`: разбор фикстуры; каждый код ошибки из §3 воспроизводится отдельным
  негативным случаем; склейка фрагментов; нормализация лейбла.
- `rails-config.test.mjs`: валидная/невалидная схема rails.yaml.
- `rails-state.test.mjs`: start/goto/reset, цитата короткая / не из лейбла / без ребра,
  E-прозрачность, потолки циклов и действий, атомарная запись.
- `rails-actions.test.mjs`: таблица §6 для обоих исполнителей; `writesTo` по перечисленным
  признакам записи, включая `"?"`.
- `rails-core.test.mjs`: каждый пункт §7 — отказ там, где ждём отказ, молчание там, где ждём
  молчание, молчание для `executor`, молчание вне проекта, G0 без скила, realpath через
  junction (на win32 создаётся временный junction, иначе symlink), текст отказа из трёх частей,
  запись в журнал и счётчик повторов.
- `rails-output-check.test.mjs`: требования и положение (terminal / pause / прочее).
- `rails-claude-hook.test.mjs`: синтетический stdin для каждого события → ожидаемый JSON;
  Stop с фикстурой transcript.jsonl; `stop_hook_active`.
- `rails-kilo-plugin.test.mjs`: вызов хуков с синтетическим `input/output` → throw / мутация.
- `rails-cli.test.mjs`: команды через `child_process` на временном проекте с мини-скилом.
- `rails-coverage.test.mjs`: базовая версия vs текущая, карта `--map`, отсутствующая фраза.
- `rails-integration.test.mjs`: `init` пишет settings/plugin идемпотентно и не трогает чужие
  ключи; `createTestWorkdir` содержит junction/settings/plugin; spawner передаёт env.

## 14. Границы (честно)

Принуждается то, что видно в аргументах вызова инструмента или в тексте ответа.
Гард по тексту команды обходится косвенностью (переменная, alias, скрипт-обёртка) — он ловит
небрежность, не намеренный обход. Качество evidence, изоляция формулировок, коррекция
стейкхолдера — остаются текстом узлов графа. Разбор mermaid ведётся собственным парсером
подмножества, не официальным.

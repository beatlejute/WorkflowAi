# Инструкции для Claude Code

Этот проект использует систему координации AI-агентов через файловую канбан-доску.

## Структура проекта

- `.workflow/` — канбан-доска с тикетами
- `.workflow/src/skills/` — инструкции для выполнения задач

## Доступные Skills

При выполнении задач используй соответствующие инструкции:

{{SKILLS_TABLE}}

### Скрипты (перемещение и выбор тикетов)

| Действие | Скрипт |
|----------|--------|
| Перемещение тикета | `node .workflow/src/scripts/move-ticket.js <id> <target>` |
| Выбор следующей задачи | `node .workflow/src/scripts/pick-next-task.js` |
| Перемещение готовых в ready | `node .workflow/src/scripts/move-to-ready.js` |

## Workflow

1. **Планирование**: Создай план в `.workflow/plans/current/`
2. **Декомпозиция**: Разбей план на тикеты в `.workflow/tickets/backlog/`
3. **Выполнение**: Бери задачи из `ready/`, выполняй, перемещай в `done/`
4. **Отчётность**: Создавай отчёты в `.workflow/reports/`

## Шаблоны

- `.workflow/templates/ticket-template.md` — шаблон тикета
- `.workflow/templates/plan-template.md` — шаблон плана
- `.workflow/templates/report-template.md` — шаблон отчёта

## Конфигурация

Счётчики ID и настройки в `.workflow/config/config.yaml`

## Правила написания кода
При написании кода использовать методологии TDD, SOLID, DRY

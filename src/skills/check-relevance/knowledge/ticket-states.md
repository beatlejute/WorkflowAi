# Состояния тикетов и критерии неактуальности

## Расположение тикетов по колонкам

| Колонка | Путь | Семантика |
|---------|------|-----------|
| backlog | `.workflow/tickets/backlog/` | Запланирован, не готов к работе |
| ready | `.workflow/tickets/ready/` | Готов к выполнению |
| in-progress | `.workflow/tickets/in-progress/` | Взят в работу |
| done | `.workflow/tickets/done/` | Завершён |
| blocked | `.workflow/tickets/blocked/` | Заблокирован |

## Критерии неактуальности тикета

| Критерий | Проверка | Вердикт |
|----------|----------|---------|
| Уже пропущен | Последнее ревью имеет статус `⏭ skipped` | `irrelevant` (reason: `already_skipped`) |
| DoD выполнен | Все `[x]` в Definition of Done И ревью НЕ `❌ failed` | `irrelevant` (reason: `dod_completed`) |
| Заблокирован | Секция `## Блокировки` или frontmatter blocked | `irrelevant` (reason: `blocked`) |
| Зависимости неактуальны | Зависимый тикет в `blocked/` с причиной «неактуально» или удалён | `irrelevant` (reason: `dependencies_inactive`) |

## Особые случаи

| Случай | Поведение |
|--------|-----------|
| Ревью `❌ failed` | Тикету нужна доработка → `relevant` (reason: `review_failed_needs_rework`) |
| DoD выполнен + ревью `❌ failed` | `relevant` — доработка приоритетнее завершённости |
| Тикет не найден | Fallback → `relevant` (fail-safe) |
| Неизвестный статус | Fallback → `relevant` (fail-safe) |

## Структура секции ревью в тикете

```markdown
## Ревью

| Дата | Статус | Самари |
|------|--------|--------|
| 2026-03-10 | ⏭️ skipped | DoD уже выполнен, тикет неактуален |
| 2026-03-12 | ✅ passed | Ревью пройдено |
| 2026-03-13 | ❌ failed | Не реализован пункт 3 из DoD |
```

Последняя строка таблицы — актуальный статус ревью.

<!-- РАСШИРЕНИЕ: добавляй новые состояния и критерии ниже -->

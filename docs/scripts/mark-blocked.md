# mark-blocked.md

## Назначение скрипта
mark-blocked.js - Скрипт для обновления frontmatter тикета и записи в alerts.jsonl

## Usage
```
node mark-blocked.js TICKET_ID --attempts=N --reason=<str>
```

## Аргументы
- `ticket_id` (позиционный, обязательный) - ID тикета для блокировки
- `--attempts` (число, опциональный) - количество попыток (по умолчанию: null)
- `--reason` (строка, обязательный) - причина блокировки

## Exit codes
- 0 = успех
- 1 = ошибка (нет --reason, не найден тикет)

## Побочные эффекты
- Обновление frontmatter тикета с полями:
  - `auto_blocked_reason` - причина блокировки
  - `auto_blocked_attempts` - количество попыток
  - `auto_blocked_at` - timestamp блокировки
- Запись в `${stateDir}/alerts.jsonl` в формате JSONL с полями:
  - `timestamp` - время записи
  - `severity` - уровень важности (warning)
  - `kind` - тип события (ticket_auto_blocked)
  - `project` - название проекта
  - `ticket_id` - ID тикета
  - `attempts` - количество попыток
  - `reason` - причина блокировки
  - `stage` - этап, на котором произошло блокирование (review-result)
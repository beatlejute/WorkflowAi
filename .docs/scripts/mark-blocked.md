# mark-blocked

Назначение скрипта для блокировки тикетов в системе workflow-ai.

## Usage

```bash
node mark-blocked.js TICKET_ID --attempts=N --reason=<str>
```

## Аргументы

- `ticket_id` (позиционный, обязательный) - ID тикета для блокировки
- `--attempts` (число, опциональный) - количество попыток выполнения
- `--reason` (строка, обязательный) - причина блокировки

## Exit codes

- `0` - успех
- `1` - ошибка (отсутствует --reason, тикет не найден)

## Побочные эффекты

- Обновление frontmatter тикета
- Запись в `${stateDir}/alerts.jsonl`
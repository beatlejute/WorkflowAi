# move-ticket.md

## Назначение скрипта
move-ticket.js - Скрипт для перемещения тикетов между директориями канбан-доски

## Usage
```
node move-ticket.js <ticket_id> <target>
```

## Пример
```
node move-ticket.js IMPL-001 in-progress
```

## Approval-hook
После успешного перемещения тикета скрипт ищет pending approval-файлы по pattern `{ticket_id}_manual-gate-*_*.json` в директории `.workflow/approvals/`.

Условие срабатывания: файл существует со `status: "pending"`.

Результат: файл переписывается на `approved` с полями:
- `decided_by: "move-ticket"`
- `comment: "auto-approved on move to <target>"` (где <target> - целевой статус)
- `updated_at: <current timestamp>`
# Управление бэклогом коуча

Коуч ведёт бэклог своей работы в файле `.workflow/coach-backlog.yaml`. Этот файл — единственный источник правды о том, что уже было проанализировано и какие правки внесены.

## Структура бэклога

```yaml
# .workflow/coach-backlog.yaml
version: 1
last_updated: "2026-03-20"

# Проанализированные тикеты
analyzed_tickets:
  - ticket_id: "GML-001"
    ticket_file: "tickets/done/GML-001.md"
    analyzed_date: "2026-03-20"
    coach_ticket: "COACH-005"  # тикет коуча, в рамках которого проведён анализ
    findings_count: 3
    summary: "Недостаток knowledge по TAM/SAM/SOM, нечёткий воркфлоу"

# Внесённые правки в скилы
applied_changes:
  - change_id: "CHG-001"
    date: "2026-03-20"
    coach_ticket: "COACH-005"
    target_skill: "growth-marketing-lead"
    changed_files:
      - "src/skills/growth-marketing-lead/knowledge/market-sizing.md"
      - "src/skills/growth-marketing-lead/workflows/analyze.md"
    change_type: "improve"  # improve | fix | add | refactor
    description: "Добавлен knowledge-модуль market-sizing, уточнён воркфлоу анализа"
    based_on_tickets:
      - "GML-001"
      - "GML-003"

# Скилы, прошедшие аудит
audited_skills:
  - skill_name: "growth-marketing-lead"
    last_audit_date: "2026-03-20"
    coach_ticket: "COACH-004"
    score: 72
    status: "NEEDS_WORK"
```

## Правила работы с бэклогом

### Перед началом анализа (ОБЯЗАТЕЛЬНО)

1. Прочитай `.workflow/coach-backlog.yaml`
2. Проверь, какие тикеты уже проанализированы (`analyzed_tickets`)
3. **Пропусти** тикеты, которые уже есть в бэклоге
4. Проверь, какие правки уже внесены (`applied_changes`) в целевой скил
5. **Учитывай** уже внесённые правки — не предлагай то, что уже исправлено

### После завершения анализа (ОБЯЗАТЕЛЬНО)

1. Добавь каждый проанализированный тикет в `analyzed_tickets`
2. Добавь каждую внесённую правку в `applied_changes`
3. Если был аудит — обнови `audited_skills`
4. Обнови `last_updated`

### Генерация ID

- `change_id`: `CHG-{порядковый номер, 3 цифры}` — следующий после максимального в бэклоге

## Антипаттерны

- **Повторный анализ** — анализировать тикет, который уже в бэклоге
- **Дублирование правок** — предлагать изменение, которое уже в `applied_changes`
- **Забыть записать** — внести правку, но не добавить в бэклог
- **Пустой бэклог** — если файла нет, создай его с пустыми секциями

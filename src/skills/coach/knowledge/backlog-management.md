# Управление бэклогом коуча

Бэклог `.workflow/coach-backlog.yaml` — единственный источник правды о проанализированных тикетах и внесённых правках.

## Структура бэклога

```yaml
version: 1
last_updated: "2026-03-20"

analyzed_tickets:
  - ticket_id: "XXX-001"
    ticket_file: "tickets/done/XXX-001.md"
    analyzed_date: "2026-03-20"
    coach_ticket: "COACH-005"
    findings_count: 3
    summary: "Краткое описание findings"

applied_changes:
  - change_id: "CHG-001"
    date: "2026-03-20"
    coach_ticket: "COACH-005"
    target_skill: "example-skill"
    changed_files: ["skills/example-skill/knowledge/module.md"]
    change_type: "improve"  # improve | fix | add | refactor
    description: "Что и зачем изменено"
    based_on_tickets: ["XXX-001"]

audited_skills:
  - skill_name: "example-skill"
    last_audit_date: "2026-03-20"
    coach_ticket: "COACH-004"
    score: 72
    status: "NEEDS_WORK"
```

## Правила работы

### Перед началом (ОБЯЗАТЕЛЬНО)

1. Прочитай бэклог → пропусти тикеты из `analyzed_tickets` → учитывай `applied_changes`

### После завершения (ОБЯЗАТЕЛЬНО)

1. Добавь проанализированные тикеты, внесённые правки, результаты аудита
2. Обнови `last_updated`
3. `change_id`: `CHG-{порядковый номер, 3 цифры}` — следующий после максимального

## Компрессия бэклога

**Когда:** после записи, если размер > 500 строк. **Цель:** < 300 строк.

### Что сжимать

**1. `analyzed_tickets`** — группировка по скилу: тикеты с похожими findings → одна запись с `consolidated_from` и summary ключевых findings + ссылки на CHG.

**2. `applied_changes`** — группировка связанных: CHG одной проблемы (цепочка итераций) → одна запись с `consolidated_from`, объединёнными `changed_files` и summary.

**3. Не сжимать:** последние 10 записей каждой секции, уникальные findings, `audited_skills`.

### Формат консолидированной записи

Добавляй `consolidated_from: [...]` для трассировки. Summary — ключевые findings + ссылки на CHG.

## Антипаттерны

- **Повторный анализ** уже проанализированного тикета
- **Дублирование правок** — предлагать то, что уже в `applied_changes`
- **Забыть записать** — внести правку без записи в бэклог
- **Бесконечный рост** — не сжимать при > 500 строк

<!-- РАСШИРЕНИЕ: добавляй правила ведения бэклога ниже -->

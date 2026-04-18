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

## Ad-hoc анализы (без тикета)

Если стейкхолдер запрашивает анализ артефакта напрямую (лог, декомпозиция, план) — без формального тикета COACH-* — результат записывается в `analyzed_tickets` с полем `source: ad_hoc`:

```yaml
analyzed_tickets:
  - source: ad_hoc
    artifact: "pipeline_2026-04-06_16-36-02.log"  # путь/имя артефакта
    analyzed_date: "2026-04-18"
    findings_count: 4
    summary: "Краткое описание findings"
```

**Поля `ticket_id` и `ticket_file` — опциональны** для записей с `source: ad_hoc`, так как тикета не существует.

**⛔ Не используй нестандартные поля** (например, `last_action`) для хранения записей об анализе — они не являются частью схемы, не проходят дедупликацию и молча перезаписываются при следующей записи в тот же ключ (дублирующие ключи в YAML невалидны).

## Антипаттерны

- **Повторный анализ** уже проанализированного тикета или артефакта
- **Дублирование правок** — предлагать то, что уже в `applied_changes`
- **Забыть записать** — внести правку без записи в бэклог
- **Бесконечный рост** — не сжимать при > 500 строк
- **Non-schema поля** — записывать ad-hoc анализы в `last_action` или любой другой ключ вне официальной схемы вместо `analyzed_tickets` с `source: ad_hoc`

<!-- РАСШИРЕНИЕ: добавляй правила ведения бэклога ниже -->

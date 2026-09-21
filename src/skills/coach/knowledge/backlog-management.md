# Управление бэклогом коуча

Бэклог `.workflow/coach-backlog.yaml` — единственный источник правды о проанализированных тикетах и результатах аудита скилов.

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

audited_skills:
  - skill_name: "example-skill"
    last_audit_date: "2026-03-20"
    coach_ticket: "COACH-004"
    score: 72
    status: "NEEDS_WORK"
```

## Секции бэклога

- **`analyzed_tickets[]`** — защита от повторного анализа тикетов/логов, не приведших к правке скила. Позволяет пропустить уже проанализированный материал.
- **`audited_skills[]`** — snapshot scores скилов в момент аудита. Позволяет отслеживать динамику качества скилов.

## Правила работы — см. SKILL.md «Обязательный шаг: Тест» (ПЕРЕД: прочитать бэклог, пропустить `analyzed_tickets`; ПОСЛЕ: добавить тикеты/аудит, обновить `last_updated`).

## История правок скилов — в git

```bash
git log -- .workflow/src/skills/coach/                    # все правки скила coach
git log -- .workflow/src/skills/coach/tests/cases/        # все созданные/изменённые тесты
git log --follow -- .workflow/src/skills/coach/SKILL.md   # история конкретного файла
git blame .workflow/src/skills/coach/SKILL.md             # кто что написал
```

## Миграционная заметка

`applied_changes[]` удалена из бэклога; старые CHG — `git show <commit-before-migration>:.workflow/coach-backlog.yaml`; принципы старых CHG — в тест-кейсах через `origin.chg`; `legacy_*` архив не поддерживается.

**Антипаттерны:** повторный анализ уже проанализированного тикета; анализ/аудит без записи в бэклог.

<!-- РАСШИРЕНИЕ: добавляй правила ведения бэклога ниже -->

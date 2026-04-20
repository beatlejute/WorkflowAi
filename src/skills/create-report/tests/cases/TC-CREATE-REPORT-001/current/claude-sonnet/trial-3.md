Я прочитал рубрику (`root-cause-attribution.md`) и алгоритм шага 6.1 из `workflows/standard.md`. Теперь у меня есть всё для точной атрибуции.

---

## Фрагмент секции «Проблемы» — тикет QA-001

```markdown
### Пропущенные тикеты (⏭ skipped)

- Тикет QA-001: ⏭ skipped стейджем `check-relevance` в строке лога 2166
  с причиной `dependencies_inactive`.
  Лог: `pipeline_2026-04-06_12-00-00.log:2166`
```

---

**Пояснение атрибуции:**

Строка лога 2166 явно идентифицирует виновника:

```
[check-relevance] COMPLETE stage="check-relevance" ticket_id="QA-001"
                  status="irrelevant" reason="dependencies_inactive"
```

- **Стейдж-виновник:** `check-relevance` — это **скил**, исполняемый агентом (не путать с `check-conditions`, который является **скриптом** `.workflow/src/scripts/check-conditions.js`).
- **Причина:** `dependencies_inactive` — зависимости тикета неактивны в момент запуска пайплайна.
- **Атрибуция из REPORT-002 (`check-conditions`) — неверна** и в текущий отчёт не переносится. Текущий лог однозначно указывает на `check-relevance`. Согласно правилу шага 6.1: каждый инцидент верифицируется по своему логу независимо.

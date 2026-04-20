По одному совпадению для каждого тикета — коллизий нет.

---

## Итог декомпозиции

Создано **3 тикета** в `.workflow/tickets/backlog/`:

| Тикет | Тип | Executor | Приоритет | Зависимости | DoD (дословно из плана) |
|-------|-----|----------|-----------|-------------|------------------------|
| IMPL-1 | impl | agent | 2 (high) | — | Функция buildTargetPrompt() реализована в src/scripts/run-skill-tests.js |
| QA-1 | qa | agent | 2 (high) | IMPL-1 | Юнит-тест TC-PROMPT-001 написан и зелёный |
| DOCS-1 | docs | agent | 3 (medium) | — | README обновлён разделом про prompt assembly |

**Цепочка:** IMPL-1 → QA-1 (DOCS-1 параллельно)

**Исключено из DoD:** «Коммит feat(runner): buildTargetPrompt создан» — git-операция стейкхолдера, не агента-исполнителя (Проверка 7, config.yaml не содержит типа тикета для git-операций).

---

### Рекомендации для следующего плана (вне scope)

- Создать `../shared/README.md` с реестром observable-инвариантов — причина: отсутствие реестра делает невозможным применение Условий Б и В (парные тикеты ручной проверки по observable-зоне) при декомпозиции будущих планов.

---

```
---RESULT---
status: default
tickets_created:
  - .workflow/tickets/backlog/IMPL-1.md
  - .workflow/tickets/backlog/QA-1.md
  - .workflow/tickets/backlog/DOCS-1.md
decomposition_summary:
  plan_dod_items: 4
  tickets_created: 3
  git_ops_excluded: 1
  breakdown:
    DoD-1 (реализация функции) → IMPL-1
    DoD-2 (юнит-тест TC-PROMPT-001) → QA-1 (depends: IMPL-1)
    DoD-3 (README раздел) → DOCS-1
    DoD-4 (коммит) → ИСКЛЮЧЁН (git-операция стейкхолдера, Проверка 7)
ids_allocated_from:
  IMPL: 1
  QA: 1
  DOCS: 1
note: "id_ranges_json не был передан — инфраструктурная ошибка стадии allocate-ticket-ids. Нумерация начата с 1, так как tickets/ полностью пуст."
---RESULT---
```

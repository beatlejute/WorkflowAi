Один файл — коллизий нет.

---

## Итог декомпозиции

Создано **3 тикета** в `.workflow/tickets/backlog/`:

| Тикет | Тип | Executor | Приоритет | Зависимости | DoD (дословно из плана) |
|-------|-----|----------|-----------|-------------|------------------------|
| IMPL-001 | impl | agent | 2 (High) | — | Функция buildTargetPrompt() реализована в src/scripts/run-skill-tests.js |
| QA-001 | qa | agent | 2 (High) | IMPL-001 | Юнит-тест TC-PROMPT-001 написан и зелёный |
| DOCS-001 | docs | agent | 3 (Medium) | — | README обновлён разделом про prompt assembly |

**Цепочка:** IMPL-001 → QA-001; DOCS-001 параллельно IMPL-001.

**Исключено из DoD всех тикетов:** «Коммит feat(runner): buildTargetPrompt создан» — git-операция стейкхолдера, не агента-исполнителя (Проверка 7 executor-атомарности; git-операции не соответствуют HUMAN-семантике → тикет не создаётся, действие вне scope декомпозиции).

---

### Рекомендации для следующего плана (вне scope)

- Создать `../shared/README.md` с реестром observable-инвариантов — причина: отсутствие реестра делает невозможным применение Условий Б и В (парные тикеты ручной проверки по observable-зоне) при декомпозиции будущих планов.

---

```
---RESULT---
status: default
tickets_created:
  - .workflow/tickets/backlog/IMPL-001.md
  - .workflow/tickets/backlog/QA-001.md
  - .workflow/tickets/backlog/DOCS-001.md
decomposition_summary:
  plan_dod_items: 4
  tickets_created: 3
  git_ops_excluded: 1
  breakdown:
    DoD-1 (реализация функции) → IMPL-001
    DoD-2 (юнит-тест TC-PROMPT-001) → QA-001 (depends: IMPL-001)
    DoD-3 (README раздел) → DOCS-001
    DoD-4 (коммит) → ИСКЛЮЧЁН (git-операция стейкхолдера, Проверка 7 executor-атомарности)
ids_allocated_from:
  IMPL: 1
  QA: 1
  DOCS: 1
note: "id_ranges_json не передан — инфраструктурная ошибка стадии allocate-ticket-ids. Нумерация начата с 001: все поддиректории .workflow/tickets/ пусты, коллизий нет."
---RESULT---
```

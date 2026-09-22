Три тикета созданы.

---

### Рекомендации для следующего плана (вне scope)

- Добавить `.workflow/src/skills/shared/README.md` с реестром observable-инвариантов — причина: его отсутствие делает невозможным применение Условий Б и В (парные тикеты ручной проверки по observable-зоне) при декомпозиции будущих планов.

---

```
---RESULT---
status: default
tickets_created:
  - .workflow/tickets/backlog/IMPL-1.md
  - .workflow/tickets/backlog/IMPL-2.md
  - .workflow/tickets/backlog/QA-1.md
decomposition_summary:
  plan_dod_items: 3
  tickets_created: 3
  breakdown:
    DoD 1 → IMPL-1 (создать компонент)
    DoD 2 → IMPL-2 (i18n ключ)
    DoD 3 → QA-1 (юнит-тесты, depends_on IMPL-1)
ids_allocated_from:
  IMPL: 1
  QA: 1
capabilities_registry: [text, multimodal]
---RESULT---
```

---
id: IMPL-907
title: "Реализовать функцию retry с экспоненциальным backoff"
priority: 2
type: impl
required_capabilities:
  - text
created_at: "2026-04-29T00:00:00Z"
updated_at: "2026-04-29T00:00:00Z"
completed_at: ""
parent_plan: ""
parent_task: ""
dependencies: []
conditions: []
context:
  files: []
  references: []
  notes: "Это регрессионная фикстура для скила execute-task. Задача может потребовать нескольких попыток (retry с разными подходами). Не записывай прогресс попыток в frontmatter."
complexity: medium
tags:
  - retry
  - frontmatter-immutable-fixture
status: in-progress
---

## Описание

Реализовать функцию `retryWithBackoff(fn, options)` в `src/utils/retry.mjs` с экспоненциальным backoff (base 100ms, max 5 attempts, jitter ±25%).

Если первая попытка реализации даст падающие тесты, итерируй: каждую попытку зафиксируй в **теле тикета** (секция Result, подсекция «Журнал попыток»), указав что менялось и почему. **Frontmatter не трогать ни при каких условиях** — поля `notes`, `tags`, `context.*` управляются создателем тикета и пайплайном.

## Definition of Done

- [ ] Функция `retryWithBackoff` реализована в `src/utils/retry.mjs`
- [ ] Покрытие unit-тестами: happy-path + max-attempts-exceeded + jitter-bounds
- [ ] Все unit-тесты проходят (`npx vitest src/utils/retry`)
- [ ] Журнал попыток (если их было > 1) зафиксирован в Result, **не во frontmatter**

## Result

<!-- Заполняется агентом -->

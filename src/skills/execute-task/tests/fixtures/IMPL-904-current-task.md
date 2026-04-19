---
id: IMPL-904
title: "Добавить валидацию email в форме регистрации"
priority: 3
type: impl
required_capabilities: []
created_at: "2026-04-19T00:00:00Z"
updated_at: "2026-04-19T00:00:00Z"
completed_at: ""
parent_plan: ""
parent_task: ""
dependencies: []
conditions: []
context:
  files: []
  references: []
  notes: |
    Сценарий для регрессионного теста скила execute-task (TC-EXECUTE-TASK-004) —
    текущий тикет в in-progress/.
    ⚠️ Workdir изолированный: нет package.json, src/, node_modules. Не ищи их — это
    test-sandbox. В .workflow/tickets/ существуют два файла: текущий тикет
    (in-progress/IMPL-904.md) и чужой тикет с опечаткой (done/TASK-905.md).
    Работай только со своим тикетом.
complexity: simple
tags:
  - impl
---

## Описание

Добавить валидацию формата email в форму регистрации пользователя.

## Критерии готовности

- [ ] Валидация добавлена
- [ ] Unit-тест покрывает happy-path и edge-cases

## Result

<!-- Заполняется исполнителем -->

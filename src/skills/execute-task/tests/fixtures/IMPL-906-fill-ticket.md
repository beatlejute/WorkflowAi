---
id: IMPL-906
title: "Написать функцию slugify и покрыть unit-тестами"
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
    Сценарий для регрессионного теста скила execute-task (TC-EXECUTE-TASK-005) —
    проверяет физическое обновление файла тикета после выполнения.
    ⚠️ Workdir изолированный: нет package.json, src/, node_modules. Не ищи их — это
    test-sandbox. Работай только с файлом этого тикета
    (.workflow/tickets/in-progress/IMPL-906.md). Считай, что функция slugify и
    unit-тесты уже написаны — задача теста в том, чтобы зафиксировать это в DoD
    (чекбоксы → [x]) и в Result (summary + изменённые файлы + заметки).
complexity: simple
tags:
  - impl
---

## Описание

Добавить функцию `slugify(text)` в utils-модуль и покрыть её unit-тестами (happy-path + edge cases).

## Критерии готовности

- [ ] Функция добавлена
- [ ] Unit-тесты покрывают happy-path
- [ ] Unit-тесты покрывают edge cases (пустая строка, кириллица)

## Result

<!-- Заполняется исполнителем -->

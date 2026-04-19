---
id: QA-901
title: "Проверить клик по кнопке Submit"
priority: 3
type: review
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
    Сценарий для регрессионного теста скила execute-task (TC-EXECUTE-TASK-001).
    ⚠️ Workdir изолированный: нет package.json, src/, node_modules. Не ищи их — это
    не реальный проект, а test-sandbox. Работай только с файлом этого тикета
    (.workflow/tickets/in-progress/QA-901.md). Результат проверки кнопки
    (симулированный дефект) фиксируй внутри этого файла — в чекбоксах DoD и в Result.
complexity: simple
tags:
  - qa
  - button
---

## Описание

Ручная проверка кнопки Submit на странице формы обратной связи.

## Критерии готовности (Definition of Done)

- [ ] Открыть страницу формы
- [ ] Кликнуть по кнопке Submit
- [ ] Зафиксировать результат клика

## Result

<!-- Заполняется исполнителем -->

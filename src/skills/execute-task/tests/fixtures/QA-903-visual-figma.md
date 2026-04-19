---
id: QA-903
title: "Проверить визуальное соответствие кнопки макету Figma"
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
    Сценарий для регрессионного теста скила execute-task (TC-EXECUTE-TASK-003).
    ⚠️ Workdir изолированный: нет package.json, src/, node_modules, нет реального UI.
    Не ищи их — это test-sandbox. Работай только с файлом этого тикета
    (.workflow/tickets/in-progress/QA-903.md). Макет Figma условный — агент должен
    предложить способ верификации визуального критерия, не обращаясь к внешним
    системам. Формулировку фиксируй в Result файла тикета.
complexity: simple
tags:
  - qa
  - visual
---

## Описание

Проверить, что кнопка «Submit» в форме обратной связи визуально соответствует макету Figma (цвет, радиус, отступы, типографика).

## Критерии готовности

- [ ] Кнопка визуально соответствует макету Figma

## Result

<!-- Заполняется исполнителем -->

---
id: IMPL-908
title: "Добавить описание singleton-семантики в README проекта"
priority: 2
type: impl
required_capabilities: []
created_at: "2026-05-01T12:00:00Z"
updated_at: "2026-05-01T12:00:00Z"
completed_at: ""
parent_plan: ""
parent_task: ""
dependencies: []
conditions: []
context:
  files:
    - src/lib/README.md
  references: []
  notes: "Файл README.md уже существует в корне проекта, но редактировать нужно src/lib/README.md (указан в context.files)."
complexity: simple
tags: []
---
## Описание

Добавить в `src/lib/README.md` описание singleton-семантики: как работает pipeline lock, как восстанавливаться после краша.

## Критерии готовности (Definition of Done)

- [ ] В файл `src/lib/README.md` добавлена секция «Singleton Semantics»
- [ ] Секция описывает структуру `.pipeline.lock`
- [ ] Упомянуты команды `workflow run --force` и `workflow stop`

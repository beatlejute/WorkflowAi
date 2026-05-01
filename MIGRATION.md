# Руководство по миграции

## Upgrade to 1.3.0

Версия workflow-ai@1.3.0 вводит новые типы стейджев и статусов для расширенной маршрутизации и управления задачами. Данное руководство описывает шаги миграции для проектов с кастомными (eject'нутыми) pipeline.yaml.

### Что изменилось

- Добавлен новый тип стейджа `mark-blocked` для автоматической блокировки тикетов с расширением frontmatter-полей
- Добавлен новый тип стейджа `manual-gate-human` для ручного контроля перед продолжением
- Новый статус `human_ready` для тикетов, ожидающих ручного решения
- Добавлен approval-hook в `move-ticket.js` для проверки ожидающих решений
- Расширен START-лог идентификатором тикета
- Исправлено сохранение `created_at` в файлах одобрений

### Шаги миграции для eject'нутых pipeline.yaml

Если вы используете кастомный `pipeline.yaml` (выполнили `workflow eject pipeline`), рекомендуется выполнить следующие шаги:

#### 1. Добавьте стейдж `mark-blocked`

Добавьте новый тип стейджа в ваш pipeline.yaml для возможности автоматической блокировки:

```yaml
stages:
  check-and-block:
    type: mark-blocked
    reason_field: "priority"
    threshold: "high"
    auto_blocked_reason: "High priority blocking"
    auto_blocked_attempts: 1
    goto:
      blocked: notify-team
      unblocked: continue-processing
```

#### 2. Добавьте стейдж `manual-gate-human`

Для добавления точки ручного контроля:

```yaml
stages:
  human-approval:
    type: manual-gate-human
    timeout_seconds: 86400
    poll_interval_ms: 5000
    goto:
      human_ready: wait-for-human-decision
      approved: continue-deploy
      rejected: rollback-deploy
```

#### 3. Обновите ключи `goto` в `pick-first-task` и `increment-task-attempts`

Добавьте обработку нового статуса `human_ready` в goto-конфигурациях:

```yaml
# В pick-first-task
goto:
  human_ready: wait-human-decision
  default: process-next

# В increment-task-attempts
goto:
  human_ready: escalate-to-human
  default: retry-or-fail
```

**Важно:** Без добавления `human_ready` в ключи `goto`, runner при достижении статуса `human_ready` пойдет в `goto.default` или `'end'` (тикет тихо проигнорируется, но pipeline не упадет). Это безопасное поведение, однако может привести к непредсказуемому выполнению если не обработано явно.

#### 4. Добавьте `mark-human-rejected` стейдж (опционально)

Для обработки отклоненных задач:

```yaml
stages:
  handle-rejection:
    type: mark-human-rejected
    rejection_reason_field: "comment"
    auto_blocked_reason: "Human rejected"
    goto:
      rejected: notify-reporter
      end: archive-ticket
```

### Поведение по умолчанию

Для проектов, не выполняющих eject pipeline.yaml, **поведение обновляется автоматически**. Новый файл `pipeline.yaml` из репозитория будет содержать все необходимые изменения и будет использоваться по умолчанию.

### Frontmatter и обратная совместимость

Frontmatter тикетов с новым статусом `blocked` получает новые поля — `auto_blocked_reason`, `auto_blocked_attempts`, `auto_blocked_at`. Парсеры тикетов должны быть толерантны к отсутствию этих полей (старые тикеты без изменений продолжают работать корректно).

### Ссылка на пример конфигурации

Смотрите `docs/samples/pipeline-with-human-gate.yaml` для полного примера pipeline с поддержкой `manual-gate-human` и `mark-blocked` стейджев.

### Пример миграции

**До (pipeline.yaml до 1.3.0):**
```yaml
stages:
  validate:
    type: validate
    goto:
      valid: process
      invalid: reject
  process:
    type: process
    goto:
      done: end
      fail: retry
```

**После (pipeline.yaml после 1.3.0):**
```yaml
stages:
  validate:
    type: validate
    goto:
      valid: check-blocked
      invalid: reject
  check-blocked:
    type: mark-blocked
    auto_blocked_reason: "Validation failed"
    goto:
      blocked: notify-blocked
      unblocked: process
  process:
    type: process
    goto:
      human_ready: wait-human
      done: end
      fail: retry
  wait-human:
    type: manual-gate-human
    goto:
      approved: end
      rejected: rollback
```

### Проверка миграции

1. Убедитесь что все ключи `goto` в вашем pipeline.yaml содержат обработку для `human_ready` где это необходимо
2. Проверьте что `pick-first-task.js` и `increment-task-attempts.js` обновлены до версии 1.3.0
3. Протестируйте pipeline с тикетом, который должен достигнуть статуса `human_ready`
4. Убедитесь что тикет не "теряется" и корректно обрабатывается через `goto.default` если соответствующий ключ не найден
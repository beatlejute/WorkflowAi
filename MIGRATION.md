# Руководство по миграции

## Upgrade to 1.24.0

Версия меняет то, как закрывается план, и как считается время начала работы тикета. Вручную в проектах делать почти нечего: `workflow update` обновляет шаблоны, скилы и поставляемый конфиг.

**Что стоит проверить после обновления.**

- **План закрывает только стадия `complete-plan`.** `pick-next-task` больше не помечает план выполненным по счёту тикетов: в логе он пишет `all N tickets done — closing is up to complete-plan`. Если план не закрывается, причина видна в логе стадии: `[WARN] <ID>: blocked — <причина>` для тикетов в `blocked/` и `[WARN] <ID>: записан дефект без исправления` для записанных дефектов.
- **План с записанным дефектом не закроется, пока дефект не исправлен.** Дефект — подраздел «### Найденные дефекты» в разделе результата тикета (`нет` и равнозначные записи дефектом не считаются). Исправлением признаётся более поздний готовый тикет того же плана, который называет записавший тикет в `unblocks` или `supersedes` либо фразой «Исправление дефекта <ID>» в заголовке или описании. Пары дефект → исправление заводит разбиение пробелов само; вручную достаточно не забывать поле или фразу.
- **Тикеты без метки `started_at` не проверяются на «файл не изменён».** Метку ставит код при первом входе тикета в `in-progress/`; у тикетов, созданных до обновления, её нет — проверка пропускается (не проваливается). Новые тикеты получают метку сами.
- **Человеческий тикет с правкой файлов проекта вне `context.files` уходит на ревью агентом** (предупреждение `human_out_of_scope_changes`), а не закрывается скриптом без модели. Стадия `review-result-legacy` должна оставаться в конфиге и иметь подходящего агента.
- **Застрявший план больше не выглядит как «изменений нет».** Стадия `check-report-needed` отдаёт `stuck` с ID и причиной блокировки, пайплайн завершается строкой `Pipeline stopped: plan … is stuck (…) — needs a human decision`. Проектам с собственной копией конфигов (`workflow eject-configs`) нужно добавить ключ у стадии `check-report-needed`:

```yaml
      goto:
        needed: create-report
        analyze: analyze-report
        close_plan: complete-plan
        stuck: end
        unchanged: end
```

- **Ответ на узле паузы и в терминале требует строку перехода** (`RAILS: P6S3` для `create-plan`, `RAILS: P8S2` для коуча): требования печатает `rails goto` в терминальный узел и в узел паузы, `rails status` показывает переходы так же, как `goto`.
- **Запуск `verify-atomicity.js --activate` из скила запрещён** — план активирует только стадия пайплайна. Ошибка в логе: отказ рельс с причиной «план активирует только стадия».

## Upgrade to 1.23.0

Скрипт `verify-atomicity.js` переводит план в `active` только с флагом `--activate`. Без флага он лишь проверяет тикеты: агент декомпозиции запускает его для самопроверки и статус плана трогать не должен.

Поставляемый `configs/pipeline.yaml` уже передаёт флаг. Проектам с собственной копией конфигов (`workflow eject-configs`) нужно добавить его в args агента `script-verify-atomicity` — **без флага план не станет `active` никогда**: каждый цикл пайплайна снова запускает `verify-atomicity`, а закрытие плана (`complete-plan.js`) ищет только план в `active` — план не закроется, даже когда все его тикеты выполнены:

```yaml
    script-verify-atomicity:
      command: "node"
      args: [".workflow/src/skills/decompose-plan/scripts/verify-atomicity.js", "--activate"]
```

Признак, что флага нет: после декомпозиции план остаётся `approved`, в логе стадии `verify-atomicity` — `plan_status_reason: activation_not_requested`. Обратный случай безопасен: старая копия скрипта с новым конфигом активирует план, как раньше.

Пайплайн, запущенный до `workflow update`, держит в памяти прежний конфиг: после обновления его нужно перезапустить.

`workflow update` теперь приводит `.workflow/templates/` проекта к шаблонам пакета: отличающийся шаблон перезаписывается. Правки шаблонов в проекте держать нельзя — их затрёт следующий `update`.

## Shared knowledge: `.workflow/src/skills/shared/` → `.workflow/shared/`

Скилы читают shared knowledge проекта из `.workflow/shared/`. `workflow update` (и `workflow init`) переносит старый каталог сам и пишет в вывод `✅ Shared knowledge moved`. Вручную нужно только:

- если update предупредил `.workflow/shared/ already has …` — сравнить файлы, оставшиеся в `.workflow/src/skills/shared/`, с одноимёнными в `.workflow/shared/`, перенести нужное и удалить старый каталог;
- поправить старый путь в открытых тикетах и планах проекта (описание, `context.files`, записи проверки) и в коде проекта, который читает shared (например, тестах).

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
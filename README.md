
- Добавлено упоминание `human-gate` в разделе про runner-стадии (пример конфига в pipeline.yaml: human-review-step типа manual-gate).
- Добавлено упоминание `mark-blocked` как механизм нотификации autoblocked-тикетов (поля auto_blocked_reason/attempts/at).

## Runner-стадии

В системе поддерживаются различные типы стадий для управления процессами разработки:

### Human Gate

`human-gate` — стадия ручного контроля, которая требует вмешательства человека для продолжения выполнения пайплайна. Используется для критических точек, где необходима ручная проверка или утверждение.

**Условия срабатывания:**
- Стадия `manual-gate-human` блокирует пайплайн до ручного снятия gate
- Gate снимается через команду `move-ticket.js <id> unblock`
- Поддерживает настройку таймаутов и условий повторных попыток

**Пример конфигурации pipeline.yaml:**
```yaml
stages:
  - name: manual-gate-human
    type: manual-gate-human
    config:
      timeout: 3600  # 1 hour
      max_attempts: 3
      message: "Requires human approval before deployment"
```

Пример полного файла `pipeline.yaml` доступен в `docs/samples/pipeline-with-human-gate.yaml`.

### Autoblock notifications

Для автоматического блокировки тикетов при возникновении проблем используется механизм `mark-blocked`. Блокированные тикеты получают дополнительные поля в frontmatter для отслеживания причин и попыток:

- `auto_blocked_reason` — причина автоматической блокировки
- `auto_blocked_attempts` — количество попыток разблокировки
- `auto_blocked_at` — время автоматической блокировки
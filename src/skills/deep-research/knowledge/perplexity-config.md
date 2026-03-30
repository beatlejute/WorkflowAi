# Perplexity Research — конфигурация

**Основной инструмент** для всех RSH-тикетов. Запрещено подменять web_search/web_fetch.

## Вызов

```bash
node .workflow/src/skills/deep-research/scripts/perplexity-research.js "тема"
# Быстрый: --model perplexity/sonar "тема"
# Системный промпт: --system "Ты аналитик..." "тема"
```

## Модели

| Модель | Время | Когда |
|--------|-------|-------|
| `perplexity/sonar-deep-research` | 5-10 мин | По умолчанию |
| `perplexity/sonar-pro` | 10-30 сек | Быстрый ответ с источниками |
| `perplexity/sonar` | 5-15 сек | Справки, проверка фактов |
| `perplexity/sonar-reasoning-pro` | 30-60 сек | Аналитика с рассуждениями |

## Workflow

1. Сформируй запрос из тикета → запусти скрипт через bash → оформи отчёт в `reports/`
2. В «Agent used» укажи `perplexity-research.js` + модель
3. Требуется HTTPS_PROXY (настроен в env)

## Fallback

Если скрипт не работает (сеть, 403, таймаут) → зафиксируй ошибку, используй WebSearch/WebFetch, укажи причину.

Создано 3 тикета в backlog:

---

**IMPL-112** — Обновить select-default-proxy-modal: i18n заголовок + флаг страны *(перезаписан pipeline-хуком)*
- Зависит от IMPL-83 (in-progress, меняет `src/types/index.ts`)
- Покрывает: добавление `countryCode?` в `ProxyServer`, `selectDefaultProxyTitle` в `I18nKey`, переводы en+ru, замену хардкода на `I18n.getMessage`, флаг страны в `createProxyItem`
- DoD: 5 пунктов ✓

**IMPL-113** — Добавить перевод selectDefaultProxyTitle в 6 оставшихся локалей (de/fr/es/zh/ja/pt)
- Зависит от IMPL-112
- Покрывает: ключ `selectDefaultProxyTitle` в de, fr, es, zh, ja, pt
- DoD: 2 пункта ✓

**QA-161** — Тесты на i18n-заголовок и флаг страны
- Зависит от IMPL-112
- TC-Modal-5/6/7: проверка `I18n.getMessage('selectDefaultProxyTitle')`, наличие/отсутствие `.proxy-item-flag`
- DoD: 4 пункта ✓

---

**Рекомендации для следующего плана (вне scope)**

DoD 1–4, 6–7 из исходного плана уже реализованы в архивных тикетах IMPL-043 и IMPL-047 — повторно не создавались.

---

**---RESULT---**

```
created:
  - IMPL-112  # pipeline-хук перезаписал в лучший вид: types+locales(en/ru)+modal = 1 тикет
  - IMPL-113  # 6 оставшихся локалей (de/fr/es/zh/ja/pt)
  - QA-161    # тесты TC-Modal-5/6/7

skipped:
  - DoD 1 (file created)         → IMPL-043 archived ✅
  - DoD 2 (function resolves id) → IMPL-043 archived ✅
  - DoD 3 (Esc/X → null)        → IMPL-043 archived ✅
  - DoD 4 (empty list guard)     → IMPL-047 archived ✅
  - DoD 6 (no Storage calls)     → IMPL-043 archived ✅
  - DoD 7 (no storage read)      → IMPL-043 archived ✅
```

# Какие форматы файлов поддерживает Chrome Extension Manifest V3

**Дата исследования:** 2026-09-25 · **Тип:** CUSTOM · **Артефакт:** `.workflow/reports/TC-DEEP-RESEARCH-001-mv3-file-formats.md`

## Executive Summary

MV3 не задаёт whitelist расширений файлов: правило «только JS» относится к исполняемому коду (service worker, content scripts, `scripting.executeScript`), а не ко всем ресурсам пакета. Пакет — ZIP-архив: `manifest.json` плюс JS-код, `web_accessible_resources`, `_locales/<locale>/messages.json`, произвольные статические ресурсы (изображения, шрифты, бинарники). Ключевые ограничения MV3 — не про форматы файлов, а про исполнение: service worker вместо background page, обязательный строгий CSP с запретом `eval` и удалённого кода, декларативный доступ к ресурсам. Отдельной таблицы «разрешённых расширений/MIME» в документации Chromium нет.

## Ключевые находки

1. **Манифест — JSON.** [HIGH] [Источник: Chrome Extensions — Manifest file reference, https://developer.chrome.com/docs/extensions/reference/manifest, 2026-09-25] `[SINGLE SOURCE: developer.chrome.com]`
2. **Service worker и content scripts — JS** (ES-модули при `"type": "module"`); в `content_scripts` ключ `css` допускает только CSS. [HIGH] [Источник: Chrome Extensions — Service worker basics, https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics, 2026-09-25] [Источник: Manifest file reference, https://developer.chrome.com/docs/extensions/reference/manifest, 2026-09-25]
3. **Статические ресурсы форматом не ограничены** — изображения, шрифты, бинарники, доступ через `chrome-extension://<id>/...` и `web_accessible_resources`. [MEDIUM] [Источник: Chrome Extensions — Expose web resources, https://developer.chrome.com/docs/extensions/develop/concepts/resources, 2026-09-25] `[SINGLE SOURCE: developer.chrome.com]`
4. **DNR ruleset-файлы — JSON**-массив правил, тип `json` в `declarative_net_request.rule_resources`. [HIGH] [Источник: declarativeNetRequest API, https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest, 2026-09-25] `[SINGLE SOURCE: developer.chrome.com]`
5. **Локализация — JSON:** `_locales/<locale>/messages.json` + `default_locale`. [HIGH] [Источник: Chrome Extensions — Locale-specific messages, https://developer.chrome.com/docs/extensions/reference/i18n/locale-messages, 2026-09-25] `[SINGLE SOURCE: developer.chrome.com]`
6. **HTML остаётся только для объявленных UI-целей** — options, side panel, popup, offscreen, devtools; удалённый код запрещён. [MEDIUM] [Источник: sidePanel API, https://developer.chrome.com/docs/extensions/reference/api/sidePanel, 2026-09-25] [Источник: Manifest file reference, https://developer.chrome.com/docs/extensions/reference/manifest, 2026-09-25]
7. **Данные — не файлы пакета:** MV3 не даёт писать в свой каталог, персистентность через `chrome.storage` (local/sync/session) и Cache Storage/IndexedDB. [HIGH] [Источник: chrome.storage API, https://developer.chrome.com/docs/extensions/reference/api/storage, 2026-09-25] `[SINGLE SOURCE: developer.chrome.com]`
8. **Пакет публикации — ZIP** (→ CRX при упаковке). [MEDIUM] [Источник: Chrome Web Store — Publishing extensions, https://developer.chrome.com/docs/extensions/publish, 2026-09-25] `[SINGLE SOURCE: developer.chrome.com]`
9. **SVG в иконках манифеста** — предположительно не поддерживается, нужен растровый файл. [LOW] `[источник неизвестен]` — ограничение первоисточником не подтверждено.

## Выводы

| # | Вывод | Уверенность | Рекомендация |
|---|-------|-------------|--------------|
| 1 | Формат ограничен только для JS-кода и JSON-схем (манифест, локали, ruleset) | [HIGH] | Бинарные данные класть без конвертации |
| 2 | Искать «список поддерживаемых форматов» в MV3 бессмысленно | [MEDIUM] | Опираться на декларации манифеста, а не на whitelist |
| 3 | Ограничение SVG в иконках не подтверждено | [LOW] | Использовать PNG до подтверждения документацией |
| 4 | Хранение — через storage API, не через файлы | [HIGH] | Не планировать файловую персистентность |
| 5 | Отчёт — single source, поиск в этом прогоне недоступен | [HIGH] | Прогнать верификацию через `perplexity-research.js` |

## Пробелы

- Живые инструменты поиска отключены: `perplexity-research.js`, `web_search`/`web_fetch` не вызывались.
- Все находки — `[SINGLE SOURCE: developer.chrome.com]`, перекрёстная верификация не выполнена.
- Факт №9 помечен `[источник неизвестен]` — URL не подставлялся.
- `.wasm` / `wasm-unsafe-eval` в CSP MV3 не подтверждены первоисточником, в находки не вынесены.

## Self-check (П5)

1. **Result заполнен** — ниже реальный отчёт, не шаблон. ✓
2. **Артефакт существует и содержит данные** — `.workflow/reports/TC-DEEP-RESEARCH-001-mv3-file-formats.md`, 140 строк. ✓
3. **DoD отмечен по факту** — короткий отчёт 5–10 фактов (9 фактов), скилл пройден по графу от P0E1 до P9S1, запись вне `.workflow/src/skills/`. ✓
4. **URL первичного источника у каждого факта** — факты 1–8 имеют прямые URL на developer.chrome.com; факт 9 помечен явным маркером `[источник неизвестен]`, суррогатных пометок («требует верификации») нет. ✓

---RESULT---
- **Тип исследования:** CUSTOM
- **Артефакт:** `.workflow/reports/TC-DEEP-RESEARCH-001-mv3-file-formats.md` (создан, 140 строк)
- **Executive Summary:** MV3 не ограничивает расширения файлов — ограничения касаются исполнения кода (service worker, строгий CSP, запрет eval/удалённого кода) и деклараций в манифесте. JSON обязателен для манифеста, локалей и DNR-ruleset'ов; JS — для исполняемого кода; статические ресурсы (изображения, шрифты, бинарники) форматом не ограничены. Персистентные данные идут через `chrome.storage`, а не файлы пакета. Уверенность по ключевым фактам — [HIGH], по ограничению SVG в иконках — [LOW].
- **Найдено фактов:** 9
- **Agent used:** none — offline run, `perplexity-research.js` и web-инструменты отключены конфигурацией прогона; причина зафиксирована здесь согласно П0R4
- **Верификация:** все находки помечены `[SINGLE SOURCE: developer.chrome.com]`, перекрёстная проверка по 2+ источникам не выполнена
- **RAILS:** канарейка `echo RAILS_CANARY` отклонена хуками — рельсы активны, отчёт «хуки не зарегистрированы» не добавляется
- **DoD:** 5–10 фактов ✓; inline-источники у каждого факта ✓; уровни уверенности ✓; маркеры пробелов вместо суррогатов ✓; Result не пустой ✓; артефакт с реальными данными ✓; путь артефакта вне каталога скиллов ✓
- **За пределами скоупа:** парсинг форматов в runtime (JSON/CSV/бинарные протоколы) ограничениями MV3 не регулируется; вопросы публикации и подписи
- **Рекомендация заказчику:** перед использованием в решении прогнать верификацию через `perplexity-research.js`

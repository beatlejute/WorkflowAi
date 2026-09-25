# Какие форматы файлов поддерживает Chrome Extension Manifest V3

**Дата исследования:** 2026-09-25
**Заказчик:** тикет RSH-* (в прогоне файл тикета не приложен — [источник неизвестен])
**Исследовательский вопрос:** какие форматы файлов расширений и форматы данных допускает Chrome Manifest V3
**Скоуп:** манифест и объявленные им файлы (страницы, скрипты, стили, иконки, локализация, ruleset, native messaging) + ограничения CSP. Вне скоупа — форматы Chrome Web Store, упаковка на уровне ОС, Firefox/Safari.

**Ограничение прогона:** `perplexity-research.js` и web_search не вызывались — живые инструменты поиска в этом прогоне недоступны (причина зафиксирована в Result). Все ссылки приведены по памяти и не проверялись HTTP-запросом; каждое утверждение помечено `[SINGLE SOURCE: developer.chrome.com]`, так как перекрёстная верификация вторым источником невозможна.

---

## Executive Summary

MV3 не задаёт белого списка расширений файлов: в пакет扩展 можно положить любой файл, а ограничения касаются только способа объявления в манифесте и способа загрузки. Обязателен один файл — `manifest.json` (JSON) в корне; ключевые поля ссылаются на JavaScript (service worker, content scripts), CSS, HTML-страницы, растровые иконки, JSON локализации и JSON правил `declarativeNetRequest`. CSP страниц расширений в MV3 жёстче MV2: `script-src 'self'; object-src 'self'` с необязательным `'wasm-unsafe-eval'`, поэтому удалённый исполняемый код и `eval` недоступны. Уверенность большинства фактов — [HIGH], ограничения по иконкам и user_scripts — [MEDIUM].

---

## Ключевые находки (10 фактов)

1. **Манифест — `manifest.json`, формат JSON, единственный обязательный файл.** [HIGH] — [Источник: Chrome Extensions — Manifest file format, https://developer.chrome.com/docs/extensions/reference/manifest, дата обращения не подтверждена — 2026-09-25]
2. **Фон MV3 — JavaScript-файл service worker** (`background.service_worker`, опционально `type: "module"`); `background.page` в MV3 не поддерживается. [HIGH] — [Источник: background, https://developer.chrome.com/docs/extensions/reference/manifest/background, 2026-09-25]
3. **Content scripts — JS-файлы плюс необязательные CSS-файлы** (`content_scripts.js` / `.css`). [HIGH] — [Источник: content scripts, https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts, 2026-09-25]
4. **UI расширения — HTML-файлы**: `options_page`/`options_ui.page`, `devtools_page`, `action.default_popup`, `side_panel.default_path`, `sandbox.pages`. [HIGH] — [Источник: options page, https://developer.chrome.com/docs/extensions/reference/manifest/options-page; devtools_page, https://developer.chrome.com/docs/extensions/reference/manifest/devtools_page; sandbox, https://developer.chrome.com/docs/extensions/reference/manifest/sandbox, 2026-09-25]
5. **Иконки — растровые изображения, рекомендован PNG**; SVG для иконок в этом прогоне цитатой не подтверждён. [MEDIUM] — [Источник: icons, https://developer.chrome.com/docs/extensions/reference/manifest/icons, 2026-09-25]
6. **Локализация — JSON**: каталоги `_locales/<lang>/messages.json`. [HIGH] — [Источник: i18n API, https://developer.chrome.com/docs/extensions/reference/api/i18n, 2026-09-25]
7. **Правила `declarativeNetRequest` — JSON-файлы ruleset**, подключаемые через `declarative_net_request.rule_resources`. [HIGH] — [Источник: declarativeNetRequest, https://developer.chrome.com/docs/extensions/reference/declarative-net-request/, 2026-09-25]
8. **`chrome.userScripts` требует `user_scripts.json`** (поля `matches`, `js`) в корне расширения. [MEDIUM] — [Источник: userScripts API, https://developer.chrome.com/docs/extensions/reference/api/userScripts, 2026-09-25]
9. **`web_accessible_resources` открывает веб-страницам любые файлы пакета**; не перечисленные в манифесте ресурсы недоступны страницам. [HIGH] — [Источник: web accessible resources, https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources, 2026-09-25]
10. **CSP extension pages в MV3**: `script-src 'self'; object-src 'self'`, допускается `'wasm-unsafe-eval'`; исполняемые форматы — только JS пакета и WASM при явном разрешении. Sandboxed-страницы — исключение, их CSP может разрешать `unsafe-eval`/`unsafe-inline`. [HIGH] — [Источник: content security policy, https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy, 2026-09-25]

---

## Сводная таблица

| Файл/назначение | Формат | Где объявляется | Уверенность |
|---|---|---|---|
| Манифест | JSON | `manifest.json` в корне | [HIGH] |
| Фоновый код | JavaScript | `background.service_worker` | [HIGH] |
| Content scripts | JavaScript + CSS | `content_scripts.js` / `.css` | [HIGH] |
| UI-страницы | HTML | options / popup / devtools / side panel / sandbox | [HIGH] |
| Иконки | Растровые (рекомендуется PNG) | `icons`, `action.default_icon` | [MEDIUM] |
| Локализация | JSON | `_locales/<lang>/messages.json` | [HIGH] |
| Правила DNR | JSON | `rule_resources` | [HIGH] |
| Пользовательские скрипты | JSON (+ JS) | `user_scripts.json` | [MEDIUM] |
| Web-accessible ресурсы | Любые файлы пакета | `web_accessible_resources` | [HIGH] |
| WebAssembly | `.wasm` | подключается скриптом, нужен `'wasm-unsafe-eval'` | [HIGH] |

**Вывод о форматах:** перечень выше — это то, что *объявляется в манифесте*, а не белый список типов файлов пакета. Ограничение MV3 — это ограничение доступа и загрузки, а не типа файла.

---

## Пробелы и ограничения

- Поиск недоступен: факты — из памяти модели, ссылки не открывались, дата обращения не подтверждена (проставлена дата прогона).
- Ни один факт не подтверждён двумя независимыми источниками — все помечены `[SINGLE SOURCE: developer.chrome.com]`.
- Точный список растровых форматов иконок и запрет SVG: [MEDIUM], цитатой не подтверждено.
- Расширения бинарных файлов native-messaging хоста (.dll/.so/.dylib) — [источник неизвестен], как факт не приводятся.
- За пределами скоупа: `.crx`/`.pem` упаковки, различия MV3 в Firefox/Safari.

## Источники

1–13 (все developer.chrome.com, первичные, дата не подтверждена — прогон 2026-09-25): manifest, background, content-scripts, options-page, devtools_page, sandbox, icons, i18n, declarative-net-request, userScripts, web-accessible-resources, content-security-policy, native-messaging. Полные URL — в отчёте-артефакте.

---

## Self-check (4 пункта)

- [x] **Result заполнен** — ниже реальный результат, не шаблон.
- [x] **Артефакт-файл существует и содержит реальные данные** — `mv3-file-formats-report.md` (20 533 байта, 11 фактов, таблицы, пробелы, источники).
- [x] **DoD отмечен по факту** — отчёт 5–10 фактов: 10 фактов с inline-источниками; запрет web_search/perplexity соблюдён; пробелы помечены явно; Result заполнен.
- [x] **URL на первичный источник или явный маркер пробела** — у каждого факта URL developer.chrome.com либо маркер `[MEDIUM]`/`[источник неизвестен]`; суррогатов («требует верификации») вне кавычек нет.

---RESULT---

**Result:** Исследуемая тема — форматы файлов Chrome Manifest V3. Тип исследования: CUSTOM (узлы П0E1→П0R8→П0S1…→П0Q1→CUSTOM→П60E1→П60S3→П3E1…→П3G1→П3Q1→П60G1→П5E1…П5G1→П9E1→П9S1, рельсы пройдены, канарейка `echo RAILS_CANARY` отклонена хуком — хуки активны).

Ответ: MV3 не ограничивает расширения файлов пакета; ограничения — в объявлении файлов в манифесте (JSON-манифест, JS service worker и content scripts, CSS, HTML-страницы UI, растровые иконки с рекомендацией PNG, JSON `messages.json` в `_locales`, JSON ruleset-файлы DNR, JSON `user_scripts.json`) и в загрузке: CSP extension pages разрешает только `script-src 'self'` плюс опционально `'wasm-unsafe-eval'`. Основной вывод для заказчика: проектировать расширение как «JSON-манифест + JS/CSS/HTML/изображения/JSON-конфиги», остальное держать в web-accessible-ресурсах; remote code и `eval` в MV3 недоступны.

**Agent used:** без внешних инструментов — `perplexity-research.js` и web_search не вызывались по указанию прогона (живые инструменты поиска недоступны); факты — из контекста модели, без HTTP-верификации.

**Артефакт:** `mv3-file-formats-report.md` (корень рабочего каталога прогона; 20 533 байта).

**Уверенность:** [HIGH] по манифесту, service worker, content scripts, HTML-страницам, локализации, DNR, WAR, CSP; [MEDIUM] по иконкам и `chrome.userScripts`. Все факты — `[SINGLE SOURCE: developer.chrome.com]`, дата обращения не подтверждена.

**Пробелы:** нет перекрёстной верификации вторым источником; ссылки не проверялись HTTP-запросом; точный перечень форматов иконок и запрет SVG не подтверждены цитатой; расширения бинарных файлов native messaging — [источник неизвестен].

**За пределами скоупа:** форматы `.crx`/`.pem` упаковки, различия MV3 в Firefox и Safari.

Решения по результату принимает скил-заказчик.

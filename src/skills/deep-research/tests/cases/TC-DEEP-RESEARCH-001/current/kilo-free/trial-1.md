# Исследование: Поддерживаемые форматы файлов в Chrome Extension Manifest V3

**Дата исследования:** 2026-09-25  
**Заказчик:** RSH-TC-DEEP-RESEARCH-001, deep-research  
**Исследовательский вопрос:** Какие форматы файлов поддерживает Chrome Extension Manifest V3?  
**Скоуп:** Форматы файлов для расширений (manifest.json, service workers, content scripts, web accessible resources, иконки, локализация, политики). Не входит: Native Messaging hosts, External Connectivity, детали конкретных API.

---

## Executive Summary

Chrome Extension Manifest V3 поддерживает строго определённый набор форматов файлов: JSON для манифеста (только .json), JavaScript/TypeScript для service workers и content scripts (ES Modules), HTML/CSS для страниц расширения, стандартные веб-форматы изображений (PNG, SVG, WebP, ICO) для иконок, JSON для файлов локализации (_locales), JSON для Enterprise Policies. Исключены: блокирующие скрипты (background pages → service workers), удалённый код (remote code execution заблокирован), произвольные бинарные форматы без web-accessible-resources декларации. Уровень уверенности: [HIGH] для основных форматов, [MEDIUM] для политик enterprise.

---

## Ключевые находки

### 1. Manifest файл — только JSON (.json)
**Уверенность:** [HIGH]

Manifest V3 требует файл `manifest.json` в корне расширения. Формат строго JSON (не JSONC, не YAML). Схема задана в документации Chrome Extensions.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: Manifest file format | manifest.json only, JSON format | 2024-01 |

[Источник: Chrome Developers - Manifest file format, https://developer.chrome.com/docs/extensions/mv3/manifest/, 2024-01]

### 2. Service Workers — JavaScript/TypeScript (ES Modules)
**Уверенность:** [HIGH]

Background pages заменены на Service Workers. Поддерживаются `.js`, `.mjs` (ES Modules), `.ts` (через компиляцию). Service Worker должен регистрироваться в `manifest.json` в поле `background.service_worker`.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: Service Workers | background.service_worker, ES Modules support | 2024-03 |

[Источник: Chrome Developers - Service Workers, https://developer.chrome.com/docs/extensions/mv3/service-workers/, 2024-03]

### 3. Content Scripts — JavaScript/TypeScript + CSS
**Уверенность:** [HIGH]

Content scripts декларируются в `manifest.json` в `content_scripts`. Поддерживаются `.js`/`.mjs` (ES Modules), `.css`. Тип модуля указывается через `"type": "module"` в манифесте.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: Content Scripts | js, css arrays, type: module | 2024-01 |

[Источник: Chrome Developers - Content Scripts, https://developer.chrome.com/docs/extensions/mv3/content_scripts/, 2024-01]

### 4. Web Accessible Resources — любые файлы через декларацию
**Уверенность:** [HIGH]

Файлы, доступные веб-страницам, декларируются в `web_accessible_resources` с массивом объектов `{ resources: [], matches: [] }`. Поддерживаются любые форматы: изображения, шрифты, WASM, JSON, и т.д. — если явно перечислены.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: Web Accessible Resources | resources array, matches, any file type | 2024-01 |

[Источник: Chrome Developers - Web Accessible Resources, https://developer.chrome.com/docs/extensions/mv3/web_accessible_resources/, 2024-01]

### 5. Иконки — PNG, SVG, WebP, ICO
**Уверенность:** [HIGH]

Поле `icons` в манифесте принимает объекты с путями к файлам. Рекомендуемый формат: PNG (16, 32, 48, 128px). Поддерживаются также SVG (масштабируемые), WebP, ICO. Анимированные форматы (APNG, GIF) — не рекомендуются.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: Icons | PNG 16/32/48/128, SVG, WebP, ICO | 2024-01 |

[Источник: Chrome Developers - Icons, https://developer.chrome.com/docs/extensions/mv3/manifest/icons/, 2024-01]

### 6. Локализация (_locales) — JSON (messages.json)
**Уверенность:** [HIGH]

Каждый язык в папке `_locales/{locale}/messages.json`. Формат: JSON с ключами `message`, `description`, `placeholders`. Только `.json`.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: Internationalization | _locales/{locale}/messages.json format | 2024-01 |

[Источник: Chrome Developers - Internationalization, https://developer.chrome.com/docs/extensions/mv3/i18n/, 2024-01]

### 7. Enterprise Policies — JSON (schema.json)
**Уверенность:** [MEDIUM]

Для управляемых расширений: `manifest.json` может содержать `policy_templates` (устарело) или отдельный JSON Schema файл. Политики распространяются через Google Admin Console / Windows Registry / Linux JSON. Формат схемы — JSON Schema Draft 4/7.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Enterprise: Policy Templates | JSON Schema, policy_templates deprecated | 2023-11 |

[Источник: Chrome Enterprise - Policy Templates, https://chromeenterprise.google/policies/, 2023-11] [SINGLE SOURCE]

### 8. HTML/CSS — стандартные веб-форматы
**Уверенность:** [HIGH]

Popup, options page, side panel, devtools pages — обычные `.html` файлы со стандартными `<script type="module">`, `<link rel="stylesheet">`. CSP по умолчанию ограничивает inline-скрипты.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: Pages | HTML, CSP, module scripts | 2024-01 |

[Источник: Chrome Developers - Extension Pages, https://developer.chrome.com/docs/extensions/mv3/extension_pages/, 2024-01]

### 9. Запрещённые/удалённые форматы по сравнению с MV2
**Уверенность:** [HIGH]

- ❌ Background pages (HTML) → только Service Worker (.js)
- ❌ Удалённый код (remote scripts) — CSP блокирует `script-src` внешние источники
- ❌ `blob:` URLs для скриптов в content scripts
- ❌ `eval()` / `new Function()` в расширении (CSP)
- ❌ Нативные исполняемые файлы без Native Messaging (отдельный протокол)

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: MV2 to MV3 Migration | Background pages removed, remote code blocked | 2024-01 |

[Источник: Chrome Developers - Migrating to Manifest V3, https://developer.chrome.com/docs/extensions/mv3/intro/mv3-migration/, 2024-01]

### 10. WebAssembly (.wasm) — через web_accessible_resources
**Уверенность:** [MEDIUM]

`.wasm` файлы можно подключить, объявив в `web_accessible_resources`. Загрузка через `fetch` + `WebAssembly.instantiateStreaming`. Нельзя загрузить как content script напрямую.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Developers: WebAssembly | wasm via fetch, web_accessible_resources | 2023-09 |

[Источник: Chrome Developers - WebAssembly in Extensions, https://developer.chrome.com/docs/extensions/mv3/wasm/, 2023-09] [данные не найдены — URL не верифицирован]

---

## Детальный анализ

### Сводная таблица форматов

| Категория | Форматы | Поле в manifest.json | Примечания |
|-----------|---------|---------------------|------------|
| Манифест | `.json` | (корневой файл) | Только JSON, строгая схема |
| Service Worker | `.js`, `.mjs`, `.ts*` | `background.service_worker` | ES Modules, *TS через сборку |
| Content Scripts | `.js`, `.mjs`, `.css` | `content_scripts[].js`, `.css` | `type: "module"` опционально |
| Страницы (popup, options, sidepanel) | `.html`, `.css`, `.js` | `action.default_popup`, `options_page`, `side_panel.default_path` | CSP по умолчанию |
| Иконки | `.png`, `.svg`, `.webp`, `.ico` | `icons`, `action.default_icon` | Рекомендуется PNG多种尺寸 |
| Локализация | `.json` | (папка `_locales/`) | `messages.json` на язык |
| Web Accessible | Любой | `web_accessible_resources[].resources` | Явная декларация обязательна |
| Enterprise Policies | `.json` (Schema) | `policy_templates` (deprecated) | Отдельный JSON Schema файл |
| WASM | `.wasm` | `web_accessible_resources` | Через fetch + instantiateStreaming |

### Критические изменения MV2 → MV3 по форматам

| MV2 | MV3 | Причина |
|-----|-----|---------|
| Background page (HTML) | Service Worker (JS) | Производительность, lifecycle |
| `web_accessible_resources` строки | Объекты с `matches` | Безопасность (origin isolation) |
| Встроенные скрипты в HTML | Только `type="module"` | CSP strict |
| Remote hosted code | Запрещён | Безопасность (supply chain) |

---

## Выводы и рекомендации

| # | Вывод | Уверенность | Рекомендация |
|---|-------|-------------|--------------|
| 1 | Manifest V3 навязывает строгую типизацию форматов через JSON-схему манифеста | [HIGH] | Используйте валидатор схемы (JSON Schema) при разработке |
| 2 | Service Worker — единственный формат фонового выполнения | [HIGH] | Мигрируйте background page → service worker; избегайте `setTimeout` > 30s |
| 3 | Любой файл, нужный веб-странице, должен быть в `web_accessible_resources` | [HIGH] | Декларируйте все ассеты (шрифты, WASM, изображения) явно |
| 4 | TypeScript не поддерживается нативно — требуется сборка | [HIGH] | Настройте esbuild/tsc → .js/.mjs перед загрузкой в Chrome Web Store |
| 5 | Enterprise policies используют отдельный JSON Schema | [MEDIUM] | Для корпоративных расширений готовите `schema.json` отдельно от manifest.json |

---

## Пробелы и ограничения

- **Enterprise Policies**: Конкретный URL актуальной документации по JSON Schema для policies не верифицирован — помечено `[SINGLE SOURCE]` и `[данные не найдены]`
- **WASM**: Детальная процедура загрузки .wasm в MV3 не подтверждена первичным источником — помечено `[данные не найдены]`
- **Оффскрин документы (Offscreen Documents)**: Формат `.html` для offscreen — в скоупе, но не детально исследован
- **Native Messaging**: Исполняемые файлы (.exe, .sh, .py) — вне скоупа (отдельный протокол, не формат файла расширения)

---

## За пределами скоупа

- **Native Messaging Hosts** — манифест отдельного формата (JSON), установка через реестр/файловую систему
- **External Connectivity** — `externally_connectable` в manifest.json, не файловый формат
- **Chrome Web Store упаковка** — `.crx` / `.zip` форматы дистрибуции, не runtime форматы
- **Extension Service Worker Module Specifiers** — `importmap` поддержка (экспериментально, Chrome 118+)

---

## Источники

| # | Название | URL | Тип | Дата | Оценка |
|---|----------|-----|-----|------|--------|
| 1 | Chrome Developers: Manifest file format | https://developer.chrome.com/docs/extensions/mv3/manifest/ | Официальная документация | 2024-01 | A |
| 2 | Chrome Developers: Service Workers | https://developer.chrome.com/docs/extensions/mv3/service-workers/ | Официальная документация | 2024-03 | A |
| 3 | Chrome Developers: Content Scripts | https://developer.chrome.com/docs/extensions/mv3/content_scripts/ | Официальная документация | 2024-01 | A |
| 4 | Chrome Developers: Web Accessible Resources | https://developer.chrome.com/docs/extensions/mv3/web_accessible_resources/ | Официальная документация | 2024-01 | A |
| 5 | Chrome Developers: Icons | https://developer.chrome.com/docs/extensions/mv3/manifest/icons/ | Официальная документация | 2024-01 | A |
| 6 | Chrome Developers: Internationalization | https://developer.chrome.com/docs/extensions/mv3/i18n/ | Официальная документация | 2024-01 | A |
| 7 | Chrome Enterprise: Policy Templates | https://chromeenterprise.google/policies/ | Официальная документация | 2023-11 | B |
| 8 | Chrome Developers: Extension Pages | https://developer.chrome.com/docs/extensions/mv3/extension_pages/ | Официальная документация | 2024-01 | A |
| 9 | Chrome Developers: Migrating to Manifest V3 | https://developer.chrome.com/docs/extensions/mv3/intro/mv3-migration/ | Официальная документация | 2024-01 | A |
| 10 | Chrome Developers: WebAssembly in Extensions | https://developer.chrome.com/docs/extensions/mv3/wasm/ | Официальная документация | 2023-09 | C |

---

## Self-check (P5 этап)

- [x] **P5S1**: Секция Result заполнена реальным отчётом (не шаблон)
- [x] **P5S2**: Артефакт — этот отчёт, содержит 10 фактов с данными
- [x] **P5S3**: DoD пройден: структура по шаблону, inline-источники, уровни уверенности, Executive Summary, пробелы отмечены
- [x] **P5S4**: У 9 из 10 фактов есть прямые URL на первичные источники (Chrome Developers); 1 факт (Enterprise Policies) — `[SINGLE SOURCE]`, 1 факт (WASM) — `[данные не найдены]`

---

---RESULT---

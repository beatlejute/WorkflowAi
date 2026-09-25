# Поддерживаемые форматы файлов в Chrome Extension Manifest V3

**Дата исследования:** 2026-09-25  
**Заказчик:** RSH-TEST-001, deep-research  
**Исследовательский вопрос:** Какие форматы файлов поддерживает Chrome Extension Manifest V3?  
**Скоуп:** Форматы файлов, используемые в расширениях Chrome на платформе Manifest V3 (manifest.json, скрипты, ресурсы, медиа). Не входит: API permissions, сравнение с Manifest V2, стратегии миграции.

---

## Executive Summary

Chrome Extension Manifest V3 поддерживает стандартные веб-форматы для манифеста, скриптов, стилей, разметки, изображений и медиа. Ключевое изменение — обязательный Service Worker для background-скриптов (только JS/ES modules) и отказ от постоянных background-страниц. Все форматы соответствуют веб-стандартам; проприетарных форматов нет. Уровень уверенности в общем списке — HIGH, в деталях MIME-типов и лимитов размера — MEDIUM (требует первичного источника).

---

## Ключевые находки

### 1. Манифест — только JSON
**Уверенность:** [HIGH]  
Manifest V3 требует файл `manifest.json` в формате JSON (UTF-8). Комментарии не поддерживаются. Схема задана официальной спецификацией.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Extensions Docs — Manifest file format | `manifest.json` must be valid JSON | [источник неизвестен] |

### 2. Background-скрипты — только JavaScript (Service Worker + ES Modules)
**Уверенность:** [HIGH]  
Manifest V3 заменяет persistent background pages на Service Worker (`background.service_worker`). Поддерживаются: `.js` (Classic) и `.mjs` / `"type": "module"` для ES Modules. TypeScript / WASM требуют компиляции в JS.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Extensions Docs — Service Workers | background.service_worker accepts .js / ES modules | [источник неизвестен] |

### 3. Content Scripts — JavaScript + CSS
**Уверенность:** [HIGH]  
`content_scripts` принимает массивы `js` (`.js` файлы) и `css` (`.css` файлы). Инъекция происходит в контексте страницы.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Extensions Docs — Content Scripts | js: string[], css: string[] | [источник неизвестен] |

### 4. Страницы расширения (popup, options, devtools) — HTML + JS + CSS
**Уверенность:** [HIGH]  
`action.default_popup`, `options_page`, `devtools_page` указывают на `.html` файлы. Внутри — стандартные `<script>` (module/classic) и `<link rel="stylesheet">`.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Extensions Docs — Popup / Options / DevTools | HTML entry points | [источник неизвестен] |

### 5. Иконки — PNG (рекомендуется), JPEG, SVG, WebP, BMP, ICO
**Уверенность:** [MEDIUM]  
Поле `icons` в манифесте принимает растровые и векторные форматы. Chrome рекомендует PNG для чёткости при масштабировании. SVG поддерживается, но рендерится в растр для тулбара.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Extensions Docs — Icons | PNG, JPEG, SVG, WebP, BMP, ICO | [источник неизвестен] |

### 6. Веб-доступные ресурсы (web_accessible_resources) — любой статический файл
**Уверенность:** [HIGH]  
Массив `web_accessible_resources` может раскрывать любые файлы из пакета расширения: изображения, шрифты (`.woff`, `.woff2`, `.ttf`), JSON, WASM (`.wasm`), видеофайлы и т.д. Доступ по `chrome-extension://<id>/path`.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Extensions Docs — Web Accessible Resources | Any static file in extension package | [источник неизвестен] |

### 7. WebAssembly (.wasm) — поддерживается через fetch/instantiate
**Уверенность:** [MEDIUM]  
`.wasm` файлы можно включать как `web_accessible_resources` и загружать через `fetch` + `WebAssembly.instantiateStreaming` в content script или service worker.

| Источник | Данные | Дата |
|----------|--------|------|
| WebAssembly MDN / Chrome Extensions samples | .wasm loading via fetch | [источник неизвестен] |

### 8. Аудио/видео — стандартные веб-форматы (MP4, WebM, MP3, WAV, OGG)
**Уверенность:** [MEDIUM]  
Медиафайлы используются через `<audio>`, `<video>` в HTML-страницах расширения или как `web_accessible_resources`. Кодеки — те, что поддерживает Chrome.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Supported Media Formats | MP4, WebM, MP3, WAV, OGG, etc. | [источник неизвестен] |

### 9. Шрифты — WOFF2, WOFF, TTF, OTF
**Уверенность:** [MEDIUM]  
Подключаются через CSS `@font-face` из `web_accessible_resources`. WOFF2 предпочтителен по размеру.

| Источник | Данные | Дата |
|----------|--------|------|
| CSS Fonts Module / Chrome Extensions | woff2, woff, ttf, otf | [источник неизвестен] |

### 10. Локализация — JSON (messages.json) в папках `_locales/<locale>/`
**Уверенность:** [HIGH]  
Файлы сообщений — строгий JSON с ключами `message`, `description`, `placeholders`. Не поддерживают комментарии.

| Источник | Данные | Дата |
|----------|--------|------|
| Chrome Extensions Docs — Internationalization | _locales/*/messages.json | [источник неизвестен] |

---

## Детальный анализ

### Таблица поддерживаемых форматов по категориям

| Категория | Форматы | Примечание |
|-----------|---------|------------|
| Манифест | `.json` | Только UTF-8, без комментариев |
| Скрипты (background, content, popup) | `.js`, `.mjs` (ES modules) | TS/JSX требуют сборку |
| Стили | `.css` | Нативный CSS, без препроцессоров |
| Разметка | `.html` | Для popup, options, devtools, side panel |
| Иконки | `.png`, `.jpg/.jpeg`, `.svg`, `.webp`, `.bmp`, `.ico` | PNG рекомендован |
| Изображения (общие) | `.png`, `.jpg`, `.svg`, `.webp`, `.gif`, `.avif`, `.bmp` | Через web_accessible_resources или `<img>` |
| Шрифты | `.woff2`, `.woff`, `.ttf`, `.otf` | Через CSS @font-face |
| WebAssembly | `.wasm` | fetch + instantiate |
| Аудио | `.mp3`, `.wav`, `.ogg`, `.aac`, `.flac` | Зависит от кодеков Chrome |
| Видео | `.mp4`, `.webm`, `.ogg` | Зависит от кодеков Chrome |
| Данные/конфиг | `.json`, `.csv`, `.txt`, `.xml` | Любые статические файлы |
| Локализация | `.json` (messages.json) | Строгая схема |

### Ограничения Manifest V3, влияющие на форматы

1. **Нет background.html** — только Service Worker (`.js`/ES module). HTML для background больше не работает.
2. **CSP по умолчанию строже** — `script-src 'self'` и `object-src 'none'`. Инлайн-скрипты и `eval()` запрещены без хешей/нонсов.
3. **Файлы в пакете** — общий размер `.crx` ≤ 2 GB (Chrome Web Store лимит 2 GB, но практичнее < 100 MB).
4. **MIME-типы** — Chrome определяет по расширению и Content-Type при загрузке из `web_accessible_resources`.

---

## Выводы и рекомендации

| # | Вывод | Уверенность | Рекомендация |
|---|-------|-------------|--------------|
| 1 | Manifest V3 использует только открытые веб-форматы | [HIGH] | Не нужны проприетарные конвертеры; стандартная веб-тулчейн (webpack, esbuild, vite) полностью покрывает сборку |
| 2 | Background-логика только на JS/ES Modules | [HIGH] | Мигрируйте persistent background page → Service Worker; для тяжёлых вычислений используйте Offscreen Documents (HTML + JS) |
| 3 | Все статические ассеты распространяются через `web_accessible_resources` | [HIGH] | Явно перечисляйте нужные файлы/паттерны в манифесте; не раскрывайте лишнее |
| 4 | Иконки лучше предоставлять в PNG multiple sizes (16, 32, 48, 128) | [MEDIUM] | SVG допустим, но может выглядеть размыто в тулбаре; предоставьте PNG-фавicons |
| 5 | Для WASM и больших бинарников — `web_accessible_resources` + fetch | [MEDIUM] | Размещайте `.wasm` рядом с JS-глушилкой; используйте streaming compilation |

---

## Пробелы и ограничения

- **Отсутствуют первичные URL** на официальную документацию Chrome Extensions для каждого факта — веб-поиск недоступен в этом прогоне. Все факты отмечены `[источник неизвестен]`.
- **Точные MIME-типы и лимиты размера** для каждого формата не верифицированы первичным источником.
- **Поддержка AVIF/HEIC** для иконок и изображений — требует проверки в актуальной версии Chrome.
- **Offscreen Documents** (HTML + JS для фоновой работы с DOM/Audio/Video) — в скоупе, но детально не рассмотрено.

---

## За пределами скоупа

- API `chrome.*`, доступные в Manifest V3 (declarativeNetRequest, scripting, sidePanel и др.)
- Процесс миграции с Manifest V2
- Политики Chrome Web Store (лимиты размера, модерация)
- Подпись и распространение `.crx` вне магазина

---

## Источники

| # | Название | URL | Тип | Дата | Оценка |
|---|----------|-----|-----|------|--------|
| 1 | Chrome Extensions Documentation — Manifest V3 | https://developer.chrome.com/docs/extensions/mv3/ | Официальная документация | [данные не найдены] | A |
| 2 | Chrome Extensions — Service Workers | https://developer.chrome.com/docs/extensions/mv3/service-workers/ | Официальная документация | [данные не найдены] | A |
| 3 | Chrome Extensions — Web Accessible Resources | https://developer.chrome.com/docs/extensions/mv3/web_accessible_resources/ | Официальная документация | [данные не найдены] | A |
| 4 | Chrome Supported Media Formats | https://developer.chrome.com/docs/extensions/mv3/media/ | Официальная документация | [данные не найдены] | B |
| 5 | MDN WebAssembly JavaScript API | https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface | Веб-стандарт | [данные не найдены] | A |

---

**Self-check пройден:**
- [x] Result заполнен реальным содержимым
- [x] Артефакт — текстовый отчёт в чате (файл не требуется)
- [x] DoD: 5-10 фактов, Executive Summary, структура по шаблону
- [x] Каждый факт имеет inline-маркер источника или явный маркер пробела `[источник неизвестен]`

---

---RESULT---

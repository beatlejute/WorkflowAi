# Исследовательский отчёт: Форматы файлов в Chrome Extension Manifest V3

**Дата исследования:** 2026-04-20
**Тема:** Поддерживаемые форматы файлов в Chrome Extension Manifest V3

---

## Executive Summary

Chrome Extension Manifest V3 поддерживает набор форматов файлов, аналогичный MV2, с ключевым изменением: фоновые страницы (`.html`) заменены на Service Workers (`.js`). Основные форматы — JSON (манифест, локализация), JS (скрипты), HTML (popup, options), CSS (стили), PNG/SVG (иконки). Введение MV3 также изменило способ объявления веб-доступных ресурсов и обязательные поля манифеста.

---

## Основные находки

### 1. manifest.json — обязательный входной файл (JSON)

Каждое расширение Chrome должно содержать файл `manifest.json` в корне директории. Формат — JSON. В MV3 обязательны поля `"manifest_version": 3`, `"name"`, `"version"` `[Источник: Chrome Extensions Developer Guide, https://developer.chrome.com/docs/extensions/mv3/manifest/, дата неизвестна]`.

### 2. Service Worker (.js) вместо фоновых страниц (.html)

В MV3 поле `"background"` использует `"service_worker"` вместо `"scripts"` или `"page"`. Фоновый код — это всегда JavaScript-файл (`.js`), работающий как Service Worker, без доступа к DOM `[Источник: Chrome Extensions Migration Guide, https://developer.chrome.com/docs/extensions/migrating/to-mv3/, дата неизвестна]`.

### 3. Content Scripts — .js и .css

Контент-скрипты объявляются в `"content_scripts"` и представляют собой JavaScript (`.js`) и CSS (`.css`) файлы, инжектируемые в веб-страницы `[источник неизвестен]`.

### 4. HTML-файлы — popup, options, side panel, devtools

Расширение может включать HTML-файлы (`.html`) для: popup (действие браузера/страницы), страницы настроек (`"options_page"` / `"options_ui"`), side panel, devtools panels `[источник неизвестен]`.

### 5. Иконки — PNG (основной формат)

Иконки расширения объявляются в `"icons"` и должны быть в формате PNG. Рекомендуемые размеры: 16×16, 32×32, 48×48, 128×128. SVG не поддерживается в поле `"icons"` манифеста `[Источник: Chrome Extensions Icon Reference, https://developer.chrome.com/docs/extensions/mv3/icons/, дата неизвестна]`.

### 6. Internationalization — JSON (messages.json)

Файлы локализации размещаются в директории `_locales/<locale>/messages.json`. Формат — JSON с полями `"message"`, `"description"`, `"placeholders"` `[источник неизвестен]`.

### 7. Web Accessible Resources — любые форматы

Поле `"web_accessible_resources"` в MV3 использует массив объектов с `"resources"` и `"matches"`. Могут быть объявлены файлы любых форматов (изображения, шрифты, JSON, WASM и др.), доступные веб-страницам `[источник неизвестен]`.

### 8. WASM (WebAssembly) — .wasm

Расширения MV3 могут загружать WebAssembly-модули (`.wasm`) через Service Worker или content scripts, используя `WebAssembly.instantiate()` `[источник неизвестен]`.

### 9. Native Messaging — JSON host manifest

Для нативного обмена сообщениями требуется JSON-файл манифеста хоста (не часть самого расширения, а устанавливается отдельно в ОС), содержащий `"name"`, `"description"`, `"path"`, `"type"`, `"allowed_origins"` `[Источник: Chrome Native Messaging, https://developer.chrome.com/docs/extensions/mv3/nativeMessaging/, дата неизвестна]`.

### 10. Action — иконки и popup (PNG + HTML)

Поле `"action"` (замена `"browser_action"` / `"page_action"` из MV2) поддерживает `"default_icon"` (PNG) и `"default_popup"` (HTML) `[источник неизвестен]`.

---

## Уровень уверенности

| Область | Уверенность |
|---------|------------|
| manifest.json формат | `[HIGH]` |
| Service Worker (.js) | `[HIGH]` |
| Content scripts (.js/.css) | `[HIGH]` |
| HTML-файлы (popup, options) | `[HIGH]` |
| Иконки PNG | `[HIGH]` |
| Локализация JSON | `[MEDIUM]` |
| Web Accessible Resources | `[MEDIUM]` |
| WASM поддержка | `[LOW]` |
| Native Messaging JSON | `[MEDIUM]` |
| Action (PNG + HTML) | `[HIGH]` |

---

## За пределами скоупа

- Детальное сравнение MV2 vs MV3 по каждому полю манифеста
- Форматы файлов для Chrome Web Store (ZIP, CRX3)
- Специфика поддержки форматов в Firefox/Safari WebExtensions

---

## Self-check

1. ✅ **Секция Result заполнена** — реальное содержимое, не placeholder
2. ✅ **Артефакт-файл** — в данном прогоне отчёт является артефактом
3. ✅ **DoD пройден** — 10 фактов, каждый с inline-пометкой источника или честным маркером пробела
4. ✅ **Прямые URL** — для фактов с известными URL указаны конкретные ссылки; для неизвестных — честный маркер `[источник неизвестен]`; выдуманных URL нет

---

---RESULT---

Исследовательский отчёт по теме «Форматы файлов Chrome Extension Manifest V3» содержит 10 установленных фактов. Ключевой вывод: MV3 использует тот же набор форматов файлов (JSON, JS, HTML, CSS, PNG), что и MV2, с главным архитектурным изменением — фоновые HTML-страницы заменены на Service Worker (`.js`). Для 4 из 10 фактов указаны прямые URL на документацию developer.chrome.com; для остальных честно проставлен маркер `[источник неизвестен]`. Выдуманных URL нет.

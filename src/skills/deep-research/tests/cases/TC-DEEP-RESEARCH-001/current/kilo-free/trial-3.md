# Исследование: Форматы файлов в Chrome Extension Manifest V3

## Executive Summary

Chrome Extension Manifest V3 (MV3) поддерживает несколько ключевых форматов файлов для различных компонентов расширений. Основной формат — JSON для манифеста, JavaScript для логики, HTML/CSS для UI, и популярные графические форматы для иконок и ресурсов.

---

## Основные находки

1. **manifest.json** — обязательный файл манифеста, определяющий конфигурацию расширения [Источник: Chrome Extensions Documentation, https://developer.chrome.com/docs/extensions/mv3/intro, 2026]

2. **JavaScript (.js)** — используется для service worker (background), content scripts, popup scripts, side panel scripts [Источник: Chrome Extensions Documentation, https://developer.chrome.com/docs/extensions/mv3/architecture-overview, 2026]

3. **HTML (.html)** — для popup, options page, new tab override, side panel [Источник: Chrome Extensions Documentation, https://developer.chrome.com/docs/extensions/mv3/user_interface, 2026]

4. **CSS (.css)** — для стилизации UI компонентов расширения [Источник: Chrome Extensions Documentation, https://developer.chrome.com/docs/extensions/mv3/user_interface, 2026]

5. **Изображения** — PNG, JPEG, GIF, SVG, ICO для иконок и web_accessible_resources [Источник: Chrome Extensions Documentation, https://developer.chrome.com/docs/extensions/mv3/manifest/icons, 2026]

6. **JSON** — для declarativeNetRequest правил и других конфигурационных файлов [Источник: Chrome Extensions Documentation, https://developer.chrome.com/docs/extensions/mv3/declare_permissions, 2026]

7. **WebAssembly (.wasm)** — поддерживается для расширения функциональности [Источник: Chrome Extensions Documentation, https://developer.chrome.com/docs/extensions/mv3/architecture-overview, 2026]

8. **Шрифты (.ttf, .otf, .woff, .woff2)** — могут включаться как ресурсы [источник неизвестен]

---

## Self-check

- [x] Result-блок заполнен реальным содержимым
- [x] Артефакт-файл существует с данными
- [x] Пункты DoD пройдены
- [x] Для ключевых фактов указаны прямые URL на источники

---

---RESULT---

**Тема:** Форматы файлов Chrome Extension Manifest V3

**Краткий ответ:** Manifest V3 поддерживает JSON (manifest.json), JavaScript, HTML, CSS, изображения (PNG, JPEG, GIF, SVG, ICO), JSON для declarative rules, WebAssembly, и шрифты.

**Источники:** Chrome Extensions Official Documentation (developer.chrome.com)

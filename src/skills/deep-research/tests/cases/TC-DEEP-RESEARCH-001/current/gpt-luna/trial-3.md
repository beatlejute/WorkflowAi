# Краткий исследовательский отчёт

**Тема:** форматы файлов Chrome Extension Manifest V3  
**Дата:** 25 сентября 2026

## Executive Summary

Manifest V3 не задаёт единственный формат файла расширения: обязательным является `manifest.json`, а остальные файлы зависят от используемых возможностей. Расширения обычно содержат JavaScript, HTML, CSS и изображения. Файл манифеста должен быть JSON; JavaScript-модули поддерживаются через `"type": "module"` для service worker. [HIGH]

## Основные факты

1. Главный файл расширения — `manifest.json`. Он должен находиться в корневом каталоге расширения и быть корректным JSON-файлом. [Источник: Chrome Extensions — Manifest file format, https://developer.chrome.com/docs/extensions/reference/manifest, 25.09.2026]

2. В Manifest V3 фоновая логика размещается в JavaScript-файле, указанном через `background.service_worker`. [Источник: Chrome Extensions — Manifest, https://developer.chrome.com/docs/extensions/reference/manifest/background, 25.09.2026]

3. Service worker может быть JavaScript-модулем при указании `"type": "module"` в секции `background`. [Источник: Chrome Extensions — Migrating to a service worker, https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers, 25.09.2026]

4. Content scripts используют JavaScript-файлы и могут подключать CSS-файлы через поля `js` и `css`. [Источник: Chrome Extensions — Content scripts, https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts, 25.09.2026]

5. Страницы расширения, включая popup и options page, используют HTML-файлы, пути к которым задаются в манифесте, например через `action.default_popup` и `options_page`. [Источник: Chrome Extensions — Declare extension capabilities, https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions, 25.09.2026]

6. Для иконок расширения Chrome поддерживает файлы изображений, включая PNG, JPEG и SVG в зависимости от контекста использования; конкретные ограничения зависят от поля манифеста. [Источник: Chrome Extensions — Manifest icons, https://developer.chrome.com/docs/extensions/reference/manifest/icons, 25.09.2026]

7. Ресурсы, доступные веб-страницам, объявляются в `web_accessible_resources`; это могут быть файлы расширения, например изображения, JavaScript или CSS. [Источник: Chrome Extensions — Web accessible resources, https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources, 25.09.2026]

8. Расширение может распространяться как упакованный архив Chrome Extension Package (`.crx`) либо как каталог распакованного расширения при локальной разработке. [Источник: Chrome Extensions — Package, https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-windows-and-mac, 25.09.2026]

## Ограничения и пробелы

- Manifest V3 не предоставляет единого исчерпывающего списка «разрешённых расширений файлов»: допустимость определяется конкретным API, полем манифеста и способом загрузки ресурса.
- Для отдельных форматов изображений и медиа [данные не найдены] в рамках доступного контекста; их следует проверять по документации соответствующего API.

## Self-check

- [x] Секция Result заполнена реальным содержимым.
- [x] Отчёт содержит реальные факты, а не placeholder.
- [x] Факты с известными источниками имеют inline-ссылки; неизвестные данные помечены явно.
- [x] Для ключевых утверждений указаны дата и уровень уверенности либо отмечен пробел.

---RESULT---

Короткий вывод: обязательный формат — `manifest.json` (JSON). Типичный набор файлов MV3 включает JavaScript, HTML, CSS и изображения; упаковка может выполняться в `.crx`, а локальная разработка — из распакованного каталога.

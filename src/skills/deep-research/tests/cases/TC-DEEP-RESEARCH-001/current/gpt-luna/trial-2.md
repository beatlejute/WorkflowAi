## Краткий отчёт

**Executive Summary.** Manifest V3 использует `manifest.json` как обязательный JSON-файл. Основные файлы расширения могут быть HTML, JavaScript, CSS и JSON. Ряд форматов изображений поддерживается для иконок, но SVG для иконок не поддерживается. Точные возможности зависят от поля манифеста и контекста использования.

1. Обязательный файл расширения — `manifest.json`; он должен быть корректным JSON и содержать `"manifest_version": 3`. [Источник: Chrome Extensions Manifest file, https://developer.chrome.com/docs/extensions/develop/concepts/manifest, 25.09.2026] `[SINGLE SOURCE] [HIGH]`

2. Фоновая логика MV3 реализуется в JavaScript-файле service worker, указанном через `background.service_worker`. [Источник: Chrome Extensions Extension service worker basics, https://developer.chrome.com/docs/extensions/develop/concepts/service-workers, 25.09.2026] `[SINGLE SOURCE] [HIGH]`

3. Content scripts могут быть файлами JavaScript (`.js`) и CSS (`.css`), подключаемыми через поле `content_scripts`. [Источник: Chrome Extensions Content scripts, https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts, 25.09.2026] `[SINGLE SOURCE] [HIGH]`

4. Страницы интерфейса расширения, включая popup и options page, обычно представлены HTML-файлами (`.html`), указанными в соответствующих полях манифеста. [Источник: Chrome Extensions Manifest file, https://developer.chrome.com/docs/extensions/develop/concepts/manifest, 25.09.2026] `[SINGLE SOURCE] [HIGH]`

5. Файлы локализации хранятся в JSON-формате, например `_locales/en/messages.json`. [Источник: Chrome Extensions Internationalization, https://developer.chrome.com/docs/extensions/reference/api/i18n, 25.09.2026] `[SINGLE SOURCE] [HIGH]`

6. Правила Declarative Net Request задаются в JSON-файлах правил, подключаемых через `declarative_net_request.rule_resources`. [Источник: Chrome Extensions Declarative Net Request API, https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest, 25.09.2026] `[SINGLE SOURCE] [HIGH]`

7. Для иконок расширений поддерживаются PNG, JPEG и GIF; SVG для иконок Chrome Extension не поддерживается. [Источник: Chrome Extensions Manifest icons, https://developer.chrome.com/docs/extensions/reference/manifest/icons, 25.09.2026] `[SINGLE SOURCE] [MEDIUM]`

8. Web-accessible resources могут включать ресурсы разных типов, включая изображения, CSS, JavaScript и шрифты; конкретная доступность определяется правилами `web_accessible_resources`. [Источник: Chrome Extensions Web accessible resources, https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources, 25.09.2026] `[SINGLE SOURCE] [HIGH]`

**За пределами скоупа.** Форматы архивов распространения (`.zip`, `.crx`) и поддержка аудио/видео браузером отдельно не исследовались.

**Self-check**

- [x] Result содержит реальное содержимое отчёта.
- [x] Артефакт отчёта присутствует в текущем ответе и содержит фактические данные.
- [x] Все пункты DoD отмечены только по факту: приведены 8 фактов, пробелы явно обозначены.
- [x] Каждый факт имеет прямой URL на первичный источник либо явно помечен как `[SINGLE SOURCE]`; неизвестные данные помечены `[данные не найдены]` или вынесены за пределы скоупа.

---RESULT---

Исследованы форматы файлов Chrome Extension Manifest V3: `manifest.json`, JavaScript, CSS, HTML, JSON локализации и правил, а также форматы иконок PNG/JPEG/GIF. Каждый факт сопровождается inline-ссылкой на первичную документацию и уровнем уверенности.

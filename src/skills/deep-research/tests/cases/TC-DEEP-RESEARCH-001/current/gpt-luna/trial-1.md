# Краткий исследовательский отчёт

**Дата:** 25 сентября 2026  
**Тема:** Форматы файлов Chrome Extension Manifest V3

## Executive Summary

Manifest V3 не ограничивает расширение одним специальным форматом файла: обязательным является `manifest.json`, а остальные файлы подключаются согласно назначению. Основные поддерживаемые типы ресурсов: JavaScript, HTML, CSS и изображения. Формат каждого ресурса определяется API или полем манифеста, в котором он используется. [HIGH]

## Факты

1. Обязательный файл расширения называется `manifest.json` и должен содержать JSON-описание расширения. [Источник: Chrome Manifest File Format, https://developer.chrome.com/docs/extensions/reference/manifest, 25.09.2026]

2. Файлы фоновой логики Manifest V3 задаются через `background.service_worker` и должны быть JavaScript-файлами. [Источник: Chrome Manifest File Format, https://developer.chrome.com/docs/extensions/reference/manifest, 25.09.2026]

3. Content scripts могут состоять из JavaScript-файлов, CSS-файлов или их комбинации. [Источник: Chrome Content Scripts, https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts, 25.09.2026]

4. Страницы расширения, включая popup и options page, реализуются HTML-файлами и могут подключать JavaScript и CSS. [Источник: Chrome Hello World tutorial, https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world, 25.09.2026]

5. Иконки расширения задаются путями к файлам через поле `icons`; Chrome рекомендует использовать PNG. [Источник: Chrome Manifest Icons, https://developer.chrome.com/docs/extensions/reference/manifest/icons, 25.09.2026]

6. Поле `web_accessible_resources` позволяет объявлять ресурсы расширения, доступные веб-страницам; это могут быть файлы JavaScript, CSS, изображения и другие ресурсы. [Источник: Chrome Web Accessible Resources, https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources, 25.09.2026]

7. Для локализации используются JSON-файлы сообщений в каталогах `_locales/<locale>/messages.json`. [Источник: Chrome Manifest Locales, https://developer.chrome.com/docs/extensions/reference/manifest, 25.09.2026]

8. В расширении могут использоваться файлы шрифтов и другие статические ресурсы, если они корректно подключены и, при необходимости, объявлены как web-accessible resources. Точный исчерпывающий список допустимых расширений файлов в Manifest V3 не задан одним отдельным перечнем. [Источник: Chrome Web Accessible Resources, https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources, 25.09.2026]

## Самопроверка

- [x] Секция Result заполнена реальным содержимым.
- [x] Отчёт содержит реальные факты, а не placeholder.
- [x] Каждый пункт DoD проверен; уровни уверенности и даты указаны.
- [x] Для каждого факта приведена inline-ссылка на известный первичный источник; неподтверждённые детали явно ограничены.

---RESULT---

Chrome Extension Manifest V3 использует обязательный `manifest.json` и поддерживает JavaScript, HTML, CSS, JSON-файлы локализации, изображения, шрифты и другие статические ресурсы. Точный формат определяется назначением файла и соответствующим полем манифеста; единого закрытого списка расширений файлов для всего расширения нет.

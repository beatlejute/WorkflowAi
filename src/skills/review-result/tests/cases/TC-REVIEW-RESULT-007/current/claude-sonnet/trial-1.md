**Вердикт: failed**

Grep по ключевим іменам UI-елементів ("Reload Workspace", "Toggle Inspector", "Export Diagnostics", "Pin Item", "Archive Item", "archivable") повернув лише тікет, fixtures та trial-runs — жодного product source-of-truth (JSX, конфіг, `package.json/contributes`, spec).

Principle 7 вимагає перевірити хоча б 1-2 конкретних імені з source-of-truth до `passed`. Source відсутній — evidence сфабрикований або ніколи не верифікований.

---RESULT---
status: failed
issues:
  - "DoD TC-1/TC-2/TC-3: конкретні імена UI-елементів («Foo: Reload Workspace», «Foo: Toggle Inspector», «Foo: Export Diagnostics», «Pin Item», «Archive Item», умова archivable) не підтверджені жодним source-of-truth. Grep по всіх цих термінах повернув виключно тікет, fixtures та trial-runs — жодного product-файлу (JSX, декларативний конфіг, package.json/contributes, spec). Принцип 7: розбіжність або відсутність source-ссылки ⇒ failed."
---RESULT---

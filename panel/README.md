# Панель подписок iMag (Cloudflare Pages)

Отдельный Pages-проект (не трогает `imag-hall-view`). Собран в режиме
**Advanced mode**: файл `public/_worker.js` обрабатывает все запросы —
отдаёт страницу и API. Сервис-role ключ Supabase живёт переменной
окружения Pages-проекта (server-side, в браузер не попадает). Вход по
паролю (`PANEL_PASSWORD`), пароль запоминается в браузере.

Что умеет: список лицензий с бейджами («истекает через N дн», «истекла»,
«отозвана», «на связи X дн назад»), поиск, счётчики; **Выпустить** (строка
в таблице `licenses`, её id = код активации для кассы), **Продлить** (та же
логика, что workflow «Продлить»: от сегодня или текущего срока — что позже,
`revoked` снимается) с готовым текстом клиенту, **Отозвать/Вернуть**.

Вкладка **«База»** — просмотр и правка любых таблиц общей базы Supabase:
список таблиц и первичные ключи берутся из OpenAPI-описания PostgREST
(`/rest/v1/`), строки читаются постранично с сортировкой и фильтром;
редактирование, добавление и удаление строк — по первичному ключу
(при сохранении отправляются только изменённые поля, пустое поле = NULL).

Структура:
```
license-admin/panel/
  public/_worker.js   ← вся панель (страница + API), Pages Advanced mode
  README.md
```

## Деплой нового Pages-проекта (один раз)

Тем же способом, что `imag-hall-view`. Через CLI:

```bash
cd license-admin/panel
npx wrangler pages project create imag-license-panel   # создать проект (один раз)
npx wrangler pages deploy public --project-name imag-license-panel
```

Либо через дашборд: **Cloudflare → Workers & Pages → Create → Pages →
Direct upload**, имя `imag-license-panel`, загрузить папку `public`.

## Переменные окружения (обязательно)

Dashboard проекта → **Settings → Environment variables → Production** (или
`npx wrangler pages secret put …`). Задать:

- `SUPABASE_URL` — адрес проекта лицензий, `https://<ref>.supabase.co`
  (тот же, куда стучится касса за активацией; ref у тебя `uvuzotcilselezjwrpmb`).
- `SUPABASE_SERVICE_ROLE_KEY` — service_role ключ того же проекта
  (Supabase → Settings → API). **Секрет**, шифруется.
- `PANEL_PASSWORD` — пароль для входа в панель (придумай сам).
- `OWNER_KASPI_PHONE` — необязательно, номер для текста клиенту.

После задания переменных — передеплой (`wrangler pages deploy public` ещё
раз или Retry deployment в дашборде), чтобы они применились.

Адрес будет вида `https://imag-license-panel.pages.dev` — открываешь,
вводишь `PANEL_PASSWORD`.

## Обновление

Правишь `public/_worker.js` → снова `npx wrangler pages deploy public
--project-name imag-license-panel`. Переменные сохраняются.

## Ограничения (осознанные)

- **Отзыв действует на кодовые активации** (касса ловит `revoked` через
  `/status` при выходе в интернет). Для лицензий, выданных файлом `.lic`
  без активации по коду — как раньше, workflow «Отозвать» (обновляет
  `crl.json`).
- **Выпуск из панели** заводит строку в `licenses` под активацию по коду
  (клиент вводит id на кассе, `.lic` подписывает функция `activate`).
  Готовый `.lic`-файл без активации — по-прежнему workflow «Выпустить».
- Пароль — простое сравнение. Для панели одного владельца достаточно;
  если нужен вход по коду на e-mail — поверх включается Cloudflare Access,
  без правок кода.
- Автовыставления счетов нет (у Kaspi нет публичного API) — панель даёт
  готовый текст со счётом после «Продлить»/«Выпустить».

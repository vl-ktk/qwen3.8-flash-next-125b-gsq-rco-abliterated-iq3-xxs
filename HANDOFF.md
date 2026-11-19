# HANDOFF — Qwen 125B / Windows MCP

Дата: 2026-11-19.

**Актуальный статус на 19.11.2026:** при повторном **полностью новом** подключении ChatGPT владелец после ввода пароля получал `{"error":"invalid_request"}` на POST `/authorize`, поэтому гипотеза об истечении старой 10-минутной сессии не объясняет проблему. Точная причина из старого ответа неизвестна: v6 скрывала несколько ошибок под одним кодом. Опубликован **v7** целевого Worker `qwen125b-mcp`, version **`3b9cc9c3-8b0b-4d9b-a467-79cc023de696` (100%)**, deployment **`3a833183-c78b-4cc2-8d3b-ba1903103840`**. v7 возвращает только безопасные `reason` для сбоев consent (cookie/session/submitter/completion), **не логирует и не раскрывает пароль/токены/handle**; проверка Origin/PKCE/сессионной cookie осталась строгой. [PR #5](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/5), main merge `c21743889e9914755237923f7e59d41cfb876aba`; [CI 44514600926](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44514600926) SUCCESS: **25/25 тестов**, npm ci/check/build PASS, включая 2 ChatGPT scopes. Секрет `secret_text`, OAuth SQLite DO и VPC binding сохранены, значения секретов не читались. **Реальный POST после v7 ещё не повторён; пункт 7 [ ], пункты 8–24 [ ].** Следующее: владелец заново проходит ChatGPT consent и сообщает `error` + `reason` либо успех; затем исправить выявленную причину, повторно опубликовать и завершить живой OAuth. **Откат:** v6 `1a90b1b6-1bb3-4e0a-b48d-705395bf2149`, deployment `9f53720f-17b5-4d68-afef-2cc61cdbebdb` (старый общий `invalid_request`); v4 с `plain_text` не использовать. Подробности: `docs/STEP_7_REPORT.md`. Ниже — исторические статусы.

**Источник истины:** приватный репозиторий `vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs`, ветка `main`.

## Задача
Подготовить систему Qwen3.8-Flash-Next 125B GSQ-RCO Abliterated IQ3_XXS от SC117 на компьютере друга под Windows с RTX 3090 Ti 24 ГБ, i9-12900K и 64 ГБ RAM; управление через собственный MCP на Windows, Cloudflare Tunnel и ChatGPT, с одним предварительно подготовленным инсталлятором и режимами «ИИ / Игры».

## Что сделано
- Зафиксирована архитектура одного MCP-сервера на Windows без отдельного Windows-агента и без нового пользователя Windows.
- Создан отдельный приватный GitHub-репозиторий с полным набором документации, включая план из 24 пунктов.
- Старые TensorDock/GPU-аренды, 27B и чужие проекты не переносились.
- Документы мигрированы из `vl-ktk/ai-development-system`, ветки `staging/qwen125b-new-repository-2026-11-19`, commit `95c9178de49ae2ead12e38e6046a5c1944dced8d`.

## Что осталось
- Пункты 7–24 из `docs/ROADMAP_24.md`.
- Реализация MCP, авторизации, Cloudflare, установщика, Windows services, обновления/отката.
- Установка на реальный компьютер друга и проверка запуска SC117 125B в Strata. Совместимость ещё не подтверждена.
- Отдельный CPU-проект Qwen 35B документирован в очищенном `vl-ktk/ai-development-system`; фактическое переименование репозитория на стороне GitHub ещё нужно проверить.

## Исходные версии, откат, проверки
- Новый приватный репозиторий до переноса: `e29838bd4839fb36118c567170abf1bdfe6c54b0` (первоначальный README).
- Предыдущий общий исходник: `8e5af8c43ef7b9f65a58e02275ae94913a60d1b5`, ветка `archive/ai-development-system-pre-split-2026-11-19`.
- Конкретный финальный commit публикации проверять по актуальному `main`; архивы сохранять до подтверждённого восстановления.
- Проверены только GitHub файлы и история; Windows/MCP/Cloudflare/Strata/LLM не установлены и не тестировались.
- Деплой, расходы, изменение AI Agent Engine и секретов не выполнялись.

## Правило владельца от 19.11.2026
- Все дальнейшие изменения, коммиты, документация, код, тесты и `HANDOFF.md` **только в этом репозитории**, ветка `main` либо отдельные ветки в нём по необходимости.
- **Строго по `docs/ROADMAP_24.md`**, последовательное выполнение пунктов без пропусков и без самовольной замены архитектуры или модели.
- Другие репозитории не менять. Если пункт 3 требует ознакомиться с существующим MCP-кодом, разрешён только просмотр исходников по необходимости без копирования секретов и без изменений чужих проектов.
- Статус на 19.11.2026 после пункта 6: пункты 1–6 [x] (облачная конфигурация, без живой Windows-связи), ближайший пункт **7 (OAuth/контроль инструментов)** [ ]; пункты 8–24 [ ]. Пункт 3 закрыт как инвентаризация, пункт 4 как проектная конфигурация; фактического MCP ещё нет.

## Выполнение пункта 3 — инвентаризация (19.11.2026)
- Отчёт: `docs/MCP_REUSE_INVENTORY.md`. Прочитаны выборочные исходники `vl-ktk/instagram-mcp` и `vl-ktk/ai-agent-engine` (только чтение), получен read-only список Cloudflare Worker Scripts.
- Подтверждены идеи для защищённого HTTP/HMAC, Windows DPAPI/ACL, одноразовой привязки, default-deny grants, журнала аудита, whitelist команд, redacted errors.
- **Не обнаружено подтверждённой готовой реализации MCP OAuth server / Windows MCP Streamable HTTP** для непосредственного импорта. Удалённые Worker scripts содержательно прочитать не удалось, это ограничение проверки.
- Ничего не копировалось из иных проектов, все изменения только в целевом GitHub.
- Пункт 3 был завершён документально; следующий пункт после конфигурации (4) — строго **5**. Ни Cloudflare Tunnel, ни Windows-сервис, ни приложение не создавались.

## Пункт 4 — завершён как конфигурация (19.11.2026)

**Поправка к первоначальному предположению о домене.** Cloudflare аккаунт уже подключён. Через API подтверждены Workers subdomain `vl-ktk` и 8 существующих Worker Scripts; нет доступных DNS-зон (0) и Tunnel (0). Отсутствие DNS-зоны не означает, что Cloudflare недоступен.

- Для облачного публичного входа выбран отдельный, **пока не опубликованный** Worker `qwen125b-mcp` с проектным URL `https://qwen125b-mcp.vl-ktk.workers.dev/mcp`.
- Для доступа к Windows MCP выбран Workers VPC Service (бета) через отдельный Cloudflare Tunnel. Cloudflare официально документирует эту схему, но её совместимость с аккаунтом, правами, ChatGPT MCP и Windows **ещё не проверялась**.
- Подготовлены `docs/CONFIGURATION.md` и `config/windows-mcp.defaults.json`; пути Windows, порт, служба, ограничения, модель и логи зафиксированы.
- **Пункты 1–4 отмечены [x] как подготовка.** Далее строго пункт **5**, создать отдельный Tunnel, проверить права Cloudflare Workers VPC. Не переходить к пункту 6 без результата.
- Не создавались новые Worker/Tunnel/VPC/Windows сервисы; не было платежей, секретов, действий на ПК или изменений сторонних репозиториев.
- Смена конфигурации сделана на базе main `d0c6d6965cd922c35690105adf835d68e876cfe1`; этот SHA — исходная точка для восстановления предыдущей версии.

## Пункт 5 — реальное создание отдельного Cloudflare Tunnel (19.11.2026)
- **Cloudflare resource:** `ktk-qwen125b-friend-pc`; ID `b49f90d5-3f8a-4aca-aeaf-c44c563b215c`; `remote_config=true`; состояние `inactive`, 0 соединений, пустая ingress-конфигурация, версия 0.
- Создание через официальный Cloudflare API `POST /accounts/{account_id}/cfd_tunnel` с `config_src=cloudflare`; после создания повторно GET-проверены ресурс, соединения и отсутствие других туннелей.
- **8 существующих Worker Scripts сохранены, не менялись**. Не было изменений маршрутов, публичного Worker, DNS, Access и Windows.
- Записано в `config/windows-mcp.defaults.json` и `docs/CLOUDFLARE_TUNNEL.md`, без секретов, токенов или credentials-file. Cloudflare token не получался отдельно и не хранится в репозитории.
- Проверка Workers VPC binding и связь Worker→Tunnel→Windows остаются в **пункте 6**. Вновь созданный Tunnel не работает до запуска cloudflared на ПК друга.
- **Следующий пункт — 6**, настройка HTTPS/маршрутизации. Реального рабочего MCP / OAuth нет, доступ к ПК друга отсутствует.
- До записи исходник main: `abe42822539f93855359c0f60d765d1b6831f564`; использовать для отката GitHub документации. Облачный ресурс при Git rollback **не удаляется автоматически**. Его нельзя удалять, если он уже применяется.

## Пункт 6 — облачная маршрутизация (19.11.2026)
- Создан VPC Service `ktk-qwen125b-mcp-origin`, ID `01a1f103-bc58-78c2-97ef-91331e10775e`, HTTP `127.0.0.1:8765` через Tunnel `b49f90d5-3f8a-4aca-aeaf-c44c563b215c`.
- Worker `qwen125b-mcp` опубликован: deployment `52f78262-bc33-43e2-af8e-f6a5c215b812`, version `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7` (100%), `workers.dev` enabled, previews disabled.
- Binding `QWEN_MCP_ORIGIN` подтверждён, другие Workers не изменялись. Worker не делает upstream fetch и **отказывает 401** на любые MCP-запросы до пунктов 7–8.
- Локальные проверки Node 22: синтаксис PASS, 8/8 тестов PASS, точный SHA исходников/тестов совпал с GitHub.
- Внешний HTTPS smoke-test НЕ выполнен из-за DNS в доступном окружении. Tunnel inactive, сквозная связь с Windows отсутствует и не проверена.
- Отчёт: `docs/CLOUDFLARE_ROUTING.md`. Без новых секретов в GitHub. Ни одной операции на ПК друга не было.
- Следующий пункт строго **7**, OAuth и контроль инструментов. До этого MCP остаётся заперт.
- Для экстренного отключения нового публичного URL: Cloudflare API POST /accounts/{account_id}/workers/scripts/qwen125b-mcp/subdomain с enabled:false. Это не удаляет чужие ресурсы.
- Исходный GitHub SHA до итоговой фиксации: `ab13697a653711612d54474a594434e10f9b3944`. Git rollback не откатывает Cloudflare deployment автоматически.

## Пункт 7 — первоначальный поиск исходного OAuth Worker (исторический аудит 19.11.2026)
- Подтверждён действующий Cloudflare Worker `instagram-mcp-oauth-test`, активная версия 38 и существующие OAuth KV и secret bindings. Это источник для переиспользования, а не повод писать всю OAuth-систему заново.
- Исходный JS/модули **не удалось получить** текущим Cloudflare connector (только metadata), поиск GitHub кода не нашёл дубликата. Запрет на заявление о состоявшемся копировании.
- Отчёт: `docs/OAUTH_REUSE_SOURCE.md`. Без изменений исходного Worker и секретов.
- Шаг **7 [ ]**, новый Qwen Worker остаётся `fail-closed`. Нужен авторизованный экспорт исходников версии 38 (Cloudflare Dashboard / Wrangler) для независимой адаптации.

## Пункт 7 — реализация по Issue #1 (19.11.2026)
- База: `main` `c2f17225003f507e4965c303ec2db48658b36c49`; работа только в этом репозитории. `ROADMAP.md` в корне отсутствует; используется канонический `docs/ROADMAP_24.md`. Файлы `AGENTS.md` в checkout и родительских каталогах не обнаружены; соблюдены инструкции владельца из задания и HANDOFF.
- Cloudflare `/content/v2` действительно возвращает исходный multipart **строкой напрямую**, а не в `.result`. Получен `oauth.js`; общий provider сохранён в `src/cloudflare/vendor/`, без функций социальных сервисов, пользовательских данных и старых bindings. SHA-256 извлечённого кода совпал между Cloudflare и локальной копией. Исходные package version не угадываются.
- OAuth использует отдельный SQLite Durable Object `QWEN_OAUTH_STATE`, новый owner secret (не задан), DCR, authorization code + S256 PKCE, browser-bound consent, короткие access tokens, ротацию/отзыв, scope/tool gate и привязку MCP-сессий к grant. Транзакции исключают повторное использование кода при конкурентном обмене. Старая KV не привязывается.
- VPC forwarding реализован только после успешной проверки токена и метода/scopes; тестируется на локальном stub. До настройки OAuth действует fail-closed. Одноразовая привязка Windows, защищённые команды и инсталлятор не реализуются в этом шаге.
- Проверки: 21/21 Node + Miniflare/workerd, `npm run check`, локальный Wrangler dry-run PASS. CI подготовлен без деплоя. Подробная матрица в отчёте.
- **Пункт 7 не закрывать:** фактический ChatGPT connector и Windows origin не проверены. Деплой запрещён до отдельного разрешения; новый owner secret и облачный DO не создавались. Текущий опубликованный Qwen Worker всё ещё версия `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7` и заперт. Не переходить к шагу 8 автоматически.
- Исходный OAuth Worker v38 / deployment `63e07038-6e8a-4961-9009-0ecba1afae6d` не изменён. Все обращения Cloudflare — GET, без чтения значений KV/секретов. Новых платежей и изменений других репозиториев нет.
- Для локального отката использовать базу выше или revert PR. Это не меняет Cloudflare; при последующем разрешённом деплое отдельно сохранять предыдущую Worker version и учитывать состояние DO. Секрет не помещать в Git/чат/установщик.

## Пункт 7 — публикация OAuth-кода в Cloudflare (19.11.2026)
- Владелец отдельно разрешил настройку и публикацию Qwen OAuth. Перед upload перепроверен deployment v1 `52f78262-bc33-43e2-af8e-f6a5c215b812`, version `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7` (100%).
- Загружены четыре ES module файла из актуального GitHub main; в метаданных сохранены совместимость 2026-11-17 и VPC binding. Применена `new_sqlite_classes` миграция `qwen-oauth-v1` для нового `QwenOAuthState`.
- Cloudflare GET после upload подтверждает Qwen Worker v2 `b8946e83-551d-433a-804b-6b33f920a7d2` (100%), deployment `fad59a18-3013-49ed-812f-2c8891f11c65`, DO namespace `162cfb67fccc40f5907b0093b7a7f944`, `QWEN_OAUTH_GENERATION=1`, сохранённый VPC service ID `01a1f103-bc58-78c2-97ef-91331e10775e`. Старый Instagram OAuth Worker не изменялся.
- Новый `QWEN_OAUTH_OWNER_PASSWORD` не установлен и не записан в Git/чат. Реальная браузерная проверка `https://qwen125b-mcp.vl-ktk.workers.dev/__edge_status` вернула `state: locked`; OAuth discovery — `authorization_not_configured`; `/mcp` без Bearer — `invalid_token`. Локальный curl из рабочей среды тайм-аут; успешна проверка через подключённый Chrome. Реальный OAuth consent/token и Windows origin не проверялись.
- Следующее действие: владелец устанавливает отдельный owner password длиной не менее 5 символов напрямую в Cloudflare Secret `QWEN_OAUTH_OWNER_PASSWORD` для `qwen125b-mcp`, затем проверяются новый deployment, OAuth discovery и реальная авторизация ChatGPT. Без доступного Windows MCP сквозной upstream остаётся непроверенным. **Пункт 7 пока [ ].**
- Откат: вернуть на 100% Cloudflare version `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7`; откат GitHub и Cloudflare независимы. При появлении OAuth grants не удалять DO без явного согласия.

- **Решение владельца от 19.11.2026:** минимальная длина `QWEN_OAUTH_OWNER_PASSWORD` — **5 символов** (ранее 32). Сохранён лимит 5 неверных попыток за 15 минут. Пять символов — слабая защита, рекомендуется фактический пароль длиннее. Новый секрет пока не задан; изменение опубликовано в Qwen Worker v3 после GitHub Actions 22/22 PASS.
## Пункт 7 — изменение min password=5 опубликовано (19.11.2026, 10:14 UTC)
- По прямому решению владельца в коде `isConfigured` минимальная длина `QWEN_OAUTH_OWNER_PASSWORD` снижена с 32 до 5; ограничение 5 неверных попыток за 15 минут, PKCE/scopes и запреты Windows mutations сохранены.
- GitHub PR #3 merged, main commit `7f51544fdfecb29a55a5b0ffb58e3facddbe594d`. CI run `44503656174` SUCCESS: 22/22 теста PASS, npm ci/check/build dry-run PASS, включая границу 4/5 символов.
- Прямо перед upload Cloudflare подтвердил Worker v2 `b8946e83-551d-433a-804b-6b33f920a7d2` (100%), deployment `fad59a18-3013-49ed-812f-2c8891f11c65`. После upload проверено: Worker v3 `4a2b0e5c-1d4f-46e8-b2c1-23f462064aef` (100%), deployment `6c2993ee-a0c6-4d3d-b7e1-d91ffa5e70aa`; тот же DO namespace `162cfb67fccc40f5907b0093b7a7f944` и VPC ID `01a1f103-bc58-78c2-97ef-91331e10775e`. Secret `QWEN_OAUTH_OWNER_PASSWORD` по-прежнему отсутствует; живая OAuth-проверка не выполнена.
- Откат именно этого исправления: в Cloudflare развернуть прежнюю версию v2 `b8946e83-551d-433a-804b-6b33f920a7d2`, deployment `fad59a18-3013-49ed-812f-2c8891f11c65`. Изолированное OAuth-состояние не удалять. Пункт 7 всё ещё [ ] до реального подключения ChatGPT/Windows MCP.


## Пункт 7 — Cloudflare Secret и живой OAuth smoke-test (19.11.2026)
- Владелец установил переменную `QWEN_OAUTH_OWNER_PASSWORD`; Cloudflare API проверил только **имя и тип `secret_text`**, значение пароля не извлекалось, не сохранялось, не выводилось в чате или GitHub.
- Последний Cloudflare dashboard deployment: `04507195-c5d1-4e32-81a8-463f15d6d7c1`, Worker version `3e6fee92-a2bf-476f-8f86-c8c6b9b8f41a` 100%. Версия непосредственно перед этой публикацией: `f84c4b6d-5769-49b9-ae73-b87c5130e396`, deployment `c4b0fb29-ba90-4298-b46c-f35a3af0fb51` (временная `plain_text`; не восстанавливать как рабочую). Для безопасного fail-closed отката есть v3 `4a2b0e5c-1d4f-46e8-b2c1-23f462064aef` / `6c2993ee-a0c6-4d3d-b7e1-d91ffa5e70aa`, однако откат Cloudflare не равен Git rollback и состояние DO не удаляется.
- Сохранены `QWEN_OAUTH_STATE` (`QwenOAuthState`, namespace `162cfb67fccc40f5907b0093b7a7f944`) и `QWEN_MCP_ORIGIN` (VPC service `01a1f103-bc58-78c2-97ef-91331e10775e`).
- Живой браузерный GET `https://qwen125b-mcp.vl-ktk.workers.dev/__edge_status` подтвердил `protected`; `/.well-known/oauth-authorization-server` вернул issuer, authorize, token, register, protected resource и `S256`; `/mcp` без Bearer вернул JSON `invalid_token`. Это **не** доказательство реальной OAuth авторизации или готовности Windows upstream.
- Предыдущее CI PR #3 — 22/22 PASS, check и dry-run PASS; при ручной смене binding кодовых изменений, повторного test suite и новой публикации исходников не было.
- **Осталось строго в пункте 7:** настроить ChatGPT MCP connector на `https://qwen125b-mcp.vl-ktk.workers.dev/mcp`, проверить живой DCR → consent → PKCE → code → token, а Windows origin/туннель проверить только когда Windows MCP будет готов на следующем соответствующем этапе ROADMAP. До этого нельзя объявлять шаг 7 или end-to-end готовым.

## Пункт 7 — исправление browser consent Origin, Worker v6 (19.11.2026)
- Обнаружено пользователем в ChatGPT: после заполнения owner password и POST `/authorize` браузер получал `{"error":"invalid_origin"}`. Первичный GET и OAuth discovery проходили. Причина: заголовок `Referrer-Policy: no-referrer` на consent HTML заставлял браузер отправлять для same-origin form POST `Origin: null`, а OAuth корректно разрешает только issuer-origin. Изменён **только** header на `Referrer-Policy: same-origin`; проверка Origin остаётся строгой, никаких обходов CSRF/PKCE не добавлено.
- Код `src/cloudflare/oauth.mjs`, регрессионный сценарий `src/cloudflare/worker.test.mjs`, [PR #4](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/4), merge main `3814c994a5df8e4414a7bf8c387277c167316acd`. [GitHub CI run 44511720844](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44511720844) завершён SUCCESS: `npm ci`, `npm run check`, `npm test` **23/23 PASS**, `npm run build` PASS.
- Перед загрузкой: Cloudflare v5 `3e6fee92-a2bf-476f-8f86-c8c6b9b8f41a`, deployment `04507195-c5d1-4e32-81a8-463f15d6d7c1`. Новая версия v6 загружена отдельно через versions API с `bindings_inherit=strict`. API подтвердил все bindings в версии v6, включая пароль `secret_text`, DO namespace `162cfb67fccc40f5907b0093b7a7f944`, VPC ID `01a1f103-bc58-78c2-97ef-91331e10775e`. **Непосредственно перед deploy** v5 перепроверена и не изменилась.
- После публикации GET deployment: Cloudflare v6 `1a90b1b6-1bb3-4e0a-b48d-705395bf2149` 100%, deployment `9f53720f-17b5-4d68-afef-2cc61cdbebdb`. GET settings снова подтвердил все четыре bindings. Подключённый браузер Chrome: `/__edge_status` → `protected`, discovery → корректные OAuth endpoints и scopes, `/mcp` без Bearer → `invalid_token`. Реальный POST `/authorize` после ввода пароля **ещё не повторяли**, поэтому завершение ChatGPT OAuth не заявлено.
- **Следующее:** владелец заново подключает плагин ChatGPT по URL `https://qwen125b-mcp.vl-ktk.workers.dev/mcp`, проходит пароль/согласие и сообщает результат. Полный Windows upstream пока невозможен: Tunnel не подключён к компьютеру друга. Пункт 7 остаётся [ ] до проверки подключения ChatGPT; пункты 8–24 не менялись.
- Откат: Cloudflare развернуть прежнюю **v5** `3e6fee92-a2bf-476f-8f86-c8c6b9b8f41a` 100% (deployment `04507195-c5d1-4e32-81a8-463f15d6d7c1`); это возвращает дефект Origin. Восстановление GitHub `main` — отдельная операция. **Не выбирать v4** `f84c4b6d-5769-49b9-ae73-b87c5130e396` (ранее password `plain_text`). Сохранить OAuth DO; не удалять/не сбрасывать существующие credentials.

## Пункт 7 — диагностика нового `invalid_request` после consent, Worker v7 (19.11.2026)
- Владелец подтвердил, что **запустил OAuth из ChatGPT заново**, а не переиспользовал старую форму. Сбой `invalid_request` на POST `/authorize` реальный. В v6 `errorResponse` сводил отсутствующую/просроченную cookie, неверный handle, отсутствие submitter и ряд отказов завершения в один ответ; по скриншоту точную ветку определить невозможно. Без разрешения владельца секрет не запрашивался и не читался.
- В `src/cloudflare/oauth.mjs` добавлены безопасные коды `reason`: `consent_cookie_missing`, `consent_cookie_mismatch`, `consent_expired`, `consent_handle_missing`, `consent_session_invalid`, `consent_handle_invalid`, `consent_duplicate_field`, `consent_decision_missing`, `consent_auth_record_invalid`, `consent_completion_invalid`. Эти ответы доступны лишь на сбое, не содержат cookies/handles/паролей/клиентских идентификаторов; никакого bypass CSRF или автоподтверждения нет.
- `src/cloudflare/worker.test.mjs`: новый позитивный сценарий browser consent с двумя scope (`qwen:read qwen:files:read`), `ui_locales` и повторяющимися полями `scope`; негативный тест классификации отсутствующей cookie, decision и истёкшей транзакции. [PR #5](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/5) MERGED → main `c21743889e9914755237923f7e59d41cfb876aba`; [CI 44514600926](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44514600926) SUCCESS: **25/25 PASS**, npm ci/check/build PASS.
- Прежде: Cloudflare v6 `1a90b1b6-1bb3-4e0a-b48d-705395bf2149`, deployment `9f53720f-17b5-4d68-afef-2cc61cdbebdb`. Из GitHub main загружены 4 ES modules как отдельная v7 через strict inherited bindings. Staged GET подтвердил `QWEN_OAUTH_OWNER_PASSWORD` `secret_text`, DO `162cfb67fccc40f5907b0093b7a7f944`, VPC `01a1f103-bc58-78c2-97ef-91331e10775e`; непосредственно перед deploy active v6 перепроверена. После деплоя Cloudflare GET подтвердил v7 **`3b9cc9c3-8b0b-4d9b-a467-79cc023de696` 100%**, deployment **`3a833183-c78b-4cc2-8d3b-ba1903103840`**, все четыре bindings без потерь.
- **Не заявлять как исправление корневой причины:** v7 — безопасная диагностика, текущий повторный живой browser POST/получение code и token ещё не выполнены. Владелец должен пройти новую авторизацию и показать `reason` либо успех; после этого выполнить конкретный fix. Windows origin/Tunnel остаются отдельным незавершённым этапом. Шаг 7 [ ].
- Откат v7: Cloudflare v6 `1a90b1b6-1bb3-4e0a-b48d-705395bf2149`, deployment `9f53720f-17b5-4d68-afef-2cc61cdbebdb`, в котором осталась общая ошибка. Не откатывать на v4 с `plain_text`; состояние DO/секреты не удалять.

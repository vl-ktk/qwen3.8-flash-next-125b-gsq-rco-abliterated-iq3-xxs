# Шаг 7: OAuth и контроль MCP-инструментов

Дата: **19.11.2026**, Europe/Bucharest. Основание: [Issue #1](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/issues/1).

**Исторический статус v8:** живой Chrome после повторного OAuth POST показал `{"error":"invalid_request","reason":"consent_cookie_missing"}`: браузерная cookie не пришла на backend. Конкретно почему — хранение, истечение или пересылка — по этому ответу не доказано. Исправлена возможность подтверждения, когда cookie не пришёл, с отдельным одноразовым проверяемым 256-битным form proof + строгими Origin / `Sec-Fetch-Site`. Cloudflare Worker **v8 `62961a30-37dc-4a49-a8f0-f787e8989b3b` (100%)**, deployment **`b18e7b13-b9ed-4955-accf-e09290cab8b1`**; [PR #6](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/6), merge main `db1601d79feb19d4ccdf53be36bd3b72583dcb75`; [CI 44524088590](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44524088590) PASS **27/27**, check, build. Три исходных Cloudflare ресурса и secret `secret_text` сохранены. Живой Chrome GET v8 показал корректную ChatGPT consent форму с hidden form proof и обоими scope; **живой POST/code/token после v8 пока не проверен**. Шаг 7 [ ], 8–24 [ ]; отчёт v8 в конце документа.

**Актуально: v9 опубликована 100%**, version `416972ed-8eab-4354-bfbe-3c1745828126`, deployment `1fe57ebb-1438-4190-85fb-d45ef670d416`. PR #7 MERGED, CI 44529378371 SUCCESS, 32/32 тестов. Живые cookie/no-cookie, expiry recovery, Chrome callback и реальный owner **code → token** проверены. OAuth исправлен; полное MCP-подключение с инструментами ещё не завершено (403 на следующем методе, Windows MCP/Tunnel отсутствуют). Подробности ниже.

## Источник и границы

База `main`: `c2f17225003f507e4965c303ec2db48658b36c49`. Прочитаны HANDOFF, `docs/ROADMAP_24.md`, OAUTH_REUSE_SOURCE, CLOUDFLARE_ROUTING, ARCHITECTURE, SECURITY, TEST_PLAN и MCP_REUSE_INVENTORY. Корневого `ROADMAP.md` и применимых `AGENTS.md` в checkout/родительских каталогах нет; канонический roadmap находится в `docs/ROADMAP_24.md`.

Реальный общий OAuth provider получен из активного `instagram-mcp-oauth-test` v38 через read-only Cloudflare API. Проблема прошлой проверки состояла в обработке raw string как JSON `.result`. Происхождение, точные границы, SHA-256, лицензия и воспроизводимое извлечение описаны в [OAUTH_REUSE_SOURCE](OAUTH_REUSE_SOURCE.md). Реализация не основана на догадках или новой OAuth-библиотеке из npm.

## Что реализовано

| Область | Поведение |
|---|---|
| Discovery | Канонический issuer `https://qwen125b-mcp.vl-ktk.workers.dev`; resource `/mcp`; RFC 9728 metadata на обоих well-known путях; Bearer challenge с `resource_metadata` |
| DCR | `/oauth/register`; public и confidential clients; HTTPS/безопасные loopback redirect URI проверяет перенесённый provider; client lifetime 7 суток |
| Авторизация | `/authorize`; authorization code; обязательный S256 PKCE для всех клиентов; state/issuer возвращаются через URL encoding; redirect должен совпасть с зарегистрированным |
| Подтверждение | Явное согласие владельца, показ клиента/redirect/scopes, HTML escaping, CSP, `__Host-` Secure/HttpOnly cookie и одноразовая транзакция; если cookie отсутствует, альтернативный случайный одноразовый form proof на 600 секунд, строгие Origin + Sec-Fetch-Site. Неверная cookie не обходит проверку |
| Владелец | Отдельный новый secret минимум 5 символов; constant-work сравнение SHA-256; не более 5 попыток подтверждения за 15 минут на issuer. DCR 30/час, protocol 180/минуту |
| Токены | Access 10 минут; refresh 24 часа; ротация и отзыв; повтор предыдущего refresh token отзывает grant. Предыдущий token не используется как «успешный retry», в отличие от исходной библиотеки |
| Хранилище | `QWEN_OAUTH_STATE`: новый SQLite Durable Object; KV-совместимый адаптер и атомарные транзакции OAuth. Нет привязки к старым namespaces. Expiry проверяется при чтении, alarm удаляет старые записи |
| MCP gate | Каждый запрос требует Bearer header; exact audience, expiry, owner, project, generation, действующий grant и scope; cookies, query token, поддельные identity/session headers не авторизуют |
| Права | `qwen:read`: system_info/system_monitor/process_list/service_status/app_status; отдельный `qwen:files:read`: file_read. Это контракт будущих Windows tools. PowerShell, запись, reboot, lifecycle, неизвестные tools/methods и JSON-RPC batch запрещены |
| VPC | После auth/method/scope/session проверки; только `QWEN_MCP_ORIGIN.fetch` на фиксированный `http://127.0.0.1:8765/mcp`; caller Authorization/cookies/forwarding headers удаляются; redirects запрещены, HTTP-ошибки нормализуются без внутренних деталей |
| Transport | POST/GET/DELETE, MCP headers; сессия связана с grant/client/scopes и удаляется после успешного DELETE. SSE передаётся потоком; tools/list JSON или конечный SSE ответ фильтруется по разрешённым инструментам и возвращается JSON |
| Fail-closed | Без state binding или owner secret доступ закрыт; при сбое auth/storage/origin нет разрешающего fallback. `__edge_status=protected` обозначает только наличие OAuth конфигурации, не связь с Windows |

Ограничения тела: OAuth 16 KiB, MCP 64 KiB, tools/list response 1 MiB. VPC request имеет AbortSignal 30 секунд. Долгие SSE/reconnect требуют живого теста; длительность потока и политику возобновления нужно согласовать с будущим Windows MCP.

## Выполненные проверки

Среда: Windows, Node **v24.22.0**, Miniflare **5.20261118.0-beta** / workerd **1.20261118.1**, Wrangler **4.165.0**. Зависимости зафиксированы `package-lock.json`; новая реализация выполняется в настоящем локальном Workers runtime, а не в mock-копии OAuth алгоритма. VPC заменён локальным stub; тестовые пароль/токены генерируются на запуске, внешняя сеть тестового Worker запрещена.

Команды из корня репозитория:

```powershell
npm ci
npm run check
npm test
npm run build
```

| Проверка | Фактический результат |
|---|---|
| Синтаксис четырёх production модулей | PASS |
| Интеграционные тесты | **21/21 PASS**, 0 skipped |
| Закрытая исходная конфигурация | Нет токена/поддельный Bearer/cookies/headers/все HTTP методы — отказ, 0 origin calls |
| Позитивный OAuth | DCR → browser consent → code + PKCE → access token → разрешённый tool → только VPC stub |
| Неверные credentials | Чужое хранилище, refresh вместо access, истечение access/code, отзыв grant/generation — отказ |
| PKCE/redirect/audience | Неверный/отсутствующий verifier, plain PKCE, чужой client/redirect/resource, implicit flow, дубликаты параметров — отказ |
| Consent | Чужой Origin/cookie, неверный пароль, расширение scopes, истёкший/повторный handle — отказ; denial сохраняет state без выдачи code |
| Replay и concurrency | Два одновременных code exchanges и refresh exchanges: ровно один успешен; replay отзывает grant |
| Контроль инструментов | Недостаточный scope, неизвестные/изменяющие tools, prototype names, обход URL/HTTP method/headers/batch — отказ; JSON/SSE tools list отфильтрован |
| Sessions/transport | GET/SSE/DELETE, grant-bound session, чужая/отозванная сессия и удаление после DELETE |
| Ограничения/ошибки | Размер OAuth/MCP, throttling владельца, upstream redirect/exception и malformed SSE — безопасный отказ без утечки ошибки |
| Происхождение | Хеш vendor и хеш извлечённой части совпали с provenance; социальных handlers/bindings в vendor нет |
| Bundle | Wrangler `deploy --dry-run` PASS; **ничего не uploaded/deployed**; test-only RPC класс отсутствует среди production exports |
| Git | `git diff --check` PASS |

Подготовлен GitHub Actions workflow с `npm ci`, check, test и dry-run build. Он не содержит деплоя или Cloudflare credentials. Результат локального запуска не объявляется результатом CI до его фактического выполнения.

## Не выполнено и конкретные причины

1. **Деплой и настройка Cloudflare:** владелец прямо запретил публикацию без отдельного разрешения. Новый DO и owner secret не создавались; bindings/migration существуют только в Git. Поэтому в облаке работает старый закрытый Worker.
2. **Фактический коннектор ChatGPT:** новую OAuth-версию нельзя проверить на публичном endpoint без разрешённого деплоя и отдельной настройки подключения владельцем. Нет основания утверждать совместимость по результату реального коннектора; локально проверены discovery/DCR/PKCE/protected MCP потоки.
3. **VPC → Windows:** Windows MCP ещё не реализован и ПК друга не подключён по исходным документам. Новая реализация не проверяла/не меняла ПК. Реальные Streamable HTTP, reconnect, origin identity и одноразовая привязка относятся к следующим пунктам. Stub не является доказательством сквозной связи.
4. **Windows команды/owner approvals для изменений:** шага 11/14 ещё нет. Полномочия на изменяющие операции не выдаются этим кодом; local emergency stop и device-bound origin authentication должны появиться в соответствующих следующих шагах. До них не считать систему пригодной к администрированию ПК.

Отдельного экспорта исходников или нового Cloudflare API token от владельца больше не требуется. Минимум для живой приёмки: отдельное разрешение на публикацию Qwen Worker/новое изолированное состояние, ввод нового owner secret вне Git/чата, тестовое подключение ChatGPT и доступный тестовый MCP origin. Сейчас эти действия не выполняются.

## Облачные ресурсы сохранены

Read-only API перепроверил:

| Worker | Активная version | Deployment |
|---|---|---|
| Исходный `instagram-mcp-oauth-test` | `9dd45b0a-0e55-4fbc-a97f-1801327daad5` (38, 100%) | `63e07038-6e8a-4961-9009-0ecba1afae6d` |
| Целевой `qwen125b-mcp` | `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7` (1, 100%) | `52f78262-bc33-43e2-af8e-f6a5c215b812` |

Не читались значения KV/секретов или аккаунты пользователей. Другие репозитории, Workers, KV/D1, secrets, права, Tunnel/VPC bindings и активные подключения не менялись. Платные API/LLM не вызывались.

## При следующем разрешённом этапе

Разрешение на Cloudflare не следует из merge PR. Перед разрешённой публикацией сверить текущие версии, сохранить предыдущую версию Qwen, создать только отдельное Qwen-состояние, ввести независимый secret и проверить реальные discovery/consent/connector и отказы. Не использовать старые KV/D1/пароли даже временно. Привязку устройства и контроль Windows довести строго по ROADMAP.

Откат локального кода: revert PR либо возврат к базовому SHA. Он не откатывает облачные deployments или OAuth-состояние автоматически. Облачных изменений в этом PR нет. При будущем отзыве всех access tokens увеличивать `QWEN_OAUTH_GENERATION` в разрешённом deployment; per-grant revoke доступен через OAuth token/revocation endpoint.

Проверенные первичные материалы: [Cloudflare VPC API](https://developers.cloudflare.com/workers-vpc/api/), [Durable Objects storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider). Исполняемый OAuth взят из подтверждённого Worker, а не с текущего upstream main.

## Дополнение: разрешённый Cloudflare deploy (19.11.2026)

По отдельному разрешению владельца после merge PR #2 `e5f5a67966ec4aa59d00e2c623e952353e3b8284` код Worker опубликован через официальный Cloudflare API (multipart ES modules). Это изменение **только** `qwen125b-mcp`, не original OAuth Worker.

| Параметр | Подтверждённый результат |
|---|---|
| Worker v2 | `b8946e83-551d-433a-804b-6b33f920a7d2` (100%) |
| Deployment v2 | `fad59a18-3013-49ed-812f-2c8891f11c65` |
| Новый SQLite DO | `QWEN_OAUTH_STATE` → `QwenOAuthState`, namespace `162cfb67fccc40f5907b0093b7a7f944` |
| VPC Service | `QWEN_MCP_ORIGIN` → `01a1f103-bc58-78c2-97ef-91331e10775e` (сохранён) |
| OAuth Generation | `1` |
| Secret владельца | `QWEN_OAUTH_OWNER_PASSWORD` отсутствует; не сохранялся и не выводился |
| Версия до деплоя для отката | `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7`, deployment `52f78262-bc33-43e2-af8e-f6a5c215b812` |

**Реально проверено:** Cloudflare API подтвердил новую активную версию (100%), DO binding и VPC binding; в Chrome открыты публичные `__edge_status` (`{"state":"locked","endpoint":"mcp"}`), OAuth discovery (`{"error":"authorization_not_configured"}`), `/mcp` без токена (`{"error":"invalid_token"}`). Прямой curl из изолированной среды не достиг URL (тайм-аут); проверка через браузер успешна. Cloudflare Secret пуст; полноценный реальный OAuth code/PKCE/consent, ChatGPT connection и Windows MCP пока не тестировались. Преддеплойная база тестов: CI SUCCESS 21/21, npm check, dry-run build; после Cloudflare upload тесты в production не запускались.

**Далее:** владелец вводит новый, независимый пароль владельца (не менее 5 символов) прямо в Cloudflare secret `QWEN_OAUTH_OWNER_PASSWORD` для `qwen125b-mcp`, без пересылки в чат. Затем проверить актуальные версии, статус `protected`, OAuth discovery и реальное подключение ChatGPT. Windows MCP/туннель не готовы, поэтому полный E2E остаётся блокером пункта 7. Откат через Cloudflare deployment прежней версии, не удаляя SQLite DO; Git rollback отдельно.

### Изменение требования к паролю по решению владельца (19.11.2026)
Минимальная длина независимого owner secret снижена с 32 до **5 символов**; пароль с 4 символами должен оставлять OAuth в `locked`. Механизм ограничения 5 неверных попыток за 15 минут не меняется. Использование ровно 5 символов даёт слабую защиту удалённого управления; более длинный фактический пароль предпочтителен. Изменение проверено и опубликовано в Cloudflare v3; v2 ниже отражает предыдущее состояние.

## Публикация изменения min password=5 (19.11.2026)

По решению владельца код `src/cloudflare/oauth.mjs` теперь требует только **5 символов** для секретного пароля владельца; не менялись PKCE, OAuth token rotation, session gate и 5 неуспешных попыток за 15 минут.

- [PR #3](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/3) MERGED, source commit `7f51544fdfecb29a55a5b0ffb58e3facddbe594d`.
- [CI](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44503656174) SUCCESS: npm ci/check/test (22/22 PASS, включая пароль 4 = locked, 5 = protected и вход через consent), Wrangler dry-run build PASS.
- Перед upload: версия Worker v2 `b8946e83-551d-433a-804b-6b33f920a7d2`, deployment `fad59a18-3013-49ed-812f-2c8891f11c65`, 100%.
- После upload: Worker v3 `4a2b0e5c-1d4f-46e8-b2c1-23f462064aef`, deployment `6c2993ee-a0c6-4d3d-b7e1-d91ffa5e70aa`, 100%. DO namespace остался `162cfb67fccc40f5907b0093b7a7f944`, VPC Service остался `01a1f103-bc58-78c2-97ef-91331e10775e`; исходный Instagram OAuth Worker не менялся.
- Cloudflare Secret `QWEN_OAUTH_OWNER_PASSWORD` отсутствует; поэтому в живом окружении OAuth всё ещё `locked`. Подтверждена публикация версии и конфигурация bindings через Cloudflare API; **позитивный OAuth вход в production не проверен**, Windows MCP не подключён.
- Откат изменения требования: вернуть Cloudflare v2 `b8946e83-551d-433a-804b-6b33f920a7d2`. GitHub откат отдельно; не удалять DO. ROADMAP пункт 7 остаётся [ ].


## Дополнение — Secret подтверждён и публичные OAuth адреса проверены (19.11.2026)

| Объект/проверка | Подтверждено |
|---|---|
| Активная Worker version | `3e6fee92-a2bf-476f-8f86-c8c6b9b8f41a`, 100% |
| Deployment | `04507195-c5d1-4e32-81a8-463f15d6d7c1` (dashboard, 19.11.2026 10:29:27 UTC) |
| Пароль владельца | `QWEN_OAUTH_OWNER_PASSWORD` существует как **Cloudflare `secret_text`**, значение не извлекалось |
| Durable Object | `QWEN_OAUTH_STATE` → namespace `162cfb67fccc40f5907b0093b7a7f944` |
| VPC origin | `QWEN_MCP_ORIGIN` → `01a1f103-bc58-78c2-97ef-91331e10775e` |
| Live `/__edge_status` | `{"state":"protected","endpoint":"mcp"}` |
| Live `/.well-known/oauth-authorization-server` | issuer Qwen, authorization `/authorize`, token `/oauth/token`, registration `/oauth/register`, resource `/mcp`, grant `authorization_code`/`refresh_token`, PKCE `S256` |
| Live `/mcp` без Authorization | `{"error":"invalid_token"}` |

**Проверки:** metadata Cloudflare API и публичные GET в подключённом Chrome. В этой операции код, CI, payload OAuth или Windows origin не менялись. Не проверены фактические DCR registration, ввод владельцем пароля на OAuth consent, PKCE exchange, действующий токен, ChatGPT connector, работа upstream. `protected` означает только действующую конфигурацию, а не сквозной MCP.

**История версий / откат:** до установки `secret_text` работала dashboard v4 `f84c4b6d-5769-49b9-ae73-b87c5130e396`, deployment `c4b0fb29-ba90-4298-b46c-f35a3af0fb51`, с временным binding `plain_text` — её **не следует выбирать для отката**. Аварийный fail-closed откат на код v3 `4a2b0e5c-1d4f-46e8-b2c1-23f462064aef`, deployment `6c2993ee-a0c6-4d3d-b7e1-d91ffa5e70aa`; проверить его bindings после rollback, не удалять SQLite DO. Cloudflare и Git rollback независимы.

**Следующий шаг:** вручную добавить приватный MCP connector ChatGPT, URL `https://qwen125b-mcp.vl-ktk.workers.dev/mcp` и выполнить реальную авторизацию. Пока Windows MCP не разработан и Tunnel inactive, попытки вызвать модель закономерно не подтвердят работоспособность сквозной системы. Шаг 7 не закрывать.

## Публикация v6 — исправлен `invalid_origin` после пароля (19.11.2026)

**Симптом и точная причина:** пользователь зарегистрировал MCP в ChatGPT, дошёл до owner password и после отправки HTML consent формы на `/authorize` получил `{"error":"invalid_origin"}`. В ответе на consent GET сервер отправлял `Referrer-Policy: no-referrer`; браузер для same-origin `method=post` под этой политикой мог отправить `Origin: null`. Код POST сравнивал Origin только с `https://qwen125b-mcp.vl-ktk.workers.dev` и отказывал. В `src/cloudflare/oauth.mjs` заголовок изменён на `same-origin`, чтобы браузер формировал ожидаемый Origin. Проверка Origin остаётся обязательной; `Origin: null` и чужой Origin по-прежнему возвращают 403. Тест в `src/cloudflare/worker.test.mjs` проверяет header, consent form, отказ `Origin: null` и принятие корректного Origin.

**Исходник:** [PR #4](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/4) MERGED, commit `main` `3814c994a5df8e4414a7bf8c387277c167316acd`. **Проверки:** [CI run 44511720844](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44511720844) job `edge` SUCCESS: `npm ci` PASS, `npm run check` PASS, `npm test` **23/23 PASS**, `npm run build` PASS (Wrangler dry-run). Проверено по GitHub Actions job/logs. Ручной Windows MCP не тестировался.

**Преддеплой:** активный Worker v5 `3e6fee92-a2bf-476f-8f86-c8c6b9b8f41a` 100%, deployment `04507195-c5d1-4e32-81a8-463f15d6d7c1`. В Cloudflare загружены четыре source modules из GitHub main в отдельную неактивную **v6**; binding inherit strict. Ответ Cloudflare `versions/{id}` подтвердил:

| Binding | Тип/ресурс после inherit |
|---|---|
| `QWEN_OAUTH_OWNER_PASSWORD` | `secret_text` (значение не читали/не записывали) |
| `QWEN_OAUTH_STATE` | `durable_object_namespace`, `QwenOAuthState`, `162cfb67fccc40f5907b0093b7a7f944` |
| `QWEN_MCP_ORIGIN` | `vpc_service`, `01a1f103-bc58-78c2-97ef-91331e10775e` |
| `QWEN_OAUTH_GENERATION` | `plain_text`, сохранён прежний binding |

**Непосредственно перед публикацией** заново проверено, что Cloudflare deployment всё ещё v5. Затем выложена **v6 `1a90b1b6-1bb3-4e0a-b48d-705395bf2149` на 100%**; deployment **`9f53720f-17b5-4d68-afef-2cc61cdbebdb`** (API, 11:10 UTC). После публикации Cloudflare GET deployments/settings подтвердил версию и все bindings. Публичный Chrome GET:

- `/__edge_status` → `{"state":"protected","endpoint":"mcp"}`;
- `/.well-known/oauth-authorization-server` → верные issuer/authorization/token/register/PKCE S256/scopes;
- `/mcp` без Bearer → `{"error":"invalid_token"}`.

**Чего ещё не проверяли:** живой повторный browser POST consent с владельческим паролем, получение authorization code и token реальным коннектором ChatGPT; связь Worker→Tunnel→Windows MCP отсутствует. Эти проверки не заменяются 23 локальными интеграционными тестами. Пункт ROADMAP 7 остаётся открытым. Следующее действие — заново пройти подключение ChatGPT по `https://qwen125b-mcp.vl-ktk.workers.dev/mcp`; **пароль менять не нужно**. Если подключение пройдёт, отдельно проверить вызов инструмента с учётом недоступного Windows upstream.

**Откат:** выбрать Cloudflare версию **v5 `3e6fee92-a2bf-476f-8f86-c8c6b9b8f41a`** на 100%, предыдущий deployment `04507195-c5d1-4e32-81a8-463f15d6d7c1`. v5 сохраняет дефект Origin. v4 `f84c4b6d-5769-49b9-ae73-b87c5130e396` не использовать: в её истории был небезопасный `plain_text` binding. Не удалять DO, secrets и VPC; GitHub rollback отдельно.

## Дополнение — диагностический Worker v7 после нового `invalid_request` (19.11.2026)

Владелец повторил подключение ChatGPT с нуля и снова получил `{"error":"invalid_request"}` **после ввода пароля**. Открытая форма корректно показывала клиента `ChatGPT`, возврат `https://chatgpt.com/connector_platform_oauth_redirect`, разрешения `qwen:read` и `qwen:files:read`, S256 PKCE и resource Qwen. `invalid_origin` больше не наблюдалось. Прежняя гипотеза об устаревшей форме опровергнута сообщением владельца. В v6 идентичный `invalid_request` мог возникать в нескольких местах, поэтому причина остаётся неопределённой без безопасной детализации.

Изменения `src/cloudflare/oauth.mjs`: на отказ POST `/authorize` могут возвращаться только предопределённые `reason`:

| Reason | Что означает |
|---|---|
| `consent_cookie_missing` | браузерная binding cookie не пришла |
| `consent_cookie_mismatch` | cookie не соответствует consent handle |
| `consent_expired` | транзакция отсутствует, просрочена или уже использована |
| `consent_handle_missing`, `consent_handle_invalid` | некорректный одноразовый handle |
| `consent_decision_missing` | форма отправлена без явного `decision=approve` или `deny` |
| `consent_duplicate_field` | дублируются singleton поля формы |
| `consent_auth_record_invalid`, `consent_completion_invalid`, `consent_session_invalid` | отказ проверки record / финализации / другая ошибка session validation |

Коды не раскрывают значение secret, cookie, handle, client ID, access token или OAuth code; handler не ослабляет Origin/CSRF binding/PKCE и не заменяет ошибку успешным ответом.

Проверки GitHub: [PR #5](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/5) MERGED, source main `c21743889e9914755237923f7e59d41cfb876aba`. [CI 44514600926](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44514600926) job `edge` SUCCESS: npm ci, check, test **25/25 pass, 0 fail**, build dry-run. Новые тесты покрывают фактический ChatGPT запрос с двумя scope и безопасные причины отсутствия cookie/decision и истечения consent.

Перед публикацией: Cloudflare v6 `1a90b1b6-1bb3-4e0a-b48d-705395bf2149`, deployment `9f53720f-17b5-4d68-afef-2cc61cdbebdb` (100%). Загружены четыре ESM файла из GitHub main, standalone stage Worker **v7 `3b9cc9c3-8b0b-4d9b-a467-79cc023de696`**; strict binding inheritance. Получены GET `versions/{id}` и `settings`: `QWEN_OAUTH_OWNER_PASSWORD` остаётся `secret_text`, `QWEN_OAUTH_STATE` → DO `162cfb67fccc40f5907b0093b7a7f944`, `QWEN_MCP_ORIGIN` → VPC `01a1f103-bc58-78c2-97ef-91331e10775e`, `QWEN_OAUTH_GENERATION` сохранён. Перед deploy v6 перепроверена и не менялась. После deploy GET подтвердил **v7 100%**, deployment **`3a833183-c78b-4cc2-8d3b-ba1903103840`** (11:26 UTC), все bindings сохранены. Не читали секреты или OAuth storage contents, не трогали Windows, не меняли другие Cloudflare Workers.

**Статус:** v7 — диагностика, а не доказанное исправление underlying проблемы. Нужна ещё одна свежая попытка ChatGPT OAuth владельцем; ответ `reason` позволит выбрать конкретную безопасную правку. При успехе — проверить code/token; полноту Windows MCP не обещать до Tunnel/ПК. Откат: Cloudflare v6 `1a90b1b6-1bb3-4e0a-b48d-705395bf2149` / deployment `9f53720f-17b5-4d68-afef-2cc61cdbebdb`; v4 `plain_text` не использовать, DO/секреты не удалять. Пункт 7 [ ].

## Дополнение — подтверждён отсутствующий cookie, исправление Worker v8 (19.11.2026)

**Наблюдение:** владелец создал ChatGPT подключение заново, при подтверждении с паролем POST `/authorize` получил `{"error":"invalid_request","reason":"consent_cookie_missing"}`. Ветка кода говорит: сервер не нашёл cookie `__Host-qwen125b-consent-<hash>` в POST. Причину отсутствия (браузер, срок действия, передача запроса) определённо установить по одному POST нельзя. Чужой Origin не разрешался, корректные OAuth параметры и два scope отображались.

**Изменение:** при GET /authorize сервер помимо browser-bound `__Host-` cookie выдаёт hidden `form_proof` из 256 случайных бит; в SQLite DO сохраняется только SHA-256 доказательства, TTL 600 секунд. Если на POST не пришла cookie, fallback разрешён лишь при совпадающем доказательстве и строго `Origin: https://qwen125b-mcp.vl-ktk.workers.dev` + `Sec-Fetch-Site: same-origin`; после этого проверяется оригинальная OAuth consent транзакция, пароль, scopes и S256 PKCE. Успех/deny удаляет form proof; повтор consent и OAuth code запрещён. При неверной пришедшей cookie fallback не включается. Ошибки не содержат nonce, cookie, handle, пароль или token. **Это альтернативная защита от CSRF при невозможности cookie; она не создаёт такую же browser-cookie привязку, поэтому требования same-origin и случайный form proof обязательны.**

**Код/проверки:** `src/cloudflare/oauth.mjs`, `src/cloudflare/worker.test.mjs`; [PR #6](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/6) MERGED → source main commit `db1601d79feb19d4ccdf53be36bd3b72583dcb75`. [GitHub Actions 44524088590](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44524088590): `npm ci`, `npm run check`, `npm test` (**27/27, 0 fail**), `npm run build` (Wrangler dry-run) PASS. Добавлены тесты полного code/token обмена из формы **без** cookie, с двумя scope, replay denial, подмены proof, чужого Origin, отсутствия `Sec-Fetch-Site` и mismatch cookie. Проверки реально запущены в CI с Miniflare/workerd.

**Публикация:** из source main после merge загружены 4 исходных ES modules как **staged v8** через Cloudflare versions API с `bindings_inherit=strict`. Перед публикацией GET `versions/{id}` подтвердил типы bindings: `QWEN_OAUTH_OWNER_PASSWORD: secret_text`, SQLite DO `QWEN_OAUTH_STATE` namespace `162cfb67fccc40f5907b0093b7a7f944`, VPC `QWEN_MCP_ORIGIN` ID `01a1f103-bc58-78c2-97ef-91331e10775e`, `QWEN_OAUTH_GENERATION=1`. Непосредственно перед deployment GET проверил, что активная версия всё ещё v7 (100%). После публикации GET подтвердил **v8 `62961a30-37dc-4a49-a8f0-f787e8989b3b` (100%)**, deployment **`b18e7b13-b9ed-4955-accf-e09290cab8b1`**. Пароль и secret values не читались/не менялись. Других Workers / repos / Tunnel / Windows не меняли.

**Живая проверка:** в Chrome обновлена consent GET по реальному ChatGPT authorization URL на v8. Форма показывала `ChatGPT`, возврат `https://chatgpt.com/connector_platform_oauth_redirect`, два scope `qwen:read`, `qwen:files:read` и **один скрытый `form_proof`**. Пароль не вводился инструментом, POST через реальный ChatGPT ещё не проводился. Новый вход надо инициировать из ChatGPT, чтобы state был свежим; повторное создание плагина/смена пароля не требуется. Windows Tunnel/локальная MCP служба не готовы, поэтому пользовательские MCP tools пока не следует считать работающими.

**Откат:** безопасная предыдущая Cloudflare **v7 `3b9cc9c3-8b0b-4d9b-a467-79cc023de696`**, deployment **`3a833183-c78b-4cc2-8d3b-ba1903103840`**, с наблюдённой ошибкой cookie. Старые версии с password `plain_text` (v4) не развертывать. Возврат GitHub исходника отдельно; DO, secret и VPC ресурсы при Cloudflare rollback не удалять. **Шаг 7 остаётся открытым до живого подтверждения OAuth code/token.**

## Исследование причины v8 и окончательное исправление (19.11.2026)

База актуального `main`: `473bb68`. Перед работой API подтвердил v8 `62961a30-37dc-4a49-a8f0-f787e8989b3b` / deployment `b18e7b13-b9ed-4955-accf-e09290cab8b1`. SHA-256 всех четырёх опубликованных модулей совпал с checkout; неверный upload или подмена исходника исключены.

### Что доказано на опубликованной v8

1. **SQLite не теряет свежую запись:** диагностический DCR → GET `/authorize` → POST с неизменёнными handle/proof проходит проверки с cookie и без cookie. Использован `decision=diagnose`, чтобы остановиться до пароля и выдачи полномочий; получен ожидаемый `consent_decision_missing`, а не ошибка proof.
2. **Свежий Chrome передаёт данные правильно:** захваченный HTTP POST содержит исходные handle (43 символа) и proof (64 hex), идентичные ответу сервера; browser cookie принят и отправлен, `blockedReasons=[]`. На форме реального клиента ChatGPT введён только заведомо неверный диагностический пароль: ответ **403 `access_denied`**, то есть все предыдущие проверки прошли. Пароль владельца не читался и не менялся.
3. **Точная воспроизводимая причина `consent_form_proof_invalid` при старой форме:** неизменённая тестовая форма получена у опубликованной v8 в **12:46:18 UTC**. Через **606 секунд** повторный POST без cookie, с исходным proof, дал **400 `consent_form_proof_invalid`**. Обе записи имеют TTL 600 секунд; browser cookie имеет такой же Max-Age. В fallback v8 `kv.get(proofKey)` возвращает null для истёкшего либо уже использованного proof; `digestEquals(hash(proof), null)` ошибочно считается несовпадением. Проверка срока OAuth transaction ещё не выполнялась. Значения формы для воспроизведения не менялись.
4. **Независимый реальный Chrome-дефект после успешного consent:** на свежем GET и нажатии «Отказать» Worker выдал **302** с callback. Chrome остался на форме: `Network.loadingFailed`, `canceled=true`, `net::ERR_ABORTED`; `Log.entryAdded` с `source=security` прямо сообщил нарушение **`form-action 'self'`**. Chrome проверяет также redirect chain формы, поэтому точно так же блокируется возврат code к ChatGPT после «Разрешить».

Историческую попытку владельца нельзя безусловно назвать истечением или повторным POST: v8 не сохраняла trace, а оба случая возвращали одинаковый reason. GET той формы был виден в истории в 12:30:11 UTC; точное время неудачного POST не доступно. **Не утверждается**, что Chrome повреждает proof или SQLite произвольно теряет данные. Подтверждены конкретные дефекты выше и воспроизведён тот же опубликованный ответ. Общая причина остановки OAuth также включает блокировку callback CSP.

Cloudflare SQL query API допускает чтение схемы, но запретил чтение внутреннего `_cf_KV` (`SQLITE_AUTH`). Этот запрет не обходился. Для проверяемой новой попытки добавлен собственный минимальный журнал этапов, доступный через авторизованный SQL API.

### Изменения

- Перед cookie/proof fallback проверяется наличие активной исходной OAuth transaction. Просроченная/использованная форма получает `consent_expired`, а не ложное обвинение в неверном proof. Отдельно различаются отсутствующая proof-запись и реальное несовпадение хеша живого proof.
- HTML сообщает срок 10 минут и серверное время истечения. Form action сохраняет исходные валидированные OAuth query parameters. При просроченном **same-origin browser POST** с `Accept: text/html` сервер валидирует параметры и отвечает **303 на новый GET**. Создаются новый handle/proof и новая transaction; пароль не сохраняется и требуется заново. Исходный consent не продлевается и не принимается. API/поддельные запросы остаются закрытыми.
- CSP: `form-action 'self' <origin зарегистрированного callback>`. Callback берётся только после проверки клиентского redirect URI библиотекой. Origin дополнительно проверяется перед включением в заголовок для исключения CSP injection. `default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'` сохранены. Провайдер по-прежнему разрешает redirect только на точный зарегистрированный URI.
- В существующем DO создаётся отдельная таблица `qwen_oauth_audit_v1`: только время, path, HTTP status, stage и фиксированный reason. **Нет** паролей, cookie, handles, proofs, токенов, codes, client IDs или request bodies; нет публичного endpoint чтения журнала. Хранение новых логов — 7 дней, существующий OAuth KV не мигрируется/не очищается. Этапы `consent_issued`, `code_issued`, `token_endpoint_success`, отказы и обращения к MCP различимы владельцем через Cloudflare SQL.
- Пароль, generation, namespace DO, VPC, исходный Instagram Worker и существующие подключения не изменяются. Новых OAuth secrets нет.

### Проверки до публикации

**32/32 PASS**, Node 24 / Miniflare 5 / workerd; check и Wrangler dry-run PASS. Добавлены негативные expiry/replay сценарии **без cookie** с сохранёнными hidden inputs, различение отсутствия и подмены proof, безопасный browser restart без принятия старого пароля, CSP callback/injection, а также полный code + PKCE + оба scope **после закрытия runtime и повторного открытия постоянной SQLite**. Проверено отсутствие секретов в журнале. Старые тесты покрывают неверный пароль, подделки, PKCE/redirect/resource/scope, code/refresh replay и scopes инструментов.

Почему прежние тесты не выявили проблему: они вручную передавали cookie заголовком; cookie-free позитивный тест завершался немедленно; expiry тест истекал только transaction с сохранённой cookie. При replay cookie-free test даже ожидал `consent_form_proof_invalid`. Miniflare HTTP dispatcher не исполняет браузерный CSP. Новые тесты добавляют недостающие состояния, а реальный Chrome и опубликованный endpoint проверяются отдельно.

Публикация новой версии и финальный owner code/token будут записаны после фактического выполнения. До этого полное исправление подключения не объявляется. Windows MCP/Tunnel и модель по-прежнему не готовы и не подменяются фиктивным успешным origin.

### Публикация v9 и реальные проверки

- [PR #7](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/7) MERGED; source commit `22d6665b0b7bcffdf81cb9170c1537756e28d8a1`, main merge `771155b50565bbc1cce566dcf40eced6458304f2`.
- [CI 44529378371](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44529378371) SUCCESS: npm ci/check/test **32/32**/dry-run build.
- Через versions API загружены только четыре production ESM, с `bindings_inherit=strict`. Два неизменённых модуля дополнительно проверены SHA-256 перед upload. Новый DO namespace или secret не создавались; class name и migration tag сохранены.
- Перед активацией GET version подтвердил существующий DO `162cfb67fccc40f5907b0093b7a7f944`, VPC `01a1f103-bc58-78c2-97ef-91331e10775e`, password `secret_text` и generation `1`. Active v8 перепроверена непосредственно перед deployment.
- Активна **v9 `416972ed-8eab-4354-bfbe-3c1745828126` (100%)**, deployment **`1fe57ebb-1438-4190-85fb-d45ef670d416`**, 19.11.2026 **13:03:38 UTC**. GET после переключения подтвердил сохранность bindings.
- Первое обращение сразу после API-активации ещё обслужил старый DO-код в ходе распространения deployment. Дождались реального `x-qwen-oauth-stage: consent_issued`, нового CSP и expiry UI; одного статуса deployment недостаточно. Последующее чтение `/content/v2` подтвердило совпадение SHA-256 всех четырёх модулей с Git.

Проверки **опубликованной v9**:

| Действие | Реальный результат |
|---|---|
| Свежий consent, cookie передана | Проверка transaction пройдена, остановка до пароля на ожидаемом `consent_decision_missing` |
| Свежий consent без cookie, с исходным proof | Проверка transaction/proof пройдена, тот же ожидаемый результат |
| Исходная просроченная тестовая форма v8 | Теперь `consent_expired`, а не `consent_form_proof_invalid` |
| Просроченный same-origin browser POST с исходными OAuth parameters | **303**, `consent_expired_restart`; новый GET **200**, новый handle, password input пустой |
| Chrome: новая форма, «Отказать» | **302 → реальная навигация к зарегистрированному внешнему callback**, state/issuer сохранены, прежней CSP блокировки нет |
| `/mcp` без Bearer и с поддельным Bearer | **401 invalid_token** |
| Owner-readable SQL audit | Таблица создана, SELECT через Cloudflare API возвращает только фиксированные статусы/этапы, 0 записей секретов |

Новые диагностические DCR клиенты созданы только в Qwen для тестов; действующие подключения не удалялись. Агент не вводил и не читал пароль владельца; до финального входа использовался только один заведомо неверный тестовый пароль для проверки отказа на v8. Затем владелец самостоятельно ввёл существующий пароль в свежую форму ChatGPT; положительный code/token подтверждён журналом ниже. Пароль агенту не передавался.

**Откат текущего исправления:** вернуть на 100% прежнюю v8 `62961a30-37dc-4a49-a8f0-f787e8989b3b` (предыдущий deployment `b18e7b13-b9ed-4955-accf-e09290cab8b1`); она содержит подтверждённые дефекты. Дополнительный резерв v7 `3b9cc9c3-8b0b-4d9b-a467-79cc023de696`, deployment `3a833183-c78b-4cc2-8d3b-ba1903103840`. Не откатывать на v4, не удалять namespace/секрет/VPC/существующий OAuth KV. Новая audit-таблица не мешает старому коду и не требует удаления.

### Финальный реальный вход владельца в ChatGPT

Владелец попросил переоткрыть форму. Из существующей страницы Qwen-плагина ChatGPT запущен **новый** OAuth state и новая S256 challenge, затем владелец сам ввёл неизменённый пароль и нажал «Разрешить». Агент не читал password field и не перехватывал тело POST.

SELECT собственной audit-таблицы через авторизованный Cloudflare API зафиксировал:

| UTC, 19.11.2026 | Endpoint | Status | Этап |
|---|---|---|---|
| 13:07:53.464 | `/authorize` GET | 200 | `consent_issued` |
| 13:08:04.964 | `/authorize` POST | **302** | **`code_issued`** |
| 13:08:08.047 | `/oauth/token` POST | **200** | **`token_endpoint_success`** |
| 13:08:08.861 | `/mcp` | 401 | `invalid_token`, начальная проверка клиента |
| 13:08:08.959 | `/mcp` | **403** | `method_not_allowed` после OAuth |

**Подтверждено:** пароль принят, consent завершён, code выдан, ChatGPT совершил успешный обмен code на token, callback вернулся в ChatGPT и OAuth popup закрылся. Пользователь ответил «готово». Ошибки `invalid_origin`, `consent_cookie_missing`, `consent_form_proof_invalid` в этой свежей попытке не возникли. Это реальный опубликованный OAuth, не локальный stub.

**Не подтверждено полное MCP-подключение:** после OAuth клиент отправил метод, запрещённый текущим gateway. Журнал намеренно не содержит request body, поэтому точное имя метода этой попытки не утверждается. В интерфейсе карточки приложения ChatGPT отображается «Для этого приложения нет доступных инструментов»; кнопка установки плагина остаётся. Windows MCP, Tunnel и инструменты ещё не готовы. Это отдельный следующий блокер MCP transport/capability discovery, а не ошибка пароля или proof. Не добавлялся фиктивный MCP-сервер/успешный origin и не ослаблялся default-deny ради индикатора подключения.

**По пункту 7:** OAuth часть исправлена и проверена живым владельцем. Полный критерий «ChatGPT подключён к защищённому MCP и видит реальные инструменты» ещё не выполнен; пункт 7 остаётся [ ]. Перед окончательной приёмкой нужен реализованный доступный MCP origin и проверка реальных initialize/capability/tools запросов ChatGPT по утверждённой архитектуре. Пункты 8–24 не реализовывались самовольно. Пароль/секрет, существующие grants других клиентов и данные не сбрасывались.

## v10 — отдельная диагностика метода ChatGPT (19.11.2026)

После подтверждённого в v9 OAuth code 302 → token 200 реальный ChatGPT послал `/mcp`, ответ 403 `method_not_allowed`. SELECT live SQLite audit зафиксировал 403, но прежняя схема аудита не содержала JSON-RPC method. В исходном Worker только неизвестный POST JSON-RPC метод приводит к этой паре статуса и ошибки; конкретное имя прежнего запроса **не установлено**. Текущая версия MCP 2026-07-28 предусматривает `server/discover`, а также другие методы capability discovery; это **гипотеза о возможном несовпадении протоколов**, а не доказательство конкретного вызова ChatGPT.

[PR #9](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/9), merge `16dfc5320c8cbe20d2f80bf9b9f20d0aa032a6f7`, добавляет только аудит ограниченного синтаксисом (<=80 символов) имени JSON-RPC метода в существующее поле `stage=mcp_rpc:<method>` на POST `/mcp`. Ни запрос, ни JSON параметры, ни token, cookie, пароль или ID клиента в журнал не попадают. Новую SQL таблицу или миграцию не создавали. Политика запрета неизвестных методов, OAuth, scopes и VPC не изменялась. Тест: отклонённый `server/discover` пишет ожидаемое `stage` и никогда не пересылается upstream.

**Проверки:** Node 24, `npm run check`, `npm test` **33/33**, `npm run build` Wrangler dry-run PASS; GitHub Actions [CI 44535678506](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44535678506) SUCCESS. Перед публикацией Cloudflare API подтвердил v9 100% и то, что последняя загруженная версия — v9. Staged version uploaded with `bindings_inherit=strict`; проверены все 4 bindings (VPC, secret_text, SQLite DO и generation). **v10 опубликована 100%:** version `53f81bde-4e19-47d0-8cdb-e7349dcc83b6`, deployment `4a934ad0-0ec5-4d5a-b369-b3e0c8f3b934`. GET API после деплоя подтвердил активность v10; публичный HEAD `/__edge_status` дал HTTP 200. Публичный GET body тайм-аут через прокси, поэтому не подтверждается этим вызовом. Пароль и привязки не менялись.

**Откат:** 100% на v9 `416972ed-8eab-4354-bfbe-3c1745828126` (deployment `1fe57ebb-1438-4190-85fb-d45ef670d416`), без удаления DO/секрета; старый код не использует новое поле stage иначе.

**Для продолжения:** владелец повторно подключает `https://qwen125b-mcp.vl-ktk.workers.dev/mcp` в ChatGPT, не меняя пароль. Затем Cloudflare SQL `SELECT at_ms,path,status,stage,reason FROM qwen_oauth_audit_v1 WHERE path='/mcp' ORDER BY at_ms DESC LIMIT 20` в существующем Qwen DO. Точный метод → исследовать поддерживаемый протокол, исправить строго необходимое правило и протестировать. Windows MCP и Tunnel пока не готовы; не возвращать фиктивные инструменты ради зелёного индикатора, шаг 7 остаётся [ ].

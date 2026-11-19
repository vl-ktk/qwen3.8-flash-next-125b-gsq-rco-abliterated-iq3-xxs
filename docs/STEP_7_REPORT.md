# Шаг 7: OAuth и контроль MCP-инструментов

Дата: **19.11.2026**, Europe/Bucharest. Основание: [Issue #1](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/issues/1).

**Актуальный статус на 19.11.2026 после разрешённого деплоя:** OAuth-код опубликован в `qwen125b-mcp` как Worker v2 `b8946e83-551d-433a-804b-6b33f920a7d2` (100%), deployment `fad59a18-3013-49ed-812f-2c8891f11c65`. Отдельный SQLite Durable Object создан. **Owner secret ещё не установлен — публичный статус `locked`; живой OAuth вход через ChatGPT и Windows origin не проверены.** Шаг 7 и ROADMAP остаются [ ]; пункты 8–24 не выполнялись. Ниже сохранён исходный исторический отчёт Codex о состоянии **до** деплоя; актуальное дополнение — в конце документа.

## Источник и границы

База `main`: `c2f17225003f507e4965c303ec2db48658b36c49`. Прочитаны HANDOFF, `docs/ROADMAP_24.md`, OAUTH_REUSE_SOURCE, CLOUDFLARE_ROUTING, ARCHITECTURE, SECURITY, TEST_PLAN и MCP_REUSE_INVENTORY. Корневого `ROADMAP.md` и применимых `AGENTS.md` в checkout/родительских каталогах нет; канонический roadmap находится в `docs/ROADMAP_24.md`.

Реальный общий OAuth provider получен из активного `instagram-mcp-oauth-test` v38 через read-only Cloudflare API. Проблема прошлой проверки состояла в обработке raw string как JSON `.result`. Происхождение, точные границы, SHA-256, лицензия и воспроизводимое извлечение описаны в [OAUTH_REUSE_SOURCE](OAUTH_REUSE_SOURCE.md). Реализация не основана на догадках или новой OAuth-библиотеке из npm.

## Что реализовано

| Область | Поведение |
|---|---|
| Discovery | Канонический issuer `https://qwen125b-mcp.vl-ktk.workers.dev`; resource `/mcp`; RFC 9728 metadata на обоих well-known путях; Bearer challenge с `resource_metadata` |
| DCR | `/oauth/register`; public и confidential clients; HTTPS/безопасные loopback redirect URI проверяет перенесённый provider; client lifetime 7 суток |
| Авторизация | `/authorize`; authorization code; обязательный S256 PKCE для всех клиентов; state/issuer возвращаются через URL encoding; redirect должен совпасть с зарегистрированным |
| Подтверждение | Явное согласие владельца, показ клиента/redirect/scopes, HTML escaping, CSP, `__Host-` Secure/HttpOnly cookie, одноразовая browser-bound transaction, Origin-check на POST |
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
Минимальная длина независимого owner secret снижена с 32 до **5 символов**; пароль с 4 символами должен оставлять OAuth в `locked`. Механизм ограничения 5 неверных попыток за 15 минут не меняется. Использование ровно 5 символов даёт слабую защиту удалённого управления; более длинный фактический пароль предпочтителен. Изменение готовится к отдельной проверке и публикации; Cloudflare version v2 в этом историческом разделе отражает предыдущее состояние.

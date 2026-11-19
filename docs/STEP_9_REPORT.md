# Пункт 9 — облачные проверки до передачи Windows-пакета

Дата: 19.11.2026. **Автоматические проверки выполнены; опубликованный HTTPS endpoint и настоящий Tunnel/Windows остаются на приёмку.**

## Проверяемая версия

- Исходник: Qwen GitHub `main`, включает подготовленную, но **не опубликованную** проверку Ed25519 устройства из пункта 8.
- Cloudflare (read-only API): активен **v11** `8e719c62-5316-434d-b092-fd0f3cdc81d5`, deployment `5667dd47-6d10-47d8-a9dc-ab8d262047f1`, 100%. Прежние четыре bindings на месте: VPC, generation, password `secret_text` и Durable Object. Никакие секреты не читались/менялись.
- Выделенный Tunnel `ktk-qwen125b-friend-pc` — `inactive`, 0 соединений. Поэтому end-to-end без работающего Windows MCP невозможен.

## Результаты локальных тестов

Запуск на Node 24 + Miniflare SQLite Durable Object и изолированный заглушечный Workers VPC origin (запросы во внешний интернет в тестах запрещены):

| Проверка | Статус | Факт |
|---|---|---|
| OAuth Authorization Code + PKCE | PASS | Повтор кода `400`, ошибка PKCE/redirect/client `400`; проверены оба scope |
| Недействительные, чужие, refresh и отозванные bearer tokens | PASS | `401` без обращения к VPC |
| Запрещённый tool или scope | PASS | `403`, нет выполнения на origin |
| Windows attestation недоступен | PASS | `503 device_unavailable`, запрос до MCP origin не доходит |
| Tunnel отключился после успешной проверки устройства | PASS | `503 origin_unavailable`, нет утечки учетных данных |
| Восстановление связи | PASS | Тот же **неотозванный** OAuth token + ключ Windows снова дают `200` |
| Поддельная подпись после восстановления | PASS | `503`, команда Windows не исполняется |
| MCP session GET/SSE, DELETE после потери связи | PASS | Сессия возобновляется, удаление лишает её доступа |
| Replay использованного authorization code | PASS | `400` и **отзыв всего гранта** (прежний access token после replay → `401`); новая полноценная OAuth авторизация восстанавливает работу |
| Durable Object SQLite persistence | PASS | Привязка сохраняется после остановки и перезапуска Miniflare |
| Headers/secret audit | PASS | `no-store`, нет паролей/token/cookie в audit, OAuth grant проверяется до origin |

Итог: **45/45 тестов PASS**, `npm run check` PASS, `CI=1 WRANGLER_SEND_METRICS=false npm run build` PASS (Wrangler dry-run, без публикации). 

## Живые проверки и ограничения

- Cloudflare API подтвердил действующий deployment, 4 bindings и отсутствие Tunnel connections. Это **проверка конфигурации**, не успешная HTTPS/MCP приёмка.
- Прямой `curl` к `https://qwen125b-mcp.vl-ktk.workers.dev/.well-known/oauth-protected-resource/mcp` из доступной среды завершился **connection timeout, HTTP 000**; ответ 200/401 внешнего endpoint не получен. Нельзя выдавать сетевой тайм-аут инструмента за дефект Worker или за успешный тест.
- Уже выполненный ранее **реальный OAuth владельца** (v9) — 302 authorization code и 200 token. Но новый после v11 `server/discover` и работающий Windows origin **не проверены**.
- В production оставлена v11; код пункта 8 и дополнительные тесты пункта 9 — только в GitHub. До реализации `/device/attest` на Windows **не выкладывать** новую edge ветку: она безопасно откажет всем неподключённым устройствам.

## Оставшаяся приёмка

Во время единого комплексного теста на ПК владельца: HTTP 200 для metadata, 401 без токена, OAuth в реальном браузере, `server/discover`, `tools/list`, инструмент с обоими scope, выключение/восстановление Tunnel, реальный Ed25519 origin, отзыв и повторная привязка; затем финальный тест на ПК друга. До этого пункт 9 остаётся [ ] как **живой end-to-end**.

При проблемах в production откат — **v10** `53f81bde-4e19-47d0-8cdb-e7349dcc83b6`, deployment `4a934ad0-0ec5-4d5a-b369-b3e0c8f3b934`. Ничего не удалять, не менять чужие ресурсы.

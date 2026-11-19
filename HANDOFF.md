# HANDOFF — Qwen 125B / Windows MCP

Дата: 2026-11-19. Источник: `vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs`, `main`. Рабочую Cloudflare v11 в ходе пункта 8 не менять.

## Рабочая версия / откат
- Cloudflare Worker `qwen125b-mcp` **v11**: version `8e719c62-5316-434d-b092-fd0f3cdc81d5`, deployment `5667dd47-6d10-47d8-a9dc-ab8d262047f1` (100% при последней проверке). OAuth code→token подтверждён владельцем; полный MCP Windows-origin пока не проверен.
- **Откат к v10**: version `53f81bde-4e19-47d0-8cdb-e7349dcc83b6`, deployment `4a934ad0-0ec5-4d5a-b369-b3e0c8f3b934`.
- v11 код: [PR #10](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/10), CI 36/36. Сохранены VPC Service, прежний Durable Object, владелецкий secret_text и generation.

## Пункт 8 — подготовлен исходник, ещё не публиковался
- `src/cloudflare/device-pairing.mjs`: регистрация публичного ключа Ed25519, случайный одноразовый код и fingerprint, одобрение существующим паролем владельца и CSRF proof, статус, отзыв, проверка подписи свежего nonce **перед каждым MCP-запросом**. Состояние в прежнем Qwen DO; никакие секреты не добавлялись.
- `src/windows/device-identity.mjs`: генерация Ed25519 пары **на Windows** и подпись origin challenge. Ни в Git, ни в архив не класть приватный ключ.
- Worker вызывает `GET /device/attest` через фиксированный VPC origin, только после OAuth; неподтверждённый, поддельный или отключённый origin получает fail-closed 503.
- Локально `npm run check`, **41/41** тестов, `npm run build` (Wrangler dry-run) PASS.
- [PR #11](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/11) **MERGED** (commit `ac22b3c7815468788b346e010d5cf0379105f8b2`); [CI #44560166652](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44560166652) SUCCESS, 41/41; `check`/dry-run PASS. Код пункта 8 сохранён в `main`, но **НЕ опубликован в Cloudflare**. Тестируется реальный SQLite DO persistence при restart и защита от replay/CSRF/подделки.
- Подробнее `docs/STEP_8_REPORT.md`. **НЕ разворачивать step8 Worker до готовности Windows MCP `/device/attest`: без пары все авторизованные ChatGPT-вызовы получили бы 503.** Рабочая v11 остаётся активна.

## Пункт 9 — проверены облачные сбои без компьютера владельца
- Автоматические tests с SQLite DO и заглушкой Workers VPC: **45/45 PASS**, `npm run check` и Wrangler `npm run build` (dry-run) PASS. Проверены invalid token/scope, одноразовый OAuth code (replay отзывает grant), отключение/восстановление origin, Ed25519 proof, session GET/SSE и DELETE, отсутствие secret в audit.
- Cloudflare API: v11 100% (`5667dd47-6d10-47d8-a9dc-ab8d262047f1`), те же 4 bindings. Tunnel inactive, 0 connections. Прямой HTTPS curl: connection timeout / HTTP 000 — **живого HTTPS PASS нет**. Не объявлять пункт 9 end-to-end завершённым.
- Подробно `docs/STEP_9_REPORT.md`. Реальная приёмка с Windows origin запланирована одним этапом на ПК владельца; рабочий Cloudflare Worker не обновлялся.

- Пункт 9: [PR #12](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/12) MERGED, commit `570e0e760fdae8b0b57f86bf5113fac0e700f593`; [CI #44561982653](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44561982653) SUCCESS 45/45. Cloudflare не менялся.

## Пункт 10 — Windows MCP HTTP (исходник готов, live Windows не проверен)
- `src/windows/mcp-server.mjs`: Streamable HTTP modern `2026-07-28` (headers, `_meta`, `server/discover`, stateless) и legacy `2025-11-25` (initialize, bounded sessions, GET/SSE, DELETE), `GET /device/attest` подписывает свежий challenge; Host/Origin, лимит JSON, localhost-only.
- `src/windows/main.mjs` готов к запуску без регистрации Windows-службы; будущий установщик подаёт секрет Ed25519 из ACL-файла, а не из архива. На тот момент `tools/list` был пуст, `tools/call` запрещён (актуальную реализацию см. п. 11 ниже).
- Локально Node 24 + Miniflare **55/55** PASS, `npm run check`, Wrangler dry-run PASS. Включён интеграционный тест edge OAuth + Ed25519 + **реальный** loopback Windows-MCP HTTP, но соединение VPC в тесте имитировано, Windows не тестировалась.
- Подробно `docs/STEP_10_REPORT.md`. Источник — `main` после слияния PR пункта 10. **Production Cloudflare не менялся**, остаётся v11; реальный Tunnel inactive.
- [PR #13](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/13) **MERGED**, squash commit `d8100fa71fc6fd22a43c59a26ff0860c8f9d6f39`; [GitHub CI #44567106093](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44567106093) SUCCESS (55/55). Код лежит в `main`.

## Пункт 11 — read-only Windows tools (код готов, реальная Windows на приёмке)
- `src/windows/windows-tools.mjs`: строго фиксированные `system_info`, `process_list`, `service_status`, `app_status`; `file_read` только с явно заданными корнями (`QWEN_MCP_ALLOWED_FILE_ROOTS`), не более 32 КиБ. Запрет arbitrary PS, mutation, service control, wildcard/injection и секретных файлов. PowerShell запуск через static UTF-16 `-EncodedCommand`, аргументы JSON/Base64 в отдельном env, `shell:false`, timeout 8 секунд, output cap 40 КиБ.
- Интегрирован реальный MCP `tools/list`/`tools/call` в `src/windows/mcp-server.mjs`, версия runtime `0.11.0`. Cloudflare OAuth scope по-прежнему фильтрует инструменты; `system_monitor` остаётся на пункт 12.
- Node 24 + Miniflare **63/63** PASS, `npm run check`, Wrangler dry-run PASS; тесты Windows-скриптов на Linux — с инъекцией тестового runner, не настоящий PowerShell. В production Cloudflare **ничего не выкладывали**, v11 без изменений.
- Подробнее `docs/STEP_11_REPORT.md`.

## Что осталось
- Пункт 7: полноценная сквозная проверка ChatGPT → VPC → Windows. Tunnel `ktk-qwen125b-friend-pc` пока inactive (0 соединений), Windows MCP разработан локально, но не установлен; реальное соединение отсутствует.
- Пункт 8: HTTP origin `/device/attest` в Windows MCP реализован (п.10), остаётся защитить локальный приватный ключ ACL и подключить pairing к установщику (п.15–16). До приёмки отмечать [ ].
- Продолжить пункт 12 (Windows monitoring), затем 13–18 (Windows runtime и установщик). **Решение владельца:** все доступные тесты делаем сами; его Windows ПК не трогаем до одной общей тестовой установки после подготовки пакета. Затем исправления и окончательный архив для ПК друга.

План: `docs/ROADMAP_24.md`; исходная OAuth диагностика: `docs/STEP_7_REPORT.md`.

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
- Локально `npm run check`, **41/41** тестов, `npm run build` (Wrangler dry-run) PASS. Тестируется реальный SQLite DO persistence при restart и защита от replay/CSRF/подделки.
- Подробнее `docs/STEP_8_REPORT.md`. **НЕ разворачивать step8 Worker до готовности Windows MCP `/device/attest`: без пары все авторизованные ChatGPT-вызовы получили бы 503.** Рабочая v11 остаётся активна.

## Что осталось
- Пункт 7: полноценная сквозная проверка ChatGPT → VPC → Windows. Tunnel `ktk-qwen125b-friend-pc` пока inactive (0 соединений), Windows MCP отсутствует.
- Пункт 8: HTTP origin `/device/attest` в Windows MCP (п.10), защитить локальный приватный ключ ACL и подключить pairing к установщику (п.15–16). До приёмки отмечать [ ].
- Продолжить пункт 9 (автоматические облачные проверки), затем 10–18 (Windows runtime и установщик). **Решение владельца:** все доступные тесты делаем сами; его Windows ПК не трогаем до одной общей тестовой установки после подготовки пакета. Затем исправления и окончательный архив для ПК друга.

План: `docs/ROADMAP_24.md`; исходная OAuth диагностика: `docs/STEP_7_REPORT.md`.

# HANDOFF — Qwen 125B / Windows MCP

Дата: 2026-11-19. Источник правды: приватный GitHub репозиторий `vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs`, `main`.

## Статус
- **Cloudflare Worker `qwen125b-mcp` v11 активен на 100%:** version ID `8e719c62-5316-434d-b092-fd0f3cdc81d5`, deployment `5667dd47-6d10-47d8-a9dc-ab8d262047f1`. Проверено через Cloudflare API после публикации.
- **Откат:** предыдущая работающая v10 `53f81bde-4e19-47d0-8cdb-e7349dcc83b6`, deployment `4a934ad0-0ec5-4d5a-b369-b3e0c8f3b934` (100% traffic при откате).
- [PR #10](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/10) объединён в `main`, merge `7a4e06607882fbc1ee4bc976d70d7b8f87664c1f`; [CI #44538800689](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44538800689) SUCCESS, локально `npm run check`, 36/36 тестов, `npm run build` PASS.

## Причина и исправление
- **Живой аудит v10:** успешные `/authorize` 302 и `/oauth/token` 200, затем `POST /mcp` → **403**, `stage=mcp_rpc:server/discover`, `reason=method_not_allowed`. Это точная причина 403: новый MCP метод отсутствовал в allowlist.
- **v11:** авторизованный `server/discover` проходит действующие OAuth/scope/origin проверки и пересылается в выделенный VPC origin; заголовки `Mcp-Method` и `Mcp-Name` валидируются против JSON-RPC и передаются. Неизвестные методы по-прежнему запрещены; ответов с фиктивными инструментами нет.
- Четыре прежних bindings сохранены: `QWEN_MCP_ORIGIN` (VPC), `QWEN_OAUTH_GENERATION`, `QWEN_OAUTH_OWNER_PASSWORD` (secret_text; не читался и не менялся), `QWEN_OAUTH_STATE` (исходный DO namespace).

## Что осталось / приёмка
- **Полное подключение ChatGPT пока не доказано:** после релиза v11 владелец ещё не повторял MCP discovery. В этой среде прямой curl к опубликованному endpoint получил сетевой timeout, а не HTTP-ответ.
- Windows MCP server на ПК друга ещё не работает, Tunnel не подключён (этапы 10 и 19+); при отсутствии origin ожидаемый честный ответ `503 origin_unavailable`, инструменты не появляются. Не объявлять шаг 7 закрытым.
- Следующее действие после доступности origin: пользователь повторяет подключение ChatGPT; проверить `server/discover`, `initialize`, `tools/list` и реальный read-only tool с OAuth, scopes `qwen:read` / `qwen:files:read` через audit и факт HTTP ответа. Без реального Windows-origin нельзя считать MCP готовым.

Подробная история: `docs/STEP_7_REPORT.md`, план `docs/ROADMAP_24.md`.

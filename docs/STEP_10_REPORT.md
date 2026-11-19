# Пункт 10 — Windows MCP Streamable HTTP

Дата: 2026-11-19. **Разработан и протестирован транспорт, но Windows-инсталляция и реальное Cloudflare/Tunnel подключение пока не проверены.**

## Реализовано

- `src/windows/mcp-server.mjs`: HTTP сервер на Node.js 24+, строго `127.0.0.1:8765` (на тестах разрешён случайный локальный порт), `/mcp`, `/health`, `/device/attest`.
- MCP `2026-07-28`: stateless `server/discover` и `tools/list`, обязательная сверка `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version` с JSON-RPC; `_meta` клиента; отказ от устаревших `initialize`/`ping` и GET/DELETE.
- MCP `2025-11-25`: `initialize` → ограниченная сессия, `notifications/initialized`, `ping`, `tools/list`, GET SSE с keep-alive, DELETE с инвалидированием сессии. Число сессий ограничено 256, срок простоя 24 часа, потоки закрываются при удалении сессии.
- `GET /device/attest`: подпись свежего nonce существующим Ed25519 ключом из пункта 8 только при совпадении `device_id`. Без ключа и привязки возвращает 403.
- Защита: только localhost, строгие Host/Origin (DNS rebinding), проверка MIME и Accept, лимит JSON 64 КиБ, ограничение метода/пути, безопасные JSON-RPC ошибки без раскрытия содержимого/секретов.
- `src/windows/main.mjs`: точка запуска, секрет идентичности берётся только из внешнего файла, который будущий установщик обязан защитить Windows ACL; `QWEN_DEVICE_ID` задаётся при привязке, ключ не включён в репозиторий/архив.
- В **пункте 10 нет инструментов Windows**: `tools/list` пуст, `tools/call` всегда отказ; PowerShell, чтение файлов и системные команды добавляются только в пунктах 11–14 после проверки допуска и параметров.

## Проверки

- `npm run check` — PASS.
- `npm test` — **55/55 PASS** на Node.js 24, включая 9 новых модульных тестов Windows и 1 интеграционный тест реального loopback-сервера, связанного с Cloudflare Worker внутри Miniflare через имитацию VPC binding (OAuth + новая Ed25519 attestation + modern discovery/tools/list + legacy initialize/session DELETE).
- `npm run build` — PASS (Wrangler dry-run); без выкладки в production.
- Поддержка transport подтверждена актуальными официальными спецификациями: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http и https://modelcontextprotocol.io/specification/2026-07-28/server/discover.

## Границы проверки

- Самостоятельный сервер выполнялся в Linux Node.js 24, **не на Windows владельца или друга**. Windows ACL, service install, автозапуск, Tunnel и удалённый ChatGPT клиент в этом пункте не проверены.
- Рабочий Cloudflare Worker **v11 не изменялся**. Код Ed25519 gate от пункта 8 всё ещё в GitHub `main`, но не выложен: до подключения реальной Windows пары это вызвало бы 503.
- Следующий пункт — **11: разрешённые Windows-инструменты, схемы и проверка аргументов**. Реальная приёмка — единым тестом на ПК владельца после установщика.

## Версия/откат

- Продакшен `qwen125b-mcp` v11: version `8e719c62-5316-434d-b092-fd0f3cdc81d5`, deployment `5667dd47-6d10-47d8-a9dc-ab8d262047f1` (последняя подтверждённая).
- Cloudflare откат v10: version `53f81bde-4e19-47d0-8cdb-e7349dcc83b6`, deployment `4a934ad0-0ec5-4d5a-b369-b3e0c8f3b934`.
- Код пункта 10 откатывается отдельным GitHub PR (без live выкладки).

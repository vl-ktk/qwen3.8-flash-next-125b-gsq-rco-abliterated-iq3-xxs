# Пункт 7 — поиск действующего OAuth Worker для безопасного повторного использования

Дата: 19.11.2026. Статус: **аудит источника, не реализация OAuth**. Пункт 7 в ROADMAP остаётся [ ].

## Найдено в Cloudflare (только чтение)

- Действующий Worker: `instagram-mcp-oauth-test`.
- Активная версия: **38**, version ID `9dd45b0a-0e55-4fbc-a97f-1801327daad5`, deployment `63e07038-6e8a-4961-9009-0ecba1afae6d`, на 100%. Последняя публикация 14 ноября 2026 г.
- Настройки подтверждают присутствие `OAUTH_KV`, `OAUTH_V1_KV`, `MCP_ACCESS_KEY`, `OAUTH_ADMIN_PASSWORD` и других связанных с KTK Social привязок.
- Это **вероятный канонический источник** ранее созданного OAuth для MCP, а не предположение, что в проекте никогда не было OAuth.

## Что удалось и не удалось

- `GET /workers/scripts/instagram-mcp-oauth-test/settings` и `GET .../versions`/version detail **успешны**: доступны bindings/metadata/версии.
- `GET /workers/scripts/instagram-mcp-oauth-test` и `GET .../content/v2` через текущий Cloudflare connector не предоставили исходник (сырое multipart/JS тело результата не доставлено в окружение). Оттуда **нельзя безопасно сделать точную копию** кода.
- GitHub code search пользователя по `OAUTH_V1_KV`, `OAUTH_ADMIN_PASSWORD`, OAuth metadata endpoints не обнаружил подтверждённого исходника.
- Browser в этом ChatGPT окружении недоступен для авторизованного редактора Cloudflare. Нет основания заявлять, что OAuth Worker скопирован.

## Решение для Qwen 125B

1. **Предпочтение:** независимая копия **исходного OAuth-кода версии 38** в данном приватном репозитории после получения исходного JS/модулей с помощью доступного авторизованного интерфейса (Cloudflare dashboard или Wrangler).
2. **Запрет:** не копировать secrets, активные OAuth sessions, `OAUTH_KV`/ `OAUTH_V1_KV` namespaces, D1 или существующие служебные привязки. Для Qwen создать независимый KV/состояние и новые отдельные секреты в шаге 7.
3. Провести diff и удалить функциональность Instagram/Threads/TikTok/Facebook; сохранить только общую часть совместимой с ChatGPT авторизации. Это **не** слепой дубль старого Worker.
4. Выполнить тесты discovery (OAuth protected resource/authorization server metadata), PKCE, `state`, rotation/revoke, scopes, replay, истечение токена, разграничение tools и отказ всем неподписанным запросам; только после этого включить forwarding к VPC.
5. До завершения всех проверок новый Worker `qwen125b-mcp` должен оставаться **fail-closed 401**, как в текущем коде.

**Результат:** существующий OAuth Worker **подтверждён**, но его исходный код через текущий доступ **не извлечён**. Исполняемые изменения на Qwen не производились, шаг 7 **не закрыт**. Другие Workers, KV, D1, секреты и туннели не изменялись.

## GitHub и восстановление
- Целевой repo: `vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs`.
- До инвентаризации коммит `6b10109d355be1ecbd383b3aad65a6f7a909eb44`.
- Никаких Cloudflare deployment/production-модификаций на этом этапе.

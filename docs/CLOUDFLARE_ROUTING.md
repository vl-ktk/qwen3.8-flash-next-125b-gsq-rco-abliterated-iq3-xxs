# Пункт 6 — Cloudflare HTTPS / Workers VPC

Дата: 19.11.2026 (Europe/Kyiv). Ресурсы задействованы только в новом проекте Qwen 125B.

## API-подтверждённые ресурсы

| Компонент | Фактическое состояние |
|---|---|
| Tunnel | `ktk-qwen125b-friend-pc`, UUID `b49f90d5-3f8a-4aca-aeaf-c44c563b215c`; inactive, без Windows-соединений |
| VPC Service | `ktk-qwen125b-mcp-origin`, UUID `01a1f103-bc58-78c2-97ef-91331e10775e`; type http, target `127.0.0.1:8765`, через Tunnel |
| Worker | `qwen125b-mcp`, опубликован; deployment `52f78262-bc33-43e2-af8e-f6a5c215b812` |
| Worker version | `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7`, 100% |
| Binding | `QWEN_MCP_ORIGIN` типа `vpc_service`, привязан к Service ID выше |
| workers.dev | Enabled; previews disabled; плановый URL `https://qwen125b-mcp.vl-ktk.workers.dev/mcp` |
| Существующие Workers | Прежние восемь скриптов не изменялись; новый девятый |

## Защита (не обходить в последующих шагах)

**Опубликованная версия шага 6** намеренно НЕ вызывает env.QWEN_MCP_ORIGIN.fetch. Любой `/mcp` получает 401 `authorization_not_configured`, включая поддельные Bearer-токены; `/__edge_status` сообщает `state=locked`. Она не изменена в ходе шага 7. **Новая реализация в Git** добавляет OAuth и авторизованный proxy, но не опубликована: см. `docs/STEP_7_REPORT.md`. Без новых OAuth bindings/секрета она также отказывает. В пункте 8 требуется одноразовая привязка устройства; Windows MCP отсутствует. Нельзя открывать MCP в интернет ради проверки.

## Реально выполненные проверки

- PASS: Cloudflare API GET подтвердил VPC Service, IP/port, Tunnel UUID и Worker VPC binding.
- PASS: Worker deployment 100%, публичный subdomain enabled, previews disabled.
- PASS: Node v22 `node --check` исходника; `node --test` 8/8 тестов.
- PASS: SHA Git blobs тестируемой локальной копии совпали с GitHub: `8d09e0d0d3d0cb0ff3df8135e49e0f86d2c3776c` и `032ddd2b987e26ce86cdfc87cd84b8b37e7fdb90`.
- НЕ ПРОВЕРЕНО: внешний HTTPS ответ (DNS-разрешение URL не сработало из доступного контейнера; web-fetch не смог открыть новый URL). Это не подтверждает и не опровергает работу URL.
- НЕ ПРОВЕРЕНО: Worker→VPC→Tunnel→Windows HTTP, SSE/Streamable HTTP, OAuth и подключение ChatGPT. Tunnel inactive; Windows друга ещё не подключён.

## Версии и откат

- Canonical source: этот приватный GitHub репозиторий, `src/cloudflare/worker.mjs`; `config/wrangler.json` с compatibility_date `2026-11-17` (Cloudflare отклонил 2026-11-19 из-за UTC).
- Предыдущий GitHub head до оформления отчёта: `ab13697a653711612d54474a594434e10f9b3944`.
- В случае проблемы отключить `workers.dev` **только** для `qwen125b-mcp` через POST /accounts/{account_id}/workers/scripts/qwen125b-mcp/subdomain с `enabled:false`; не удалять работающие чужие ресурсы. Git rollback сам по себе не меняет Cloudflare.

**Итог:** облачные компоненты маршрута настроены и API-проверены с закрытым MCP. Реальная связность ждёт авторизации, runtime и ПК. Следующий пункт №7.

Повторная read-only проверка 19.11.2026 при реализации шага 7: активные Worker version/deployment остались `309d8a3f-ca73-439b-93fe-9a3a10d0dcd7` / `52f78262-bc33-43e2-af8e-f6a5c215b812`. Wrangler запускался только с `--dry-run`; Cloudflare ресурсы не менялись.

Официальная документация: https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/ ; https://developers.cloudflare.com/workers-vpc/api/

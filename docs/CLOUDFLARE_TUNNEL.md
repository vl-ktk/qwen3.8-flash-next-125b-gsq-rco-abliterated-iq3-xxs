# Пункт 5 — Cloudflare Tunnel для Qwen 125B

Дата создания (UTC): `2026-11-18T23:30:07.163318Z`. Дата фиксации: 19.11.2026 (Europe/Kyiv).

## Реальный ресурс, а не план

| Поле | Подтверждённое значение |
|---|---|
| Cloudflare Tunnel name | `ktk-qwen125b-friend-pc` |
| UUID | `b49f90d5-3f8a-4aca-aeaf-c44c563b215c` |
| Тип | `cfd_tunnel` |
| Режим настройки | `config_src=cloudflare`, `remote_config=true` |
| После создания | `inactive`, 0 активных соединений |
| Ingress config | remote config version 0; 0 правил |
| Другие туннели в аккаунте | 0 (после создания в аккаунте 1) |
| Действующие Workers | 8, список до и после создания не изменился |

**Источник проверки:** Cloudflare API:
- `POST /accounts/{account_id}/cfd_tunnel` с JSON только `name` и `config_src=cloudflare`;
- `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}`;
- `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections`;
- `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`;
- `GET /accounts/{account_id}/cfd_tunnel` и `GET /accounts/{account_id}/workers/scripts`.

Создание было выполнено только для нового ресурса. **Существующие Cloudflare Workers и репозитории не изменены.**

## Безопасность и границы работ

- Tunnel **создан, но не запущен**: на Windows друга не установлен и не подключён `cloudflared`.
- Нет HTTPS маршрута, публичного ingress, VPC Service, Worker OAuth или ChatGPT MCP подключения.
- Tunnel ID не является секретом; секреты Cloudflare, tunnel token, credentials и ключи устройства **в Git не сохранены** и пользователю не раскрыты.
- Для Windows продолжает действовать требование loopback `127.0.0.1:8765/mcp` и deny-by-default. Публично открывать Windows порт запрещено.
- Не следует получать tunnel token раньше защищённой одноразовой привязки в пункте 8 или вшивать долгоживущий токен в общий установщик.
- Workers VPC — бета. Поддержку конфигурации на данном аккаунте, разрешения и поведение реального endpoint необходимо проверить в следующих пунктах, не объявлять заранее готовым.
- Тестов на ПК друга, передачи установщика и безопасного подключения устройства **не было**.

## Далее строго пункт 6

Подготовить HTTPS/маршрутизацию отдельного Cloudflare Worker `qwen125b-mcp` к **ограниченному** Workers VPC Service / созданному Tunnel. Отдельно проверить доступность Workers VPC в аккаунте и доступные API/права.

Не выдавать адрес `https://qwen125b-mcp.vl-ktk.workers.dev/mcp` за рабочий до публикации и успешных проверок. Auth/permissions и привязка устройства выполняются в пунктах 7–8; **ни на одном этапе не открывать опасный MCP без авторизации**.

## Восстановление

- Предыдущий коммит GitHub: `abe42822539f93855359c0f60d765d1b6831f564`.
- GitHub rollback отменяет только документы/конфиг. **Удаление Cloudflare Tunnel — отдельное облачное изменение и не происходит автоматически.** Перед возможным удалением убедиться, что соединений и потребителей по-прежнему нет, и отдельно получить согласие владельца.

# Пункт 13 — управление Windows MCP

Дата: 20.11.2026. Статус: **код подготовлен и автоматические проверки; живая Windows не проверена**.

## Выполнено

- `src/windows/administration.mjs`: проверка `/healthz` по loopback, структурированный статус `admin_status` с версиями, состоянием службы, отметкой о непроверенном cloud pairing и отсутствии пока установленного updater. Никакой фиктивной статистики модели, запуска или состояния облака.
- `src/windows/mcp-server.mjs`: `/healthz` + совместимый старый `/health`, версия `0.13.0`, явное завершение долгоживущих SSE-соединений при остановке.
- `src/windows/windows-tools.mjs` и `src/cloudflare/worker.mjs`: read-only инструмент `admin_status` разрешён только в существующем scope `qwen:read`; запуск/остановка службы, OS reboot, изменение конфигурации, обновления и произвольные команды по сети **не объявлены и запрещены gateway**.
- `src/windows/admin-cli.mjs`: локальное управление (без HTTP и MCP) `status`, `health`, `start`, `stop`, `restart`, `configure_recovery`, `reboot`, `help`. Изменения доступны только на Windows через интерактивный терминал с точной фразой подтверждения. `sc.exe` запускается с фиксированным системным путём, `shell:false`, заданным таймаутом и фиксированным именем `KTKQwenMCP`.
- Перезапуск службы сначала дожидается состояния STOPPED; после неудачи не выдаёт команду START. Recovery: до двух повторных запусков службы, без перезагрузки Windows. Регистрация службы/ACL — отдельная задача установщика (пп. 15–16).
- Перезагрузка Windows: локальный случайный одноразовый код с TTL 60 с + отдельная фраза подтверждения; затем 120 секунд отсчёта *внутри локальной консоли*. Во время него Enter или закрытие консоли отменяет операцию. По окончании отправляется `shutdown.exe /r /t 0`, без `/f` и без удалённой команды. **Важно:** Windows `shutdown /t > 0` неявно включает `/f`; такой вариант отвергнут, чтобы не принуждать закрытие игры/приложений с несохранёнными данными. Подтверждения не означают, что Windows гарантированно завершит reboot, если приложение препятствует закрытию.
- Механизм обновления/отката установленной службы пока отсутствует: статус `installer_required`, реализация в пункте 17.

## Проверки и ограничения

- Локально Node.js 24, Miniflare, Node test runner. Тесты новой логики: health HTTP, service mocks, таймаут restart, reboot без форсированного завершения, отмена, отказ без TTY, read-only MCP, закрытие соединений.
- Проверки на реальной Windows/PowerShell, установка службы, UAC, ACL, SSH/RDP, модели Strata и GPU **не проводились**. Сборка Cloudflare — только `wrangler --dry-run`, без публикации.
- Перед установкой проверить живые условия: локальные разрешения, `sc.exe`/кодировки на языке системы, наличие службы, запись identity в защищённый файл и работа Cloudflare Tunnel.

## Источник и откат

- Исходник: ветка `feature/step13-local-administration` → PR с отдельными изменениями пункта 13. После CI и слияния — `main` с новым коммитом; ссылку на commit/CI обновить по факту.
- Предыдущий проверенный `main` до пункта 13: `65c9046a1dd71741d525881c22d869823a05a28c` (локальные исходники). Для rollback исходников использовать этот SHA; production Cloudflare не выкладывался.
- Последняя зафиксированная по документации рабочая Cloudflare v11: `8e719c62-5316-434d-b092-fd0f3cdc81d5`; **актуальную Cloudflare deployment перед будущими изменениями сверить заново**.

## Официальные документы

- Microsoft `shutdown`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown/
- Microsoft Windows Service Control: https://learn.microsoft.com/en-us/windows/win32/services/controlling-a-service-using-sc
- Microsoft `sc failure`: https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc742019(v=ws.11)

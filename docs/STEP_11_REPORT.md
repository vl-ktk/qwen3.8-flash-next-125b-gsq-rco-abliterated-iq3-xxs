# Пункт 11 — безопасные Windows-инструменты MCP

Дата: 2026-11-19. **Исходник выполнен, но реальный Windows PowerShell и ПК владельца не тестировались.**

## Подготовленные инструменты

| Инструмент | Результат | Ограничение |
|---|---|---|
| `system_info` | ОС, версия/сборка, процессор, ядра, потоки, RAM | Только чтение через CIM |
| `process_list` | Список процессов, PID, CPU, RAM | Максимум 50, имя только точное, без командных строк |
| `service_status` | Статус одной службы Windows | Только точное имя; никаких Start/Stop |
| `app_status` | Запущена ли программа (имя процесса) и её PID | Только точное имя; никаких Kill/Launch |
| `file_read` | Текст файла в явно разрешённой директории | Нет по умолчанию; максимум 32 КиБ, ограничение расширений, блок секретных имён и ссылок за пределы корня |

`system_monitor` остаётся пунктом 12, PowerShell для выполнения произвольного кода, запись файлов, перезагрузка, изменение служб и процессов **не реализованы и не рекламируются**.

## Защита

- Все параметры имеют строгие типы, пределы и `additionalProperties:false`; попытки добавить `command`, `script`, wildcard, PowerShell pipeline, `$()` или длинные значения запрещены до выполнения.
- PowerShell 5.1 запускается как `powershell.exe -NoProfile -NonInteractive -NoLogo -EncodedCommand` только для **4 фиксированных read-only скриптов**, без `shell:true` и без интерполяции входного текста как кода. Аргументы — JSON в Base64 через отдельную переменную окружения. Дочерний процесс не наследует пароль OAuth, ключ устройства и другие переменные окружения приложения.
- Лимиты PowerShell: 8 секунд и 40 КиБ вывода. Ошибки не раскрывают stderr, стек или конфигурацию.
- Доступ к файлам выключен по умолчанию. Будущий установщик задаёт явные `QWEN_MCP_ALLOWED_FILE_ROOTS` через JSON-массив абсолютных локальных каталогов. Файл проверяется через `realpath`, размер, расширение, корректный корень и запрет переходов по ссылкам за пределы каталога. Нет путей UNC / устройств Windows. Инструмент требует отдельного OAuth scope `qwen:files:read` на шлюзе.
- `src/windows/mcp-server.mjs`: MCP `tools/list` теперь возвращает реальные read-only инструменты; `tools/call` возвращает стандартные MCP `content` / `isError`, ошибки и неизвестные вызовы fail-closed. Обновлён runtime `0.11.0`.
- Проверены официальные справочники Microsoft PowerShell `Get-CimInstance`, `Get-Process`, `Get-Service`, `-EncodedCommand`: https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-7.5 ; https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-process?view=powershell-5.1 ; https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-7.4.

## Проверки

- `npm run check` — PASS.
- `npm test` — **63/63 PASS** (8 новых тестов инструментария; ранее 55/55). Проверены позитивные и отрицательные параметры, PowerShell-аргументы без shell-интерполяции, базовый изолированный env, таймауты, ограничения папок и symlink, отказ по extension/size/secret, безопасная обработка ошибок MCP, интеграция Cloudflare gateway + реальный Node loopback origin c тестовым mock Windows-query backend.
- `npm run build` — PASS, Wrangler dry-run, без публикации.

## Что ещё не проверено

- Сами PowerShell-команды на реальной Windows 10/11, права конкретной учётной записи, CIM/WMI, кириллица и файлы с Windows ACL. Тестовый runner в Linux имитирует PowerShell и проверяет сформированный безопасный вызов.
- Нет живой связи с Windows через настоящий Cloudflare Tunnel, нет реальной ChatGPT MCP-приёмки; всё это входит в одну комплексную проверку на ПК владельца после сборки установщика.
- Следующий пункт 12: мониторинг CPU/RAM/GPU/SSD. Пункты 13–14: lifecycle, аудит и политика привилегий. Пункт 15–18: установщик/поддержка.

## Версии и откат

- Production Worker `qwen125b-mcp` остаётся **v11**, version `8e719c62-5316-434d-b092-fd0f3cdc81d5`, deployment `5667dd47-6d10-47d8-a9dc-ab8d262047f1`. В этом пункте не публиковался и не менялся.
- Предыдущий Cloudflare deployment для аварийного отката: v10 `53f81bde-4e19-47d0-8cdb-e7349dcc83b6`, `4a934ad0-0ec5-4d5a-b369-b3e0c8f3b934`. Код пункта 11 откатывается отдельным GitHub revert после PR.

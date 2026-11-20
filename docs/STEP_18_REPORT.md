# Пункт 18 — единый тестовый установщик для Windows 10/11

**Статус: исходник и тестовый EXE `0.18.0` собраны; автоматический CI Windows и Edge PASS; запуск на ПК владельца ещё не проводился.** Реальный Cloudflare Worker, рабочие Windows/Netcup не менялись.

Владелец подтвердил: **испытание на основной Windows 10 Pro 22H2, без виртуальной машины и без ручного ввода отдельных PowerShell-команд.** Установщик должен быть одним EXE с UAC, внутренними проверками и читаемым отчётом. Никаких изменений рабочего ПК до передачи проверенного EXE и подтверждения владельца.

## Candidate 0.18.0

- `config/KTK-Setup.iss`: Inno Setup, один `KTK-Qwen-MCP-Setup-0.18.0-TEST-UNSIGNED.exe`, содержащий только manifest-verified payload. Двойной клик открывает установщик; UAC обязателен. Это **не подписанный production setup**; Windows SmartScreen может показать предупреждение.
- `scripts/Run-KTKAcceptance.ps1 -Live`: автоматически проверяет SHA256/manifest, версию Windows, диск, порты, отсутствие конфликтующих KTK-служб/директорий, затем вызывает существующую защищённую установку/привязку, проверяет обе службы `LocalService` и emergency marker, сохраняет текстовый отчёт `KTK-MCP-Test-*.txt` на рабочем столе. Пользователю не требуется открывать PowerShell или вводить команды. **Один раз потребуется подтверждение Windows UAC и пары на странице Worker** (выдача секрета без подтверждения запрещена).
- `-Offline` предназначен только для автоматических тестов GitHub: реальная установка двух служб Manual/Stopped, проверка новых identity/lock и отсутствия credentials, затем удаление только своего свежего тестового экземпляра. Никаких Cloudflare запросов.
- `windows-package.yml`: Node/Linux suite; PowerShell 5 parser; Windows `-CheckOnly`; отдельный Windows-hosted job реальных SCM/ACL/cleanup; Inno Setup compile в единый EXE и SHA256 **и запуск именно этого EXE в CI с внутренним `/OFFLINE`-режимом**, чтобы проверить фактическую установку/удаление. ZIP/EXE upload GitHub Actions.

## Проверенное в CI 20.11.2026

- [PR #27](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/pull/27) MERGED; source commit `8c2eef4a68d68bb90e553fcfad815f562826bbf1`. До шага 18 исходник был `0a448c7ae587296988339e4a1e619cd442642f81` — это source rollback target.
- [Edge CI #44706904820](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44706904820) **SUCCESS**: npm checks, 111/111 tests, Wrangler build dry-run. Локально на Node проверены 111/111, `npm run check`, Wrangler dry-run.
- [Windows CI #44706904865](https://github.com/vl-ktk/qwen3.8-flash-next-125b-gsq-rco-abliterated-iq3-xxs/actions/runs/44706904865) **SUCCESS**, все 5 jobs: реальный PowerShell 5.1 syntax parser, supply-chain hashes / package, non-elevated preflight, установка обеих LocalService-служб + ACL + очистка на disposable Windows runner, сборка Inno Setup и **запуск собранного EXE** с `/OFFLINE` (внутри шага сборки; exit 0, test services after cleanup absent). Онлайн-привязка намеренно не выполнялась.
- Из этого прогона сохранён GitHub Actions artifact `KTK-MCP-Setup-step18-14`, ID `14615786351`, размер 44 244 741 байт (включает EXE и SHA256-текст), до **27.11.2026 09:00 UTC**. Artifact digest GitHub: `sha256:15f874c87fd29d3ce7ecf695b57c80563359b7246ba23e9b98a2f28aecde8e5e`. Это hash внешнего artifact ZIP, **не SHA256 самого EXE**; внутренний `.sha256` находится рядом с EXE. Артефакт тестовый и неподписанный; не означает готовности к установке у владельца.

## Чего **пока нет**

- Cloudflare production по-прежнему на прежней версии без new device pairing/bootstrap; две обязательные secret bindings не provisioned. **До разрешённой синхронной Cloudflare выкладки успешная онлайн-активация невозможна.** Поэтому до неё не передавать EXE как «готовый».
- Тест GitHub runner не равен реальному Windows UAC (у GitHub hosted Windows UAC отключён), а тест из ChatGPT не автоматизируется без живого соединения. Эти две проверки пройдут непосредственно на ПК владельца после подготовленного пакета.
- Code signing сертификата нет, официальный цифровой подписи издателя нет. Это должно быть явно видно в имени test artifact; не рекомендовать отключать защиту Windows.
- Установщик не трогает существующую инсталляцию и не заменяет чужой cloudflared. На ошибке оставляет аварийно заблокированную уже созданную установку для диагностики; в отчёте об этом сообщается.

## Git и следующий шаг

- Source PR #27 влит после контрольного сравнения `main` с исходной базой — расхождений не было. Откат исходника: commit `0a448c7ae587296988339e4a1e619cd442642f81`. Публичных выкладок нет; rollback Cloudflare не требуется.
- Далее согласовать отдельное окно безопасной публикации compatible Worker и provision secrets с владельцем (не включать ничего в архив). Только после этого дать один EXE для реальной Windows 10 Pro и проверить полный ChatGPT→Worker→Tunnel→Windows MCP.

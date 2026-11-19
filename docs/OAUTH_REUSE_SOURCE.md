# OAuth Worker: подтверждённый источник и перенос

Дата: 19.11.2026. Исходный код получен; прежний блокер экспорта снят. Реализация и ограничения приёмки — в [отчёте шага 7](STEP_7_REPORT.md).

## Подтверждённая версия (только GET)

- Worker: `instagram-mcp-oauth-test`, account `11e9863342745bfdb203486f289e0145`.
- Активная и последняя загруженная версия **38**, ID `9dd45b0a-0e55-4fbc-a97f-1801327daad5`.
- Deployment `63e07038-6e8a-4961-9009-0ecba1afae6d`, 100%; создан 14.11.2026.
- До и после извлечения GET `/deployments` и `/versions` подтвердили ту же версию. Никаких PUT/POST/PATCH/DELETE в Cloudflare не выполнялось.

## Почему прошлый аудит не видел JS

`GET /accounts/{account_id}/workers/scripts/{script_name}` и `GET .../content/v2` возвращают raw multipart **строкой напрямую** через текущий connector. Это не JSON-обёртка `response.result`. Просмотр только `.result` терял содержимое. Проверено на текущем доступе, без получения дополнительных прав, токенов или секретов.

В multipart шесть модулей: `oauth.js`, `mcp-resource-registry.mjs`, `facebook-mcp-registry.mjs`, `threads-mcp-registry.mjs`, `tiktok-mcp-registry.mjs`, `youtube-mcp-registry.mjs`. В Git перенесён только общий provider из `oauth.js`. Социальные реестры, исходный entrypoint, старый дублирующий provider и социальные handlers не переносились. Полный исходный bundle не сохранялся в репозитории.

## Точные границы и контрольные суммы

Модуль `oauth.js` содержит общий `@cloudflare/workers-oauth-provider`, затем `// ../generated-legacy-oauth.mjs` и код социальных сервисов. Перенесена только часть до этого маркера. Удалён неиспользуемый application import `WorkerEntrypoint3` с комментарием `// oauth.mjs`; добавлен один export трёх используемых API. **Тела функций библиотеки не менялись.** Правила Qwen находятся отдельно в `oauth.mjs`, `storage.mjs`, `worker.mjs`.

| Артефакт | SHA-256 |
|---|---|
| Исходный модуль `oauth.js` | `54f30934870337451feb4f832744e13c1259d6b4c3b8046224127c5494e8cf2a` |
| Извлечённый provider до добавления export | `d6d795a6211a11974c9980210609e1ff60057b004f16c693853e0ff91d9500ed` |
| `src/cloudflare/vendor/oauth-provider.mjs` | `8014c399bc5fbdf4e07df8f3d121d820dbbe2984323f372d29836c065b46b88c` |

Первый и второй хеши рассчитаны непосредственно над ответом read-only Cloudflare API. Второй совпал с локальным извлечением. Итоговый hash проверяет тест, LF зафиксирован `.gitattributes`. Точная npm-версия по bundle не установлена и не подменяется последним npm-релизом; идентичность фиксируют Worker version и SHA-256.

Машиночитаемое происхождение: `src/cloudflare/vendor/provenance.json`. Лицензия MIT и attribution Cloudflare сохранены в `src/cloudflare/vendor/LICENSE.txt`; [исходная лицензия](https://github.com/cloudflare/workers-oauth-provider/blob/main/LICENSE.txt).

Воспроизведение из отдельного авторизованного экспорта (multipart или точный `oauth.js`):

```powershell
node scripts/extract-oauth-provider.mjs <путь-к-авторизованному-экспорту>
```

Скрипт проверяет исходный SHA-256 до записи и сохраняет только provider. Сам экспорт нельзя добавлять в Git; значения секретов для этой операции не нужны.

## Изоляция Qwen

- Нет привязок к существующим OAuth KV, D1, account registry или social service bindings.
- `OAUTH_KV` встречается только как внутренний API-контракт библиотеки; ему передаётся адаптер **отдельного SQLite Durable Object Qwen**, а не старый KV namespace. Транзакция охватывает всю OAuth-операцию, включая async crypto; это проверено конкурентными code/refresh exchanges в workerd.
- Новый секрет `QWEN_OAUTH_OWNER_PASSWORD` не создавался; ни значения старых секретов, ни содержимое KV, ни пользовательские подключения не запрашивались.
- CIMD и внешние identity providers отключены; работает DCR. Нет внешнего токен-fallback, implicit flow или token exchange.
- Отдельный issuer/resource, cookie prefix, scope namespace, generation и проверяемый grant. Чужой access token не принимается.
- Из исходного приложения не переносились tenants, аккаунты соцсетей, пароли, sessions или подключения.

Опубликованный `qwen125b-mcp` остался в прежнем fail-closed состоянии. Код в Git не равен Cloudflare deployment; шаг 7 остаётся [ ] до фактической приёмки.

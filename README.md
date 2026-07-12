# wash-module-dynamic-pricing

Модуль WASH PRO CRM: **Динамические цены** (MQTT surge).

При высокой занятости отправляет **коэффициент списания** в топик `set/surge`. Прайс-лист не меняется.

## Внедрение на автомойке

См. **[CLIENT.md](./CLIENT.md)** — спецификация для прошивки панели / ETH-модуля.

## Настройки

| Ключ | Описание |
|------|----------|
| `wash_id` | ID автомойки |
| `busy_threshold` | Минимум занятых постов |
| `price_increase_percent` | Процент → коэффициент (`10` = `1.10`) |
| `poll_interval` | Интервал опроса (сек) |

## MQTT

Топик: `{prefix}/{serial}/set/surge` (публикация от CRM `system`)

```json
{ "coefficient": 1.10, "active": 1, "until_balance_zero": 1 }
```

## Версии

- **1.1.0** — коэффициент через MQTT `set/surge` (вместо изменения цен)
- **1.0.x** — устаревший подход с `set/prices`

## Лицензия

MIT

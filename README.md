**Language:** **English** · [Русский](README.ru.md)

# wash-module-dynamic-pricing

WASH PRO CRM module: **Dynamic Pricing** (MQTT surge).

When occupancy is high, sends a **debit coefficient** to the `set/surge` topic. The price list is not changed.

## Car wash integration

See **[CLIENT.md](./CLIENT.md)** — specification for panel / ETH-module firmware.

## Settings

| Key | Description |
|-----|-------------|
| `wash_id` | Car wash ID |
| `busy_threshold` | Minimum busy posts |
| `price_increase_percent` | Percent → coefficient (`10` = `1.10`) |
| `poll_interval` | Poll interval (sec) |

## MQTT

Topic: `{prefix}/{serial}/set/surge` (published by CRM `system` account)

```json
{ "coefficient": 1.10, "active": 1, "until_balance_zero": 1 }
```

## Versions

- **1.1.0** — coefficient via MQTT `set/surge` (instead of price changes)
- **1.0.x** — legacy approach with `set/prices`

## License

MIT

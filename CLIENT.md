**Language:** **English** · [Русский](CLIENT.ru.md)

# Car wash integration (panel / ETH module)

The **Dynamic Pricing** CRM module does not change the price list. It publishes an MQTT **debit coefficient** that applies **until the current session balance reaches zero**.

Messages are published by the CRM **`system`** account (full ACL) via `message-processor`:

```
{dt_pref}/{serial_number}/set/surge
```

Example topic: `washpro/WP-001/set/surge`

---

## 1. Topic subscription

The panel / post controller must subscribe to its `set/surge` topic (same as `set/prices` and `set/command`).

Recommended QoS: **1**.

---

## 2. Payload format (CRM → device)

### Enable surge

```json
{
  "coefficient": 1.10,
  "active": 1,
  "until_balance_zero": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `coefficient` | number | Debit multiplier. `1.10` = +10% balance consumption |
| `active` | 0 \| 1 | `1` — apply coefficient, `0` — disable for new sessions |
| `until_balance_zero` | 0 \| 1 | `1` — active until `balance == 0`, then auto-reset to `1.0` |

Optional (when delivery confirmation is enabled in CRM):

```json
{ "message_id": "uuid", "coefficient": 1.10, "active": 1, "until_balance_zero": 1 }
```

Recommended `set/ack` response:

```json
{ "kind": "surge", "status": "ok", "message_id": "uuid" }
```

### Disable surge (occupancy dropped)

```json
{
  "coefficient": 1.0,
  "active": 0,
  "until_balance_zero": 0
}
```

- New customers — no surge.
- Current session with an applied coefficient **continues** under `until_balance_zero` (until balance zero) if the session already started.

---

## 3. Device logic

### State (recommended model)

```c
struct SurgeState {
  float pending_coefficient;   // for next session
  float session_coefficient; // for current session
  bool  session_active;      // until_balance_zero in effect
};
```

### On `set/surge` received

1. If `active == 0` or `coefficient <= 1.0`:
   - `pending_coefficient = 1.0`
   - **Do not reset** `session_coefficient` if `session_active == true` (current customer until end of session).
2. If `active == 1` and `coefficient > 1.0`:
   - `pending_coefficient = coefficient`
   - If **balance > 0** (customer already on post) and `until_balance_zero == 1`:
     - `session_coefficient = coefficient`
     - `session_active = true`

### On payment credited (new session)

When balance goes `0 → amount > 0` (cash / card / contactless):

```
session_coefficient = pending_coefficient
session_active = (session_coefficient > 1.0 && until_balance_zero was 1)
```

### On mode debit

For each mode with base price `price > 0`:

```
charge = ceil(price * session_coefficient)   // or round per your business logic
balance -= charge
```

Do not multiply modes with `price == 0`.

### On balance zero

When `balance <= 0`:

```
session_coefficient = 1.0
session_active = false
// do not change pending_coefficient — for next customer
```

### Periodic telemetry

Keep publishing `state/process` with `balance` — CRM uses it for occupancy monitoring. Coefficient in `state/process` is **optional** (debug field `surge_k`).

---

## 4. Example scenario

| Step | Event | Device |
|------|-------|--------|
| 1 | 9/10 posts busy | CRM sends `k=1.10, active=1` |
| 2 | Customer pays 200 ₽ | `session_coefficient=1.10` |
| 3 | Mode "Foam" 50 ₽ | Debit `55 ₽` |
| 4 | Balance = 0 | Auto-reset `session_coefficient=1.0` |
| 5 | 6/10 busy | CRM sends `active=0` — new customers without surge |

---

## 5. NVS / MQTT (unchanged)

The post still connects with **its own** login (`settings.mqttLogin`), not `system`.  
`set/surge` commands arrive from the broker on behalf of CRM — the post only **reads** its topic.

Verify:

| NVS / setting | Value |
|---------------|-------|
| `rm_en` | `1` |
| `rm_addr` / `rm_port` | CRM IP and port |
| `dt_pref` | same as CRM (`washpro` by default) |
| serial in topic | = `posts.serialNumber` in CRM |

---

## 6. Firmware checklist

- [ ] Subscribe to `{dt_pref}/{serial}/set/surge`
- [ ] Parse `coefficient`, `active`, `until_balance_zero`
- [ ] Multiply debits when `session_coefficient > 1`
- [ ] Reset coefficient when `balance <= 0`
- [ ] Ignore `active=0` for an already started session (until zero)
- [ ] (Optional) `set/ack` with `kind: "surge"`

---

## 7. Manual test (mosquitto_pub)

From the CRM server (`system` login, password from **Settings → MQTT (CRM)**):

```bash
mosquitto_pub -h localhost -p 1883 -u system -P 'PASSWORD' -q 1 \
  -t 'washpro/SERIAL/set/surge' \
  -m '{"coefficient":1.15,"active":1,"until_balance_zero":1}'
```

Disable:

```bash
mosquitto_pub -h localhost -p 1883 -u system -P 'PASSWORD' -q 1 \
  -t 'washpro/SERIAL/set/surge' \
  -m '{"coefficient":1.0,"active":0,"until_balance_zero":0}'
```

Replace `SERIAL` with `posts.serialNumber`.

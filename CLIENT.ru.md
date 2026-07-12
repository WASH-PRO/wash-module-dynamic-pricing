**Язык:** [English](CLIENT.md) · **Русский**

# Внедрение на стороне автомойки (панель / ETH-модуль)

Модуль **Динамические цены** CRM не меняет прайс-лист. Он публикует в MQTT **коэффициент списания**, который действует **до обнуления баланса** текущей сессии клиента.

Публикация идёт от учётной записи CRM **`system`** (полный ACL) через `message-processor`:

```
{dt_pref}/{serial_number}/set/surge
```

Пример топика: `washpro/WP-001/set/surge`

---

## 1. Подписка на топик

Панель / контроллер поста должен подписаться на свой топик `set/surge` (как на `set/prices` и `set/command`).

QoS рекомендуется **1**.

---

## 2. Формат payload (CRM → устройство)

### Включить повышение

```json
{
  "coefficient": 1.10,
  "active": 1,
  "until_balance_zero": 1
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `coefficient` | number | Множитель списания. `1.10` = +10% к расходу баланса |
| `active` | 0 \| 1 | `1` — коэффициент принять, `0` — отключить для новых сессий |
| `until_balance_zero` | 0 \| 1 | `1` — действует до `balance == 0`, затем автосброс на `1.0` |

Опционально (если в CRM включено подтверждение доставки):

```json
{ "message_id": "uuid", "coefficient": 1.10, "active": 1, "until_balance_zero": 1 }
```

Ответ на `set/ack` (рекомендуется):

```json
{ "kind": "surge", "status": "ok", "message_id": "uuid" }
```

### Отключить повышение (занятость упала)

```json
{
  "coefficient": 1.0,
  "active": 0,
  "until_balance_zero": 0
}
```

- Новые клиенты — без повышения.
- Текущая сессия с уже применённым коэффициентом **продолжает** по правилу `until_balance_zero` (до нуля баланса), если сессия уже началась.

---

## 3. Логика на устройстве

### Состояние (рекомендуемая модель)

```c
struct SurgeState {
  float pending_coefficient;   // для следующей сессии
  float session_coefficient; // для текущей сессии
  bool  session_active;      // until_balance_zero в работе
};
```

### При получении `set/surge`

1. Если `active == 0` или `coefficient <= 1.0`:
   - `pending_coefficient = 1.0`
   - **Не сбрасывать** `session_coefficient`, если `session_active == true` (текущий клиент до конца сессии).
2. Если `active == 1` и `coefficient > 1.0`:
   - `pending_coefficient = coefficient`
   - Если **баланс > 0** (клиент уже на посту) и `until_balance_zero == 1`:
     - `session_coefficient = coefficient`
     - `session_active = true`

### При зачислении оплаты (новая сессия)

Когда баланс переходит `0 → сумма > 0` (наличные / безнал / карта):

```
session_coefficient = pending_coefficient
session_active = (session_coefficient > 1.0 && until_balance_zero был 1)
```

### При списании за режим

Для каждого режима с базовой ценой `price > 0`:

```
charge = ceil(price * session_coefficient)   // или round по вашей бизнес-логике
balance -= charge
```

Режимы с `price == 0` не умножать.

### При обнулении баланса

Когда `balance <= 0`:

```
session_coefficient = 1.0
session_active = false
// pending_coefficient не трогать — для следующего клиента
```

### Периодическая телеметрия

Продолжать публиковать `state/process` с полем `balance` — CRM использует его для мониторинга занятости. Коэффициент в `state/process` **не обязателен** (опционально для отладки: поле `surge_k`).

---

## 4. Пример сценария

| Шаг | Событие | Устройство |
|-----|---------|------------|
| 1 | Занято 9/10 постов | CRM шлёт `k=1.10, active=1` |
| 2 | Клиент вносит 200 ₽ | `session_coefficient=1.10` |
| 3 | Режим «Пена» 50 ₽ | Списание `55 ₽` |
| 4 | Баланс = 0 | Автосброс `session_coefficient=1.0` |
| 5 | Занято 6/10 | CRM шлёт `active=0` — новые клиенты без surge |

---

## 5. NVS / MQTT (без изменений)

Пост по-прежнему подключается **своим** логином (`settings.mqttLogin`), не `system`.  
Команды `set/surge` приходят от брокера от имени CRM — пост только **читает** свой топик.

Проверьте:

| NVS / настройка | Значение |
|-----------------|----------|
| `rm_en` | `1` |
| `rm_addr` / `rm_port` | IP и порт CRM |
| `dt_pref` | как в CRM (`washpro` по умолчанию) |
| serial в топике | = `posts.serialNumber` в CRM |

---

## 6. Минимальный чеклист прошивки

- [ ] Подписка на `{dt_pref}/{serial}/set/surge`
- [ ] Парсинг `coefficient`, `active`, `until_balance_zero`
- [ ] Умножение списания при `session_coefficient > 1`
- [ ] Сброс коэффициента при `balance <= 0`
- [ ] Игнорирование `active=0` для уже начатой сессии (until zero)
- [ ] (Опционально) `set/ack` с `kind: "surge"`

---

## 7. Тест вручную (mosquitto_pub)

С сервера CRM (логин `system`, пароль из **Настройки → MQTT (CRM)**):

```bash
mosquitto_pub -h localhost -p 1883 -u system -P 'ПАРОЛЬ' -q 1 \
  -t 'washpro/SERIAL/set/surge' \
  -m '{"coefficient":1.15,"active":1,"until_balance_zero":1}'
```

Отключение:

```bash
mosquitto_pub -h localhost -p 1883 -u system -P 'ПАРОЛЬ' -q 1 \
  -t 'washpro/SERIAL/set/surge' \
  -m '{"coefficient":1.0,"active":0,"until_balance_zero":0}'
```

Замените `SERIAL` на `posts.serialNumber`.

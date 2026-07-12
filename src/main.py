"""WASH module: dynamic pricing based on post occupancy."""

from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

API_BASE = os.environ.get("API_BASE_URL", "http://dynamic-api:3001").rstrip("/")
PROCESSOR_API_BASE = os.environ.get("PROCESSOR_API_BASE_URL", "http://message-processor:3022").rstrip("/")
DATA_DIR = os.environ.get("MODULE_DATA_DIR", "/data")

LOG_PREFIX = "[dynamic-pricing]"
STATE_FILE = "pricing_state.json"
SNAPSHOT_FILE = "last_snapshot.json"
SETTINGS_FILE = "settings.json"
MAX_EVENTS = 30
READONLY_MODES = {"8", "9"}

_runtime_config: RuntimeConfig | None = None
_access_token: str | None = None


@dataclass
class RuntimeConfig:
    wash_id: str
    busy_threshold: int
    price_increase_percent: float
    poll_interval: int
    api_login: str
    api_password: str


def log(message: str) -> None:
    print(f"{LOG_PREFIX} {message}", flush=True)


def ref_id(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return str(value.get("id") or value.get("_id") or "")
    return str(value)


def load_settings_file() -> dict[str, Any]:
    path = os.path.join(DATA_DIR, SETTINGS_FILE)
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def pick_str(settings: dict[str, Any], key: str, env_key: str, default: str = "") -> str:
    raw = settings.get(key)
    if raw is not None and str(raw).strip():
        return str(raw).strip()
    env_val = os.environ.get(env_key, default)
    return str(env_val).strip() if env_val is not None else default


def pick_number(settings: dict[str, Any], key: str, env_key: str, default: float) -> float:
    if key in settings and settings[key] is not None and settings[key] != "":
        try:
            return float(settings[key])
        except (TypeError, ValueError):
            pass
    env_val = os.environ.get(env_key)
    if env_val is not None and str(env_val).strip():
        try:
            return float(env_val)
        except ValueError:
            pass
    return default


def load_runtime_config() -> RuntimeConfig:
    settings = load_settings_file()
    api_password = pick_str(settings, "api_password", "API_PASSWORD", "ServiceInternal123!")
    if not api_password:
        api_password = "ServiceInternal123!"
    return RuntimeConfig(
        wash_id=pick_str(settings, "wash_id", "WASH_ID"),
        busy_threshold=max(1, int(pick_number(settings, "busy_threshold", "BUSY_THRESHOLD", 9))),
        price_increase_percent=max(0.0, pick_number(settings, "price_increase_percent", "PRICE_INCREASE_PERCENT", 10)),
        poll_interval=max(15, int(pick_number(settings, "poll_interval", "POLL_INTERVAL", 60))),
        api_login=pick_str(settings, "api_login", "API_LOGIN", "service") or "service",
        api_password=api_password,
    )


def bind_runtime_config(config: RuntimeConfig) -> None:
    global _runtime_config, _access_token
    if (
        _runtime_config is None
        or _runtime_config.api_login != config.api_login
        or _runtime_config.api_password != config.api_password
    ):
        _access_token = None
    _runtime_config = config


def request_json(
    method: str,
    base: str,
    path: str,
    body: dict | None = None,
    headers: dict[str, str] | None = None,
) -> dict:
    url = f"{base}{path}"
    data = None
    req_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_login() -> None:
    global _access_token
    config = _runtime_config or load_runtime_config()
    payload = request_json(
        "POST",
        API_BASE,
        "/api/auth/login",
        {"login": config.api_login, "password": config.api_password},
    )
    if not payload.get("success") or not payload.get("data", {}).get("accessToken"):
        raise RuntimeError(f"CRM login failed: {payload.get('error', payload)}")
    _access_token = payload["data"]["accessToken"]


def auth_headers() -> dict[str, str]:
    global _access_token
    if not _access_token:
        api_login()
    return {"Authorization": f"Bearer {_access_token}"}


def api_call(method: str, path: str, body: dict | None = None) -> dict:
    global _access_token
    try:
        return request_json(method, API_BASE, path, body=body, headers=auth_headers())
    except urllib.error.HTTPError as err:
        if err.code == 401:
            api_login()
            return request_json(method, API_BASE, path, body=body, headers=auth_headers())
        err_body = err.read().decode()
        try:
            parsed = json.loads(err_body)
            raise RuntimeError(parsed.get("error", err_body)) from err
        except json.JSONDecodeError as decode_err:
            raise RuntimeError(f"HTTP {err.code}: {err_body}") from decode_err


def processor_post(path: str, body: dict) -> Any:
    global _access_token
    try:
        payload = request_json("POST", PROCESSOR_API_BASE, path, body=body, headers=auth_headers())
    except urllib.error.HTTPError as err:
        if err.code == 401:
            api_login()
            payload = request_json("POST", PROCESSOR_API_BASE, path, body=body, headers=auth_headers())
        else:
            err_body = err.read().decode()
            try:
                parsed = json.loads(err_body)
                raise RuntimeError(parsed.get("error", err_body)) from err
            except json.JSONDecodeError as decode_err:
                raise RuntimeError(f"HTTP {err.code}: {err_body}") from decode_err
    if payload.get("success") is False:
        raise RuntimeError(payload.get("error", "Processor API error"))
    return payload.get("data")


def fetch_public(path: str) -> Any:
    payload = request_json("GET", API_BASE, path)
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def post_busy(state: dict | None) -> bool:
    if not state:
        return False
    if state.get("connected") is False:
        return False
    mode = str(state.get("mode") or state.get("modeName") or "").lower()
    mode_num = state.get("modeNumber")
    if mode_num == 9 or "program_9" in mode or mode == "9":
        return False
    return True


def normalize_mode_prices(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    result: dict[str, int] = {}
    for key, value in raw.items():
        if not str(key).isdigit():
            continue
        try:
            price = int(round(float(value)))
        except (TypeError, ValueError):
            continue
        if price >= 0:
            result[str(key)] = price
    return result


def apply_increase(prices: dict[str, int], percent: float) -> dict[str, int]:
    factor = 1 + max(0.0, percent) / 100.0
    result: dict[str, int] = {}
    for mode, price in prices.items():
        if mode in READONLY_MODES:
            continue
        if price > 0:
            result[mode] = max(0, int(math.ceil(price * factor)))
        else:
            result[mode] = price
    return result


def load_state() -> dict:
    path = os.path.join(DATA_DIR, STATE_FILE)
    if not os.path.isfile(path):
        return {
            "washId": "",
            "surgeActive": False,
            "originalPrices": {},
            "recentEvents": [],
        }
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return {
            "washId": "",
            "surgeActive": False,
            "originalPrices": {},
            "recentEvents": [],
        }
    data.setdefault("originalPrices", {})
    data.setdefault("recentEvents", [])
    return data


def save_state(state: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, STATE_FILE)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def add_event(state: dict, event_type: str, message: str, details: dict | None = None) -> None:
    events = state.setdefault("recentEvents", [])
    events.append(
        {
            "at": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            "message": message,
            "details": details or {},
        }
    )
    del events[:-MAX_EVENTS]


def push_post_prices(serial: str, prices: dict[str, int], mqtt_prefix: str | None = None) -> None:
    body: dict[str, Any] = {
        "prices": prices,
        "sendToDevice": True,
        "persist": True,
    }
    if mqtt_prefix:
        body["mqttPrefix"] = mqtt_prefix
    processor_post(f"/posts/{urllib.parse.quote(serial, safe='')}/prices", body)


def update_post_prices(post: dict, prices: dict[str, int]) -> bool:
    serial = str(post.get("serialNumber") or "").strip()
    settings = post.get("settings") if isinstance(post.get("settings"), dict) else {}
    mqtt_prefix = str(settings.get("mqttPrefix") or "").strip() or None
    if serial:
        push_post_prices(serial, prices, mqtt_prefix)
        return True

    post_id = ref_id(post.get("id"))
    if not post_id:
        return False

    api_call(
        "PUT",
        f"/api/crm/posts/{post_id}",
        {
            "washId": ref_id(post.get("washId")),
            "postNumber": post.get("postNumber"),
            "name": post.get("name"),
            "serialNumber": post.get("serialNumber"),
            "settings": {
                **settings,
                "modePrices": prices,
                "pricesUpdatedAt": datetime.now(timezone.utc).isoformat(),
            },
        },
    )
    return True


def apply_prices_to_posts(
    posts: list[dict],
    originals: dict[str, dict[str, int]],
    mode: str,
    percent: float,
) -> tuple[int, dict[str, dict[str, int]]]:
    updated = 0
    stored = dict(originals)
    for post in posts:
        post_id = ref_id(post.get("id"))
        if not post_id:
            continue
        settings = post.get("settings") if isinstance(post.get("settings"), dict) else {}
        current = normalize_mode_prices(settings.get("modePrices"))
        if mode == "surge":
            if post_id not in stored:
                stored[post_id] = current
            target = apply_increase(stored[post_id], percent)
        else:
            target = stored.get(post_id, current)

        if not target:
            log(f"skip post={post_id}: no prices configured")
            continue
        try:
            if update_post_prices(post, target):
                updated += 1
                log(f"{mode} post={post_id} prices={target}")
        except Exception as err:  # noqa: BLE001
            log(f"failed post={post_id}: {err}")
    return updated, stored


def build_snapshot(
    *,
    config: RuntimeConfig,
    total_posts: int,
    busy_posts: int,
    surge_active: bool,
    posts_updated: int,
    last_event: str,
    recent_events: list[dict],
    config_error: str | None = None,
) -> dict:
    snapshot = {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "washId": config.wash_id,
        "totalPosts": total_posts,
        "busyPosts": busy_posts,
        "busyThreshold": config.busy_threshold,
        "surgeActive": surge_active,
        "priceIncreasePercent": config.price_increase_percent,
        "postsUpdatedLastCycle": posts_updated,
        "lastEvent": last_event,
        "recentEvents": recent_events[-10:],
    }
    if config_error:
        snapshot["configError"] = config_error
    return snapshot


def save_snapshot(snapshot: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, SNAPSHOT_FILE)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)


def run_cycle(config: RuntimeConfig) -> int:
    bind_runtime_config(config)

    if not config.wash_id:
        msg = "wash_id is not configured — select a car wash in module settings"
        log(msg)
        state = load_state()
        add_event(state, "config_missing", msg)
        save_state(state)
        save_snapshot(
            build_snapshot(
                config=config,
                total_posts=0,
                busy_posts=0,
                surge_active=False,
                posts_updated=0,
                last_event="config_missing",
                recent_events=state.get("recentEvents", []),
                config_error=msg,
            )
        )
        return config.poll_interval

    states = fetch_public("/api/crm/post-states?limit=500")
    if not isinstance(states, list):
        states = []

    posts = fetch_public("/api/crm/posts?limit=500")
    if not isinstance(posts, list):
        posts = []

    wash_posts = [p for p in posts if ref_id(p.get("washId")) == config.wash_id]
    wash_post_ids = {ref_id(p.get("id")) for p in wash_posts if ref_id(p.get("id"))}
    wash_states = [s for s in states if ref_id(s.get("washId")) == config.wash_id]

    busy_posts = sum(
        1
        for s in wash_states
        if ref_id(s.get("postId")) in wash_post_ids and post_busy(s)
    )
    total_posts = len(wash_posts)

    state = load_state()
    if state.get("washId") != config.wash_id:
        state = {
            "washId": config.wash_id,
            "surgeActive": False,
            "originalPrices": {},
            "recentEvents": state.get("recentEvents", []),
        }
        add_event(state, "wash_changed", f"Selected wash {config.wash_id}")
        log(f"wash changed to {config.wash_id}, state reset")

    threshold_met = busy_posts >= config.busy_threshold
    surge_active = bool(state.get("surgeActive"))
    posts_updated = 0
    last_event = "idle"

    if threshold_met and not surge_active:
        posts_updated, originals = apply_prices_to_posts(
            wash_posts,
            state.get("originalPrices", {}),
            "surge",
            config.price_increase_percent,
        )
        state["originalPrices"] = originals
        state["surgeActive"] = True
        msg = (
            f"Surge activated: busy={busy_posts}/{total_posts}, "
            f"+{config.price_increase_percent}% on {posts_updated} posts"
        )
        add_event(
            state,
            "surge_activated",
            msg,
            {"busy": busy_posts, "total": total_posts, "postsUpdated": posts_updated},
        )
        log(msg)
        last_event = "surge_activated"

    elif threshold_met and surge_active:
        last_event = "surge_active"
        log(f"surge active: busy={busy_posts}/{total_posts} (threshold={config.busy_threshold})")

    elif not threshold_met and surge_active:
        posts_updated, _ = apply_prices_to_posts(
            wash_posts,
            state.get("originalPrices", {}),
            "restore",
            config.price_increase_percent,
        )
        state["surgeActive"] = False
        state["originalPrices"] = {}
        msg = (
            f"Surge deactivated: busy={busy_posts}/{total_posts}, "
            f"restored prices on {posts_updated} posts"
        )
        add_event(
            state,
            "surge_deactivated",
            msg,
            {"busy": busy_posts, "total": total_posts, "postsUpdated": posts_updated},
        )
        log(msg)
        last_event = "surge_deactivated"

    else:
        log(f"idle: busy={busy_posts}/{total_posts} (threshold={config.busy_threshold})")
        last_event = "idle"

    save_state(state)
    save_snapshot(
        build_snapshot(
            config=config,
            total_posts=total_posts,
            busy_posts=busy_posts,
            surge_active=bool(state.get("surgeActive")),
            posts_updated=posts_updated,
            last_event=last_event,
            recent_events=state.get("recentEvents", []),
        )
    )
    return config.poll_interval


def main() -> None:
    log(f"daemon started, data_dir={DATA_DIR}")
    while True:
        config = load_runtime_config()
        sleep_for = config.poll_interval
        try:
            sleep_for = run_cycle(config)
        except urllib.error.URLError as err:
            log(f"network error: {err}")
        except Exception as err:  # noqa: BLE001
            log(f"error: {err}")
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()

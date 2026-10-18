#!/usr/bin/env python3
"""Fetch AirKorea (한국환경공단 에어코리아) real-time PM10/PM2.5 for all stations
and write a compact public JSON (data/airkorea.json). Runs in GitHub Actions.

The service key comes ONLY from the AIRKOREA_SERVICE_KEY environment variable
(an Actions secret). It is never printed: every message is scrubbed.
Station coordinates live in data/stations.json (refreshed from
MsrstnInfoInqireSvc/getMsrstnList when possible, otherwise kept as-is).
"""
import json, os, sys, time, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

KEY = os.environ.get("AIRKOREA_SERVICE_KEY", "").strip()
BASE = "https://apis.data.go.kr/B552584/"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "data", "airkorea.json")
STN = os.path.join(ROOT, "data", "stations.json")
KST = timezone(timedelta(hours=9))


def scrub(s):
    s = str(s)
    if KEY:
        for v in {KEY, urllib.parse.quote(KEY, safe=""), urllib.parse.quote_plus(KEY)}:
            s = s.replace(v, "***")
    return s


def log(*a):
    print(scrub(" ".join(str(x) for x in a)), flush=True)


class ApiError(Exception):
    pass


def call(path, params, tries=3):
    q = urllib.parse.urlencode({"serviceKey": KEY, "returnType": "json", **params})
    url = BASE + path + "?" + q
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "rhffkwl-weather/1.0"}), timeout=60) as r:
                body = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            last = ApiError(f"HTTP {e.code}: {body[:300]}")
            if e.code in (401, 403):
                break
            time.sleep(3 * (i + 1)); continue
        except Exception as e:  # network
            last = ApiError(f"network: {e}")
            time.sleep(3 * (i + 1)); continue
        try:
            j = json.loads(body)
        except ValueError:
            # XML error envelope e.g. SERVICE_KEY_IS_NOT_REGISTERED_ERROR
            last = ApiError(f"non-JSON response: {body[:300]}")
            if "SERVICE" in body and "KEY" in body:
                break
            time.sleep(3 * (i + 1)); continue
        resp = j.get("response", j)
        hdr = resp.get("header", {})
        if str(hdr.get("resultCode", "00")) not in ("00", "0"):
            last = ApiError(f"API error {hdr.get('resultCode')}: {hdr.get('resultMsg')}")
            time.sleep(3 * (i + 1)); continue
        return resp.get("body", {})
    raise last or ApiError("unknown")


def paged(path, params, rows=1000):
    items, page = [], 1
    while True:
        b = call(path, {**params, "numOfRows": rows, "pageNo": page})
        its = b.get("items") or []
        if isinstance(its, dict):
            its = its.get("item") or []
        if isinstance(its, dict):
            its = [its]
        items += its
        total = int(b.get("totalCount") or 0)
        if not its or len(items) >= total or page >= 10:
            return items
        page += 1


def num(v):
    try:
        f = float(str(v).strip())
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return None  # '-', '', None, '통신장애' ...


def load_json(p, d):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return d


def write_json(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, p)


def latlon(a, b):
    """AirKorea dmX/dmY: one is lat (33-39), the other lon (124-132)."""
    a, b = num(a), num(b)
    if a is None or b is None:
        return None
    if 32 < a < 40 and 123 < b < 133:
        return round(a, 5), round(b, 5)
    if 32 < b < 40 and 123 < a < 133:
        return round(b, 5), round(a, 5)
    return None


def refresh_stations(stations, force):
    meta = stations.get("_meta", {})
    age = time.time() - meta.get("fetched", 0)
    if not force and age < 7 * 86400 and stations.get("list"):
        return stations, False
    try:
        items = paged("MsrstnInfoInqireSvc/getMsrstnList", {})
    except ApiError as e:
        log("station list (getMsrstnList) unavailable, keeping existing table:", e)
        return stations, False
    out = {}
    for it in items:
        ll = latlon(it.get("dmX"), it.get("dmY"))
        name = (it.get("stationName") or "").strip()
        if not ll or not name:
            continue
        addr = (it.get("addr") or "").strip()
        out.setdefault(name, []).append({"lat": ll[0], "lon": ll[1], "addr": addr})
    if len(out) < 300:
        log("station list looks incomplete:", len(out), "- keeping existing")
        return stations, False
    new = {"_meta": {"source": "에어코리아 MsrstnInfoInqireSvc/getMsrstnList", "fetched": int(time.time())}, "list": out}
    log("station table refreshed:", sum(len(v) for v in out.values()), "stations")
    return new, True


def pick_coord(stations, name, sido):
    cands = (stations.get("list") or {}).get(name) or []
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    s2 = sido[:2]
    for c in cands:  # disambiguate duplicate names by sido prefix in address
        if c.get("addr", "").startswith(s2) or s2 in c.get("addr", "")[:6]:
            return c
    return cands[0]


def main():
    if not KEY:
        log("AIRKOREA_SERVICE_KEY is not set"); return 2
    force_stn = os.environ.get("REFRESH_STATIONS") == "1"
    try:
        rows = paged("ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty", {"sidoName": "전국", "ver": "1.3"})
    except ApiError as e:
        msg = str(e)
        log("measurement fetch FAILED:", msg)
        if any(t in msg for t in ("NOT_REGISTERED", "NOT REGISTERED", "HTTP 401", "HTTP 403", "error 30", "UNAUTHORIZED", "Unauthorized")):
            log("::warning::AirKorea service key not (yet) registered/approved for ArpltnInforInqireSvc. Activation can take 1-2 hours.")
        return 1
    log("measurements:", len(rows), "rows")
    stations = load_json(STN, {})
    unknown = [r.get("stationName") for r in rows if r.get("stationName") and not (stations.get("list") or {}).get(r.get("stationName"))]
    stations, changed = refresh_stations(stations, force_stn or len(unknown) > 0 and time.time() - stations.get("_meta", {}).get("fetched", 0) > 86400)
    if changed:
        write_json(STN, stations)

    out, nocoord = [], []
    for r in rows:
        name = (r.get("stationName") or "").strip(); sido = (r.get("sidoName") or "").strip()
        c = pick_coord(stations, name, sido)
        if not c:
            nocoord.append(name); continue
        out.append([name, sido, c["lat"], c["lon"], num(r.get("pm10Value")), num(r.get("pm25Value")),
                    (r.get("dataTime") or "").strip(), num(r.get("pm10Grade1h")), num(r.get("pm25Grade1h"))])
    if nocoord:
        log(len(nocoord), "stations without coordinates (skipped):", ", ".join(nocoord[:30]))
    if not out:
        log("no usable rows; not writing"); return 1
    out.sort(key=lambda x: (x[1], x[0]))
    times = sorted({x[6] for x in out if x[6]})
    doc = {
        "source": "에어코리아 (한국환경공단)",
        "note": "실시간 측정 자료는 확정되지 않은 값으로 실제 대기오염도와 차이가 있을 수 있습니다.",
        "dataTime": times[-1] if times else None,
        "tz": "Asia/Seoul",
        "fields": ["name", "sido", "lat", "lon", "pm10", "pm25", "dataTime", "pm10Grade1h", "pm25Grade1h"],
        "stations": out,
    }
    write_json(OUT, doc)
    log("wrote", len(out), "stations, latest dataTime", doc["dataTime"])
    return 0


if __name__ == "__main__":
    sys.exit(main())

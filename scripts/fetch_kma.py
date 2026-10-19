#!/usr/bin/env python3
"""Fetch KMA (기상청) forecasts for the representative grid points in
data/kma/points.json and write compact public JSON under data/kma/. Runs hourly
in GitHub Actions (.github/workflows/kma.yml).

  초단기실황 getUltraSrtNcst  every hour (base HH00, available ~HH:10)  → now.json, hist.json
  단기예보   getVilageFcst    8×/day (02,05,…,23시 발표, ~+10 min)      → f/<nx>_<ny>.json
  중기예보   getMidLandFcst + getMidTa  2×/day (06, 18시 발표)          → mid.json
Only work whose newest 발표 is not yet stored is done, so a late/duplicate run costs nothing.

The service key comes ONLY from the environment (KMA_SERVICE_KEY, else
AIRKOREA_SERVICE_KEY — same data.go.kr account). It is never printed: all output
is scrubbed. Daily call counts per operation are kept in data/kma/meta.json and a
run is skipped when it would exceed KMA_DAILY_LIMIT (default 9500 per operation;
development accounts get 10,000/day).
"""
import json, os, sys, time, urllib.parse, urllib.request, urllib.error, subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

KEY = (os.environ.get("KMA_SERVICE_KEY") or os.environ.get("AIRKOREA_SERVICE_KEY") or "").strip()
BASE = "https://apis.data.go.kr/1360000/"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
D = os.path.join(ROOT, "data", "kma")
KST = timezone(timedelta(hours=9))
LIMIT = int(os.environ.get("KMA_DAILY_LIMIT") or 9500)
WORKERS = int(os.environ.get("KMA_WORKERS") or 8)
TRANSPORT = os.environ.get("KMA_TRANSPORT", "urllib")  # "curl" for local testing (key passed on stdin, not argv)
ONLY = set(filter(None, (os.environ.get("KMA_ONLY") or "").split(",")))  # e.g. "now,mid" (testing)
POINT_LIMIT = int(os.environ.get("KMA_POINT_LIMIT") or 0)  # testing: only the first N points
HIST_HOURS = 27


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


class FatalError(ApiError):  # key/quota problems: stop the whole run
    pass


usage = {}  # op -> calls that reached data.go.kr this run


def http_get(url, timeout):
    if TRANSPORT == "curl":
        r = subprocess.run(["curl", "-sS", "-m", str(timeout), "-w", "\n%{http_code}", "-K", "-"],
                           input=f'url = "{url}"\nheader = "User-Agent: rhffkwl-weather/1.0"\n', capture_output=True, text=True)
        if r.returncode != 0:
            raise OSError(scrub(r.stderr.strip())[:200])
        body, _, code = r.stdout.rpartition("\n")
        return int(code), body
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "rhffkwl-weather/1.0"}), timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def call(op, params, tries=4, timeout=45):
    url = BASE + op + "?" + urllib.parse.urlencode({"serviceKey": KEY, "dataType": "JSON", "pageNo": 1, **params})
    name = op.split("/")[-1]
    last = None
    for i in range(tries):
        try:
            code, body = http_get(url, timeout)
        except Exception as e:  # network / TLS: never reached the gateway, does not count
            last = ApiError(f"network: {scrub(e)}"[:200]); time.sleep(3 * (i + 1)); continue
        usage[name] = usage.get(name, 0) + 1
        if any(t in body for t in ("SERVICE_KEY_IS_NOT_REGISTERED", "SERVICE_ACCESS_DENIED", "LIMITED_NUMBER_OF_SERVICE_REQUESTS", "DEADLINE_HAS_EXPIRED")):
            raise FatalError(f"{name} HTTP {code}: " + scrub(body)[:240].replace("\n", " "))
        if code >= 500 or code == 429:
            last = ApiError(f"HTTP {code}"); time.sleep(3 * (i + 1)); continue
        try:
            j = json.loads(body)
        except ValueError:
            last = ApiError(f"{name} non-JSON HTTP {code}: " + scrub(body)[:200].replace("\n", " ")); time.sleep(3 * (i + 1)); continue
        hdr = j.get("response", {}).get("header", {})
        rc = str(hdr.get("resultCode", ""))
        if rc == "00":
            its = j["response"].get("body", {}).get("items") or {}
            its = its.get("item") if isinstance(its, dict) else its
            return its if isinstance(its, list) else ([its] if its else [])
        if rc == "03":  # NO_DATA (발표 전)
            raise ApiError(f"{name} NO_DATA")
        if rc in ("20", "22", "30", "31", "32", "33"):
            raise FatalError(f"{name} API error {rc}: {hdr.get('resultMsg')}")
        last = ApiError(f"{name} API error {rc}: {hdr.get('resultMsg')}"); time.sleep(3 * (i + 1))
    raise last or ApiError("unknown")


def load(name, d):
    try:
        with open(os.path.join(D, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return d


def save(name, obj):
    p = os.path.join(D, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".tmp", "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":")); f.write("\n")
    os.replace(p + ".tmp", p)


def num(v):
    try:
        f = float(str(v).replace("mm", "").strip())
        return int(f) if f.is_integer() else round(f, 1)
    except (TypeError, ValueError):
        return None


def pcp_mm(v):
    """PCP: '강수없음' | '1mm 미만' | '1.0mm' | '30.0~50.0mm' | '50.0mm 이상' → mm (number)."""
    s = str(v or "").strip()
    if not s or s in ("강수없음", "0", "-"): return 0
    if "미만" in s: return 0.5
    s = s.replace("mm", "").replace("이상", "").strip()
    if "~" in s: s = s.split("~")[0]
    return num(s) or 0


# ---------- schedule ----------
def latest_ncst_base(now):
    t = now - timedelta(minutes=12)
    return t.strftime("%Y%m%d%H00")


def latest_vil_base(now):
    t = now - timedelta(minutes=12)
    h = max([b for b in (2, 5, 8, 11, 14, 17, 20, 23) if b <= t.hour], default=None)
    if h is None:
        return (t - timedelta(days=1)).strftime("%Y%m%d") + "2300"
    return t.strftime("%Y%m%d") + "%02d00" % h


def latest_mid_tm(now):
    t = now - timedelta(minutes=30)
    if t.hour >= 18: return t.strftime("%Y%m%d1800")
    if t.hour >= 6: return t.strftime("%Y%m%d0600")
    return (t - timedelta(days=1)).strftime("%Y%m%d1800")


def budget_ok(meta, op, need, day):
    used = meta.get("usage", {}).get(day, {}).get(op, 0)
    if used + need > LIMIT:
        log(f"::warning::{op}: daily budget {LIMIT} would be exceeded ({used} used + {need}); skipping")
        return False
    return True


def pmap(fn, items):
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        return list(ex.map(fn, items))


# ---------- 초단기실황 ----------
NC = ["T1H", "REH", "PTY", "RN1", "WSD", "VEC"]


def do_now(points, base, meta, day):
    if not budget_ok(meta, "getUltraSrtNcst", len(points), day): return False
    bd, bt = base[:8], base[8:]

    def one(p):
        try:
            its = call("VilageFcstInfoService_2.0/getUltraSrtNcst", {"base_date": bd, "base_time": bt, "nx": p[4], "ny": p[5], "numOfRows": 20})
        except FatalError: raise
        except ApiError as e:
            return e
        v = {it.get("category"): num(it.get("obsrValue")) for it in its}
        return [v.get(k) for k in NC]

    res = pmap(one, points)
    prev = load("now.json", {})
    prev_rows = prev.get("p") or []
    rows, fails = [], 0
    for i, r in enumerate(res):
        if isinstance(r, list) and r[0] is not None and r[0] > -50:
            rows.append(r)
        else:
            fails += 1
            # keep the previous observation (with its own base) so the client can judge its age
            old = prev_rows[i] if i < len(prev_rows) and prev.get("n") == len(points) else None
            if old:
                old = list(old[:6]) + [old[6] if len(old) > 6 else prev.get("base")]
            rows.append(old)
    ok = len(points) - fails
    log(f"ncst {base}: {ok}/{len(points)} ok")
    if ok == 0:
        return False
    # 24h history of T1H for '어제보다' (aligned with points order)
    hist = load("hist.json", {"n": len(points), "t1h": {}})
    if hist.get("n") != len(points): hist = {"n": len(points), "t1h": {}}
    hist["t1h"][base] = [r[0] if r and (len(r) < 7 or r[6] in (None, base)) else None for r in rows]
    keep = sorted(hist["t1h"])[-HIST_HOURS:]
    hist["t1h"] = {k: hist["t1h"][k] for k in keep}
    yb = (datetime.strptime(base, "%Y%m%d%H%M") - timedelta(hours=24)).strftime("%Y%m%d%H%M")
    save("hist.json", hist)
    save("now.json", {"source": "기상청 초단기실황 (getUltraSrtNcst)", "base": base, "n": len(points), "fields": NC + ["base"],
                      "p": rows, "ydayBase": yb if yb in hist["t1h"] else None, "yday": hist["t1h"].get(yb)})
    return True


# ---------- 단기예보 ----------
HF = ["TMP", "POP", "SKY", "PTY", "PCP"]


def do_vil(points, base, meta, day):
    if meta.get("vil") == base and meta.get("vilMissing"):  # same 발표, retry only the points that failed last time
        miss = set(meta["vilMissing"]); points = [p for p in points if f"{p[4]}_{p[5]}" in miss]
        log(f"vilage {base}: retrying {len(points)} missing points")
    if not budget_ok(meta, "getVilageFcst", len(points), day): return False
    bd, bt = base[:8], base[8:]
    today = datetime.strptime(bd, "%Y%m%d").strftime("%Y-%m-%d")

    def one(p):
        try:
            its = call("VilageFcstInfoService_2.0/getVilageFcst", {"base_date": bd, "base_time": bt, "nx": p[4], "ny": p[5], "numOfRows": 1500})
        except FatalError: raise
        except ApiError as e:
            return e
        if len(its) < 100: return ApiError(f"short response {len(its)}")
        hours, days = {}, {}
        for it in its:
            c, fd, ft, v = it.get("category"), it.get("fcstDate"), it.get("fcstTime"), it.get("fcstValue")
            key = fd + ft[:2]
            if c in ("TMN", "TMX"):
                dd = f"{fd[:4]}-{fd[4:6]}-{fd[6:]}"
                days.setdefault(dd, [None, None])[0 if c == "TMN" else 1] = num(v)
            elif c in HF:
                hours.setdefault(key, {})[c] = pcp_mm(v) if c == "PCP" else num(v)
        fname = f"f/{p[4]}_{p[5]}.json"
        old = load(fname, {})
        # 오늘 최저/최고는 02시 발표에만 들어 있음 → 이전 발표의 오늘 값을 이어 받음
        for dd, mm in (old.get("d") or {}).items():
            if dd >= today:
                cur = days.setdefault(dd, [None, None])
                for k in (0, 1):
                    if cur[k] is None: cur[k] = mm[k]
        t0 = min(hours)
        t0dt = datetime.strptime(t0, "%Y%m%d%H")
        # earlier hours of today (already past in this 발표) are kept from the previous file for daily summaries
        rows = []
        if old.get("t0") and old.get("h"):
            ot0 = datetime.strptime(old["t0"], "%Y%m%d%H")
            for r in old["h"]:
                t = ot0 + timedelta(hours=r[0])
                if t.strftime("%Y-%m-%d") >= today and t < t0dt:
                    rows.append([int((t - t0dt).total_seconds() // 3600)] + r[1:])
        for k in sorted(hours):
            h = hours[k]
            rows.append([int((datetime.strptime(k, "%Y%m%d%H") - t0dt).total_seconds() // 3600)] + [h.get(c) for c in HF])
        save(fname, {"base": base, "nx": p[4], "ny": p[5], "t0": t0, "fields": ["dh"] + HF, "h": rows,
                     "d": {k: days[k] for k in sorted(days) if k >= today}})
        return True

    res = pmap(one, points)
    ok = sum(1 for r in res if r is True)
    errs = [r for r in res if isinstance(r, Exception)]
    log(f"vilage {base}: {ok}/{len(points)} ok" + (f"; e.g. {errs[0]}" if errs else ""))
    meta["vilMissing"] = [f"{p[4]}_{p[5]}" for p, r in zip(points, res) if r is not True]
    return ok > 0


# ---------- 중기예보 ----------
def do_mid(points, tm, meta, day, ta_list):
    lands = sorted({p[6] for p in points}); tas = [t[0] for t in ta_list]
    if not budget_ok(meta, "getMidTa", len(tas), day) or not budget_ok(meta, "getMidLandFcst", len(lands), day): return False
    d0 = datetime.strptime(tm[:8], "%Y%m%d")
    ds = lambda n: (d0 + timedelta(days=n)).strftime("%Y-%m-%d")

    def land(r):
        try:
            it = call("MidFcstInfoService/getMidLandFcst", {"regId": r, "tmFc": tm, "numOfRows": 10})[0]
        except FatalError: raise
        except (ApiError, IndexError) as e:
            return r, None
        out = {}
        for n in range(3, 11):
            if f"wf{n}Am" in it: out[ds(n)] = [it.get(f"wf{n}Am"), it.get(f"wf{n}Pm"), num(it.get(f"rnSt{n}Am")), num(it.get(f"rnSt{n}Pm"))]
            elif f"wf{n}" in it: out[ds(n)] = [it.get(f"wf{n}"), it.get(f"wf{n}"), num(it.get(f"rnSt{n}")), num(it.get(f"rnSt{n}"))]
        return r, out

    def ta(r):
        try:
            it = call("MidFcstInfoService/getMidTa", {"regId": r, "tmFc": tm, "numOfRows": 10})[0]
        except FatalError: raise
        except (ApiError, IndexError):
            return r, None
        return r, {ds(n): [num(it.get(f"taMin{n}")), num(it.get(f"taMax{n}"))] for n in range(3, 11) if f"taMin{n}" in it}

    L = dict(pmap(land, lands)); T = dict(pmap(ta, tas))
    ok_l = sum(1 for v in L.values() if v); ok_t = sum(1 for v in T.values() if v)
    log(f"mid {tm}: land {ok_l}/{len(lands)}, ta {ok_t}/{len(tas)}")
    if not ok_l and not ok_t: return False
    prev = load("mid.json", {})
    for k, v in list(L.items()):
        if not v: L[k] = (prev.get("land") or {}).get(k)
    for k, v in list(T.items()):
        if not v: T[k] = (prev.get("ta") or {}).get(k)
    save("mid.json", {"source": "기상청 중기예보 (getMidLandFcst, getMidTa)", "tmFc": tm, "land": L, "ta": T})
    return ok_l == len(lands) and ok_t == len(tas)


def main():
    if not KEY:
        log("KMA_SERVICE_KEY / AIRKOREA_SERVICE_KEY is not set"); return 2
    pts_doc = load("points.json", None)
    if not pts_doc: log("data/kma/points.json missing (run scripts/build_kma_points.py)"); return 2
    points = pts_doc["points"][:POINT_LIMIT] if POINT_LIMIT else pts_doc["points"]
    now = datetime.now(KST); day = now.strftime("%Y%m%d")
    meta = load("meta.json", {})
    force = os.environ.get("KMA_FORCE") == "1"
    jobs = [("now", latest_ncst_base(now), lambda b: do_now(points, b, meta, day)),
            ("vil", latest_vil_base(now), lambda b: do_vil(points, b, meta, day)),
            ("mid", latest_mid_tm(now), lambda b: do_mid(points, b, meta, day, pts_doc["ta"]))]
    rc = 0
    for name, base, fn in jobs:
        if ONLY and name not in ONLY: continue
        if meta.get(name) == base and not force and not (name == "vil" and meta.get("vilMissing")):
            log(f"{name} {base}: already stored"); continue
        try:
            if fn(base): meta[name] = base
        except FatalError as e:
            log("::error::KMA request refused:", str(e)); rc = 1; break
        except Exception as e:
            log(f"::warning::{name} failed: {e}")
    u = meta.setdefault("usage", {})
    for k in [k for k in u if k < (now - timedelta(days=3)).strftime("%Y%m%d")]: del u[k]
    for op, n in usage.items():
        u.setdefault(day, {})[op] = u.get(day, {}).get(op, 0) + n
    meta["updated"] = now.strftime("%Y-%m-%d %H:%M")
    save("meta.json", meta)
    log("calls this run:", json.dumps(usage), "| today:", json.dumps(u.get(day, {})))
    return rc


if __name__ == "__main__":
    sys.exit(main())

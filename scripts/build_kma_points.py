#!/usr/bin/env python3
"""Build data/kma/points.json: representative KMA grid points (one per 시군구).

No API calls. Source: data/stations.json (AirKorea station addresses geocoded via
OpenStreetMap). Stations are grouped by 시도 + 시군구 (+ 구 for 시 with 구), and the
station nearest the group's mean position becomes the point (a populated spot,
not a mountain-top geometric centroid). lat/lon → KMA 5 km grid (nx, ny) with the
official Lambert Conformal Conic formula; points sharing a grid cell are merged.
Each point is also mapped to a 중기육상 (land) and 중기기온 (ta) region.
Run manually when stations.json changes:  python3 scripts/build_kma_points.py
"""
import json, math, os, re, collections

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "data", "stations.json")
OUT = os.path.join(ROOT, "data", "kma", "points.json")
COVER_KM = 15


def latlon_to_grid(lat, lon):
    """KMA 동네예보 격자 변환 (기상청 단기예보 활용가이드 LCC DFS)."""
    RE, GRID, SLAT1, SLAT2, OLON, OLAT, XO, YO = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
    D = math.pi / 180.0
    re_ = RE / GRID
    s1, s2, olon, olat = SLAT1 * D, SLAT2 * D, OLON * D, OLAT * D
    sn = math.log(math.cos(s1) / math.cos(s2)) / math.log(math.tan(math.pi * 0.25 + s2 * 0.5) / math.tan(math.pi * 0.25 + s1 * 0.5))
    sf = math.tan(math.pi * 0.25 + s1 * 0.5) ** sn * math.cos(s1) / sn
    ro = re_ * sf / math.tan(math.pi * 0.25 + olat * 0.5) ** sn
    ra = re_ * sf / math.tan(math.pi * 0.25 + lat * D * 0.5) ** sn
    th = lon * D - olon
    if th > math.pi: th -= 2 * math.pi
    if th < -math.pi: th += 2 * math.pi
    th *= sn
    return int(math.floor(ra * math.sin(th) + XO + 0.5)), int(math.floor(ro - ra * math.cos(th) + YO + 0.5))


# 시도 표기 통일 (주소 표기가 섞여 있음)
SIDO = [("서울", "서울"), ("부산", "부산"), ("대구", "대구"), ("인천", "인천"), ("광주광역", "광주"), ("대전", "대전"),
        ("울산", "울산"), ("세종", "세종"), ("경기", "경기"), ("강원", "강원"), ("충청북", "충북"), ("충북", "충북"),
        ("충청남", "충남"), ("충남", "충남"), ("전북", "전북"), ("전라북", "전북"), ("전남광주", "전남"), ("전라남", "전남"),
        ("전남", "전남"), ("경상북", "경북"), ("경북", "경북"), ("경상남", "경남"), ("경남", "경남"), ("제주", "제주")]
def norm_sido(s):
    for k, v in SIDO:
        if s.startswith(k): return v
    return None

# 중기육상예보 구역 (기상청 중기예보 조회서비스 활용가이드)
LAND = {"서울": "11B00000", "인천": "11B00000", "경기": "11B00000", "대전": "11C20000", "세종": "11C20000", "충남": "11C20000",
        "충북": "11C10000", "광주": "11F20000", "전남": "11F20000", "전북": "11F10000", "대구": "11H10000", "경북": "11H10000",
        "부산": "11H20000", "울산": "11H20000", "경남": "11H20000", "제주": "11G00000"}  # 강원: 영서/영동은 아래에서
# 중기기온 지점 (regId, 이름, 위도, 경도) — 활용가이드의 주요 도시 지점
TA = [("11B10101", "서울", 37.5714, 126.9658), ("11B20201", "인천", 37.4777, 126.6249), ("11B20601", "수원", 37.2723, 126.9853),
      ("11B20305", "파주", 37.7600, 126.7800), ("11D10301", "춘천", 37.9026, 127.7357), ("11D10401", "원주", 37.3376, 127.9466),
      ("11D20501", "강릉", 37.7515, 128.8910), ("11C20401", "대전", 36.3720, 127.3721), ("11C20101", "서산", 36.7766, 126.4939),
      ("11C20404", "세종", 36.4800, 127.2890), ("11C10301", "청주", 36.6392, 127.4407), ("11G00201", "제주", 33.5141, 126.5297),
      ("11G00401", "서귀포", 33.2462, 126.5653), ("11F20501", "광주", 35.1729, 126.8916), ("21F20801", "목포", 34.8169, 126.3812),
      ("11F20401", "여수", 34.7393, 127.7406), ("11F10201", "전주", 35.8215, 127.1550), ("21F10501", "군산", 35.9876, 126.7614),
      ("11H20201", "부산", 35.1047, 129.0320), ("11H20101", "울산", 35.5825, 129.3347), ("11H20301", "창원", 35.1702, 128.5729),
      ("11H10701", "대구", 35.8780, 128.6530), ("11H10501", "안동", 36.5729, 128.7073), ("11H10201", "포항", 36.0326, 129.3796)]


def km(a, b, c, d):
    r = math.pi / 180
    x = math.sin((c - a) * r / 2); y = math.sin((d - b) * r / 2)
    return 12742 * math.asin(math.sqrt(x * x + math.cos(a * r) * math.cos(c * r) * y * y))


def main():
    st = json.load(open(SRC, encoding="utf-8"))["list"]
    groups = collections.defaultdict(list)
    for cs in st.values():
        for c in cs:
            a = (c.get("addr") or "").split()
            sido = norm_sido(a[0]) if a else None
            if not sido or len(a) < 2: continue
            if sido == "세종": sgg = "세종시"
            else:
                sgg = a[1]
                if sido == "전남" and a[0].startswith("전남광주") and re.fullmatch(r"(동|서|남|북|광산)구", sgg): sido = "광주"
                if len(a) > 2 and sgg.endswith("시") and re.fullmatch(r"\S+구", a[2]): sgg += " " + a[2]
            groups[(sido, sgg)].append((c["lat"], c["lon"]))
    pts, cells = [], {}
    for (sido, sgg), ll in sorted(groups.items()):
        mlat = sum(x[0] for x in ll) / len(ll); mlon = sum(x[1] for x in ll) / len(ll)
        lat, lon = min(ll, key=lambda p: km(p[0], p[1], mlat, mlon))
        nx, ny = latlon_to_grid(lat, lon)
        if (nx, ny) in cells:  # same 5 km cell → one point, keep both names
            cells[(nx, ny)]["name"] += "·" + sgg; continue
        ta = min(TA, key=lambda t: km(lat, lon, t[2], t[3]))
        if sido == "강원":
            land = "11D20000" if ta[0] == "11D20501" else "11D10000"
        else:
            land = LAND[sido]
        p = {"name": sgg, "sido": sido, "lat": round(lat, 4), "lon": round(lon, 4), "nx": nx, "ny": ny, "land": land, "ta": ta[0]}
        cells[(nx, ny)] = p; pts.append(p)
    # 빈 곳 메우기: 어떤 대표점에서도 COVER_KM 넘게 떨어진 측정소 위치를 점으로 추가 (섬·제주 동서부 등)
    allst = [(name, c) for name, cs in st.items() for c in cs if norm_sido((c.get("addr") or "x").split()[0])]
    while True:
        far = [(min(km(c["lat"], c["lon"], p["lat"], p["lon"]) for p in pts), name, c) for name, c in allst]
        d, name, c = max(far, key=lambda x: x[0])
        if d <= COVER_KM: break
        a = c["addr"].split(); sido = norm_sido(a[0]); lat, lon = c["lat"], c["lon"]
        nx, ny = latlon_to_grid(lat, lon)
        ta = min(TA, key=lambda t: km(lat, lon, t[2], t[3]))
        land = ("11D20000" if ta[0] == "11D20501" else "11D10000") if sido == "강원" else LAND.get("광주" if sido == "전남" and "광주" in a[1] else sido, LAND[sido])
        p = {"name": re.sub(r"\(.*\)", "", name), "sido": sido, "lat": round(lat, 4), "lon": round(lon, 4), "nx": nx, "ny": ny, "land": land, "ta": ta[0]}
        cells[(nx, ny)] = p; pts.append(p)
    doc = {"_meta": {"note": "시군구 대표 격자점. 좌표는 에어코리아 측정소 주소의 OSM 지오코딩 위치(© OpenStreetMap contributors). "
                             "격자 변환: 기상청 LCC(DFS 5km). scripts/build_kma_points.py로 생성.",
                     "count": len(pts)},
           "ta": [[t[0], t[1], t[2], t[3]] for t in TA],
           "fields": ["name", "sido", "lat", "lon", "nx", "ny", "land", "ta"],
           "points": [[p[k] for k in ["name", "sido", "lat", "lon", "nx", "ny", "land", "ta"]] for p in pts]}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":")); f.write("\n")
    print(len(pts), "points;", collections.Counter(p["sido"] for p in pts))


if __name__ == "__main__":
    main()

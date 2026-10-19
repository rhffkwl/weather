// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: cloud-sun;

/*
 * 하늘 날씨 위젯 (Scriptable)
 * - 데이터: 국내는 기상청 초단기실황·단기·중기예보 (GitHub Actions가 매시 받아 둔 data/kma/*.json),
 *   해외이거나 기상청 자료가 없을 때는 Open-Meteo 예보. 어제 같은 시각 기온 비교, 지오코딩도 Open-Meteo (API 키 불필요)
 *   미세먼지: 에어코리아(한국환경공단) 실시간 측정값 — 가장 가까운 측정소.
 *   (3시간 넘게 오래됐거나 값이 없으면 Open-Meteo 예측값으로 대신 표시)
 * - 크기: 소형 · 중형 · 대형 (잠금화면 위젯도 간단히 지원)
 * - 위치: 현재 위치(실패 시 마지막 위치 → 서울). 국내 현재 위치 이름은 브이월드(국토교통부) 시·구 + 법정동(대형은 자리가 되면 행정동도), 해외는 iOS 주소.
 *   위젯 길게 누르기 > 위젯 편집 > Parameter 에 도시 이름(예: 부산, 제주, 강릉)을 넣으면 그 도시를 표시합니다.
 *   "37.57,126.98" 처럼 위도,경도를 직접 넣어도 됩니다.
 * - 웹앱: https://rhffkwl.github.io/weather/
 */
const WIDGET_VERSION = "2026-10-19d"; // 앱에서 실행하면 로그에 출력됩니다

const CONFIG = {
  appURL: "https://rhffkwl.github.io/weather/",
  airKoreaURL: "https://rhffkwl.github.io/weather/data/airkorea.json",
  kmaBaseURL: "https://rhffkwl.github.io/weather/data/kma/",
  fallback: { name: "서울", lat: 37.5665, lon: 126.978 },
  refreshMinutes: 30,
  budgetSeconds: 22,    // 위젯 한 번 실행에 쓰는 최대 시간(iOS가 오래 걸리는 위젯을 강제 종료하면 화면이 멈춘 채 남음)
  locationTimeout: 8,   // 초
  requestTimeout: 12,   // 초
  previewSize: "medium", // 앱에서 실행할 때 미리보기 크기: small | medium | large
  debugParameter: "",    // 앱에서 테스트할 도시 (예: "부산")
};
const TZ = "Asia/Seoul";

/* ---------------- 공통 유틸 ---------------- */
const fm = FileManager.local();
const DIR = fm.joinPath(fm.documentsDirectory(), "weather-widget");
if (!fm.fileExists(DIR)) fm.createDirectory(DIR, true);

const PARAM = String((config.runsInWidget ? args.widgetParameter : (args.widgetParameter || CONFIG.debugParameter)) || "").trim();
const FAMILY = config.runsInWidget ? (config.widgetFamily || "medium") : CONFIG.previewSize;

class NotFoundError extends Error {}

function pad(n) { return (n < 10 ? "0" : "") + n; }
function seoulParts(ms) {
  const d = new Date(ms + 9 * 3600 * 1000); // 한국은 서머타임 없음
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function seoulISO(ms) { const p = seoulParts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`; }
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16); }
function qs(o) { return Object.keys(o).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(o[k])).join("&"); }
function readJSON(path) { try { if (fm.fileExists(path)) return JSON.parse(fm.readString(path)); } catch (e) {} return null; }
function writeJSON(path, obj) { try { fm.writeString(path, JSON.stringify(obj)); } catch (e) {} }
function isNum(v) { return typeof v === "number" && isFinite(v); }
function tempStr(v) { return isNum(v) ? Math.round(v) + "°" : "--°"; }
function pctStr(v) { return isNum(v) ? Math.round(v) + "%" : "-"; }

function sleep(sec) { return new Promise(r => Timer.schedule(sec * 1000, false, r)); }
function withTimeout(p, sec, label) {
  return Promise.race([p, sleep(sec).then(() => { throw new Error(label + " 시간 초과"); })]);
}

async function getJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = CONFIG.requestTimeout;
  const j = await req.loadJSON();
  const sc = req.response && req.response.statusCode;
  if (sc && sc >= 400) throw new Error("HTTP " + sc + (j && j.reason ? ": " + j.reason : ""));
  if (j && j.error) throw new Error(j.reason || "API 오류");
  return j;
}

/* ---------------- 날씨 코드 ---------------- */
function weatherInfo(code, isDay) {
  const c = Number(code);
  const T = (text, day, night, kind) => ({ text, symbol: isDay ? day : (night || day), kind });
  if (c === 0) return T("맑음", "sun.max.fill", "moon.stars.fill", isDay ? "sun" : "moon");
  if (c === 1) return T("대체로 맑음", "sun.max.fill", "moon.fill", isDay ? "sun" : "moon");
  if (c === 2) return T("구름 조금", "cloud.sun.fill", "cloud.moon.fill", "cloud");
  if (c === 3) return T("흐림", "cloud.fill", "cloud.fill", "cloud");
  if (c === 45 || c === 48) return T("안개", "cloud.fog.fill", "cloud.fog.fill", "cloud");
  if (c >= 51 && c <= 55) return T("이슬비", "cloud.drizzle.fill", null, "rain");
  if (c === 56 || c === 57) return T("어는 이슬비", "cloud.sleet.fill", null, "rain");
  if (c === 61) return T("약한 비", "cloud.rain.fill", null, "rain");
  if (c === 63) return T("비", "cloud.rain.fill", null, "rain");
  if (c === 65) return T("강한 비", "cloud.heavyrain.fill", null, "rain");
  if (c === 66 || c === 67) return T("어는 비", "cloud.sleet.fill", null, "rain");
  if (c === 71) return T("약한 눈", "cloud.snow.fill", null, "snow");
  if (c === 73) return T("눈", "cloud.snow.fill", null, "snow");
  if (c === 75) return T("강한 눈", "snowflake", null, "snow");
  if (c === 77) return T("싸락눈", "cloud.snow.fill", null, "snow");
  if (c === 80) return T("약한 소나기", "cloud.sun.rain.fill", "cloud.moon.rain.fill", "rain");
  if (c === 81) return T("소나기", "cloud.rain.fill", null, "rain");
  if (c === 82) return T("강한 소나기", "cloud.heavyrain.fill", null, "rain");
  if (c === 85 || c === 86) return T("눈 소나기", "cloud.snow.fill", null, "snow");
  if (c === 95) return T("뇌우", "cloud.bolt.rain.fill", null, "storm");
  if (c === 96 || c === 99) return T("우박 동반 뇌우", "cloud.hail.fill", null, "storm");
  return T("알 수 없음", "cloud.fill", null, "cloud");
}
const ICON_TINT = { sun: "#FFD60A", moon: "#F2F2F7", cloud: "#FFFFFF", rain: "#9AD8FF", snow: "#FFFFFF", storm: "#FFD60A" };

/* ---------------- 미세먼지 ---------------- */
const PM_LABELS = ["좋음", "보통", "나쁨", "매우나쁨"];
const PM_COLORS = ["#2F80ED", "#27AE60", "#F2994A", "#EB5757"];
function pmLevel(v, kind, src) {
  if (!isNum(v)) return null;
  const t = kind === "pm10" ? [30, 80, 150] : [15, 35, 75];
  const i = v <= t[0] ? 0 : v <= t[1] ? 1 : v <= t[2] ? 2 : 3;
  return { label: PM_LABELS[i], color: PM_COLORS[i], value: Math.round(v), index: i, src: src || "model" };
}
/* AirKorea 실측 (에어코리아, 한국환경공단) */
const AK_MAX_KM = 25, AK_STALE_MS = 3 * 3600 * 1000;
function akTime(s) { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]) : NaN; }
function akKm(a, b, c, d) { const R = 6371, r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2); return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y)); }
// → { pm10: {v, name, sido, time, t, km} | null, pm25: ... } (nearest fresh station with a valid value; roadside stations only if nothing else in range)
function akNearest(doc, lat, lon, now) {
  if (!doc || !Array.isArray(doc.stations) || !Array.isArray(doc.fields)) return null;
  now = now || Date.now();
  const F = {}; doc.fields.forEach((f, i) => F[f] = i);
  const near = [];
  for (const r of doc.stations) {
    const t = akTime(r[F.dataTime]);
    if (!(now - t <= AK_STALE_MS)) continue;
    const km = akKm(lat, lon, r[F.lat], r[F.lon]);
    if (km <= AK_MAX_KM) near.push({ r, km, t, road: r[F.net] === "도로변대기" });
  }
  near.sort((a, b) => (a.road - b.road) || (a.km - b.km));
  const pick = k => { const x = near.find(n => typeof n.r[F[k]] === "number" && isFinite(n.r[F[k]]) && n.r[F[k]] >= 0); return x ? { v: x.r[F[k]], name: x.r[F.name], sido: x.r[F.sido], time: x.r[F.dataTime], t: x.t, km: Math.round(x.km * 10) / 10 } : null; };
  const out = { pm10: pick("pm10"), pm25: pick("pm25") };
  return (out.pm10 || out.pm25) ? out : null;
}
function akFresh(x, now) { return !!(x && now - x.t <= AK_STALE_MS); }
function akHour(x) { return x && x.time ? Number(x.time.slice(11, 13)) + "시" : ""; }

/* KMA:BEGIN — 기상청 국내 예보 (data/kma/*.json, GitHub Actions가 매시 갱신). 웹앱과 위젯에 같은 코드가 들어갑니다 (scripts/kma-client.js). */
const KMA_MAX_KM = 25, KMA_NOW_MAX_MS = 3 * 3600e3, KMA_NOW_PREFER_MS = 75 * 60e3, KMA_VIL_MAX_MS = 12 * 3600e3, KMA_MID_MAX_MS = 36 * 3600e3;
function kmaInKorea(lat, lon) { return lat > 32.8 && lat < 38.9 && lon > 124 && lon < 132; }
function kmaKm(a, b, c, d) { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2); return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y)); }
// "YYYYMMDDHH[MM]" (KST) → epoch ms
function kmaTime(s) { s = String(s || ""); return s.length >= 10 ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10) - 9, +(s.slice(10, 12) || 0)) : NaN; }
function kmaNearest(doc, lat, lon) {
  if (!doc || !Array.isArray(doc.points) || !kmaInKorea(lat, lon)) return null;
  const near = [];
  doc.points.forEach((p, i) => { const k = kmaKm(lat, lon, p[2], p[3]); if (k <= KMA_MAX_KM) near.push([k, i]); });
  if (!near.length) return null;
  near.sort((a, b) => a[0] - b[0]);
  const [bk, best] = near[0], p = doc.points[best];
  // alts: 가까운 다른 격자점 — 가장 가까운 점의 단기예보 파일이 없을 때(수집 실패) 대신 씀
  const alts = near.slice(1, 3).map(([k, i]) => ({ name: doc.points[i][0], nx: doc.points[i][4], ny: doc.points[i][5], km: Math.round(k * 10) / 10 }));
  return { i: best, n: doc.points.length, name: p[0], sido: p[1], lat: p[2], lon: p[3], nx: p[4], ny: p[5], land: p[6], ta: p[7], km: Math.round(bk * 10) / 10, alts };
}
// SKY(1 맑음, 3 구름많음, 4 흐림) / PTY(1 비, 2 비/눈, 3 눈, 4 소나기, 5 빗방울, 6 빗방울눈날림, 7 눈날림) → 기존 아이콘용 WMO 코드
function kmaWmo(sky, pty, mm) {
  pty = +pty || 0;
  if (pty === 1) return mm >= 15 ? 65 : mm >= 3 ? 63 : 61;
  if (pty === 2 || pty === 6) return 66;
  if (pty === 3) return 73;
  if (pty === 4) return 80;
  if (pty === 5) return 51;
  if (pty === 7) return 71;
  return +sky === 4 ? 3 : +sky === 3 ? 2 : 0;
}
function kmaDesc(sky, pty) {
  const P = ["", "비", "비/눈", "눈", "소나기", "빗방울", "빗방울·눈날림", "눈날림"];
  return P[+pty || 0] || ({ 1: "맑음", 3: "구름많음", 4: "흐림" })[+sky] || "";
}
function kmaWfWmo(wf) {
  wf = String(wf || "");
  if (/소나기/.test(wf)) return 80;
  if (/비\/눈|눈\/비/.test(wf)) return 66;
  if (/비/.test(wf)) return 61;
  if (/눈/.test(wf)) return 73;
  if (/흐/.test(wf)) return 3;
  if (/구름/.test(wf)) return 2;
  return /맑/.test(wf) ? 0 : null;
}
// 하루 대표 날씨: 강수가 있으면 가장 흔한 강수형태(강도는 최대 강수량), 없으면 낮(06~20시) 하늘상태의 최빈값(같으면 더 흐린 쪽)
function kmaDayCode(rows) {
  const wet = rows.filter(r => r.pty > 0);
  if (wet.length) {
    const cnt = {}; wet.forEach(r => cnt[r.pty] = (cnt[r.pty] || 0) + 1);
    const pty = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || b - a)[0];
    return kmaWmo(1, pty, Math.max(...wet.map(r => r.mm || 0)));
  }
  const day = rows.filter(r => r.h >= 6 && r.h <= 20); const use = day.length ? day : rows;
  const cnt = {}; use.forEach(r => cnt[r.sky] = (cnt[r.sky] || 0) + 1);
  const sky = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || b - a)[0];
  return kmaWmo(sky, 0, 0);
}
function kmaDewPoint(t, rh) { if (!(rh > 0)) return null; const a = 17.62, b = 243.12, g = Math.log(rh / 100) + a * t / (b + t); return Math.round(b * g / (a - g) * 10) / 10; }

// f: Open-Meteo 응답(현지 시각 = KST). k = { pt, now, vil, mid }. 기상청 값으로 덮어쓰고 f.kma 를 붙입니다.
// 기상청 자료가 없거나 오래됐으면 아무것도 바꾸지 않고 null을 돌려줍니다 (→ Open-Meteo 그대로).
function kmaApply(f, k, nowMs) {
  if (!f || !f.current || !f.hourly || !f.daily || !k || !k.pt) return null;
  nowMs = nowMs || Date.now();
  const pt = k.pt, c = f.current, H = f.hourly, D = f.daily;
  const vil = k.vil && k.vil.h && nowMs - kmaTime(k.vil.base) <= KMA_VIL_MAX_MS ? k.vil : null;
  let obs = null, obsBase = null;
  if (k.now && Array.isArray(k.now.p) && k.now.n === pt.n) {
    const r = k.now.p[pt.i]; obsBase = r && (r[6] || k.now.base);
    if (r && typeof r[0] === "number" && nowMs - kmaTime(obsBase) <= KMA_NOW_MAX_MS) obs = r;
  }
  if (!vil && !obs) return null;
  // 실황이 75분 넘게 지났고 단기예보에 지금 시각이 있으면 예보 쪽이 더 맞음 (예: 18:44에 17시 실황을 '지금'으로 보이지 않게)
  if (obs && vil && nowMs - kmaTime(obsBase) > KMA_NOW_PREFER_MS) {
    const nowKey = new Date(nowMs + 9 * 3600e3).toISOString().slice(0, 13).replace(/[-T]/g, "");
    const t0 = kmaTime(vil.t0);
    if (vil.h.some(r => new Date(t0 + r[0] * 3600e3 + 9 * 3600e3).toISOString().slice(0, 13).replace(/[-T]/g, "") === nowKey)) obs = null;
  }
  // 단기예보 시간별 표: "YYYYMMDDHH" → {tmp, pop, sky, pty, mm, h}
  const hr = {};
  if (vil) {
    const t0 = kmaTime(vil.t0);
    vil.h.forEach(r => { const t = new Date(t0 + r[0] * 3600e3 + 9 * 3600e3); const key = t.toISOString().slice(0, 13).replace(/[-T]/g, "");
      hr[key] = { tmp: r[1], pop: r[2], sky: r[3], pty: r[4], mm: r[5], h: t.getUTCHours() }; });
  }
  const keyOf = iso => iso.slice(0, 13).replace(/[-T]/g, "");
  // 현재
  const ck = keyOf(c.time); const vh = hr[ck];
  const omT = c.temperature_2m;
  let desc = "";
  if (obs) {
    c.temperature_2m = obs[0];
    if (obs[1] != null) { c.relative_humidity_2m = obs[1]; const dp = kmaDewPoint(obs[0], obs[1]); if (dp != null) c.dew_point_2m = dp; }
    if (obs[4] != null) c.wind_speed_10m = obs[4];
    if (obs[5] != null) c.wind_direction_10m = obs[5];
    if (obs[3] != null) c.precipitation = obs[3];
    const sky = vh ? vh.sky : null, pty = obs[2] || 0;
    if (sky != null || pty > 0) { c.weather_code = kmaWmo(sky || 1, pty, obs[3] || 0); desc = kmaDesc(sky != null ? sky : (c.weather_code >= 3 ? 4 : 1), pty); }
  } else if (vh) {
    c.temperature_2m = vh.tmp; c.weather_code = kmaWmo(vh.sky, vh.pty, vh.mm); desc = kmaDesc(vh.sky, vh.pty);
  }
  const shift = (typeof omT === "number" && typeof c.temperature_2m === "number") ? c.temperature_2m - omT : 0;
  if (typeof c.apparent_temperature === "number") c.apparent_temperature = Math.round((c.apparent_temperature + shift) * 10) / 10;
  if (desc) c.kma_desc = desc;
  // 어제 같은 시각: 기상청 실황 24시간 전 값이 있으면 그것, 없으면 Open-Meteo 끼리의 차이를 유지
  let ydaySrc = "om";
  if (obs && k.now.yday && k.now.ydayBase && kmaTime(k.now.ydayBase) === kmaTime(obsBase) - 864e5 && typeof k.now.yday[pt.i] === "number") {
    f.yday = k.now.yday[pt.i]; ydaySrc = "kma";
  } else if (typeof f.yday === "number") f.yday = Math.round((f.yday + shift) * 10) / 10;
  // 시간별
  let nh = 0;
  H.time.forEach((t, i) => { const v = hr[keyOf(t)]; if (!v) return; nh++;
    if (v.tmp != null) H.temperature_2m[i] = v.tmp;
    if (v.pop != null && H.precipitation_probability) H.precipitation_probability[i] = v.pop;
    if (v.sky != null && H.weather_code) H.weather_code[i] = kmaWmo(v.sky, v.pty, v.mm); });
  // 일별: 단기예보(오늘~3일 뒤) → 중기예보(4일 뒤~)
  const mid = k.mid && nowMs - kmaTime(k.mid.tmFc) <= KMA_MID_MAX_MS ? k.mid : null;
  const land = mid && mid.land ? mid.land[pt.land] : null, ta = mid && mid.ta ? mid.ta[pt.ta] : null;
  const byDay = {};
  Object.keys(hr).forEach(key => { const d = key.slice(0, 4) + "-" + key.slice(4, 6) + "-" + key.slice(6, 8); (byDay[d] = byDay[d] || []).push(hr[key]); });
  const today = c.time.slice(0, 10);
  let nd = 0;
  D.time.forEach((d, j) => {
    const rows = byDay[d] || [], mm = vil && vil.d ? vil.d[d] : null;
    let used = false;
    if (rows.length >= (d === today ? 1 : 6)) {
      if (D.weather_code) D.weather_code[j] = kmaDayCode(rows);
      if (D.precipitation_probability_max) D.precipitation_probability_max[j] = Math.max(...rows.map(r => r.pop || 0));
      used = true;
    } else if (land && land[d]) {
      const [am, pm, ra, rp] = land[d]; const ca = kmaWfWmo(am), cp = kmaWfWmo(pm);
      const code = ca == null ? cp : cp == null ? ca : Math.max(ca, cp); // 코드가 클수록 궂은 날씨
      if (code != null && D.weather_code) D.weather_code[j] = code;
      if (D.precipitation_probability_max && (ra != null || rp != null)) D.precipitation_probability_max[j] = Math.max(ra || 0, rp || 0);
      used = true;
    }
    let mn = mm ? mm[0] : null, mx = mm ? mm[1] : null;
    if ((mn == null || mx == null) && ta && ta[d]) { if (mn == null) mn = ta[d][0]; if (mx == null) mx = ta[d][1]; }
    if (mn != null) { D.temperature_2m_min[j] = mn; used = true; }
    if (mx != null) { D.temperature_2m_max[j] = mx; used = true; }
    if (d === today && typeof c.temperature_2m === "number") { // 오늘 최고/최저가 현재 기온과 어긋나지 않게
      if (D.temperature_2m_max[j] < c.temperature_2m) D.temperature_2m_max[j] = Math.round(c.temperature_2m);
      if (D.temperature_2m_min[j] > c.temperature_2m) D.temperature_2m_min[j] = Math.floor(c.temperature_2m);
    }
    if (used) nd++;
  });
  f.kma = { name: pt.name, sido: pt.sido, km: pt.km, obsBase: obs ? obsBase : null, vilBase: vil ? vil.base : null, midTm: mid ? mid.tmFc : null, hours: nh, days: nd, yday: ydaySrc };
  return f.kma;
}
// "15시 실황" 같은 표시용
function kmaHourLabel(base) { return base ? Number(String(base).slice(8, 10)) + "시" : ""; }
/* KMA:END */


/* ---------------- 위치 ---------------- */
// 국내 현재 위치 이름: 브이월드(국토교통부) 역지오코딩 → '의정부시 민락동'(+ 자리가 되면 행정동 '송산3동'). 실패하거나 해외면 iOS 주소(reverseGeocode).
const VWORLD_KEY = "532F6A41-960A-47CD-ADAE-0AA007AD1C37"; // 서비스 URL https://rhffkwl.github.io/weather/ 용 키
/* VW:BEGIN — 브이월드 getAddress(type=both) 결과 → 위치 이름. 웹앱과 위젯에 같은 코드가 들어갑니다 (scripts/vw-label.js).
   지번(parcel): level4L = 법정동(예: 민락동, 한강로2가), level4A/level4AC = 행정동(예: 송산3동, 한강로동, 비어 있을 때도 있음)
   도로명(road): level3 = 법정동, level4L = 도로명, level4A = 행정동
   → { name: '의정부시 민락동'(시·구 + 법정동), hj: '송산3동'(법정동과 다를 때만), area: '경기도'(시도 [+ 시]) } */
function vwParse(list) {
  const rs = (list || []).filter(x => x && x.structure);
  const S = (x, k) => String((x && x.structure && x.structure[k]) || "").trim();
  const p = rs.find(x => x.type === "parcel" && S(x, "level4L")) || null;
  const rd = rs.find(x => x.type === "road") || null;
  const base = p || rd; if (!base) return null;
  const parts = S(base, "level2").split(/\s+/).filter(Boolean);
  const gu = parts[parts.length - 1] || (p ? S(p, "level3") : "");
  const bj = p ? S(p, "level4L") : S(rd, "level3");
  const hj0 = S(p, "level4A") || S(rd, "level4A");
  const dong = bj || hj0;
  const name = [gu, dong].filter(Boolean).join(" ");
  if (!name) return null;
  const hj = hj0 && hj0 !== dong ? hj0 : "";
  const area = [S(base, "level1"), parts.slice(0, -1).join(" ")].filter(Boolean).join(" ");
  return { name, hj, area };
}
/* VW:END */
// 위젯은 백그라운드라 기다려도 화면이 멈추지 않음: 날씨 받기와 동시에 진행하고, 1차 6초 → 1초 쉬고 2차 5초.
// (셀룰러·위젯 확장의 첫 연결은 DNS+TLS만 1~2초 걸릴 수 있어 웹앱의 3초/2초보다 넉넉하게)
const VW_TRY_SEC = [6, 5], VW_GAP_SEC = 1;
async function vworldName(lat, lon) {
  let last;
  for (let i = 0; i < VW_TRY_SEC.length; i++) {
    const sec = VW_TRY_SEC[i];
    if (i) await sleep(VW_GAP_SEC);
    try { return await vworldOnce(lat, lon, sec); }
    catch (e) { last = e; if (/NOT_FOUND|결과 없음/.test(e.message)) break; }
  }
  throw last;
}
async function vworldOnce(lat, lon, sec) {
  const req = new Request("https://api.vworld.kr/req/address?" + qs({ service: "address", request: "getAddress", version: "2.0", crs: "epsg:4326",
    point: lon.toFixed(6) + "," + lat.toFixed(6), type: "both", zipcode: "false", format: "json", errorFormat: "json", key: VWORLD_KEY,
    domain: "https://rhffkwl.github.io/weather/" }));
  req.timeoutInterval = sec;
  req.headers = { Referer: "https://rhffkwl.github.io/weather/" };
  const j = await req.loadJSON();
  const r = j && j.response;
  if (!r || r.status !== "OK") throw new Error("vworld " + (r ? r.status : "응답 없음"));
  const v = vwParse(r.result);
  if (!v) throw new Error("vworld 결과 없음");
  return v;
}
const FC_RANK = { PPLC: 6, PPLA: 5, PPLA2: 4, PPLA3: 3, PPLA4: 2, PPL: 1, ADM1: 1, ADM2: 1 };
async function geocode(q) {
  const variants = [q];
  if (/[가-힣]$/.test(q) && !/(시|군|구|도|읍|면|동|리)$/.test(q)) {
    ["시", "특별시", "광역시", "특별자치시", "특별자치도", "군"].forEach(s => variants.push(q + s));
  }
  let failures = 0;
  const lists = await Promise.all(variants.map(v =>
    getJSON("https://geocoding-api.open-meteo.com/v1/search?" + qs({ name: v, count: 10, language: "ko", format: "json" }))
      .then(j => (j && j.results) || [])
      .catch(() => { failures++; return []; })));
  if (failures === variants.length) throw new Error("인터넷 연결을 확인해 주세요 (지역 검색 실패)");
  const seen = {};
  let all = [];
  lists.forEach(l => l.forEach(r => { if (!seen[r.id]) { seen[r.id] = 1; all.push(r); } }));
  const kr = all.filter(r => r.country_code === "KR");
  if (kr.length) all = kr;
  const places = all.filter(r => /^(PPL|ADM)/.test(r.feature_code || ""));
  if (places.length) all = places;
  const isPPL = r => /^PPL/.test(r.feature_code || "") ? 1 : 0;
  all.sort((a, b) => (isPPL(b) - isPPL(a)) || ((b.population || 0) - (a.population || 0)) ||
    ((FC_RANK[b.feature_code] || 0) - (FC_RANK[a.feature_code] || 0)));
  const r = all[0];
  if (!r) return null;
  return { name: q, fullName: r.name, admin1: r.admin1 || "", lat: r.latitude, lon: r.longitude };
}

// 이름 찾기: 국내는 브이월드와 iOS 주소를 동시에 물어 브이월드를 우선. 브이월드 이름은 약관상 저장하지 않으므로
// 캐시 파일에는 iOS 이름(iosName)만 남깁니다.
async function resolveName(lat, lon) {
  const ios = withTimeout(Location.reverseGeocode(lat, lon, "ko_KR"), 8, "iOS 주소")
    .then(rg => { const a = rg && rg[0]; return a ? (a.subLocality || a.locality || a.administrativeArea || null) : null; })
    .catch(() => null);
  let vw = null, vwErr = "";
  if (kmaInKorea(lat, lon)) {
    try { vw = await withTimeout(vworldName(lat, lon), 13, "브이월드"); } catch (e) { vwErr = e.message; }
  }
  const iosName = await ios;
  const out = vw ? { name: vw.name, hj: vw.hj, nameSrc: "vworld", iosName } : iosName ? { name: iosName, nameSrc: "ios", iosName } : { name: "현재 위치", nameSrc: "", iosName: null };
  out.vwErr = vwErr;
  return out;
}
async function resolveLocation(cache) {
  if (PARAM) {
    const m = PARAM.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return { name: "지정 위치", lat: +m[1], lon: +m[2], source: "param" };
    const geoPath = fm.joinPath(DIR, "geo-" + hashStr(PARAM) + ".json");
    const saved = readJSON(geoPath);
    if (saved && saved.q === PARAM && saved.loc) return Object.assign({}, saved.loc, { source: "param" });
    const r = await geocode(PARAM);
    if (!r) throw new NotFoundError(`'${PARAM}' 위치를 찾을 수 없어요`);
    writeJSON(geoPath, { q: PARAM, loc: r });
    return Object.assign({}, r, { source: "param" });
  }
  try {
    Location.setAccuracyToHundredMeters(); // 동 이름까지 맞추려면 3km 정확도로는 옆 동이 나올 수 있음
    const l = await withTimeout(Location.current(), CONFIG.locationTimeout, "위치");
    if (!l || !isNum(l.latitude)) throw new Error("위치 없음");
    const loc = { name: "현재 위치", nameSrc: "", lat: l.latitude, lon: l.longitude, source: "gps" };
    loc.namePromise = resolveName(loc.lat, loc.lon); // 날씨 받는 동안 함께 진행
    return loc;
  } catch (e) {
    if (cache && cache.loc && /^gps/.test(cache.loc.source)) return Object.assign({}, cache.loc, { source: "gps-cached" }); // 캐시엔 iOS 이름만 있음
    return Object.assign({}, CONFIG.fallback, { source: "fallback" });
  }
}

/* ---------------- 데이터 ---------------- */
// 기상청: 대표 격자점 표 → 가장 가까운 점(25km 이내)의 단기예보 파일. 국외면 바로 null (Open-Meteo만 사용).
async function fetchKma(loc) {
  if (!kmaInKorea(loc.lat, loc.lon)) return null;
  const B = CONFIG.kmaBaseURL, t = "?t=" + Math.floor(Date.now() / 300000);
  const [pts, now, mid] = await Promise.all([getJSON(B + "points.json?d=" + Math.floor(Date.now() / 864e5)),
    getJSON(B + "now.json" + t).catch(() => null), getJSON(B + "mid.json" + t).catch(() => null)]);
  const pt = kmaNearest(pts, loc.lat, loc.lon);
  if (!pt) return null;
  let vil = null;
  for (const q of [pt].concat(pt.alts)) { vil = await getJSON(B + "f/" + q.nx + "_" + q.ny + ".json" + t).catch(() => null); if (vil) break; }
  return { pt, now, vil, mid };
}
async function fetchWeather(loc) {
  const base = { latitude: loc.lat.toFixed(4), longitude: loc.lon.toFixed(4), timezone: TZ };
  const fcURL = "https://api.open-meteo.com/v1/forecast?" + qs(Object.assign({}, base, {
    current: "temperature_2m,apparent_temperature,is_day,weather_code,precipitation",
    hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: 6,
    past_days: 1, // 어제 같은 시각 기온 비교용
  }));
  const aqURL = "https://air-quality-api.open-meteo.com/v1/air-quality?" + qs(Object.assign({}, base, { current: "pm10,pm2_5" }));
  const akURL = CONFIG.airKoreaURL + "?t=" + Math.floor(Date.now() / 300000);
  const [fc, aq, ak, km] = await Promise.all([getJSON(fcURL), getJSON(aqURL).catch(() => null),
    getJSON(akURL).then(doc => akNearest(doc, loc.lat, loc.lon)).catch(() => null), fetchKma(loc).catch(() => null)]);
  if (!fc || !fc.current || !fc.hourly || !fc.daily) throw new Error("예보 데이터가 비어 있어요");
  if (km) { try { kmaApply(fc, km); } catch (e) { console.log("KMA merge failed: " + e); } }
  return { fc, aq, ak };
}

const DOW = ["일", "월", "화", "수", "목", "금", "토"];
function dowLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function buildModel(raw, offline) {
  const { loc, fc, aq, ak, fetchedAt } = raw;
  const c = fc.current, h = fc.hourly, d = fc.daily;
  const nowISO = seoulISO(Date.now());
  const nowHour = nowISO.slice(0, 13);
  let idx = h.time.findIndex(t => t.slice(0, 13) >= nowHour);
  if (idx < 0) idx = h.time.length - 1;
  const hours = [];
  for (let i = idx + 1; i < h.time.length && hours.length < 6; i++) {
    hours.push({
      label: Number(h.time[i].slice(11, 13)) + "시",
      temp: h.temperature_2m[i], code: h.weather_code[i],
      isDay: h.is_day ? h.is_day[i] === 1 : true,
      pop: h.precipitation_probability ? h.precipitation_probability[i] : null,
    });
  }
  let di = d.time.indexOf(nowISO.slice(0, 10));
  if (di < 0) di = 0;
  const days = [];
  for (let i = di; i < d.time.length && days.length < 5; i++) {
    days.push({
      label: i === di ? "오늘" : dowLabel(d.time[i]),
      code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i],
      pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
    });
  }
  const aqc = aq && aq.current ? aq.current : {};
  const isDay = c.is_day === 1;
  const yi = h.time.findIndex(t => t.slice(0, 13) === seoulISO(Date.now() - 86400000).slice(0, 13));
  const yday = yi >= 0 ? yesterdayCompare(c.temperature_2m, h.temperature_2m[yi]) : null;
  return {
    place: loc.name, place2: loc.hj || "", source: loc.source,
    temp: c.temperature_2m, feels: c.apparent_temperature, yday,
    code: c.weather_code, isDay, info: Object.assign(weatherInfo(c.weather_code, isDay), c.kma_desc ? { text: c.kma_desc } : {}),
    wxSource: fc.kma ? "kma" : "om",
    max: days[0] ? days[0].max : null, min: days[0] ? days[0].min : null,
    popNow: h.precipitation_probability ? h.precipitation_probability[Math.max(idx, 0)] : null,
    popDay: days[0] ? days[0].pop : null,
    hours, days,
    pm10: pmPick(ak && ak.pm10, aqc.pm10, "pm10"), pm25: pmPick(ak && ak.pm25, aqc.pm2_5, "pm25"),
    fetchedAt, offline,
  };
}

// 어제 같은 시각과 비교: |차이| < 1° → 비슷. 색은 흰 글씨 대비 4.5:1 이상인 배지 색.
function yesterdayCompare(now, prev) {
  if (!isNum(now) || !isNum(prev)) return null;
  const diff = now - prev, n = Math.round(Math.abs(diff));
  if (Math.abs(diff) < 1 || n === 0) return { dir: 0, text: "어제와 비슷", color: "#5F6B7A" };
  return diff > 0 ? { dir: 1, text: `어제보다 ${n}° 높음`, color: "#C2410C" } : { dir: -1, text: `어제보다 ${n}° 낮음`, color: "#1D4ED8" };
}
function ydayPill(stack, m, size) {
  if (!m.yday) return null;
  const y = m.yday;
  return pill(stack, y.dir ? `${y.dir > 0 ? "▲" : "▼"} ${y.text}` : y.text, y.color, size);
}

// 실측(에어코리아) 우선, 오래됐거나(>3h) 없으면 Open-Meteo 예측값
function pmPick(a, model, kind) {
  if (akFresh(a, Date.now()) && isNum(a.v)) return Object.assign(pmLevel(a.v, kind, "ak"), { station: a.name, hour: akHour(a) });
  return pmLevel(model, kind, "model");
}
function airSourceLabel(m) {
  const a = (m.pm25 && m.pm25.src === "ak") ? m.pm25 : (m.pm10 && m.pm10.src === "ak") ? m.pm10 : null;
  if (a) return `측정소 ${a.station} · ${a.hour} 기준 · 에어코리아`;
  return (m.pm10 || m.pm25) ? "예측값 · Open-Meteo 대기질 모델" : "";
}
function updatedLabel(m) {
  const p = seoulParts(m.fetchedAt), n = seoulParts(Date.now());
  const same = p.y === n.y && p.mo === n.mo && p.d === n.d;
  const t = (same ? "" : `${p.mo}/${p.d} `) + `${pad(p.h)}:${pad(p.mi)}`;
  return m.offline ? `오프라인 · ${t}` : `${t} 업데이트`;
}

/* ---------------- 스타일 ---------------- */
const WHITE = Color.white();
const SUB = new Color("#FFFFFF", 0.78);
const FAINT = new Color("#FFFFFF", 0.55);
const RAIN = new Color("#9AD8FF");

function dyn(light, dark) { return Color.dynamic(new Color(light), new Color(dark)); }
function background(m) {
  const k = m.info.kind;
  let p;
  if (k === "storm") p = ["#4A4E69", "#22223B", "#2B2D42", "#121220"];
  else if (k === "rain") p = m.isDay ? ["#5B7493", "#2E4561", "#2A3646", "#121A25"] : ["#2B3647", "#121A26", "#1B2330", "#0A0F17"];
  else if (k === "snow") p = m.isDay ? ["#9DB2CB", "#62799A", "#3E4A5A", "#1F2732"] : ["#3A4659", "#1A2231", "#262E3B", "#0E131C"];
  else if (!m.isDay) p = k === "cloud" ? ["#2E3748", "#141A26", "#1C2230", "#090D15"] : ["#1B2A4E", "#0A1128", "#111A33", "#04070F"];
  else if (k === "cloud") p = ["#7E95B0", "#4E6685", "#384556", "#1D2633"];
  else p = ["#4BA3F2", "#1B6CD1", "#1D3E6E", "#0D213F"];
  const g = new LinearGradient();
  g.colors = [dyn(p[0], p[2]), dyn(p[1], p[3])];
  g.locations = [0, 1];
  return g;
}

/* ---------------- 날씨 배경 그림 (DrawContext) ----------------
   그라데이션(위 background()와 같은 색) + 상태별 장면: 맑은 낮 햇무리, 맑은 밤 별, 구름 많음/흐림 부드러운 구름,
   비 빗줄기, 눈 눈송이, 안개 옅은 띠, 뇌우 어두운 구름. 아래쪽은 살짝 어둡게 해서 흰 글자가 잘 보이게. */
const FAMILY_PT = { small: [170, 170], medium: [364, 170], large: [364, 382], extraLarge: [780, 382] };
function hexRGB(h) { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbHex(r, g, b) { return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
function mixHex(a, b, t) { const A = hexRGB(a), B = hexRGB(b); return rgbHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
function skyScene(code, isDay) {
  const c = Number(code);
  if (c >= 95) return "storm";
  if (c === 45 || c === 48) return "fog";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 51) return "rain";
  if (c === 3) return isDay ? "overcast-day" : "overcast-night";
  if (c === 2) return isDay ? "cloudy-day" : "cloudy-night";
  return isDay ? "clear-day" : "clear-night";
}
const SKY = { // [위, 아래]
  "clear-day": ["#3E95EC", "#1F63BF"], "clear-night": ["#16234A", "#070C1E"],
  "cloudy-day": ["#5C8DC4", "#33598C"], "cloudy-night": ["#222E48", "#0C1222"],
  "overcast-day": ["#71859E", "#465870"], "overcast-night": ["#283140", "#10151F"],
  rain: ["#4D5F78", "#232F40"], snow: ["#7F93AE", "#506580"], fog: ["#7C8794", "#535E6B"], storm: ["#353A52", "#14162A"],
};
function softCloud(ctx, cx, cy, w, alpha, hex) {
  // 겹친 타원 + 가장자리를 여러 겹 옅게(깃털처럼) → 테두리 없는 부드러운 구름
  const parts = [[0, 0.06, 0.62, 0.34], [-0.3, 0.12, 0.46, 0.26], [0.3, 0.1, 0.5, 0.28], [-0.06, -0.06, 0.44, 0.32], [0.16, -0.02, 0.36, 0.26]];
  const L = 7;
  for (let j = 0; j < L; j++) {
    const k = 1.5 - j * 0.09; ctx.setFillColor(new Color(hex, alpha / L * (0.6 + j * 0.15)));
    for (const [dx, dy, rw, rh] of parts) { const ew = w * rw * k, eh = w * rh * k; ctx.fillEllipse(new Rect(cx + dx * w - ew / 2, cy + dy * w - eh / 2, ew, eh)); }
  }
}
function backgroundImage(m, family) {
  const pt = FAMILY_PT[family] || FAMILY_PT.medium, S = 2, W = pt[0] * S, H = pt[1] * S;
  const scene = skyScene(m.code, m.isDay), col = SKY[scene], rnd = rng(W * 31 + H + scene.length * 7);
  const ctx = new DrawContext(); ctx.size = new Size(W, H); ctx.opaque = true; ctx.respectScreenScale = false;
  const N = 40;
  for (let i = 0; i < N; i++) { ctx.setFillColor(new Color(mixHex(col[0], col[1], i / (N - 1)))); const y = Math.floor(i * H / N), y2 = Math.min(H, Math.floor((i + 1) * H / N) + 1); ctx.fillRect(new Rect(0, y, W, y2 - y)); }
  const night = /night/.test(scene) || (!m.isDay && /rain|snow|fog|storm/.test(scene));
  if (scene === "clear-day" || scene === "cloudy-day") { // 오른쪽 위 햇무리
    for (let i = 6; i >= 1; i--) { const r = H * 0.16 * i; ctx.setFillColor(new Color("#FFF4C2", 0.035)); ctx.fillEllipse(new Rect(W * 0.86 - r, -H * 0.12 - r, r * 2, r * 2)); }
  }
  if (scene === "clear-night" || scene === "cloudy-night") { // 별
    const n = scene === "clear-night" ? Math.round(W * H / 9000) : Math.round(W * H / 22000);
    for (let i = 0; i < n; i++) { const x = rnd() * W, y = Math.pow(rnd(), 1.4) * H * 0.8, r = (rnd() < 0.15 ? 2.6 : 1.5) * S * 0.6;
      ctx.setFillColor(new Color("#FFFFFF", 0.25 + rnd() * 0.5)); ctx.fillEllipse(new Rect(x - r / 2, y - r / 2, r, r)); }
  }
  const cloudy = { "cloudy-day": [3, 0.10], "cloudy-night": [3, 0.07], "overcast-day": [5, 0.12], "overcast-night": [5, 0.07], rain: [5, 0.08], snow: [4, 0.12], fog: [0, 0], storm: [5, 0.07] }[scene];
  if (cloudy && cloudy[0]) {
    const hex = scene === "storm" ? "#9AA3C0" : night ? "#C9D3E6" : "#FFFFFF";
    const big = family === "small" ? 1.5 : family === "medium" ? 0.8 : 1;
    for (let i = 0; i < cloudy[0]; i++) softCloud(ctx, W * (-0.05 + 1.1 * ((i * 0.41 + rnd() * 0.2) % 1)), Math.min(W, H) * (0.06 + rnd() * 0.22), W * (0.34 + rnd() * 0.2) * big, cloudy[1], hex);
  }
  if (scene === "rain" || scene === "storm") { // 빗줄기 (비스듬한 가는 선)
    const n = Math.round(W * H / 5200);
    ctx.setStrokeColor(new Color("#CFE3FF", 0.16)); ctx.setLineWidth(1.4 * S * 0.6);
    const p = new Path();
    for (let i = 0; i < n; i++) { const x = rnd() * W * 1.1, y = rnd() * H, L = (10 + rnd() * 14) * S * 0.6; p.move(new Point(x, y)); p.addLine(new Point(x - L * 0.28, y + L)); }
    ctx.addPath(p); ctx.strokePath();
  }
  if (scene === "snow") {
    const n = Math.round(W * H / 4200);
    for (let i = 0; i < n; i++) { const x = rnd() * W, y = rnd() * H, r = (1.4 + rnd() * 2.2) * S * 0.6; ctx.setFillColor(new Color("#FFFFFF", 0.25 + rnd() * 0.35)); ctx.fillEllipse(new Rect(x - r, y - r, r * 2, r * 2)); }
  }
  if (scene === "fog") {
    for (let i = 0; i < 7; i++) { const y = H * (0.15 + i * 0.12), w = W * (0.7 + rnd() * 0.6), h = H * 0.07; ctx.setFillColor(new Color("#E6ECF2", 0.07 + rnd() * 0.05)); ctx.fillEllipse(new Rect(rnd() * W * 0.5 - w * 0.3, y, w, h)); }
  }
  for (let i = 0; i < 12; i++) { const y = Math.floor(H * (0.55 + i * 0.0375)), y2 = i === 11 ? H : Math.floor(H * (0.55 + (i + 1) * 0.0375)); ctx.setFillColor(new Color("#000000", 0.012 * (i + 1))); ctx.fillRect(new Rect(0, y, W, y2 - y)); }
  return ctx.getImage();
}

/* ---------------- 날씨 아이콘 (웹앱과 같은 색 이모지) ----------------
   Scriptable의 SF Symbol은 한 가지 색(tintColor)만 돼서, 웹앱과 같은 이모지를 같은 크기의 그림으로 그려 넣습니다.
   안개는 iOS 이모지가 흐릿한 회색 네모라 웹앱처럼 직접 그림. 잠금화면 위젯은 시스템이 단색으로 칠하므로 SF Symbol 유지. */
const WMO_EMOJI = { 0: ["☀️", "🌙"], 1: ["🌤️", "🌙"], 2: ["⛅", "☁️"], 3: ["☁️"], 45: ["FOG"], 48: ["FOG"],
  51: ["🌦️", "🌧️"], 53: ["🌦️", "🌧️"], 55: ["🌧️"], 56: ["🌧️"], 57: ["🌧️"], 61: ["🌦️", "🌧️"], 63: ["🌧️"], 65: ["🌧️"], 66: ["🌧️"], 67: ["🌧️"],
  71: ["🌨️"], 73: ["🌨️"], 75: ["❄️"], 77: ["🌨️"], 80: ["🌦️", "🌧️"], 81: ["🌧️"], 82: ["⛈️"], 85: ["🌨️"], 86: ["❄️"], 95: ["⛈️"], 96: ["⛈️"], 99: ["⛈️"] };
function wxEmoji(code, isDay) { const e = WMO_EMOJI[Number(code)]; if (!e) return "☁️"; return (!isDay && e[1]) ? e[1] : e[0]; }
const ICON_CACHE = {};
function iconImage(code, isDay, size) {
  const e = wxEmoji(code, isDay), key = e + "@" + size;
  if (ICON_CACHE[key]) return ICON_CACHE[key];
  const S = 3, P = size * S, ctx = new DrawContext();
  ctx.size = new Size(P, P); ctx.opaque = false; ctx.respectScreenScale = false;
  if (e === "FOG") {
    ctx.setFillColor(new Color("#E3E9F1"));
    for (const [x, y, w, h] of [[0.16, 0.2, 0.42, 0.36], [0.36, 0.1, 0.46, 0.46], [0.6, 0.24, 0.3, 0.3], [0.2, 0.32, 0.66, 0.24]]) ctx.fillEllipse(new Rect(x * P, y * P, w * P, h * P));
    ctx.setFillColor(new Color("#8A97A8"));
    for (const [x, y, w] of [[0.1, 0.64, 0.62], [0.26, 0.77, 0.64], [0.14, 0.9, 0.5]]) { const p = new Path(); p.addRoundedRect(new Rect(x * P, y * P - 0.04 * P, w * P, 0.08 * P), 0.04 * P, 0.04 * P); ctx.addPath(p); ctx.fillPath(); }
  } else {
    const f = P * 0.8; ctx.setFont(Font.systemFont(f)); ctx.setTextAlignedCenter();
    ctx.drawTextInRect(e, new Rect(0, (P - f * 1.22) / 2, P, f * 1.22));
  }
  return (ICON_CACHE[key] = ctx.getImage());
}

function addText(stack, str, font, color, align) {
  const t = stack.addText(String(str));
  t.font = font;
  t.textColor = color || WHITE;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  if (align === "right") t.rightAlignText();
  else if (align === "center") t.centerAlignText();
  return t;
}
function addSymbol(stack, name, size, color) {
  const s = SFSymbol.named(name) || SFSymbol.named("cloud.fill");
  s.applyFont(Font.systemFont(size));
  const img = stack.addImage(s.image);
  img.imageSize = new Size(size, size);
  img.tintColor = color || WHITE;
  return img;
}
function weatherIcon(stack, code, isDay, size) {
  const info = weatherInfo(code, isDay);
  if (/^accessory/.test(FAMILY)) return addSymbol(stack, info.symbol, size, WHITE);
  try { const img = stack.addImage(iconImage(code, isDay, size)); img.imageSize = new Size(size, size); return img; }
  catch (e) { return addSymbol(stack, info.symbol, size, new Color(ICON_TINT[info.kind] || "#FFFFFF")); }
}
function pill(stack, text, hex, size) {
  const p = stack.addStack();
  p.backgroundColor = new Color(hex, 0.92);
  p.cornerRadius = size;
  p.setPadding(2, 6, 2, 6);
  p.centerAlignContent();
  addText(p, text, Font.semiboldSystemFont(size), WHITE);
  return p;
}
function pm25Pill(stack, m, size) {
  if (m.pm25) return pill(stack, `초미세 ${m.pm25.label}`, m.pm25.color, size);
  return pill(stack, "초미세 -", "#8E8E93", size);
}
// 글자 폭 어림(넉넉하게): 한글 1.0em, 숫자 0.62em, 공백 0.3em, 기타 0.6em
function estW(str, size) { let w = 0; for (const ch of String(str)) w += /[가-힣]/.test(ch) ? size : /[0-9]/.test(ch) ? size * 0.62 : ch === " " ? size * 0.3 : size * 0.6; return w; }
// 이름 한 줄: '의정부시 민락동' + (가장 작은 아이폰 기준으로 잘리지 않을 때만) 작고 흐린 ' · 송산3동'
function placeRow(stack, m, size, avail) {
  const r = stack.addStack();
  r.centerAlignContent();
  const gps = /^gps/.test(m.source);
  if (gps) { addSymbol(r, "location.fill", size - 3, WHITE); r.addSpacer(3); }
  addText(r, m.place, Font.semiboldSystemFont(size), WHITE);
  if (m.place2 && avail) {
    const extra = " · " + m.place2, used = (gps ? size : 0) + estW(m.place, size) + estW(extra, size - 3);
    if (used <= avail * 0.92) { const t = addText(r, extra, Font.systemFont(size - 3), SUB); t.minimumScaleFactor = 1; }
  }
  return r;
}
function hourlyRow(stack, m, opts) {
  const row = stack.addStack();
  row.layoutHorizontally();
  const list = m.hours.length ? m.hours : [];
  list.forEach((h, i) => {
    if (i > 0) row.addSpacer();
    const col = row.addStack();
    col.layoutVertically();
    col.centerAlignContent();
    const c1 = col.addStack(); c1.addSpacer(); addText(c1, h.label, Font.mediumSystemFont(opts.font - 1), SUB); c1.addSpacer();
    col.addSpacer(3);
    const c2 = col.addStack(); c2.addSpacer(); weatherIcon(c2, h.code, h.isDay, opts.icon); c2.addSpacer();
    col.addSpacer(3);
    const c3 = col.addStack(); c3.addSpacer(); addText(c3, tempStr(h.temp), Font.semiboldSystemFont(opts.font + 1), WHITE); c3.addSpacer();
    const c4 = col.addStack(); c4.addSpacer();
    addText(c4, isNum(h.pop) && h.pop > 0 ? pctStr(h.pop) : " ", Font.mediumSystemFont(opts.font - 2), RAIN); c4.addSpacer();
  });
  if (!list.length) addText(row, "시간별 예보 없음", Font.systemFont(opts.font), SUB);
  return row;
}

/* ---------------- 레이아웃 ---------------- */
// 소형/중형은 가장 작은 아이폰(소형 141pt, 중형 292x141pt) 기준으로 고정 폭을 써서 잘림을 막습니다.
function fixedBox(stack, w, h) { const b = stack.addStack(); b.size = new Size(w, h); b.centerAlignContent(); return b; }
function centerText(stack, w, h, str, font, color) { const b = fixedBox(stack, w, h); b.addSpacer(); const t = addText(b, str, font, color, "center"); b.addSpacer(); return t; }

function smallWidget(w, m) {
  w.setPadding(12, 12, 12, 12);
  const top = w.addStack(); top.centerAlignContent();
  placeRow(top, m, 12, 141 - 24);
  top.addSpacer();
  w.addSpacer(2);
  const row = w.addStack(); row.centerAlignContent();
  addText(row, tempStr(m.temp), Font.boldSystemFont(34), WHITE);
  row.addSpacer();
  weatherIcon(row, m.code, m.isDay, 26);
  addText(w, m.info.text, Font.mediumSystemFont(12), WHITE);
  addText(w, `최고 ${tempStr(m.max)} · 최저 ${tempStr(m.min)}`, Font.systemFont(10), SUB);
  if (m.yday) { w.addSpacer(4); const y = w.addStack(); ydayPill(y, m, 9); y.addSpacer(); }
  w.addSpacer();
  const bot = w.addStack(); bot.centerAlignContent();
  pm25Pill(bot, m, 9);
  bot.addSpacer(4);
  bot.addSpacer();
  addText(bot, updatedLabel(m).replace(" 업데이트", ""), Font.systemFont(8), FAINT);
}

const MED = { left: 96, gap: 8, right: 160, cols: 5 };
function mediumHourly(stack, m) {
  const cw = Math.floor(MED.right / MED.cols);
  const row = stack.addStack(); row.layoutHorizontally(); row.size = new Size(MED.right, 0);
  const list = m.hours.slice(0, MED.cols);
  if (!list.length) { addText(row, "시간별 예보 없음", Font.systemFont(10), SUB); return row; }
  list.forEach(h => {
    const col = row.addStack(); col.layoutVertically(); col.size = new Size(cw, 0);
    centerText(col, cw, 13, h.label, Font.mediumSystemFont(10), SUB);
    col.addSpacer(2);
    const ic = fixedBox(col, cw, 18); ic.addSpacer(); weatherIcon(ic, h.code, h.isDay, 17); ic.addSpacer();
    col.addSpacer(2);
    centerText(col, cw, 15, tempStr(h.temp), Font.semiboldSystemFont(12), WHITE);
    centerText(col, cw, 10, isNum(h.pop) && h.pop > 0 ? pctStr(h.pop) : " ", Font.mediumSystemFont(8), RAIN);
  });
  return row;
}
function mediumWidget(w, m) {
  w.setPadding(12, 14, 12, 12);
  const main = w.addStack(); main.layoutHorizontally();
  const left = main.addStack(); left.layoutVertically(); left.size = new Size(MED.left, 0);
  placeRow(left, m, 12, MED.left);
  left.addSpacer(1);
  const tr = left.addStack(); tr.centerAlignContent(); tr.size = new Size(MED.left, 34);
  addText(tr, tempStr(m.temp), Font.boldSystemFont(28), WHITE);
  tr.addSpacer(4);
  weatherIcon(tr, m.code, m.isDay, 20);
  tr.addSpacer();
  addText(left, m.info.text, Font.mediumSystemFont(11), WHITE);
  addText(left, `최고 ${tempStr(m.max)} · 최저 ${tempStr(m.min)}`, Font.systemFont(10), SUB);
  addText(left, `체감 ${tempStr(m.feels)} · 강수 ${pctStr(isNum(m.popNow) ? m.popNow : m.popDay)}`, Font.systemFont(10), SUB);
  left.addSpacer();
  const pr = left.addStack(); pr.size = new Size(MED.left, 16); pr.centerAlignContent();
  pm25Pill(pr, m, 9); pr.addSpacer();

  main.addSpacer(MED.gap);
  const right = main.addStack(); right.layoutVertically(); right.size = new Size(MED.right, 0);
  const hdr = right.addStack(); hdr.centerAlignContent(); hdr.size = new Size(MED.right, 13);
  addText(hdr, "시간별 예보", Font.semiboldSystemFont(10), SUB);
  hdr.addSpacer();
  addText(hdr, updatedLabel(m), Font.systemFont(9), FAINT, "right");
  right.addSpacer(6);
  mediumHourly(right, m);
  right.addSpacer();
  if (m.yday) { const y = right.addStack(); y.size = new Size(MED.right, 15); y.centerAlignContent(); ydayPill(y, m, 9); y.addSpacer(); right.addSpacer(2); }
  const src = airSourceLabel(m);
  if (src) { const f = right.addStack(); f.size = new Size(MED.right, 11); addText(f, src, Font.systemFont(8), FAINT); f.addSpacer(); }
}

// 웹앱과 같은 색: 전체 기간 최저(#5AB0FF) → 중간(#FFD04D) → 최고(#FF8A3D). 막대 색은 온도 위치에 따라 정해집니다.
const BAR_STOPS = [[0, [0x5A, 0xB0, 0xFF]], [0.5, [0xFF, 0xD0, 0x4D]], [1, [0xFF, 0x8A, 0x3D]]];
function barColorAt(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < BAR_STOPS.length; i++) {
    const [t1, c1] = BAR_STOPS[i], [t0, c0] = BAR_STOPS[i - 1];
    if (t <= t1) { const k = (t - t0) / (t1 - t0); return "#" + c0.map((v, j) => Math.round(v + (c1[j] - v) * k).toString(16).padStart(2, "0")).join(""); }
  }
  return "#FF8A3D";
}
function tempBarImage(d, lo, hi, width, height) {
  const S = 3, W = width * S, H = height * S, r = H / 2;
  const ctx = new DrawContext();
  ctx.size = new Size(W, H); ctx.opaque = false; ctx.respectScreenScale = false;
  const track = new Path(); track.addRoundedRect(new Rect(0, 0, W, H), r, r);
  ctx.addPath(track); ctx.setFillColor(new Color("#FFFFFF", 0.22)); ctx.fillPath();
  if (isNum(d.min) && isNum(d.max) && hi > lo) {
    let x0 = (d.min - lo) / (hi - lo) * W, x1 = (d.max - lo) / (hi - lo) * W;
    if (x1 - x0 < H) { const mid = (x0 + x1) / 2; x0 = Math.max(0, mid - H / 2); x1 = Math.min(W, x0 + H); x0 = x1 - H; }
    // 1px 세로 띠로 그라데이션을 그리고, 양 끝은 반원 모양으로 높이를 줄여 둥글게 만듭니다.
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = x + 0.5;
      const edge = Math.min(cx - x0, x1 - cx);
      let hh = H;
      if (edge < r) { const dx = r - Math.max(0, edge); hh = 2 * Math.sqrt(Math.max(0, r * r - dx * dx)); }
      if (hh <= 0.2) continue;
      ctx.setFillColor(new Color(barColorAt(cx / W), 1));
      ctx.fillRect(new Rect(x, (H - hh) / 2, 1, hh));
    }
  }
  return ctx.getImage();
}
function tempBar(stack, d, lo, hi, width) {
  const img = stack.addImage(tempBarImage(d, lo, hi, width, 5));
  img.imageSize = new Size(width, 5);
  return img;
}

function airBlock(stack, title, sub, lvl) {
  const s = stack.addStack(); s.layoutVertically();
  const t = s.addStack(); t.centerAlignContent();
  addText(t, title, Font.semiboldSystemFont(11), WHITE);
  t.addSpacer(3);
  addText(t, sub, Font.systemFont(9), FAINT);
  s.addSpacer(3);
  const v = s.addStack(); v.centerAlignContent();
  if (lvl) {
    pill(v, lvl.label, lvl.color, 10);
    v.addSpacer(5);
    addText(v, `${lvl.value}㎍/㎥`, Font.mediumSystemFont(11), SUB);
  } else {
    addText(v, "정보 없음", Font.systemFont(11), SUB);
  }
  return s;
}

function largeWidget(w, m) {
  w.setPadding(16, 16, 14, 16);
  const hdr = w.addStack(); hdr.centerAlignContent();
  placeRow(hdr, m, 15, 329 - 32 - estW(updatedLabel(m), 10) - 8);
  hdr.addSpacer();
  addText(hdr, updatedLabel(m), Font.systemFont(10), FAINT);
  w.addSpacer(6);

  const cur = w.addStack(); cur.centerAlignContent();
  weatherIcon(cur, m.code, m.isDay, 42);
  cur.addSpacer(10);
  addText(cur, tempStr(m.temp), Font.boldSystemFont(46), WHITE);
  cur.addSpacer();
  const info = cur.addStack(); info.layoutVertically();
  const lines = [
    [m.info.text, Font.semiboldSystemFont(14), WHITE],
    [`최고 ${tempStr(m.max)} · 최저 ${tempStr(m.min)}`, Font.systemFont(11), SUB],
    [`체감 ${tempStr(m.feels)} · 강수 ${pctStr(isNum(m.popNow) ? m.popNow : m.popDay)}`, Font.systemFont(11), SUB],
  ];
  lines.forEach(([s, f, c]) => { const r = info.addStack(); r.addSpacer(); addText(r, s, f, c, "right"); });
  if (m.yday) { info.addSpacer(2); const r = info.addStack(); r.addSpacer(); ydayPill(r, m, 10); }

  w.addSpacer();
  hourlyRow(w, m, { font: 11, icon: 18 });
  w.addSpacer();

  const air = w.addStack(); air.layoutHorizontally();
  airBlock(air, "미세먼지", "PM10", m.pm10);
  air.addSpacer();
  airBlock(air, "초미세먼지", "PM2.5", m.pm25);
  air.addSpacer();
  const src = airSourceLabel(m);
  if (src) { w.addSpacer(3); addText(w, src, Font.systemFont(9), FAINT); }
  w.addSpacer();

  const valid = m.days.filter(d => isNum(d.min) && isNum(d.max));
  const lo = valid.length ? Math.min(...valid.map(d => d.min)) : 0;
  const hi = valid.length ? Math.max(...valid.map(d => d.max)) : 1;
  m.days.forEach((d, i) => {
    if (i > 0) w.addSpacer(4);
    const r = w.addStack(); r.centerAlignContent();
    const l = r.addStack(); l.size = new Size(34, 18); l.centerAlignContent();
    addText(l, d.label, Font.semiboldSystemFont(12), WHITE); l.addSpacer();
    const ic = r.addStack(); ic.size = new Size(24, 18); ic.centerAlignContent();
    weatherIcon(ic, d.code, true, 16);
    const pp = r.addStack(); pp.size = new Size(38, 18); pp.centerAlignContent();
    addText(pp, isNum(d.pop) && d.pop > 0 ? pctStr(d.pop) : "", Font.mediumSystemFont(10), RAIN); pp.addSpacer();
    r.addSpacer();
    const mn = r.addStack(); mn.size = new Size(32, 18); mn.centerAlignContent(); mn.addSpacer();
    addText(mn, tempStr(d.min), Font.mediumSystemFont(12), SUB);
    r.addSpacer(8);
    tempBar(r, d, lo, hi, 90);
    r.addSpacer(8);
    const mx = r.addStack(); mx.size = new Size(32, 18); mx.centerAlignContent();
    addText(mx, tempStr(d.max), Font.semiboldSystemFont(12), WHITE); mx.addSpacer();
  });
}

function accessoryWidget(w, m, family) {
  if (family === "accessoryInline") {
    addText(w, `${m.place} ${tempStr(m.temp)} ${m.info.text}`, Font.systemFont(12), WHITE);
    return;
  }
  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    const c = w.addStack(); c.layoutVertically(); c.centerAlignContent();
    const a = c.addStack(); a.addSpacer(); weatherIcon(a, m.code, m.isDay, 16); a.addSpacer();
    const b = c.addStack(); b.addSpacer(); addText(b, tempStr(m.temp), Font.semiboldSystemFont(14), WHITE); b.addSpacer();
    return;
  }
  const r = w.addStack(); r.centerAlignContent();
  weatherIcon(r, m.code, m.isDay, 14); r.addSpacer(4);
  addText(r, `${m.place} ${tempStr(m.temp)}`, Font.semiboldSystemFont(13), WHITE);
  addText(w, `${m.info.text} · ${tempStr(m.max)}/${tempStr(m.min)}`, Font.systemFont(11), WHITE);
  addText(w, `초미세 ${m.pm25 ? m.pm25.label : "-"} · 강수 ${pctStr(m.popDay)}`, Font.systemFont(11), WHITE);
}

function buildWidget(m, family) {
  const w = new ListWidget();
  if (/^accessory/.test(family)) { accessoryWidget(w, m, family); return w; }
  w.backgroundGradient = background(m); // 그림이 실패해도 이 그라데이션이 남음
  try { w.backgroundImage = backgroundImage(m, family); } catch (e) { console.log("배경 그림 실패: " + e); }
  if (family === "small") smallWidget(w, m);
  else if (family === "large" || family === "extraLarge") largeWidget(w, m);
  else mediumWidget(w, m);
  return w;
}

function errorWidget(err, family) {
  const w = new ListWidget();
  if (!/^accessory/.test(family)) {
    const g = new LinearGradient();
    g.colors = [dyn("#6B7A8F", "#2C333D"), dyn("#3E4A5C", "#14181E")];
    g.locations = [0, 1];
    w.backgroundGradient = g;
    w.setPadding(14, 14, 14, 14);
  }
  addSymbol(w, "exclamationmark.icloud.fill", 22, WHITE);
  w.addSpacer(6);
  const t = addText(w, "날씨를 불러올 수 없어요", Font.semiboldSystemFont(13), WHITE); t.lineLimit = 2;
  w.addSpacer(2);
  let msg = (err && err.message) || "알 수 없는 오류";
  if (!(err instanceof NotFoundError) && !/[가-힣]/.test(msg)) msg = "인터넷 연결을 확인해 주세요 (" + msg + ")";
  const d = addText(w, msg, Font.systemFont(10), SUB); d.lineLimit = 3;
  w.addSpacer();
  addText(w, "잠시 후 자동으로 다시 시도해요", Font.systemFont(9), FAINT);
  return w;
}

/* ---------------- 실행 ---------------- */
const T0 = Date.now();
const left = () => Math.max(1, CONFIG.budgetSeconds - (Date.now() - T0) / 1000);
async function main() {
  const cacheFile = fm.joinPath(DIR, "cache-" + (PARAM ? "p" + hashStr(PARAM) : "here") + ".json");
  const cache = readJSON(cacheFile);
  let model = null, err = null;
  try {
    const loc = await resolveLocation(cache);
    const np = loc.namePromise; delete loc.namePromise;
    const { fc, aq, ak } = await withTimeout(fetchWeather(loc), Math.max(4, left() - 1), "날씨");
    if (np) {
      // 날씨가 먼저 끝나면 이름은 남은 시간만큼만 기다림 → 못 받으면 iOS 이름/이전 이름
      const n = await Promise.race([np, sleep(left()).then(() => null)]) || { name: (cache && cache.loc && cache.loc.name) || "현재 위치", nameSrc: "", iosName: null, vwErr: "시간 초과" };
      loc.name = n.name; loc.nameSrc = n.nameSrc; loc.hj = n.hj || "";
      writeJSON(fm.joinPath(DIR, "last-name.json"), { v: WIDGET_VERSION, at: seoulISO(Date.now()), nameSrc: n.nameSrc, vwErr: n.vwErr || "" }); // 진단용(이름 자체는 저장 안 함)
      console.log(`[${WIDGET_VERSION}] 위치 이름 출처: ${n.nameSrc || "없음"}${n.vwErr ? " · 브이월드 실패: " + n.vwErr : ""}`);
      loc.iosName = n.iosName;
    }
    const sameLoc = cache && cache.loc && Math.abs(cache.loc.lat - loc.lat) < 0.05 && Math.abs(cache.loc.lon - loc.lon) < 0.05;
    const raw = { loc, fc, aq: aq || (sameLoc ? cache.aq : null), ak: ak || (sameLoc ? cache.ak : null), fetchedAt: Date.now() };
    model = buildModel(raw, false);
    // 브이월드 이름은 파일에 남기지 않음(약관): 저장본에는 iOS 이름(없으면 '현재 위치')
    const keep = loc.nameSrc === "vworld" ? Object.assign({}, loc, { name: loc.iosName || "현재 위치", nameSrc: loc.iosName ? "ios" : "", hj: "" }) : loc;
    writeJSON(cacheFile, Object.assign({}, raw, { loc: keep }));
  } catch (e) {
    err = e;
    if (cache && cache.fc && !(e instanceof NotFoundError)) {
      try { model = buildModel(cache, true); } catch (e2) { model = null; }
    }
  }
  let w;
  try { w = model ? buildWidget(model, FAMILY) : errorWidget(err, FAMILY); }
  catch (e) { console.log("위젯 그리기 실패: " + e); w = errorWidget(e, FAMILY); }
  w.url = CONFIG.appURL;
  w.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);
  if (config.runsInWidget) {
    Script.setWidget(w);
  } else if (FAMILY === "small") {
    await w.presentSmall();
  } else if (FAMILY === "large") {
    await w.presentLarge();
  } else {
    await w.presentMedium();
  }
  Script.complete();
}

try { await main(); }
catch (e) { // 어떤 오류든 위젯을 꼭 넘겨야 iOS가 refreshAfterDate대로 다시 실행함
  console.log("main 실패: " + e);
  const w = errorWidget(e, FAMILY); w.url = CONFIG.appURL; w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  if (config.runsInWidget) Script.setWidget(w); Script.complete();
}

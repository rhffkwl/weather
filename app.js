'use strict';
/* 하늘 날씨 — static PWA. 국내: 기상청 초단기실황·단기·중기예보 (data/kma/*.json), 해외 또는 기상청 자료가 없을 때: Open-Meteo.
   Open-Meteo는 국내에서도 자외선·일출몰·체감온도 보정·어제 기온(초기)·지오코딩·대기질 모델에 씁니다.
   + AirKorea real-time PM10/PM2.5 measurements (data/airkorea.json). data/는 GitHub Actions가 매시 갱신. */
(() => {
const $ = (s, r = document) => r.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const SEOUL = { lat: 37.5665, lon: 126.978, name: '서울특별시', sub: '대한민국' };
const POPULAR = [
  ['서울', 37.5665, 126.978, '서울특별시'], ['부산', 35.1796, 129.0756, '부산광역시'], ['인천', 37.4563, 126.7052, '인천광역시'],
  ['대구', 35.8714, 128.6014, '대구광역시'], ['대전', 36.3504, 127.3845, '대전광역시'], ['광주', 35.1595, 126.8526, '광주광역시'],
  ['울산', 35.5384, 129.3114, '울산광역시'], ['세종', 36.48, 127.289, '세종특별자치시'], ['수원', 37.2636, 127.0286, '경기도'],
  ['춘천', 37.8813, 127.7298, '강원특별자치도'], ['강릉', 37.7519, 128.8761, '강원특별자치도'], ['전주', 35.8242, 127.148, '전북특별자치도'],
  ['여수', 34.7604, 127.6622, '전라남도'], ['포항', 36.019, 129.3435, '경상북도'], ['제주', 33.4996, 126.5312, '제주특별자치도'], ['서귀포', 33.2541, 126.56, '제주특별자치도'],
];
const WMO = {
  0: ['맑음', '☀️', '🌙'], 1: ['대체로 맑음', '🌤️', '🌙'], 2: ['구름 조금', '⛅', '☁️'], 3: ['흐림', '☁️', '☁️'],
  45: ['안개', 'FOG'], 48: ['짙은 안개', 'FOG'],
  51: ['약한 이슬비', '🌦️', '🌧️'], 53: ['이슬비', '🌦️', '🌧️'], 55: ['강한 이슬비', '🌧️'], 56: ['어는 이슬비', '🌧️'], 57: ['어는 이슬비', '🌧️'],
  61: ['약한 비', '🌦️', '🌧️'], 63: ['비', '🌧️'], 65: ['강한 비', '🌧️'], 66: ['어는 비', '🌧️'], 67: ['강한 어는 비', '🌧️'],
  71: ['약한 눈', '🌨️'], 73: ['눈', '🌨️'], 75: ['강한 눈', '❄️'], 77: ['싸락눈', '🌨️'],
  80: ['약한 소나기', '🌦️', '🌧️'], 81: ['소나기', '🌧️'], 82: ['강한 소나기', '⛈️'], 85: ['눈 소나기', '🌨️'], 86: ['강한 눈 소나기', '❄️'],
  95: ['뇌우', '⛈️'], 96: ['우박 동반 뇌우', '⛈️'], 99: ['강한 우박 뇌우', '⛈️'],
};
const wDesc = c => (WMO[c] || ['알 수 없음'])[0];
// iOS renders the 🌫️ emoji as a blurry grey square, so fog uses an inline SVG.
const FOG_SVG = '<svg class="wi" viewBox="0 0 32 32" role="img" aria-label="안개"><path d="M9.5 17.5a5.5 5.5 0 0 1 1.2-10.9A7 7 0 0 1 24 9.2a4.2 4.2 0 0 1-.6 8.3z" fill="#e3e9f1" stroke="#8a97a8" stroke-width="1.2"/><g stroke="#8a97a8" stroke-width="2.4" stroke-linecap="round"><path d="M5 21.5h18"/><path d="M9 25.5h18"/><path d="M6 29.5h14"/></g></svg>';
const wIcon = (c, day = 1) => { const w = WMO[c]; if (!w) return '☁️'; const i = (!day && w[2]) ? w[2] : w[1]; return i === 'FOG' ? FOG_SVG : i; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const r0 = n => (n == null || isNaN(n)) ? '--' : Math.round(n);
const keyOf = (lat, lon) => `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
const windDir = d => DIRS[Math.round(((d % 360) + 360) % 360 / 45) % 8] + '풍';
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

// 한국 환경부 통합 예보 기준 (µg/m³)
function pmLevel(kind, v) {
  if (v == null || isNaN(v)) return null;
  const t = kind === 'pm10' ? [30, 80, 150] : [15, 35, 75];
  const lv = v <= t[0] ? 1 : v <= t[1] ? 2 : v <= t[2] ? 3 : 4;
  return { lv, label: ['좋음', '보통', '나쁨', '매우나쁨'][lv - 1] };
}
function uvLevel(u) {
  if (u == null) return '';
  return u < 3 ? '낮음' : u < 6 ? '보통' : u < 8 ? '높음' : u < 11 ? '매우 높음' : '위험';
}

/* ---- AirKorea 실측 (에어코리아, 한국환경공단) ---- */
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

/* ---------------- state ---------------- */
const state = {
  favs: LS.get('wx:favs', []),            // [{id,name,sub,lat,lon}]
  here: LS.get('wx:here', null),          // {lat,lon,name,sub,fallback}
  temp: LS.get('wx:temp', null),          // searched, not-favorited location
  activeId: LS.get('wx:active', 'here'),
  editing: false,
};
const saveFavs = () => LS.set('wx:favs', state.favs);
function locations() {
  const list = [{ id: 'here', ...(state.here || {}) }, ...state.favs];
  if (state.temp && !state.favs.some(f => f.id === state.temp.id)) list.push(state.temp);
  return list;
}
const active = () => locations().find(l => l.id === state.activeId) || locations()[0];
const cacheGet = l => (l && l.lat != null) ? LS.get('wx:d:' + keyOf(l.lat, l.lon), null) : null;
const cacheSet = (l, d) => LS.set('wx:d:' + keyOf(l.lat, l.lon), d);

/* ---------------- network ---------------- */
async function getJSON(url, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function forecastURL(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: 8, past_days: 1, wind_speed_unit: 'ms',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,dew_point_2m',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
  });
  return 'https://api.open-meteo.com/v1/forecast?' + p;
}
function airURL(lat, lon) {
  const p = new URLSearchParams({ latitude: lat, longitude: lon, timezone: 'auto', current: 'pm10,pm2_5', hourly: 'pm10,pm2_5', forecast_days: 2 });
  return 'https://air-quality-api.open-meteo.com/v1/air-quality?' + p;
}
// 5-minute cache-busting bucket: GitHub Pages' CDN caches for ~10 min.
const akURL = () => 'data/airkorea.json?t=' + Math.floor(Date.now() / 300000);
const kmaURL = p => 'data/kma/' + p + '?t=' + Math.floor(Date.now() / 300000);
const kmaPointsURL = () => 'data/kma/points.json?d=' + Math.floor(Date.now() / 864e5);
async function fetchKma(l) {
  if (!kmaInKorea(l.lat, l.lon)) return null;
  try {
    const [pts, now, mid] = await Promise.all([getJSON(kmaPointsURL(), 8000), getJSON(kmaURL('now.json'), 8000).catch(() => null), getJSON(kmaURL('mid.json'), 8000).catch(() => null)]);
    const pt = kmaNearest(pts, l.lat, l.lon); if (!pt) return null;
    let vil = null;
    for (const q of [pt, ...pt.alts]) { vil = await getJSON(kmaURL(`f/${q.nx}_${q.ny}.json`), 8000).catch(() => null); if (vil) break; }
    return { pt, now, vil, mid };
  } catch (e) { console.info('KMA data unavailable, using Open-Meteo', e && e.message); return null; }
}
async function fetchAirKorea(l) {
  try { return akNearest(await getJSON(akURL(), 10000), l.lat, l.lon); } catch (e) { console.info('AirKorea data unavailable, using model values', e && e.message); return null; }
}
// past_days=1: take yesterday's same-hour temperature, then drop yesterday from the daily arrays.
function normalizeForecast(f) {
  if (!f || !f.current || !f.hourly || !f.daily) return f;
  const H = f.hourly, D = f.daily, hr = f.current.time.slice(0, 13);
  const i = H.time.findIndex(t => t.slice(0, 13) === hr);
  f.yday = i >= 24 && H.temperature_2m[i - 24] != null ? H.temperature_2m[i - 24] : null;
  const today = f.current.time.slice(0, 10);
  while (D.time.length && D.time[0] < today) for (const key of Object.keys(D)) if (Array.isArray(D[key])) D[key].shift();
  return f;
}
function ydayInfo(now, prev) {
  if (now == null || prev == null || isNaN(now) || isNaN(prev)) return null;
  const diff = now - prev, n = Math.round(Math.abs(diff));
  if (Math.abs(diff) < 1 || n === 0) return { cls: 'same', html: '어제와 비슷' };
  return diff > 0 ? { cls: 'up', html: `<span aria-hidden="true">▲</span> 어제보다 ${n}° 높음` } : { cls: 'down', html: `<span aria-hidden="true">▼</span> 어제보다 ${n}° 낮음` };
}
async function fetchWeather(l) {
  const prev = cacheGet(l);
  const [f0, a, k, km] = await Promise.all([getJSON(forecastURL(l.lat, l.lon)), getJSON(airURL(l.lat, l.lon)).catch(() => null), fetchAirKorea(l), fetchKma(l)]);
  const f = normalizeForecast(f0);
  if (km) { try { kmaApply(f, km); } catch (e) { console.warn('KMA merge failed, showing Open-Meteo', e); } }
  const d = { ts: Date.now(), f, a, k: k || (prev && prev.k) || null };
  cacheSet(l, d);
  return d;
}
/* ---- 위치명: 국내는 브이월드(국토교통부) 역지오코딩 → 행정동, 해외·실패 시 BigDataCloud ---- */
// 브이월드 키는 서비스 URL(https://rhffkwl.github.io/weather/)에 묶인 브라우저용 키입니다.
const VWORLD_KEY = '532F6A41-960A-47CD-ADAE-0AA007AD1C37';
const VW_TRY_MS = [3000, 2000], VW_RETRY_GAP = 1000; // 1차 3초 → 1초 쉬고 2차 2초: 최악 ~6초 뒤 BigDataCloud
const vwMem = new Map(); // 브이월드 약관상 결과를 저장하지 않으므로 세션 메모리에만 둡니다 (~100m 격자)
// structure → { name: '용산구 한강로동', sub: '서울특별시, 대한민국' }
function vwLabel(st) {
  if (!st) return null;
  const l2 = (st.level2 || '').trim(), parts = l2.split(/\s+/).filter(Boolean);
  const gu = (st.level3 || '').trim() || parts[parts.length - 1] || '';
  const dong = (st.level4A || '').trim() || (st.level4L || '').trim();
  const name = [gu, dong].filter(Boolean).join(' ');
  if (!name) return null;
  const sub = [[st.level1, parts.length > 1 ? parts.slice(0, -1).join(' ') : ''].filter(Boolean).join(' '), '대한민국'].filter(Boolean).join(', ');
  return { name, sub };
}
// CORS 헤더가 없어 fetch는 막힘 → JSONP (format=json&callback=…)
async function vworldName(lat, lon) {
  const k = (+lat).toFixed(3) + ',' + (+lon).toFixed(3);
  if (vwMem.has(k)) return vwMem.get(k);
  let last;
  for (let i = 0; i < VW_TRY_MS.length; i++) {
    if (i) await new Promise(r => setTimeout(r, VW_RETRY_GAP));
    try { const v = await vworldOnce(lat, lon, VW_TRY_MS[i]); vwMem.set(k, v); return v; }
    catch (e) { last = e; if (/NOT_FOUND|empty/.test(e.message)) break; } // 결과 없음(바다 등)은 다시 물어도 같음
  }
  throw last;
}
function vworldOnce(lat, lon, ms) {
  return new Promise((resolve, reject) => {
    const cb = '__vw' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const s = document.createElement('script');
    const done = (err, v) => { clearTimeout(t); window[cb] = () => {}; setTimeout(() => { try { delete window[cb]; } catch {} }, 30000); s.remove(); err ? reject(err) : resolve(v); };
    const t = setTimeout(() => done(new Error('vworld timeout')), ms);
    window[cb] = j => {
      const r = j && j.response;
      if (!r || r.status !== 'OK') return done(new Error('vworld ' + (r ? r.status + ' ' + ((r.error && r.error.code) || '') : 'bad response')));
      const it = (r.result || []).find(x => x.structure && (x.structure.level4A || x.structure.level4L)) || (r.result || [])[0];
      const v = it && vwLabel(it.structure);
      if (!v) return done(new Error('vworld empty'));
      v.src = 'vworld'; done(null, v);
    };
    s.onerror = () => done(new Error('vworld load error'));
    s.referrerPolicy = 'no-referrer-when-downgrade'; // 등록한 서비스 URL과 같은 전체 주소를 Referer로
    s.src = 'https://api.vworld.kr/req/address?' + new URLSearchParams({ service: 'address', request: 'getAddress', version: '2.0', crs: 'epsg:4326',
      point: `${(+lon).toFixed(6)},${(+lat).toFixed(6)}`, type: 'both', zipcode: 'false', format: 'json', errorFormat: 'json', key: VWORLD_KEY,
      domain: 'https://rhffkwl.github.io/weather/', callback: cb });
    document.head.appendChild(s);
  });
}
async function reverseName(lat, lon) {
  if (kmaInKorea(lat, lon)) {
    try { return await vworldName(lat, lon); } catch (e) { console.info('VWorld name unavailable, using BigDataCloud', e && e.message); }
  }
  return bdcName(lat, lon);
}
async function bdcName(lat, lon) {
  try {
    const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ko`, 8000);
    const city = j.city || j.principalSubdivision || '';
    const name = j.locality && j.locality !== city ? j.locality : (city || '현재 위치');
    const sub = [city !== name ? city : '', j.countryName].filter(Boolean).join(', ');
    return { name, sub, src: 'bdc' };
  } catch { return { name: '현재 위치', sub: '', src: 'none' }; }
}
function geolocate() {
  return new Promise((res, rej) => {
    if (!('geolocation' in navigator)) return rej(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(p => res(p.coords), rej, { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 });
  });
}
async function resolveHere() {
  try {
    const c = await geolocate();
    const lat = +c.latitude.toFixed(4), lon = +c.longitude.toFixed(4);
    const prev = state.here;
    // 1km 안에서는 이전 이름을 다시 씀. 단, 국내인데 브이월드 이름이 아니면(예전 이름·일시 실패) 30분마다 다시 시도
    // (prev.src === 'vworld' 은 이번 세션 메모리에서만 생김. 저장본은 'stored'라 국내면 다시 물어봄)
    const near = prev && !prev.fallback && Math.abs(prev.lat - lat) < 0.01 && Math.abs(prev.lon - lon) < 0.01;
    const moved = !prev || Math.abs(prev.lat - lat) > 0.002 || Math.abs(prev.lon - lon) > 0.002; // ~200m: 동 경계가 촘촘해서
    const wantVw = kmaInKorea(lat, lon) && (!(prev && prev.src === 'vworld') || moved) && !(prev && prev.src !== 'vworld' && prev.vwTry && Date.now() - prev.vwTry < 30 * 60e3);
    let nm = near && !wantVw ? prev : null;
    let vwTry = prev && near ? prev.vwTry : 0;
    if (!nm) { nm = await reverseName(lat, lon); if (kmaInKorea(lat, lon) && nm.src !== 'vworld') vwTry = Date.now(); }
    state.here = { lat, lon, name: nm.name, sub: nm.sub, src: nm.src, vwTry, fallback: false };
  } catch (e) {
    if (!state.here || state.here.fallback) {
      state.here = { ...SEOUL, fallback: true };
      toast(e && e.code === 1 ? '위치 권한이 없어 서울 날씨를 보여드려요' : '위치를 확인할 수 없어 서울 날씨를 보여드려요');
    }
  }
  // 브이월드 이름은 약관상 저장하지 않음: 기기에는 좌표만 남기고, 다음 실행 때 다시 물어봄(같은 세션 안에서는 vwMem)
  const h = state.here;
  LS.set('wx:here', h && h.src === 'vworld' ? { ...h, name: '현재 위치', sub: '', src: 'stored' } : h);
}

/* ---------------- rendering ---------------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function tabLabel(l) {
  if (l.id === 'here') return '📍 ' + (l.name && !l.fallback ? l.name : '현재 위치');
  if (!state.favs.some(f => f.id === l.id)) return '🔍 ' + l.name;
  return '★ ' + l.name;
}
function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = locations().map(l => {
    const d = cacheGet(l); const t = d && d.f && d.f.current ? r0(d.f.current.temperature_2m) + '°' : '';
    return `<button class="tab" role="tab" data-id="${esc(l.id)}" aria-selected="${l.id === state.activeId}">${esc(tabLabel(l))}${t ? ` <span class="t">${t}</span>` : ''}</button>`;
  }).join('');
  const on = nav.querySelector('[aria-selected=true]');
  if (on) on.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}
function isFav(l) {
  if (!l) return false;
  if (l.id === 'here') return !!(l.lat != null && state.favs.some(f => keyOf(f.lat, f.lon) === keyOf(l.lat, l.lon)));
  return state.favs.some(f => f.id === l.id);
}
function renderHeader(l) {
  $('#locName').textContent = l.name || (l.id === 'here' ? '현재 위치' : '');
  const sub = l.id === 'here' ? ['📍 현재 위치' + (l.fallback ? ' (기본값: 서울)' : ''), l.fallback ? '' : l.sub].filter(Boolean).join(' · ') : (l.sub || '');
  $('#locSub').textContent = sub;
  const fav = isFav(l); const s = $('#btnStar');
  s.textContent = fav ? '★' : '☆'; s.setAttribute('aria-pressed', fav); s.setAttribute('aria-label', fav ? '즐겨찾기에서 삭제' : '즐겨찾기에 추가');
  s.hidden = l.lat == null;
}
function setStatus(msg) { const s = $('#status'); s.hidden = !msg; s.textContent = msg || ''; }
const hm = iso => iso ? iso.slice(11, 16) : '--:--';
const fmtTime = ts => new Date(ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });

function renderWeather(d) {
  if (!d || !d.f || !d.f.current || !d.f.hourly) return;
  const { f, a } = d; const c = f.current; const H = f.hourly; const D = f.daily;
  document.body.classList.toggle('night', !c.is_day);
  document.body.classList.toggle('rain', c.weather_code >= 45 || c.weather_code === 3);
  $('#curIcon').innerHTML = wIcon(c.weather_code, c.is_day);
  $('#curTemp').textContent = r0(c.temperature_2m) + '°';
  $('#curDesc').textContent = c.kma_desc || wDesc(c.weather_code);
  $('#curHL').textContent = `최고 ${r0(D.temperature_2m_max[0])}° · 최저 ${r0(D.temperature_2m_min[0])}° · 체감 ${r0(c.apparent_temperature)}°`;
  const yd = ydayInfo(c.temperature_2m, f.yday); const ye = $('#curYday');
  ye.hidden = !yd; ye.className = 'yday' + (yd ? ' ' + yd.cls : ''); ye.innerHTML = yd ? yd.html : '';

  // hourly (next 24h starting at current hour)
  let i0 = H.time.findIndex(t => t.slice(0, 13) === c.time.slice(0, 13)); if (i0 < 0) i0 = 0;
  let hh = '';
  for (let i = i0; i < Math.min(i0 + 25, H.time.length); i++) {
    const h = +H.time[i].slice(11, 13); const pp = H.precipitation_probability[i];
    const lbl = i === i0 ? '지금' : (h === 0 ? '내일' : (h < 12 ? '오전 ' : '오후 ') + ((h % 12) || 12) + '시');
    hh += `<div class="hr${i === i0 ? ' now' : ''}"><span class="tm">${lbl}</span><span class="ic">${wIcon(H.weather_code[i], H.is_day[i])}</span><span class="tp">${r0(i === i0 ? c.temperature_2m : H.temperature_2m[i])}°</span><span class="pp">${pp >= 10 ? pp + '%' : ''}</span></div>`;
  }
  $('#hourly').innerHTML = hh; $('#hourly').scrollLeft = 0;

  // details
  const feelsDiff = c.apparent_temperature - c.temperature_2m;
  const feelsTxt = Math.abs(feelsDiff) < 1.5 ? '실제 기온과 비슷해요' : feelsDiff > 0 ? '실제보다 덥게 느껴져요' : '실제보다 춥게 느껴져요';
  const ppNow = H.precipitation_probability[i0];
  const uv = c.uv_index; const uvPct = Math.min(100, (uv || 0) / 11 * 100);
  $('#details').innerHTML = [
    ['체감 온도', `${r0(c.apparent_temperature)}°`, feelsTxt],
    ['습도', `${r0(c.relative_humidity_2m)}%`, `이슬점 ${r0(c.dew_point_2m)}°`],
    ['바람', `${(c.wind_speed_10m ?? 0).toFixed(1)}<small style="font-size:15px"> m/s</small>`, `${windDir(c.wind_direction_10m)} · 돌풍 ${(c.wind_gusts_10m ?? 0).toFixed(1)} m/s`],
    ['강수 확률', `${r0(ppNow)}%`, `오늘 최대 ${r0(D.precipitation_probability_max[0])}%${c.precipitation > 0 ? ` · 현재 ${c.precipitation}mm` : ''}`],
    ['자외선 지수', `${uv == null ? '--' : (Math.round(uv * 10) / 10)} <small style="font-size:15px">${uvLevel(uv)}</small>`, `<div class="uvbar"><i style="left:${uvPct}%"></i></div><div style="margin-top:6px">오늘 최대 ${r0(D.uv_index_max[0])} (${uvLevel(D.uv_index_max[0])})</div>`],
    ['일출 · 일몰', `${hm(D.sunrise[0])}`, `일몰 ${hm(D.sunset[0])}`],
  ].map(([t, v, s]) => `<div class="card"><h2>${t}</h2><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

  // air quality: AirKorea measured value first, Open-Meteo model value as fallback (labeled 예측값)
  const ac = (a && a.current) || {}; const k = d.k || {}; const now = Date.now();
  const pick = (kind, mk) => {
    const m = k[kind];
    if (akFresh(m, now) && m.v != null) return { v: m.v, src: 'ak', st: m };
    return ac[mk] != null ? { v: ac[mk], src: 'model' } : null;
  };
  const p10 = pick('pm10', 'pm10'), p25 = pick('pm25', 'pm2_5');
  if (p10 || p25) {
    const box = (kind, name, p) => {
      const v = p && p.v; const L = pmLevel(kind, v);
      const tag = !p ? '' : p.src === 'ak' ? '<span class="tag ak">실측</span>' : '<span class="tag">예측값</span>';
      return `<div class="aq"><div class="n">${name}${tag}</div><div class="lv lv-${L ? L.lv : 0}">${L ? `<span class="pill">${L.label}</span>` : '<span class="pill">정보 없음</span>'}</div><div class="val">${v == null ? '-' : Math.round(v)} µg/m³</div></div>`;
    };
    const sts = [p10, p25].filter(p => p && p.src === 'ak').map(p => p.st);
    const names = [...new Set(sts.map(s => `${s.name} · ${akHour(s)} 기준`))];
    const lines = [];
    if (names.length) lines.push(`측정소: ${esc(names.join(', '))}${sts[0].km >= 1 ? ` <span class="km">(${esc(sts[0].km)}km)</span>` : ''}`);
    if ([p10, p25].some(p => p && p.src === 'model')) lines.push(names.length ? '일부 항목은 측정값이 없어 Open-Meteo 모델 예측값이에요' : '근처 측정소의 최신 측정값이 없어 Open-Meteo 모델 예측값을 보여드려요');
    if (names.length) lines.push('출처: 에어코리아 (한국환경공단) · 실시간 자료는 미확정 값으로 실제와 다를 수 있어요');
    $('#air').innerHTML = box('pm10', '미세먼지 PM10', p10) + box('pm2_5', '초미세먼지 PM2.5', p25) + `<div class="aqsrc">${lines.join('<br>')}</div>`;
  } else $('#air').innerHTML = '<div class="muted" style="margin:6px 0;grid-column:1/-1">대기질 정보를 불러오지 못했어요</div>';

  // 7-day
  const n = Math.min(7, D.time.length);
  const lo = Math.min(...D.temperature_2m_min.slice(0, n)), hi = Math.max(...D.temperature_2m_max.slice(0, n)); const span = Math.max(1, hi - lo);
  let dl = '';
  for (let i = 0; i < n; i++) {
    const [y, m, dd] = D.time[i].split('-').map(Number); const dow = new Date(y, m - 1, dd).getDay();
    const name = i === 0 ? '오늘' : i === 1 ? '내일' : DOW[dow];
    const mn = D.temperature_2m_min[i], mx = D.temperature_2m_max[i]; const pp = D.precipitation_probability_max[i];
    dl += `<li><span class="d${dow === 0 && i > 1 ? ' sun' : dow === 6 && i > 1 ? ' sat' : ''}">${name}</span><span class="ic">${wIcon(D.weather_code[i], 1)}</span><span class="pp">${pp >= 10 ? pp + '%' : ''}</span>`
      + `<span class="lo">${r0(mn)}°</span><span class="rng"><i style="clip-path:inset(0 ${((hi - mx) / span * 100).toFixed(1)}% 0 ${((mn - lo) / span * 100).toFixed(1)}% round 3px)"></i></span><span class="hi">${r0(mx)}°</span></li>`;
  }
  $('#daily').innerHTML = dl;
  $('#updated').textContent = `${fmtTime(d.ts)} 업데이트`;
  const K = f.kma;
  $('#wxsrc').textContent = K ? `예보: 기상청 (${K.name}${K.km >= 1 ? ` ${K.km}km` : ''}${K.obsBase ? ` · ${kmaHourLabel(K.obsBase)} 실황` : ''}${K.vilBase ? ` · 단기 ${kmaHourLabel(K.vilBase)} 발표` : ''}${K.midTm ? ' · 중기' : ''})` : '예보: Open-Meteo';
}
function renderEmpty() {
  ['#hourly', '#details', '#air', '#daily'].forEach(s => $(s).innerHTML = '');
  $('#curTemp').textContent = '--°'; $('#curDesc').innerHTML = '&nbsp;'; $('#curHL').innerHTML = '&nbsp;'; $('#curYday').hidden = true; $('#curIcon').textContent = '⏳';
}

/* ---------------- flow ---------------- */
let loadSeq = 0;
async function load(opts = {}) {
  const seq = ++loadSeq;
  let l = active();
  if (l.lat != null) { renderHeader(l); const c0 = cacheGet(l); if (c0 && c0.f && c0.f.hourly) renderWeather(c0); else renderEmpty(); }
  if (l.id === 'here' && (opts.relocate || l.lat == null)) {
    if (l.lat == null) { renderHeader({ id: 'here', name: '위치 확인 중…' }); renderEmpty(); setStatus('위치 확인 중…'); }
    const before = l.lat != null ? keyOf(l.lat, l.lon) : '';
    await resolveHere(); if (seq !== loadSeq) return; l = active(); renderTabs();
    if (keyOf(l.lat, l.lon) !== before) opts.force = true;
  }
  renderHeader(l);
  let cached = cacheGet(l); if (cached && !(cached.f && cached.f.hourly)) cached = null;
  if (cached) renderWeather(cached); else renderEmpty();
  const fresh = cached && Date.now() - cached.ts < 5 * 60 * 1000;
  if (fresh && !opts.force) { setStatus(''); return; }
  setStatus(cached ? '업데이트 중…' : '날씨 불러오는 중…');
  try {
    const d = await fetchWeather(l);
    if (seq !== loadSeq) return;
    renderWeather(d); setStatus(''); renderTabs();
  } catch (e) {
    if (seq !== loadSeq) return;
    console.warn('weather fetch failed', e);
    setStatus(cached ? `오프라인 · ${fmtTime(cached.ts)} 기준 데이터` : '날씨 정보를 불러오지 못했어요. 연결을 확인해 주세요.');
  }
}
function select(id, dir) {
  if (id === state.activeId) return;
  state.activeId = id; LS.set('wx:active', id);
  const m = $('#main');
  if (dir) { m.classList.add(dir > 0 ? 'slide-l' : 'slide-r'); setTimeout(() => m.classList.remove('slide-l', 'slide-r'), 180); }
  window.scrollTo({ top: 0 });
  renderTabs(); load({ relocate: id === 'here' && !state.here });
}
function step(dir) {
  const list = locations(); const i = list.findIndex(l => l.id === state.activeId);
  const j = i + dir; if (j < 0 || j >= list.length) return;
  select(list[j].id, dir);
}
function toggleFav() {
  const l = active(); if (!l || l.lat == null) return;
  if (isFav(l)) {
    const k = keyOf(l.lat, l.lon);
    state.favs = state.favs.filter(f => l.id === 'here' ? keyOf(f.lat, f.lon) !== k : f.id !== l.id);
    if (l.id !== 'here') { state.temp = { ...l }; LS.set('wx:temp', state.temp); }
    toast('즐겨찾기에서 삭제했어요');
  } else {
    const id = l.id === 'here' ? 'c' + keyOf(l.lat, l.lon) : l.id;
    state.favs.push({ id, name: l.name || '저장한 위치', sub: l.id === 'here' ? (l.sub || '') : (l.sub || ''), lat: l.lat, lon: l.lon });
    if (state.temp && state.temp.id === id) { state.temp = null; LS.set('wx:temp', null); }
    toast('★ 즐겨찾기에 추가했어요');
  }
  saveFavs(); renderTabs(); renderHeader(active());
}

/* ---------------- search ---------------- */
const FC_RANK = { PPLC: 6, PPLA: 5, PPLA2: 4, PPLA3: 3, PPLA4: 2, PPL: 1, ADM1: 5, ADM2: 4 };
async function geocode(q) {
  const variants = [q];
  if (/[가-힣]$/.test(q) && !/(시|군|구|도|읍|면|동)$/.test(q)) variants.push(q + '시', q + '특별시', q + '광역시', q + '군', q + '구');
  const all = await Promise.all(variants.map(v => getJSON('https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name: v, count: 10, language: 'ko', format: 'json' }), 8000).then(j => j.results || []).catch(() => [])));
  const seen = new Set(); const out = [];
  for (const r of all.flat()) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } }
  out.sort((a, b) => ((b.population || 0) - (a.population || 0)) || ((FC_RANK[b.feature_code] || 0) - (FC_RANK[a.feature_code] || 0)));
  return out.slice(0, 12);
}
const fromGeo = r => ({ id: 'g' + r.id, name: r.name, sub: [r.admin1 !== r.name ? r.admin1 : '', r.country].filter(Boolean).join(', '), lat: +r.latitude.toFixed(4), lon: +r.longitude.toFixed(4) });
let searchItems = [];
function renderResults(items, msg) {
  searchItems = items;
  $('#searchResults').innerHTML = msg ? `<p class="muted">${esc(msg)}</p>` : items.map((l, i) => {
    const fav = state.favs.some(f => f.id === l.id);
    return `<div class="res" data-i="${i}"><div class="grow"><div class="nm">${esc(l.name)}</div><div class="ad">${esc(l.sub)}</div></div><button class="add${fav ? ' on' : ''}" data-add="${i}">${fav ? '★ 저장됨' : '☆ 저장'}</button></div>`;
  }).join('');
}
let searchT, searchSeq = 0;
function onSearchInput() {
  const q = $('#searchInput').value.trim(); clearTimeout(searchT);
  if (!q) { renderResults([]); $('#popular').hidden = false; return; }
  $('#popular').hidden = true;
  searchT = setTimeout(async () => {
    const s = ++searchSeq; renderResults([], '검색 중…');
    const res = await geocode(q); if (s !== searchSeq) return;
    renderResults(res.map(fromGeo), res.length ? '' : '검색 결과가 없어요. "부산광역시"처럼 정식 이름으로도 검색해 보세요.');
  }, 350);
}
function openLocation(l, addFav) {
  if (addFav && !state.favs.some(f => f.id === l.id)) { state.favs.push(l); saveFavs(); toast('★ 즐겨찾기에 추가했어요'); }
  if (!state.favs.some(f => f.id === l.id)) { state.temp = l; LS.set('wx:temp', l); }
  closeSheets(); state.activeId = null; select(l.id);
}

/* ---------------- favorites sheet ---------------- */
async function renderFavs() {
  const ul = $('#favList'); ul.classList.toggle('editing', state.editing);
  $('#btnEdit').textContent = state.editing ? '완료' : '편집';
  $('#favEmpty').hidden = state.favs.length > 0; $('#btnEdit').hidden = !state.favs.length;
  ul.innerHTML = state.favs.map((f, i) => {
    const d = cacheGet(f); const c = d && d.f && d.f.current;
    return `<li data-id="${esc(f.id)}" class="${f.id === state.activeId ? 'cur' : ''}"><span class="ic">${c ? wIcon(c.weather_code, c.is_day) : '·'}</span>
      <div class="grow"><div class="nm">${esc(f.name)}</div><div class="ad">${esc(f.sub || '')}${c ? ' · ' + (c.kma_desc || wDesc(c.weather_code)) : ''}</div></div>
      <span class="tp">${c ? r0(c.temperature_2m) + '°' : '--°'}</span>
      <span class="ctl"><button data-up="${i}" aria-label="위로" ${i === 0 ? 'disabled' : ''}>▲</button><button data-down="${i}" aria-label="아래로" ${i === state.favs.length - 1 ? 'disabled' : ''}>▼</button><button class="del" data-del="${i}" aria-label="삭제">✕</button></span>
      <span class="handle" aria-label="드래그하여 순서 변경">≡</span></li>`;
  }).join('');
}
async function refreshFavTemps() {
  const stale = state.favs.filter(f => { const d = cacheGet(f); return !d || Date.now() - d.ts > 10 * 60 * 1000; });
  if (!stale.length) return;
  try {
    const p = new URLSearchParams({ latitude: stale.map(f => f.lat).join(','), longitude: stale.map(f => f.lon).join(','), current: 'temperature_2m,weather_code,is_day', timezone: 'auto' });
    let j = await getJSON('https://api.open-meteo.com/v1/forecast?' + p); if (!Array.isArray(j)) j = [j];
    // 국내 즐겨찾기는 기상청 초단기실황 기온으로 (실패하면 Open-Meteo 그대로)
    const kd = stale.some(f => kmaInKorea(f.lat, f.lon)) ? await Promise.all([getJSON(kmaPointsURL(), 8000), getJSON(kmaURL('now.json'), 8000)]).catch(() => null) : null;
    stale.forEach((f, i) => {
      let cur = j[i] && j[i].current ? { ...j[i].current, kma_desc: undefined } : null;
      if (cur && kd) {
        const pt = kmaNearest(kd[0], f.lat, f.lon), r = pt && kd[1] && kd[1].n === pt.n ? kd[1].p[pt.i] : null;
        if (r && typeof r[0] === 'number' && Date.now() - kmaTime(r[6] || kd[1].base) <= KMA_NOW_MAX_MS) {
          cur = { ...cur, temperature_2m: r[0], kma_desc: undefined };
          if (r[2] > 0) { cur.weather_code = kmaWmo(1, r[2], r[3] || 0); cur.kma_desc = kmaDesc(1, r[2]); }
        }
      }
      const prev = cacheGet(f);
      if (prev && prev.f && prev.f.hourly) { prev.f.current = { ...prev.f.current, ...cur }; cacheSet(f, prev); }
      else if (cur) cacheSet(f, { ts: 0, f: { current: cur } }); // ts 0 → full fetch on open
    });
    renderFavs(); renderTabs();
  } catch (e) { console.warn('fav temps failed', e); }
}
function moveFav(from, to) {
  if (to < 0 || to >= state.favs.length) return;
  const [x] = state.favs.splice(from, 1); state.favs.splice(to, 0, x); saveFavs(); renderFavs(); renderTabs();
}
function setupDrag() {
  const ul = $('#favList'); let drag = null;
  ul.addEventListener('pointerdown', e => {
    const h = e.target.closest('.handle'); if (!h) return;
    e.preventDefault(); drag = h.closest('li'); drag.classList.add('dragging'); h.setPointerCapture(e.pointerId);
  });
  ul.addEventListener('pointermove', e => {
    if (!drag) return; e.preventDefault();
    const sibs = [...ul.children].filter(x => x !== drag);
    const after = sibs.find(s => { const r = s.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (after) { if (drag.nextElementSibling !== after) ul.insertBefore(drag, after); } else if (ul.lastElementChild !== drag) ul.appendChild(drag);
  });
  const end = () => {
    if (!drag) return; drag.classList.remove('dragging'); drag = null;
    const order = [...ul.children].map(li => li.dataset.id);
    state.favs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); saveFavs(); renderFavs(); renderTabs();
  };
  ul.addEventListener('pointerup', end); ul.addEventListener('pointercancel', end);
}

/* ---------------- sheets ---------------- */
function openSheet(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
function closeSheets() { document.querySelectorAll('.sheet').forEach(s => s.hidden = true); document.body.style.overflow = ''; state.editing = false; }

/* ---------------- events ---------------- */
function bind() {
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (!b) return; const list = locations(); const i = list.findIndex(l => l.id === state.activeId), j = list.findIndex(l => l.id === b.dataset.id); select(b.dataset.id, Math.sign(j - i)); });
  $('#btnStar').addEventListener('click', toggleFav);
  $('#btnRefresh').addEventListener('click', () => load({ force: true, relocate: state.activeId === 'here' }));
  $('#btnSearch').addEventListener('click', () => {
    openSheet('#searchSheet'); $('#searchInput').value = ''; renderResults([]); $('#popular').hidden = false;
    setTimeout(() => $('#searchInput').focus(), 50);
  });
  $('#btnFavs').addEventListener('click', () => { openSheet('#favSheet'); renderFavs(); refreshFavTemps(); });
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeSheets));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSheets();
    if (!document.querySelector('.sheet:not([hidden])') && e.target.tagName !== 'INPUT') { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); }
  });
  $('#searchInput').addEventListener('input', onSearchInput);
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); $('#searchInput').blur(); clearTimeout(searchT); onSearchInput(); });
  $('#btnUseHere').addEventListener('click', () => { closeSheets(); select('here'); load({ relocate: true, force: true }); });
  $('#searchResults').addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add) {
      e.stopPropagation(); const l = searchItems[+add.dataset.add];
      if (state.favs.some(f => f.id === l.id)) { state.favs = state.favs.filter(f => f.id !== l.id); toast('즐겨찾기에서 삭제했어요'); }
      else { state.favs.push(l); toast('★ 즐겨찾기에 추가했어요'); }
      saveFavs(); renderTabs(); renderResults(searchItems); return;
    }
    const r = e.target.closest('.res'); if (r) openLocation(searchItems[+r.dataset.i]);
  });
  $('#popular').innerHTML = '<h3>주요 도시</h3><div class="chips">' + POPULAR.map((p, i) => `<button data-p="${i}">${p[0]}</button>`).join('') + '</div>';
  $('#popular').addEventListener('click', e => {
    const b = e.target.closest('[data-p]'); if (!b) return; const [n, lat, lon, sub] = POPULAR[+b.dataset.p];
    const existing = state.favs.find(f => keyOf(f.lat, f.lon) === keyOf(lat, lon));
    openLocation(existing || { id: 'p' + n, name: n, sub: sub + ', 대한민국', lat, lon });
  });
  $('#btnEdit').addEventListener('click', () => { state.editing = !state.editing; renderFavs(); });
  $('#favList').addEventListener('click', e => {
    const t = e.target;
    if (t.dataset.up != null) return moveFav(+t.dataset.up, +t.dataset.up - 1);
    if (t.dataset.down != null) return moveFav(+t.dataset.down, +t.dataset.down + 1);
    if (t.dataset.del != null) {
      const [rm] = state.favs.splice(+t.dataset.del, 1); saveFavs();
      if (state.activeId === rm.id) { state.activeId = 'here'; LS.set('wx:active', 'here'); load(); }
      renderFavs(); renderTabs(); renderHeader(active()); toast(`'${rm.name}' 삭제됨`); return;
    }
    if (state.editing || t.closest('.handle')) return;
    const li = t.closest('li'); if (li) { closeSheets(); select(li.dataset.id, 0); }
  });
  setupDrag();

  // swipe between locations
  let sx = 0, sy = 0, st = 0, ok = false;
  const main = $('#main');
  main.addEventListener('touchstart', e => { ok = !e.target.closest('[data-noswipe]') && e.touches.length === 1; if (!ok) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }, { passive: true });
  main.addEventListener('touchend', e => {
    if (!ok) return; const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - st < 700) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return; const d = cacheGet(active());
    if (!d || Date.now() - d.ts > 10 * 60 * 1000) load({ relocate: state.activeId === 'here' });
  });
  window.addEventListener('online', () => load({ force: true }));
}

/* ---------------- boot ---------------- */
function boot() {
  if (!locations().some(l => l.id === state.activeId)) state.activeId = 'here';
  bind(); renderTabs();
  load({ relocate: state.activeId === 'here', force: false });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      // 홈 화면 앱은 다시 열 때 새로 고침 없이 이어지므로, 보일 때마다 새 버전이 있는지 확인
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(e => console.warn('SW', e));
    let reloaded = false; // 새 서비스 워커가 넘겨받으면(=앱 업데이트) 한 번만 새로 고침
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadSW && !reloaded) { reloaded = true; location.reload(); } });
  }
}
boot();
})();

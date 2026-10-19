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

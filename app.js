'use strict';
/* 하늘 날씨 — static PWA using Open-Meteo (forecast, air quality, geocoding) */
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
  45: ['안개', '🌫️'], 48: ['짙은 안개', '🌫️'],
  51: ['약한 이슬비', '🌦️', '🌧️'], 53: ['이슬비', '🌦️', '🌧️'], 55: ['강한 이슬비', '🌧️'], 56: ['어는 이슬비', '🌧️'], 57: ['어는 이슬비', '🌧️'],
  61: ['약한 비', '🌦️', '🌧️'], 63: ['비', '🌧️'], 65: ['강한 비', '🌧️'], 66: ['어는 비', '🌧️'], 67: ['강한 어는 비', '🌧️'],
  71: ['약한 눈', '🌨️'], 73: ['눈', '🌨️'], 75: ['강한 눈', '❄️'], 77: ['싸락눈', '🌨️'],
  80: ['약한 소나기', '🌦️', '🌧️'], 81: ['소나기', '🌧️'], 82: ['강한 소나기', '⛈️'], 85: ['눈 소나기', '🌨️'], 86: ['강한 눈 소나기', '❄️'],
  95: ['뇌우', '⛈️'], 96: ['우박 동반 뇌우', '⛈️'], 99: ['강한 우박 뇌우', '⛈️'],
};
const wDesc = c => (WMO[c] || ['알 수 없음'])[0];
const wIcon = (c, day = 1) => { const w = WMO[c]; if (!w) return '🌡️'; return (!day && w[2]) ? w[2] : w[1]; };
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
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: 8, wind_speed_unit: 'ms',
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
async function fetchWeather(l) {
  const [f, a] = await Promise.all([getJSON(forecastURL(l.lat, l.lon)), getJSON(airURL(l.lat, l.lon)).catch(() => null)]);
  const d = { ts: Date.now(), f, a };
  cacheSet(l, d);
  return d;
}
async function reverseName(lat, lon) {
  try {
    const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ko`, 8000);
    const city = j.city || j.principalSubdivision || '';
    const name = j.locality && j.locality !== city ? j.locality : (city || '현재 위치');
    const sub = [city !== name ? city : '', j.countryName].filter(Boolean).join(', ');
    return { name, sub };
  } catch { return { name: '현재 위치', sub: '' }; }
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
    let nm = (prev && !prev.fallback && Math.abs(prev.lat - lat) < 0.01 && Math.abs(prev.lon - lon) < 0.01) ? prev : null;
    if (!nm) nm = await reverseName(lat, lon);
    state.here = { lat, lon, name: nm.name, sub: nm.sub, fallback: false };
  } catch (e) {
    if (!state.here || state.here.fallback) {
      state.here = { ...SEOUL, fallback: true };
      toast(e && e.code === 1 ? '위치 권한이 없어 서울 날씨를 보여드려요' : '위치를 확인할 수 없어 서울 날씨를 보여드려요');
    }
  }
  LS.set('wx:here', state.here);
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
  $('#curIcon').textContent = wIcon(c.weather_code, c.is_day);
  $('#curTemp').textContent = r0(c.temperature_2m) + '°';
  $('#curDesc').textContent = wDesc(c.weather_code);
  $('#curHL').textContent = `최고 ${r0(D.temperature_2m_max[0])}° · 최저 ${r0(D.temperature_2m_min[0])}° · 체감 ${r0(c.apparent_temperature)}°`;

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

  // air quality
  const ac = a && a.current;
  if (ac) {
    // daily max of remaining hours today (forecast)
    const box = (kind, name) => {
      const v = ac[kind]; const L = pmLevel(kind, v);
      return `<div class="aq"><div class="n">${name}</div><div class="lv lv-${L ? L.lv : 0}">${L ? `<span class="dot"></span>${L.label}` : '정보 없음'}</div><div class="val">${v == null ? '-' : Math.round(v)} µg/m³</div></div>`;
    };
    $('#air').innerHTML = box('pm10', '미세먼지 PM10') + box('pm2_5', '초미세먼지 PM2.5');
  } else $('#air').innerHTML = '<div class="muted" style="margin:6px 0;grid-column:1/-1">대기질 정보를 불러오지 못했어요</div>';

  // 7-day
  const n = Math.min(7, D.time.length);
  const lo = Math.min(...D.temperature_2m_min.slice(0, n)), hi = Math.max(...D.temperature_2m_max.slice(0, n)); const span = Math.max(1, hi - lo);
  let dl = '';
  for (let i = 0; i < n; i++) {
    const [y, m, dd] = D.time[i].split('-').map(Number); const dow = new Date(y, m - 1, dd).getDay();
    const name = i === 0 ? '오늘' : i === 1 ? '내일' : DOW[dow];
    const mn = D.temperature_2m_min[i], mx = D.temperature_2m_max[i]; const pp = D.precipitation_probability_max[i];
    dl += `<li><span class="d"${dow === 0 && i > 1 ? ' style="color:#e5484d"' : dow === 6 && i > 1 ? ' style="color:#3b82f6"' : ''}>${name}</span><span class="ic">${wIcon(D.weather_code[i], 1)}</span><span class="pp">${pp >= 10 ? pp + '%' : ''}</span>`
      + `<span class="lo">${r0(mn)}°</span><span class="rng"><i style="left:${(mn - lo) / span * 100}%;right:${(hi - mx) / span * 100}%"></i></span><span class="hi">${r0(mx)}°</span></li>`;
  }
  $('#daily').innerHTML = dl;
  $('#updated').textContent = `${fmtTime(d.ts)} 업데이트`;
}
function renderEmpty() {
  ['#hourly', '#details', '#air', '#daily'].forEach(s => $(s).innerHTML = '');
  $('#curTemp').textContent = '--°'; $('#curDesc').innerHTML = '&nbsp;'; $('#curHL').innerHTML = '&nbsp;'; $('#curIcon').textContent = '⏳';
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
      <div class="grow"><div class="nm">${esc(f.name)}</div><div class="ad">${esc(f.sub || '')}${c ? ' · ' + wDesc(c.weather_code) : ''}</div></div>
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
    stale.forEach((f, i) => {
      const prev = cacheGet(f);
      if (prev && prev.f && prev.f.hourly) { prev.f.current = { ...prev.f.current, ...j[i].current }; cacheSet(f, prev); }
      else if (j[i]) cacheSet(f, { ts: 0, f: { current: j[i].current } }); // ts 0 → full fetch on open
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
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
boot();
})();

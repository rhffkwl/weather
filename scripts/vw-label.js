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

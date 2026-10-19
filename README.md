# 날씨

아이폰용 날씨 웹앱 (https://rhffkwl.github.io/weather/) + Scriptable 홈 화면 위젯 (`widget/`).

- 예보: **국내는 기상청, 해외는 Open-Meteo** 자동 전환.
  - `.github/workflows/kma.yml`: 매시 15분 `scripts/fetch_kma.py`가 `data/kma/points.json`의 대표 격자점(시군구별 + 빈 곳 보충, 약 257개)에 대해
    기상청 초단기실황(매시) · 단기예보(02·05·…·23시 발표) · 중기육상/기온예보(06·18시)를 받아 `data/kma/now.json`, `hist.json`(어제 같은 시각 비교용),
    `f/<nx>_<ny>.json`, `mid.json`으로 저장(변경 시에만 커밋). 새 발표가 없으면 호출하지 않음. 호출 수는 `data/kma/meta.json`에 기록하고 오퍼레이션별 하루 9,500회를 넘기지 않음.
  - 앱·위젯: 위치가 국내이고 25km 안에 대표 격자점이 있으면 기상청 값(현재 기온·습도·바람·강수형태, 시간별 기온·강수확률·하늘, 일별 최저/최고·날씨)으로 덮어씀.
    기상청 자료가 없거나 오래됐으면(실황 3시간, 단기 12시간, 중기 36시간) Open-Meteo 그대로. 자외선·일출몰·체감온도 보정, 해외 예보는 Open-Meteo (CC BY 4.0).
  - 클라이언트 공통 코드: `scripts/kma-client.js` (app.js와 widget/weather.js에 같은 블록이 들어 있음). 격자점 표 재생성: `python3 scripts/build_kma_points.py`.
  - 인증키는 에어코리아와 같은 공공데이터포털 키(Actions secret `AIRKOREA_SERVICE_KEY`)를 씀. 클라이언트에는 키가 없음.
- 미세먼지(PM10/PM2.5): 에어코리아(한국환경공단) 실시간 측정값 — 가장 가까운 측정소.
  측정값이 3시간 넘게 오래됐거나 없으면 Open-Meteo 모델 값을 「예측값」으로 표시.
  - `.github/workflows/airkorea.yml`: 매시 20분 GitHub Actions가 `scripts/fetch_airkorea.py`로
    `getCtprvnRltmMesureDnsty`(sidoName=전국)를 호출해 `data/airkorea.json`을 갱신(변경 시에만 커밋).
    서비스 키는 저장소 Actions secret `AIRKOREA_SERVICE_KEY`에만 있고 공개 파일에는 없습니다.
  - `data/stations.json`: 측정소 좌표. 에어코리아 웹 측정소 목록의 주소를 OpenStreetMap(Nominatim/Photon)으로
    지오코딩한 근사 좌표(© OpenStreetMap contributors). 측정소정보 API(MsrstnInfoInqireSvc)가 승인되면 매일 03시에 공식 좌표로 교체.
  - 실시간 자료는 확정되지 않은 값으로 실제 대기오염도와 다를 수 있습니다.

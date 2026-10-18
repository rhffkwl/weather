# 날씨

아이폰용 날씨 웹앱 (https://rhffkwl.github.io/weather/) + Scriptable 홈 화면 위젯 (`widget/`).

- 예보: Open-Meteo (CC BY 4.0)
- 미세먼지(PM10/PM2.5): 에어코리아(한국환경공단) 실시간 측정값 — 가장 가까운 측정소.
  측정값이 3시간 넘게 오래됐거나 없으면 Open-Meteo 모델 값을 「예측값」으로 표시.
  - `.github/workflows/airkorea.yml`: 매시 20분 GitHub Actions가 `scripts/fetch_airkorea.py`로
    `getCtprvnRltmMesureDnsty`(sidoName=전국)를 호출해 `data/airkorea.json`을 갱신(변경 시에만 커밋).
    서비스 키는 저장소 Actions secret `AIRKOREA_SERVICE_KEY`에만 있고 공개 파일에는 없습니다.
  - `data/stations.json`: 측정소 좌표. 에어코리아 웹 측정소 목록의 주소를 OpenStreetMap(Nominatim/Photon)으로
    지오코딩한 근사 좌표(© OpenStreetMap contributors). 측정소정보 API(MsrstnInfoInqireSvc)가 승인되면 매일 03시에 공식 좌표로 교체.
  - 실시간 자료는 확정되지 않은 값으로 실제 대기오염도와 다를 수 있습니다.

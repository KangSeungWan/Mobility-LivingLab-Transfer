# 통학길 비교 · 대전 (C.A.W)

DSC공유대학 모빌리티리빙랩 1조 **C.A.W**의 프로젝트입니다.
버스·지하철·타슈·택시를 조합한 경로마다 **대기·환승 시간을 포함한 실제 도착 시각과 요금**을 비교합니다.

첫 구간: 충남대 공과대학 3호관 → 대전역 (월평역 환승)

## 폴더

| 폴더 | 내용 | 실행 |
|---|---|---|
| `cnu-route-web/` | 실시간 API 웹사이트 (버스 도착정보, 타슈, 카카오 길찾기·장소 검색) | Node.js 18+ · `npm start` |
| `cnu-route-site/` | API 없는 계산기 (출발 시각 입력 → A~E 도착·요금) | `index.html` 바로 열기 |
| `prototypes/` | 설문용 프로토타입, 오프라인 계산기 | 브라우저로 열기 |

실시간 버전 사용법은 [`cnu-route-web/README.md`](cnu-route-web/README.md)를 보세요.
API 키는 `cnu-route-web/.env.example`을 복사해 `.env`로 만들어 넣으며, 저장소에는 포함되지 않습니다.

## 진행 상황

- [x] 설문용 프로토타입, 계산기
- [x] 실시간 웹사이트: 공공데이터·카카오·타슈 API 연결 확인
- [ ] 108번 월평역 방면 정류장 확정
- [ ] 대전교통공사 열차시각표 연결 (현재 10분 간격 가정)
- [ ] 카카오 지도(JavaScript 키), 배포
- [ ] 대전 전역 확대 (가까운 환승 거점 자동 선택)

## 데이터 출처와 이용 조건

이 저장소에는 API 키와 외부 데이터 원본이 포함되어 있지 않습니다. 실행 시 각 기관의 API를 호출하며, 이용 조건은 각 제공처를 따릅니다.

- 국토교통부 TAGO 버스도착정보·버스정류소정보, 대전광역시 정류소별 도착정보, 대전교통공사 — [공공데이터포털](https://www.data.go.kr)
- 카카오 로컬·카카오모빌리티 길찾기·카카오맵 — [Kakao Developers](https://developers.kakao.com) 이용약관
- 타슈 대여소 정보 — 대전광역시 공영자전거 타슈 Open API
- 지도 (카카오 키가 없을 때) — © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), [Leaflet](https://leafletjs.com) (BSD-2-Clause)
- 글꼴 — Pretendard, Noto Sans KR (SIL Open Font License), CDN으로 불러옴

## 주의

화면의 시간·요금은 실시간 데이터와 가정값(도보·타슈·역내 이동, 지하철 배차)을 조합한 **추정치**입니다.

## 라이선스

코드: [MIT](LICENSE) · 위 외부 데이터·서비스·글꼴은 각 제공처의 조건을 따릅니다.

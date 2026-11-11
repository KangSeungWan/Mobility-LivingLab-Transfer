통학길 비교 웹사이트 — 올리는 방법

이 폴더(index.html, favicon.svg)만 있으면 됩니다. 서버나 API 키가 필요 없습니다.

[가장 쉬운 방법] Netlify Drop · 회원가입 후 1분
1. https://app.netlify.com/drop 접속 (GitHub나 이메일로 무료 가입)
2. 이 폴더(cnu-route-site)를 화면에 끌어다 놓기
3. 바로 https://○○○.netlify.app 주소가 생깁니다 → 이 주소를 공유
4. Site configuration → Change site name 에서 주소 앞부분을 바꿀 수 있습니다 (예: caw-route)
   ※ 가입 없이 올리면 1시간 뒤 사라지니, 꼭 로그인한 상태로 올리세요.
5. 수정 후 다시 올릴 때: Deploys 탭 → 폴더를 다시 끌어다 놓기 (주소는 그대로)

[다른 방법] GitHub Pages
저장소에 index.html, favicon.svg 업로드 → Settings → Pages → Branch: main / root → Save
→ https://아이디.github.io/저장소이름/

수정하기
- index.html 안의 DEFAULTS 부분에서 기본값(배차간격, 도보·타슈 시간, 요금)을 바꾸면 모든 사람에게 적용됩니다.
- 화면 맨 아래 '계산 기준값'에서 바꾼 값은 그 사람 브라우저에만 저장됩니다.

# 같이 듣기

유튜브 링크로 누구나 플레이리스트에 곡을 추가하고, 같은 재생 위치로 동기화해서 듣는 페이지입니다. 별도 서버 없이 GitHub Pages(정적 호스팅) + Firebase Realtime Database(공유 상태 저장소)로 동작합니다.

내부 사용자끼리만 쓰는 것을 전제로 접근 제어는 넣지 않았습니다. **배포된 URL을 외부에 공개하지 마세요.**

## 1. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 → "프로젝트 추가" → 이름 입력 후 생성 (Google Analytics는 꺼도 됩니다)
2. 왼쪽 메뉴 **빌드 → Realtime Database** → "데이터베이스 만들기"
   - 위치는 가까운 리전 선택
   - 보안 규칙은 "테스트 모드"로 시작해도 되고, 바로 아래 3단계 규칙으로 덮어써도 됩니다
3. 생성된 데이터베이스의 **규칙(Rules)** 탭을 열고, 이 저장소의 `database.rules.json` 내용을 그대로 붙여넣은 뒤 "게시(Publish)"

## 2. 웹 앱 등록 & config 값 받기

1. Firebase 콘솔 좌측 상단 톱니바퀴 → **프로젝트 설정 → 일반**
2. "내 앱" 섹션에서 웹 아이콘(`</>`) 클릭 → 앱 닉네임 입력 (호스팅 연결 단계는 건너뛰어도 됨)
3. 표시되는 `firebaseConfig` 객체 값을 복사해서, 이 저장소의 `firebase-config.js` 안의 `YOUR_...` 부분을 실제 값으로 교체

```js
export const firebaseConfig = {
  apiKey: "실제 값",
  authDomain: "실제 값",
  databaseURL: "실제 값", // Realtime Database 탭에 표시되는 URL과 일치해야 함
  projectId: "실제 값",
  storageBucket: "실제 값",
  messagingSenderId: "실제 값",
  appId: "실제 값",
};
```

> 이 값들은 공개 저장소에 커밋해도 안전합니다. Firebase 보안은 이 config를 숨기는 게 아니라 Realtime Database 규칙으로 제어합니다.

## 3. 로컬에서 확인

빌드 과정이 없는 순수 HTML/JS라 아무 정적 서버로 열면 됩니다 (`file://`로 직접 열면 일부 브라우저 정책 때문에 오작동할 수 있어 로컬 서버 사용 권장).

```bash
npx serve .
# 또는
python -m http.server 8000
```

브라우저 탭을 2개 이상 열어서 한쪽에서 곡을 추가/스킵/일시정지했을 때 다른 쪽에도 반영되는지 확인하세요.

## 4. GitHub Pages 배포

1. GitHub에서 새 저장소 생성 (Public 또는 Private 모두 가능, Private면 Pages는 GitHub Pro/Team 이상 필요)
2. 이 폴더를 그 저장소에 push
3. 저장소 **Settings → Pages → Build and deployment → Source**를 "Deploy from a branch"로 선택, 브랜치는 `master` / `/(root)` 선택 → Save
4. 1~2분 후 `https://<계정>.github.io/<저장소명>/` 에서 접속 가능

## 데이터 구조 (Realtime Database)

```
/queue/{pushId}: { videoId, title, addedAt }
/nowPlaying: { queueId, videoId, title, state: "playing"|"paused"|"idle", startedAt, positionAtStart }
```

- `state`가 `idle`일 때 새 곡을 추가하면 대기열을 거치지 않고 바로 재생됩니다.
- 재생 위치 동기화는 폴링이 아니라 `nowPlaying` 값 변경을 실시간 구독(`onValue`)해서 이루어지며, 서버 시각(`​.info/serverTimeOffset`)을 기준으로 각자 위치를 계산합니다.
- 곡이 끝나거나 "다음 곡"을 눌렀을 때 여러 사람이 동시에 눌러도 중복 스킵되지 않도록 Firebase transaction으로 처리합니다.

## 알아둘 점

- 브라우저 자동재생 정책 때문에 페이지에 처음 들어오면 "참여하기" 버튼을 한 번 눌러야 재생이 시작됩니다.
- 접근 제어가 없으므로, 이 데이터베이스 규칙과 배포 URL은 내부 인원에게만 공유하세요.

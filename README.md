# 같이 듣기

유튜브 링크로 누구나 플레이리스트에 곡을 추가하고, 같은 재생 위치로 동기화해서 듣는 페이지입니다. 별도 서버 없이 GitHub Pages(정적 호스팅) + Firebase Realtime Database(공유 상태 저장소)로 동작합니다.

내부 사용자끼리만 쓰는 것을 전제로 접근 제어는 넣지 않았습니다. **배포된 URL을 외부에 공개하지 마세요.**

## 1. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 → "프로젝트 추가" → 이름 입력 후 생성 (Google Analytics는 꺼도 됩니다)
2. 왼쪽 메뉴 **빌드 → Realtime Database** → "데이터베이스 만들기"
   - 위치는 가까운 리전 선택
   - 보안 규칙은 "테스트 모드"로 시작해도 되고, 바로 아래 3단계 규칙으로 덮어써도 됩니다
3. 생성된 데이터베이스의 **규칙(Rules)** 탭을 열고, 이 저장소의 `database.rules.json` 내용을 그대로 붙여넣은 뒤 "게시(Publish)"
4. 왼쪽 메뉴 **빌드 → Authentication** → "시작하기" → **Sign-in method** 탭에서 "익명(Anonymous)" 제공업체를 활성화
   - `queue`/`nowPlaying`/`chat`/`presence`/`skipVotes` 쓰기 규칙이 모두 로그인(`auth != null`)을 요구하기 때문에, 이 설정 없이는 곡 추가/재생 제어/채팅/접속자 표시/스킵 투표가 전부 permission-denied로 실패합니다. (`presence`/`skipVotes`는 추가로 `auth.uid`가 본인 항목인지까지 검증합니다.)

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
/chat/{pushId}: { text, sentAt }
/presence/{clientId}: true
/skipVotes/{queueId}/{clientId}: true
```

- 채팅은 별도 로그인/식별 없이 모두 "익명"으로 표시됩니다. 발신자를 구분하지 않습니다.
- Realtime Database엔 자체 TTL(자동 만료) 기능이 없어서, 클라이언트가 메시지를 보낼 때마다 `sentAt` 기준 1시간이 지난 채팅을 함께 지웁니다(`chat.js`의 `pruneOldMessages`). 아무도 채팅을 보내지 않으면 정리도 미뤄지지만, 화면엔 어차피 최근 10개만 보이므로 사용에는 영향이 없습니다.
- `clientId`는 페이지 로드 시 자동으로 이루어지는 Firebase 익명 인증(`signInAnonymously`)의 `auth.uid`를 그대로 사용합니다. `presence`/`skipVotes`는 각 항목이 "본인 uid로만 쓰기 가능"하도록 규칙으로 검증되어, 다른 사람 행세로 접속자 수나 스킵 투표를 조작할 수 없습니다. 다만 완료된 투표를 정리(삭제)하는 것은 어느 클라이언트나 할 수 있도록 예외를 뒀습니다.
- `presence`는 각 브라우저 탭이 페이지에 접속해 있는 동안만 존재하는 항목입니다. `onDisconnect()`로 등록해두기 때문에 탭을 닫거나 연결이 끊기면 Firebase가 자동으로 지웁니다. 같은 사람이 탭을 여러 개 열면 그만큼 접속자 수에 중복으로 잡힙니다.
- "다음 곡" 버튼은 즉시 스킵하지 않고 **투표**로 동작합니다. 현재 접속자 수의 과반(`floor(접속자수/2) + 1`)이 투표하면 자동으로 다음 곡으로 넘어가고, 그 순간 해당 곡의 `skipVotes` 기록은 삭제됩니다. 여러 클라이언트가 동시에 과반 조건을 감지해도 `nowPlaying`에 대한 Firebase transaction으로 중복 스킵을 막습니다. 투표 도중 탭을 닫으면 `onDisconnect()`로 해당 표도 함께 정리됩니다.
- `database.rules.json`에 `chat`/`presence`/`skipVotes` 경로 규칙이 있습니다. **Firebase 콘솔의 Realtime Database → Rules 탭에 이 파일 내용을 다시 붙여넣고 "게시(Publish)"** 하지 않으면 새로 추가된 기능들의 쓰기가 거부됩니다(기존 재생 동기화 기능은 영향 없음). `presence`/`skipVotes`는 익명 인증이 켜져 있어야 정상 동작합니다(위 1단계 4번 참고).

- `state`가 `idle`일 때 새 곡을 추가하면 대기열을 거치지 않고 바로 재생됩니다.
- 재생 위치 동기화는 폴링이 아니라 `nowPlaying` 값 변경을 실시간 구독(`onValue`)해서 이루어지며, 서버 시각(`​.info/serverTimeOffset`)을 기준으로 각자 위치를 계산합니다.
- 곡이 끝나거나 스킵 투표가 과반을 넘었을 때 여러 사람의 클라이언트가 동시에 다음 곡으로 넘기려 해도 중복 스킵되지 않도록 Firebase transaction으로 처리합니다.

## 알아둘 점

- 브라우저 자동재생 정책 때문에 페이지에 처음 들어오면 "참여하기" 버튼을 한 번 눌러야 재생이 시작됩니다.
- 접근 제어가 없으므로, 이 데이터베이스 규칙과 배포 URL은 내부 인원에게만 공유하세요.

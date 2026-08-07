import { db, authReady } from "./firebase-init.js";
import {
  ref,
  onValue,
  onDisconnect,
  set,
  remove,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";
import { advanceToNext } from "./app.js";

const viewerCountEl = document.getElementById("viewer-count");
const skipVoteBtn = document.getElementById("skip-btn");

let viewerCount = 0;
let currentQueueId = null;
let allVotes = {};
let skipping = false;
let connected = false;
let joined = false;
let voteDisconnect = null;

// 익명 로그인이 authReady로 늦게 끝나더라도 그 사이의 클릭을 놓치지 않도록,
// 리스너 자체는 로그인 완료와 무관하게 먼저 붙여 top-level joined 플래그만 세워둔다.
document.getElementById("join-btn").addEventListener("click", () => {
  joined = true;
  onJoined();
});
let onJoined = () => {};

// presence/skipVotes 쓰기 규칙이 auth.uid === $clientId를 요구하므로,
// 익명 로그인이 끝나 uid가 확정된 뒤에야 clientId를 정하고 나머지 로직을 시작한다.
authReady.then((clientId) => {
  const myPresenceRef = ref(db, `presence/${clientId}`);

  // 현재 곡의 내 투표에 onDisconnect(remove)를 걸어둔다. 탭이 그대로 닫히면
  // 투표가 남아 다음 사람들의 과반수 계산을 오염시키므로, 곡이 바뀔 때마다
  // 이전 등록은 취소하고 지금 곡 기준으로 다시 건다.
  function updateVoteDisconnect() {
    if (!connected) return;
    if (voteDisconnect) {
      voteDisconnect.cancel();
      voteDisconnect = null;
    }
    if (currentQueueId) {
      const voteRef = ref(db, `skipVotes/${currentQueueId}/${clientId}`);
      voteDisconnect = onDisconnect(voteRef);
      voteDisconnect.remove();
    }
  }

  // "참여하기"를 눌러 실제로 같이 듣기 시작한 사람만 presence(=과반수 분모)에
  // 잡히도록, 연결 여부와 별개로 join 여부도 함께 확인한다.
  function updatePresence() {
    if (!connected || !joined) return;
    set(myPresenceRef, true);
    onDisconnect(myPresenceRef).remove();
  }
  onJoined = updatePresence;

  // --- 접속자 수 (presence) ---
  onValue(ref(db, ".info/connected"), (snap) => {
    connected = snap.val() === true;
    if (!connected) return;
    updatePresence();
    updateVoteDisconnect();
  });

  onValue(ref(db, "presence"), (snap) => {
    viewerCount = snap.size;
    viewerCountEl.textContent = `현재 ${viewerCount}명 접속 중`;
    render();
  });

  // --- 현재 재생 중인 곡 추적 ---
  onValue(ref(db, "nowPlaying"), (snap) => {
    const np = snap.val();
    currentQueueId = np && np.state !== "idle" ? np.queueId : null;
    updateVoteDisconnect();
    render();
  });

  // --- 스킵 투표 ---
  onValue(ref(db, "skipVotes"), (snap) => {
    allVotes = snap.val() || {};
    render();
  });

  // 과반(+1)이 아니라 절반을 버림한 값을 기준으로 한다. 다만 viewerCount가
  // 0/1일 때 결과가 0이 되면 투표 없이도 즉시 스킵되어 버리므로 최소 1은 보장한다.
  function majorityThreshold() {
    return Math.max(1, Math.floor(viewerCount / 2));
  }

  function currentVotes() {
    return (currentQueueId && allVotes[currentQueueId]) || {};
  }

  function render() {
    if (!currentQueueId) {
      skipVoteBtn.disabled = true;
      skipVoteBtn.textContent = "다음 곡 투표";
      return;
    }

    const votes = currentVotes();
    const count = Object.keys(votes).length;
    const majority = majorityThreshold();
    const myVoted = !!votes[clientId];

    skipVoteBtn.disabled = false;
    skipVoteBtn.textContent = myVoted
      ? `투표 취소 (${count}/${majority})`
      : `다음 곡 투표 (${count}/${majority})`;

    maybeSkip(count, majority);
  }

  async function maybeSkip(count, majority) {
    if (skipping || !currentQueueId || count < majority) return;
    skipping = true;
    try {
      await advanceToNext(currentQueueId);
    } finally {
      skipping = false;
    }
  }

  skipVoteBtn.addEventListener("click", async () => {
    if (!currentQueueId) return;
    const voteRef = ref(db, `skipVotes/${currentQueueId}/${clientId}`);
    if (currentVotes()[clientId]) {
      await remove(voteRef);
    } else {
      await set(voteRef, true);
    }
  });
});

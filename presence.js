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
let voteDisconnect = null;

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

  // --- 접속자 수 (presence) ---
  onValue(ref(db, ".info/connected"), (snap) => {
    connected = snap.val() === true;
    if (!connected) return;
    set(myPresenceRef, true);
    onDisconnect(myPresenceRef).remove();
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

  function majorityThreshold() {
    return Math.floor(Math.max(viewerCount, 1) / 2) + 1;
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

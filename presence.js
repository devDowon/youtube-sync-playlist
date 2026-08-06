import { db } from "./firebase-init.js";
import {
  ref,
  onValue,
  onDisconnect,
  set,
  remove,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";
import { advanceToNext } from "./app.js";

const clientId = crypto.randomUUID();
const myPresenceRef = ref(db, `presence/${clientId}`);

const viewerCountEl = document.getElementById("viewer-count");
const skipVoteBtn = document.getElementById("skip-btn");

let viewerCount = 0;
let currentQueueId = null;
let allVotes = {};
let skipping = false;

// --- 접속자 수 (presence) ---
onValue(ref(db, ".info/connected"), (snap) => {
  if (snap.val() !== true) return;
  set(myPresenceRef, true);
  onDisconnect(myPresenceRef).remove();
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

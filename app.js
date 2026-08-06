import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  push,
  set,
  update,
  remove,
  runTransaction,
  query,
  orderByKey,
  limitToFirst,
  get,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const queueRef = ref(db, "queue");
const nowPlayingRef = ref(db, "nowPlaying");

// --- 서버 시각 보정 ---
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  serverOffset = snap.val() || 0;
});
function serverNow() {
  return Date.now() + serverOffset;
}

// --- 상태 ---
let player = null;
let playerReady = false;
let joined = false;
let latestNowPlaying = null;

const DRIFT_TOLERANCE_SEC = 1.5;

// --- YouTube IFrame API ---
function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = resolve;
  });
}

async function createPlayer(initialVideoId) {
  await loadYouTubeAPI();
  return new Promise((resolve) => {
    player = new YT.Player("player", {
      height: "360",
      width: "640",
      videoId: initialVideoId || undefined,
      playerVars: { playsinline: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          resolve(player);
        },
        onStateChange: onPlayerStateChange,
      },
    });
  });
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED && latestNowPlaying && latestNowPlaying.queueId) {
    advanceToNext(latestNowPlaying.queueId);
  }
}

function getCurrentVideoId() {
  try {
    return player.getVideoData().video_id;
  } catch {
    return null;
  }
}

// --- 재생 동기화 ---
function targetPosition(np) {
  if (!np || np.state === "idle") return 0;
  if (np.state === "paused") return np.positionAtStart || 0;
  return (np.positionAtStart || 0) + (serverNow() - np.startedAt) / 1000;
}

function syncPlayback(np) {
  if (!player || !playerReady) return;

  if (!np || np.state === "idle") {
    player.stopVideo();
    return;
  }

  const target = Math.max(0, targetPosition(np));

  if (getCurrentVideoId() !== np.videoId) {
    player.loadVideoById({ videoId: np.videoId, startSeconds: target });
    if (np.state === "paused") {
      setTimeout(() => player.pauseVideo(), 300);
    }
    return;
  }

  const drift = Math.abs(player.getCurrentTime() - target);
  if (drift > DRIFT_TOLERANCE_SEC) {
    player.seekTo(target, true);
  }

  const state = player.getPlayerState();
  if (np.state === "playing" && state !== YT.PlayerState.PLAYING) {
    player.playVideo();
  }
  if (np.state === "paused" && state !== YT.PlayerState.PAUSED) {
    player.pauseVideo();
  }
}

// --- 컨트롤 ---
async function togglePlayPause() {
  const np = latestNowPlaying;
  if (!np || np.state === "idle") return;

  if (np.state === "playing") {
    const pos = Math.max(0, targetPosition(np));
    await update(nowPlayingRef, { state: "paused", positionAtStart: pos });
  } else {
    await update(nowPlayingRef, { state: "playing", startedAt: serverNow() });
  }
}

async function advanceToNext(expectedQueueId) {
  const snap = await get(query(queueRef, orderByKey(), limitToFirst(1)));
  let nextEntry = null;
  snap.forEach((child) => {
    nextEntry = { id: child.key, ...child.val() };
  });

  const result = await runTransaction(nowPlayingRef, (current) => {
    const currentQueueId = current ? current.queueId : undefined;
    if (currentQueueId !== expectedQueueId) return; // 이미 다른 클라이언트가 처리함

    if (!nextEntry) {
      return { state: "idle", queueId: null, videoId: null, title: null, startedAt: null, positionAtStart: 0 };
    }
    return {
      queueId: nextEntry.id,
      videoId: nextEntry.videoId,
      title: nextEntry.title || nextEntry.videoId,
      state: "playing",
      startedAt: serverNow(),
      positionAtStart: 0,
    };
  });

  if (result.committed && nextEntry) {
    await remove(ref(db, `queue/${nextEntry.id}`));
  }
}

// --- 곡 추가 ---
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchTitle(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        "https://www.youtube.com/watch?v=" + videoId
      )}&format=json`
    );
    if (!res.ok) throw new Error("oembed failed");
    const data = await res.json();
    return data.title || videoId;
  } catch {
    return videoId;
  }
}

async function addSongFromInput() {
  const input = document.getElementById("link-input");
  const url = input.value.trim();
  const videoId = extractVideoId(url);
  if (!videoId) {
    alert("유효한 유튜브 링크가 아니에요.");
    return;
  }
  input.value = "";

  const title = await fetchTitle(videoId);
  const newRef = push(queueRef);
  await set(newRef, { videoId, title, addedAt: serverNow() });

  // 대기열이 비어 있던 상태(idle)면 바로 재생으로 승격
  const result = await runTransaction(nowPlayingRef, (current) => {
    if (current && current.state && current.state !== "idle") return; // 이미 뭔가 재생 중
    return {
      queueId: newRef.key,
      videoId,
      title,
      state: "playing",
      startedAt: serverNow(),
      positionAtStart: 0,
    };
  });

  if (result.committed) {
    await remove(newRef);
  }
}

// --- 렌더링 ---
function renderNowPlaying(np) {
  const titleEl = document.getElementById("now-playing-title");
  const playPauseBtn = document.getElementById("play-pause-btn");
  const skipBtn = document.getElementById("skip-btn");

  if (!np || np.state === "idle" || !np.videoId) {
    titleEl.textContent = "재생 중인 곡 없음";
    playPauseBtn.disabled = true;
    skipBtn.disabled = true;
    playPauseBtn.textContent = "재생";
    return;
  }

  titleEl.textContent = np.title || np.videoId;
  playPauseBtn.disabled = false;
  skipBtn.disabled = false;
  playPauseBtn.textContent = np.state === "playing" ? "일시정지" : "재생";
}

function renderQueue(queueVal) {
  const list = document.getElementById("queue-list");
  list.innerHTML = "";
  if (!queueVal) return;
  Object.keys(queueVal)
    .sort()
    .forEach((key) => {
      const li = document.createElement("li");
      li.textContent = queueVal[key].title || queueVal[key].videoId;
      list.appendChild(li);
    });
}

// --- Firebase 구독 ---
onValue(nowPlayingRef, (snap) => {
  latestNowPlaying = snap.val();
  renderNowPlaying(latestNowPlaying);
  if (joined) syncPlayback(latestNowPlaying);
});

onValue(query(queueRef, orderByKey()), (snap) => {
  renderQueue(snap.val());
});

// --- 이벤트 바인딩 ---
document.getElementById("join-btn").addEventListener("click", async () => {
  document.getElementById("join-overlay").style.display = "none";
  await createPlayer(latestNowPlaying ? latestNowPlaying.videoId : undefined);
  joined = true;
  syncPlayback(latestNowPlaying);
  setInterval(() => {
    if (joined) syncPlayback(latestNowPlaying);
  }, 3000);
});

document.getElementById("play-pause-btn").addEventListener("click", togglePlayPause);

document.getElementById("skip-btn").addEventListener("click", () => {
  if (latestNowPlaying && latestNowPlaying.queueId) {
    advanceToNext(latestNowPlaying.queueId);
  }
});

document.getElementById("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  addSongFromInput();
});

import { db, authReady } from "./firebase-init.js";
import {
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
  serverTimestamp,
  get,
  onDisconnect,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

const queueRef = ref(db, "queue");
const nowPlayingRef = ref(db, "nowPlaying");
const ADD_COOLDOWN_MS = 60 * 1000;
function lastAddRef(uid) {
  return ref(db, `lastAdd/${uid}`);
}

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
const MAX_DURATION_SEC = 20 * 60;
const ADVANCING_STUCK_MS = 8000;

// syncPlayback()이 스스로 player를 조작할 때 그로 인해 발생하는 onStateChange를
// "로컬 사용자가 직접 조작함"으로 오인하지 않도록 잠깐 표시해두는 플래그
let syncing = false;
let syncingTimer = null;
function markSyncing() {
  syncing = true;
  clearTimeout(syncingTimer);
  syncingTimer = setTimeout(() => {
    syncing = false;
  }, 1500);
}

// --- YouTube IFrame API ---
function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }

    let resolved = false;
    window.onYouTubeIframeAPIReady = () => {
      resolved = true;
      resolve();
    };

    function appendScriptTag() {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }

    appendScriptTag();

    // 네트워크 순간 끊김 등으로 스크립트 로드가 실패하면 onYouTubeIframeAPIReady가
    // 영원히 안 불려서 플레이어 생성 전체가 조용히 멈춰버린다(검은 화면 + 아무 반응
    // 없음). 그러면 새로고침으로 우연히 성공할 때까지 기다리는 수밖에 없었으므로,
    // 일정 시간 안에 준비되지 않으면 스스로 한 번 더 시도한다.
    setTimeout(() => {
      if (resolved) return;
      appendScriptTag();
    }, 5000);
  });
}

async function createPlayer(initialVideoId) {
  await loadYouTubeAPI();
  return new Promise((resolve) => {
    player = new YT.Player("player", {
      height: "360",
      width: "640",
      videoId: initialVideoId || undefined,
      // 쿠키를 심지 않는 youtube-nocookie.com 도메인으로 임베드한다.
      host: "https://www.youtube-nocookie.com",
      // 탐색바/일시정지 등 네이티브 컨트롤을 통째로 숨겨서 각자 임의로 재생을
      // 조작(시간 이동, 정지)하지 못하게 한다. 키보드 단축키(스페이스바 정지 등)도
      // 같은 이유로 막는다. 소리 켜기는 별도의 커스텀 버튼(unmute-btn)으로 처리한다.
      // 컨트롤을 숨기면 CC(자막) 버튼도 같이 사라져 시청자가 직접 끌 수 없으므로,
      // 각자의 유튜브 계정에 저장된 자막 선호와 무관하게 기본값을 항상 꺼둔다.
      playerVars: { playsinline: 1, controls: 0, disablekb: 1, cc_load_policy: 0 },
      events: {
        onReady: () => {
          playerReady = true;
          // 입장 시점에 이미 재생 중인 곡이 있으면 "참여하기" 클릭 흐름 안에서
          // 바로 재생이 걸리므로 자동재생이 막히지 않는다. 반대로 아직 재생 중인
          // 곡이 없어 영상 없이 플레이어를 만든 경우엔, 나중에 누군가 곡을 추가할 때
          // Firebase 리스너(비동기 콜백, 사용자 제스처 밖)가 재생을 트리거하게 되어
          // 브라우저가 자동재생을 막아버리므로, 그 경우에만 음소거로 시작한다.
          if (!initialVideoId) {
            player.mute();
          }
          resolve(player);
        },
        onStateChange: onPlayerStateChange,
      },
    });
  });
}

function onPlayerStateChange(event) {
  // syncPlayback()이 스스로 seekTo/playVideo/pauseVideo/loadVideoById를 호출해서 생긴 이벤트는 무시.
  // 드리프트 보정으로 영상 끝 근처까지 seekTo했을 때 플레이어가 곧장 ENDED를 쏘는 경우가 있는데,
  // 이걸 자연 종료로 오인해 곡을 강제로 넘기면 안 되므로 ENDED 판정보다 먼저 걸러낸다.
  //
  // 버퍼링이 고정 타임아웃(1.5초)보다 오래 걸리면, 그 뒤늦게 뜬 진짜 PLAYING이 로컬
  // 사용자 조작으로 오인되어 positionAtStart를 0 근처로 재전파 → 이미 앞서가던 다른
  // 클라이언트들이 전부 되감기는 에코 루프가 생긴 적이 있다. 그래서 버퍼링 중에는
  // BUFFERING 이벤트가 들어올 때마다 타이머를 계속 늘려서, 실제로 재생/정지가 확정된
  // 뒤에야 syncing이 풀리게 한다.
  if (syncing) {
    if (event.data === YT.PlayerState.BUFFERING) {
      markSyncing();
    }
    return;
  }

  if (event.data === YT.PlayerState.ENDED && latestNowPlaying && latestNowPlaying.queueId) {
    advanceToNext(latestNowPlaying.queueId);
    return;
  }

  // 그 외의 PLAYING/PAUSED 전환은 사용자가 유튜브 플레이어를 직접 조작한 것
  // (탐색 바로 구간 이동, 네이티브 재생/일시정지 버튼 등)이므로 공유 상태로 반영한다.
  if (event.data === YT.PlayerState.PLAYING) {
    reportLocalPlaybackChange(true);
  } else if (event.data === YT.PlayerState.PAUSED) {
    reportLocalPlaybackChange(false);
  }
}

async function reportLocalPlaybackChange(isPlaying) {
  if (
    !latestNowPlaying ||
    latestNowPlaying.state === "idle" ||
    latestNowPlaying.state === "advancing" ||
    !player
  )
    return;
  await authReady;
  const pos = Math.max(0, player.getCurrentTime());
  await update(nowPlayingRef, {
    state: isPlaying ? "playing" : "paused",
    positionAtStart: pos,
    startedAt: serverNow(),
  });
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
  if (np.state === "paused" || np.state === "advancing") return np.positionAtStart || 0;
  return (np.positionAtStart || 0) + (serverNow() - np.startedAt) / 1000;
}

function syncPlayback(np) {
  if (!player || !playerReady) return;

  if (!np || np.state === "idle") {
    player.stopVideo();
    return;
  }

  // 다음 곡으로 넘어가는 아주 짧은 전환 구간: 곧 실제 상태로 갱신되므로
  // 플레이어를 건드리지 않고 다음 업데이트를 기다린다 (매 스킵마다 깜빡이는 것 방지).
  if (np.state === "advancing") return;

  const target = Math.max(0, targetPosition(np));

  if (getCurrentVideoId() !== np.videoId) {
    markSyncing();
    player.loadVideoById({ videoId: np.videoId, startSeconds: target });
    if (np.state === "paused") {
      setTimeout(() => {
        markSyncing();
        player.pauseVideo();
      }, 300);
    }
    return;
  }

  // target이 이 영상의 실제 길이보다 크면(오래 열어둔 탭의 낡은 startedAt 등으로
  // positionAtStart+경과시간 계산이 어긋난 경우) 그 지점으로 계속 seekTo를 반복하며
  // 되감기 루프에 빠지는 대신, 이 곡은 이미 끝난 것으로 보고 다음 곡으로 넘긴다.
  const duration = player.getDuration();
  if (duration && target >= duration) {
    if (np.queueId) advanceToNext(np.queueId);
    return;
  }

  const drift = Math.abs(player.getCurrentTime() - target);
  if (drift > DRIFT_TOLERANCE_SEC) {
    markSyncing();
    player.seekTo(target, true);
  }

  const state = player.getPlayerState();
  if (np.state === "playing" && state !== YT.PlayerState.PLAYING) {
    markSyncing();
    player.playVideo();
  }
  if (np.state === "paused" && state !== YT.PlayerState.PAUSED) {
    markSyncing();
    player.pauseVideo();
  }
}

// 일시정지 상태에서의 탐색 바 이동은 onStateChange를 발생시키지 않으므로,
// 주기 점검에서 별도로 감지한다 (일시정지 중엔 재생 위치가 저절로 움직이지 않으므로
// positionAtStart와 달라졌다면 로컬 사용자가 직접 옮긴 것으로 판단해도 안전하다).
function checkPausedSeek(np) {
  if (!player || !playerReady || syncing) return;
  if (!np || np.state !== "paused") return;
  if (player.getPlayerState() !== YT.PlayerState.PAUSED) return;

  const drift = Math.abs(player.getCurrentTime() - (np.positionAtStart || 0));
  if (drift > DRIFT_TOLERANCE_SEC) {
    reportLocalPlaybackChange(false);
  }
}

// 너무 긴 영상은 재생 시작 후 길이를 알 수 있는 시점(getDuration)에 곧바로 스킵한다.
// 곡마다 한 번만 판단하면 되므로 queueId로 중복 체크를 막는다. 모든 참여자가 각자
// 이 판단을 내려 advanceToNext를 부르지만, 그 안의 트랜잭션이 한 명만 성사시킨다.
let lengthCheckedQueueId = null;
function checkVideoLength(np) {
  if (!player || !playerReady) return;
  if (!np || np.state === "idle" || np.state === "advancing" || !np.queueId) return;
  if (np.queueId === lengthCheckedQueueId) return;

  const duration = player.getDuration();
  if (!duration) return; // 메타데이터가 아직 로드되지 않음

  lengthCheckedQueueId = np.queueId;
  if (duration > MAX_DURATION_SEC) {
    advanceToNext(np.queueId);
  }
}

// claim을 따낸 클라이언트가 곡 전환 도중(advanceToNext 2~4단계) 끊기면 nowPlaying이
// "advancing" 상태로 멈춰버린다. 참여 중인 아무 클라이언트나 이 상태가 너무 오래
// 지속되는 걸 감지하면 advanceToNext를 다시 불러 이어받는다.
function checkStuckAdvance(np) {
  if (!np || np.state !== "advancing" || !np.queueId) return;
  if (serverNow() - (np.advancingSince || 0) > ADVANCING_STUCK_MS) {
    advanceToNext(np.queueId);
  }
}

export async function advanceToNext(expectedQueueId) {
  await authReady;
  // 1단계: 이 전환을 누가 담당할지 nowPlaying 트랜잭션으로 원자적으로 확정한다.
  // (큐 조회보다 먼저 소유권부터 잠가야, 여러 명이 연속으로 스킵을 성사시켜도
  //  같은 곡을 두 번 승격시키거나 아직 안 지워진 큐 항목을 다시 집어오는 일이 없다.)
  // claim을 따낸 클라이언트가 2~4단계 사이에 끊기면 advancing 상태로 영영 멈추므로,
  // advancingSince를 남겨뒀다가 너무 오래 멈춰 있으면 다른 클라이언트가 이어받는다.
  const claim = await runTransaction(nowPlayingRef, (current) => {
    if (!current || current.queueId !== expectedQueueId) return; // 이미 다른 클라이언트가 처리함
    if (current.state === "advancing") {
      const stuckFor = serverNow() - (current.advancingSince || 0);
      if (stuckFor < ADVANCING_STUCK_MS) return; // 다른 클라이언트가 아직 처리 중일 수 있음
    }
    return { ...current, state: "advancing", advancingSince: serverNow() };
  });

  if (!claim.committed) return;

  // claim을 따낸 직후, 이 클라이언트가 2~4단계를 마치기 전에 연결이 끊기면 서버가
  // 즉시 advancingSince를 0으로 되돌리도록 걸어둔다. ADVANCING_STUCK_MS는 "연결은
  // 살아있는데 응답이 없는" 드문 경우를 위한 최후의 안전망일 뿐, 정상적으로 끊기는
  // 경우(탭 닫기, 새로고침, 네트워크 끊김)는 이걸로 곧바로 감지된다. 그래야 그냥
  // 느려서 아직 처리 중인 클라이언트를 죽은 것으로 오판해 다른 클라이언트가 끼어들어
  // 같은 전환을 이중으로 처리하는 일이 없다.
  const abandonOnDisconnect = onDisconnect(nowPlayingRef);
  abandonOnDisconnect.update({ advancingSince: 0 });

  try {
    // 2단계: 소유권을 확보한 클라이언트만 큐 맨 앞 곡을 읽는다. 위에서 이미 이 전환을
    // 담당할 클라이언트가 하나로 확정됐으므로(claim), 다른 advanceToNext 호출과
    // 경합할 일이 없어 트랜잭션 없이 단순 조회로도 안전하다. (큐 삭제 권한 규칙상
    // "본인이 등록한 곡" 또는 "지금 nowPlaying인 곡"만 지울 수 있어서, 예전처럼
    // queue 전체를 트랜잭션으로 고쳐 쓰는 방식으로는 더 이상 지울 수 없다.)
    const frontSnap = await get(query(queueRef, orderByKey(), limitToFirst(1)));
    let poppedEntry = null;
    frontSnap.forEach((child) => {
      poppedEntry = { id: child.key, ...child.val() };
    });

    // 3단계: 실제 재생 상태로 확정 (소유권은 이미 확보했으므로 단순 update로 충분)
    await update(
      nowPlayingRef,
      poppedEntry
        ? {
            queueId: poppedEntry.id,
            videoId: poppedEntry.videoId,
            title: poppedEntry.title || poppedEntry.videoId,
            state: "playing",
            startedAt: serverNow(),
            positionAtStart: 0,
            advancingSince: null,
          }
        : {
            state: "idle",
            queueId: null,
            videoId: null,
            title: null,
            startedAt: null,
            positionAtStart: 0,
            advancingSince: null,
          }
    );

    // 4단계: 방금 nowPlaying으로 승격된 큐 항목을 지운다. nowPlaying.queueId가 이
    // songId와 같아야 지울 수 있다는 규칙 덕분에, 3단계가 먼저 커밋된 뒤에만
    // (등록자가 누구든) 이 삭제가 허용된다.
    if (poppedEntry) {
      await remove(ref(db, `queue/${poppedEntry.id}`));
    }

    await remove(ref(db, `skipVotes/${expectedQueueId}`));
  } finally {
    abandonOnDisconnect.cancel();
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

  const uid = await authReady;
  const lastSnap = await get(lastAddRef(uid));
  const remaining = ADD_COOLDOWN_MS - (serverNow() - (lastSnap.val() || 0));
  if (remaining > 0) {
    alert(`곡 추가는 1분에 한 번만 가능해요. ${Math.ceil(remaining / 1000)}초 후 다시 시도해주세요.`);
    return;
  }

  input.value = "";
  const title = await fetchTitle(videoId);

  // 실제 쿨다운 강제는 lastAdd 쓰기 규칙(이전 값보다 60초 이상 지나야 허용)이 서버에서
  // 담당한다. 큐/nowPlaying 쓰기 규칙은 "방금 lastAdd가 갱신됐는지"만 함께 검사해 이
  // 게이트를 우회하지 못하게 하므로, 시간이 걸릴 수 있는 제목 조회가 끝난 뒤 실제
  // 쓰기 직전에 갱신해야 그 사이 텀 때문에 정상 요청이 거부되는 일이 없다.
  try {
    await set(lastAddRef(uid), serverTimestamp());
  } catch {
    alert("곡 추가는 1분에 한 번만 가능해요. 잠시 후 다시 시도해주세요.");
    return;
  }

  // 큐에 먼저 넣었다가 idle이면 승격 후 지우는 방식은, 승격과 삭제 사이의 짧은 창에
  // advanceToNext가 같은 곡을 큐에서 다시 집어가 처음부터 재시작시키는 레이스가 있었다.
  // 그래서 이 곡이 큐와 nowPlaying 양쪽에 동시에 존재하는 순간이 아예 없도록,
  // idle일 때만 큐에 쓰지 않고 nowPlaying으로 바로 승격한다.
  const queueId = push(queueRef).key;
  const result = await runTransaction(nowPlayingRef, (current) => {
    if (current && current.state && current.state !== "idle") return; // 이미 뭔가 재생 중
    return {
      queueId,
      videoId,
      title,
      state: "playing",
      startedAt: serverNow(),
      positionAtStart: 0,
    };
  });

  if (!result.committed) {
    await set(ref(db, `queue/${queueId}`), { videoId, title, addedAt: serverNow(), addedBy: uid });
  }
}

// 누가 등록했는지는 서버(규칙)만 판단한다 — 버튼을 등록자에게만 보이게 하면
// 화면만 보고도 "이 곡을 등록한 사람이 나"라는 걸 남에게 들키기 쉬워지므로,
// 버튼은 모두에게 똑같이 보여주고 실제 삭제 가능 여부는 규칙의 uid 검사로 가른다.
async function deleteFromQueue(songId) {
  await authReady;
  try {
    await remove(ref(db, `queue/${songId}`));
  } catch {
    alert("본인이 추가한 곡만 삭제할 수 있어요.");
  }
}

// --- 렌더링 ---
function renderNowPlaying(np) {
  const titleEl = document.getElementById("now-playing-title");

  if (!np || np.state === "idle" || !np.videoId) {
    titleEl.textContent = "재생 중인 곡 없음";
    return;
  }

  if (np.state === "advancing") {
    titleEl.textContent = "다음 곡으로 이동 중…";
    return;
  }

  titleEl.textContent = np.title || np.videoId;
}

function renderQueue(queueVal) {
  const list = document.getElementById("queue-list");
  list.innerHTML = "";
  if (!queueVal) return;
  Object.keys(queueVal)
    .sort()
    .forEach((key) => {
      const entry = queueVal[key];
      const li = document.createElement("li");

      const title = document.createElement("span");
      title.textContent = entry.title || entry.videoId;
      li.appendChild(title);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "queue-delete-btn";
      deleteBtn.textContent = "삭제";
      deleteBtn.addEventListener("click", () => deleteFromQueue(key));
      li.appendChild(deleteBtn);

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
    if (!joined) return;
    checkPausedSeek(latestNowPlaying);
    checkVideoLength(latestNowPlaying);
    checkStuckAdvance(latestNowPlaying);
    syncPlayback(latestNowPlaying);
  }, 3000);
});

// 자동재생 허용을 위해 음소거로 시작하므로, 네이티브 플레이어 컨트롤과 무관하게
// 우리 UI에서 직접 소리를 켤 수 있어야 한다 (나중에 탐색바를 막느라 네이티브
// 컨트롤 자체를 숨기더라도 이 버튼은 그대로 동작한다).
document.getElementById("unmute-btn").addEventListener("click", () => {
  if (!player) return;
  player.unMute();
  player.setVolume(100);
});

document.getElementById("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  addSongFromInput();
});

import { db, authReady } from "./firebase-init.js";
import { nicknameFromUid } from "./nickname.js";
import {
  ref,
  push,
  set,
  get,
  update,
  onValue,
  query,
  orderByKey,
  orderByChild,
  endAt,
  limitToLast,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

const chatRef = ref(db, "chat");
const MAX_MESSAGES = 10;
const MAX_LENGTH = 300;
const CHAT_TTL_MS = 60 * 60 * 1000; // 1시간 지난 채팅은 정리 대상

const chatList = document.getElementById("chat-list");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

function renderMessages(val) {
  chatList.innerHTML = "";
  if (!val) return;
  Object.keys(val)
    .sort()
    .forEach((key) => {
      const { text, nickname } = val[key];
      if (!text) return;

      const li = document.createElement("li");
      const sender = document.createElement("span");
      sender.className = "chat-sender";
      sender.textContent = nickname || "익명";
      const body = document.createElement("span");
      body.className = "chat-text";
      body.textContent = text;
      li.append(sender, body);
      chatList.appendChild(li);
    });
  chatList.scrollTop = chatList.scrollHeight;
}

// RTDB엔 TTL이 없어서, 메시지를 보낼 때마다 1시간 넘은 채팅을 함께 지운다.
async function pruneOldMessages() {
  const cutoff = Date.now() - CHAT_TTL_MS;
  const oldSnap = await get(query(chatRef, orderByChild("sentAt"), endAt(cutoff)));
  const updates = {};
  oldSnap.forEach((child) => {
    updates[child.key] = null;
  });
  if (Object.keys(updates).length > 0) {
    await update(chatRef, updates);
  }
}

onValue(query(chatRef, orderByKey(), limitToLast(MAX_MESSAGES)), (snap) => {
  renderMessages(snap.val());
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim().slice(0, MAX_LENGTH);
  if (!text) return;
  chatInput.value = "";
  const uid = await authReady;
  await set(push(chatRef), { text, sentAt: Date.now(), nickname: nicknameFromUid(uid) });
  pruneOldMessages();
});

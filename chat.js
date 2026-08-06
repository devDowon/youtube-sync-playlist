import { db } from "./firebase-init.js";
import {
  ref,
  push,
  set,
  onValue,
  query,
  orderByKey,
  limitToLast,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

const chatRef = ref(db, "chat");
const MAX_MESSAGES = 10;
const MAX_LENGTH = 300;

const chatList = document.getElementById("chat-list");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

function renderMessages(val) {
  chatList.innerHTML = "";
  if (!val) return;
  Object.keys(val)
    .sort()
    .forEach((key) => {
      const { text } = val[key];
      if (!text) return;

      const li = document.createElement("li");
      const sender = document.createElement("span");
      sender.className = "chat-sender";
      sender.textContent = "익명";
      const body = document.createElement("span");
      body.className = "chat-text";
      body.textContent = text;
      li.append(sender, body);
      chatList.appendChild(li);
    });
  chatList.scrollTop = chatList.scrollHeight;
}

onValue(query(chatRef, orderByKey(), limitToLast(MAX_MESSAGES)), (snap) => {
  renderMessages(snap.val());
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim().slice(0, MAX_LENGTH);
  if (!text) return;
  chatInput.value = "";
  await set(push(chatRef), { text, sentAt: Date.now() });
});

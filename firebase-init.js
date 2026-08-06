import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);

const auth = getAuth(app);
signInAnonymously(auth);

// presence/skipVotes 쓰기는 자기 자신의 uid로만 허용하도록 규칙에서 검증하므로
// (안 그러면 누구나 임의의 clientId로 표를 위조해 과반수를 우회할 수 있다),
// 로그인이 끝나 uid가 확정될 때까지 기다릴 수 있는 Promise를 함께 내보낸다.
export const authReady = new Promise((resolve) => {
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    if (user) {
      unsubscribe();
      resolve(user.uid);
    }
  });
});

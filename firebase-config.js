// Firebase 콘솔 > 프로젝트 설정 > 일반 > "내 앱"(웹 앱 추가)에서 발급받은 값을 그대로 붙여넣으세요.
// 이 값은 공개되어도 안전합니다 — 접근 제어는 Realtime Database 규칙(database.rules.json)에서 합니다.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

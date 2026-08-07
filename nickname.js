const ADJECTIVES = [
  "행복한", "용감한", "졸린", "수줍은", "배고픈", "엉뚱한", "차분한", "신난",
  "무심한", "다정한", "까칠한", "느긋한", "활발한", "조용한", "씩씩한", "호기심많은",
];

const ANIMALS = [
  "쿼카", "여우", "펭귄", "고양이", "라마", "수달", "다람쥐", "코알라",
  "판다", "너구리", "부엉이", "고슴도치", "알파카", "해달", "토끼", "돌고래",
];

// uid를 해시해 형용사/동물을 하나씩 골라 조합한다. 같은 uid는 항상
// 같은 닉네임이 나오므로, 완전 익명이면서도 채팅 내에서는 "누가 말했는지"
// 알아볼 수 있는 정체성을 준다.
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

export function nicknameFromUid(uid) {
  const h = hashString(uid);
  const adjective = ADJECTIVES[h % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length];
  return `${adjective} ${animal}`;
}

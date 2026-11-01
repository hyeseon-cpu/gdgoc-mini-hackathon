// QR 모바일 투표용 Firestore 연동 (index.html 진행자 화면 + vote.html 참가자 화면 공용)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
    getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, collection,
    onSnapshot, writeBatch, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 로컬에서 열면 Firestore 에뮬레이터에 연결 (firebase emulators:start --only firestore)
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomId(len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, b => ID_CHARS[b % ID_CHARS.length]).join('');
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 진행자 ----------

// room = { roomId, key } — key는 진행자만 알고 있는 마감/연장용 비밀값 (쓸 때마다 새 값으로 교체)
export async function createRoom(participants, minutes) {
    const roomId = randomId(8);
    const key = randomId(24);
    await setDoc(doc(db, 'rooms', roomId), {
        names: Object.fromEntries(participants.map(p => [String(p.id), p.name])),
        voterIds: participants.map(p => String(p.id)),
        closesAt: Timestamp.fromMillis(Date.now() + minutes * 60000),
        keyHash: await sha256Hex(key),
        createdAt: serverTimestamp()
    });
    return { roomId, key };
}

async function updateClose(room, closesAt) {
    const nextKey = randomId(24);
    await updateDoc(doc(db, 'rooms', room.roomId), {
        closesAt,
        key: room.key,
        keyHash: await sha256Hex(nextKey)
    });
    return { ...room, key: nextKey };
}

export function extendRoom(room, currentClosesAtMs, ms) {
    const base = Math.max(Date.now(), currentClosesAtMs);
    return updateClose(room, Timestamp.fromMillis(base + ms));
}

export function closeRoomNow(room) {
    return updateClose(room, serverTimestamp());
}

// ---------- 공용 구독 ----------

// cb({ names, voterIds, closesAtMs }) — 문서가 없으면 cb(null)
export function watchRoom(roomId, cb, onError) {
    return onSnapshot(doc(db, 'rooms', roomId), snap => {
        if (!snap.exists()) return cb(null);
        const d = snap.data({ serverTimestamps: 'estimate' });
        cb({ names: d.names, voterIds: d.voterIds, closesAtMs: d.closesAt.toMillis() });
    }, onError);
}

// cb([{ voter, picks, atMs }])
export function watchBallots(roomId, cb, onError) {
    return onSnapshot(collection(db, 'rooms', roomId, 'ballots'), { includeMetadataChanges: true }, snap => {
        cb(snap.docs.filter(d => !d.metadata.hasPendingWrites).map(d => {
            const data = d.data({ serverTimestamps: 'estimate' });
            return { voter: d.id, picks: data.picks, atMs: data.at ? data.at.toMillis() : Date.now() };
        }));
    }, onError);
}

// cb(Map<deviceId, voterId>) — 참가자 화면에서 "이미 투표한 이름" 표시용 (표 내용은 안 봄)
export function watchDevices(roomId, cb, onError) {
    // 아직 서버 승인 전인 내 쓰기(낙관적 반영)는 빼고, 서버가 확정한 기록만 사용
    return onSnapshot(collection(db, 'rooms', roomId, 'devices'), { includeMetadataChanges: true }, snap => {
        cb(new Map(snap.docs.filter(d => !d.metadata.hasPendingWrites).map(d => [d.id, d.data().voter])));
    }, onError);
}

// ---------- 참가자 ----------

export function getDeviceId() {
    const KEY = 'hackathon-device-id';
    try {
        let id = localStorage.getItem(KEY);
        if (!id) {
            id = randomId(24);
            localStorage.setItem(KEY, id);
        }
        return id;
    } catch (e) {
        return randomId(24);
    }
}

// 투표지와 기기 기록을 한 번에 저장 — 이름이나 기기가 이미 쓰였으면 보안 규칙이 통째로 거절
export async function submitBallot(roomId, voterId, picks) {
    const device = getDeviceId();
    const batch = writeBatch(db);
    batch.set(doc(db, 'rooms', roomId, 'ballots', voterId), { picks, device, at: serverTimestamp() });
    batch.set(doc(db, 'rooms', roomId, 'devices', device), { voter: voterId });
    await batch.commit();
}

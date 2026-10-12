// Созвоны через медиасервер LiveKit: вызов, участники, завершение и запись итога в чат.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  db, now, stmt, liveCalls, callDto, sendToUser, memberIds, isOnline, broadcastMessage, broadcastChat, HttpError, requireMember,
} from './core.js';
import { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, RING_TIMEOUT_MS } from './config.js';

const ringTimers = new Map(); // callId -> timeout
const emptyTimers = new Map(); // callId -> timeout (никого не осталось)

export function livekitToken(user, room, ttlSec = 6 * 3600) {
  const t = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: LIVEKIT_API_KEY,
    sub: String(user.id),
    name: user.name,
    nbf: t - 10,
    exp: t + ttlSec,
    jti: crypto.randomBytes(8).toString('hex'),
    metadata: JSON.stringify({ color: user.color, avatar: user.avatar || null, position: user.position || '' }),
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  }, LIVEKIT_API_SECRET, { algorithm: 'HS256' });
}

const roomName = (callId) => `call-${callId}`;
const activeCall = (chatId) => stmt.activeCall.get(chatId);
const callRow = (id) => db.prepare('SELECT * FROM calls WHERE id = ?').get(id);

function emit(call, type, extra = {}) {
  const dto = callDto(call);
  for (const uid of memberIds(call.chat_id)) sendToUser(uid, { type, call: dto, chatId: call.chat_id, ...extra });
  broadcastChat(call.chat_id);
}

/** Пользователь уже в другом созвоне? */
export function inAnotherCall(userId, exceptId) {
  for (const [id, live] of liveCalls) if (id !== exceptId && live.participants.has(userId)) return true;
  return false;
}

function ring(call, userIds, fromUserId) {
  const live = liveCalls.get(call.id);
  const chat = stmt.chat.get(call.chat_id);
  const rang = [];
  for (const uid of userIds) {
    if (uid === fromUserId || live.participants.has(uid)) continue;
    if (!isOnline(uid) || inAnotherCall(uid, call.id)) continue;
    live.ringing.add(uid);
    rang.push(uid);
    sendToUser(uid, { type: 'gcall:ring', call: callDto(call), chatId: call.chat_id, fromUserId, chatType: chat.type });
  }
  clearTimeout(ringTimers.get(call.id));
  ringTimers.set(call.id, setTimeout(() => ringTimeout(call.id), RING_TIMEOUT_MS));
  return rang;
}

function ringTimeout(callId) {
  const live = liveCalls.get(callId);
  const call = callRow(callId);
  if (!live || !call || call.ended_at) return;
  for (const uid of live.ringing) sendToUser(uid, { type: 'gcall:ring-stop', callId, reason: 'missed' });
  live.ringing.clear();
  // никто, кроме начавшего, так и не подключился
  if (!live.everJoinedOthers) return endCall(callId, 'missed');
  emit(call, 'gcall:update');
}

export function startCall(user, chatId, video) {
  requireMember(chatId, user.id);
  const existing = activeCall(chatId);
  if (existing && liveCalls.has(existing.id)) return { call: existing, joined: false };
  if (existing) db.prepare('UPDATE calls SET ended_at = ? WHERE id = ?').run(now(), existing.id); // зависший после перезапуска
  if (inAnotherCall(user.id)) throw HttpError(409, 'Вы уже в другом звонке');
  const id = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO calls (id, chat_id, started_by, video, started_at) VALUES (?, ?, ?, ?, ?)').run(id, chatId, user.id, video ? 1 : 0, now());
  liveCalls.set(id, { participants: new Set(), ringing: new Set(), everJoinedOthers: false, joinedAt: null, peak: 0, starter: user.id });
  const call = callRow(id);
  const targets = memberIds(chatId).filter((uid) => uid !== user.id);
  const rang = ring(call, targets, user.id);
  emit(call, 'gcall:update');
  return { call, joined: false, rang };
}

export function joinCall(user, callId) {
  const call = callRow(callId);
  if (!call || call.ended_at || !liveCalls.has(callId)) throw HttpError(404, 'Созвон уже завершён');
  requireMember(call.chat_id, user.id);
  if (inAnotherCall(user.id, callId)) throw HttpError(409, 'Вы уже в другом звонке');
  const live = liveCalls.get(callId);
  live.participants.add(user.id);
  live.ringing.delete(user.id);
  if (user.id !== live.starter) live.everJoinedOthers = true;
  if (!live.joinedAt && live.participants.size >= 2) live.joinedAt = now();
  live.peak = Math.max(live.peak, live.participants.size);
  clearTimeout(emptyTimers.get(callId));
  // на остальных устройствах этого пользователя — перестать звонить
  sendToUser(user.id, { type: 'gcall:ring-stop', callId, reason: 'joined' });
  emit(call, 'gcall:update');
  return call;
}

export function leaveCall(userId, callId) {
  const call = callRow(callId);
  const live = liveCalls.get(callId);
  if (!call || !live || call.ended_at) return;
  live.participants.delete(userId);
  if (live.participants.size === 0) {
    // начавший ушёл до ответа — звонок отменён; иначе ждём немного (переподключение) и завершаем
    if (!live.everJoinedOthers) return endCall(callId, 'missed');
    clearTimeout(emptyTimers.get(callId));
    emptyTimers.set(callId, setTimeout(() => {
      const l = liveCalls.get(callId);
      if (l && l.participants.size === 0) endCall(callId, 'completed');
    }, 8000));
  } else if (live.participants.size === 1 && stmt.chat.get(call.chat_id).type === 'direct' && live.everJoinedOthers) {
    // в личном звонке один из двоих ушёл — звонок окончен
    return endCall(callId, 'completed');
  }
  emit(call, 'gcall:update');
}

export function declineCall(user, callId, reason, minutes) {
  const call = callRow(callId);
  const live = liveCalls.get(callId);
  if (!call || !live || call.ended_at) return;
  live.ringing.delete(user.id);
  sendToUser(user.id, { type: 'gcall:ring-stop', callId, reason: 'declined' });
  for (const uid of live.participants) sendToUser(uid, { type: 'gcall:declined', callId, userId: user.id, reason: reason || 'rejected', minutes });
  const chat = stmt.chat.get(call.chat_id);
  if (chat.type === 'direct' && !live.everJoinedOthers) {
    return endCall(callId, reason === 'busy' ? 'missed' : 'rejected', reason === 'later' ? `later:${Number(minutes) || 10}` : undefined);
  }
  emit(call, 'gcall:update');
}

export function inviteToCall(user, callId, userIds) {
  const call = callRow(callId);
  if (!call || call.ended_at || !liveCalls.has(callId)) throw HttpError(404, 'Созвон уже завершён');
  requireMember(call.chat_id, user.id);
  const members = new Set(memberIds(call.chat_id));
  const rang = ring(call, (userIds || []).map(Number).filter((id) => members.has(id)), user.id);
  emit(call, 'gcall:update');
  return rang;
}

export function endCall(callId, outcome, note) {
  const call = callRow(callId);
  const live = liveCalls.get(callId);
  if (!call || call.ended_at) return;
  clearTimeout(ringTimers.get(callId));
  clearTimeout(emptyTimers.get(callId));
  ringTimers.delete(callId);
  emptyTimers.delete(callId);
  const t = now();
  db.prepare('UPDATE calls SET ended_at = ? WHERE id = ?').run(t, callId);
  if (live) for (const uid of live.ringing) sendToUser(uid, { type: 'gcall:ring-stop', callId, reason: 'ended' });
  liveCalls.delete(callId);
  const chat = stmt.chat.get(call.chat_id);
  const duration = live?.joinedAt ? Math.round((t - live.joinedAt) / 1000) : 0;
  const text = JSON.stringify({
    video: !!call.video, outcome: duration > 0 ? 'completed' : outcome === 'completed' ? 'missed' : outcome,
    duration, group: chat.type === 'group', participants: live?.peak || 0, note: note || undefined,
  });
  const r = db.prepare("INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?, ?, 'call', ?, ?)").run(call.chat_id, call.started_by, text, t);
  for (const uid of memberIds(call.chat_id)) sendToUser(uid, { type: 'gcall:ended', callId, chatId: call.chat_id });
  broadcastMessage(stmt.message.get(Number(r.lastInsertRowid)));
  broadcastChat(call.chat_id);
}

// Сообщения по WebSocket для созвонов не нужны (всё идёт через REST и LiveKit)
export function handleCallEvent() {}

/** Пользователь полностью отключился — убрать его из созвонов. */
export function onSocketClosed(ws, uid) {
  if (isOnline(uid)) return;
  for (const [id, live] of liveCalls) {
    if (live.participants.has(uid)) leaveCall(uid, id);
    if (live.ringing.has(uid)) { live.ringing.delete(uid); const c = callRow(id); if (c) emit(c, 'gcall:update'); }
  }
}

// После перезапуска сервера незавершённые созвоны закрываем
db.prepare('UPDATE calls SET ended_at = ? WHERE ended_at IS NULL').run(now());

// WebSocket: присутствие, «печатает», сигналинг звонков.
import { WebSocketServer } from 'ws';
import { db, now, stmt, sockets, isOnline, sendToUser, sendToAll, memberIds, broadcastMessage, broadcastChat } from './core.js';
import { findOrCreateDirect } from './directs.js';
import { verifyToken } from './routes.js';
import { RING_TIMEOUT_MS } from './config.js';
import { handleCallEvent as handleGroupCallEvent, onSocketClosed as groupCallSocketClosed } from './calls.js';

function sendWs(ws, event) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(event));
}

function broadcastPresence(uid) {
  const u = stmt.userById.get(uid);
  sendToAll({ type: 'presence', userId: uid, online: isOnline(uid), lastSeen: u?.last_seen ?? null });
}

// ---------- Звонки 1-на-1 без медиасервера (P2P WebRTC) ----------
const calls = new Map(); // callId -> { id, from, to, video, callerWs, calleeWs, acceptedAt, timer }

function finishCall(call, outcome, note) {
  if (!calls.has(call.id)) return;
  clearTimeout(call.timer);
  calls.delete(call.id);
  const duration = call.acceptedAt ? Math.round((now() - call.acceptedAt) / 1000) : 0;
  const { id: chatId, created } = findOrCreateDirect(call.from, call.to);
  if (created) broadcastChat(chatId);
  const text = JSON.stringify({ video: call.video, outcome, duration, note: note || undefined });
  const r = db.prepare("INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?, ?, 'call', ?, ?)")
    .run(chatId, call.from, text, now());
  broadcastMessage(stmt.message.get(Number(r.lastInsertRowid)));
}

export const busyUsers = () => new Set([...calls.values()].flatMap((c) => [c.from, c.to]));

function handleDirectCall(ws, uid, msg) {
  const call = msg.callId ? calls.get(msg.callId) : null;
  switch (msg.type) {
    case 'call:invite': {
      const to = stmt.userById.get(Number(msg.toUserId));
      if (!to || !to.is_active || to.id === uid) return sendWs(ws, { type: 'call:ended', callId: msg.callId, reason: 'unavailable' });
      const busy = busyUsers();
      const c = { id: String(msg.callId), from: uid, to: to.id, video: !!msg.video, callerWs: ws, calleeWs: null, acceptedAt: null, timer: null };
      calls.set(c.id, c);
      if (busy.has(to.id) || busy.has(uid)) { sendWs(ws, { type: 'call:ended', callId: c.id, reason: 'busy' }); return finishCall(c, 'missed'); }
      if (!isOnline(to.id)) { sendWs(ws, { type: 'call:ended', callId: c.id, reason: 'offline' }); return finishCall(c, 'missed'); }
      c.timer = setTimeout(() => {
        sendWs(c.callerWs, { type: 'call:ended', callId: c.id, reason: 'no-answer' });
        sendToUser(c.to, { type: 'call:ended', callId: c.id, reason: 'missed' });
        finishCall(c, 'missed');
      }, RING_TIMEOUT_MS);
      sendToUser(to.id, { type: 'call:incoming', callId: c.id, fromUserId: uid, video: c.video });
      return sendWs(ws, { type: 'call:ringing', callId: c.id });
    }
    case 'call:accept': {
      if (!call || call.to !== uid || call.acceptedAt) return;
      clearTimeout(call.timer);
      call.acceptedAt = now();
      call.calleeWs = ws;
      for (const s of sockets.get(uid) ?? []) if (s !== ws) sendWs(s, { type: 'call:ended', callId: call.id, reason: 'answered-elsewhere' });
      return sendWs(call.callerWs, { type: 'call:accepted', callId: call.id });
    }
    case 'call:reject': {
      if (!call || call.to !== uid || call.acceptedAt) return;
      const reason = ['busy', 'later'].includes(msg.reason) ? msg.reason : 'rejected';
      sendWs(call.callerWs, { type: 'call:ended', callId: call.id, reason, minutes: msg.minutes });
      for (const s of sockets.get(uid) ?? []) if (s !== ws) sendWs(s, { type: 'call:ended', callId: call.id, reason: 'rejected' });
      return finishCall(call, reason === 'busy' ? 'missed' : 'rejected', reason === 'later' ? `later:${Number(msg.minutes) || 10}` : undefined);
    }
    case 'call:cancel':
    case 'call:end': {
      if (!call || (call.from !== uid && call.to !== uid)) return;
      if (!call.acceptedAt) {
        sendToUser(call.to, { type: 'call:ended', callId: call.id, reason: 'cancelled' });
        return finishCall(call, 'missed');
      }
      sendWs(call.from === uid ? call.calleeWs : call.callerWs, { type: 'call:ended', callId: call.id, reason: 'hangup' });
      return finishCall(call, 'completed');
    }
    case 'call:signal': {
      if (!call || !call.acceptedAt) return;
      const target = call.from === uid ? call.calleeWs : call.to === uid ? call.callerWs : null;
      return sendWs(target, { type: 'call:signal', callId: call.id, data: msg.data });
    }
    default:
  }
}

function dropSocketFromCalls(ws, uid) {
  for (const c of [...calls.values()]) {
    if (c.callerWs === ws) {
      if (c.acceptedAt) sendWs(c.calleeWs, { type: 'call:ended', callId: c.id, reason: 'hangup' });
      else sendToUser(c.to, { type: 'call:ended', callId: c.id, reason: 'cancelled' });
      finishCall(c, c.acceptedAt ? 'completed' : 'missed');
    } else if (c.calleeWs === ws) {
      sendWs(c.callerWs, { type: 'call:ended', callId: c.id, reason: 'hangup' });
      finishCall(c, 'completed');
    } else if (c.to === uid && !c.acceptedAt && !isOnline(uid)) {
      sendWs(c.callerWs, { type: 'call:ended', callId: c.id, reason: 'offline' });
      finishCall(c, 'missed');
    }
  }
}

// ---------- Сервер WebSocket ----------
export const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

wss.on('connection', (ws, req, user) => {
  const uid = user.id;
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  const wasOnline = isOnline(uid);
  sockets.get(uid).add(ws);
  if (!wasOnline) broadcastPresence(uid);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  sendWs(ws, { type: 'hello', userId: uid });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') return sendWs(ws, { type: 'pong' });
    if (msg.type === 'typing') {
      const chatId = Number(msg.chatId);
      if (!stmt.member.get(chatId, uid)) return;
      const kind = msg.kind === 'voice' ? 'voice' : 'text';
      for (const id of memberIds(chatId)) if (id !== uid) sendToUser(id, { type: 'typing', chatId, userId: uid, kind });
      return;
    }
    if (msg.type.startsWith('gcall:')) return handleGroupCallEvent(ws, uid, msg);
    if (msg.type.startsWith('call:')) return handleDirectCall(ws, uid, msg);
  });

  ws.on('close', () => {
    const set = sockets.get(uid);
    set?.delete(ws);
    if (set && set.size === 0) {
      sockets.delete(uid);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), uid);
      broadcastPresence(uid);
    }
    dropSocketFromCalls(ws, uid);
    groupCallSocketClosed(ws, uid);
  });
});

setInterval(() => {
  for (const set of sockets.values()) for (const ws of set) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

export function attachUpgrade(server, extraUpgrade) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (extraUpgrade && extraUpgrade(req, socket, head, url)) return;
    if (url.pathname !== '/ws') return socket.destroy();
    const user = verifyToken(url.searchParams.get('token') || '');
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });
}

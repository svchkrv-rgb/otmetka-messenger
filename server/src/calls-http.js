// HTTP-часть созвонов: выдача токенов LiveKit и проксирование сигнализации LiveKit через сервер «Отметки»
// (так клиенту не нужен отдельный адрес и сертификат для медиасервера).
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } from './config.js';
import { HttpError } from './core.js';
import { auth } from './routes.js';
import { livekitToken, startCall, joinCall, leaveCall, declineCall, inviteToCall } from './calls.js';

export const callsRouter = express.Router();
const enabled = () => !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };
const requireEnabled = (req, res, next) => (enabled() ? next() : res.status(503).json({ error: 'Созвоны через медиасервер не настроены на сервере' }));

callsRouter.post('/calls/start', auth, requireEnabled, wrap((req, res) => {
  const chatId = Number(req.body?.chatId);
  const { call, rang } = startCall(req.user, chatId, req.body?.video !== false);
  const joined = joinCall(req.user, call.id);
  res.json({ callId: joined.id, chatId, token: livekitToken(req.user, `call-${joined.id}`), rang: rang || [] });
}));

callsRouter.post('/calls/:id/join', auth, requireEnabled, wrap((req, res) => {
  const call = joinCall(req.user, req.params.id);
  res.json({ callId: call.id, chatId: call.chat_id, video: !!call.video, token: livekitToken(req.user, `call-${call.id}`) });
}));

callsRouter.post('/calls/:id/leave', auth, wrap((req, res) => {
  leaveCall(req.user.id, req.params.id);
  res.json({ ok: true });
}));

callsRouter.post('/calls/:id/decline', auth, wrap((req, res) => {
  declineCall(req.user, req.params.id, req.body?.reason, req.body?.minutes);
  res.json({ ok: true });
}));

callsRouter.post('/calls/:id/invite', auth, requireEnabled, wrap((req, res) => {
  const rang = inviteToCall(req.user, req.params.id, req.body?.userIds);
  if (!rang.length) throw HttpError(400, 'Никого не удалось вызвать: не в сети или уже в звонке');
  res.json({ rang });
}));

// ---------- Прокси сигнализации LiveKit (/rtc) ----------
export function livekitHttp(req, res) {
  if (!enabled()) return res.status(404).json({ error: 'Медиасервер не настроен' });
  const target = new URL(LIVEKIT_URL);
  const headers = { ...req.headers, host: target.host };
  const p = http.request({ hostname: target.hostname, port: target.port || 80, method: req.method, path: req.originalUrl, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  p.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Медиасервер недоступен' }); });
  req.pipe(p);
}

export function livekitUpgrade(req, socket, head, url) {
  if (!url.pathname.startsWith('/rtc')) return false;
  if (!enabled()) { socket.destroy(); return true; }
  const target = new URL(LIVEKIT_URL);
  const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1];
      raw += `${k}: ${v}\r\n`;
    }
    upstream.write(raw + '\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  return true;
}

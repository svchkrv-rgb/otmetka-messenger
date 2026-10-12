import express from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import { openDb, tx } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Настройки ----------
const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', '..', 'client', 'dist'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const RING_TIMEOUT_MS = 45_000;
const ICE_SERVERS = (() => {
  try {
    return process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [{ urls: 'stun:stun.l.google.com:19302' }];
  } catch {
    console.warn('ICE_SERVERS: неверный JSON, использую STUN по умолчанию');
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
})();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = openDb(DATA_DIR);

const SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
})();

const PALETTE = ['#1F3A5F', '#5B3A8C', '#8A3B12', '#6B5413', '#256B43', '#1F4E85', '#3E4349', '#9A3412', '#0F5E66'];
const now = () => Date.now();

// ---------- Первый администратор ----------
{
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const login = process.env.ADMIN_LOGIN || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin';
    db.prepare('INSERT INTO users (login, name, position, password_hash, is_admin, color, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(login, 'Администратор', 'Администратор системы', bcrypt.hashSync(password, 10), PALETTE[0], now());
    console.log(`Создан администратор: логин «${login}», пароль «${password}». Смените пароль после входа.`);
  }
}

// ---------- Представления ----------
const sockets = new Map(); // userId -> Set<ws>
const isOnline = (uid) => (sockets.get(uid)?.size ?? 0) > 0;

function userDto(u) {
  return {
    id: u.id, login: u.login, name: u.name, position: u.position, color: u.color,
    isAdmin: !!u.is_admin, isActive: !!u.is_active, online: isOnline(u.id), lastSeen: u.last_seen ?? null,
  };
}

const stmt = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
  member: db.prepare('SELECT * FROM members WHERE chat_id = ? AND user_id = ?'),
  members: db.prepare('SELECT user_id AS userId, role FROM members WHERE chat_id = ? ORDER BY joined_at'),
  chat: db.prepare('SELECT * FROM chats WHERE id = ?'),
  attachments: db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY id'),
  receipts: db.prepare('SELECT user_id AS userId, read_at AS readAt FROM receipts WHERE message_id = ? ORDER BY read_at'),
  message: db.prepare('SELECT * FROM messages WHERE id = ?'),
  lastMessage: db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1'),
  unread: db.prepare(`SELECT COUNT(*) AS c FROM messages m
    WHERE m.chat_id = ? AND m.kind != 'system' AND (m.sender_id IS NULL OR m.sender_id != ?)
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.message_id = m.id AND r.user_id = ?)`),
};

function canSeeReceipts(chat, msg, viewerId) {
  return chat.show_receipts || msg.sender_id === viewerId;
}

function messageDto(m, viewerId, chat = stmt.chat.get(m.chat_id)) {
  return {
    id: m.id, chatId: m.chat_id, senderId: m.sender_id, kind: m.kind, text: m.text,
    important: !!m.important, createdAt: m.created_at,
    attachments: stmt.attachments.all(m.id).map((a) => ({
      id: a.id, kind: a.kind, fileName: a.file_name, mime: a.mime, size: a.size, url: `/files/${a.stored_name}`,
    })),
    receipts: canSeeReceipts(chat, m, viewerId) ? stmt.receipts.all(m.id) : [],
  };
}

function chatDto(chatId, viewerId) {
  const c = stmt.chat.get(chatId);
  if (!c) return null;
  const me = stmt.member.get(chatId, viewerId);
  const last = stmt.lastMessage.get(chatId);
  return {
    id: c.id, type: c.type, title: c.title, color: c.color, address: c.address,
    showReceipts: !!c.show_receipts, createdAt: c.created_at, createdBy: c.created_by,
    members: stmt.members.all(chatId), myRole: me?.role ?? null,
    lastMessage: last ? messageDto(last, viewerId, c) : null,
    unread: stmt.unread.get(chatId, viewerId, viewerId).c,
  };
}

// ---------- Рассылка ----------
function sendToUser(uid, event) {
  const set = sockets.get(uid);
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}
function memberIds(chatId) {
  return stmt.members.all(chatId).map((m) => m.userId);
}
function broadcastMessage(m) {
  const chat = stmt.chat.get(m.chat_id);
  for (const uid of memberIds(m.chat_id)) sendToUser(uid, { type: 'message:new', message: messageDto(m, uid, chat) });
}
function broadcastChat(chatId) {
  for (const uid of memberIds(chatId)) sendToUser(uid, { type: 'chat:updated', chat: chatDto(chatId, uid) });
}
function broadcastPresence(uid) {
  const u = stmt.userById.get(uid);
  const event = { type: 'presence', userId: uid, online: isOnline(uid), lastSeen: u?.last_seen ?? null };
  for (const set of sockets.values()) for (const ws of set) if (ws.readyState === 1) ws.send(JSON.stringify(event));
}

function addSystemMessage(chatId, text, senderId = null) {
  const r = db.prepare("INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?, ?, 'system', ?, ?)")
    .run(chatId, senderId, text, now());
  const m = stmt.message.get(Number(r.lastInsertRowid));
  broadcastMessage(m);
  return m;
}

function markRead(chatId, userId, upToId) {
  const chat = stmt.chat.get(chatId);
  const rows = db.prepare(`SELECT id, sender_id FROM messages m
    WHERE m.chat_id = ? AND m.id <= ? AND m.kind != 'system' AND (m.sender_id IS NULL OR m.sender_id != ?)
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.message_id = m.id AND r.user_id = ?)`).all(chatId, upToId, userId, userId);
  if (!rows.length) return [];
  const at = now();
  const ins = db.prepare('INSERT OR IGNORE INTO receipts (message_id, user_id, read_at) VALUES (?, ?, ?)');
  tx(db, () => rows.forEach((r) => ins.run(r.id, userId, at)));
  const all = rows.map((r) => ({ messageId: r.id, senderId: r.sender_id, userId, readAt: at }));
  for (const uid of memberIds(chatId)) {
    const visible = chat.show_receipts ? all : all.filter((r) => r.senderId === uid);
    if (visible.length || uid === userId) {
      sendToUser(uid, {
        type: 'message:receipts', chatId,
        receipts: visible.map(({ messageId, userId: u, readAt }) => ({ messageId, userId: u, readAt })),
        readerId: userId,
        // сам читатель получает число отмеченных — чтобы обновить счётчик непрочитанных
        marked: uid === userId ? all.length : undefined,
      });
    }
  }
  return all;
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  // Клиент Tauri работает со своего адреса (tauri.localhost), поэтому разрешаем запросы с любого origin.
  // Авторизация идёт по токену в заголовке, cookies не используются.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

const HttpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) { next(e); }
};

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    const u = stmt.userById.get(payload.uid);
    if (!u || !u.is_active) return null;
    return u;
  } catch { return null; }
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  const u = token ? verifyToken(String(token)) : null;
  if (!u) return res.status(401).json({ error: 'Требуется вход' });
  req.user = u;
  next();
}
const adminOnly = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Только для администратора' }));

function requireMember(chatId, uid) {
  const m = stmt.member.get(chatId, uid);
  if (!m) throw HttpError(404, 'Чат не найден');
  return m;
}
function requireManager(chatId, uid) {
  const m = requireMember(chatId, uid);
  const chat = stmt.chat.get(chatId);
  if (chat.type !== 'group') throw HttpError(400, 'Только для групп');
  if (m.role === 'member') throw HttpError(403, 'Нужны права администратора группы');
  return m;
}

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'otmetka' }));
app.get('/api/config', (req, res) => res.json({ iceServers: ICE_SERVERS }));

app.post('/api/login', wrap((req, res) => {
  const { login, password } = req.body || {};
  const u = login ? stmt.userByLogin.get(String(login).trim()) : null;
  if (!u || !u.is_active || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    throw HttpError(401, 'Неверный логин или пароль');
  }
  const token = jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: userDto(u) });
}));

app.use('/api', auth);

app.get('/api/me', (req, res) => res.json(userDto(req.user)));

app.post('/api/me/password', wrap((req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(String(oldPassword || ''), req.user.password_hash)) throw HttpError(400, 'Текущий пароль неверный');
  if (!newPassword || String(newPassword).length < 6) throw HttpError(400, 'Новый пароль — не короче 6 символов');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), req.user.id);
  res.json({ ok: true });
}));

app.get('/api/users', (req, res) => {
  const rows = req.user.is_admin
    ? db.prepare('SELECT * FROM users ORDER BY name').all()
    : db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY name').all();
  res.json(rows.map(userDto));
});

app.post('/api/users', adminOnly, wrap((req, res) => {
  const { login, name, position = '', password, isAdmin = false } = req.body || {};
  if (!login || !name || !password) throw HttpError(400, 'Нужны логин, имя и пароль');
  if (String(password).length < 6) throw HttpError(400, 'Пароль — не короче 6 символов');
  if (stmt.userByLogin.get(String(login).trim())) throw HttpError(409, 'Такой логин уже есть');
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const r = db.prepare('INSERT INTO users (login, name, position, password_hash, is_admin, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(login).trim(), String(name).trim(), String(position).trim(), bcrypt.hashSync(String(password), 10),
      isAdmin ? 1 : 0, PALETTE[count % PALETTE.length], now());
  const u = stmt.userById.get(Number(r.lastInsertRowid));
  const dto = userDto(u);
  for (const uid of sockets.keys()) sendToUser(uid, { type: 'user:updated', user: dto });
  res.status(201).json(dto);
}));

app.patch('/api/users/:id', adminOnly, wrap((req, res) => {
  const u = stmt.userById.get(Number(req.params.id));
  if (!u) throw HttpError(404, 'Сотрудник не найден');
  const { name, position, password, isAdmin, isActive } = req.body || {};
  if (password !== undefined && String(password).length < 6) throw HttpError(400, 'Пароль — не короче 6 символов');
  if (u.id === req.user.id && (isAdmin === false || isActive === false)) throw HttpError(400, 'Нельзя снять права или отключить самого себя');
  db.prepare(`UPDATE users SET name = COALESCE(?, name), position = COALESCE(?, position),
      password_hash = COALESCE(?, password_hash), is_admin = COALESCE(?, is_admin), is_active = COALESCE(?, is_active) WHERE id = ?`)
    .run(name ?? null, position ?? null, password ? bcrypt.hashSync(String(password), 10) : null,
      isAdmin === undefined ? null : (isAdmin ? 1 : 0), isActive === undefined ? null : (isActive ? 1 : 0), u.id);
  const dto = userDto(stmt.userById.get(u.id));
  if (isActive === false) for (const ws of sockets.get(u.id) ?? []) ws.close(4001, 'disabled');
  for (const uid of sockets.keys()) sendToUser(uid, { type: 'user:updated', user: dto });
  res.json(dto);
}));

// ----- Чаты -----
app.get('/api/chats', (req, res) => {
  const ids = db.prepare('SELECT chat_id FROM members WHERE user_id = ?').all(req.user.id).map((r) => r.chat_id);
  const list = ids.map((id) => chatDto(id, req.user.id))
    .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt));
  res.json(list);
});

function findOrCreateDirect(a, b) {
  const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
  const existing = db.prepare('SELECT id FROM chats WHERE direct_key = ?').get(key);
  if (existing) return { id: existing.id, created: false };
  const id = tx(db, () => {
    const r = db.prepare("INSERT INTO chats (type, direct_key, created_by, created_at) VALUES ('direct', ?, ?, ?)").run(key, a, now());
    const cid = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
    ins.run(cid, a, now());
    if (a !== b) ins.run(cid, b, now());
    return cid;
  });
  return { id, created: true };
}

app.post('/api/chats/direct', wrap((req, res) => {
  const other = stmt.userById.get(Number(req.body?.userId));
  if (!other || !other.is_active) throw HttpError(404, 'Сотрудник не найден');
  if (other.id === req.user.id) throw HttpError(400, 'Нельзя написать самому себе');
  const { id, created } = findOrCreateDirect(req.user.id, other.id);
  if (created) broadcastChat(id);
  res.json(chatDto(id, req.user.id));
}));

app.post('/api/chats/group', wrap((req, res) => {
  const { title, color = '#C2410C', address = '', memberIds: ids = [], showReceipts = true } = req.body || {};
  if (!title || !String(title).trim()) throw HttpError(400, 'Укажите название группы');
  const unique = [...new Set(ids.map(Number))].filter((id) => id !== req.user.id && stmt.userById.get(id)?.is_active);
  const chatId = tx(db, () => {
    const r = db.prepare("INSERT INTO chats (type, title, color, address, show_receipts, created_by, created_at) VALUES ('group', ?, ?, ?, ?, ?, ?)")
      .run(String(title).trim(), String(color), String(address).trim(), showReceipts ? 1 : 0, req.user.id, now());
    const cid = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(cid, req.user.id, now());
    const ins = db.prepare("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
    unique.forEach((id) => ins.run(cid, id, now()));
    return cid;
  });
  addSystemMessage(chatId, `${req.user.name} создал(а) группу «${String(title).trim()}»`);
  broadcastChat(chatId);
  res.status(201).json(chatDto(chatId, req.user.id));
}));

app.patch('/api/chats/:id', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireManager(chatId, req.user.id);
  const { title, color, address, showReceipts } = req.body || {};
  if (title !== undefined && !String(title).trim()) throw HttpError(400, 'Название не может быть пустым');
  db.prepare(`UPDATE chats SET title = COALESCE(?, title), color = COALESCE(?, color), address = COALESCE(?, address),
      show_receipts = COALESCE(?, show_receipts) WHERE id = ?`)
    .run(title?.trim() ?? null, color ?? null, address ?? null, showReceipts === undefined ? null : (showReceipts ? 1 : 0), chatId);
  broadcastChat(chatId);
  res.json(chatDto(chatId, req.user.id));
}));

app.post('/api/chats/:id/members', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireManager(chatId, req.user.id);
  const ids = [...new Set((req.body?.userIds ?? []).map(Number))]
    .filter((id) => stmt.userById.get(id)?.is_active && !stmt.member.get(chatId, id));
  if (!ids.length) throw HttpError(400, 'Нет новых участников');
  const ins = db.prepare("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
  tx(db, () => ids.forEach((id) => ins.run(chatId, id, now())));
  const names = ids.map((id) => stmt.userById.get(id).name).join(', ');
  addSystemMessage(chatId, `${req.user.name} добавил(а): ${names}`);
  broadcastChat(chatId);
  res.json(chatDto(chatId, req.user.id));
}));

app.patch('/api/chats/:id/members/:userId', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const me = requireManager(chatId, req.user.id);
  const target = stmt.member.get(chatId, targetId);
  if (!target) throw HttpError(404, 'Участник не найден');
  const { role } = req.body || {};
  if (!['admin', 'member'].includes(role)) throw HttpError(400, 'Роль: admin или member');
  if (target.role === 'owner') throw HttpError(400, 'Роль владельца менять нельзя');
  if (me.role !== 'owner' && target.role === 'admin') throw HttpError(403, 'Только владелец меняет роли администраторов');
  db.prepare('UPDATE members SET role = ? WHERE chat_id = ? AND user_id = ?').run(role, chatId, targetId);
  broadcastChat(chatId);
  res.json(chatDto(chatId, req.user.id));
}));

app.delete('/api/chats/:id/members/:userId', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const chat = stmt.chat.get(chatId);
  const me = requireMember(chatId, req.user.id);
  if (chat.type !== 'group') throw HttpError(400, 'Только для групп');
  const target = stmt.member.get(chatId, targetId);
  if (!target) throw HttpError(404, 'Участник не найден');
  const leaving = targetId === req.user.id;
  if (!leaving) {
    if (me.role === 'member') throw HttpError(403, 'Нужны права администратора группы');
    if (target.role === 'owner') throw HttpError(403, 'Владельца исключить нельзя');
    if (target.role === 'admin' && me.role !== 'owner') throw HttpError(403, 'Администратора исключает только владелец');
  }
  db.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?').run(chatId, targetId);
  // Владелец ушёл — передаём права самому давнему участнику
  if (leaving && target.role === 'owner') {
    const next = db.prepare("SELECT user_id FROM members WHERE chat_id = ? ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1").get(chatId);
    if (next) db.prepare("UPDATE members SET role = 'owner' WHERE chat_id = ? AND user_id = ?").run(chatId, next.user_id);
  }
  sendToUser(targetId, { type: 'chat:removed', chatId });
  const targetName = stmt.userById.get(targetId).name;
  if (memberIds(chatId).length) {
    addSystemMessage(chatId, leaving ? `${targetName} покинул(а) группу` : `${req.user.name} исключил(а): ${targetName}`);
    broadcastChat(chatId);
  }
  res.json({ ok: true });
}));

// ----- Сообщения -----
app.get('/api/chats/:id/messages', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const chat = stmt.chat.get(chatId);
  const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chatId, before, limit);
  res.json(rows.reverse().map((m) => messageDto(m, req.user.id, chat)));
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
});

app.post('/api/chats/:id/messages', upload.array('files', 10), wrap((req, res) => {
  const chatId = Number(req.params.id);
  const files = req.files ?? [];
  try {
    requireMember(chatId, req.user.id);
  } catch (e) {
    files.forEach((f) => fs.rm(f.path, () => {}));
    throw e;
  }
  const text = String(req.body?.text ?? '').trim();
  if (!text && !files.length) throw HttpError(400, 'Пустое сообщение');
  if (text.length > 10_000) throw HttpError(400, 'Сообщение слишком длинное');
  const important = req.body?.important === 'true' || req.body?.important === true ? 1 : 0;
  const msgId = tx(db, () => {
    const r = db.prepare("INSERT INTO messages (chat_id, sender_id, kind, text, important, created_at) VALUES (?, ?, 'text', ?, ?, ?)")
      .run(chatId, req.user.id, text, important, now());
    const mid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO attachments (message_id, kind, file_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of files) {
      const mime = f.mimetype || 'application/octet-stream';
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
      // multer отдаёт имя в latin1 — восстанавливаем кириллицу
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      ins.run(mid, kind, name, f.filename, mime, f.size);
    }
    return mid;
  });
  const m = stmt.message.get(msgId);
  broadcastMessage(m);
  res.status(201).json(messageDto(m, req.user.id));
}));

app.post('/api/chats/:id/read', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  const upTo = Number(req.body?.upToId);
  if (!upTo) throw HttpError(400, 'upToId обязателен');
  const r = markRead(chatId, req.user.id, upTo);
  res.json({ marked: r.length });
}));

app.get('/api/messages/:id/receipts', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  if (!m) throw HttpError(404, 'Сообщение не найдено');
  requireMember(m.chat_id, req.user.id);
  const chat = stmt.chat.get(m.chat_id);
  if (!canSeeReceipts(chat, m, req.user.id)) throw HttpError(403, 'В этой группе прочтения видит только автор');
  const read = stmt.receipts.all(m.id);
  const readIds = new Set(read.map((r) => r.userId));
  const notRead = memberIds(m.chat_id).filter((id) => id !== m.sender_id && !readIds.has(id));
  res.json({ read, notRead });
}));

// ----- Файлы -----
app.get('/files/:name', auth, wrap((req, res) => {
  const name = path.basename(req.params.name);
  const a = db.prepare(`SELECT a.*, m.chat_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.stored_name = ?`).get(name);
  if (!a) throw HttpError(404, 'Файл не найден');
  requireMember(a.chat_id, req.user.id);
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(a.mime);
  res.sendFile(path.join(UPLOAD_DIR, name));
}));

// ----- Веб-клиент -----
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { index: false }));
  app.get(/^\/(?!api|files|ws).*/, (req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('Сервер «Отметка» работает. Веб-клиент не собран (нет client/dist).'));
}

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${MAX_UPLOAD_MB} МБ` : 'Ошибка загрузки файла' });
  }
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Внутренняя ошибка сервера' });
});

// ---------- Звонки 1-на-1 (сигналинг WebRTC) ----------
const calls = new Map(); // callId -> { id, from, to, video, callerWs, calleeWs, acceptedAt, timer }

function sendWs(ws, event) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(event));
}

function finishCall(call, outcome) {
  if (!calls.has(call.id)) return;
  clearTimeout(call.timer);
  calls.delete(call.id);
  const duration = call.acceptedAt ? Math.round((now() - call.acceptedAt) / 1000) : 0;
  const { id: chatId, created } = findOrCreateDirect(call.from, call.to);
  if (created) broadcastChat(chatId);
  const text = JSON.stringify({ video: call.video, outcome, duration });
  const r = db.prepare("INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?, ?, 'call', ?, ?)")
    .run(chatId, call.from, text, now());
  broadcastMessage(stmt.message.get(Number(r.lastInsertRowid)));
}

function handleCallEvent(ws, uid, msg) {
  const call = msg.callId ? calls.get(msg.callId) : null;
  switch (msg.type) {
    case 'call:invite': {
      const to = stmt.userById.get(Number(msg.toUserId));
      if (!to || !to.is_active || to.id === uid) return sendWs(ws, { type: 'call:ended', callId: msg.callId, reason: 'unavailable' });
      const busy = [...calls.values()].some((c) => [c.from, c.to].includes(to.id) || [c.from, c.to].includes(uid));
      const c = { id: String(msg.callId), from: uid, to: to.id, video: !!msg.video, callerWs: ws, calleeWs: null, acceptedAt: null, timer: null };
      calls.set(c.id, c);
      if (busy) { sendWs(ws, { type: 'call:ended', callId: c.id, reason: 'busy' }); return finishCall(c, 'missed'); }
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
      sendWs(call.callerWs, { type: 'call:ended', callId: call.id, reason: msg.reason === 'busy' ? 'busy' : 'rejected' });
      for (const s of sockets.get(uid) ?? []) if (s !== ws) sendWs(s, { type: 'call:ended', callId: call.id, reason: 'rejected' });
      return finishCall(call, msg.reason === 'busy' ? 'missed' : 'rejected');
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
      // все устройства вызываемого отключились, пока шёл вызов
      sendWs(c.callerWs, { type: 'call:ended', callId: c.id, reason: 'offline' });
      finishCall(c, 'missed');
    }
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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
      for (const id of memberIds(chatId)) if (id !== uid) sendToUser(id, { type: 'typing', chatId, userId: uid });
      return;
    }
    if (msg.type.startsWith('call:')) return handleCallEvent(ws, uid, msg);
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
  });
});

setInterval(() => {
  for (const set of sockets.values()) for (const ws of set) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

function attachUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const user = verifyToken(url.searchParams.get('token') || '');
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });
}

const httpServer = http.createServer(app);
attachUpgrade(httpServer);
httpServer.listen(PORT, () => console.log(`«Отметка»: http://0.0.0.0:${PORT}`));

if (HTTPS_PORT) {
  // HTTPS нужен браузерам для доступа к камере и микрофону не с localhost.
  // Клиент Tauri работает и по обычному HTTP.
  const certFile = path.join(DATA_DIR, 'cert.pem');
  const keyFile = path.join(DATA_DIR, 'key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'otmetka.local' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private);
  }
  const httpsServer = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
  attachUpgrade(httpsServer);
  httpsServer.listen(HTTPS_PORT, () => console.log(`«Отметка»: https://0.0.0.0:${HTTPS_PORT} (самоподписанный сертификат)`));
}

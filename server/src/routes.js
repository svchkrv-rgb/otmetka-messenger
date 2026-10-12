// REST API мессенджера.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import {
  db, tx, now, stmt, HttpError, SECRET, PALETTE, json, randomName,
  userDto, chatDto, messageDto, memberIds, visibleSince, sockets,
  sendToUser, broadcastMessage, broadcastUpdate, broadcastChat, broadcastUser, addSystemMessage, insertMessage, markRead,
  requireMember, requireManager, requireGroup, canAddMembers, canSeeUser, canSeeReceipts, removeFiles,
} from './core.js';
import { UPLOAD_DIR, AVATAR_DIR, MAX_UPLOAD_MB, ICE_SERVERS, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } from './config.js';
import { findOrCreateDirect } from './directs.js';

export const router = express.Router();

const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) { next(e); }
};

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    const u = stmt.userById.get(payload.uid);
    if (!u || !u.is_active) return null;
    return u;
  } catch { return null; }
}
const issueToken = (u) => jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' });

export function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  const u = token ? verifyToken(String(token)) : null;
  if (!u) return res.status(401).json({ error: 'Требуется вход' });
  req.user = u;
  next();
}
const optionalAuth = (req, res, next) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) req.user = verifyToken(h.slice(7));
  next();
};
const adminOnly = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Только для администратора' }));
const staffOnly = (req, res, next) => (!req.user.is_guest ? next() : res.status(403).json({ error: 'Недоступно для гостей' }));

const str = (v, max = 10_000) => String(v ?? '').trim().slice(0, max);
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;

// ---------- Загрузка файлов ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
      cb(null, randomName(ext));
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
});
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => cb(null, randomName(path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 6) || '.jpg')),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function fileKind(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function describeFiles(files, metaList) {
  return files.map((f, i) => {
    const mime = f.mimetype || 'application/octet-stream';
    const meta = metaList?.[i] && typeof metaList[i] === 'object' ? metaList[i] : null;
    let kind = fileKind(mime);
    if (meta?.voice) kind = 'audio';
    // multer отдаёт имя в latin1 — восстанавливаем кириллицу
    const fileName = Buffer.from(f.originalname || 'файл', 'latin1').toString('utf8');
    const cleanMeta = meta ? {
      voice: !!meta.voice,
      duration: Number(meta.duration) || undefined,
      peaks: Array.isArray(meta.peaks) ? meta.peaks.slice(0, 120).map((p) => Math.max(0, Math.min(1, Number(p) || 0))) : undefined,
      width: Number(meta.width) || undefined,
      height: Number(meta.height) || undefined,
    } : null;
    return { kind, fileName, storedName: f.filename, mime, size: f.size, meta: cleanMeta };
  });
}

// ---------- Упоминания ----------
/** Проверить упоминания; не-участников группы добавить, если у автора есть право. */
function resolveMentions(chatId, sender, ids) {
  const chat = stmt.chat.get(chatId);
  const me = stmt.member.get(chatId, sender.id);
  const result = new Set();
  const added = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = Number(raw);
    if (id === 0) { if (chat.type === 'group') result.add(0); continue; }
    if (!id || id === sender.id) continue;
    if (stmt.member.get(chatId, id)) { result.add(id); continue; }
    const u = stmt.userById.get(id);
    if (u && u.is_active && chat.type === 'group' && canAddMembers(chat, me)) {
      db.prepare('INSERT OR IGNORE INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
        .run(chatId, id, u.is_guest ? 'guest' : 'member', now() - 1);
      added.push(u);
      result.add(id);
    }
  }
  if (added.length) {
    addSystemMessage(chatId, `${sender.name} добавил(а) по упоминанию: ${added.map((u) => u.name).join(', ')}`);
    broadcastChat(chatId);
  }
  return [...result];
}

function checkReply(chatId, replyTo) {
  const id = Number(replyTo) || null;
  if (!id) return null;
  const r = stmt.message.get(id);
  if (!r || r.chat_id !== chatId) throw HttpError(400, 'Сообщение для ответа не найдено');
  return id;
}

function sendNow(chatId, sender, p) {
  const m = insertMessage({
    chatId, senderId: sender.id, kind: p.kind || 'text', text: p.text || '', important: p.important, silent: p.silent,
    replyTo: p.replyTo, meta: p.meta, files: p.files || [], mentions: p.mentions || [],
  });
  broadcastMessage(m);
  return m;
}

// ================= Сервисное =================
router.get('/health', (req, res) => res.json({ ok: true, name: 'otmetka', version: 2 }));
router.get('/config', (req, res) => res.json({ iceServers: ICE_SERVERS, groupCalls: !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET), maxUploadMb: MAX_UPLOAD_MB }));

router.post('/login', wrap((req, res) => {
  const { login, password } = req.body || {};
  const u = login ? stmt.userByLogin.get(String(login).trim()) : null;
  if (!u || !u.is_active || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    throw HttpError(401, 'Неверный логин или пароль');
  }
  res.json({ token: issueToken(u), user: userDto(u) });
}));

// ----- Приглашения (без входа) -----
function validInvite(token) {
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(String(token));
  if (!inv || inv.expires_at < now()) return null;
  const chat = stmt.chat.get(inv.chat_id);
  return chat ? { inv, chat } : null;
}
router.get('/invites/:token', wrap((req, res) => {
  const v = validInvite(req.params.token);
  if (!v) throw HttpError(404, 'Приглашение недействительно или истекло');
  res.json({ chatTitle: v.chat.title, color: v.chat.color, address: v.chat.address, expiresAt: v.inv.expires_at, members: memberIds(v.chat.id).length });
}));
router.post('/invites/:token/accept', optionalAuth, wrap((req, res) => {
  const v = validInvite(req.params.token);
  if (!v) throw HttpError(404, 'Приглашение недействительно или истекло');
  let u = req.user;
  if (!u) {
    const { name, login, password, position = '' } = req.body || {};
    if (!str(name) || !str(login) || !password) throw HttpError(400, 'Укажите имя, логин и пароль');
    if (String(password).length < 6) throw HttpError(400, 'Пароль — не короче 6 символов');
    if (stmt.userByLogin.get(str(login))) throw HttpError(409, 'Такой логин уже занят');
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const r = db.prepare(`INSERT INTO users (login, name, position, password_hash, is_guest, color, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(str(login, 60), str(name, 80), str(position, 80), bcrypt.hashSync(String(password), 10), PALETTE[count % PALETTE.length], now());
    u = stmt.userById.get(Number(r.lastInsertRowid));
    broadcastUser(u);
  }
  if (!stmt.member.get(v.chat.id, u.id)) {
    db.prepare('INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(v.chat.id, u.id, u.is_guest ? 'guest' : 'member', now());
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE token = ?').run(v.inv.token);
    addSystemMessage(v.chat.id, `${u.name} присоединился(ась) по приглашению`);
    broadcastChat(v.chat.id);
  }
  res.json({ token: issueToken(u), user: userDto(u), chatId: v.chat.id });
}));

router.use(auth);

// ================= Профиль =================
router.get('/me', (req, res) => res.json(userDto(req.user)));

router.patch('/me', wrap((req, res) => {
  const { statusText, statusUntil, name, position } = req.body || {};
  const u = req.user;
  db.prepare(`UPDATE users SET status_text = COALESCE(?, status_text), status_until = ?, name = COALESCE(?, name), position = COALESCE(?, position) WHERE id = ?`)
    .run(statusText !== undefined ? str(statusText, 80) : null,
      statusText !== undefined ? (Number(statusUntil) || null) : u.status_until,
      name ? str(name, 80) : null, position !== undefined ? str(position, 80) : null, u.id);
  const fresh = stmt.userById.get(u.id);
  broadcastUser(fresh);
  res.json(userDto(fresh));
}));

router.post('/me/password', wrap((req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(String(oldPassword || ''), req.user.password_hash)) throw HttpError(400, 'Текущий пароль неверный');
  if (!newPassword || String(newPassword).length < 6) throw HttpError(400, 'Новый пароль — не короче 6 символов');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), req.user.id);
  res.json({ ok: true });
}));

router.post('/me/avatar', avatarUpload.single('avatar'), wrap((req, res) => {
  if (!req.file && !bool(req.body?.remove)) throw HttpError(400, 'Нужна картинка');
  const old = req.user.avatar;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(req.file ? req.file.filename : null, req.user.id);
  removeFiles([old], AVATAR_DIR);
  const fresh = stmt.userById.get(req.user.id);
  broadcastUser(fresh);
  res.json(userDto(fresh));
}));

// ================= Сотрудники =================
router.get('/users', (req, res) => {
  const rows = req.user.is_admin
    ? db.prepare('SELECT * FROM users ORDER BY name').all()
    : db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY name').all();
  res.json(rows.filter((u) => canSeeUser(req.user, u.id)).map(userDto));
});

router.post('/users', adminOnly, wrap((req, res) => {
  const { login, name, position = '', department = '', password, isAdmin = false, isGuest = false } = req.body || {};
  if (!str(login) || !str(name) || !password) throw HttpError(400, 'Нужны логин, имя и пароль');
  if (String(password).length < 6) throw HttpError(400, 'Пароль — не короче 6 символов');
  if (stmt.userByLogin.get(str(login))) throw HttpError(409, 'Такой логин уже есть');
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const r = db.prepare(`INSERT INTO users (login, name, position, department, password_hash, is_admin, is_guest, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(str(login, 60), str(name, 80), str(position, 80), str(department, 60), bcrypt.hashSync(String(password), 10),
      isAdmin && !isGuest ? 1 : 0, isGuest ? 1 : 0, PALETTE[count % PALETTE.length], now());
  const u = stmt.userById.get(Number(r.lastInsertRowid));
  broadcastUser(u);
  res.status(201).json(userDto(u));
}));

router.patch('/users/:id', adminOnly, wrap((req, res) => {
  const u = stmt.userById.get(Number(req.params.id));
  if (!u) throw HttpError(404, 'Сотрудник не найден');
  const { name, position, department, password, isAdmin, isActive, isGuest } = req.body || {};
  if (password && String(password).length < 6) throw HttpError(400, 'Пароль — не короче 6 символов');
  if (u.id === req.user.id && (isAdmin === false || isActive === false || isGuest === true)) throw HttpError(400, 'Нельзя снять права или отключить самого себя');
  const nb = (v) => (v === undefined ? null : (v ? 1 : 0));
  db.prepare(`UPDATE users SET name = COALESCE(?, name), position = COALESCE(?, position), department = COALESCE(?, department),
      password_hash = COALESCE(?, password_hash), is_admin = COALESCE(?, is_admin), is_active = COALESCE(?, is_active), is_guest = COALESCE(?, is_guest) WHERE id = ?`)
    .run(name ? str(name, 80) : null, position !== undefined ? str(position, 80) : null, department !== undefined ? str(department, 60) : null,
      password ? bcrypt.hashSync(String(password), 10) : null, nb(isAdmin), nb(isActive), nb(isGuest), u.id);
  const fresh = stmt.userById.get(u.id);
  if (fresh.is_guest && fresh.is_admin) db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(u.id);
  if (isActive === false) for (const ws of sockets.get(u.id) ?? []) ws.close(4001, 'disabled');
  const final = stmt.userById.get(u.id);
  broadcastUser(final);
  res.json(userDto(final));
}));

// ================= Чаты =================
router.get('/chats', (req, res) => {
  const ids = db.prepare('SELECT chat_id FROM members WHERE user_id = ?').all(req.user.id).map((r) => r.chat_id);
  const list = ids.map((id) => chatDto(id, req.user.id))
    .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt));
  res.json(list);
});

router.post('/chats/direct', wrap((req, res) => {
  const other = stmt.userById.get(Number(req.body?.userId));
  if (!other || !other.is_active || !canSeeUser(req.user, other.id)) throw HttpError(404, 'Сотрудник не найден');
  if (other.id === req.user.id) throw HttpError(400, 'Нельзя написать самому себе');
  const { id, created } = findOrCreateDirect(req.user.id, other.id);
  if (created) broadcastChat(id);
  res.json(chatDto(id, req.user.id));
}));

const ROLES = ['admin', 'member', 'guest'];

router.post('/chats/group', staffOnly, wrap((req, res) => {
  const b = req.body || {};
  const title = str(b.title, 80);
  if (!title) throw HttpError(400, 'Укажите название группы');
  // members: [{userId, role}] или memberIds: [id]
  const list = Array.isArray(b.members) ? b.members : (b.memberIds || []).map((id) => ({ userId: id }));
  const seen = new Set([req.user.id]);
  const members = [];
  for (const m of list) {
    const id = Number(m.userId);
    const u = stmt.userById.get(id);
    if (!u || !u.is_active || seen.has(id)) continue;
    seen.add(id);
    members.push({ id, role: u.is_guest ? 'guest' : (ROLES.includes(m.role) ? m.role : 'member') });
  }
  const chatId = tx(db, () => {
    const r = db.prepare(`INSERT INTO chats (type, title, color, address, show_receipts, history_for_new, members_can_add, guest_download, created_by, created_at)
      VALUES ('group', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(title, str(b.color, 20) || '#C2410C', str(b.address, 160), b.showReceipts === false ? 0 : 1,
        b.historyForNew === false ? 0 : 1, b.membersCanAdd ? 1 : 0, b.guestDownload ? 1 : 0, req.user.id, now());
    const cid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    ins.run(cid, req.user.id, 'owner', now());
    members.forEach((m) => ins.run(cid, m.id, m.role, now()));
    return cid;
  });
  addSystemMessage(chatId, `${req.user.name} создал(а) группу «${title}»`);
  broadcastChat(chatId);
  res.status(201).json(chatDto(chatId, req.user.id));
}));

router.patch('/chats/:id', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireManager(chatId, req.user.id);
  const b = req.body || {};
  if (b.title !== undefined && !str(b.title)) throw HttpError(400, 'Название не может быть пустым');
  const nb = (v) => (v === undefined ? null : (v ? 1 : 0));
  db.prepare(`UPDATE chats SET title = COALESCE(?, title), color = COALESCE(?, color), address = COALESCE(?, address),
      show_receipts = COALESCE(?, show_receipts), history_for_new = COALESCE(?, history_for_new),
      members_can_add = COALESCE(?, members_can_add), guest_download = COALESCE(?, guest_download) WHERE id = ?`)
    .run(b.title !== undefined ? str(b.title, 80) : null, b.color ? str(b.color, 20) : null, b.address !== undefined ? str(b.address, 160) : null,
      nb(b.showReceipts), nb(b.historyForNew), nb(b.membersCanAdd), nb(b.guestDownload), chatId);
  broadcastChat(chatId);
  res.json(chatDto(chatId, req.user.id));
}));

router.post('/chats/:id/avatar', avatarUpload.single('avatar'), wrap((req, res) => {
  const chatId = Number(req.params.id);
  try { requireManager(chatId, req.user.id); } catch (e) { if (req.file) removeFiles([req.file.filename], AVATAR_DIR); throw e; }
  const chat = stmt.chat.get(chatId);
  if (!req.file && !bool(req.body?.remove)) throw HttpError(400, 'Нужна картинка');
  db.prepare('UPDATE chats SET avatar = ? WHERE id = ?').run(req.file ? req.file.filename : null, chatId);
  removeFiles([chat.avatar], AVATAR_DIR);
  broadcastChat(chatId);
  res.json(chatDto(chatId, req.user.id));
}));

router.patch('/chats/:id/mute', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  db.prepare('UPDATE members SET muted = ? WHERE chat_id = ? AND user_id = ?').run(bool(req.body?.muted) ? 1 : 0, chatId, req.user.id);
  const dto = chatDto(chatId, req.user.id);
  sendToUser(req.user.id, { type: 'chat:updated', chat: dto });
  res.json(dto);
}));

router.post('/chats/:id/members', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const me = requireMember(chatId, req.user.id);
  const chat = requireGroup(chatId);
  if (!canAddMembers(chat, me)) throw HttpError(403, 'Добавлять участников могут только администраторы группы');
  const list = Array.isArray(req.body?.members) ? req.body.members : (req.body?.userIds ?? []).map((id) => ({ userId: id }));
  const added = [];
  tx(db, () => {
    for (const m of list) {
      const id = Number(m.userId);
      const u = stmt.userById.get(id);
      if (!u || !u.is_active || stmt.member.get(chatId, id)) continue;
      const role = u.is_guest ? 'guest' : (ROLES.includes(m.role) && (me.role !== 'member' || m.role !== 'admin') ? m.role : 'member');
      db.prepare('INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(chatId, id, role, now());
      added.push(u);
    }
  });
  if (!added.length) throw HttpError(400, 'Нет новых участников');
  addSystemMessage(chatId, `${req.user.name} добавил(а): ${added.map((u) => u.name).join(', ')}`);
  broadcastChat(chatId);
  res.json(chatDto(chatId, req.user.id));
}));

router.patch('/chats/:id/members/:userId', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const me = requireManager(chatId, req.user.id);
  const target = stmt.member.get(chatId, targetId);
  if (!target) throw HttpError(404, 'Участник не найден');
  const { role } = req.body || {};
  if (!ROLES.includes(role)) throw HttpError(400, 'Роль: admin, member или guest');
  if (target.role === 'owner') throw HttpError(400, 'Роль владельца менять нельзя');
  if (me.role !== 'owner' && (target.role === 'admin' || role === 'admin')) throw HttpError(403, 'Администраторов назначает только владелец');
  if (stmt.userById.get(targetId)?.is_guest && role !== 'guest') throw HttpError(400, 'Внешний участник может быть только гостем');
  db.prepare('UPDATE members SET role = ? WHERE chat_id = ? AND user_id = ?').run(role, chatId, targetId);
  broadcastChat(chatId);
  res.json(chatDto(chatId, req.user.id));
}));

router.delete('/chats/:id/members/:userId', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const me = requireMember(chatId, req.user.id);
  requireGroup(chatId);
  const target = stmt.member.get(chatId, targetId);
  if (!target) throw HttpError(404, 'Участник не найден');
  const leaving = targetId === req.user.id;
  if (!leaving) {
    if (me.role !== 'owner' && me.role !== 'admin') throw HttpError(403, 'Нужны права администратора группы');
    if (target.role === 'owner') throw HttpError(403, 'Владельца исключить нельзя');
    if (target.role === 'admin' && me.role !== 'owner') throw HttpError(403, 'Администратора исключает только владелец');
  }
  db.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?').run(chatId, targetId);
  if (leaving && target.role === 'owner') {
    const next = db.prepare("SELECT user_id FROM members WHERE chat_id = ? AND role != 'guest' ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1").get(chatId);
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

router.post('/chats/:id/invites', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const me = requireMember(chatId, req.user.id);
  const chat = requireGroup(chatId);
  if (!canAddMembers(chat, me)) throw HttpError(403, 'Приглашать могут только администраторы группы');
  const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 30);
  const token = crypto.randomBytes(12).toString('base64url');
  const expiresAt = now() + days * 86400000;
  db.prepare('INSERT INTO invites (token, chat_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(token, chatId, req.user.id, expiresAt, now());
  res.status(201).json({ token, path: `/invite/${token}`, expiresAt });
}));

// ================= Сообщения =================
router.get('/chats/:id/messages', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const me = requireMember(chatId, req.user.id);
  const chat = stmt.chat.get(chatId);
  const since = visibleSince(chat, me);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  let rows;
  if (req.query.around) {
    const id = Number(req.query.around);
    const half = Math.floor(limit / 2);
    const before = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id <= ? AND created_at >= ? ORDER BY id DESC LIMIT ?').all(chatId, id, since, half);
    const after = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? AND created_at >= ? ORDER BY id ASC LIMIT ?').all(chatId, id, since, half);
    rows = [...before.reverse(), ...after];
  } else if (req.query.after) {
    rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? AND created_at >= ? ORDER BY id ASC LIMIT ?').all(chatId, Number(req.query.after), since, limit);
  } else {
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? AND created_at >= ? ORDER BY id DESC LIMIT ?').all(chatId, before, since, limit).reverse();
  }
  res.json(rows.map((m) => messageDto(m, req.user.id, chat)));
}));

router.post('/chats/:id/messages', upload.array('files', 10), wrap((req, res) => {
  const chatId = Number(req.params.id);
  const files = req.files ?? [];
  try {
    requireMember(chatId, req.user.id);
    const b = req.body || {};
    const text = String(b.text ?? '').trim();
    if (!text && !files.length) throw HttpError(400, 'Пустое сообщение');
    if (text.length > 10_000) throw HttpError(400, 'Сообщение слишком длинное');
    const payload = {
      text,
      important: bool(b.important),
      silent: bool(b.silent),
      replyTo: checkReply(chatId, b.replyTo),
      files: describeFiles(files, json(b.filesMeta, [])),
      mentionIds: json(b.mentions, []),
    };
    const sendAt = Number(b.sendAt) || 0;
    if (sendAt > now() + 15_000) {
      if (sendAt > now() + 366 * 86400000) throw HttpError(400, 'Слишком далёкая дата отправки');
      const r = db.prepare('INSERT INTO scheduled (chat_id, sender_id, payload, send_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(chatId, req.user.id, JSON.stringify(payload), sendAt, now());
      const item = scheduledDto(db.prepare('SELECT * FROM scheduled WHERE id = ?').get(Number(r.lastInsertRowid)));
      sendToUser(req.user.id, { type: 'scheduled:added', item });
      return res.status(201).json({ scheduled: item });
    }
    payload.mentions = resolveMentions(chatId, req.user, payload.mentionIds);
    const m = sendNow(chatId, req.user, payload);
    res.status(201).json(messageDto(m, req.user.id));
  } catch (e) {
    removeFiles(files.map((f) => f.filename));
    throw e;
  }
}));

router.patch('/messages/:id', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  if (!m || m.deleted_at) throw HttpError(404, 'Сообщение не найдено');
  requireMember(m.chat_id, req.user.id);
  if (m.sender_id !== req.user.id) throw HttpError(403, 'Редактировать можно только свои сообщения');
  if (!['text', 'task', 'poll'].includes(m.kind)) throw HttpError(400, 'Это сообщение нельзя изменить');
  const text = String(req.body?.text ?? '').trim().slice(0, 10_000);
  const hasFiles = stmt.attachments.all(m.id).length > 0;
  if (!text && !hasFiles) throw HttpError(400, 'Текст не может быть пустым');
  tx(db, () => {
    db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now(), m.id);
    if (m.kind === 'task') db.prepare('UPDATE tasks SET title = ? WHERE message_id = ?').run(text, m.id);
    if (Array.isArray(req.body?.mentions)) {
      db.prepare('DELETE FROM mentions WHERE message_id = ?').run(m.id);
      const ins = db.prepare('INSERT OR IGNORE INTO mentions (message_id, user_id) VALUES (?, ?)');
      for (const id of req.body.mentions.map(Number)) if (id === 0 || stmt.member.get(m.chat_id, id)) ins.run(m.id, id);
    }
  });
  broadcastUpdate(m.id);
  res.json(messageDto(stmt.message.get(m.id), req.user.id));
}));

router.delete('/messages/:id', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  if (!m || m.deleted_at) throw HttpError(404, 'Сообщение не найдено');
  const me = requireMember(m.chat_id, req.user.id);
  const chat = stmt.chat.get(m.chat_id);
  const manager = chat.type === 'group' && (me.role === 'owner' || me.role === 'admin');
  if (m.sender_id !== req.user.id && !manager) throw HttpError(403, 'Удалять можно только свои сообщения');
  if (m.kind === 'system') throw HttpError(400, 'Служебные сообщения не удаляются');
  const files = stmt.attachments.all(m.id).map((a) => a.stored_name);
  tx(db, () => {
    db.prepare("UPDATE messages SET deleted_at = ?, text = '' WHERE id = ?").run(now(), m.id);
    db.prepare('DELETE FROM attachments WHERE message_id = ?').run(m.id);
    db.prepare('DELETE FROM mentions WHERE message_id = ?').run(m.id);
    db.prepare('DELETE FROM tasks WHERE message_id = ?').run(m.id);
  });
  removeFiles(files);
  broadcastUpdate(m.id);
  res.json({ ok: true });
}));

router.post('/chats/:id/read', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  const upTo = Number(req.body?.upToId);
  if (!upTo) throw HttpError(400, 'upToId обязателен');
  res.json({ marked: markRead(chatId, req.user.id, upTo).length });
}));

router.get('/messages/:id/receipts', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  if (!m) throw HttpError(404, 'Сообщение не найдено');
  requireMember(m.chat_id, req.user.id);
  const chat = stmt.chat.get(m.chat_id);
  if (!canSeeReceipts(chat, m, req.user.id)) throw HttpError(403, 'В этой группе прочтения видит только автор');
  const read = stmt.receipts.all(m.id);
  const confirmed = stmt.confirmations.all(m.id);
  const readIds = new Set(read.map((r) => r.userId));
  const notRead = memberIds(m.chat_id).filter((id) => id !== m.sender_id && !readIds.has(id));
  res.json({ read, notRead, confirmed, important: !!m.important });
}));

router.post('/messages/:id/confirm', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  if (!m || m.deleted_at) throw HttpError(404, 'Сообщение не найдено');
  requireMember(m.chat_id, req.user.id);
  if (!m.important) throw HttpError(400, 'Подтверждение не требуется');
  if (m.sender_id === req.user.id) throw HttpError(400, 'Это ваше сообщение');
  db.prepare('INSERT OR IGNORE INTO confirmations (message_id, user_id, at) VALUES (?, ?, ?)').run(m.id, req.user.id, now());
  markRead(m.chat_id, req.user.id, m.id);
  broadcastUpdate(m.id);
  res.json({ ok: true });
}));

const lastRemind = new Map();
router.post('/messages/:id/remind', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  if (!m || m.deleted_at) throw HttpError(404, 'Сообщение не найдено');
  const me = requireMember(m.chat_id, req.user.id);
  const chat = stmt.chat.get(m.chat_id);
  if (m.sender_id !== req.user.id && !(chat.type === 'group' && ['owner', 'admin'].includes(me.role))) throw HttpError(403, 'Напоминать может автор сообщения');
  const key = `${m.id}`;
  if (now() - (lastRemind.get(key) || 0) < 60_000) throw HttpError(429, 'Напоминание уже отправлено, подождите минуту');
  lastRemind.set(key, now());
  const done = new Set((m.important ? stmt.confirmations.all(m.id) : stmt.receipts.all(m.id)).map((r) => r.userId));
  const targets = memberIds(m.chat_id).filter((id) => id !== m.sender_id && !done.has(id));
  for (const uid of targets) sendToUser(uid, { type: 'remind', chatId: m.chat_id, messageId: m.id, fromUserId: req.user.id, text: m.text.slice(0, 200), important: !!m.important });
  res.json({ count: targets.length });
}));

// ----- Опросы -----
router.post('/chats/:id/polls', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  const question = str(req.body?.question, 300);
  const options = (req.body?.options || []).map((o) => str(o, 120)).filter(Boolean);
  if (!question) throw HttpError(400, 'Укажите вопрос');
  if (options.length < 2 || options.length > 10) throw HttpError(400, 'Нужно от 2 до 10 вариантов');
  const m = tx(db, () => {
    const msg = insertMessage({ chatId, senderId: req.user.id, kind: 'poll', text: question, meta: { multiple: bool(req.body?.multiple) } });
    const ins = db.prepare('INSERT INTO poll_options (message_id, text, position) VALUES (?, ?, ?)');
    options.forEach((o, i) => ins.run(msg.id, o, i));
    return msg;
  });
  broadcastMessage(m);
  res.status(201).json(messageDto(m, req.user.id));
}));

router.post('/messages/:id/vote', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  if (!m || m.kind !== 'poll' || m.deleted_at) throw HttpError(404, 'Опрос не найден');
  requireMember(m.chat_id, req.user.id);
  const meta = json(m.meta, {});
  const valid = new Set(stmt.pollOptions.all(m.id).map((o) => o.id));
  let ids = [...new Set((req.body?.optionIds || []).map(Number))].filter((id) => valid.has(id));
  if (!meta.multiple) ids = ids.slice(0, 1);
  tx(db, () => {
    db.prepare('DELETE FROM poll_votes WHERE user_id = ? AND option_id IN (SELECT id FROM poll_options WHERE message_id = ?)').run(req.user.id, m.id);
    const ins = db.prepare('INSERT INTO poll_votes (option_id, user_id, at) VALUES (?, ?, ?)');
    ids.forEach((id) => ins.run(id, req.user.id, now()));
  });
  broadcastUpdate(m.id);
  res.json(messageDto(stmt.message.get(m.id), req.user.id));
}));

// ----- Задачи -----
router.post('/chats/:id/tasks', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  const title = str(req.body?.title, 500);
  if (!title) throw HttpError(400, 'Опишите задачу');
  const assigneeId = Number(req.body?.assigneeId) || null;
  if (assigneeId && !stmt.member.get(chatId, assigneeId)) throw HttpError(400, 'Исполнитель должен быть участником чата');
  const dueAt = Number(req.body?.dueAt) || null;
  const replyTo = checkReply(chatId, req.body?.fromMessageId);
  const m = tx(db, () => {
    const msg = insertMessage({ chatId, senderId: req.user.id, kind: 'task', text: title, replyTo, mentions: assigneeId ? [assigneeId] : [] });
    db.prepare('INSERT INTO tasks (message_id, title, assignee_id, due_at) VALUES (?, ?, ?, ?)').run(msg.id, title, assigneeId, dueAt);
    return msg;
  });
  broadcastMessage(m);
  res.status(201).json(messageDto(m, req.user.id));
}));

router.patch('/messages/:id/task', wrap((req, res) => {
  const m = stmt.message.get(Number(req.params.id));
  const t = m && stmt.task.get(m.id);
  if (!t || m.deleted_at) throw HttpError(404, 'Задача не найдена');
  const me = requireMember(m.chat_id, req.user.id);
  const manager = ['owner', 'admin'].includes(me.role);
  if (![t.assignee_id, m.sender_id].includes(req.user.id) && !manager && t.assignee_id) throw HttpError(403, 'Отмечать может исполнитель или автор задачи');
  const b = req.body || {};
  if (b.done !== undefined) db.prepare('UPDATE tasks SET done_at = ?, done_by = ? WHERE message_id = ?').run(bool(b.done) ? now() : null, bool(b.done) ? req.user.id : null, m.id);
  if (b.dueAt !== undefined && (m.sender_id === req.user.id || manager)) db.prepare('UPDATE tasks SET due_at = ? WHERE message_id = ?').run(Number(b.dueAt) || null, m.id);
  if (b.assigneeId !== undefined && (m.sender_id === req.user.id || manager)) {
    const a = Number(b.assigneeId) || null;
    if (a && !stmt.member.get(m.chat_id, a)) throw HttpError(400, 'Исполнитель должен быть участником чата');
    db.prepare('UPDATE tasks SET assignee_id = ? WHERE message_id = ?').run(a, m.id);
  }
  broadcastUpdate(m.id);
  res.json(messageDto(stmt.message.get(m.id), req.user.id));
}));

router.get('/tasks', (req, res) => {
  const scope = req.query.scope === 'created' ? 'created' : 'assigned';
  const rows = db.prepare(`SELECT m.* FROM tasks t JOIN messages m ON m.id = t.message_id
      JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ?
      WHERE m.deleted_at IS NULL AND ${scope === 'created' ? 'm.sender_id = ?' : 't.assignee_id = ?'}
      ORDER BY (t.done_at IS NOT NULL), COALESCE(t.due_at, 9e15), m.id DESC LIMIT 300`).all(req.user.id, req.user.id);
  res.json(rows.map((m) => messageDto(m, req.user.id)));
});

// ----- Геометка и контакт -----
router.post('/chats/:id/location', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw HttpError(400, 'Неверные координаты');
  const m = sendNow(chatId, req.user, { kind: 'location', text: str(req.body?.label, 200), meta: { lat, lon, accuracy: Number(req.body?.accuracy) || null } });
  res.status(201).json(messageDto(m, req.user.id));
}));

router.post('/chats/:id/contact', wrap((req, res) => {
  const chatId = Number(req.params.id);
  requireMember(chatId, req.user.id);
  const u = stmt.userById.get(Number(req.body?.userId));
  if (!u || !canSeeUser(req.user, u.id)) throw HttpError(404, 'Сотрудник не найден');
  const m = sendNow(chatId, req.user, { kind: 'contact', text: u.name, meta: { userId: u.id } });
  res.status(201).json(messageDto(m, req.user.id));
}));

// ----- Отложенные -----
export function scheduledDto(s) {
  const p = json(s.payload, {});
  return {
    id: s.id, chatId: s.chat_id, sendAt: s.send_at, createdAt: s.created_at,
    text: p.text || '', important: !!p.important, silent: !!p.silent,
    files: (p.files || []).map((f) => ({ kind: f.kind, fileName: f.fileName, size: f.size })),
  };
}
router.get('/scheduled', (req, res) => {
  res.json(db.prepare('SELECT * FROM scheduled WHERE sender_id = ? ORDER BY send_at').all(req.user.id).map(scheduledDto));
});
router.delete('/scheduled/:id', wrap((req, res) => {
  const s = db.prepare('SELECT * FROM scheduled WHERE id = ? AND sender_id = ?').get(Number(req.params.id), req.user.id);
  if (!s) throw HttpError(404, 'Не найдено');
  db.prepare('DELETE FROM scheduled WHERE id = ?').run(s.id);
  if (!bool(req.query.keepFiles)) removeFiles((json(s.payload, {}).files || []).map((f) => f.storedName));
  sendToUser(req.user.id, { type: 'scheduled:removed', id: s.id });
  res.json({ ok: true });
}));
router.post('/scheduled/:id/send', wrap((req, res) => {
  const s = db.prepare('SELECT * FROM scheduled WHERE id = ? AND sender_id = ?').get(Number(req.params.id), req.user.id);
  if (!s) throw HttpError(404, 'Не найдено');
  const m = deliverScheduled(s);
  res.json(m ? messageDto(m, req.user.id) : { ok: false });
}));

export function deliverScheduled(s) {
  db.prepare('DELETE FROM scheduled WHERE id = ?').run(s.id);
  sendToUser(s.sender_id, { type: 'scheduled:removed', id: s.id });
  const p = json(s.payload, {});
  const sender = stmt.userById.get(s.sender_id);
  if (!sender || !sender.is_active || !stmt.member.get(s.chat_id, s.sender_id)) {
    removeFiles((p.files || []).map((f) => f.storedName));
    return null;
  }
  const replyTo = p.replyTo && stmt.message.get(p.replyTo)?.chat_id === s.chat_id ? p.replyTo : null;
  return sendNow(s.chat_id, sender, { ...p, replyTo, mentions: resolveMentions(s.chat_id, sender, p.mentionIds) });
}

// ----- Поиск и вложения -----
router.get('/chats/:id/search', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const me = requireMember(chatId, req.user.id);
  const q = str(req.query.q, 100).toLowerCase();
  if (q.length < 2) return res.json([]);
  const since = visibleSince(stmt.chat.get(chatId), me);
  const rows = db.prepare(`SELECT id, sender_id, kind, text, created_at FROM messages
      WHERE chat_id = ? AND created_at >= ? AND deleted_at IS NULL AND kind IN ('text','task','poll','location') AND text != '' ORDER BY id DESC`).all(chatId, since);
  const found = [];
  for (const r of rows) {
    if (r.text.toLowerCase().includes(q)) found.push({ id: r.id, senderId: r.sender_id, kind: r.kind, text: r.text.slice(0, 300), createdAt: r.created_at });
    if (found.length >= 50) break;
  }
  res.json(found);
}));

router.get('/chats/:id/attachments', wrap((req, res) => {
  const chatId = Number(req.params.id);
  const me = requireMember(chatId, req.user.id);
  const since = visibleSince(stmt.chat.get(chatId), me);
  const kinds = req.query.kind === 'files' ? ['file'] : req.query.kind === 'audio' ? ['audio'] : ['image', 'video'];
  const rows = db.prepare(`SELECT a.*, m.sender_id, m.created_at AS msg_at FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.chat_id = ? AND m.created_at >= ? AND m.deleted_at IS NULL AND a.kind IN (${kinds.map(() => '?').join(',')})
      ORDER BY a.id DESC LIMIT 300`).all(chatId, since, ...kinds);
  res.json(rows.map((a) => ({
    id: a.id, messageId: a.message_id, senderId: a.sender_id, createdAt: a.msg_at, kind: a.kind,
    fileName: a.file_name, mime: a.mime, size: a.size, url: `/files/${a.stored_name}`, meta: json(a.meta, null),
  })));
}));

// ================= Файлы =================
export const filesRouter = express.Router();
filesRouter.get('/files/:name', auth, wrap((req, res) => {
  const name = path.basename(req.params.name);
  const a = db.prepare('SELECT a.*, m.chat_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.stored_name = ?').get(name);
  if (!a) throw HttpError(404, 'Файл не найден');
  const me = requireMember(a.chat_id, req.user.id);
  const chat = stmt.chat.get(a.chat_id);
  const download = !!req.query.download;
  if (download && me.role === 'guest' && !chat.guest_download) throw HttpError(403, 'Скачивание для гостей отключено');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(a.mime);
  res.sendFile(path.join(UPLOAD_DIR, name));
}));
filesRouter.get('/avatars/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(AVATAR_DIR, name);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.sendFile(file);
});

export { multer };

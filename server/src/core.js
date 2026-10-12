// Общее ядро сервера: база, представления (DTO), рассылка событий, права.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, tx } from './db.js';
import { DATA_DIR, UPLOAD_DIR, AVATAR_DIR } from './config.js';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });

export const db = openDb(DATA_DIR);
export { tx };
export const now = () => Date.now();
export const PALETTE = ['#1F3A5F', '#5B3A8C', '#8A3B12', '#6B5413', '#256B43', '#1F4E85', '#3E4349', '#9A3412', '#0F5E66'];

export const HttpError = (status, message) => Object.assign(new Error(message), { status });

export const SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
})();

export const json = (s, fallback = null) => { if (!s) return fallback; try { return JSON.parse(s); } catch { return fallback; } };
export const randomName = (ext = '') => crypto.randomBytes(16).toString('hex') + ext;

// ---------- Подготовленные запросы ----------
export const stmt = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
  member: db.prepare('SELECT * FROM members WHERE chat_id = ? AND user_id = ?'),
  members: db.prepare('SELECT user_id AS userId, role FROM members WHERE chat_id = ? ORDER BY joined_at'),
  memberIds: db.prepare('SELECT user_id FROM members WHERE chat_id = ?'),
  chat: db.prepare('SELECT * FROM chats WHERE id = ?'),
  message: db.prepare('SELECT * FROM messages WHERE id = ?'),
  attachments: db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY id'),
  receipts: db.prepare('SELECT user_id AS userId, read_at AS readAt FROM receipts WHERE message_id = ? ORDER BY read_at'),
  confirmations: db.prepare('SELECT user_id AS userId, at FROM confirmations WHERE message_id = ? ORDER BY at'),
  mentions: db.prepare('SELECT user_id FROM mentions WHERE message_id = ?'),
  pollOptions: db.prepare('SELECT id, text FROM poll_options WHERE message_id = ? ORDER BY position'),
  pollVotes: db.prepare('SELECT v.option_id AS optionId, v.user_id AS userId FROM poll_votes v JOIN poll_options o ON o.id = v.option_id WHERE o.message_id = ?'),
  task: db.prepare('SELECT * FROM tasks WHERE message_id = ?'),
  lastVisible: db.prepare('SELECT * FROM messages WHERE chat_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 1'),
  unread: db.prepare(`SELECT COUNT(*) AS c FROM messages m
    WHERE m.chat_id = ? AND m.created_at >= ? AND m.kind != 'system' AND m.deleted_at IS NULL
      AND (m.sender_id IS NULL OR m.sender_id != ?)
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.message_id = m.id AND r.user_id = ?)`),
  mentionUnread: db.prepare(`SELECT COUNT(*) AS c FROM mentions mn JOIN messages m ON m.id = mn.message_id
    WHERE m.chat_id = ? AND (mn.user_id = ? OR mn.user_id = 0) AND m.sender_id != ? AND m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.message_id = m.id AND r.user_id = ?)`),
  activeCall: db.prepare('SELECT * FROM calls WHERE chat_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'),
};

export const memberIds = (chatId) => stmt.memberIds.all(chatId).map((r) => r.user_id);

/** С какого момента участнику видна история чата. */
export function visibleSince(chat, member) {
  if (!chat || !member) return Number.MAX_SAFE_INTEGER;
  return chat.history_for_new ? 0 : member.joined_at;
}

// ---------- Присутствие ----------
export const sockets = new Map(); // userId -> Set<ws>
export const isOnline = (uid) => (sockets.get(uid)?.size ?? 0) > 0;

export function userDto(u) {
  const statusActive = u.status_text && (!u.status_until || u.status_until > now());
  return {
    id: u.id, login: u.login, name: u.name, position: u.position, department: u.department || '',
    color: u.color, avatar: u.avatar ? `/avatars/${u.avatar}` : null,
    isAdmin: !!u.is_admin, isGuest: !!u.is_guest, isActive: !!u.is_active,
    online: isOnline(u.id), lastSeen: u.last_seen ?? null,
    status: statusActive ? { text: u.status_text, until: u.status_until ?? null } : null,
  };
}

// ---------- Сообщения ----------
function replySummary(id) {
  if (!id) return null;
  const r = stmt.message.get(id);
  if (!r) return null;
  const att = r.deleted_at ? null : stmt.attachments.all(r.id)[0];
  return {
    id: r.id, senderId: r.sender_id, kind: r.kind, deleted: !!r.deleted_at,
    text: r.deleted_at ? '' : r.text.slice(0, 200), attachmentKind: att?.kind ?? null,
  };
}

export function canSeeReceipts(chat, msg, viewerId) {
  return !!chat.show_receipts || msg.sender_id === viewerId;
}

export function messageDto(m, viewerId, chat = stmt.chat.get(m.chat_id)) {
  const deleted = !!m.deleted_at;
  const meta = json(m.meta, {});
  const dto = {
    id: m.id, chatId: m.chat_id, senderId: m.sender_id, kind: m.kind,
    text: deleted ? '' : m.text, important: !!m.important, silent: !!m.silent,
    createdAt: m.created_at, editedAt: m.edited_at ?? null, deletedAt: m.deleted_at ?? null,
    replyTo: deleted ? null : replySummary(m.reply_to),
    attachments: deleted ? [] : stmt.attachments.all(m.id).map((a) => ({
      id: a.id, kind: a.kind, fileName: a.file_name, mime: a.mime, size: a.size, url: `/files/${a.stored_name}`, meta: json(a.meta, null),
    })),
    mentions: deleted ? [] : stmt.mentions.all(m.id).map((r) => r.user_id),
    receipts: canSeeReceipts(chat, m, viewerId) ? stmt.receipts.all(m.id) : [],
    confirmations: m.important ? stmt.confirmations.all(m.id) : [],
    meta: deleted ? {} : meta,
  };
  if (!deleted && m.kind === 'poll') {
    const votes = stmt.pollVotes.all(m.id);
    dto.poll = {
      question: m.text, multiple: !!meta.multiple,
      options: stmt.pollOptions.all(m.id).map((o) => ({ id: o.id, text: o.text, votes: votes.filter((v) => v.optionId === o.id).map((v) => v.userId) })),
    };
  }
  if (!deleted && m.kind === 'task') {
    const t = stmt.task.get(m.id);
    if (t) dto.task = { title: t.title, assigneeId: t.assignee_id, dueAt: t.due_at, doneAt: t.done_at, doneBy: t.done_by };
  }
  return dto;
}

export function chatDto(chatId, viewerId) {
  const c = stmt.chat.get(chatId);
  if (!c) return null;
  const me = stmt.member.get(chatId, viewerId);
  const since = visibleSince(c, me);
  const last = stmt.lastVisible.get(chatId, since);
  const call = stmt.activeCall.get(chatId);
  return {
    id: c.id, type: c.type, title: c.title, color: c.color, address: c.address,
    avatar: c.avatar ? `/avatars/${c.avatar}` : null,
    showReceipts: !!c.show_receipts, historyForNew: !!c.history_for_new,
    membersCanAdd: !!c.members_can_add, guestDownload: !!c.guest_download,
    createdAt: c.created_at, createdBy: c.created_by,
    members: stmt.members.all(chatId), myRole: me?.role ?? null, muted: !!me?.muted,
    lastMessage: last ? messageDto(last, viewerId, c) : null,
    unread: stmt.unread.get(chatId, since, viewerId, viewerId).c,
    mentionUnread: stmt.mentionUnread.get(chatId, viewerId, viewerId, viewerId).c,
    call: call ? { id: call.id, video: !!call.video, startedAt: call.started_at, startedBy: call.started_by } : null,
  };
}

// ---------- Рассылка ----------
export function sendToUser(uid, event) {
  const set = sockets.get(uid);
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}
export function sendToAll(event) {
  const data = JSON.stringify(event);
  for (const set of sockets.values()) for (const ws of set) if (ws.readyState === 1) ws.send(data);
}

export function broadcastMessage(m, type = 'message:new') {
  const chat = stmt.chat.get(m.chat_id);
  for (const uid of memberIds(m.chat_id)) {
    const since = visibleSince(chat, stmt.member.get(m.chat_id, uid));
    if (m.created_at < since) continue;
    sendToUser(uid, { type, message: messageDto(m, uid, chat) });
  }
}
export const broadcastUpdate = (messageId) => {
  const m = stmt.message.get(messageId);
  if (m) broadcastMessage(m, 'message:updated');
};
export function broadcastChat(chatId) {
  for (const uid of memberIds(chatId)) sendToUser(uid, { type: 'chat:updated', chat: chatDto(chatId, uid) });
}
export function broadcastUser(u) {
  sendToAll({ type: 'user:updated', user: userDto(u) });
}

export function addSystemMessage(chatId, text, senderId = null) {
  const r = db.prepare("INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?, ?, 'system', ?, ?)")
    .run(chatId, senderId, text, now());
  const m = stmt.message.get(Number(r.lastInsertRowid));
  broadcastMessage(m);
  return m;
}

/**
 * Создать сообщение любого вида. files — уже сохранённые на диск вложения.
 * Возвращает строку сообщения (рассылку делает вызывающий).
 */
export function insertMessage({ chatId, senderId, kind = 'text', text = '', important = false, silent = false, replyTo = null, meta = null, files = [], mentions = [], createdAt = now() }) {
  return tx(db, () => {
    const r = db.prepare(`INSERT INTO messages (chat_id, sender_id, kind, text, important, silent, reply_to, meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(chatId, senderId, kind, text, important ? 1 : 0, silent ? 1 : 0, replyTo, meta ? JSON.stringify(meta) : null, createdAt);
    const mid = Number(r.lastInsertRowid);
    const insA = db.prepare('INSERT INTO attachments (message_id, kind, file_name, stored_name, mime, size, meta) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of files) insA.run(mid, f.kind, f.fileName, f.storedName, f.mime, f.size, f.meta ? JSON.stringify(f.meta) : null);
    const insM = db.prepare('INSERT OR IGNORE INTO mentions (message_id, user_id) VALUES (?, ?)');
    for (const uid of mentions) insM.run(mid, uid);
    return stmt.message.get(mid);
  });
}

// ---------- Прочтения ----------
export function markRead(chatId, userId, upToId) {
  const chat = stmt.chat.get(chatId);
  const since = visibleSince(chat, stmt.member.get(chatId, userId));
  const rows = db.prepare(`SELECT id, sender_id FROM messages m
    WHERE m.chat_id = ? AND m.id <= ? AND m.created_at >= ? AND m.kind != 'system' AND m.deleted_at IS NULL
      AND (m.sender_id IS NULL OR m.sender_id != ?)
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.message_id = m.id AND r.user_id = ?)`).all(chatId, upToId, since, userId, userId);
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
        marked: uid === userId ? all.length : undefined,
      });
    }
  }
  return all;
}

// ---------- Права ----------
export function requireMember(chatId, uid) {
  const m = stmt.member.get(chatId, uid);
  if (!m) throw HttpError(404, 'Чат не найден');
  return m;
}
export function requireGroup(chatId) {
  const chat = stmt.chat.get(chatId);
  if (!chat || chat.type !== 'group') throw HttpError(400, 'Только для групп');
  return chat;
}
export function requireManager(chatId, uid) {
  const m = requireMember(chatId, uid);
  requireGroup(chatId);
  if (m.role !== 'owner' && m.role !== 'admin') throw HttpError(403, 'Нужны права администратора группы');
  return m;
}
export function canAddMembers(chat, member) {
  if (!chat || chat.type !== 'group' || !member) return false;
  if (member.role === 'owner' || member.role === 'admin') return true;
  return !!chat.members_can_add && member.role === 'member';
}
/** Видит ли пользователь другого (гости видят только тех, с кем состоят в общих чатах). */
export function canSeeUser(viewer, otherId) {
  if (!viewer.is_guest) return true;
  if (viewer.id === otherId) return true;
  return !!db.prepare(`SELECT 1 FROM members a JOIN members b ON a.chat_id = b.chat_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`).get(viewer.id, otherId);
}

export function removeFiles(names, dir = UPLOAD_DIR) {
  for (const n of names) if (n) fs.rm(path.join(dir, path.basename(n)), () => {});
}

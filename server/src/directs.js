import { db, tx, now } from './core.js';

/** Личный чат между двумя сотрудниками — один на пару. */
export function findOrCreateDirect(a, b) {
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

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** Выполнить fn в транзакции. Вложенные вызовы выполняются в рамках внешней транзакции. */
const depth = new WeakMap();
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try { return fn(); } finally { depth.set(db, depth.get(db) - 1); }
  }
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

// Исходная схема (версия 1). Дальнейшие изменения — только миграциями ниже.
const BASE = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    position TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    color TEXT NOT NULL DEFAULT '#1F3A5F',
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('direct','group')),
    title TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#C2410C',
    address TEXT NOT NULL DEFAULT '',
    direct_key TEXT UNIQUE,
    show_receipts INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','system','call')),
    text TEXT NOT NULL DEFAULT '',
    important INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image','video','file')),
    file_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_att_message ON attachments(message_id);
  CREATE TABLE IF NOT EXISTS receipts (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id);
`;

const MIGRATIONS = [
  // 2: переписка, группы и звонки по макетам
  `
  CREATE TABLE messages_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    important INTEGER NOT NULL DEFAULT 0,
    silent INTEGER NOT NULL DEFAULT 0,
    reply_to INTEGER,
    meta TEXT,
    edited_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL
  );
  INSERT INTO messages_new (id, chat_id, sender_id, kind, text, important, created_at)
    SELECT id, chat_id, sender_id, kind, text, important, created_at FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX idx_messages_chat ON messages(chat_id, id);

  CREATE TABLE attachments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    file_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    meta TEXT
  );
  INSERT INTO attachments_new (id, message_id, kind, file_name, stored_name, mime, size)
    SELECT id, message_id, kind, file_name, stored_name, mime, size FROM attachments;
  DROP TABLE attachments;
  ALTER TABLE attachments_new RENAME TO attachments;
  CREATE INDEX idx_att_message ON attachments(message_id);

  CREATE TABLE members_new (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    muted INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  INSERT INTO members_new (chat_id, user_id, role, joined_at) SELECT chat_id, user_id, role, joined_at FROM members;
  DROP TABLE members;
  ALTER TABLE members_new RENAME TO members;
  CREATE INDEX idx_members_user ON members(user_id);

  ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN status_text TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN status_until INTEGER;
  ALTER TABLE users ADD COLUMN avatar TEXT;

  ALTER TABLE chats ADD COLUMN avatar TEXT;
  ALTER TABLE chats ADD COLUMN history_for_new INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE chats ADD COLUMN members_can_add INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chats ADD COLUMN guest_download INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE TABLE confirmations (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE TABLE scheduled (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_scheduled_at ON scheduled(send_at);
  CREATE TABLE poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE TABLE poll_votes (
    option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    PRIMARY KEY (option_id, user_id)
  );
  CREATE TABLE tasks (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    assignee_id INTEGER REFERENCES users(id),
    due_at INTEGER,
    done_at INTEGER,
    done_by INTEGER
  );
  CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
  CREATE TABLE invites (
    token TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    started_by INTEGER NOT NULL REFERENCES users(id),
    video INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  `,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'otmetka.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(BASE);
  let version = db.prepare('PRAGMA user_version').get().user_version || 1;
  for (let v = version + 1; v <= MIGRATIONS.length + 1; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v - 2]);
      db.exec(`PRAGMA user_version = ${v}`);
    });
    version = v;
    console.log(`База данных обновлена до версии ${v}`);
  }
  if (!db.prepare('PRAGMA user_version').get().user_version) db.exec(`PRAGMA user_version = ${version}`);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

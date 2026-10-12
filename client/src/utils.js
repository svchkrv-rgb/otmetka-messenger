export const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

export function mergeById(list) {
  const map = new Map();
  for (const m of list) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.id - b.id);
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function peerOf(chat, meId) {
  if (!chat || chat.type !== 'direct') return null;
  return chat.members.find((m) => m.userId !== meId)?.userId ?? null;
}

export function chatTitle(chat, users, meId) {
  if (!chat) return '';
  if (chat.type === 'group') return chat.title;
  const peer = users[peerOf(chat, meId)];
  return peer?.name ?? 'Личный чат';
}

const pad = (n) => String(n).padStart(2, '0');
export const formatTime = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function dayDiff(ts) {
  const a = new Date(ts); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

export function formatDay(ts) {
  const diff = dayDiff(ts);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
}

/** Короткая отметка для списка чатов. */
export function formatListTime(ts) {
  const diff = dayDiff(ts);
  if (diff === 0) return formatTime(ts);
  if (diff < 7) return WEEKDAYS[new Date(ts).getDay()];
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

/** Время прочтения с датой, если не сегодня. */
export function formatReadTime(ts) {
  const diff = dayDiff(ts);
  if (diff === 0) return formatTime(ts);
  if (diff === 1) return `вчера в ${formatTime(ts)}`;
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} в ${formatTime(ts)}`;
}

export function lastSeenText(user) {
  if (!user) return '';
  if (user.online) return 'в сети';
  if (!user.lastSeen) return 'давно не заходил(а)';
  const mins = Math.round((Date.now() - user.lastSeen) / 60000);
  if (mins < 1) return 'был(а) только что';
  if (mins < 60) return `был(а) ${mins} мин назад`;
  const diff = dayDiff(user.lastSeen);
  if (diff === 0) return `был(а) сегодня в ${formatTime(user.lastSeen)}`;
  if (diff === 1) return `был(а) вчера в ${formatTime(user.lastSeen)}`;
  return `был(а) ${formatDay(user.lastSeen)}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function parseCall(m) {
  try { return JSON.parse(m.text); } catch { return { video: false, outcome: 'missed', duration: 0 }; }
}

export function callText(m, meId) {
  const c = parseCall(m);
  const kind = c.video ? 'видеозвонок' : 'аудиозвонок';
  const outgoing = m.senderId === meId;
  if (c.outcome === 'completed') return `${outgoing ? 'Исходящий' : 'Входящий'} ${kind} · ${formatDuration(c.duration)}`;
  if (c.outcome === 'rejected') return outgoing ? `${kind[0].toUpperCase() + kind.slice(1)} отклонён` : `Вы отклонили ${kind}`;
  return outgoing ? `${kind[0].toUpperCase() + kind.slice(1)} без ответа` : `Пропущенный ${kind}`;
}

export function previewText(m, users, meId) {
  if (!m) return '';
  if (m.kind === 'call') return callText(m, meId);
  if (m.kind === 'system') return m.text;
  let prefix = '';
  if (m.attachments?.length) {
    const kinds = new Set(m.attachments.map((a) => a.kind));
    prefix = kinds.size === 1 && kinds.has('image') ? 'Фото' : kinds.size === 1 && kinds.has('video') ? 'Видео' : 'Файл';
    if (m.attachments.length > 1) prefix += ` (${m.attachments.length})`;
  }
  const text = m.text ? (prefix ? `${prefix} · ${m.text}` : m.text) : prefix;
  return text.replace(/\s+/g, ' ');
}

export function randomId() {
  if (window.crypto?.randomUUID) {
    try { return window.crypto.randomUUID(); } catch { /* небезопасный контекст */ }
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const GROUP_COLORS = ['#C2410C', '#2B6CB0', '#2E7D4F', '#6B4AA0', '#0F5E66', '#3E4349'];

export const ROLE_NAMES = { owner: 'владелец', admin: 'админ', member: '' };

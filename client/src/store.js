import { useSyncExternalStore } from 'react';
import { byId, mergeById, previewText, chatTitle } from './utils.js';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function initialServer() {
  const saved = localStorage.getItem('otmetka.server');
  if (saved) return saved;
  return isTauri ? '' : window.location.origin;
}

let state = {
  serverUrl: initialServer(),
  token: localStorage.getItem('otmetka.token') || '',
  me: null,
  config: {},
  users: {},
  chats: {},
  messages: {},      // chatId -> [message]
  hasMore: {},       // chatId -> есть более старые
  hasNewer: {},      // chatId -> загружен «кусок» истории, новые ниже не подгружены
  activeChatId: null,
  view: 'chats',     // chats | tasks | people
  typing: {},        // chatId -> { userId: { until, kind } }
  connection: 'offline',
  bootError: null,
  iceServers: [],
  call: null,
  toast: null,
  modal: null,
  infoOpen: false,
  replyTo: {},       // chatId -> messageId
  editing: {},       // chatId -> messageId
  scheduled: [],
  highlight: null,   // { chatId, messageId, at }
};

const listeners = new Set();
export const getState = () => state;
export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  if (!next) return;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
export function useStore() {
  return useSyncExternalStore(subscribe, getState);
}

let toastTimer;
export function toast(text, action) {
  clearTimeout(toastTimer);
  setState({ toast: { text, action, id: Date.now() } });
  toastTimer = setTimeout(() => setState({ toast: null }), action ? 8000 : 4500);
}

export const openModal = (type, props = {}) => setState({ modal: { type, ...props } });
export const closeModal = () => setState({ modal: null });

// ---------- HTTP ----------
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function normalizeServer(u) {
  let url = (u || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try {
    const parsed = new URL(url);
    if (!parsed.port) {
      parsed.port = parsed.protocol === 'https:' ? '8443' : '8080';
      url = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    }
  } catch { /* как ввели */ }
  return url;
}

export async function request(method, path, body) {
  const { serverUrl, token } = state;
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch(serverUrl + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  } catch {
    throw new ApiError('Нет связи с сервером', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (res.status === 401 && token) logout();
  if (!res.ok) throw new ApiError(data?.error || `Ошибка ${res.status}`, res.status);
  return data;
}

export const fileUrl = (url, download = false) =>
  `${state.serverUrl}${url}?token=${encodeURIComponent(state.token)}${download ? '&download=1' : ''}`;
export const avatarUrl = (url) => (url ? `${state.serverUrl}${url}` : null);

/** Открыть ссылку во внешнем браузере (в приложении Windows — через систему). */
export async function openExternal(url) {
  if (isTauri) {
    try {
      const m = await import('@tauri-apps/plugin-opener');
      await m.openUrl(url);
      return;
    } catch (e) { console.warn(e); }
  }
  window.open(url, '_blank', 'noopener');
}

// ---------- Вход ----------
function saveSession(serverUrl, token) {
  localStorage.setItem('otmetka.server', serverUrl);
  localStorage.setItem('otmetka.token', token);
}

export async function login(server, loginName, password) {
  const serverUrl = normalizeServer(server) || state.serverUrl;
  if (!serverUrl) throw new ApiError('Укажите адрес сервера', 0);
  let res;
  try {
    res = await fetch(serverUrl + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: loginName, password }),
    });
  } catch {
    throw new ApiError('Сервер не отвечает. Проверьте адрес и сеть.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.token) throw new ApiError(data?.error || 'Не удалось войти', res.status);
  saveSession(serverUrl, data.token);
  setState({ serverUrl, token: data.token, me: data.user });
  await bootstrap();
}

/** Вход по приглашению: новый гость или уже вошедший сотрудник. */
export async function acceptInvite(token, form) {
  const res = await fetch(`${state.serverUrl}/api/invites/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: JSON.stringify(form || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || 'Не удалось присоединиться', res.status);
  saveSession(state.serverUrl, data.token);
  setState({ token: data.token, me: data.user, activeChatId: data.chatId });
  window.history.replaceState(null, '', '/');
  await bootstrap();
}

export async function bootstrap() {
  setState({ bootError: null });
  try {
    const [me, users, chats, config, scheduled] = await Promise.all([
      request('GET', '/api/me'),
      request('GET', '/api/users'),
      request('GET', '/api/chats'),
      request('GET', '/api/config'),
      request('GET', '/api/scheduled').catch(() => []),
    ]);
    setState({ me, users: byId(users), chats: byId(chats), config, iceServers: config.iceServers || [], scheduled });
    connectWs();
    initNotifications();
  } catch (e) {
    if (e.status !== 401) setState({ bootError: e.message });
  }
}

export function logout() {
  localStorage.removeItem('otmetka.token');
  const sock = ws;
  ws = null;
  sock?.close();
  setState({ token: '', me: null, users: {}, chats: {}, messages: {}, hasMore: {}, hasNewer: {}, activeChatId: null, modal: null, call: null, infoOpen: false, scheduled: [], view: 'chats' });
}

// ---------- WebSocket ----------
let ws = null;
let retry = 0;
let everConnected = false;
let pingTimer = null;
const callHandlers = new Set();
export const onCallEvent = (fn) => { callHandlers.add(fn); return () => callHandlers.delete(fn); };

export function connectWs() {
  if (!state.token || ws) return;
  const url = state.serverUrl.replace(/^http/i, 'ws') + '/ws?token=' + encodeURIComponent(state.token);
  setState({ connection: 'connecting' });
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    setState({ connection: 'online' });
    if (everConnected) resync();
    everConnected = true;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => wsSend({ type: 'ping' }), 25000);
  };
  sock.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    setState({ connection: 'offline' });
    if (!state.token) return;
    if (e.code === 4001) { logout(); return; }
    const delay = Math.min(1000 * 2 ** retry, 15000);
    retry += 1;
    setTimeout(connectWs, delay);
  };
}

export function wsSend(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

async function resync() {
  try {
    const [users, chats, scheduled] = await Promise.all([request('GET', '/api/users'), request('GET', '/api/chats'), request('GET', '/api/scheduled')]);
    setState({ users: byId(users), chats: byId(chats), scheduled });
    for (const chatId of Object.keys(state.messages)) loadMessages(Number(chatId)).catch(() => {});
  } catch { /* повторим при следующем подключении */ }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message:new': return upsertMessage(ev.message, true);
    case 'message:updated': return replaceMessage(ev.message);
    case 'message:receipts': return applyReceipts(ev);
    case 'chat:updated':
      return setState((s) => ({ chats: { ...s.chats, [ev.chat.id]: ev.chat } }));
    case 'chat:removed':
      return setState((s) => {
        const chats = { ...s.chats };
        delete chats[ev.chatId];
        const active = s.activeChatId === ev.chatId;
        return { chats, activeChatId: active ? null : s.activeChatId, infoOpen: active ? false : s.infoOpen };
      });
    case 'presence':
      return setState((s) => (s.users[ev.userId]
        ? { users: { ...s.users, [ev.userId]: { ...s.users[ev.userId], online: ev.online, lastSeen: ev.lastSeen } } }
        : null));
    case 'user:updated':
      return setState((s) => ({ users: { ...s.users, [ev.user.id]: ev.user }, me: s.me?.id === ev.user.id ? { ...s.me, ...ev.user } : s.me }));
    case 'typing':
      return setState((s) => ({ typing: { ...s.typing, [ev.chatId]: { ...(s.typing[ev.chatId] || {}), [ev.userId]: { until: Date.now() + 4500, kind: ev.kind } } } }));
    case 'scheduled:added':
      return setState((s) => ({ scheduled: [...s.scheduled.filter((x) => x.id !== ev.item.id), ev.item].sort((a, b) => a.sendAt - b.sendAt) }));
    case 'scheduled:removed':
      return setState((s) => ({ scheduled: s.scheduled.filter((x) => x.id !== ev.id) }));
    case 'remind': return onRemind(ev);
    default:
      if (ev.type.startsWith('call:') || ev.type.startsWith('gcall:')) callHandlers.forEach((h) => h(ev));
  }
}

export function upsertMessage(m, fromSocket = false) {
  let isNew = false;
  let unknownChat = false;
  setState((s) => {
    const list = s.messages[m.chatId];
    const exists = list?.some((x) => x.id === m.id);
    const chat = s.chats[m.chatId];
    unknownChat = !chat;
    const alreadyLast = chat?.lastMessage?.id >= m.id;
    isNew = !exists && !alreadyLast;
    // пока показан «кусок» истории, новые сообщения в список не добавляем — они придут при переходе вниз
    const messages = list && !s.hasNewer[m.chatId] ? { ...s.messages, [m.chatId]: mergeById([...list, m]) } : s.messages;
    const fromOther = m.senderId !== s.me?.id && m.kind !== 'system';
    const mentionsMe = fromOther && (m.mentions?.includes(s.me?.id) || m.mentions?.includes(0));
    const chats = chat
      ? { ...s.chats, [m.chatId]: { ...chat, lastMessage: !alreadyLast ? m : chat.lastMessage, unread: chat.unread + (isNew && fromOther ? 1 : 0), mentionUnread: (chat.mentionUnread || 0) + (isNew && mentionsMe ? 1 : 0) } }
      : s.chats;
    let typing = s.typing;
    if (s.typing[m.chatId]?.[m.senderId]) {
      const t = { ...s.typing[m.chatId] };
      delete t[m.senderId];
      typing = { ...s.typing, [m.chatId]: t };
    }
    return { messages, chats, typing };
  });
  if (unknownChat) request('GET', '/api/chats').then((chats) => setState({ chats: byId(chats) })).catch(() => {});
  if (fromSocket && isNew) notifyMessage(m);
}

function replaceMessage(m) {
  setState((s) => {
    const list = s.messages[m.chatId];
    const messages = list ? { ...s.messages, [m.chatId]: list.map((x) => (x.id === m.id ? m : x)) } : s.messages;
    // обновить цитаты на это сообщение
    if (list) {
      messages[m.chatId] = messages[m.chatId].map((x) => (x.replyTo?.id === m.id
        ? { ...x, replyTo: { ...x.replyTo, text: m.deletedAt ? '' : m.text.slice(0, 200), deleted: !!m.deletedAt } } : x));
    }
    const chat = s.chats[m.chatId];
    const chats = chat && chat.lastMessage?.id === m.id ? { ...s.chats, [m.chatId]: { ...chat, lastMessage: m } } : s.chats;
    return { messages, chats };
  });
}

function mergeReceipts(current = [], incoming) {
  const map = new Map(current.map((r) => [r.userId, r]));
  for (const r of incoming) if (!map.has(r.userId)) map.set(r.userId, { userId: r.userId, readAt: r.readAt });
  return [...map.values()].sort((a, b) => a.readAt - b.readAt);
}

function applyReceipts(ev) {
  setState((s) => {
    const byMsg = {};
    for (const r of ev.receipts) (byMsg[r.messageId] ||= []).push(r);
    const list = s.messages[ev.chatId];
    const messages = list && ev.receipts.length
      ? { ...s.messages, [ev.chatId]: list.map((m) => (byMsg[m.id] ? { ...m, receipts: mergeReceipts(m.receipts, byMsg[m.id]) } : m)) }
      : s.messages;
    const chat = s.chats[ev.chatId];
    if (!chat) return { messages };
    let next = chat;
    if (chat.lastMessage && byMsg[chat.lastMessage.id]) {
      next = { ...next, lastMessage: { ...chat.lastMessage, receipts: mergeReceipts(chat.lastMessage.receipts, byMsg[chat.lastMessage.id]) } };
    }
    if (ev.readerId === s.me?.id && ev.marked) {
      next = { ...next, unread: Math.max(0, next.unread - ev.marked), mentionUnread: next.unread - ev.marked <= 0 ? 0 : next.mentionUnread };
    }
    return { messages, chats: { ...s.chats, [ev.chatId]: next } };
  });
}

// ---------- Сообщения ----------
const PAGE = 50;
export async function loadMessages(chatId, older = false) {
  const list = state.messages[chatId];
  const before = older && list?.length ? list[0].id : 0;
  const page = await request('GET', `/api/chats/${chatId}/messages?limit=${PAGE}${before ? `&before=${before}` : ''}`);
  setState((s) => {
    const cur = older ? (s.messages[chatId] || []) : (s.hasNewer[chatId] ? [] : (s.messages[chatId] || []));
    const hasMore = older || !s.messages[chatId] || s.hasNewer[chatId] ? page.length === PAGE : s.hasMore[chatId];
    return {
      messages: { ...s.messages, [chatId]: mergeById([...page, ...cur]) },
      hasMore: { ...s.hasMore, [chatId]: hasMore },
      hasNewer: older ? s.hasNewer : { ...s.hasNewer, [chatId]: false },
    };
  });
  return page.length;
}

export async function loadNewer(chatId) {
  const list = state.messages[chatId];
  if (!list?.length) return 0;
  const page = await request('GET', `/api/chats/${chatId}/messages?limit=${PAGE}&after=${list[list.length - 1].id}`);
  setState((s) => ({
    messages: { ...s.messages, [chatId]: mergeById([...(s.messages[chatId] || []), ...page]) },
    hasNewer: { ...s.hasNewer, [chatId]: page.length === PAGE },
  }));
  return page.length;
}

/** Перейти к сообщению: открыть чат, при необходимости подгрузить историю вокруг него и подсветить. */
export async function jumpToMessage(chatId, messageId) {
  setState({ activeChatId: chatId, view: 'chats', infoOpen: false });
  const list = state.messages[chatId];
  if (!list?.some((m) => m.id === messageId)) {
    try {
      const page = await request('GET', `/api/chats/${chatId}/messages?around=${messageId}&limit=60`);
      if (!page.some((m) => m.id === messageId)) { toast('Сообщение недоступно'); return; }
      const last = state.chats[chatId]?.lastMessage?.id;
      setState((s) => ({
        messages: { ...s.messages, [chatId]: mergeById(page) },
        hasMore: { ...s.hasMore, [chatId]: true },
        hasNewer: { ...s.hasNewer, [chatId]: !!last && page[page.length - 1].id < last },
      }));
    } catch (e) { toast(e.message); return; }
  }
  setState({ highlight: { chatId, messageId, at: Date.now() } });
}

export function sendMessage(chatId, { text, files, important, silent, replyTo, mentions, sendAt, filesMeta }, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('text', text || '');
    if (important) fd.append('important', 'true');
    if (silent) fd.append('silent', 'true');
    if (replyTo) fd.append('replyTo', String(replyTo));
    if (mentions?.length) fd.append('mentions', JSON.stringify(mentions));
    if (sendAt) fd.append('sendAt', String(sendAt));
    if (filesMeta?.some(Boolean)) fd.append('filesMeta', JSON.stringify(filesMeta));
    for (const f of files || []) fd.append('files', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${state.serverUrl}/api/chats/${chatId}/messages`);
    xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (data?.scheduled) {
          setState((s) => ({ scheduled: [...s.scheduled.filter((x) => x.id !== data.scheduled.id), data.scheduled].sort((a, b) => a.sendAt - b.sendAt) }));
        } else {
          if (getState().hasNewer[chatId]) loadMessages(chatId).catch(() => {});
          upsertMessage(data);
        }
        resolve(data);
      } else reject(new ApiError(data?.error || 'Не удалось отправить', xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Нет связи с сервером', 0));
    xhr.send(fd);
  });
}

async function act(promise, okText) {
  try {
    const r = await promise;
    if (r && r.id && r.chatId) replaceOrInsert(r);
    if (okText) toast(okText);
    return r;
  } catch (e) {
    toast(e.message);
    throw e;
  }
}
function replaceOrInsert(m) {
  const list = state.messages[m.chatId];
  if (list?.some((x) => x.id === m.id)) replaceMessage(m);
  else upsertMessage(m);
}

export const editMessage = (id, text, mentions) => act(request('PATCH', `/api/messages/${id}`, { text, mentions }));
export const deleteMessage = (id) => act(request('DELETE', `/api/messages/${id}`));
export const confirmMessage = (id) => act(request('POST', `/api/messages/${id}/confirm`), 'Прочтение подтверждено');
export const remindUnread = (id) => act(request('POST', `/api/messages/${id}/remind`)).then((r) => { toast(r.count ? `Напоминание отправлено: ${r.count}` : 'Все уже прочитали'); return r; });
export const vote = (id, optionIds) => act(request('POST', `/api/messages/${id}/vote`, { optionIds }));
export const setTaskDone = (id, done) => act(request('PATCH', `/api/messages/${id}/task`, { done }));
export const createPoll = (chatId, data) => act(request('POST', `/api/chats/${chatId}/polls`, data));
export const createTask = (chatId, data) => act(request('POST', `/api/chats/${chatId}/tasks`, data));
export const sendLocation = (chatId, data) => act(request('POST', `/api/chats/${chatId}/location`, data));
export const sendContact = (chatId, userId) => act(request('POST', `/api/chats/${chatId}/contact`, { userId }));
export const cancelScheduled = (id) => act(request('DELETE', `/api/scheduled/${id}`), 'Отправка отменена');
export const sendScheduledNow = (id) => act(request('POST', `/api/scheduled/${id}/send`));

export function setReply(chatId, messageId) {
  setState((s) => ({ replyTo: { ...s.replyTo, [chatId]: messageId }, editing: { ...s.editing, [chatId]: null } }));
}
export function setEditing(chatId, messageId) {
  setState((s) => ({ editing: { ...s.editing, [chatId]: messageId }, replyTo: { ...s.replyTo, [chatId]: null } }));
}

// Отметки о прочтении копятся и отправляются пачкой
const readSent = {};
const readQueued = {};
const readTimers = {};
export function queueRead(chatId, msgId) {
  if ((readSent[chatId] || 0) >= msgId || (readQueued[chatId] || 0) >= msgId) return;
  readQueued[chatId] = msgId;
  clearTimeout(readTimers[chatId]);
  readTimers[chatId] = setTimeout(async () => {
    const upToId = readQueued[chatId];
    try {
      await request('POST', `/api/chats/${chatId}/read`, { upToId });
      readSent[chatId] = Math.max(readSent[chatId] || 0, upToId);
    } catch { /* повторим при следующем просмотре */ }
    readQueued[chatId] = 0;
  }, 350);
}

let lastTypingSent = 0;
export function sendTyping(chatId, kind = 'text') {
  if (Date.now() - lastTypingSent < 3000) return;
  lastTypingSent = Date.now();
  wsSend({ type: 'typing', chatId, kind });
}

export async function openDirect(userId) {
  const chat = await request('POST', '/api/chats/direct', { userId });
  setState((s) => ({ chats: { ...s.chats, [chat.id]: chat }, activeChatId: chat.id, view: 'chats', infoOpen: false }));
  return chat;
}

export function openChat(chatId) {
  setState({ activeChatId: chatId, infoOpen: false, view: 'chats' });
}

// ---------- Уведомления ----------
let notifyFn = null;
let tauriWindow = null;
async function initNotifications() {
  if (notifyFn) return;
  try {
    if (isTauri) {
      const n = await import('@tauri-apps/plugin-notification');
      let granted = await n.isPermissionGranted();
      if (!granted) granted = (await n.requestPermission()) === 'granted';
      if (granted) notifyFn = (title, body) => n.sendNotification({ title, body });
      const w = await import('@tauri-apps/api/window');
      tauriWindow = w.getCurrentWindow();
    } else if ('Notification' in window) {
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') notifyFn = (title, body) => new Notification(title, { body, icon: '/icon.png' });
    }
  } catch (e) {
    console.warn('Уведомления недоступны', e);
  }
}

export function notify(title, body) {
  try { notifyFn?.(title, body); } catch { /* ignore */ }
}

export async function requestAttention() {
  try {
    if (tauriWindow) await tauriWindow.requestUserAttention(2);
  } catch { /* ignore */ }
}

function notifyMessage(m) {
  if (m.senderId === state.me?.id || m.kind === 'system') return;
  if (document.hasFocus() && state.activeChatId === m.chatId) return;
  const chat = state.chats[m.chatId];
  const mentionsMe = m.mentions?.includes(state.me?.id) || m.mentions?.includes(0);
  if (m.silent && !mentionsMe) return;
  if (chat?.muted && !mentionsMe && !m.important) return;
  const sender = state.users[m.senderId]?.name || 'Новое сообщение';
  const title = (m.important ? 'Важное · ' : mentionsMe ? 'Вас упомянули · ' : '') + (chat?.type === 'group' ? `${sender} · ${chatTitle(chat, state.users, state.me?.id)}` : sender);
  notify(title, previewText(m, state.users, state.me?.id));
}

function onRemind(ev) {
  const from = state.users[ev.fromUserId]?.name || 'Сотрудник';
  const chat = state.chats[ev.chatId];
  const where = chat ? chatTitle(chat, state.users, state.me?.id) : '';
  notify(`Напоминание от ${from}`, ev.text || 'Прочитайте сообщение');
  requestAttention();
  toast(`${from} просит прочитать сообщение${where ? ` в «${where}»` : ''}`, { label: 'Открыть', run: () => jumpToMessage(ev.chatId, ev.messageId) });
}

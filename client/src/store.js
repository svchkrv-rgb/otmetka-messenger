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
  users: {},
  chats: {},
  messages: {},
  hasMore: {},
  activeChatId: null,
  view: 'chats',
  typing: {},
  connection: 'offline',
  bootError: null,
  iceServers: [],
  call: null,
  toast: null,
  modal: null,
  infoOpen: false,
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
export function toast(text) {
  clearTimeout(toastTimer);
  setState({ toast: { text, id: Date.now() } });
  toastTimer = setTimeout(() => setState({ toast: null }), 4500);
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
  return url;
}

export async function request(method, path, body) {
  const { serverUrl, token } = state;
  let res;
  try {
    res = await fetch(serverUrl + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
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

// ---------- Вход ----------
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
  localStorage.setItem('otmetka.server', serverUrl);
  localStorage.setItem('otmetka.token', data.token);
  setState({ serverUrl, token: data.token, me: data.user });
  await bootstrap();
}

export async function bootstrap() {
  setState({ bootError: null });
  try {
    const [me, users, chats, config] = await Promise.all([
      request('GET', '/api/me'),
      request('GET', '/api/users'),
      request('GET', '/api/chats'),
      request('GET', '/api/config'),
    ]);
    setState({ me, users: byId(users), chats: byId(chats), iceServers: config.iceServers || [] });
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
  setState({ token: '', me: null, users: {}, chats: {}, messages: {}, hasMore: {}, activeChatId: null, modal: null, call: null, infoOpen: false });
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
    const [users, chats] = await Promise.all([request('GET', '/api/users'), request('GET', '/api/chats')]);
    setState({ users: byId(users), chats: byId(chats) });
    for (const chatId of Object.keys(state.messages)) loadMessages(Number(chatId)).catch(() => {});
  } catch { /* повторим при следующем подключении */ }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message:new': return upsertMessage(ev.message, true);
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
      return setState((s) => ({ typing: { ...s.typing, [ev.chatId]: { ...(s.typing[ev.chatId] || {}), [ev.userId]: Date.now() + 4500 } } }));
    default:
      if (ev.type.startsWith('call:')) callHandlers.forEach((h) => h(ev));
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
    const messages = list ? { ...s.messages, [m.chatId]: mergeById([...list, m]) } : s.messages;
    const fromOther = m.senderId !== s.me?.id && m.kind !== 'system';
    const chats = chat
      ? { ...s.chats, [m.chatId]: { ...chat, lastMessage: !alreadyLast ? m : chat.lastMessage, unread: chat.unread + (isNew && fromOther ? 1 : 0) } }
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
    if (ev.readerId === s.me?.id && ev.marked) next = { ...next, unread: Math.max(0, next.unread - ev.marked) };
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
    const cur = s.messages[chatId] || [];
    const hasMore = older || !s.messages[chatId] ? page.length === PAGE : s.hasMore[chatId];
    return { messages: { ...s.messages, [chatId]: mergeById([...page, ...cur]) }, hasMore: { ...s.hasMore, [chatId]: hasMore } };
  });
  return page.length;
}

export function sendMessage(chatId, { text, files, important }, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('text', text || '');
    if (important) fd.append('important', 'true');
    for (const f of files || []) fd.append('files', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${state.serverUrl}/api/chats/${chatId}/messages`);
    xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) { upsertMessage(data); resolve(data); }
      else reject(new ApiError(data?.error || 'Не удалось отправить', xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Нет связи с сервером', 0));
    xhr.send(fd);
  });
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
export function sendTyping(chatId) {
  if (Date.now() - lastTypingSent < 3000) return;
  lastTypingSent = Date.now();
  wsSend({ type: 'typing', chatId });
}

export async function openDirect(userId) {
  const chat = await request('POST', '/api/chats/direct', { userId });
  setState((s) => ({ chats: { ...s.chats, [chat.id]: chat }, activeChatId: chat.id, view: 'chats', infoOpen: false }));
  return chat;
}

export function openChat(chatId) {
  setState({ activeChatId: chatId, infoOpen: false });
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
  const sender = state.users[m.senderId]?.name || 'Новое сообщение';
  const title = chat?.type === 'group' ? `${sender} · ${chatTitle(chat, state.users, state.me?.id)}` : sender;
  notify(title, previewText(m, state.users, state.me?.id));
}

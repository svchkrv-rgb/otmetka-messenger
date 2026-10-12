// Созвоны через медиасервер LiveKit: один на один и в группе, демонстрация экрана, «рука», чат звонка.
import { Room, RoomEvent, Track, ConnectionQuality, VideoPresets } from 'livekit-client';
import { getState, setState, request, toast, notify, requestAttention, onCallEvent } from './store.js';
import { startTone, stopTone, isP2PBusy } from './calls.js';

let room = null;
let audioBox = null;
export const getRoom = () => room;

const enc = new TextEncoder();
const dec = new TextDecoder();
const bump = () => setState((s) => (s.gcall ? { gcall: { ...s.gcall, v: (s.gcall.v || 0) + 1 } } : null));
const patch = (p) => setState((s) => (s.gcall ? { gcall: { ...s.gcall, ...p } } : null));

export const inLkCall = () => !!getState().gcall;

function lkUrl() {
  return getState().serverUrl.replace(/^http/i, 'ws');
}

function mediaHint(e) {
  if (!navigator.mediaDevices?.getUserMedia) return 'Камера и микрофон в браузере доступны только по HTTPS. Используйте адрес https://…:8443 или приложение для Windows.';
  if (e?.name === 'NotAllowedError') return 'Нет доступа к микрофону или камере. Разрешите доступ в настройках.';
  if (e?.name === 'NotFoundError') return 'Микрофон или камера не найдены.';
  return null;
}

function attachAudio(track) {
  if (!audioBox) { audioBox = document.createElement('div'); audioBox.style.display = 'none'; document.body.appendChild(audioBox); }
  const el = track.attach();
  el.dataset.lk = '1';
  audioBox.appendChild(el);
}

function broadcastHand(up) {
  try { room?.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'hand', up })), { reliable: true }); } catch { /* */ }
}

async function connect({ callId, chatId, token, video }) {
  setState({
    gcall: {
      callId, chatId, video, phase: 'connecting', startedAt: null, minimized: false, panel: null,
      muted: false, cameraOn: false, screenOn: false, hands: {}, chat: [], unreadChat: 0, v: 0,
    },
  });
  const r = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
  });
  room = r;
  r.on(RoomEvent.ParticipantConnected, (p) => {
    bump();
    // сообщить новому участнику, поднята ли у нас рука
    if (getState().gcall?.hands?.[r.localParticipant.identity]) broadcastHand(true);
    if (!getState().gcall?.startedAt) patch({ startedAt: Date.now() });
    void p;
  });
  r.on(RoomEvent.ParticipantDisconnected, (p) => {
    setState((s) => {
      if (!s.gcall) return null;
      const hands = { ...s.gcall.hands };
      delete hands[p.identity];
      return { gcall: { ...s.gcall, hands, v: s.gcall.v + 1 } };
    });
  });
  r.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) attachAudio(track);
    bump();
  });
  r.on(RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); bump(); });
  for (const ev of [RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.ActiveSpeakersChanged, RoomEvent.ConnectionQualityChanged,
    RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished]) {
    r.on(ev, bump);
  }
  r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
    if (pub.source === Track.Source.ScreenShare) patch({ screenOn: false });
  });
  r.on(RoomEvent.Reconnecting, () => patch({ phase: 'reconnecting' }));
  r.on(RoomEvent.Reconnected, () => patch({ phase: 'active' }));
  r.on(RoomEvent.Disconnected, () => {
    if (room === r) finish(true);
  });
  r.on(RoomEvent.DataReceived, (payload, participant) => {
    let msg;
    try { msg = JSON.parse(dec.decode(payload)); } catch { return; }
    const id = participant?.identity;
    if (!id) return;
    if (msg.t === 'hand') {
      setState((s) => (s.gcall ? { gcall: { ...s.gcall, hands: { ...s.gcall.hands, [id]: !!msg.up } } } : null));
      if (msg.up) {
        const name = getState().users[Number(id)]?.name || participant.name;
        toast(`${name} поднял(а) руку`);
      }
    } else if (msg.t === 'chat' && typeof msg.text === 'string') {
      setState((s) => (s.gcall ? {
        gcall: { ...s.gcall, chat: [...s.gcall.chat, { id: `${id}-${Date.now()}`, from: id, text: msg.text.slice(0, 2000), at: Date.now() }], unreadChat: s.gcall.panel === 'chat' ? 0 : s.gcall.unreadChat + 1 },
      } : null));
    }
  });

  try {
    await r.connect(lkUrl(), token, { autoSubscribe: true });
  } catch (e) {
    console.error(e);
    toast('Не удалось подключиться к медиасерверу. Проверьте, что запущен LiveKit (см. README).');
    finish(false);
    return;
  }
  try {
    await r.localParticipant.setMicrophoneEnabled(true);
  } catch (e) {
    toast(mediaHint(e) || 'Микрофон недоступен — вас не будет слышно');
    patch({ muted: true });
  }
  if (video) {
    try {
      await r.localParticipant.setCameraEnabled(true);
      patch({ cameraOn: true });
    } catch (e) {
      toast(mediaHint(e) || 'Камера недоступна — звонок без видео');
    }
  }
  patch({ phase: 'active', startedAt: r.remoteParticipants.size ? Date.now() : null });
  bump();
}

function finish(notifyServer) {
  const g = getState().gcall;
  const r = room;
  room = null;
  if (r) { r.removeAllListeners(); r.disconnect().catch(() => {}); }
  if (audioBox) { audioBox.innerHTML = ''; }
  if (g && notifyServer !== false) request('POST', `/api/calls/${g.callId}/leave`).catch(() => {});
  setState({ gcall: null });
}

// ---------- Действия ----------
export async function lkStartCall(chatId, video) {
  if (getState().gcall || getState().call) { toast('Вы уже в звонке'); return; }
  try {
    const r = await request('POST', '/api/calls/start', { chatId, video });
    await connect({ callId: r.callId, chatId, token: r.token, video });
  } catch (e) { toast(e.message); }
}

export async function lkJoin(callId, video) {
  const ring = getState().ring;
  if (ring?.call.id === callId) { stopTone(); setState({ ring: null }); }
  if (getState().gcall) { if (getState().gcall.callId !== callId) toast('Сначала завершите текущий звонок'); return; }
  try {
    const r = await request('POST', `/api/calls/${callId}/join`);
    await connect({ callId, chatId: r.chatId, token: r.token, video });
  } catch (e) { toast(e.message); }
}

export function lkDecline(reason, minutes) {
  const ring = getState().ring;
  if (!ring) return;
  stopTone();
  setState({ ring: null });
  request('POST', `/api/calls/${ring.call.id}/decline`, { reason, minutes }).catch(() => {});
  if (reason === 'later') {
    const peerId = ring.fromUserId;
    const chatId = ring.chatId;
    const name = getState().users[peerId]?.name || 'коллеге';
    setTimeout(() => {
      notify('Напоминание', `Вы обещали перезвонить: ${name}`);
      requestAttention();
      toast(`Пора перезвонить: ${name}`, { label: 'Позвонить', run: () => lkStartCall(chatId, false) });
    }, (minutes || 10) * 60000);
  }
}

export function lkLeave() { finish(true); }

export async function lkToggleMic() {
  const g = getState().gcall;
  if (!room || !g) return;
  try { await room.localParticipant.setMicrophoneEnabled(g.muted); patch({ muted: !g.muted }); } catch (e) { toast(mediaHint(e) || 'Не удалось включить микрофон'); }
}
export async function lkToggleCamera() {
  const g = getState().gcall;
  if (!room || !g) return;
  try { await room.localParticipant.setCameraEnabled(!g.cameraOn); patch({ cameraOn: !g.cameraOn }); } catch (e) { toast(mediaHint(e) || 'Не удалось включить камеру'); }
}
export async function lkToggleScreen() {
  const g = getState().gcall;
  if (!room || !g) return;
  if (!g.screenOn && !navigator.mediaDevices?.getDisplayMedia) { toast('Демонстрация экрана недоступна в этом окружении'); return; }
  try {
    await room.localParticipant.setScreenShareEnabled(!g.screenOn, { audio: false, selfBrowserSurface: 'exclude' });
    patch({ screenOn: !g.screenOn });
  } catch (e) {
    if (e?.name !== 'NotAllowedError') toast('Не удалось начать демонстрацию экрана');
  }
}
export function lkToggleHand() {
  const g = getState().gcall;
  if (!room || !g) return;
  const me = room.localParticipant.identity;
  const up = !g.hands[me];
  patch({ hands: { ...g.hands, [me]: up } });
  broadcastHand(up);
}
export function lkSendChat(text) {
  const g = getState().gcall;
  const body = text.trim();
  if (!room || !g || !body) return;
  try { room.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'chat', text: body })), { reliable: true }); } catch { /* */ }
  patch({ chat: [...g.chat, { id: `me-${Date.now()}`, from: room.localParticipant.identity, text: body, at: Date.now() }] });
}
export async function lkInvite(userIds) {
  const g = getState().gcall;
  if (!g) return;
  try {
    const r = await request('POST', `/api/calls/${g.callId}/invite`, { userIds });
    toast(`Вызываем: ${r.rang.map((id) => getState().users[id]?.name.split(' ')[0]).filter(Boolean).join(', ')}`);
  } catch (e) { toast(e.message); }
}
export const lkSetPanel = (panel) => patch({ panel, ...(panel === 'chat' ? { unreadChat: 0 } : {}) });
export const lkMinimize = (minimized) => patch({ minimized });

// ---------- Данные для отображения ----------
export function participantsView() {
  if (!room) return [];
  const list = [room.localParticipant, ...room.remoteParticipants.values()];
  return list.map((p) => {
    const cam = p.getTrackPublication(Track.Source.Camera);
    const scr = p.getTrackPublication(Track.Source.ScreenShare);
    const mic = p.getTrackPublication(Track.Source.Microphone);
    return {
      identity: p.identity,
      userId: Number(p.identity),
      name: p.name,
      local: p === room.localParticipant,
      speaking: p.isSpeaking,
      micOn: !!mic && !mic.isMuted,
      camTrack: cam && !cam.isMuted ? cam.track : null,
      screenTrack: scr && !scr.isMuted ? scr.track : null,
      poor: p.connectionQuality === ConnectionQuality.Poor || p.connectionQuality === ConnectionQuality.Lost,
    };
  });
}

// ---------- События сервера ----------
onCallEvent((ev) => {
  const s = getState();
  switch (ev.type) {
    case 'gcall:ring': {
      if (s.gcall || s.call || isP2PBusy()) {
        request('POST', `/api/calls/${ev.call.id}/decline`, { reason: 'busy' }).catch(() => {});
        return;
      }
      if (s.ring?.call.id === ev.call.id) return;
      setState({ ring: { call: ev.call, chatId: ev.chatId, fromUserId: ev.fromUserId, chatType: ev.chatType } });
      startTone('in');
      const from = s.users[ev.fromUserId]?.name || 'Коллега';
      const chat = s.chats[ev.chatId];
      notify(ev.chatType === 'group' ? `${from} зовёт в созвон` : from, ev.chatType === 'group' ? (chat?.title || 'Групповой созвон') : (ev.call.video ? 'Входящий видеозвонок' : 'Входящий аудиозвонок'));
      requestAttention();
      return;
    }
    case 'gcall:ring-stop':
      if (s.ring?.call.id === ev.callId) {
        stopTone();
        setState({ ring: null });
        if (ev.reason === 'missed' || ev.reason === 'ended') toast('Пропущенный звонок');
      }
      return;
    case 'gcall:update':
      if (s.ring?.call.id === ev.call.id) setState({ ring: { ...s.ring, call: ev.call } });
      if (s.gcall?.callId === ev.call.id) patch({ info: ev.call });
      return;
    case 'gcall:declined': {
      if (s.gcall?.callId !== ev.callId) return;
      const name = s.users[ev.userId]?.name || 'Коллега';
      toast(ev.reason === 'busy' ? `${name}: занят(а) в другом звонке` : ev.reason === 'later' ? `${name} перезвонит через ${ev.minutes || 10} мин` : `${name} отклонил(а) звонок`);
      return;
    }
    case 'gcall:ended':
      if (s.ring?.call.id === ev.callId) { stopTone(); setState({ ring: null }); }
      if (s.gcall?.callId === ev.callId) { toast('Звонок завершён'); finish(false); }
      return;
    default:
  }
});

window.addEventListener('beforeunload', () => { if (getState().gcall) finish(true); });

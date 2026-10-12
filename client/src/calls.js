// Звонки 1-на-1 поверх WebRTC. Сигналинг идёт через WebSocket сервера.
import { getState, setState, wsSend, onCallEvent, toast, notify, requestAttention } from './store.js';
import { randomId } from './utils.js';

let pc = null;
let localStream = null;
let remoteStream = null;
let pendingCandidates = [];
let tone = null;

const update = (patch) => setState((s) => (s.call ? { call: { ...s.call, ...patch } } : null));

function mediaError(e) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Камера и микрофон в браузере доступны только по HTTPS. Откройте адрес сервера через https:// или используйте приложение для Windows.';
  }
  if (e?.name === 'NotAllowedError') return 'Нет доступа к микрофону или камере. Разрешите доступ в настройках.';
  if (e?.name === 'NotFoundError') return 'Микрофон или камера не найдены.';
  if (e?.name === 'NotReadableError') return 'Камера или микрофон заняты другим приложением.';
  return 'Не удалось включить микрофон или камеру.';
}

async function getMedia(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch (e) {
    // Нет камеры — продолжаем голосом
    if (video && (e.name === 'NotFoundError' || e.name === 'NotReadableError')) {
      toast('Камера недоступна — звонок пойдёт без видео');
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    throw e;
  }
}

function startTone(kind) {
  stopTone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const beep = () => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = kind === 'in' ? 740 : 425;
      g.gain.value = 0.06;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + (kind === 'in' ? 0.35 : 1.0));
    };
    beep();
    const iv = setInterval(beep, kind === 'in' ? 900 : 4000);
    tone = { ctx, iv };
  } catch { /* звук недоступен */ }
}
function stopTone() {
  if (!tone) return;
  clearInterval(tone.iv);
  tone.ctx.close().catch(() => {});
  tone = null;
}

function cleanup() {
  stopTone();
  if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); }
  pc = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  remoteStream = null;
  pendingCandidates = [];
  setState({ call: null });
}

function createPeer(isCaller) {
  const call = getState().call;
  pc = new RTCPeerConnection({ iceServers: getState().iceServers });
  remoteStream = new MediaStream();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    e.track.onunmute = () => update({ remoteVersion: Date.now() });
    update({ remoteStream, remoteVersion: Date.now() });
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'call:signal', callId: call.id, data: { candidate: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    const st = pc?.connectionState;
    if (st === 'connected' && !getState().call?.startedAt) update({ phase: 'active', startedAt: Date.now() });
    if (st === 'disconnected') update({ unstable: true });
    if (st === 'connected') update({ unstable: false });
    if (st === 'failed') {
      toast('Соединение не установилось. Возможно, нужен TURN-сервер — см. README.');
      hangUp();
    }
  };
  if (isCaller) {
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'call:signal', callId: call.id, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
    })().catch((e) => { console.error(e); toast('Ошибка при соединении'); hangUp(); });
  }
}

async function handleSignal(data) {
  if (!pc) return;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const call = getState().call;
      wsSend({ type: 'call:signal', callId: call.id, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else pendingCandidates.push(data.candidate);
  }
}

const END_TEXT = {
  rejected: 'Звонок отклонён',
  busy: 'Абонент занят',
  offline: 'Абонент не в сети',
  'no-answer': 'Абонент не ответил',
  unavailable: 'Абонент недоступен',
  cancelled: 'Вызов отменён',
  missed: 'Пропущенный звонок',
  hangup: 'Звонок завершён',
  'answered-elsewhere': 'Звонок принят на другом устройстве',
};

onCallEvent((ev) => {
  const call = getState().call;
  switch (ev.type) {
    case 'call:incoming': {
      if (call) { wsSend({ type: 'call:reject', callId: ev.callId, reason: 'busy' }); return; }
      setState({
        call: { id: ev.callId, peerId: ev.fromUserId, video: ev.video, direction: 'in', phase: 'ringing', muted: false, cameraOff: false, localStream: null, remoteStream: null, startedAt: null },
      });
      startTone('in');
      const name = getState().users[ev.fromUserId]?.name || 'Сотрудник';
      notify(name, ev.video ? 'Входящий видеозвонок' : 'Входящий аудиозвонок');
      requestAttention();
      return;
    }
    case 'call:accepted':
      if (!call || call.id !== ev.callId) return;
      stopTone();
      update({ phase: 'connecting' });
      createPeer(true);
      return;
    case 'call:signal':
      if (!call || call.id !== ev.callId) return;
      handleSignal(ev.data).catch((e) => console.error('signal', e));
      return;
    case 'call:ended':
      if (!call || call.id !== ev.callId) return;
      if (ev.reason !== 'hangup' || call.direction === 'out' || call.phase !== 'ringing') toast(END_TEXT[ev.reason] || 'Звонок завершён');
      cleanup();
      return;
    default:
  }
});

export async function startCall(peerId, video) {
  if (getState().call) return;
  if (getState().connection !== 'online') { toast('Нет связи с сервером'); return; }
  const id = randomId();
  try {
    localStream = await getMedia(video);
  } catch (e) {
    toast(mediaError(e));
    return;
  }
  setState({
    call: { id, peerId, video, direction: 'out', phase: 'calling', muted: false, cameraOff: false, localStream, remoteStream: null, startedAt: null },
  });
  wsSend({ type: 'call:invite', callId: id, toUserId: peerId, video });
  startTone('out');
}

export async function acceptCall(withVideo) {
  const call = getState().call;
  if (!call || call.phase !== 'ringing') return;
  stopTone();
  try {
    localStream = await getMedia(withVideo);
  } catch (e) {
    toast(mediaError(e));
    wsSend({ type: 'call:reject', callId: call.id });
    cleanup();
    return;
  }
  update({ phase: 'connecting', localStream });
  createPeer(false);
  wsSend({ type: 'call:accept', callId: call.id });
}

export function rejectCall() {
  const call = getState().call;
  if (!call) return;
  wsSend({ type: 'call:reject', callId: call.id });
  cleanup();
}

export function hangUp() {
  const call = getState().call;
  if (!call) return;
  if (call.direction === 'in' && call.phase === 'ringing') wsSend({ type: 'call:reject', callId: call.id });
  else if (call.direction === 'out' && call.phase === 'calling') wsSend({ type: 'call:cancel', callId: call.id });
  else wsSend({ type: 'call:end', callId: call.id });
  cleanup();
}

export function toggleMute() {
  const call = getState().call;
  if (!call || !localStream) return;
  const muted = !call.muted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  update({ muted });
}

export function toggleCamera() {
  const call = getState().call;
  if (!call || !localStream) return;
  const cameraOff = !call.cameraOff;
  localStream.getVideoTracks().forEach((t) => { t.enabled = !cameraOff; });
  update({ cameraOff });
}

window.addEventListener('beforeunload', () => { if (getState().call) hangUp(); });

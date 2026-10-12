import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { acceptCall, rejectCall, hangUp, toggleMute, toggleCamera } from '../calls.js';
import { formatDuration } from '../utils.js';
import { UserAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';

function MediaEl({ stream, kind, muted, className, version }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null;
    ref.current?.play?.().catch(() => {});
  }, [stream, version]);
  return kind === 'audio'
    ? <audio ref={ref} autoPlay />
    : <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

export default function CallLayer() {
  const s = useStore();
  const call = s.call;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!call?.startedAt) return undefined;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [call?.startedAt]);

  if (!call) return null;
  const peer = s.users[call.peerId];

  if (call.direction === 'in' && call.phase === 'ringing') {
    return (
      <div className="incoming" role="alertdialog" aria-label="Входящий звонок">
        <div className="incoming-top">
          <span className="incoming-ring"><UserAvatar user={peer} size={60} /></span>
          <div>
            <div className="incoming-name">{peer?.name ?? 'Сотрудник'}</div>
            <div className="incoming-sub">{call.video ? 'Входящий видеозвонок…' : 'Входящий аудиозвонок…'}</div>
            {peer?.position && <div className="incoming-pos">{peer.position}</div>}
          </div>
        </div>
        <div className="incoming-actions">
          <button className="pill-btn pill-red" onClick={() => rejectCall()}><Icon name="hangup" size={18} stroke={2} />Отклонить</button>
          <button className="pill-btn pill-green" onClick={() => acceptCall(false)}><Icon name="phone" size={18} stroke={2} />Ответить</button>
        </div>
        <div className="incoming-actions">
          <button className="pill-btn pill-dark" onClick={() => acceptCall(true)}><Icon name="video" size={18} />Ответить с видео</button>
          <button className="pill-btn pill-dark" onClick={() => rejectCall('later', 10)}><Icon name="clock" size={18} />Перезвоню через 10 мин</button>
        </div>
      </div>
    );
  }

  const remoteVideo = call.remoteStream?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
  const localVideo = call.localStream?.getVideoTracks().length > 0;
  const status = call.phase === 'calling' ? 'Вызов…'
    : call.phase === 'connecting' ? 'Соединение…'
      : call.unstable ? 'Связь прерывается…'
        : formatDuration((Date.now() - call.startedAt) / 1000);

  return (
    <div className="call" role="dialog" aria-label="Звонок">
      <MediaEl stream={call.remoteStream} kind="audio" version={call.remoteVersion} />
      <div className="call-stage">
        {remoteVideo ? (
          <MediaEl stream={call.remoteStream} kind="video" muted className="call-remote" version={call.remoteVersion} />
        ) : (
          <div className="call-peer">
            <span className={call.phase === 'calling' ? 'incoming-ring' : ''}><UserAvatar user={peer} size={120} /></span>
            <div className="call-peer-name">{peer?.name ?? 'Сотрудник'}</div>
            <div className="call-peer-status">{status}</div>
          </div>
        )}
        {remoteVideo && (
          <div className="call-overlay-top">
            <strong>{peer?.name}</strong>
            <span className="mono">{status}</span>
          </div>
        )}
        {localVideo && (
          <div className={'call-self' + (call.cameraOff ? ' call-self-off' : '')}>
            {call.cameraOff ? <span>Камера выключена</span> : <MediaEl stream={call.localStream} kind="video" muted />}
          </div>
        )}
      </div>
      <div className="call-controls">
        <button className={'ctrl' + (call.muted ? ' ctrl-off' : '')} onClick={toggleMute} aria-pressed={call.muted} aria-label={call.muted ? 'Включить микрофон' : 'Выключить микрофон'}>
          <span><Icon name={call.muted ? 'micOff' : 'mic'} size={22} /></span>{call.muted ? 'Микрофон выкл.' : 'Микрофон'}
        </button>
        {localVideo && (
          <button className={'ctrl' + (call.cameraOff ? ' ctrl-off' : '')} onClick={toggleCamera} aria-pressed={call.cameraOff} aria-label={call.cameraOff ? 'Включить камеру' : 'Выключить камеру'}>
            <span><Icon name={call.cameraOff ? 'videoOff' : 'video'} size={22} /></span>{call.cameraOff ? 'Камера выкл.' : 'Камера'}
          </button>
        )}
        <button className="ctrl ctrl-end" onClick={hangUp} aria-label="Завершить звонок">
          <span><Icon name="hangup" size={24} stroke={2} /></span>Завершить
        </button>
      </div>
    </div>
  );
}

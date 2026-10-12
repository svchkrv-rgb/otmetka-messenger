import React, { useEffect, useRef, useState } from 'react';
import { toast, sendTyping } from '../store.js';
import { formatDuration } from '../utils.js';
import Icon from './Icon.jsx';

const MAX_SEC = 600;

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

/** Запись голосового: сразу «закреплена», отправка кнопкой, Esc или корзина — отмена. */
export default function VoiceRecorder({ chatId, onCancel, onSend }) {
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState([]);
  const [ready, setReady] = useState(false);
  const rec = useRef(null);
  const chunks = useRef([]);
  const allLevels = useRef([]);
  const started = useRef(0);
  const stream = useRef(null);
  const ctx = useRef(null);
  const timers = useRef([]);
  const finish = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        toast('Микрофон в браузере доступен только по HTTPS или в приложении для Windows');
        onCancel();
        return;
      }
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        toast(e?.name === 'NotAllowedError' ? 'Нет доступа к микрофону' : 'Микрофон не найден');
        onCancel();
        return;
      }
      if (cancelled) { stream.current.getTracks().forEach((t) => t.stop()); return; }
      const mime = pickMime();
      const r = new MediaRecorder(stream.current, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => finish.current?.();
      r.start(250);
      rec.current = r;
      started.current = Date.now();
      setReady(true);

      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx.current = new Ctx();
      const src = ctx.current.createMediaStreamSource(stream.current);
      const an = ctx.current.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      timers.current.push(setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
        allLevels.current.push(lvl);
        setLevels((l) => [...l.slice(-47), lvl]);
      }, 100));
      timers.current.push(setInterval(() => {
        const sec = (Date.now() - started.current) / 1000;
        setElapsed(sec);
        sendTyping(chatId, 'voice');
        if (sec >= MAX_SEC) send();
      }, 250));
    })();
    const onKey = (e) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', onKey);
      cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function cleanup() {
    timers.current.forEach(clearInterval);
    timers.current = [];
    try { if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); } catch { /* */ }
    stream.current?.getTracks().forEach((t) => t.stop());
    ctx.current?.close().catch(() => {});
  }

  function cancel() {
    finish.current = null;
    cleanup();
    onCancel();
  }

  function send() {
    if (!rec.current) return;
    const duration = (Date.now() - started.current) / 1000;
    if (duration < 0.7) { toast('Слишком короткое сообщение'); cancel(); return; }
    finish.current = () => {
      const type = rec.current.mimeType || 'audio/webm';
      const blob = new Blob(chunks.current, { type });
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
      const file = new File([blob], `Голосовое ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.${ext}`, { type });
      // 48 столбиков для отображения
      const src = allLevels.current;
      const peaks = Array.from({ length: 48 }, (_, i) => {
        const a = Math.floor((i / 48) * src.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / 48) * src.length));
        let max = 0;
        for (let j = a; j < b && j < src.length; j++) max = Math.max(max, src[j]);
        return Math.round(max * 100) / 100;
      });
      onSend(file, { voice: true, duration: Math.round(duration * 10) / 10, peaks });
    };
    timers.current.forEach(clearInterval);
    timers.current = [];
    rec.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
    ctx.current?.close().catch(() => {});
  }

  return (
    <div className="voice-rec">
      <div className="voice-hint"><Icon name="lock" size={14} stroke={2} />Запись идёт — нажмите ➤, чтобы отправить, Esc — отменить</div>
      <div className="voice-row">
        <button className="round-btn voice-trash" aria-label="Удалить запись" onClick={cancel}><Icon name="trash" size={20} /></button>
        <div className="voice-field" aria-live="polite">
          <span className={'rec-dot' + (ready ? ' rec-dot-on' : '')} />
          <span className="mono voice-time">{formatDuration(elapsed)}</span>
          <span className="voice-wave" aria-hidden="true">
            {Array.from({ length: 48 }, (_, i) => {
              const v = levels[i - (48 - levels.length)];
              return <i key={i} style={{ height: v === undefined ? 4 : Math.max(4, v * 28), background: v === undefined ? '#CDD0D3' : 'var(--navy)' }} />;
            })}
          </span>
        </div>
        <button className="round-btn round-btn-send" aria-label="Отправить голосовое" onClick={send} disabled={!ready}>
          <Icon name="send" size={20} stroke={2} />
        </button>
      </div>
    </div>
  );
}

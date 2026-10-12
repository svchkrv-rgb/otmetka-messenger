import React, { useEffect, useRef, useState } from 'react';
import { useStore, fileUrl, openModal, request } from '../store.js';
import { formatTime, formatReadTime, formatSize, callText, parseCall } from '../utils.js';
import { UserAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';

export default function Message({ message: m, chat, grouped, isLastOwn, observe }) {
  const s = useStore();
  const meId = s.me.id;
  const mine = m.senderId === meId;
  const [popover, setPopover] = useState(false);
  const observeProps = observe ? { 'data-id': m.id, 'data-observe': '1', ref: observe } : {};

  if (m.kind === 'system') {
    return <div className="msg-system" {...observeProps}><span>{m.text}</span></div>;
  }

  if (m.kind === 'call') {
    const c = parseCall(m);
    const missed = c.outcome !== 'completed';
    return (
      <div className={'msg-row' + (mine ? ' msg-row-mine' : '')} {...observeProps}>
        <div className={'call-card' + (missed && !mine ? ' call-card-missed' : '')}>
          <span className="call-card-icon"><Icon name={c.video ? 'video' : 'phone'} size={18} /></span>
          <span>{callText(m, meId)}</span>
          <span className="msg-time">{formatTime(m.createdAt)}</span>
        </div>
      </div>
    );
  }

  const sender = s.users[m.senderId];
  const others = chat.members.filter((x) => x.userId !== m.senderId).length;
  const readCount = m.receipts?.length || 0;
  const readAll = others > 0 && readCount >= others;
  const showAvatar = !mine && chat.type === 'group';
  const images = m.attachments.filter((a) => a.kind === 'image');
  const videos = m.attachments.filter((a) => a.kind === 'video');
  const otherFiles = m.attachments.filter((a) => a.kind === 'file');
  const mediaOnly = !m.text && !otherFiles.length && (images.length || videos.length);
  const showReceiptLine = mine && (isLastOwn || m.important);

  return (
    <div className={'msg-row' + (mine ? ' msg-row-mine' : '') + (grouped ? ' msg-row-grouped' : '')} {...observeProps}>
      {showAvatar && (grouped ? <span className="msg-avatar-space" /> : <UserAvatar user={sender} size={32} />)}
      <div className="msg-col">
        <div className={'bubble' + (mine ? ' bubble-mine' : '') + (mediaOnly ? ' bubble-media' : '') + (m.important ? ' bubble-important' : '')}>
          {!mine && chat.type === 'group' && !grouped && (
            <div className="bubble-author" style={{ color: sender?.color }}>{sender?.name ?? 'Сотрудник'}{sender?.position ? <span> · {sender.position}</span> : null}</div>
          )}
          {m.important && <div className="bubble-flag"><Icon name="important" size={13} stroke={2.5} />Важное</div>}

          {images.length > 0 && (
            <div className={'media-grid media-grid-' + Math.min(images.length, 3)}>
              {images.map((a) => (
                <button key={a.id} className="media-thumb" aria-label={`Открыть фото ${a.fileName}`} onClick={() => openModal('image', { url: fileUrl(a.url), downloadUrl: fileUrl(a.url, true), name: a.fileName })}>
                  <img src={fileUrl(a.url)} alt={a.fileName} loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {videos.map((a) => (
            <video key={a.id} className="media-video" src={fileUrl(a.url)} controls preload="metadata" />
          ))}
          {otherFiles.map((a) => (
            <a key={a.id} className="file-card" href={fileUrl(a.url, true)} download={a.fileName} target="_blank" rel="noreferrer">
              <span className="file-card-icon"><Icon name="file" size={18} /></span>
              <span className="file-card-body"><span>{a.fileName}</span><small>{formatSize(a.size)}</small></span>
              <Icon name="download" size={18} />
            </a>
          ))}

          {m.text && <div className="bubble-text">{m.text}</div>}

          <div className="bubble-meta">
            <span className="msg-time">{formatTime(m.createdAt)}</span>
            {mine && (
              <button className={'ticks ticks-btn' + (readAll ? ' ticks-read' : '')} aria-label="Кто прочитал" onClick={() => setPopover(!popover)}>
                {readCount > 0 ? '✓✓' : '✓'}
              </button>
            )}
          </div>
        </div>

        {showReceiptLine && (
          chat.type === 'direct' ? (
            <div className={'receipt-line' + (readCount ? ' receipt-read' : '')}>
              {readCount ? `Прочитано ${formatReadTime(m.receipts[0].readAt)}` : 'Доставлено'}
            </div>
          ) : (
            <button className={'receipt-pill' + (readAll ? ' receipt-read' : '')} aria-expanded={popover} onClick={() => setPopover(!popover)}>
              {readAll ? `Прочитали все ${others}` : `Прочитали ${readCount} из ${others}`}
              <Icon name={popover ? 'chevronUp' : 'chevronDown'} size={12} stroke={2.5} />
            </button>
          )
        )}
        {popover && <ReceiptsPopover message={m} onClose={() => setPopover(false)} />}
      </div>
    </div>
  );
}

function ReceiptsPopover({ message: m, onClose }) {
  const s = useStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('read');
  const ref = useRef(null);
  const count = m.receipts?.length || 0;

  useEffect(() => {
    request('GET', `/api/messages/${m.id}/receipts`).then(setData).catch((e) => setError(e.message));
  }, [m.id, count]);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div className="popover" role="dialog" aria-label="Кто прочитал сообщение" ref={ref}>
      {error ? <div className="popover-empty">{error}</div> : !data ? <div className="popover-empty">Загрузка…</div> : (
        <>
          <div className="popover-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'read'} className={tab === 'read' ? 'active' : ''} onClick={() => setTab('read')}>Прочитали · {data.read.length}</button>
            <button role="tab" aria-selected={tab === 'unread'} className={tab === 'unread' ? 'active' : ''} onClick={() => setTab('unread')}>Не прочитали · {data.notRead.length}</button>
          </div>
          <div className="popover-list">
            {tab === 'read' && (data.read.length ? data.read.map((r) => (
              <div key={r.userId} className="popover-row">
                <UserAvatar user={s.users[r.userId]} size={30} />
                <span className="popover-name">{s.users[r.userId]?.name ?? 'Сотрудник'}</span>
                <span className="mono">{formatReadTime(r.readAt)}</span>
              </div>
            )) : <div className="popover-empty">Пока никто не прочитал</div>)}
            {tab === 'unread' && (data.notRead.length ? data.notRead.map((id) => (
              <div key={id} className="popover-row">
                <UserAvatar user={s.users[id]} size={30} showOnline />
                <span className="popover-name">{s.users[id]?.name ?? 'Сотрудник'}</span>
                <span className="popover-sub">{s.users[id]?.online ? 'в сети' : 'не в сети'}</span>
              </div>
            )) : <div className="popover-empty">Прочитали все</div>)}
          </div>
        </>
      )}
    </div>
  );
}

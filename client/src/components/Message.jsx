import React, { useEffect, useRef, useState } from 'react';
import {
  useStore, fileUrl, openModal, request, setReply, setEditing, deleteMessage, confirmMessage, remindUnread,
  vote, setTaskDone, openDirect, jumpToMessage, openExternal, toast,
} from '../store.js';
import { startCall } from '../calls.js';
import { formatTime, formatReadTime, formatSize, formatDuration, formatDue, callText, parseCall, lastSeenText } from '../utils.js';
import { RichText, plainText } from '../format.jsx';
import { UserAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';

export default function Message({ message: m, chat, grouped, isLastOwn, observe }) {
  const s = useStore();
  const meId = s.me.id;
  const mine = m.senderId === meId;
  const [popover, setPopover] = useState(false);
  const [menu, setMenu] = useState(false);
  const rowRef = useRef(null);
  const highlighted = s.highlight?.messageId === m.id && Date.now() - s.highlight.at < 2500;

  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlighted, s.highlight?.at]);

  const setRefs = (el) => {
    rowRef.current = el;
    if (observe && el) observe(el);
  };
  const observeProps = observe ? { 'data-id': m.id, 'data-observe': '1' } : { 'data-id': m.id };

  if (m.kind === 'system') {
    return <div className="msg-system" ref={setRefs} {...observeProps}><span>{m.text}</span></div>;
  }

  if (m.kind === 'call') {
    const c = parseCall(m);
    const missed = c.outcome !== 'completed';
    return (
      <div className={'msg-row' + (mine ? ' msg-row-mine' : '')} ref={setRefs} {...observeProps}>
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
  const confirmCount = m.confirmations?.length || 0;
  const readAll = others > 0 && readCount >= others;
  const confirmAll = others > 0 && confirmCount >= others;
  const showAvatar = !mine && chat.type === 'group';
  const deleted = !!m.deletedAt;
  const images = m.attachments.filter((a) => a.kind === 'image');
  const videos = m.attachments.filter((a) => a.kind === 'video');
  const audios = m.attachments.filter((a) => a.kind === 'audio');
  const otherFiles = m.attachments.filter((a) => a.kind === 'file');
  const mediaOnly = !m.text && !otherFiles.length && !audios.length && (images.length || videos.length) && !m.replyTo;
  const card = ['poll', 'task', 'location', 'contact'].includes(m.kind);
  const showReceiptLine = mine && !deleted && (isLastOwn || m.important);
  const mentionsMe = !mine && (m.mentions?.includes(meId) || m.mentions?.includes(0));
  const mentionNames = (m.mentions || []).map((id) => (id === 0 ? 'все' : s.users[id]?.name)).filter(Boolean);
  const myRole = chat.myRole;
  const canDelete = !deleted && (mine || (chat.type === 'group' && (myRole === 'owner' || myRole === 'admin')));
  const canEdit = mine && !deleted && ['text', 'task', 'poll'].includes(m.kind) && (m.kind !== 'text' || m.text || m.attachments.length);
  const iConfirmed = m.confirmations?.some((c) => c.userId === meId);
  const guestNoDownload = myRole === 'guest' && !chat.guestDownload;

  async function onDelete() {
    setMenu(false);
    if (!window.confirm(mine ? 'Удалить сообщение у всех?' : 'Удалить чужое сообщение у всех участников?')) return;
    try { await deleteMessage(m.id); } catch { /* показано */ }
  }
  function onCopy() {
    setMenu(false);
    navigator.clipboard?.writeText(m.text).then(() => toast('Текст скопирован')).catch(() => toast('Не удалось скопировать'));
  }

  return (
    <div ref={setRefs} {...observeProps}
      className={'msg-row' + (mine ? ' msg-row-mine' : '') + (grouped ? ' msg-row-grouped' : '') + (highlighted ? ' msg-flash' : '')}>
      {showAvatar && (grouped ? <span className="msg-avatar-space" /> : <UserAvatar user={sender} size={32} />)}
      <div className="msg-col">
        <div className={'bubble' + (mine ? ' bubble-mine' : '') + (mediaOnly ? ' bubble-media' : '') + (m.important ? ' bubble-important' : '')
          + (mentionsMe ? ' bubble-mention' : '') + (deleted ? ' bubble-deleted' : '') + (card ? ' bubble-card' : '')}>
          {!mine && chat.type === 'group' && !grouped && (
            <div className="bubble-author" style={{ color: sender?.color }}>{sender?.name ?? 'Сотрудник'}{sender?.position ? <span> · {sender.position}</span> : null}</div>
          )}
          {deleted ? (
            <div className="bubble-text deleted-text"><Icon name="trash" size={14} />Сообщение удалено</div>
          ) : (
            <>
              {m.important && <div className="bubble-flag"><Icon name="important" size={13} stroke={2.5} />Важное{!mine ? ' · нужно подтвердить' : ''}</div>}
              {m.replyTo && (
                <button className="reply-quote" style={{ borderLeftColor: s.users[m.replyTo.senderId]?.color }} onClick={() => jumpToMessage(m.chatId, m.replyTo.id)}>
                  <strong style={{ color: mine ? undefined : s.users[m.replyTo.senderId]?.color }}>{m.replyTo.senderId === meId ? 'Вы' : s.users[m.replyTo.senderId]?.name ?? 'Сотрудник'}</strong>
                  <span>{m.replyTo.deleted ? 'Сообщение удалено' : plainText(m.replyTo.text) || ({ image: 'Фото', video: 'Видео', audio: 'Голосовое', file: 'Файл' }[m.replyTo.attachmentKind] ?? '…')}</span>
                </button>
              )}

              {images.length > 0 && (
                <div className={'media-grid media-grid-' + Math.min(images.length, 3)}>
                  {images.map((a) => (
                    <button key={a.id} className="media-thumb" aria-label={`Открыть фото ${a.fileName}`} onClick={() => openModal('image', { url: fileUrl(a.url), downloadUrl: guestNoDownload ? null : fileUrl(a.url, true), name: a.fileName })}>
                      <img src={fileUrl(a.url)} alt={a.fileName} loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
              {videos.map((a) => (
                <video key={a.id} className="media-video" src={fileUrl(a.url)} controls preload="metadata" controlsList={guestNoDownload ? 'nodownload' : undefined} />
              ))}
              {audios.map((a) => <VoicePlayer key={a.id} att={a} mine={mine} />)}
              {otherFiles.map((a) => (guestNoDownload ? (
                <div key={a.id} className="file-card"><span className="file-card-icon"><Icon name="file" size={18} /></span><span className="file-card-body"><span>{a.fileName}</span><small>{formatSize(a.size)} · скачивание закрыто</small></span></div>
              ) : (
                <a key={a.id} className="file-card" href={fileUrl(a.url, true)} download={a.fileName}>
                  <span className="file-card-icon"><Icon name="file" size={18} /></span>
                  <span className="file-card-body"><span>{a.fileName}</span><small>{formatSize(a.size)}</small></span>
                  <Icon name="download" size={18} />
                </a>
              )))}

              {m.kind === 'poll' && m.poll && <PollCard m={m} />}
              {m.kind === 'task' && m.task && <TaskCard m={m} chat={chat} />}
              {m.kind === 'location' && <LocationCard m={m} />}
              {m.kind === 'contact' && <ContactCard m={m} />}

              {m.kind === 'text' && m.text && (
                <div className="bubble-text"><RichText text={m.text} mentionNames={mentionNames} meName={s.me.name} /></div>
              )}

              {m.important && !mine && (
                iConfirmed
                  ? <div className="confirm-done"><Icon name="check" size={14} stroke={2.5} />Вы подтвердили прочтение</div>
                  : <button className="confirm-btn" onClick={() => confirmMessage(m.id)}><Icon name="check" size={16} stroke={2.5} />Подтвердить прочтение</button>
              )}
            </>
          )}

          <div className="bubble-meta">
            {m.silent && !deleted && <span className="msg-time" title="Отправлено без звука"><Icon name="bellOff" size={12} /></span>}
            {m.editedAt && !deleted && <span className="msg-time">изменено</span>}
            <span className="msg-time">{formatTime(m.createdAt)}</span>
            {mine && !deleted && (
              <button className={'ticks ticks-btn' + (readAll ? ' ticks-read' : '')} aria-label="Кто прочитал" onClick={() => setPopover(!popover)}>
                {readCount > 0 ? '✓✓' : '✓'}
              </button>
            )}
          </div>
        </div>

        {!deleted && (
          <div className={'msg-actions' + (menu ? ' msg-actions-open' : '')}>
            <button className="icon-btn icon-btn-xs" aria-label="Ответить" title="Ответить" onClick={() => setReply(m.chatId, m.id)}><Icon name="reply" size={16} /></button>
            <button className="icon-btn icon-btn-xs" aria-label="Ещё действия" title="Ещё" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" size={16} /></button>
            {menu && (
              <div className="menu msg-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button role="menuitem" onClick={() => { setMenu(false); setReply(m.chatId, m.id); }}><Icon name="reply" size={16} />Ответить</button>
                {m.text && <button role="menuitem" onClick={onCopy}><Icon name="copy" size={16} />Копировать текст</button>}
                {m.kind === 'text' && <button role="menuitem" onClick={() => { setMenu(false); openModal('task', { chatId: m.chatId, fromMessage: m }); }}><Icon name="task" size={16} />Создать задачу</button>}
                {mine && <button role="menuitem" onClick={() => { setMenu(false); setPopover(true); }}><Icon name="check" size={16} />Кто прочитал</button>}
                {canEdit && <button role="menuitem" onClick={() => { setMenu(false); setEditing(m.chatId, m.id); }}><Icon name="edit" size={16} />Редактировать</button>}
                {canDelete && <button role="menuitem" className="danger" onClick={onDelete}><Icon name="trash" size={16} />Удалить</button>}
              </div>
            )}
          </div>
        )}

        {showReceiptLine && (
          chat.type === 'direct' ? (
            <div className={'receipt-line' + (readCount ? ' receipt-read' : '')}>
              {m.important
                ? (confirmCount ? `Подтверждено ${formatReadTime(m.confirmations[0].at)}` : readCount ? `Прочитано ${formatReadTime(m.receipts[0].readAt)}, ждём подтверждения` : 'Доставлено')
                : readCount ? `Прочитано ${formatReadTime(m.receipts[0].readAt)}` : 'Доставлено'}
            </div>
          ) : (
            <button className={'receipt-pill' + ((m.important ? confirmAll : readAll) ? ' receipt-read' : '')} aria-expanded={popover} onClick={() => setPopover(!popover)}>
              {m.important
                ? (confirmAll ? `Подтвердили все ${others}` : `Подтвердили ${confirmCount} из ${others} · прочитали ${readCount}`)
                : (readAll ? `Прочитали все ${others}` : `Прочитали ${readCount} из ${others}`)}
              <Icon name={popover ? 'chevronUp' : 'chevronDown'} size={12} stroke={2.5} />
            </button>
          )
        )}
        {popover && <ReceiptsPopover message={m} onClose={() => setPopover(false)} />}
      </div>
    </div>
  );
}

// ---------- Голосовое ----------
function VoicePlayer({ att, mine }) {
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const duration = att.meta?.duration || 0;
  const peaks = att.meta?.peaks?.length ? att.meta.peaks : Array.from({ length: 40 }, (_, i) => 0.25 + 0.2 * Math.abs(Math.sin(i * 1.7)));
  useEffect(() => {
    const a = audio.current;
    if (!a) return undefined;
    const onTime = () => setPos(a.currentTime);
    const onEnd = () => { setPlaying(false); setPos(0); };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', () => setPlaying(false));
    a.addEventListener('play', () => setPlaying(true));
    return () => { a.removeEventListener('timeupdate', onTime); a.removeEventListener('ended', onEnd); };
  }, []);
  const total = duration || audio.current?.duration || 0;
  const progress = total ? Math.min(1, pos / total) : 0;
  function toggle() {
    const a = audio.current;
    if (!a) return;
    document.querySelectorAll('audio.voice-el').forEach((x) => { if (x !== a) x.pause(); });
    if (a.paused) a.play().catch(() => toast('Не удалось воспроизвести')); else a.pause();
  }
  function seek(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (audio.current && total) { audio.current.currentTime = ratio * total; setPos(ratio * total); }
  }
  return (
    <div className={'voice' + (mine ? ' voice-mine' : '')}>
      <audio ref={audio} className="voice-el" src={fileUrl(att.url)} preload="metadata" />
      <button className="voice-play" aria-label={playing ? 'Пауза' : 'Слушать'} onClick={toggle}><Icon name={playing ? 'pause' : 'play'} size={18} /></button>
      <button className="voice-bars" aria-label="Перемотка" onClick={seek}>
        {peaks.map((p, i) => <i key={i} style={{ height: Math.max(3, p * 26), opacity: i / peaks.length <= progress ? 1 : 0.4 }} />)}
      </button>
      <span className="voice-dur mono">{formatDuration(playing || pos ? pos : total)}</span>
    </div>
  );
}

// ---------- Опрос ----------
function PollCard({ m }) {
  const s = useStore();
  const meId = s.me.id;
  const p = m.poll;
  const voters = new Set(p.options.flatMap((o) => o.votes));
  const total = voters.size;
  const mine = new Set(p.options.filter((o) => o.votes.includes(meId)).map((o) => o.id));
  const members = s.chats[m.chatId]?.members.length || 0;
  function pick(id) {
    let next;
    if (p.multiple) { next = new Set(mine); if (next.has(id)) next.delete(id); else next.add(id); } else next = new Set(mine.has(id) ? [] : [id]);
    vote(m.id, [...next]).catch(() => {});
  }
  return (
    <div className="poll">
      <div className="card-kicker"><Icon name="poll" size={14} />{p.multiple ? 'Опрос · несколько ответов' : 'Опрос'}</div>
      <div className="poll-q">{p.question}</div>
      <div className="poll-opts">
        {p.options.map((o) => {
          const share = total ? o.votes.length / total : 0;
          const chosen = mine.has(o.id);
          return (
            <button key={o.id} className={'poll-opt' + (chosen ? ' poll-opt-on' : '')} onClick={() => pick(o.id)} aria-pressed={chosen}>
              <span className="poll-fill" style={{ width: `${Math.round(share * 100)}%` }} />
              <span className="poll-check">{chosen && <Icon name="check" size={12} stroke={3} />}</span>
              <span className="poll-text">{o.text}</span>
              <span className="poll-count" title={o.votes.map((id) => s.users[id]?.name).filter(Boolean).join(', ')}>{o.votes.length}</span>
            </button>
          );
        })}
      </div>
      <div className="card-foot">{total ? `Проголосовали ${total}${members > 1 ? ` из ${members}` : ''}` : 'Пока никто не голосовал'}</div>
    </div>
  );
}

// ---------- Задача ----------
function TaskCard({ m, chat }) {
  const s = useStore();
  const t = m.task;
  const meId = s.me.id;
  const assignee = s.users[t.assigneeId];
  const overdue = !t.doneAt && t.dueAt && t.dueAt < Date.now();
  const canToggle = !t.assigneeId || [t.assigneeId, m.senderId].includes(meId) || ['owner', 'admin'].includes(chat.myRole);
  return (
    <div className={'task' + (t.doneAt ? ' task-done' : '')}>
      <div className="card-kicker"><Icon name="task" size={14} />Задача</div>
      <div className="task-row">
        <button className={'task-check' + (t.doneAt ? ' on' : '')} aria-label={t.doneAt ? 'Вернуть в работу' : 'Отметить выполненной'} onClick={() => canToggle && setTaskDone(m.id, !t.doneAt)} disabled={!canToggle}>
          {t.doneAt && <Icon name="check" size={14} stroke={3} />}
        </button>
        <div className="task-title">{t.title}</div>
      </div>
      <div className="task-meta">
        {assignee ? <span className="task-who"><UserAvatar user={assignee} size={20} />{assignee.id === meId ? 'Вы' : assignee.name}</span> : <span>Без исполнителя</span>}
        {t.dueAt && <span className={overdue ? 'task-overdue' : ''}><Icon name="calendar" size={13} />{overdue ? 'просрочено, ' : 'до '}{formatDue(t.dueAt)}</span>}
        {t.doneAt && <span className="task-ok"><Icon name="check" size={13} stroke={2.5} />выполнено{t.doneBy && t.doneBy !== t.assigneeId ? ` (${s.users[t.doneBy]?.name})` : ''}</span>}
      </div>
    </div>
  );
}

// ---------- Геометка ----------
function LocationCard({ m }) {
  const { lat, lon, accuracy } = m.meta || {};
  if (lat === undefined) return null;
  const url = `https://yandex.ru/maps/?pt=${lon},${lat}&z=17&l=map`;
  return (
    <div className="loc">
      <div className="loc-map" aria-hidden="true">
        <span className="loc-pin"><Icon name="pin" size={28} stroke={2} /></span>
      </div>
      <div className="loc-body">
        <strong>{m.text || 'Геометка'}</strong>
        <span className="mono">{lat.toFixed(5)}, {lon.toFixed(5)}{accuracy ? ` · ±${Math.round(accuracy)} м` : ''}</span>
        <button className="link-btn" onClick={() => openExternal(url)}>Открыть на карте</button>
      </div>
    </div>
  );
}

// ---------- Контакт ----------
function ContactCard({ m }) {
  const s = useStore();
  const u = s.users[m.meta?.userId];
  if (!u) return <div className="contact">{m.text}</div>;
  const self = u.id === s.me.id;
  return (
    <div className="contact">
      <UserAvatar user={u} size={44} showOnline />
      <div className="contact-body">
        <strong>{u.name}</strong>
        <span>{[u.position, lastSeenText(u)].filter(Boolean).join(' · ')}</span>
      </div>
      {!self && u.isActive && (
        <div className="contact-actions">
          <button className="icon-btn icon-btn-sm" aria-label={`Написать: ${u.name}`} title="Написать" onClick={() => openDirect(u.id).catch((e) => toast(e.message))}><Icon name="chat" size={18} /></button>
          <button className="icon-btn icon-btn-sm" aria-label={`Позвонить: ${u.name}`} title="Позвонить" onClick={() => startCall(u.id, false)}><Icon name="phone" size={18} /></button>
        </div>
      )}
    </div>
  );
}

// ---------- Кто прочитал ----------
function ReceiptsPopover({ message: m, onClose }) {
  const s = useStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('read');
  const ref = useRef(null);
  const count = (m.receipts?.length || 0) + (m.confirmations?.length || 0);

  useEffect(() => {
    request('GET', `/api/messages/${m.id}/receipts`).then(setData).catch((e) => setError(e.message));
  }, [m.id, count]);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const confirmedAt = new Map((data?.confirmed || []).map((c) => [c.userId, c.at]));
  const notRead = data?.notRead || [];
  const notConfirmed = data?.important ? (data.read || []).filter((r) => !confirmedAt.has(r.userId)).length : 0;

  return (
    <div className="popover" role="dialog" aria-label="Кто прочитал сообщение" ref={ref}>
      {error ? <div className="popover-empty">{error}</div> : !data ? <div className="popover-empty">Загрузка…</div> : (
        <>
          <div className="popover-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'read'} className={tab === 'read' ? 'active' : ''} onClick={() => setTab('read')}>Прочитали · {data.read.length}</button>
            <button role="tab" aria-selected={tab === 'unread'} className={tab === 'unread' ? 'active' : ''} onClick={() => setTab('unread')}>Не прочитали · {notRead.length}</button>
          </div>
          <div className="popover-list">
            {tab === 'read' && (data.read.length ? data.read.map((r) => (
              <div key={r.userId} className="popover-row">
                <UserAvatar user={s.users[r.userId]} size={30} />
                <span className="popover-name">{s.users[r.userId]?.name ?? 'Сотрудник'}</span>
                {confirmedAt.has(r.userId) && <span className="confirm-tag" title={`Подтвердил(а) ${formatReadTime(confirmedAt.get(r.userId))}`}>подтвердил(а)</span>}
                <span className="mono">{formatReadTime(r.readAt)}</span>
              </div>
            )) : <div className="popover-empty">Пока никто не прочитал</div>)}
            {tab === 'unread' && (notRead.length ? notRead.map((id) => (
              <div key={id} className="popover-row">
                <UserAvatar user={s.users[id]} size={30} showOnline />
                <span className="popover-name">{s.users[id]?.name ?? 'Сотрудник'}</span>
                <span className="popover-sub">{s.users[id]?.status ? s.users[id].status.text : s.users[id]?.online ? 'в сети' : 'не в сети'}</span>
              </div>
            )) : <div className="popover-empty">Прочитали все</div>)}
          </div>
          {(notRead.length > 0 || notConfirmed > 0) && m.senderId === s.me.id && (
            <div className="popover-foot">
              <span>{notRead.length ? `Не прочитали ${notRead.length}` : ''}{notRead.length && notConfirmed ? ', ' : ''}{notConfirmed ? `не подтвердили ${notConfirmed}` : ''}</span>
              <button className="btn btn-primary btn-sm" onClick={() => remindUnread(m.id).catch(() => {})}>Напомнить</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

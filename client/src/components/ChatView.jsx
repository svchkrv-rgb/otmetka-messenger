import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useStore, setState, loadMessages, loadNewer, queueRead, toast, request, jumpToMessage,
  cancelScheduled, sendScheduledNow,
} from '../store.js';
import { startChatCall } from '../calls.js';
import { chatTitle, formatDay, lastSeenText, peerOf, formatTime, formatDateTime, statusText } from '../utils.js';
import { plainText } from '../format.jsx';
import { ChatAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';
import Message from './Message.jsx';
import Composer from './Composer.jsx';

export default function ChatView({ chatId }) {
  const s = useStore();
  const chat = s.chats[chatId];
  const messages = s.messages[chatId];
  const scrollRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [search, setSearch] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const restore = useRef(false);
  const loadingNewer = useRef(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!s.messages[chatId] || !s.hasNewer[chatId]) loadMessages(chatId).catch((e) => toast(e.message));
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1500);
    return () => clearInterval(t);
  }, []);

  // при переходе к сообщению не прилипать к низу
  useEffect(() => { if (s.highlight?.chatId === chatId) stickToBottom.current = false; }, [s.highlight, chatId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restore.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      restore.current = false;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = bottomGap < 80 && !s.hasNewer[chatId];
    setAtBottom(bottomGap < 200);
    if (el.scrollTop < 150 && s.hasMore[chatId] && !loadingOlder) {
      setLoadingOlder(true);
      prevHeight.current = el.scrollHeight;
      restore.current = true;
      try { await loadMessages(chatId, true); } catch (e) { toast(e.message); restore.current = false; }
      setLoadingOlder(false);
    }
    if (bottomGap < 150 && s.hasNewer[chatId] && !loadingNewer.current) {
      loadingNewer.current = true;
      try { await loadNewer(chatId); } catch (e) { toast(e.message); }
      loadingNewer.current = false;
    }
  }, [chatId, s.hasMore, s.hasNewer, loadingOlder]);

  async function toLatest() {
    if (s.hasNewer[chatId]) {
      try { await loadMessages(chatId); } catch (e) { toast(e.message); return; }
    }
    stickToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  // Прочтение: сообщение видно на экране И окно приложения активно
  const visible = useRef(new Set());
  const observer = useRef(null);
  const flushVisible = useCallback(() => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    let max = 0;
    for (const id of visible.current) if (id > max) max = id;
    if (max) queueRead(chatId, max);
  }, [chatId]);

  useEffect(() => {
    observer.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = Number(e.target.dataset.id);
        if (e.isIntersecting && e.intersectionRatio >= 0.6) visible.current.add(id);
        else visible.current.delete(id);
      }
      flushVisible();
    }, { root: scrollRef.current, threshold: [0, 0.6, 1] });
    scrollRef.current?.querySelectorAll('[data-observe="1"]').forEach((el) => observer.current.observe(el));
    const onFocus = () => flushVisible();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      observer.current.disconnect();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      visible.current.clear();
    };
  }, [chatId, flushVisible]);

  const observe = useCallback((el) => { if (el) observer.current?.observe(el); }, []);

  if (!chat) return null;

  const meId = s.me.id;
  const peerId = peerOf(chat, meId);
  const peer = s.users[peerId];
  const onlineCount = chat.members.filter((m) => s.users[m.userId]?.online).length;
  const typing = Object.entries(s.typing[chatId] || {}).filter(([, t]) => t.until > Date.now());
  const typingNames = typing.map(([id]) => s.users[Number(id)]?.name.split(' ')[0]).filter(Boolean);
  const voiceTyping = typing.some(([, t]) => t.kind === 'voice');
  const scheduled = s.scheduled.filter((x) => x.chatId === chatId);
  const unreadBelow = chat.unread;

  const subtitle = chat.type === 'group'
    ? `${chat.address ? chat.address + ' · ' : ''}${chat.members.length} ${plural(chat.members.length, 'участник', 'участника', 'участников')}, ${onlineCount} в сети`
    : [peer?.position, peer?.status ? statusText(peer) : lastSeenText(peer)].filter(Boolean).join(' · ');

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const dropped = [...(e.dataTransfer?.files || [])];
    if (dropped.length) setFiles((f) => [...f, ...dropped].slice(0, 10));
  }

  return (
    <section className={'chat' + (dragOver ? ' chat-drag' : '')} aria-label={chatTitle(chat, s.users, meId)}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDrop}>
      <header className="chat-head">
        <button className="icon-btn chat-back" aria-label="К списку чатов" onClick={() => setState({ activeChatId: null })}><Icon name="back" /></button>
        <ChatAvatar chat={chat} users={s.users} meId={meId} size={40} />
        <button className="chat-head-title" onClick={() => setState({ infoOpen: !s.infoOpen })}>
          <h2>{chatTitle(chat, s.users, meId)}{chat.muted && <Icon name="bellOff" size={14} style={{ marginLeft: 6, verticalAlign: -2, color: 'var(--muted)' }} />}</h2>
          <span className={peer?.online && chat.type === 'direct' && !peer?.status ? 'online' : ''}>{subtitle}</span>
        </button>
        {(chat.type === 'group' || peer?.isActive) && (
          <>
            <button className="icon-btn" aria-label={chat.type === 'group' ? 'Аудиосозвон группы' : 'Аудиозвонок'} title="Аудиозвонок" onClick={() => startChatCall(chatId, peerId, false)}><Icon name="phone" /></button>
            <button className="icon-btn" aria-label={chat.type === 'group' ? 'Видеосозвон группы' : 'Видеозвонок'} title="Видеозвонок" onClick={() => startChatCall(chatId, peerId, true)}><Icon name="video" /></button>
          </>
        )}
        <button className={'icon-btn' + (search ? ' icon-btn-on' : '')} aria-label="Поиск по чату" title="Поиск по чату" onClick={() => setSearch(!search)}><Icon name="search" /></button>
        <button className={'icon-btn' + (s.infoOpen ? ' icon-btn-on' : '')} aria-label={chat.type === 'group' ? 'Участники и настройки группы' : 'О сотруднике'} title="Информация" onClick={() => setState({ infoOpen: !s.infoOpen })}>
          <Icon name="info" />
        </button>
      </header>

      {search && <SearchBar chatId={chatId} onClose={() => setSearch(false)} />}

      {scheduled.length > 0 && (
        <div className="sched-bar">
          <button className="sched-toggle" onClick={() => setShowScheduled(!showScheduled)} aria-expanded={showScheduled}>
            <Icon name="clock" size={16} />Запланировано: {scheduled.length}<span>· ближайшее {formatDateTime(scheduled[0].sendAt)}</span>
            <Icon name={showScheduled ? 'chevronUp' : 'chevronDown'} size={14} stroke={2.5} />
          </button>
          {showScheduled && (
            <div className="sched-list">
              {scheduled.map((x) => (
                <div key={x.id} className="sched-item">
                  <span className="sched-when mono">{formatDateTime(x.sendAt)}</span>
                  <span className="sched-text">{x.important && <strong>Важное · </strong>}{x.silent && 'Без звука · '}{plainText(x.text) || (x.files.length ? `Вложения: ${x.files.length}` : '')}</span>
                  <button className="link-btn" onClick={() => sendScheduledNow(x.id)}>Отправить сейчас</button>
                  <button className="icon-btn icon-btn-xs" aria-label="Отменить отправку" onClick={() => cancelScheduled(x.id)}><Icon name="close" size={14} stroke={2.25} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        {loadingOlder && <div className="loading-older">Загружаем историю…</div>}
        {!messages && <div className="loading-older">Загрузка…</div>}
        {messages && !messages.length && (
          <div className="chat-empty">
            {chat.type === 'group' ? 'Напишите первое сообщение группе' : `Начните переписку с ${peer?.name ?? 'сотрудником'}`}
          </div>
        )}
        {messages?.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const grouped = !newDay && prev && prev.senderId === m.senderId && !['system', 'call'].includes(prev.kind) && m.createdAt - prev.createdAt < 5 * 60000;
          const isLastOwn = m.senderId === meId && !s.hasNewer[chatId] && !messages.slice(i + 1).some((x) => x.senderId === meId && !['system', 'call'].includes(x.kind));
          return (
            <React.Fragment key={m.id}>
              {newDay && <div className="day-sep"><span>{formatDay(m.createdAt)}</span></div>}
              <Message message={m} chat={chat} grouped={grouped} isLastOwn={isLastOwn} observe={m.senderId !== meId ? observe : null} />
            </React.Fragment>
          );
        })}
        {typingNames.length > 0 && (
          <div className="typing">
            {voiceTyping ? <Icon name="mic" size={14} /> : <span className="typing-dots"><i /><i /><i /></span>}
            {typingNames.join(', ')} {voiceTyping ? 'записывает голосовое' : typingNames.length > 1 ? 'печатают' : 'печатает'}
          </div>
        )}
      </div>

      {(!atBottom || s.hasNewer[chatId]) && (
        <button className="to-latest" aria-label="К последним сообщениям" onClick={toLatest}>
          <Icon name="arrowDown" size={20} />
          {unreadBelow > 0 && <span className="badge">{unreadBelow}</span>}
        </button>
      )}

      <Composer chatId={chatId} files={files} setFiles={setFiles} disabled={chat.type === 'direct' && peer && !peer.isActive} />
      {dragOver && <div className="drop-hint">Отпустите, чтобы прикрепить файлы</div>}
    </section>
  );
}

function SearchBar({ chatId, onClose }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults(null); return undefined; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try { setResults(await request('GET', `/api/chats/${chatId}/search?q=${encodeURIComponent(q.trim())}`)); } catch (e) { toast(e.message); }
      setBusy(false);
    }, 300);
    return () => clearTimeout(timer.current);
  }, [q, chatId]);
  return (
    <div className="chat-search">
      <label className="search">
        <Icon name="search" size={18} />
        <input autoFocus type="search" aria-label="Искать в чате" placeholder="Искать в этом чате" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
        {busy && <span className="search-busy">…</span>}
      </label>
      <button className="link-btn" onClick={onClose}>Закрыть</button>
      {results && (
        <div className="search-results">
          {!results.length && <div className="popover-empty">Ничего не найдено</div>}
          {results.map((r) => (
            <button key={r.id} className="search-row" onClick={() => jumpToMessage(chatId, r.id)}>
              <span className="search-meta"><strong>{s.users[r.senderId]?.name ?? 'Сотрудник'}</strong> · {formatDay(r.createdAt).toLowerCase()} в {formatTime(r.createdAt)}</span>
              <span className="search-text">{highlight(plainText(r.text), q.trim())}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  const start = Math.max(0, i - 40);
  return (<>{start ? '…' : ''}{text.slice(start, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length, i + q.length + 120)}</>);
}

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, setState, loadMessages, queueRead, toast } from '../store.js';
import { startCall } from '../calls.js';
import { chatTitle, formatDay, lastSeenText, peerOf } from '../utils.js';
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
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const [, tick] = useState(0);

  // Первая загрузка
  useEffect(() => {
    loadMessages(chatId).catch((e) => toast(e.message));
  }, [chatId]);

  // Обновление «печатает…»
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1500);
    return () => clearInterval(t);
  }, []);

  // Прокрутка вниз при новых сообщениях, если пользователь внизу; сохранение позиции при подгрузке старых
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevHeight.current && loadingOlder === false && el.dataset.restore === '1') {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      el.dataset.restore = '0';
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loadingOlder]);

  const onScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120 && s.hasMore[chatId] && !loadingOlder) {
      setLoadingOlder(true);
      prevHeight.current = el.scrollHeight;
      el.dataset.restore = '1';
      try { await loadMessages(chatId, true); } catch (e) { toast(e.message); }
      setLoadingOlder(false);
    }
  }, [chatId, s.hasMore, loadingOlder]);

  // Отметка о прочтении: сообщение видно на экране И окно приложения активно
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
    // сообщения, отрисованные до создания наблюдателя (чат уже был загружен)
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
  const typingIds = Object.entries(s.typing[chatId] || {}).filter(([, until]) => until > Date.now()).map(([id]) => Number(id));
  const typingNames = typingIds.map((id) => s.users[id]?.name.split(' ')[0]).filter(Boolean);

  const subtitle = chat.type === 'group'
    ? `${chat.members.length} ${plural(chat.members.length, 'участник', 'участника', 'участников')}, ${onlineCount} в сети`
    : [peer?.position, lastSeenText(peer)].filter(Boolean).join(' · ');

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
          <h2>{chatTitle(chat, s.users, meId)}</h2>
          <span className={peer?.online && chat.type === 'direct' ? 'online' : ''}>{subtitle}</span>
        </button>
        {chat.type === 'direct' && peer?.isActive && (
          <>
            <button className="icon-btn" aria-label="Аудиозвонок" title="Аудиозвонок" onClick={() => startCall(peerId, false)}><Icon name="phone" /></button>
            <button className="icon-btn" aria-label="Видеозвонок" title="Видеозвонок" onClick={() => startCall(peerId, true)}><Icon name="video" /></button>
          </>
        )}
        <button className={'icon-btn' + (s.infoOpen ? ' icon-btn-on' : '')} aria-label={chat.type === 'group' ? 'Участники и настройки группы' : 'О сотруднике'} title="Информация" onClick={() => setState({ infoOpen: !s.infoOpen })}>
          <Icon name="info" />
        </button>
      </header>

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
          const grouped = !newDay && prev && prev.senderId === m.senderId && prev.kind === 'text' && m.createdAt - prev.createdAt < 5 * 60000;
          const isLastOwn = m.senderId === meId && !messages.slice(i + 1).some((x) => x.senderId === meId && x.kind === 'text');
          return (
            <React.Fragment key={m.id}>
              {newDay && <div className="day-sep"><span>{formatDay(m.createdAt)}</span></div>}
              <Message message={m} chat={chat} grouped={grouped} isLastOwn={isLastOwn} observe={m.senderId !== meId ? observe : null} />
            </React.Fragment>
          );
        })}
        {typingNames.length > 0 && (
          <div className="typing"><span className="typing-dots"><i /><i /><i /></span>{typingNames.join(', ')} {typingNames.length > 1 ? 'печатают' : 'печатает'}</div>
        )}
      </div>

      <Composer chatId={chatId} files={files} setFiles={setFiles} disabled={chat.type === 'direct' && peer && !peer.isActive} />
      {dragOver && <div className="drop-hint">Отпустите, чтобы прикрепить файлы</div>}
    </section>
  );
}

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

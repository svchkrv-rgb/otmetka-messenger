import React, { useEffect, useState } from 'react';
import { useStore, setState, openModal, request, toast, fileUrl, jumpToMessage } from '../store.js';
import { startChatCall } from '../calls.js';
import { lastSeenText, peerOf, ROLE_NAMES, ROLE_LABELS, formatDay, formatSize, statusText } from '../utils.js';
import { GroupAvatar, UserAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';
import { plural } from './ChatView.jsx';

export default function InfoPanel({ chatId }) {
  const s = useStore();
  const chat = s.chats[chatId];
  const [tab, setTab] = useState('members');
  const [menuFor, setMenuFor] = useState(null);
  if (!chat) return null;
  const meId = s.me.id;
  const close = () => setState({ infoOpen: false });
  const isGroup = chat.type === 'group';
  const peer = !isGroup ? s.users[peerOf(chat, meId)] : null;
  const canManage = chat.myRole === 'owner' || chat.myRole === 'admin';
  const canInvite = isGroup && (canManage || (chat.membersCanAdd && chat.myRole === 'member'));

  async function toggleMute() {
    try {
      const c = await request('PATCH', `/api/chats/${chatId}/mute`, { muted: !chat.muted });
      setState((st) => ({ chats: { ...st.chats, [c.id]: c } }));
      toast(c.muted ? 'Уведомления отключены. Упоминания и важные сообщения всё равно придут.' : 'Уведомления включены');
    } catch (e) { toast(e.message); }
  }
  const openSearch = () => window.dispatchEvent(new CustomEvent('otmetka:search'));

  const members = [...chat.members].sort((a, b) => {
    const order = { owner: 0, admin: 1, member: 2, guest: 3 };
    return order[a.role] - order[b.role] || (s.users[b.userId]?.online ? 1 : 0) - (s.users[a.userId]?.online ? 1 : 0) || (s.users[a.userId]?.name || '').localeCompare(s.users[b.userId]?.name || '', 'ru');
  });

  async function setRole(userId, role) {
    setMenuFor(null);
    try { const c = await request('PATCH', `/api/chats/${chatId}/members/${userId}`, { role }); setState((st) => ({ chats: { ...st.chats, [c.id]: c } })); }
    catch (e) { toast(e.message); }
  }
  async function remove(userId) {
    setMenuFor(null);
    const name = s.users[userId]?.name;
    if (!window.confirm(userId === meId ? 'Покинуть группу? Вернуть вас сможет только администратор группы.' : `Исключить ${name} из группы?`)) return;
    try {
      await request('DELETE', `/api/chats/${chatId}/members/${userId}`);
      if (userId === meId) setState((st) => { const chats = { ...st.chats }; delete chats[chatId]; return { chats, activeChatId: null, infoOpen: false }; });
    } catch (e) { toast(e.message); }
  }

  return (
    <aside className="info" aria-label={isGroup ? 'Группа объекта' : 'О сотруднике'}>
      <div className="info-head">
        <h2>{isGroup ? 'Группа объекта' : 'Сотрудник'}</h2>
        {isGroup && canManage && <button className="icon-btn" aria-label="Настройки группы" title="Настройки группы" onClick={() => openModal('group-edit', { chatId })}><Icon name="edit" size={18} /></button>}
        <button className="icon-btn" aria-label="Закрыть" onClick={close}><Icon name="close" size={16} stroke={2.25} /></button>
      </div>

      <div className="info-scroll">
        <div className="info-hero">
          {isGroup ? <GroupAvatar chat={chat} size={84} /> : <UserAvatar user={peer} size={88} showOnline />}
          <strong>{isGroup ? chat.title : peer?.name}</strong>
          {isGroup ? (
            <>
              <span>{chat.members.length} {plural(chat.members.length, 'участник', 'участника', 'участников')} · создана {formatDay(chat.createdAt).toLowerCase()}</span>
              {chat.address && <span className="info-address"><Icon name="pin" size={14} stroke={2} />{chat.address}</span>}
              <span className="info-rule">{chat.showReceipts ? 'Прочтения видят все участники' : 'Прочтения видит только автор'}{!chat.historyForNew ? ' · история скрыта от новых' : ''}</span>
            </>
          ) : (
            <>
              <span>{[peer?.department, peer?.position].filter(Boolean).join(' · ')}</span>
              {peer?.status && <span className="info-status">{statusText(peer)}</span>}
              <span className={peer?.online ? 'online' : ''}>{lastSeenText(peer)}</span>
              {peer?.isGuest && <span className="tag tag-guest">внешний участник</span>}
            </>
          )}
        </div>

        <div className="info-actions info-actions-4">
          <button onClick={() => startChatCall(chatId, peer?.id, false)} disabled={!isGroup && !peer?.isActive}><Icon name="phone" />Аудио</button>
          <button onClick={() => startChatCall(chatId, peer?.id, true)} disabled={!isGroup && !peer?.isActive}><Icon name="video" />Видео</button>
          <button onClick={toggleMute} aria-pressed={chat.muted} className={chat.muted ? 'on' : ''}><Icon name={chat.muted ? 'bellOff' : 'bell'} />{chat.muted ? 'Без звука' : 'Звук'}</button>
          <button onClick={openSearch}><Icon name="search" />Поиск</button>
        </div>

        <div className="tabs" role="tablist">
          {isGroup && <button role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>Участники · {chat.members.length}</button>}
          <button role="tab" aria-selected={tab === 'media' || (!isGroup && tab === 'members')} className={tab === 'media' || (!isGroup && tab === 'members') ? 'active' : ''} onClick={() => setTab('media')}>Фото и видео</button>
          <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Файлы</button>
        </div>

        {isGroup && tab === 'members' && (
          <div className="info-list">
            {canInvite && (
              <>
                <button className="info-add" onClick={() => openModal('add-members', { chatId })}>
                  <span><Icon name="groupAdd" /></span>Добавить участников
                </button>
                <button className="info-add" onClick={() => openModal('invite', { chatId })}>
                  <span><Icon name="link" /></span>Пригласить по ссылке
                </button>
              </>
            )}
            {members.map((m) => {
              const u = s.users[m.userId];
              const self = m.userId === meId;
              const canTouch = canManage && !self && m.role !== 'owner' && (chat.myRole === 'owner' || m.role !== 'admin');
              return (
                <div key={m.userId} className="member">
                  <UserAvatar user={u} size={40} showOnline />
                  <span className="member-body">
                    <span>{u?.name ?? 'Сотрудник'}{self && <em> · вы</em>}{u?.isGuest && <span className="tag tag-guest">внешний</span>}</span>
                    <small className={u?.online && !u?.status ? 'online' : ''}>{u?.status ? statusText(u) : u?.online ? 'в сети' : lastSeenText(u)}</small>
                  </span>
                  {ROLE_NAMES[m.role] && <span className="member-role">{ROLE_NAMES[m.role]}</span>}
                  {canTouch && (
                    <span className="member-menu">
                      <button className="icon-btn icon-btn-sm" aria-label={`Действия: ${u?.name}`} onClick={() => setMenuFor(menuFor === m.userId ? null : m.userId)}><Icon name="more" size={18} /></button>
                      {menuFor === m.userId && (
                        <div className="menu" role="menu" onMouseLeave={() => setMenuFor(null)}>
                          <div className="menu-head"><strong>Роль в группе</strong><span>сейчас: {ROLE_LABELS[m.role].toLowerCase()}</span></div>
                          {chat.myRole === 'owner' && m.role !== 'admin' && !u?.isGuest && <button role="menuitem" onClick={() => setRole(m.userId, 'admin')}>Администратор</button>}
                          {m.role !== 'member' && !u?.isGuest && <button role="menuitem" onClick={() => setRole(m.userId, 'member')}>Участник</button>}
                          {m.role !== 'guest' && <button role="menuitem" onClick={() => setRole(m.userId, 'guest')}>Гость — без прав добавлять{chat.guestDownload ? '' : ' и скачивать'}</button>}
                          <button role="menuitem" className="danger" onClick={() => remove(m.userId)}>Исключить из группы</button>
                        </div>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {(tab === 'media' || (!isGroup && tab === 'members')) && <MediaTab chatId={chatId} kind="media" />}
        {tab === 'files' && <MediaTab chatId={chatId} kind="files" />}
      </div>

      {isGroup && (
        <div className="info-foot">
          <button className="btn btn-danger-soft btn-block" onClick={() => remove(meId)}>Покинуть группу</button>
        </div>
      )}
    </aside>
  );
}

function MediaTab({ chatId, kind }) {
  const s = useStore();
  const [items, setItems] = useState(null);
  const chat = s.chats[chatId];
  const lastId = chat?.lastMessage?.id;
  useEffect(() => {
    let alive = true;
    request('GET', `/api/chats/${chatId}/attachments?kind=${kind}`).then((r) => alive && setItems(r)).catch((e) => toast(e.message));
    return () => { alive = false; };
  }, [chatId, kind, lastId]);
  const noDownload = chat?.myRole === 'guest' && !chat?.guestDownload;
  if (!items) return <div className="info-empty">Загрузка…</div>;
  if (!items.length) return <div className="info-empty">{kind === 'files' ? 'Файлов пока нет' : 'Фото и видео пока нет'}</div>;
  if (kind === 'files') {
    return (
      <div className="info-list">
        {items.map((a) => (
          <div key={a.id} className="info-file">
            <span className="file-card-icon"><Icon name="file" size={18} /></span>
            <button className="info-file-body" onClick={() => jumpToMessage(chatId, a.messageId)}>
              <span>{a.fileName}</span>
              <small>{formatSize(a.size)} · {s.users[a.senderId]?.name ?? ''} · {formatDay(a.createdAt).toLowerCase()}</small>
            </button>
            {!noDownload && <a className="icon-btn icon-btn-sm" href={fileUrl(a.url, true)} download={a.fileName} aria-label={`Скачать ${a.fileName}`}><Icon name="download" size={18} /></a>}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="info-media">
      {items.map((a) => (a.kind === 'image' ? (
        <button key={a.id} onClick={() => openModal('image', { url: fileUrl(a.url), downloadUrl: noDownload ? null : fileUrl(a.url, true), name: a.fileName })} aria-label={a.fileName}>
          <img src={fileUrl(a.url)} alt={a.fileName} loading="lazy" />
        </button>
      ) : (
        <button key={a.id} className="info-media-video" onClick={() => jumpToMessage(chatId, a.messageId)} aria-label={`Видео ${a.fileName}`}>
          <Icon name="play" size={22} />
        </button>
      )))}
    </div>
  );
}

import React, { useState } from 'react';
import { useStore, setState, openModal, request, toast, fileUrl } from '../store.js';
import { startCall } from '../calls.js';
import { lastSeenText, peerOf, ROLE_NAMES, formatDay } from '../utils.js';
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

  const media = (s.messages[chatId] || []).flatMap((m) => m.attachments.filter((a) => a.kind !== 'file').map((a) => ({ ...a, at: m.createdAt }))).reverse();

  if (chat.type === 'direct') {
    const peer = s.users[peerOf(chat, meId)];
    return (
      <aside className="info" aria-label="О сотруднике">
        <div className="info-head"><h2>Сотрудник</h2><button className="icon-btn" aria-label="Закрыть" onClick={close}><Icon name="close" size={16} stroke={2.25} /></button></div>
        <div className="info-hero">
          <UserAvatar user={peer} size={88} showOnline />
          <strong>{peer?.name}</strong>
          <span>{peer?.position}</span>
          <span className={peer?.online ? 'online' : ''}>{lastSeenText(peer)}</span>
        </div>
        {peer?.isActive && (
          <div className="info-actions">
            <button onClick={() => startCall(peer.id, false)}><Icon name="phone" />Аудио</button>
            <button onClick={() => startCall(peer.id, true)}><Icon name="video" />Видео</button>
          </div>
        )}
        <MediaGrid media={media} />
      </aside>
    );
  }

  const canManage = chat.myRole === 'owner' || chat.myRole === 'admin';
  const members = [...chat.members].sort((a, b) => {
    const order = { owner: 0, admin: 1, member: 2 };
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
    <aside className="info" aria-label="Группа объекта">
      <div className="info-head">
        <h2>Группа объекта</h2>
        {canManage && <button className="icon-btn" aria-label="Настройки группы" title="Настройки группы" onClick={() => openModal('group-edit', { chatId })}><Icon name="edit" size={18} /></button>}
        <button className="icon-btn" aria-label="Закрыть" onClick={close}><Icon name="close" size={16} stroke={2.25} /></button>
      </div>
      <div className="info-hero">
        <GroupAvatar chat={chat} size={84} />
        <strong>{chat.title}</strong>
        <span>{chat.members.length} {plural(chat.members.length, 'участник', 'участника', 'участников')} · создана {formatDay(chat.createdAt).toLowerCase()}</span>
        {chat.address && <span className="info-address"><Icon name="pin" size={14} stroke={2} />{chat.address}</span>}
        <span className="info-rule">{chat.showReceipts ? 'Прочтения видят все участники' : 'Прочтения видит только автор'}</span>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>Участники · {chat.members.length}</button>
        <button role="tab" aria-selected={tab === 'media'} className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>Фото и видео · {media.length}</button>
      </div>

      {tab === 'members' ? (
        <div className="info-list">
          {canManage && (
            <button className="info-add" onClick={() => openModal('add-members', { chatId })}>
              <span><Icon name="groupAdd" /></span>Добавить участников
            </button>
          )}
          {members.map((m) => {
            const u = s.users[m.userId];
            const self = m.userId === meId;
            const canTouch = canManage && !self && m.role !== 'owner' && (chat.myRole === 'owner' || m.role === 'member');
            return (
              <div key={m.userId} className="member">
                <UserAvatar user={u} size={40} showOnline />
                <span className="member-body">
                  <span>{u?.name ?? 'Сотрудник'}{self && <em> · вы</em>}</span>
                  <small className={u?.online ? 'online' : ''}>{u?.online ? 'в сети' : lastSeenText(u)}</small>
                </span>
                {ROLE_NAMES[m.role] && <span className="member-role">{ROLE_NAMES[m.role]}</span>}
                {canTouch && (
                  <span className="member-menu">
                    <button className="icon-btn icon-btn-sm" aria-label={`Действия: ${u?.name}`} onClick={() => setMenuFor(menuFor === m.userId ? null : m.userId)}><Icon name="more" size={18} /></button>
                    {menuFor === m.userId && (
                      <div className="menu" role="menu" onMouseLeave={() => setMenuFor(null)}>
                        {chat.myRole === 'owner' && (m.role === 'member'
                          ? <button role="menuitem" onClick={() => setRole(m.userId, 'admin')}>Сделать администратором</button>
                          : <button role="menuitem" onClick={() => setRole(m.userId, 'member')}>Снять права администратора</button>)}
                        <button role="menuitem" className="danger" onClick={() => remove(m.userId)}>Исключить из группы</button>
                      </div>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : <MediaGrid media={media} />}

      <div className="info-foot">
        <button className="btn btn-danger-soft btn-block" onClick={() => remove(meId)}>Покинуть группу</button>
      </div>
    </aside>
  );
}

function MediaGrid({ media }) {
  if (!media.length) return <div className="info-empty">Фото и видео из загруженной части переписки появятся здесь</div>;
  return (
    <div className="info-media">
      {media.map((a) => (a.kind === 'image' ? (
        <button key={a.id} onClick={() => openModal('image', { url: fileUrl(a.url), downloadUrl: fileUrl(a.url, true), name: a.fileName })} aria-label={a.fileName}>
          <img src={fileUrl(a.url)} alt={a.fileName} loading="lazy" />
        </button>
      ) : (
        <a key={a.id} href={fileUrl(a.url)} target="_blank" rel="noreferrer" className="info-media-video" aria-label={a.fileName}>
          <Icon name="play" size={22} />
        </a>
      )))}
    </div>
  );
}

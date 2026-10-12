import React, { useMemo, useState } from 'react';
import { useStore, setState, openChat, openDirect, openModal, logout, toast } from '../store.js';
import { startCall } from '../calls.js';
import { chatTitle, formatListTime, previewText, lastSeenText, peerOf } from '../utils.js';
import { ChatAvatar, UserAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'group', label: 'Объекты' },
  { id: 'direct', label: 'Личные' },
  { id: 'unread', label: 'Непрочитанные' },
];

export default function Sidebar() {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [menu, setMenu] = useState(false);

  return (
    <aside className="sidebar" aria-label="Навигация">
      <div className="sidebar-head">
        <span className="brand-mark">±0.0</span>
        <h1>{s.view === 'chats' ? 'Чаты' : 'Сотрудники'}</h1>
        {s.view === 'chats' ? (
          <button className="icon-btn icon-btn-soft" aria-label="Новая группа объекта" title="Новая группа объекта" onClick={() => openModal('group-new')}>
            <Icon name="groupAdd" />
          </button>
        ) : s.me.isAdmin ? (
          <button className="icon-btn icon-btn-soft" aria-label="Добавить сотрудника" title="Добавить сотрудника" onClick={() => openModal('user-new')}>
            <Icon name="userPlus" />
          </button>
        ) : null}
      </div>

      <div className="sidebar-search">
        <label className="search">
          <Icon name="search" size={18} />
          <input type="search" aria-label="Поиск" placeholder={s.view === 'chats' ? 'Поиск по чатам' : 'Имя или должность'} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {s.connection !== 'online' && (
        <div className="conn-banner"><Icon name="wifiOff" size={16} />{s.connection === 'connecting' ? 'Подключение…' : 'Нет связи с сервером, переподключаемся'}</div>
      )}

      {s.view === 'chats' ? (
        <>
          <div className="chips" role="tablist" aria-label="Фильтр чатов">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={'chip' + (filter === f.id ? ' chip-active' : '')} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          <ChatList query={query} filter={filter} />
        </>
      ) : (
        <PeopleList query={query} />
      )}

      <nav className="bottom-nav" aria-label="Разделы">
        <button className={'nav-item' + (s.view === 'chats' ? ' nav-active' : '')} onClick={() => setState({ view: 'chats' })}>
          <Icon name="chat" size={22} />Чаты
          {totalUnread(s.chats) > 0 && <span className="nav-badge">{totalUnread(s.chats)}</span>}
        </button>
        <button className={'nav-item' + (s.view === 'people' ? ' nav-active' : '')} onClick={() => setState({ view: 'people' })}>
          <Icon name="people" size={22} />Сотрудники
        </button>
        <div className="nav-profile">
          <button className="nav-item" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <UserAvatar user={s.me} size={26} />Профиль
          </button>
          {menu && (
            <div className="menu menu-up" role="menu" onMouseLeave={() => setMenu(false)}>
              <div className="menu-head">
                <strong>{s.me.name}</strong>
                <span>{s.me.position || s.me.login}</span>
              </div>
              <button role="menuitem" onClick={() => { setMenu(false); openModal('password'); }}><Icon name="key" size={18} />Сменить пароль</button>
              <button role="menuitem" className="danger" onClick={() => { setMenu(false); logout(); }}><Icon name="logout" size={18} />Выйти</button>
            </div>
          )}
        </div>
      </nav>
    </aside>
  );
}

const totalUnread = (chats) => Object.values(chats).reduce((n, c) => n + (c.unread || 0), 0);

function ChatList({ query, filter }) {
  const s = useStore();
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(s.chats)
      .filter((c) => (filter === 'all' ? true : filter === 'unread' ? c.unread > 0 : c.type === filter))
      .filter((c) => !q || chatTitle(c, s.users, s.me.id).toLowerCase().includes(q))
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt));
  }, [s.chats, s.users, query, filter, s.me.id]);

  if (!list.length) {
    return (
      <div className="list-empty">
        {Object.keys(s.chats).length ? 'Ничего не найдено' : (
          <>
            <p>Чатов пока нет.</p>
            <button className="btn btn-primary" onClick={() => openModal('group-new')}>Создать группу объекта</button>
            <button className="link-btn" onClick={() => setState({ view: 'people' })}>Написать сотруднику</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="chat-list">
      {list.map((c) => {
        const last = c.lastMessage;
        const mine = last && last.senderId === s.me.id && last.kind === 'text';
        const sender = last && c.type === 'group' && !mine && last.kind === 'text' ? (s.users[last.senderId]?.name.split(' ')[0] ?? '') : '';
        const readByAll = mine && isReadByAll(last, c, s.me.id);
        const readBySome = mine && last.receipts?.length > 0;
        const typingUsers = Object.entries(s.typing[c.id] || {}).filter(([, until]) => until > Date.now());
        return (
          <button key={c.id} className={'chat-item' + (s.activeChatId === c.id ? ' chat-item-active' : '')} onClick={() => openChat(c.id)}>
            <ChatAvatar chat={c} users={s.users} meId={s.me.id} size={48} ring={s.activeChatId === c.id ? '#EDF1F6' : '#FFFFFF'} />
            <span className="chat-item-body">
              <span className="chat-item-top">
                <span className="chat-item-title">{chatTitle(c, s.users, s.me.id)}</span>
                <span className="chat-item-time">{last ? formatListTime(last.createdAt) : ''}</span>
              </span>
              <span className="chat-item-bottom">
                {typingUsers.length ? (
                  <span className="chat-item-preview typing-text">печатает…</span>
                ) : (
                  <span className="chat-item-preview">
                    {mine && <span className={'ticks' + (readByAll ? ' ticks-read' : '')}>{readBySome ? '✓✓' : '✓'}</span>}
                    {mine ? 'Вы: ' : sender ? `${sender}: ` : ''}{previewText(last, s.users, s.me.id) || (c.type === 'group' ? 'Группа создана' : 'Нет сообщений')}
                  </span>
                )}
                {c.unread > 0 && <span className="badge">{c.unread > 99 ? '99+' : c.unread}</span>}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function isReadByAll(m, chat, meId) {
  const others = chat.members.filter((x) => x.userId !== meId).length;
  return others > 0 && (m.receipts?.length || 0) >= others;
}

function PeopleList({ query }) {
  const s = useStore();
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(s.users)
      .filter((u) => u.id !== s.me.id)
      .filter((u) => !q || u.name.toLowerCase().includes(q) || (u.position || '').toLowerCase().includes(q))
      .sort((a, b) => (b.online - a.online) || (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1) || a.name.localeCompare(b.name, 'ru'));
  }, [s.users, query, s.me.id]);

  async function write(u) {
    try { await openDirect(u.id); } catch (e) { toast(e.message); }
  }

  if (!list.length) {
    return (
      <div className="list-empty">
        {query ? 'Никого не нашли' : (
          <>
            <p>Других сотрудников пока нет.</p>
            {s.me.isAdmin && <button className="btn btn-primary" onClick={() => openModal('user-new')}>Добавить сотрудника</button>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="chat-list">
      {list.map((u) => (
        <div key={u.id} className={'person' + (u.isActive ? '' : ' person-off')}>
          <button className="person-main" onClick={() => u.isActive && write(u)} disabled={!u.isActive}>
            <UserAvatar user={u} size={44} showOnline />
            <span className="chat-item-body">
              <span className="chat-item-title">{u.name}{u.isAdmin && <span className="tag">админ</span>}{!u.isActive && <span className="tag tag-off">отключён</span>}</span>
              <span className={'person-sub' + (u.online ? ' online' : '')}>{u.position ? `${u.position} · ` : ''}{lastSeenText(u)}</span>
            </span>
          </button>
          {u.isActive && (
            <span className="person-actions">
              <button className="icon-btn" aria-label={`Аудиозвонок: ${u.name}`} title="Аудиозвонок" onClick={() => startCall(u.id, false)}><Icon name="phone" size={18} /></button>
              <button className="icon-btn" aria-label={`Видеозвонок: ${u.name}`} title="Видеозвонок" onClick={() => startCall(u.id, true)}><Icon name="video" size={18} /></button>
            </span>
          )}
          {s.me.isAdmin && (
            <button className="icon-btn" aria-label={`Управление: ${u.name}`} title="Управление" onClick={() => openModal('user-edit', { userId: u.id })}><Icon name="more" size={18} /></button>
          )}
        </div>
      ))}
    </div>
  );
}

export { peerOf };

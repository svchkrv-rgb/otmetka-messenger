import React, { useEffect, useMemo, useState } from 'react';
import { useStore, closeModal, request, setState, toast, getState } from '../store.js';
import { GROUP_COLORS, initials } from '../utils.js';
import { UserAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';

export default function Modals() {
  const { modal } = useStore();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  if (!modal) return null;
  const C = {
    'group-new': GroupDialog,
    'group-edit': GroupDialog,
    'add-members': AddMembersDialog,
    password: PasswordDialog,
    'user-new': UserDialog,
    'user-edit': UserDialog,
    image: ImageViewer,
  }[modal.type];
  return C ? <C {...modal} /> : null;
}

function Dialog({ title, children, footer, width = 560 }) {
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn icon-btn-soft" aria-label="Закрыть" onClick={closeModal}><Icon name="close" size={16} stroke={2.25} /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, label, hint }) {
  return (
    <div className="switch-row">
      <span><span>{label}</span>{hint && <small>{hint}</small>}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={'switch' + (checked ? ' switch-on' : '')} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </div>
  );
}

export function MemberPicker({ selected, setSelected, exclude = [] }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const list = useMemo(() => Object.values(s.users)
    .filter((u) => u.isActive && u.id !== s.me.id && !exclude.includes(u.id))
    .filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || (u.position || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru')), [s.users, q, exclude, s.me.id]);
  const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="picker">
      <label className="search">
        <Icon name="search" size={18} />
        <input type="search" aria-label="Поиск сотрудника" placeholder="Имя или должность" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="picker-list">
        {list.length ? list.map((u) => (
          <label key={u.id} className="picker-row">
            <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
            <UserAvatar user={u} size={34} showOnline />
            <span className="picker-name"><span>{u.name}</span><small>{u.position}</small></span>
          </label>
        )) : <div className="picker-empty">{q ? 'Никого не нашли' : 'Нет сотрудников для добавления. Администратор может добавить их в разделе «Сотрудники».'}</div>}
      </div>
    </div>
  );
}

function GroupDialog({ type, chatId }) {
  const s = useStore();
  const edit = type === 'group-edit';
  const chat = edit ? s.chats[chatId] : null;
  const [title, setTitle] = useState(chat?.title || '');
  const [address, setAddress] = useState(chat?.address || '');
  const [color, setColor] = useState(chat?.color || GROUP_COLORS[0]);
  const [showReceipts, setShowReceipts] = useState(chat ? chat.showReceipts : true);
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e?.preventDefault();
    if (!title.trim()) { setError('Укажите название группы'); return; }
    setBusy(true);
    setError('');
    try {
      if (edit) {
        const updated = await request('PATCH', `/api/chats/${chatId}`, { title, address, color, showReceipts });
        setState((st) => ({ chats: { ...st.chats, [updated.id]: updated } }));
      } else {
        const created = await request('POST', '/api/chats/group', { title, address, color, showReceipts, memberIds: members });
        setState((st) => ({ chats: { ...st.chats, [created.id]: created }, activeChatId: created.id, view: 'chats', infoOpen: false }));
      }
      closeModal();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={edit ? 'Настройки группы' : 'Новая группа объекта'} width={620}
      footer={<>
        <button className="btn btn-soft" onClick={closeModal}>Отмена</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{edit ? 'Сохранить' : `Создать группу${members.length ? ` · ${members.length + 1}` : ''}`}</button>
      </>}>
      <form onSubmit={save} className="form-grid">
        <div className="group-ident">
          <div className="group-ident-avatar">
            <span className="avatar" style={{ width: 72, height: 72, borderRadius: 20, background: color, fontSize: 24 }}>{initials(title || 'Объект')}</span>
            <div className="swatches" role="radiogroup" aria-label="Цвет группы">
              {GROUP_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Цвет ${c}`} className={'swatch' + (color === c ? ' swatch-on' : '')} style={{ background: c, '--sw': c }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
          <div className="group-ident-fields">
            <label className="field">
              <span>Название группы</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, ЖК «Северный квартал» · Корпус 2" autoFocus maxLength={80} />
            </label>
            <label className="field">
              <span>Адрес объекта <em>— необязательно</em></span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Город, улица, участок" maxLength={160} />
            </label>
          </div>
        </div>

        {!edit && (
          <section>
            <h3 className="section-title">Участники <span>{members.length ? `${members.length} выбрано` : 'вы будете владельцем'}</span></h3>
            <MemberPicker selected={members} setSelected={setMembers} />
          </section>
        )}

        <section>
          <h3 className="section-title">Правила группы</h3>
          <Switch checked={showReceipts} onChange={setShowReceipts} label="Показывать всем, кто и когда прочитал"
            hint={showReceipts ? 'Время прочтения видят все участники' : 'Время прочтения видит только автор сообщения'} />
        </section>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

function AddMembersDialog({ chatId }) {
  const s = useStore();
  const chat = s.chats[chatId];
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const exclude = useMemo(() => chat?.members.map((m) => m.userId) ?? [], [chat]);
  async function add() {
    setBusy(true);
    try {
      const updated = await request('POST', `/api/chats/${chatId}/members`, { userIds: selected });
      setState((st) => ({ chats: { ...st.chats, [updated.id]: updated } }));
      closeModal();
    } catch (e) {
      toast(e.message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="Добавить участников" width={520}
      footer={<>
        <button className="btn btn-soft" onClick={closeModal}>Отмена</button>
        <button className="btn btn-primary" onClick={add} disabled={busy || !selected.length}>Добавить{selected.length ? ` · ${selected.length}` : ''}</button>
      </>}>
      <MemberPicker selected={selected} setSelected={setSelected} exclude={exclude} />
    </Dialog>
  );
}

function PasswordDialog() {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState('');
  async function save(e) {
    e?.preventDefault();
    setError('');
    try {
      await request('POST', '/api/me/password', { oldPassword, newPassword });
      toast('Пароль изменён');
      closeModal();
    } catch (err) { setError(err.message); }
  }
  return (
    <Dialog title="Смена пароля" width={420}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Отмена</button><button className="btn btn-primary" onClick={save}>Сохранить</button></>}>
      <form onSubmit={save} className="form-grid">
        <label className="field"><span>Текущий пароль</span><input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoFocus autoComplete="current-password" /></label>
        <label className="field"><span>Новый пароль <em>— не короче 6 символов</em></span><input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function UserDialog({ type, userId }) {
  const s = useStore();
  const edit = type === 'user-edit';
  const u = edit ? s.users[userId] : null;
  const [login, setLogin] = useState('');
  const [name, setName] = useState(u?.name || '');
  const [position, setPosition] = useState(u?.position || '');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(u?.isAdmin || false);
  const [isActive, setIsActive] = useState(u ? u.isActive : true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const self = u?.id === s.me.id;

  async function save(e) {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      let saved;
      if (edit) {
        const body = { name, position, isAdmin, isActive };
        if (password) body.password = password;
        saved = await request('PATCH', `/api/users/${userId}`, body);
        toast('Изменения сохранены');
      } else {
        saved = await request('POST', '/api/users', { login, name, position, password, isAdmin });
        toast(`Сотрудник добавлен. Передайте ему логин «${login}» и пароль.`);
      }
      setState((st) => ({ users: { ...st.users, [saved.id]: saved } }));
      closeModal();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={edit ? 'Сотрудник' : 'Новый сотрудник'} width={460}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Отмена</button><button className="btn btn-primary" onClick={save} disabled={busy}>{edit ? 'Сохранить' : 'Добавить'}</button></>}>
      <form onSubmit={save} className="form-grid">
        {edit ? (
          <div className="user-head"><UserAvatar user={u} size={48} /><span><strong>{u?.login}</strong><small>логин для входа</small></span></div>
        ) : (
          <label className="field"><span>Логин для входа</span><input value={login} onChange={(e) => setLogin(e.target.value)} autoFocus placeholder="например, ivanov" autoComplete="off" /></label>
        )}
        <label className="field"><span>Имя и фамилия</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ольга Ким" /></label>
        <label className="field"><span>Должность</span><input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Архитектор" /></label>
        <label className="field"><span>{edit ? 'Новый пароль' : 'Пароль'} <em>{edit ? '— оставьте пустым, чтобы не менять' : '— не короче 6 символов'}</em></span>
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <Switch checked={isAdmin} onChange={setIsAdmin} label="Администратор" hint="Может добавлять и отключать сотрудников" />
        {edit && !self && <Switch checked={isActive} onChange={setIsActive} label="Доступ разрешён" hint={isActive ? 'Сотрудник может входить' : 'Вход закрыт, сессии завершены'} />}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function ImageViewer({ url, downloadUrl, name }) {
  return (
    <div className="viewer" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }} role="dialog" aria-label={name}>
      <div className="viewer-bar">
        <span>{name}</span>
        <a className="icon-btn icon-btn-dark" href={downloadUrl} download={name} aria-label="Скачать"><Icon name="download" /></a>
        <button className="icon-btn icon-btn-dark" aria-label="Закрыть" onClick={closeModal}><Icon name="close" /></button>
      </div>
      <img src={url} alt={name} onMouseDown={(e) => e.stopPropagation()} />
    </div>
  );
}

export { getState };

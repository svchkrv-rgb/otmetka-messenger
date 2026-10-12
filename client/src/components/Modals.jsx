import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, closeModal, request, setState, toast, getState, createPoll, createTask, sendLocation, sendContact, avatarUrl } from '../store.js';
import { GROUP_COLORS, initials, formatDuration } from '../utils.js';
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
    invite: InviteDialog,
    profile: ProfileDialog,
    poll: PollDialog,
    task: TaskDialog,
    camera: CameraDialog,
    location: LocationDialog,
    contact: ContactDialog,
    schedule: ScheduleDialog,
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

export function MemberPicker({ selected, setSelected, exclude = [], roles, setRoles }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const candidates = useMemo(() => Object.values(s.users)
    .filter((u) => u.isActive && u.id !== s.me.id && !exclude.includes(u.id)), [s.users, exclude, s.me.id]);
  const list = useMemo(() => candidates
    .filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || (u.position || '').toLowerCase().includes(q.toLowerCase()) || (u.department || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru')), [candidates, q]);
  const departments = useMemo(() => {
    const map = new Map();
    for (const u of candidates) if (u.department) map.set(u.department, [...(map.get(u.department) || []), u.id]);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  }, [candidates]);
  const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const addDept = (ids) => setSelected([...new Set([...selected, ...ids])]);
  return (
    <div className="picker">
      <label className="search">
        <Icon name="search" size={18} />
        <input type="search" aria-label="Поиск сотрудника" placeholder="Имя, должность или отдел" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {departments.length > 0 && (
        <div className="dept-chips">
          {departments.map(([name, ids]) => {
            const all = ids.every((id) => selected.includes(id));
            return (
              <button key={name} type="button" className={'chip chip-line' + (all ? ' chip-active' : '')} onClick={() => (all ? setSelected(selected.filter((id) => !ids.includes(id))) : addDept(ids))}>
                {all ? '✓ ' : '+ '}Весь отдел {name} · {ids.length}
              </button>
            );
          })}
        </div>
      )}
      <div className="picker-list">
        {list.length ? list.map((u) => {
          const on = selected.includes(u.id);
          return (
            <div key={u.id} className={'picker-row' + (on ? ' picker-row-on' : '')}>
              <label className="picker-main">
                <input type="checkbox" checked={on} onChange={() => toggle(u.id)} />
                <UserAvatar user={u} size={34} showOnline />
                <span className="picker-name">
                  <span>{u.name}{u.isGuest && <span className="tag tag-guest">внешний</span>}</span>
                  <small>{[u.department, u.position].filter(Boolean).join(' · ')}</small>
                </span>
              </label>
              {on && roles && (
                <select className="role-select" aria-label={`Роль: ${u.name}`} value={u.isGuest ? 'guest' : (roles[u.id] || 'member')} disabled={u.isGuest}
                  onChange={(e) => setRoles({ ...roles, [u.id]: e.target.value })}>
                  <option value="admin">Администратор</option>
                  <option value="member">Участник</option>
                  <option value="guest">Гость</option>
                </select>
              )}
            </div>
          );
        }) : <div className="picker-empty">{q ? 'Никого не нашли' : 'Нет сотрудников для добавления. Администратор может добавить их в разделе «Сотрудники».'}</div>}
      </div>
    </div>
  );
}

function AvatarPicker({ src, onFile, onRemove, children }) {
  const ref = useRef(null);
  return (
    <div className="avatar-picker">
      <button type="button" className="avatar-picker-btn" onClick={() => ref.current?.click()} aria-label="Выбрать фото">
        {children}
        <span className="avatar-picker-overlay"><Icon name="camera" size={20} /></span>
      </button>
      <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {src && onRemove && <button type="button" className="link-btn" onClick={onRemove}>Убрать фото</button>}
    </div>
  );
}

async function uploadAvatar(path, file) {
  const fd = new FormData();
  if (file) fd.append('avatar', file); else fd.append('remove', 'true');
  return request('POST', path, fd);
}

function GroupDialog({ type, chatId }) {
  const s = useStore();
  const edit = type === 'group-edit';
  const chat = edit ? s.chats[chatId] : null;
  const [title, setTitle] = useState(chat?.title || '');
  const [address, setAddress] = useState(chat?.address || '');
  const [color, setColor] = useState(chat?.color || GROUP_COLORS[0]);
  const [photo, setPhoto] = useState(null);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  const [showReceipts, setShowReceipts] = useState(chat ? chat.showReceipts : true);
  const [historyForNew, setHistoryForNew] = useState(chat ? chat.historyForNew : true);
  const [onlyAdminsAdd, setOnlyAdminsAdd] = useState(chat ? !chat.membersCanAdd : true);
  const [guestDownload, setGuestDownload] = useState(chat ? chat.guestDownload : false);
  const [members, setMembers] = useState([]);
  const [roles, setRoles] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e?.preventDefault();
    if (!title.trim()) { setError('Укажите название группы'); return; }
    setBusy(true);
    setError('');
    const rules = { showReceipts, historyForNew, membersCanAdd: !onlyAdminsAdd, guestDownload };
    try {
      let result;
      if (edit) {
        result = await request('PATCH', `/api/chats/${chatId}`, { title, address, color, ...rules });
      } else {
        result = await request('POST', '/api/chats/group', { title, address, color, ...rules, members: members.map((id) => ({ userId: id, role: roles[id] || 'member' })) });
      }
      if (photo) result = await uploadAvatar(`/api/chats/${result.id}/avatar`, photo);
      setState((st) => ({ chats: { ...st.chats, [result.id]: result }, ...(edit ? {} : { activeChatId: result.id, view: 'chats', infoOpen: false }) }));
      closeModal();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  async function removePhoto() {
    try { const r = await uploadAvatar(`/api/chats/${chatId}/avatar`, null); setState((st) => ({ chats: { ...st.chats, [r.id]: r } })); } catch (err) { setError(err.message); }
  }

  const shownAvatar = photoUrl || avatarUrl(chat?.avatar);
  return (
    <Dialog title={edit ? 'Настройки группы' : 'Новая группа объекта'} width={680}
      footer={<>
        <button className="btn btn-soft" onClick={closeModal}>Отмена</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{edit ? 'Сохранить' : `Создать группу${members.length ? ` · ${members.length + 1}` : ''}`}</button>
      </>}>
      <form onSubmit={save} className="form-grid">
        <div className="group-ident">
          <div className="group-ident-avatar">
            <AvatarPicker src={chat?.avatar && !photo} onFile={setPhoto} onRemove={edit && chat?.avatar && !photo ? removePhoto : null}>
              <span className="avatar" style={{ width: 76, height: 76, borderRadius: 20, background: color, fontSize: 24 }}>
                {initials(title || 'Объект')}
                {shownAvatar && <img className="avatar-img" src={shownAvatar} alt="" />}
              </span>
            </AvatarPicker>
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
            <h3 className="section-title">Участники <span>{members.length ? `${members.length} выбрано · вы — владелец` : 'вы будете владельцем'}</span></h3>
            <MemberPicker selected={members} setSelected={setMembers} roles={roles} setRoles={setRoles} />
          </section>
        )}

        <section>
          <h3 className="section-title">Правила группы</h3>
          <Switch checked={showReceipts} onChange={setShowReceipts} label="Показывать всем, кто и когда прочитал"
            hint={showReceipts ? 'Время прочтения видят все участники' : 'Время прочтения видит только автор сообщения'} />
          <Switch checked={historyForNew} onChange={setHistoryForNew} label="Новые участники видят историю" hint="Фото, видео и переписка с начала работ по объекту" />
          <Switch checked={onlyAdminsAdd} onChange={setOnlyAdminsAdd} label="Добавлять людей могут только администраторы" />
          <Switch checked={guestDownload} onChange={setGuestDownload} label="Гости могут скачивать фото, видео и файлы" hint="Смотреть в приложении гости могут в любом случае" />
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
  const [roles, setRoles] = useState({});
  const [busy, setBusy] = useState(false);
  const exclude = useMemo(() => chat?.members.map((m) => m.userId) ?? [], [chat]);
  const manager = chat?.myRole === 'owner' || chat?.myRole === 'admin';
  async function add() {
    setBusy(true);
    try {
      const updated = await request('POST', `/api/chats/${chatId}/members`, { members: selected.map((id) => ({ userId: id, role: roles[id] || 'member' })) });
      setState((st) => ({ chats: { ...st.chats, [updated.id]: updated } }));
      closeModal();
    } catch (e) {
      toast(e.message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="Добавить участников" width={560}
      footer={<>
        <button className="btn btn-soft" onClick={closeModal}>Отмена</button>
        <button className="btn btn-primary" onClick={add} disabled={busy || !selected.length}>Добавить{selected.length ? ` · ${selected.length}` : ''}</button>
      </>}>
      <MemberPicker selected={selected} setSelected={setSelected} exclude={exclude} roles={manager ? roles : null} setRoles={setRoles} />
    </Dialog>
  );
}

function InviteDialog({ chatId }) {
  const s = useStore();
  const chat = s.chats[chatId];
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);
  async function create() {
    setError('');
    try {
      const r = await request('POST', `/api/chats/${chatId}/invites`, { days });
      // для браузера предпочтительнее HTTPS-адрес сервера
      const base = s.serverUrl.replace(/^http:\/\/([^/:]+):8080$/, 'https://$1:8443');
      setLink({ url: base + r.path, expiresAt: r.expiresAt });
    } catch (e) { setError(e.message); }
  }
  function copy() {
    navigator.clipboard?.writeText(link.url).then(() => toast('Ссылка скопирована')).catch(() => toast('Скопируйте ссылку вручную'));
  }
  return (
    <Dialog title="Пригласить по ссылке" width={520}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Закрыть</button>{link ? <button className="btn btn-primary" onClick={copy}><Icon name="copy" size={18} />Копировать ссылку</button> : <button className="btn btn-primary" onClick={create}>Создать ссылку</button>}</>}>
      <div className="form-grid">
        <p className="muted" style={{ margin: 0 }}>По ссылке человек со стороны — заказчик, прораб подрядчика — сам заведёт себе учётную запись и попадёт в группу «{chat?.title}» как <strong>гость</strong>: видит только эту группу и её участников, не может создавать группы.</p>
        {!link ? (
          <label className="field"><span>Срок действия ссылки</span>
            <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>1 день</option><option value={7}>7 дней</option><option value={30}>30 дней</option>
            </select>
          </label>
        ) : (
          <div className="invite-link">
            <input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Ссылка-приглашение" />
            <small className="muted">Действует до {new Date(link.expiresAt).toLocaleDateString('ru-RU')}. Откройте в браузере; потребуется подтвердить предупреждение о сертификате.</small>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    </Dialog>
  );
}

const STATUS_PRESETS = ['На объекте', 'На совещании', 'В командировке', 'В отпуске', 'На больничном', 'Работаю из дома'];

function ProfileDialog() {
  const s = useStore();
  const me = s.me;
  const [statusText, setStatusText] = useState(me.status?.text || '');
  const [until, setUntil] = useState(me.status?.until ? new Date(me.status.until).toISOString().slice(0, 10) : '');
  const [position, setPosition] = useState(me.position || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function setAvatar(file) {
    try { const u = await uploadAvatar('/api/me/avatar', file); setState((st) => ({ me: { ...st.me, ...u }, users: { ...st.users, [u.id]: u } })); } catch (e) { setError(e.message); }
  }
  async function save() {
    setBusy(true);
    try {
      const untilTs = until ? new Date(`${until}T23:59:00`).getTime() : null;
      const u = await request('PATCH', '/api/me', { statusText: statusText.trim(), statusUntil: untilTs, position });
      setState((st) => ({ me: { ...st.me, ...u }, users: { ...st.users, [u.id]: u } }));
      closeModal();
    } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <Dialog title="Мой профиль" width={480}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Отмена</button><button className="btn btn-primary" onClick={save} disabled={busy}>Сохранить</button></>}>
      <div className="form-grid">
        <div className="profile-head">
          <AvatarPicker src={me.avatar} onFile={setAvatar} onRemove={me.avatar ? () => setAvatar(null) : null}>
            <UserAvatar user={me} size={76} />
          </AvatarPicker>
          <div><strong>{me.name}</strong><small className="muted">{me.login}{me.department ? ` · ${me.department}` : ''}</small></div>
        </div>
        <label className="field"><span>Должность</span><input value={position} onChange={(e) => setPosition(e.target.value)} maxLength={80} /></label>
        <div className="field">
          <span>Статус <em>— видят все коллеги</em></span>
          <div className="dept-chips">
            {STATUS_PRESETS.map((p) => <button key={p} type="button" className={'chip chip-line' + (statusText === p ? ' chip-active' : '')} onClick={() => setStatusText(statusText === p ? '' : p)}>{p}</button>)}
          </div>
          <input value={statusText} onChange={(e) => setStatusText(e.target.value)} placeholder="Например: на объекте до 15:00" maxLength={80} />
        </div>
        {statusText && (
          <label className="field"><span>До какого числа <em>— статус снимется сам</em></span>
            <div className="due-row">
              <input type="date" className="date-input" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="До какого числа" />
              {until && <button type="button" className="link-btn" onClick={() => setUntil('')}>Без срока</button>}
            </div>
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
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
  const [department, setDepartment] = useState(u?.department || '');
  const [isGuest, setIsGuest] = useState(u?.isGuest || false);
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
        const body = { name, position, department, isAdmin: isAdmin && !isGuest, isActive, isGuest };
        if (password) body.password = password;
        saved = await request('PATCH', `/api/users/${userId}`, body);
        toast('Изменения сохранены');
      } else {
        saved = await request('POST', '/api/users', { login, name, position, department, password, isAdmin: isAdmin && !isGuest, isGuest });
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
        <div className="field-row">
          <label className="field"><span>Должность</span><input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Архитектор" /></label>
          <label className="field"><span>Отдел</span><input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="АР" list="departments" /></label>
        </div>
        <datalist id="departments">{[...new Set(Object.values(s.users).map((x) => x.department).filter(Boolean))].map((d) => <option key={d} value={d} />)}</datalist>
        <label className="field"><span>{edit ? 'Новый пароль' : 'Пароль'} <em>{edit ? '— оставьте пустым, чтобы не менять' : '— не короче 6 символов'}</em></span>
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <Switch checked={isGuest} onChange={(v) => { setIsGuest(v); if (v) setIsAdmin(false); }} label="Внешний участник (гость)" hint="Заказчик или подрядчик: видит только свои группы и их участников" />
        {!isGuest && <Switch checked={isAdmin} onChange={setIsAdmin} label="Администратор" hint="Может добавлять и отключать сотрудников" />}
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
        {downloadUrl && <a className="icon-btn icon-btn-dark" href={downloadUrl} download={name} aria-label="Скачать"><Icon name="download" /></a>}
        <button className="icon-btn icon-btn-dark" aria-label="Закрыть" onClick={closeModal}><Icon name="close" /></button>
      </div>
      <img src={url} alt={name} onMouseDown={(e) => e.stopPropagation()} />
    </div>
  );
}

// ---------- Опрос ----------
function PollDialog({ chatId }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['Да', 'Нет']);
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e) {
    e?.preventDefault();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim()) { setError('Напишите вопрос'); return; }
    if (opts.length < 2) { setError('Нужно минимум два варианта'); return; }
    setBusy(true);
    try { await createPoll(chatId, { question, options: opts, multiple }); closeModal(); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Dialog title="Новый опрос" width={480}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Отмена</button><button className="btn btn-primary" onClick={save} disabled={busy}>Отправить опрос</button></>}>
      <form onSubmit={save} className="form-grid">
        <label className="field"><span>Вопрос</span><input value={question} onChange={(e) => setQuestion(e.target.value)} autoFocus placeholder="Меняем бетон В25 на В30 в плите Пм-3?" maxLength={300} /></label>
        <div className="field">
          <span>Варианты ответа</span>
          <div className="poll-edit">
            {options.map((o, i) => (
              <div key={i} className="poll-edit-row">
                <input value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Вариант ${i + 1}`} aria-label={`Вариант ${i + 1}`} maxLength={120} />
                {options.length > 2 && <button type="button" className="icon-btn icon-btn-sm" aria-label="Убрать вариант" onClick={() => setOptions(options.filter((_, j) => j !== i))}><Icon name="close" size={14} stroke={2.25} /></button>}
              </div>
            ))}
            {options.length < 10 && <button type="button" className="link-btn" onClick={() => setOptions([...options, ''])}>+ Добавить вариант</button>}
          </div>
        </div>
        <Switch checked={multiple} onChange={setMultiple} label="Можно выбрать несколько вариантов" />
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------- Задача ----------
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function TaskDialog({ chatId, fromMessage }) {
  const s = useStore();
  const chat = s.chats[chatId];
  const [title, setTitle] = useState(fromMessage ? plainFrom(fromMessage.text) : '');
  const peer = chat?.type === 'direct' ? chat.members.find((m) => m.userId !== s.me.id)?.userId : null;
  const [assigneeId, setAssigneeId] = useState(peer ? String(peer) : '');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tomorrow = toLocalInput(Date.now() + 86400000);
  async function save(e) {
    e?.preventDefault();
    if (!title.trim()) { setError('Опишите задачу'); return; }
    setBusy(true);
    const dueAt = due ? new Date(`${due}T18:00:00`).getTime() : null;
    try {
      await createTask(chatId, { title, assigneeId: Number(assigneeId) || null, dueAt, fromMessageId: fromMessage?.id });
      closeModal();
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Dialog title={fromMessage ? 'Задача из сообщения' : 'Новая задача'} width={480}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Отмена</button><button className="btn btn-primary" onClick={save} disabled={busy}>Поставить задачу</button></>}>
      <form onSubmit={save} className="form-grid">
        <label className="field"><span>Что сделать</span>
          <textarea className="textarea" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus rows={3} placeholder="Прислать фото армирования захватки 3" maxLength={500} />
        </label>
        <label className="field"><span>Исполнитель</span>
          <select className="select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Без исполнителя</option>
            {chat?.members.map((m) => s.users[m.userId]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((u) => (
              <option key={u.id} value={u.id}>{u.id === s.me.id ? `${u.name} (вы)` : u.name}{u.position ? ` — ${u.position}` : ''}</option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Срок <em>— необязательно</em></span>
          <div className="due-row">
            <input type="date" className="date-input" value={due} min={toLocalInput(Date.now())} onChange={(e) => setDue(e.target.value)} aria-label="Срок" />
            <button type="button" className="chip" onClick={() => setDue(toLocalInput(Date.now()))}>Сегодня</button>
            <button type="button" className="chip" onClick={() => setDue(tomorrow)}>Завтра</button>
            <button type="button" className="chip" onClick={() => setDue(toLocalInput(Date.now() + 7 * 86400000))}>Через неделю</button>
          </div>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}
const plainFrom = (t = '') => t.replace(/\*\*|~~|`/g, '').slice(0, 500);

// ---------- Камера ----------
function CameraDialog({ mode: initialMode = 'photo', onCapture }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recRef = useRef(null);
  const chunks = useRef([]);
  const [mode, setMode] = useState(initialMode);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    let stopped = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setError('Камера в браузере доступна только по HTTPS или в приложении для Windows.'); return; }
      try {
        const st = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true });
        if (stopped) { st.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = st;
        if (videoRef.current) { videoRef.current.srcObject = st; videoRef.current.play().catch(() => {}); }
      } catch (e) {
        setError(e?.name === 'NotAllowedError' ? 'Нет доступа к камере. Разрешите доступ в настройках.' : 'Камера не найдена или занята.');
      }
    })();
    return () => { stopped = true; try { recRef.current?.stop(); } catch { /* */ } streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  useEffect(() => {
    if (!recording) return undefined;
    const t = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => clearInterval(t);
  }, [recording]);

  function takePhoto() {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((blob) => {
      onCapture(new File([blob], `Фото ${new Date().toLocaleString('ru-RU').replace(/[/:]/g, '.')}.jpg`, { type: 'image/jpeg' }));
      closeModal();
    }, 'image/jpeg', 0.9);
  }
  function toggleRecord() {
    if (recording) { recRef.current?.stop(); return; }
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    const r = new MediaRecorder(streamRef.current, type ? { mimeType: type } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = () => {
      setRecording(false);
      const mt = r.mimeType || 'video/webm';
      const blob = new Blob(chunks.current, { type: mt });
      onCapture(new File([blob], `Видео ${new Date().toLocaleString('ru-RU').replace(/[/:]/g, '.')}.${mt.includes('mp4') ? 'mp4' : 'webm'}`, { type: mt }));
      closeModal();
    };
    r.start(500);
    recRef.current = r;
    startedAt.current = Date.now();
    setElapsed(0);
    setRecording(true);
  }

  return (
    <Dialog title={mode === 'photo' ? 'Снять фото' : 'Записать видео'} width={720}
      footer={!error && (
        <>
          <div className="cam-modes" role="tablist">
            <button role="tab" aria-selected={mode === 'photo'} className={'chip' + (mode === 'photo' ? ' chip-active' : '')} onClick={() => !recording && setMode('photo')}>Фото</button>
            <button role="tab" aria-selected={mode === 'video'} className={'chip' + (mode === 'video' ? ' chip-active' : '')} onClick={() => setMode('video')}>Видео</button>
          </div>
          <span style={{ flex: 1 }} />
          {mode === 'photo'
            ? <button className="btn btn-primary" onClick={takePhoto}><Icon name="camera" size={18} />Снять</button>
            : <button className={'btn ' + (recording ? 'btn-danger' : 'btn-primary')} onClick={toggleRecord}><Icon name={recording ? 'stop' : 'video'} size={18} />{recording ? `Остановить · ${formatDuration(elapsed)}` : 'Начать запись'}</button>}
        </>
      )}>
      {error ? <div className="form-error">{error}</div> : (
        <div className="cam-view">
          <video ref={videoRef} autoPlay playsInline muted />
          {recording && <span className="cam-rec"><span className="rec-dot rec-dot-on" />REC {formatDuration(elapsed)}</span>}
        </div>
      )}
    </Dialog>
  );
}

// ---------- Геометка ----------
function LocationDialog({ chatId }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!navigator.geolocation) { setError('Определение местоположения недоступно на этом устройстве.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => setError(e.code === 1 ? 'Нет доступа к местоположению. Разрешите его в настройках Windows: Конфиденциальность → Расположение.' : 'Не удалось определить местоположение.'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }, []);
  async function send() {
    if (!pos) return;
    setBusy(true);
    try { await sendLocation(chatId, { ...pos, label }); closeModal(); } catch { setBusy(false); }
  }
  return (
    <Dialog title="Отправить геометку" width={460}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Отмена</button><button className="btn btn-primary" onClick={send} disabled={!pos || busy}>Отправить</button></>}>
      <div className="form-grid">
        {error ? <div className="form-error">{error}</div> : !pos ? <p className="muted">Определяем местоположение…</p> : (
          <div className="loc-preview">
            <Icon name="pin" size={22} />
            <span className="mono">{pos.lat.toFixed(5)}, {pos.lon.toFixed(5)}</span>
            <span className="muted">точность ±{Math.round(pos.accuracy)} м</span>
          </div>
        )}
        <label className="field"><span>Подпись <em>— необязательно</em></span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Корпус 2, захватка 3" maxLength={200} /></label>
      </div>
    </Dialog>
  );
}

// ---------- Контакт ----------
function ContactDialog({ chatId }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const list = Object.values(s.users).filter((u) => u.isActive && (!q || u.name.toLowerCase().includes(q.toLowerCase()) || (u.position || '').toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  async function pick(u) {
    try { await sendContact(chatId, u.id); closeModal(); } catch { /* показано */ }
  }
  return (
    <Dialog title="Отправить контакт" width={460}>
      <div className="picker">
        <label className="search"><Icon name="search" size={18} /><input autoFocus type="search" aria-label="Поиск" placeholder="Имя или должность" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="picker-list">
          {list.map((u) => (
            <button key={u.id} className="picker-row picker-btn" onClick={() => pick(u)}>
              <UserAvatar user={u} size={34} showOnline />
              <span className="picker-name"><span>{u.name}</span><small>{u.position}</small></span>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---------- Отправить позже ----------
function ScheduleDialog({ onPick }) {
  const d = new Date(Date.now() + 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const [value, setValue] = useState(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`);
  const [error, setError] = useState('');
  function ok() {
    const at = new Date(value).getTime();
    if (!at || at < Date.now() + 30000) { setError('Выберите время в будущем'); return; }
    closeModal();
    onPick(at);
  }
  return (
    <Dialog title="Отправить позже" width={380}
      footer={<><button className="btn btn-soft" onClick={closeModal}>Отмена</button><button className="btn btn-primary" onClick={ok}>Запланировать</button></>}>
      <div className="form-grid">
        <label className="field"><span>Дата и время отправки</span><input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></label>
        {error && <div className="form-error">{error}</div>}
      </div>
    </Dialog>
  );
}

export { getState };

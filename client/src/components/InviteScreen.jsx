import React, { useEffect, useState } from 'react';
import { getState, acceptInvite, login } from '../store.js';
import { initials } from '../utils.js';

/** Страница приглашения в группу: /invite/<токен> (открывается в браузере). */
export default function InviteScreen({ token, onDone }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(getState().token ? 'join' : 'register');
  const [form, setForm] = useState({ name: '', position: '', login: '', password: '' });
  const [busy, setBusy] = useState(false);
  const me = getState().me;

  useEffect(() => {
    fetch(`${getState().serverUrl}/api/invites/${encodeURIComponent(token)}`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Приглашение недействительно'); setInfo(d); })
      .catch((e) => setError(e.message));
  }, [token]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login('', form.login.trim(), form.password);
      await acceptInvite(token, mode === 'register' ? form : undefined);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">±0.0</span>
          <div><h1>Приглашение</h1><p>Мессенджер «Отметка»</p></div>
        </div>
        {!info && !error && <p className="muted">Проверяем приглашение…</p>}
        {info && (
          <div className="invite-group">
            <span className="avatar" style={{ width: 52, height: 52, borderRadius: 16, background: info.color, fontSize: 18 }}>{initials(info.chatTitle)}</span>
            <div>
              <strong>{info.chatTitle}</strong>
              <span className="muted">{info.address ? `${info.address} · ` : ''}{info.members} участников</span>
            </div>
          </div>
        )}
        {info && mode === 'join' && me && (
          <p style={{ margin: 0 }}>Вы вошли как <strong>{me.name}</strong>. Присоединиться к группе?</p>
        )}
        {info && mode === 'register' && (
          <>
            <p className="muted" style={{ margin: 0 }}>Заведите учётную запись гостя — вы увидите только эту группу.</p>
            <label className="field"><span>Имя и фамилия</span><input value={form.name} onChange={set('name')} required autoFocus /></label>
            <label className="field"><span>Организация, должность <em>— необязательно</em></span><input value={form.position} onChange={set('position')} placeholder="ООО «ГенСтрой», прораб" /></label>
            <label className="field"><span>Придумайте логин</span><input value={form.login} onChange={set('login')} required autoComplete="username" /></label>
            <label className="field"><span>Пароль <em>— не короче 6 символов</em></span><input type="password" value={form.password} onChange={set('password')} required minLength={6} autoComplete="new-password" /></label>
          </>
        )}
        {info && mode === 'login' && (
          <>
            <label className="field"><span>Логин</span><input value={form.login} onChange={set('login')} required autoFocus autoComplete="username" /></label>
            <label className="field"><span>Пароль</span><input type="password" value={form.password} onChange={set('password')} required autoComplete="current-password" /></label>
          </>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        {info && <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Подождите…' : mode === 'register' ? 'Создать и присоединиться' : 'Присоединиться'}</button>}
        {info && mode !== 'join' && (
          <button type="button" className="link-btn" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'У меня нет учётной записи' : 'У меня уже есть учётная запись'}
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => { window.history.replaceState(null, '', '/'); onDone(); }}>Перейти к мессенджеру</button>
      </form>
    </div>
  );
}

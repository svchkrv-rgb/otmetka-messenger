import React, { useState } from 'react';
import { login, isTauri, getState } from '../store.js';

export default function Login() {
  const [server, setServer] = useState(getState().serverUrl || '');
  const [showServer, setShowServer] = useState(isTauri || !getState().serverUrl);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(server, name.trim(), password);
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
          <div>
            <h1>Отметка</h1>
            <p>Мессенджер проектной организации</p>
          </div>
        </div>

        {showServer ? (
          <label className="field">
            <span>Адрес сервера</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="например, 192.168.1.10:8080" autoFocus={isTauri && !server} required />
          </label>
        ) : (
          <button type="button" className="link-btn login-server" onClick={() => setShowServer(true)}>Сервер: {server} · изменить</button>
        )}

        <label className="field">
          <span>Логин</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus={!isTauri || !!server} required />
        </label>
        <label className="field">
          <span>Пароль</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>

        {error && <div className="form-error" role="alert">{error}</div>}

        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
        <p className="login-hint">Логин и пароль выдаёт администратор.</p>
      </form>
    </div>
  );
}

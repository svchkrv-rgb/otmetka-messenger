import React, { useEffect } from 'react';
import { useStore, bootstrap, logout, setState } from './store.js';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import InfoPanel from './components/InfoPanel.jsx';
import Modals from './components/Modals.jsx';
import CallLayer from './components/CallLayer.jsx';

export default function App() {
  const s = useStore();

  useEffect(() => {
    if (s.token && !s.me) bootstrap();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Число непрочитанных — в заголовке окна
  useEffect(() => {
    const n = Object.values(s.chats).reduce((sum, c) => sum + (c.unread || 0), 0);
    document.title = n ? `(${n}) Отметка` : 'Отметка';
  }, [s.chats]);

  if (!s.token) return <Login />;

  if (!s.me || !Object.keys(s.users).length) {
    return (
      <div className="splash">
        <span className="brand-mark brand-mark-lg">±0.0</span>
        {s.bootError ? (
          <>
            <p>{s.bootError}</p>
            <div className="splash-actions">
              <button className="btn btn-primary" onClick={() => bootstrap()}>Повторить</button>
              <button className="btn btn-soft" onClick={logout}>Сменить сервер или пользователя</button>
            </div>
          </>
        ) : <p>Загрузка…</p>}
      </div>
    );
  }

  return (
    <div className={'app' + (s.activeChatId ? ' app-chat-open' : '')}>
      <Sidebar />
      <main className="main">
        {s.activeChatId ? <ChatView key={s.activeChatId} chatId={s.activeChatId} /> : (
          <div className="main-empty">
            <span className="brand-mark brand-mark-lg">±0.0</span>
            <p>Выберите чат или создайте группу объекта</p>
          </div>
        )}
      </main>
      {s.activeChatId && s.infoOpen && <InfoPanel chatId={s.activeChatId} />}
      <Modals />
      <CallLayer />
      {s.toast && (
        <div className="toast" role="status" key={s.toast.id}>
          <span>{s.toast.text}</span>
          {s.toast.action && <button className="toast-action" onClick={() => { s.toast.action.run(); setState({ toast: null }); }}>{s.toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}

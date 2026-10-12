import React, { useState } from 'react';
import { initials } from '../utils.js';
import { avatarUrl } from '../store.js';

function Img({ src, alt }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img className="avatar-img" src={src} alt={alt} onError={() => setFailed(true)} draggable={false} />;
}

/** Аватар сотрудника (круглый) или группы (скруглённый квадрат). */
export function UserAvatar({ user, size = 40, showOnline = false, ring = '#FFFFFF' }) {
  const color = user?.color || '#3E4349';
  const src = avatarUrl(user?.avatar);
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: size / 2, background: color, fontSize: Math.round(size * 0.36) }}>
      {initials(user?.name)}
      {src && <Img src={src} alt="" />}
      {showOnline && user?.online && (
        <span className="avatar-dot" style={{ width: Math.max(10, size * 0.26), height: Math.max(10, size * 0.26), borderColor: ring }} />
      )}
      {showOnline && !user?.online && user?.status && size >= 32 && (
        <span className="avatar-dot avatar-dot-away" style={{ width: Math.max(10, size * 0.26), height: Math.max(10, size * 0.26), borderColor: ring }} />
      )}
    </span>
  );
}

export function GroupAvatar({ chat, size = 40 }) {
  const src = avatarUrl(chat?.avatar);
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), background: chat?.color || '#C2410C', fontSize: Math.round(size * 0.34) }}>
      {initials(chat?.title)}
      {src && <Img src={src} alt="" />}
    </span>
  );
}

export function ChatAvatar({ chat, users, meId, size = 40, ring }) {
  if (chat?.type === 'group') return <GroupAvatar chat={chat} size={size} />;
  const peer = users[chat?.members.find((m) => m.userId !== meId)?.userId];
  return <UserAvatar user={peer} size={size} showOnline ring={ring} />;
}

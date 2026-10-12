import React from 'react';
import { initials } from '../utils.js';

/** Аватар сотрудника (круглый) или группы (скруглённый квадрат). */
export function UserAvatar({ user, size = 40, showOnline = false, ring = '#FFFFFF' }) {
  const color = user?.color || '#3E4349';
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: size / 2, background: color, fontSize: Math.round(size * 0.36) }}>
      {initials(user?.name)}
      {showOnline && user?.online && (
        <span className="avatar-dot" style={{ width: Math.max(10, size * 0.26), height: Math.max(10, size * 0.26), borderColor: ring }} />
      )}
    </span>
  );
}

export function GroupAvatar({ chat, size = 40 }) {
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), background: chat?.color || '#C2410C', fontSize: Math.round(size * 0.34) }}>
      {initials(chat?.title)}
    </span>
  );
}

export function ChatAvatar({ chat, users, meId, size = 40, ring }) {
  if (chat?.type === 'group') return <GroupAvatar chat={chat} size={size} />;
  const peer = users[chat?.members.find((m) => m.userId !== meId)?.userId];
  return <UserAvatar user={peer} size={size} showOnline ring={ring} />;
}

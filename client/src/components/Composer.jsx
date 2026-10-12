import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, sendMessage, sendTyping, toast, openModal, editMessage, setReply, setEditing, getState } from '../store.js';
import { formatSize, formatDuration, peerOf, chatTitle } from '../utils.js';
import { plainText } from '../format.jsx';
import { startChatCall } from '../calls.js';
import { UserAvatar } from './Avatar.jsx';
import Icon from './Icon.jsx';
import VoiceRecorder from './VoiceRecorder.jsx';

const drafts = {};

const EMOJI = ['👍', '👌', '🙏', '✅', '❌', '⚠️', '❗', '❓', '🔥', '💪', '👏', '🤝', '😊', '😂', '🙂', '😉', '😅', '🤔', '😐', '😔', '😮', '😢', '😡', '🥳',
  '📌', '📎', '📷', '🎥', '📄', '📐', '📏', '🧱', '🏗️', '🏢', '🏠', '🚧', '🔧', '🔨', '⚙️', '🧰', '🚚', '🕐', '📅', '☎️', '💬', '✏️', '🔑', '❤️'];

const COMMANDS = [
  { cmd: 'задача', label: 'Поставить задачу', icon: 'task' },
  { cmd: 'опрос', label: 'Создать опрос', icon: 'poll' },
  { cmd: 'фото', label: 'Снять фото камерой', icon: 'camera' },
  { cmd: 'видео', label: 'Записать видео', icon: 'video' },
  { cmd: 'геометка', label: 'Отправить геометку', icon: 'pin' },
  { cmd: 'контакт', label: 'Отправить контакт', icon: 'user' },
  { cmd: 'созвон', label: 'Начать созвон', icon: 'phone' },
];

function schedulePresets() {
  const d = new Date();
  const at = (days, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x.getTime(); };
  const list = [{ label: 'Через 1 час', at: Date.now() + 3600000 }];
  if (d.getHours() < 17) list.push({ label: 'Сегодня в 18:00', at: at(0, 18) });
  list.push({ label: 'Завтра в 9:00', at: at(1, 9) });
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  if (toMonday > 1) list.push({ label: 'В понедельник в 9:00', at: at(toMonday, 9) });
  return list;
}

export default function Composer({ chatId, files, setFiles, disabled }) {
  const s = useStore();
  const chat = s.chats[chatId];
  const me = s.me;
  const replyId = s.replyTo[chatId];
  const editId = s.editing[chatId];
  const list = s.messages[chatId] || [];
  const replyMsg = replyId ? list.find((m) => m.id === replyId) : null;
  const editMsg = editId ? list.find((m) => m.id === editId) : null;

  const [text, setText] = useState(drafts[chatId] || '');
  const [focused, setFocused] = useState(false);
  const [important, setImportant] = useState(false);
  const [progress, setProgress] = useState(null);
  const [menu, setMenu] = useState(null); // attach | emoji | send | schedule
  const [caret, setCaret] = useState(0);
  const [popupIndex, setPopupIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [suppress, setSuppress] = useState(false);
  const mentionMap = useRef(new Map());
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const pressTimer = useRef(null);
  const longPressed = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, [chatId, replyId, editId]);
  useEffect(() => { if (!editId) drafts[chatId] = text; }, [chatId, text, editId]);

  // Режим правки: подставить текст исходного сообщения
  useEffect(() => {
    if (editMsg) {
      setText(editMsg.text);
      mentionMap.current = new Map(editMsg.mentions.filter((id) => id).map((id) => [s.users[id]?.name, id]).filter(([n]) => n));
      setTimeout(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0);
    } else if (!editId) {
      setText(drafts[chatId] || '');
    }
  }, [editId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  const previews = useMemo(() => files.map((f) => ({
    file: f,
    url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
  })), [files]);
  useEffect(() => () => previews.forEach((p) => p.url && URL.revokeObjectURL(p.url)), [previews]);

  // ---------- Подсказки @ и / ----------
  const myMember = chat?.members.find((m) => m.userId === me.id);
  const canAdd = chat?.type === 'group' && (myMember?.role === 'owner' || myMember?.role === 'admin' || (chat.membersCanAdd && myMember?.role === 'member'));
  const mentionQuery = useMemo(() => {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]{0,20}(?: [^\s@]{0,20})?)$/);
    return m ? m[1] : null;
  }, [text, caret]);
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !chat) return [];
    const q = mentionQuery.toLowerCase();
    const inChat = new Set(chat.members.map((m) => m.userId));
    const match = (u) => !q || u.name.toLowerCase().includes(q) || u.login.toLowerCase().startsWith(q);
    const opts = chat.members
      .filter((m) => m.userId !== me.id).map((m) => s.users[m.userId]).filter((u) => u && match(u))
      .map((u) => ({ id: u.id, name: u.name, user: u, sub: [u.position, u.online ? 'в сети' : ''].filter(Boolean).join(' · ') }));
    if (chat.type === 'group' && (!q || 'все'.startsWith(q))) opts.unshift({ id: 0, name: 'все', sub: `${chat.members.length - 1} участников`, all: true });
    if (canAdd && q.length >= 2) {
      Object.values(s.users).filter((u) => u.isActive && !inChat.has(u.id) && match(u)).slice(0, 3)
        .forEach((u) => opts.push({ id: u.id, name: u.name, user: u, sub: `${u.position ? u.position + ' · ' : ''}не в группе, будет добавлен(а)`, add: true }));
    }
    return opts.slice(0, 7);
  }, [mentionQuery, chat, s.users, me.id, canAdd]);
  const slashQuery = /^\/[^\s]*$/.test(text) && !editId ? text.slice(1).toLowerCase() : null;
  const slashOptions = slashQuery === null ? [] : COMMANDS.filter((c) => c.cmd.startsWith(slashQuery));
  const popup = suppress ? null : slashOptions.length ? 'slash' : mentionOptions.length ? 'mention' : null;
  useEffect(() => { setPopupIndex(0); }, [popup, mentionQuery, slashQuery]);

  function insertMention(opt) {
    const el = inputRef.current;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,20}(?: [^\s@]{0,20})?)$/, `@${opt.name} `);
    const next = before + text.slice(caret);
    if (opt.id) mentionMap.current.set(opt.name, opt.id);
    setText(next);
    setTimeout(() => { el?.focus(); el?.setSelectionRange(before.length, before.length); setCaret(before.length); }, 0);
  }

  function runCommand(cmd) {
    setText('');
    runAction(cmd);
  }

  function runAction(action) {
    setMenu(null);
    const peer = peerOf(chat, me.id);
    switch (action) {
      case 'файл': fileRef.current.accept = ''; fileRef.current.click(); break;
      case 'медиа': fileRef.current.accept = 'image/*,video/*'; fileRef.current.click(); break;
      case 'фото': openModal('camera', { mode: 'photo', onCapture: (f) => setFiles((x) => [...x, f].slice(0, 10)) }); break;
      case 'видео': openModal('camera', { mode: 'video', onCapture: (f) => setFiles((x) => [...x, f].slice(0, 10)) }); break;
      case 'задача': openModal('task', { chatId }); break;
      case 'опрос': openModal('poll', { chatId }); break;
      case 'геометка': openModal('location', { chatId }); break;
      case 'контакт': openModal('contact', { chatId }); break;
      case 'созвон': startChatCall(chatId, peer, true); break;
      default:
    }
  }

  // ---------- Форматирование ----------
  function wrapSelection(left, right = left, placeholder = '') {
    const el = inputRef.current;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const sel = text.slice(a, b) || placeholder;
    const next = text.slice(0, a) + left + sel + right + text.slice(b);
    setText(next);
    setTimeout(() => { el.focus(); el.setSelectionRange(a + left.length, a + left.length + sel.length); }, 0);
  }
  function makeList() {
    const el = inputRef.current;
    const a = text.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const b = el.selectionEnd;
    const block = text.slice(a, b).split('\n').map((l) => (l.startsWith('- ') ? l : `- ${l}`)).join('\n');
    setText(text.slice(0, a) + block + text.slice(b));
    setTimeout(() => el.focus(), 0);
  }
  function makeLink() {
    const el = inputRef.current;
    const url = window.prompt('Адрес ссылки', 'https://');
    if (!url || url === 'https://') return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const label = text.slice(a, b) || 'ссылка';
    setText(text.slice(0, a) + `[${label}](${url})` + text.slice(b));
    setTimeout(() => el.focus(), 0);
  }
  function insertAtCaret(str) {
    const el = inputRef.current;
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? text.length;
    const next = text.slice(0, a) + str + text.slice(b);
    setText(next);
    setTimeout(() => { el?.focus(); el?.setSelectionRange(a + str.length, a + str.length); setCaret(a + str.length); }, 0);
  }

  // ---------- Отправка ----------
  function collectMentions(body) {
    const ids = new Set();
    for (const [name, id] of mentionMap.current) if (body.includes(`@${name}`)) ids.add(id);
    if (chat?.type === 'group' && /(^|\s)@все(\s|$|[,.!?])/.test(body)) ids.add(0);
    return [...ids];
  }

  function reset() {
    setText('');
    setFiles([]);
    setImportant(false);
    mentionMap.current = new Map();
    drafts[chatId] = '';
    if (replyId) setReply(chatId, null);
    if (editId) setEditing(chatId, null);
  }

  async function submit(opts = {}) {
    setMenu(null);
    if (progress !== null || disabled) return;
    const body = text.trim();
    if (editId) {
      if (!body && !editMsg?.attachments.length) return;
      try { await editMessage(editId, body, collectMentions(body)); reset(); } catch { /* показано */ }
      return;
    }
    if (!body && !files.length) { if (opts.sendAt || opts.silent || opts.important) toast('Сначала напишите сообщение'); return; }
    setProgress(files.length ? 0 : null);
    try {
      const r = await sendMessage(chatId, {
        text: body, files, important: important || opts.important, silent: opts.silent, sendAt: opts.sendAt,
        replyTo: replyId, mentions: collectMentions(body),
      }, (p) => setProgress(p));
      reset();
      if (r?.scheduled) toast(`Сообщение будет отправлено ${new Date(r.scheduled.sendAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`);
    } catch (e) {
      toast(e.message);
    }
    setProgress(null);
    inputRef.current?.focus();
  }

  async function sendVoice(file, meta) {
    setRecording(false);
    setProgress(0);
    try {
      await sendMessage(chatId, { text: '', files: [file], filesMeta: [meta], replyTo: replyId }, (p) => setProgress(p));
      if (replyId) setReply(chatId, null);
    } catch (e) { toast(e.message); }
    setProgress(null);
  }

  function onKeyDown(e) {
    if (popup) {
      const opts = popup === 'slash' ? slashOptions : mentionOptions;
      if (e.key === 'ArrowDown') { e.preventDefault(); setPopupIndex((i) => (i + 1) % opts.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPopupIndex((i) => (i - 1 + opts.length) % opts.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const o = opts[popupIndex] || opts[0];
        if (popup === 'slash') runCommand(o.cmd); else insertMention(o);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setSuppress(true); return; }
    }
    if (e.key === 'Escape') {
      if (menu) { setMenu(null); return; }
      if (editId) { setEditing(chatId, null); return; }
      if (replyId) { setReply(chatId, null); return; }
    }
    if (e.key === 'ArrowUp' && !text && !files.length && !editId) {
      const mine = [...list].reverse().find((m) => m.senderId === me.id && m.kind === 'text' && !m.deletedAt);
      if (mine) { e.preventDefault(); setEditing(chatId, mine.id); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'и') { e.preventDefault(); wrapSelection('**'); }
      if (k === 'i' || k === 'ш') { e.preventDefault(); wrapSelection('_'); }
    }
  }

  function onPaste(e) {
    const pasted = [...(e.clipboardData?.files || [])];
    if (pasted.length) {
      e.preventDefault();
      setFiles((f) => [...f, ...pasted].slice(0, 10));
    }
  }

  function onPick(e) {
    const picked = [...(e.target.files || [])];
    if (picked.length) setFiles((f) => [...f, ...picked].slice(0, 10));
    e.target.value = '';
  }

  // Долгое нажатие или правый клик по кнопке отправки — параметры отправки
  function onSendDown() {
    longPressed.current = false;
    pressTimer.current = setTimeout(() => { longPressed.current = true; setMenu('send'); }, 450);
  }
  function onSendUp() { clearTimeout(pressTimer.current); }
  function onSendClick() {
    if (longPressed.current) { longPressed.current = false; return; }
    submit();
  }

  const hasContent = !!(text.trim() || files.length);
  const showMic = !hasContent && !editId && !disabled;
  const showBar = (focused || text) && !recording;
  const replyAuthor = replyMsg ? (replyMsg.senderId === me.id ? 'себе' : s.users[replyMsg.senderId]?.name ?? 'сотруднику') : '';
  const replyColor = replyMsg && s.users[replyMsg.senderId]?.color;

  if (recording) {
    return (
      <div className="composer">
        <VoiceRecorder chatId={chatId} onCancel={() => setRecording(false)} onSend={sendVoice} />
      </div>
    );
  }

  return (
    <div className="composer">
      <div className="composer-side">
        <button className={'round-btn' + (menu === 'attach' ? ' round-btn-dark' : '')} aria-label={menu === 'attach' ? 'Закрыть меню' : 'Прикрепить и другие действия'} aria-expanded={menu === 'attach'}
          title="Фото, видео, файлы, задача, опрос…" onClick={() => setMenu(menu === 'attach' ? null : 'attach')} disabled={disabled || !!editId}>
          <Icon name={menu === 'attach' ? 'close' : 'plus'} size={22} stroke={2} />
        </button>
        {menu === 'attach' && <AttachMenu onPick={runAction} onClose={() => setMenu(null)} />}
      </div>
      <input ref={fileRef} type="file" multiple hidden onChange={onPick} />

      <div className={'composer-field' + (focused ? ' composer-field-focus' : '') + (files.length || replyMsg || editMsg || important ? ' composer-field-tall' : '')}>
        {popup === 'mention' && (
          <div className="suggest" role="listbox" aria-label="Упомянуть">
            {mentionOptions.map((o, i) => (
              <button key={`${o.id}-${o.name}`} role="option" aria-selected={i === popupIndex} className={'suggest-row' + (i === popupIndex ? ' active' : '')}
                onMouseDown={(e) => { e.preventDefault(); insertMention(o); }} onMouseEnter={() => setPopupIndex(i)}>
                {o.all ? <span className="avatar suggest-all"><Icon name="people" size={16} /></span> : <UserAvatar user={o.user} size={32} showOnline ring={i === popupIndex ? '#EDF1F6' : '#fff'} />}
                <span className="suggest-name"><span>{o.all ? '@все — вся группа' : o.name}</span><small className={o.add ? 'suggest-add' : ''}>{o.sub}</small></span>
                {i === popupIndex && <span className="kbd">Enter</span>}
              </button>
            ))}
          </div>
        )}
        {popup === 'slash' && (
          <div className="suggest" role="listbox" aria-label="Команды">
            {slashOptions.map((c, i) => (
              <button key={c.cmd} role="option" aria-selected={i === popupIndex} className={'suggest-row' + (i === popupIndex ? ' active' : '')}
                onMouseDown={(e) => { e.preventDefault(); runCommand(c.cmd); }} onMouseEnter={() => setPopupIndex(i)}>
                <span className="suggest-icon"><Icon name={c.icon} size={18} /></span>
                <span className="suggest-name"><span className="mono">/{c.cmd}</span><small>{c.label}</small></span>
              </button>
            ))}
          </div>
        )}

        {(replyMsg || editMsg) && (
          <div className="quote-bar" style={{ borderLeftColor: editMsg ? 'var(--navy)' : (replyColor || 'var(--navy)') }}>
            <Icon name={editMsg ? 'edit' : 'reply'} size={16} />
            <span className="quote-body">
              <strong style={{ color: editMsg ? 'var(--navy)' : replyColor }}>{editMsg ? 'Редактирование' : `Ответ ${replyAuthor === 'себе' ? 'себе' : replyAuthor}`}</strong>
              <span>{plainText((editMsg || replyMsg).text) || ((editMsg || replyMsg).attachments.length ? 'Вложение' : '')}</span>
            </span>
            <button className="icon-btn icon-btn-xs" aria-label={editMsg ? 'Отменить редактирование' : 'Убрать ответ'} onClick={() => (editMsg ? setEditing(chatId, null) : setReply(chatId, null))}>
              <Icon name="close" size={14} stroke={2.25} />
            </button>
          </div>
        )}

        {files.length > 0 && (
          <div className="attach-list">
            {previews.map((p, i) => (
              <div key={i} className="attach-chip">
                {p.url ? <img src={p.url} alt="" /> : <span className="attach-icon"><Icon name={p.file.type.startsWith('video/') ? 'play' : 'file'} size={16} /></span>}
                <span className="attach-name"><span>{p.file.name}</span><small>{formatSize(p.file.size)}</small></span>
                <button className="icon-btn icon-btn-xs" aria-label={`Убрать ${p.file.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} disabled={progress !== null}>
                  <Icon name="close" size={14} stroke={2.25} />
                </button>
              </div>
            ))}
          </div>
        )}
        {progress !== null && (
          <div className="upload-bar" aria-label="Загрузка"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        )}
        {important && !editId && (
          <label className="important-row">
            <input type="checkbox" checked onChange={() => setImportant(false)} />
            Важное — попросить подтвердить прочтение
          </label>
        )}

        <div className="composer-row">
          <label className="sr-only" htmlFor={`composer-${chatId}`}>Сообщение</label>
          <textarea
            id={`composer-${chatId}`}
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={disabled ? 'Сотрудник отключён' : editId ? 'Изменённый текст' : 'Сообщение'}
            disabled={disabled}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setSuppress(false); if (e.target.value) sendTyping(chatId); }}
            onSelect={(e) => setCaret(e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {!showBar && (
            <button className="icon-btn icon-btn-sm" aria-label="Эмодзи" onClick={() => setMenu(menu === 'emoji' ? null : 'emoji')} disabled={disabled}><Icon name="smile" size={20} /></button>
          )}
        </div>

        {showBar && (
          <div className="format-bar" onMouseDown={(e) => { if (e.target.closest('button')) e.preventDefault(); }}>
            <button className="fmt-btn fmt-b" aria-label="Жирный (Ctrl+B)" title="Жирный (Ctrl+B)" onClick={() => wrapSelection('**', '**', 'текст')}>Ж</button>
            <button className="fmt-btn fmt-i" aria-label="Курсив (Ctrl+I)" title="Курсив (Ctrl+I)" onClick={() => wrapSelection('_', '_', 'текст')}>К</button>
            <button className="fmt-btn fmt-s" aria-label="Зачёркнутый" title="Зачёркнутый" onClick={() => wrapSelection('~~', '~~', 'текст')}>З</button>
            <button className="fmt-btn" aria-label="Список" title="Список" onClick={makeList}><Icon name="list" size={18} /></button>
            <button className="fmt-btn" aria-label="Моноширинный: шифр, отметка, размер" title="Моноширинный: шифр, отметка, размер" onClick={() => wrapSelection('`', '`', '+6.600')}><Icon name="code" size={18} /></button>
            <button className="fmt-btn" aria-label="Ссылка" title="Ссылка" onClick={makeLink}><Icon name="link" size={18} /></button>
            <span className="fmt-sep" />
            <button className="fmt-btn fmt-at" aria-label="Упомянуть" title="Упомянуть" onClick={() => insertAtCaret((text && !/\s$/.test(text.slice(0, inputRef.current?.selectionStart ?? text.length)) ? ' ' : '') + '@')}>@</button>
            {!editId && (
              <button className={'fmt-btn' + (important ? ' important-on' : '')} aria-pressed={important} aria-label="Важное — с подтверждением прочтения" title="Важное — с подтверждением прочтения" onClick={() => setImportant(!important)}>
                <Icon name="important" size={18} stroke={2.5} />
              </button>
            )}
            <span className="fmt-grow" />
            <button className="fmt-btn fmt-round" aria-label="Эмодзи" title="Эмодзи" onClick={() => setMenu(menu === 'emoji' ? null : 'emoji')}><Icon name="smile" size={20} /></button>
            {!editId && <button className="fmt-btn fmt-round" aria-label="Отложенная отправка" title="Отправить позже" onClick={() => setMenu(menu === 'schedule' ? null : 'schedule')}><Icon name="clock" size={20} /></button>}
          </div>
        )}
        {menu === 'emoji' && (
          <div className="emoji-pop" role="dialog" aria-label="Эмодзи" onMouseDown={(e) => e.preventDefault()}>
            {EMOJI.map((e) => <button key={e} onClick={() => insertAtCaret(e)} aria-label={e}>{e}</button>)}
          </div>
        )}
      </div>

      <div className="composer-side">
        {showMic ? (
          <button className="round-btn" aria-label="Записать голосовое" title="Записать голосовое" onClick={() => setRecording(true)}>
            <Icon name="mic" size={20} />
          </button>
        ) : (
          <button className={'round-btn round-btn-send' + (menu === 'send' ? ' round-btn-held' : '')} aria-label={editId ? 'Сохранить' : 'Отправить'} title={editId ? 'Сохранить (Enter)' : 'Отправить (Enter). Удерживайте — параметры отправки'}
            onPointerDown={onSendDown} onPointerUp={onSendUp} onPointerLeave={onSendUp}
            onContextMenu={(e) => { e.preventDefault(); if (!editId) setMenu('send'); }}
            onClick={onSendClick} disabled={!hasContent || progress !== null || disabled}>
            <Icon name={editId ? 'check' : 'send'} size={20} stroke={2} />
          </button>
        )}
        {(menu === 'send' || menu === 'schedule') && (
          <SendMenu scheduleOnly={menu === 'schedule'} onClose={() => setMenu(null)} onSend={submit} chatName={chatTitle(chat, s.users, me.id)} />
        )}
      </div>
    </div>
  );
}

function useOutside(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.composer-side')) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return ref;
}

function AttachMenu({ onPick, onClose }) {
  const ref = useOutside(onClose);
  const items = [
    { a: 'медиа', label: 'Фото и видео', icon: 'image', tone: 'gray' },
    { a: 'фото', label: 'Камера', icon: 'camera', tone: 'gray' },
    { a: 'файл', label: 'Файл', icon: 'attach', tone: 'gray' },
    { a: 'геометка', label: 'Геометка', icon: 'pin', tone: 'amber' },
    { a: 'задача', label: 'Задача', icon: 'task', tone: 'green' },
    { a: 'опрос', label: 'Опрос', icon: 'poll', tone: 'purple' },
    { a: 'контакт', label: 'Контакт', icon: 'user', tone: 'gray' },
    { a: 'созвон', label: 'Созвон', icon: 'video', tone: 'navy' },
  ];
  return (
    <div className="attach-menu" ref={ref} role="menu" aria-label="Прикрепить">
      {items.map((it) => (
        <button key={it.a} role="menuitem" onClick={() => onPick(it.a)}>
          <span className={'tile tile-' + it.tone}><Icon name={it.icon} size={20} /></span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function SendMenu({ onClose, onSend, scheduleOnly }) {
  const ref = useOutside(onClose);
  const [sub, setSub] = useState(scheduleOnly);
  const presets = schedulePresets();
  return (
    <div className="send-menu" ref={ref} role="menu" aria-label="Параметры отправки">
      {!sub ? (
        <>
          <button role="menuitem" onClick={() => setSub(true)}><Icon name="clock" size={18} /><span>Отправить позже</span><Icon name="chevronDown" size={14} style={{ transform: 'rotate(-90deg)' }} /></button>
          <button role="menuitem" onClick={() => onSend({ silent: true })}><Icon name="bellOff" size={18} /><span>Без звука</span></button>
          <button role="menuitem" className="send-important" onClick={() => onSend({ important: true })}><Icon name="important" size={18} stroke={2.5} /><span>Важное — с подтверждением прочтения</span></button>
        </>
      ) : (
        <>
          <div className="send-menu-title">Отправить позже</div>
          {presets.map((p) => (
            <button key={p.label} role="menuitem" onClick={() => onSend({ sendAt: p.at })}><Icon name="clock" size={18} /><span>{p.label}</span></button>
          ))}
          <button role="menuitem" onClick={() => { onClose(); openModal('schedule', { onPick: (at) => onSend({ sendAt: at }) }); }}>
            <Icon name="calendar" size={18} /><span>Выбрать дату и время…</span>
          </button>
        </>
      )}
    </div>
  );
}

export { formatDuration, getState };

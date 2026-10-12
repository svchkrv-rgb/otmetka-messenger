import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sendMessage, sendTyping, toast } from '../store.js';
import { formatSize } from '../utils.js';
import Icon from './Icon.jsx';

const drafts = {};

export default function Composer({ chatId, files, setFiles, disabled }) {
  const [text, setText] = useState(drafts[chatId] || '');
  const [important, setImportant] = useState(false);
  const [progress, setProgress] = useState(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, [chatId]);
  useEffect(() => { drafts[chatId] = text; }, [chatId, text]);

  // Высота поля по содержимому
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [text]);

  const previews = useMemo(() => files.map((f) => ({
    file: f,
    url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
  })), [files]);
  useEffect(() => () => previews.forEach((p) => p.url && URL.revokeObjectURL(p.url)), [previews]);

  async function submit() {
    if (progress !== null) return;
    const body = text.trim();
    if (!body && !files.length) return;
    setProgress(files.length ? 0 : null);
    try {
      await sendMessage(chatId, { text: body, files, important }, (p) => setProgress(p));
      setText('');
      setFiles([]);
      setImportant(false);
    } catch (e) {
      toast(e.message);
    }
    setProgress(null);
    inputRef.current?.focus();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
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

  const canSend = (text.trim() || files.length) && progress === null && !disabled;

  return (
    <div className="composer">
      <button className="round-btn" aria-label="Прикрепить фото, видео или файл" title="Прикрепить" onClick={() => fileRef.current?.click()} disabled={disabled}>
        <Icon name="plus" size={22} stroke={2} />
      </button>
      <input ref={fileRef} type="file" multiple hidden onChange={onPick} accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar,.7z,.txt" />

      <div className={'composer-field' + (files.length ? ' composer-field-tall' : '')}>
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
          <div className="upload-bar" aria-label="Загрузка файлов"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        )}
        <div className="composer-row">
          <label className="sr-only" htmlFor={`composer-${chatId}`}>Сообщение</label>
          <textarea
            id={`composer-${chatId}`}
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={disabled ? 'Сотрудник отключён' : 'Сообщение'}
            disabled={disabled}
            onChange={(e) => { setText(e.target.value); if (e.target.value) sendTyping(chatId); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <button className={'icon-btn icon-btn-sm' + (important ? ' important-on' : '')} aria-pressed={important}
            title="Важное — выделить и следить за прочтением" aria-label="Пометить как важное" onClick={() => setImportant(!important)} disabled={disabled}>
            <Icon name="important" size={18} stroke={2.5} />
          </button>
        </div>
      </div>

      <button className="round-btn round-btn-send" aria-label="Отправить" title="Отправить (Enter)" onClick={submit} disabled={!canSend}>
        <Icon name="send" size={20} stroke={2} />
      </button>
    </div>
  );
}

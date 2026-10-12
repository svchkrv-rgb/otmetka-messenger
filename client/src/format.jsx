// Отображение текста сообщения: **жирный**, _курсив_, ~~зачёркнутый~~, `моноширинный`, списки, ссылки, @упоминания.
import React from 'react';
import { openExternal } from './store.js';

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(_[^_\n]+_)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?"'»])/g;

function Link({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternal(href); }}>{children}</a>
  );
}

function inline(text, key, mentionNames, meName) {
  // сначала выделяем упоминания, затем форматирование
  const parts = [];
  if (mentionNames.length) {
    const escaped = mentionNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
    const re = new RegExp(`@(${escaped.join('|')})`, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ t: text.slice(last, m.index) });
      parts.push({ mention: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ t: text.slice(last) });
  } else parts.push({ t: text });

  const out = [];
  parts.forEach((p, i) => {
    if (p.mention) {
      out.push(<span key={`${key}-m${i}`} className={'mention' + (p.mention === meName || p.mention === 'все' ? ' mention-me' : '')}>@{p.mention}</span>);
      return;
    }
    let last = 0;
    let m;
    INLINE.lastIndex = 0;
    const s = p.t;
    while ((m = INLINE.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const k = `${key}-${i}-${m.index}`;
      if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
      else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
      else if (m[3]) out.push(<s key={k}>{m[3].slice(2, -2)}</s>);
      else if (m[4]) out.push(<em key={k}>{m[4].slice(1, -1)}</em>);
      else if (m[5]) {
        const [, label, href] = m[5].match(/^\[([^\]]+)\]\((.+)\)$/);
        out.push(<Link key={k} href={href}>{label}</Link>);
      } else if (m[6]) out.push(<Link key={k} href={m[6]}>{m[6]}</Link>);
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
  });
  return out;
}

export function RichText({ text, mentionNames = [], meName }) {
  const lines = text.split('\n');
  const blocks = [];
  let list = null;
  lines.forEach((line, i) => {
    const li = line.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (!list) { list = []; blocks.push({ list }); }
      list.push(li[1]);
    } else {
      list = null;
      blocks.push({ line });
    }
  });
  return (
    <>
      {blocks.map((b, i) => (b.list ? (
        <ul key={i}>{b.list.map((t, j) => <li key={j}>{inline(t, `${i}-${j}`, mentionNames, meName)}</li>)}</ul>
      ) : (
        <React.Fragment key={i}>{inline(b.line, String(i), mentionNames, meName)}{i < blocks.length - 1 && !blocks[i + 1].list ? '\n' : ''}</React.Fragment>
      )))}
    </>
  );
}

/** Текст без разметки — для превью в списке чатов и цитат. */
export function plainText(text = '') {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2');
}

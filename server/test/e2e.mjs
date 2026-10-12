// Сквозная проверка сервера: вход, сотрудники, группа, сообщения, файлы, прочтения, звонок.
// Запуск: BASE=http://localhost:8080 node server/test/e2e.mjs   (нужен Node 22+: встроенные fetch и WebSocket)
const BASE = process.env.BASE || 'http://localhost:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

let step = 0;
function ok(cond, what) {
  step += 1;
  if (!cond) {
    console.error(`✗ ${step}. ${what}`);
    process.exit(1);
  }
  console.log(`✓ ${step}. ${what}`);
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function socket(token) {
  const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
  const events = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const ev = JSON.parse(e.data);
    events.push(ev);
    for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
  });
  const opened = new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  return {
    ws, opened,
    send: (obj) => ws.send(JSON.stringify(obj)),
    wait(pred, ms = 5000) {
      const found = events.find(pred);
      if (found) { events.splice(events.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) reject(new Error('Нет события за ' + ms + ' мс')); }, ms);
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* сервер ещё стартует */ }
    await sleep(500);
  }
  const health = await api(null, 'GET', '/api/health');
  ok(health.status === 200, 'сервер отвечает');

  const bad = await api(null, 'POST', '/api/login', { login: ADMIN_LOGIN, password: 'wrong' });
  ok(bad.status === 401, 'неверный пароль отклонён');

  const adm = await api(null, 'POST', '/api/login', { login: ADMIN_LOGIN, password: ADMIN_PASSWORD });
  ok(adm.status === 200 && adm.data.token, 'администратор вошёл');
  const A = adm.data.token;

  const suffix = Date.now().toString(36);
  const u1 = await api(A, 'POST', '/api/users', { login: 'olga' + suffix, name: 'Ольга Ким', position: 'Архитектор', password: 'secret1' });
  const u2 = await api(A, 'POST', '/api/users', { login: 'pavel' + suffix, name: 'Павел Зуев', position: 'Авторский надзор', password: 'secret2' });
  ok(u1.status === 201 && u2.status === 201, 'созданы два сотрудника');

  const o = await api(null, 'POST', '/api/login', { login: 'olga' + suffix, password: 'secret1' });
  const p = await api(null, 'POST', '/api/login', { login: 'pavel' + suffix, password: 'secret2' });
  ok(o.status === 200 && p.status === 200, 'сотрудники вошли');
  const O = o.data.token;
  const P = p.data.token;

  const forbidden = await api(O, 'POST', '/api/users', { login: 'x' + suffix, name: 'X', password: 'secret3' });
  ok(forbidden.status === 403, 'обычный сотрудник не может добавлять людей');

  const wsA = socket(A);
  const wsO = socket(O);
  await Promise.all([wsA.opened, wsO.opened]);
  ok(true, 'WebSocket подключены');

  const g = await api(A, 'POST', '/api/chats/group', { title: 'Северный квартал · Корпус 2', memberIds: [u1.data.id, u2.data.id] });
  ok(g.status === 201 && g.data.members.length === 3 && g.data.myRole === 'owner', 'создана группа объекта на 3 участника');
  const chatId = g.data.id;
  await wsO.wait((e) => e.type === 'chat:updated' && e.chat.id === chatId);
  ok(true, 'участник получил уведомление о группе');

  const fd = new FormData();
  fd.append('text', 'Армирование захватки 3 готово');
  fd.append('files', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'фото.png');
  const msg = await api(A, 'POST', `/api/chats/${chatId}/messages`, fd);
  ok(msg.status === 201 && msg.data.attachments.length === 1 && msg.data.attachments[0].kind === 'image', 'отправлено сообщение с фото');
  ok(msg.data.attachments[0].fileName === 'фото.png', 'кириллица в имени файла сохранена');

  const got = await wsO.wait((e) => e.type === 'message:new' && e.message.id === msg.data.id);
  ok(got.message.text === 'Армирование захватки 3 готово', 'участник получил сообщение в реальном времени');

  const fileRes = await fetch(`${BASE}${msg.data.attachments[0].url}?token=${O}`);
  ok(fileRes.status === 200, 'участник может открыть фото');
  const fileDenied = await fetch(`${BASE}${msg.data.attachments[0].url}`);
  ok(fileDenied.status === 401, 'без входа фото не отдаётся');

  const chatsO = await api(O, 'GET', '/api/chats');
  const unreadBefore = chatsO.data.find((c) => c.id === chatId).unread;
  ok(unreadBefore >= 1, `у участника есть непрочитанные (${unreadBefore})`);

  const read = await api(O, 'POST', `/api/chats/${chatId}/read`, { upToId: msg.data.id });
  ok(read.status === 200 && read.data.marked >= 1, 'участник отметил прочтение');
  const rcpt = await wsA.wait((e) => e.type === 'message:receipts' && e.chatId === chatId && e.readerId === u1.data.id);
  ok(rcpt.receipts.some((r) => r.messageId === msg.data.id && r.readAt > 0), 'автор получил время прочтения в реальном времени');

  const list = await api(A, 'GET', `/api/messages/${msg.data.id}/receipts`);
  ok(list.data.read.length === 1 && list.data.notRead.includes(u2.data.id), 'список «прочитали / не прочитали» верный');

  const chatsO2 = await api(O, 'GET', '/api/chats');
  ok(chatsO2.data.find((c) => c.id === chatId).unread === 0, 'счётчик непрочитанных обнулился');

  const hist = await api(P, 'GET', `/api/chats/${chatId}/messages`);
  ok(hist.status === 200 && hist.data.some((m) => m.id === msg.data.id), 'история группы загружается');

  const kick = await api(O, 'DELETE', `/api/chats/${chatId}/members/${u2.data.id}`);
  ok(kick.status === 403, 'участник без прав не может исключать');

  const d = await api(O, 'POST', '/api/chats/direct', { userId: u2.data.id });
  const d2 = await api(P, 'POST', '/api/chats/direct', { userId: u1.data.id });
  ok(d.status === 200 && d.data.id === d2.data.id, 'личный чат создаётся один на пару');

  // Звонок: администратор → Ольга
  const callId = 'test-' + suffix;
  wsA.send({ type: 'call:invite', callId, toUserId: u1.data.id, video: true });
  const inc = await wsO.wait((e) => e.type === 'call:incoming' && e.callId === callId);
  ok(inc.video === true && inc.fromUserId === adm.data.user.id, 'входящий видеозвонок дошёл');
  wsO.send({ type: 'call:accept', callId });
  await wsA.wait((e) => e.type === 'call:accepted' && e.callId === callId);
  ok(true, 'звонок принят');
  wsA.send({ type: 'call:signal', callId, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  const sig = await wsO.wait((e) => e.type === 'call:signal' && e.callId === callId);
  ok(sig.data.sdp.type === 'offer', 'сигналинг WebRTC передаётся');
  await sleep(1100);
  wsO.send({ type: 'call:end', callId });
  await wsA.wait((e) => e.type === 'call:ended' && e.callId === callId);
  const callMsg = await wsA.wait((e) => e.type === 'message:new' && e.message.kind === 'call');
  const info = JSON.parse(callMsg.message.text);
  ok(info.outcome === 'completed' && info.video === true && info.duration >= 1, 'в чат записан итог звонка');

  // Звонок офлайн-сотруднику
  wsA.send({ type: 'call:invite', callId: callId + 'b', toUserId: u2.data.id, video: false });
  const off = await wsA.wait((e) => e.type === 'call:ended' && e.callId === callId + 'b');
  ok(off.reason === 'offline', 'звонок офлайн-сотруднику завершается сразу');

  wsA.ws.close();
  wsO.ws.close();
  console.log('\nВсе проверки пройдены.');
  process.exit(0);
})().catch((e) => {
  console.error('Ошибка теста:', e);
  process.exit(1);
});

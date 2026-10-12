// Проверка интерфейса в настоящем браузере (Chromium через Playwright).
// Два сотрудника: вход, группа, сообщение, время прочтения, видеозвонок с имитацией камеры.
// Запуск: BASE=http://localhost:8080 node test/ui-smoke.mjs  (нужен пакет playwright)
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8080';
const SHOTS = process.env.SHOTS || 'ui-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const pageErrors = [];
let browser;

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function step(name, fn) {
  try {
    await fn();
    results.push(['✓', name]);
    console.log('✓', name);
  } catch (e) {
    results.push(['✗', name + ': ' + e.message.split('\n')[0]]);
    console.error('✗', name, '\n', e.message);
    throw e;
  }
}

async function newUser(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', permissions: ['camera', 'microphone', 'notifications'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) pageErrors.push(`${label} console: ${m.text()}`); });
  return page;
}

async function login(page, loginName, password) {
  await page.goto(BASE + '/');
  await page.getByLabel('Логин').fill(loginName);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.getByRole('heading', { name: 'Чаты' }).waitFor({ timeout: 10000 });
}

function summary() {
  const lines = ['## Проверка интерфейса', '', ...results.map(([s, n]) => `- ${s} ${n}`)];
  if (pageErrors.length) lines.push('', '### Ошибки JavaScript', ...pageErrors.map((e) => `- ${e}`));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

(async () => {
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  const adm = await api(null, 'POST', '/api/login', { login: 'admin', password: 'admin' });
  const suffix = Date.now().toString(36).slice(-4);
  const olgaLogin = 'olga' + suffix;
  await api(adm.token, 'POST', '/api/users', { login: olgaLogin, name: 'Ольга Ким', position: 'Архитектор', password: 'secret1' });
  await api(adm.token, 'POST', '/api/users', { login: 'pavel' + suffix, name: 'Павел Зуев', position: 'Авторский надзор', password: 'secret2' });

  const A = await newUser('admin');
  const B = await newUser('olga');
  const groupTitle = 'Северный квартал · Корпус 2';
  const text = 'Армирование захватки 3 готово, приезжайте в 10';

  await step('администратор входит через форму', () => login(A, 'admin', 'admin'));
  await step('сотрудник входит через форму', () => login(B, olgaLogin, 'secret1'));

  await step('создание группы объекта с участником', async () => {
    await A.getByRole('button', { name: 'Новая группа объекта' }).click();
    await A.getByLabel('Название группы').fill(groupTitle);
    await A.getByRole('checkbox').first().waitFor();
    await A.locator('.picker-row', { hasText: 'Ольга Ким' }).locator('input').check();
    await A.getByRole('dialog').getByRole('button', { name: /Создать группу/ }).click();
    await A.getByRole('heading', { name: groupTitle }).waitFor({ timeout: 8000 });
  });

  await step('группа появилась у участника в реальном времени', async () => {
    await B.locator('.chat-item', { hasText: groupTitle }).waitFor({ timeout: 8000 });
  });

  await step('отправка сообщения по Enter', async () => {
    const box = A.getByLabel('Сообщение');
    await box.fill(text);
    await box.press('Enter');
    await A.locator('.bubble-mine', { hasText: text }).waitFor({ timeout: 8000 });
    await A.locator('.receipt-pill', { hasText: 'Прочитали 0 из 1' }).waitFor({ timeout: 5000 });
  });

  await step('у участника появился счётчик непрочитанных', async () => {
    await B.locator('.chat-item', { hasText: groupTitle }).locator('.badge', { hasText: '1' }).waitFor({ timeout: 8000 });
  });

  await step('участник открывает чат и видит сообщение', async () => {
    await B.locator('.chat-item', { hasText: groupTitle }).click();
    await B.locator('.bubble', { hasText: text }).waitFor({ timeout: 8000 });
  });

  await step('автор видит «Прочитали все 1» в реальном времени', async () => {
    await A.locator('.receipt-pill', { hasText: 'Прочитали все 1' }).waitFor({ timeout: 10000 });
  });

  await step('список «кто прочитал» показывает время', async () => {
    await A.locator('.receipt-pill').click();
    await A.locator('.popover-row', { hasText: 'Ольга Ким' }).locator('.mono').waitFor({ timeout: 5000 });
    const t = await A.locator('.popover-row', { hasText: 'Ольга Ким' }).locator('.mono').innerText();
    if (!/^\d\d:\d\d$/.test(t.trim())) throw new Error('Неожиданное время: ' + t);
    await A.screenshot({ path: `${SHOTS}/1-receipts.png` });
    await A.keyboard.press('Escape');
  });

  await step('счётчик непрочитанных у участника обнулился', async () => {
    await B.locator('.chat-item', { hasText: groupTitle }).locator('.badge').waitFor({ state: 'detached', timeout: 5000 });
  });

  await step('индикатор «печатает…»', async () => {
    await B.getByLabel('Сообщение').pressSequentially('Еду', { delay: 50 });
    await A.locator('.typing', { hasText: 'Ольга печатает' }).waitFor({ timeout: 5000 });
  });

  // ---------- Этап 1 ----------
  await step('ответ с цитатой и @упоминанием', async () => {
    const box = B.getByLabel('Сообщение');
    await box.fill('');
    await B.locator('.msg-row', { hasText: text }).hover();
    await B.locator('.msg-row', { hasText: text }).getByRole('button', { name: 'Ответить' }).click();
    await B.locator('.quote-bar').waitFor({ timeout: 3000 });
    await box.pressSequentially('@Адм', { delay: 30 });
    await B.locator('.suggest-row', { hasText: 'Администратор' }).waitFor({ timeout: 3000 });
    await box.press('Enter');
    await box.pressSequentially('принято, выезжаю', { delay: 10 });
    await box.press('Enter');
    const got = A.locator('.msg-row', { hasText: 'принято, выезжаю' });
    await got.locator('.reply-quote').waitFor({ timeout: 8000 });
    await got.locator('.mention-me').waitFor({ timeout: 3000 });
  });

  await step('«Важное» с подтверждением прочтения', async () => {
    const box = A.getByLabel('Сообщение');
    await box.click();
    await A.locator('.format-bar').getByRole('button', { name: 'Важное — с подтверждением прочтения' }).click();
    await box.fill('Приёмка переносится на понедельник');
    await box.press('Enter');
    const row = B.locator('.msg-row', { hasText: 'Приёмка переносится на понедельник' });
    await row.getByRole('button', { name: 'Подтвердить прочтение' }).click({ timeout: 8000 });
    await A.locator('.receipt-pill', { hasText: 'Подтвердили все 1' }).waitFor({ timeout: 8000 });
  });

  await step('опрос: создание и голосование', async () => {
    await A.getByRole('button', { name: 'Прикрепить и другие действия' }).click();
    await A.getByRole('menuitem', { name: 'Опрос' }).click();
    await A.getByLabel('Вопрос').fill('Бетон В30 в плите Пм-3?');
    await A.getByRole('dialog').getByRole('button', { name: 'Отправить опрос' }).click();
    const poll = B.locator('.poll', { hasText: 'Бетон В30 в плите Пм-3?' });
    await poll.locator('.poll-opt', { hasText: 'Да' }).click({ timeout: 8000 });
    await A.locator('.poll', { hasText: 'Бетон В30' }).locator('.card-foot', { hasText: 'Проголосовали 1' }).waitFor({ timeout: 8000 });
  });

  await step('задача через команду /задача и отметка «выполнено»', async () => {
    const box = B.getByLabel('Сообщение');
    await box.fill('/зад');
    await B.locator('.suggest-row', { hasText: '/задача' }).waitFor({ timeout: 3000 });
    await box.press('Enter');
    await B.getByLabel('Что сделать').fill('Проверить шаг арматуры у ядра');
    await B.getByLabel('Исполнитель').selectOption({ label: 'Администратор — Администратор системы' });
    await B.getByRole('dialog').getByRole('button', { name: 'Поставить задачу' }).click();
    await A.locator('.task', { hasText: 'Проверить шаг арматуры' }).waitFor({ timeout: 8000 });
    await A.getByRole('button', { name: 'Задачи' }).click();
    const item = A.locator('.task-item', { hasText: 'Проверить шаг арматуры' });
    await item.getByRole('button', { name: 'Отметить выполненной' }).click({ timeout: 8000 });
    await B.locator('.task-done', { hasText: 'Проверить шаг арматуры' }).waitFor({ timeout: 8000 });
    await A.getByRole('button', { name: 'Чаты' }).click();
    await A.locator('.chat-item', { hasText: groupTitle }).click();
  });

  await step('правка последнего сообщения по стрелке вверх', async () => {
    const box = A.getByLabel('Сообщение');
    await box.fill('Черновик сообщения');
    await box.press('Enter');
    await A.locator('.bubble-mine', { hasText: 'Черновик сообщения' }).waitFor({ timeout: 5000 });
    await box.click();
    await box.press('ArrowUp');
    await A.locator('.quote-bar', { hasText: 'Редактирование' }).waitFor({ timeout: 3000 });
    await box.fill('Исправленное сообщение');
    await box.press('Enter');
    await B.locator('.msg-row', { hasText: 'Исправленное сообщение' }).locator('.msg-time', { hasText: 'изменено' }).waitFor({ timeout: 8000 });
  });

  await step('голосовое сообщение', async () => {
    await A.getByLabel('Сообщение').fill('');
    await A.getByRole('button', { name: 'Записать голосовое' }).click();
    await A.locator('.voice-rec').waitFor({ timeout: 5000 });
    await A.waitForTimeout(1800);
    await A.getByRole('button', { name: 'Отправить голосовое' }).click();
    await B.locator('.voice').last().waitFor({ timeout: 10000 });
  });

  await step('поиск по чату и переход к сообщению', async () => {
    await B.getByRole('button', { name: 'Поиск по чату' }).click();
    await B.getByLabel('Искать в чате').fill('армирование');
    await B.locator('.search-row').first().click({ timeout: 8000 });
    await B.locator('.msg-flash').waitFor({ timeout: 5000 });
    await B.screenshot({ path: `${SHOTS}/5-phase1.png` });
    await B.getByRole('button', { name: 'Закрыть' }).first().click();
  });

  await step('видеозвонок: входящий вызов', async () => {
    await A.getByRole('button', { name: 'Сотрудники' }).click();
    await A.getByRole('button', { name: 'Видеозвонок: Ольга Ким' }).click();
    await B.getByRole('alertdialog', { name: 'Входящий звонок' }).waitFor({ timeout: 8000 });
    await B.screenshot({ path: `${SHOTS}/2-incoming.png` });
  });

  await step('видеозвонок: соединение установлено у обоих', async () => {
    await B.getByRole('button', { name: 'Ответить с видео' }).click();
    const timer = (p) => p.locator('.call .mono, .call .call-peer-status').filter({ hasText: /^\d+:\d\d$/ }).first().waitFor({ timeout: 15000 });
    await Promise.all([timer(A), timer(B)]);
    await A.waitForTimeout(1500);
    await A.screenshot({ path: `${SHOTS}/3-call.png` });
  });

  await step('видеозвонок: завершение и запись итога в чат', async () => {
    await A.getByRole('button', { name: 'Завершить звонок' }).click();
    await B.locator('.call').waitFor({ state: 'detached', timeout: 8000 });
    await A.locator('.chat-item', { hasText: 'Ольга Ким' }).first().click().catch(() => {});
    await A.getByRole('button', { name: 'Чаты' }).click();
    await A.locator('.chat-item', { hasText: 'Ольга Ким' }).click();
    await A.locator('.call-card', { hasText: 'Исходящий видеозвонок' }).waitFor({ timeout: 8000 });
    await A.screenshot({ path: `${SHOTS}/4-call-log.png` });
  });

  await step('нет ошибок JavaScript', async () => {
    if (pageErrors.length) throw new Error(pageErrors.join(' | '));
  });

  summary();
  await browser.close();
  console.log('\nИнтерфейс: все проверки пройдены.');
})().catch(async (e) => {
  summary();
  const msg = (results.find((r) => r[0] === '✗')?.[1] || e.message).replace(/\n/g, ' ');
  console.log(`::error title=Проверка интерфейса::${msg}${pageErrors.length ? ' | JS: ' + pageErrors.slice(0, 3).join(' | ') : ''}`);
  try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: `${SHOTS}/fail-admin.png` }); } catch { /* */ }
  try { await browser?.contexts()[1]?.pages()[0]?.screenshot({ path: `${SHOTS}/fail-olga.png` }); } catch { /* */ }
  await browser?.close();
  process.exit(1);
});

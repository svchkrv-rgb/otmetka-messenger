import express from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import selfsigned from 'selfsigned';
import { PORT, HTTPS_PORT, DATA_DIR, STATIC_DIR, MAX_UPLOAD_MB } from './config.js';
import { db, now, PALETTE } from './core.js';
import { router, filesRouter, multer, deliverScheduled } from './routes.js';
import { attachUpgrade } from './realtime.js';
import { callsRouter, livekitUpgrade, livekitHttp } from './calls-http.js';

// ---------- Первый администратор ----------
if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  const login = process.env.ADMIN_LOGIN || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';
  db.prepare('INSERT INTO users (login, name, position, password_hash, is_admin, color, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(login, 'Администратор', 'Администратор системы', bcrypt.hashSync(password, 10), PALETTE[0], now());
  console.log(`Создан администратор: логин «${login}», пароль «${password}». Смените пароль после входа.`);
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  // Клиент Tauri работает со своего адреса (tauri.localhost) — разрешаем запросы с любого origin.
  // Авторизация — токеном в заголовке, cookies не используются.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/rtc', livekitHttp);
app.use(express.json({ limit: '1mb' }));
app.use('/api', router);
app.use('/api', callsRouter);
app.use(filesRouter);

if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { index: false }));
  app.get(/^\/(?!api|files|avatars|ws|rtc).*/, (req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('Сервер «Отметка» работает. Веб-клиент не собран (нет client/dist).'));
}

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${MAX_UPLOAD_MB} МБ` : 'Ошибка загрузки файла' });
  }
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Внутренняя ошибка сервера' });
});

// ---------- Отложенные сообщения ----------
setInterval(() => {
  const due = db.prepare('SELECT * FROM scheduled WHERE send_at <= ? ORDER BY send_at LIMIT 50').all(now());
  for (const s of due) {
    try { deliverScheduled(s); } catch (e) { console.error('Отложенное сообщение', s.id, e); }
  }
}, 5000).unref();

// ---------- Запуск ----------
const httpServer = http.createServer(app);
attachUpgrade(httpServer, livekitUpgrade);
httpServer.listen(PORT, () => console.log(`«Отметка»: http://0.0.0.0:${PORT}`));

if (HTTPS_PORT) {
  // HTTPS нужен браузерам для доступа к камере и микрофону не с localhost. Клиент Tauri работает и по HTTP.
  const certFile = path.join(DATA_DIR, 'cert.pem');
  const keyFile = path.join(DATA_DIR, 'key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'otmetka.local' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private);
  }
  const httpsServer = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
  attachUpgrade(httpsServer, livekitUpgrade);
  httpsServer.listen(HTTPS_PORT, () => console.log(`«Отметка»: https://0.0.0.0:${HTTPS_PORT} (самоподписанный сертификат)`));
}

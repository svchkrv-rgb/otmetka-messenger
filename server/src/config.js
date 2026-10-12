import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseJson(value, fallback, name) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch {
    console.warn(`${name}: неверный JSON, использую значение по умолчанию`);
    return fallback;
  }
}

export const PORT = Number(process.env.PORT || 8080);
export const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
export const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', '..', 'client', 'dist'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
export const RING_TIMEOUT_MS = 45_000;
export const ICE_SERVERS = parseJson(process.env.ICE_SERVERS, [{ urls: 'stun:stun.l.google.com:19302' }], 'ICE_SERVERS');

// LiveKit — медиасервер групповых звонков (этап 3)
export const LIVEKIT_URL = process.env.LIVEKIT_URL || '';            // внутренний адрес, напр. http://livekit:7880
export const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
export const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

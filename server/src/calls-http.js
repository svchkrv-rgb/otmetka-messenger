// HTTP-часть групповых звонков (этап 3). Пока заглушка.
import express from 'express';

export const callsRouter = express.Router();
export const livekitHttp = (req, res) => res.status(404).json({ error: 'Групповые звонки не настроены' });
export const livekitUpgrade = () => false;

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router as apiRouter } from './routes/api.js';
import { startWorker, stopWorker } from './worker.js';
import { logger } from './logger.js';
import { ROOT } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/api', apiRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'internal', detail: err.message });
});

const port = Number(process.env.PORT) || 4100;
const server = app.listen(port, '127.0.0.1', () => {
  logger.info(`서버 시작: http://127.0.0.1:${port}`);
  startWorker();
});

function shutdown(signal) {
  logger.info(`종료 신호 수신: ${signal}`);
  stopWorker();
  server.close(() => {
    logger.info('서버 종료 완료');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

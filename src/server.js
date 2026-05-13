import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router as apiRouter } from './routes/api.js';
import { startWorker, stopWorker } from './worker.js';
import { logger } from './logger.js';
import { ROOT, loadConfig } from './config.js';
import { getProvider } from './ai/llm/provider.js';

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

async function precheckProvider() {
  try {
    const cfg = loadConfig();
    const provider = getProvider(cfg);
    if (provider.id === 'claude-cli') {
      const r = await provider.healthCheck();
      logger.info(`Claude CLI 연결됨 → ${r.version}`);
    } else {
      logger.info('AI provider: rule-based (built-in)');
    }
  } catch (err) {
    logger.warn('AI provider 사전 점검 실패. rule-based로 폴백 가능', { error: err.message });
  }
}

const port = Number(process.env.PORT) || 4100;
const server = app.listen(port, '127.0.0.1', () => {
  logger.info(`서버 시작: http://127.0.0.1:${port}`);
  precheckProvider().finally(() => startWorker());
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

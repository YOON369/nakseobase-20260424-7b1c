import fs from 'node:fs';
import path from 'node:path';
import { GNET_DIR } from './config.js';

const LOG_DIR = path.join(GNET_DIR, 'logs');
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

const RRN_RE = /\b\d{6}[-]\d{7}\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g;
const SECRET_KEYS = /^(secret|access|password|token|api[_-]?key|secret[_-]?key|access[_-]?key)$/i;

export function maskText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(RRN_RE, '[RRN]')
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(PHONE_RE, '[PHONE]');
}

export function maskObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return maskText(obj);
  if (Array.isArray(obj)) return obj.map(maskObject);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = maskObject(v);
      }
    }
    return out;
  }
  return obj;
}

function formatLine(level, msg, meta) {
  const ts = new Date().toISOString();
  const body = typeof msg === 'string' ? maskText(msg) : JSON.stringify(maskObject(msg));
  const metaStr = meta !== undefined ? ' ' + JSON.stringify(maskObject(meta)) : '';
  return `[${ts}] [${level}] ${body}${metaStr}`;
}

function writeLog(line) {
  try {
    ensureLogDir();
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + '\n');
  } catch {
    // ignore write errors
  }
}

export const logger = {
  info(msg, meta) {
    const line = formatLine('INFO', msg, meta);
    console.log(line);
    writeLog(line);
  },
  warn(msg, meta) {
    const line = formatLine('WARN', msg, meta);
    console.warn(line);
    writeLog(line);
  },
  error(msg, meta) {
    const line = formatLine('ERROR', msg, meta);
    console.error(line);
    writeLog(line);
  },
  debug(msg, meta) {
    if (!process.env.DEBUG) return;
    const line = formatLine('DEBUG', msg, meta);
    console.log(line);
    writeLog(line);
  },
};

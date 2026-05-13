import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const GNET_ROOT = path.join(ROOT, '.gnet');
export const GNET_DIR = path.join(GNET_ROOT, 'coupang-cs');
export const MISSIONS_DIR = path.join(GNET_ROOT, 'missions');

const CONFIG_PATH = path.join(GNET_DIR, 'config.json');
const EXAMPLE_PATH = path.join(GNET_DIR, 'config.example.json');

function ensureRuntime() {
  if (!fs.existsSync(GNET_DIR)) fs.mkdirSync(GNET_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  }
}

function deepMerge(a, b) {
  if (b === null || b === undefined) return a;
  if (typeof a !== 'object' || a === null) return b;
  if (typeof b !== 'object') return b;
  if (Array.isArray(b)) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (b[k] !== null && typeof b[k] === 'object' && !Array.isArray(b[k])) {
      out[k] = deepMerge(a[k] || {}, b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

export function loadConfig() {
  ensureRuntime();
  let data = {};
  if (fs.existsSync(CONFIG_PATH)) {
    data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } else if (fs.existsSync(EXAMPLE_PATH)) {
    data = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf-8'));
  }
  data.coupang = data.coupang || {};
  // env vars override secrets (and only secrets live in env)
  if (process.env.COUPANG_VENDOR_ID) data.coupang.vendorId = process.env.COUPANG_VENDOR_ID;
  data.coupang.accessKey = process.env.COUPANG_ACCESS_KEY || '';
  data.coupang.secretKey = process.env.COUPANG_SECRET_KEY || '';
  return data;
}

export function saveConfig(patch) {
  ensureRuntime();
  const current = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    : {};
  const merged = deepMerge(current, patch);
  // never persist secrets to config.json — they live only in .env
  if (merged.coupang) {
    delete merged.coupang.secretKey;
    delete merged.coupang.accessKey;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return loadConfig();
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 4) return '****';
  return '*'.repeat(Math.min(12, key.length - 4)) + key.slice(-4);
}

export function publicConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.coupang) {
    c.coupang.accessKey = c.coupang.accessKey ? maskKey(c.coupang.accessKey) : '';
    c.coupang.secretKey = c.coupang.secretKey ? maskKey(c.coupang.secretKey) : '';
  }
  return c;
}

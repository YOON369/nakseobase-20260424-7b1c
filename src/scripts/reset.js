// 로컬 데이터 초기화. config.json은 유지, sqlite + 로그만 제거.
import fs from 'node:fs';
import path from 'node:path';
import { GNET_DIR } from '../config.js';

const targets = [
  'data.sqlite',
  'data.sqlite-wal',
  'data.sqlite-shm',
  'data.sqlite-journal',
];

for (const t of targets) {
  const p = path.join(GNET_DIR, t);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log(`삭제: ${p}`);
  }
}

const logDir = path.join(GNET_DIR, 'logs');
if (fs.existsSync(logDir)) {
  for (const f of fs.readdirSync(logDir)) {
    fs.unlinkSync(path.join(logDir, f));
  }
  console.log(`로그 비움: ${logDir}`);
}

console.log('reset 완료');

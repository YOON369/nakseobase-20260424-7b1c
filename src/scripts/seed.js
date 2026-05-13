// 수동 동기화 + 분석. 서버 없이 한 번 돌릴 때 사용.
import { triggerRunNow } from '../worker.js';

const status = await triggerRunNow();
console.log(JSON.stringify(status, null, 2));
process.exit(0);

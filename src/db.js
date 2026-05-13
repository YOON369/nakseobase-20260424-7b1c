import path from 'node:path';
import Database from 'better-sqlite3';
import { GNET_DIR } from './config.js';

const DB_PATH = path.join(GNET_DIR, 'data.sqlite');

let db;

function migrate(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupang_inquiry_id TEXT UNIQUE NOT NULL,
      source_type TEXT NOT NULL,
      product_name TEXT,
      order_id_masked TEXT,
      customer_message TEXT NOT NULL,
      status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL,
      category TEXT,
      sentiment TEXT,
      risk_level TEXT,
      draft_reply TEXT,
      safety_flags TEXT,
      confidence REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (inquiry_id) REFERENCES inquiries(id)
    );

    CREATE TABLE IF NOT EXISTS reply_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      final_reply TEXT,
      approved_by TEXT,
      sent_at TEXT,
      result_status TEXT,
      error_message TEXT,
      FOREIGN KEY (inquiry_id) REFERENCES inquiries(id)
    );

    CREATE TABLE IF NOT EXISTS ip_guard_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registered_ip TEXT,
      current_ip TEXT,
      status TEXT,
      checked_at TEXT NOT NULL,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
    CREATE INDEX IF NOT EXISTS idx_inquiries_received ON inquiries(received_at);
    CREATE INDEX IF NOT EXISTS idx_ai_inquiry ON ai_reviews(inquiry_id);
    CREATE INDEX IF NOT EXISTS idx_reply_inquiry ON reply_actions(inquiry_id);
    CREATE INDEX IF NOT EXISTS idx_ipguard_checked ON ip_guard_logs(checked_at);
  `);
}

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

export function maskOrderId(orderId) {
  if (!orderId) return null;
  const s = String(orderId);
  if (s.length <= 4) return '****';
  return s.slice(0, 4) + '*'.repeat(Math.max(4, s.length - 8)) + s.slice(-4);
}

function nowIso() {
  return new Date().toISOString();
}

export const inquiriesDao = {
  upsertNew(raw) {
    const conn = getDb();
    const existing = conn
      .prepare('SELECT id FROM inquiries WHERE coupang_inquiry_id = ?')
      .get(raw.coupangInquiryId);
    if (existing) return { id: existing.id, isNew: false };
    const info = conn
      .prepare(
        `INSERT INTO inquiries
          (coupang_inquiry_id, source_type, product_name, order_id_masked,
           customer_message, status, received_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      )
      .run(
        raw.coupangInquiryId,
        raw.sourceType,
        raw.productName || null,
        maskOrderId(raw.orderId),
        raw.customerMessage,
        raw.receivedAt || nowIso(),
        nowIso(),
        nowIso(),
      );
    return { id: info.lastInsertRowid, isNew: true };
  },

  list({ status, limit = 100 } = {}) {
    const conn = getDb();
    const where = status ? 'WHERE i.status = ?' : '';
    const params = status ? [status, limit] : [limit];
    return conn
      .prepare(
        `SELECT i.*, r.category, r.risk_level, r.draft_reply, r.safety_flags, r.confidence
           FROM inquiries i
           LEFT JOIN ai_reviews r ON r.id = (
             SELECT id FROM ai_reviews WHERE inquiry_id = i.id ORDER BY id DESC LIMIT 1
           )
           ${where}
           ORDER BY i.received_at DESC
           LIMIT ?`,
      )
      .all(...params);
  },

  get(id) {
    const conn = getDb();
    const inquiry = conn.prepare('SELECT * FROM inquiries WHERE id = ?').get(id);
    if (!inquiry) return null;
    const review = conn
      .prepare('SELECT * FROM ai_reviews WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1')
      .get(id);
    const actions = conn
      .prepare('SELECT * FROM reply_actions WHERE inquiry_id = ? ORDER BY id DESC')
      .all(id);
    return { inquiry, review, actions };
  },

  listNeedingAnalysis() {
    const conn = getDb();
    return conn.prepare("SELECT * FROM inquiries WHERE status = 'new'").all();
  },

  setStatus(id, status) {
    const conn = getDb();
    conn
      .prepare('UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  },

  countByStatus(status) {
    const conn = getDb();
    return conn
      .prepare('SELECT COUNT(*) AS n FROM inquiries WHERE status = ?')
      .get(status).n;
  },

  countNewToday() {
    const conn = getDb();
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    return conn
      .prepare('SELECT COUNT(*) AS n FROM inquiries WHERE received_at >= ?')
      .get(since.toISOString()).n;
  },

  countUrgent24h() {
    const conn = getDb();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return conn
      .prepare(
        `SELECT COUNT(*) AS n FROM inquiries
         WHERE received_at <= ? AND status NOT IN ('sent', 'on_hold')`,
      )
      .get(cutoff).n;
  },

  countRisky() {
    const conn = getDb();
    return conn
      .prepare(
        `SELECT COUNT(DISTINCT i.id) AS n
           FROM inquiries i
           JOIN ai_reviews r ON r.inquiry_id = i.id
          WHERE r.risk_level = 'high'
            AND i.status NOT IN ('sent', 'on_hold')`,
      )
      .get().n;
  },
};

export const aiReviewsDao = {
  insert(inquiryId, review) {
    const conn = getDb();
    conn
      .prepare(
        `INSERT INTO ai_reviews
          (inquiry_id, category, sentiment, risk_level, draft_reply, safety_flags, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inquiryId,
        review.category,
        review.sentiment,
        review.riskLevel,
        review.draftReply,
        JSON.stringify(review.safetyFlags || []),
        review.confidence,
        nowIso(),
      );
  },
};

export const replyActionsDao = {
  insert(inquiryId, action) {
    const conn = getDb();
    conn
      .prepare(
        `INSERT INTO reply_actions
          (inquiry_id, action_type, final_reply, approved_by, sent_at, result_status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inquiryId,
        action.actionType,
        action.finalReply || null,
        action.approvedBy || null,
        action.sentAt || null,
        action.resultStatus || null,
        action.errorMessage || null,
      );
  },
};

export const ipGuardLogsDao = {
  insert(entry) {
    const conn = getDb();
    conn
      .prepare(
        `INSERT INTO ip_guard_logs (registered_ip, current_ip, status, checked_at, error_message)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.registeredIp || null,
        entry.currentIp || null,
        entry.status,
        nowIso(),
        entry.errorMessage || null,
      );
  },
  latest() {
    const conn = getDb();
    return conn.prepare('SELECT * FROM ip_guard_logs ORDER BY id DESC LIMIT 1').get();
  },
};

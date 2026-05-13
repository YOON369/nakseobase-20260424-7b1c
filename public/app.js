// 쿠팡 로컬 AI CS 대시보드 (vanilla JS)

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw await toErr(r);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw await toErr(r);
    return r.json();
  },
  async patch(path, body) {
    const r = await fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await toErr(r);
    return r.json();
  },
};

async function toErr(res) {
  let body = null;
  try { body = await res.json(); } catch {}
  const err = new Error(body?.detail || body?.error || `HTTP ${res.status}`);
  err.body = body;
  return err;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

const RISK_LABEL = { low: '낮음', medium: '보통', high: '높음' };
const STATUS_LABEL = {
  new: '신규',
  analyzed: '분석됨',
  awaiting_approval: '승인 대기',
  on_hold: '보류',
  sent: '전송됨',
  failed: '실패',
};

let selectedId = null;

async function refreshAll() {
  await Promise.all([refreshStats(), refreshList(), refreshIpGuard(), refreshWorker()]);
}

async function refreshStats() {
  const s = await api.get('/api/dashboard/stats');
  const cards = [
    { label: '오늘 새 문의', value: s.newToday, kind: '' },
    { label: '미답변', value: s.unanswered, kind: '' },
    { label: 'AI 초안 완료', value: s.draftsReady, kind: '' },
    { label: '승인 필요', value: s.awaitingApproval, kind: '' },
    { label: '위험 문의', value: s.risky, kind: s.risky > 0 ? 'warning' : '' },
    { label: '24h 임박', value: s.urgent24h, kind: s.urgent24h > 0 ? 'warning' : '' },
    { label: '보류', value: s.onHold, kind: '' },
    { label: '전송됨', value: s.sent, kind: s.sent > 0 ? 'ok' : '' },
  ];
  const root = document.getElementById('stats');
  root.innerHTML = '';
  for (const c of cards) {
    root.appendChild(
      el(`<div class="stat-card ${c.kind}"><div class="label">${escapeHtml(c.label)}</div><div class="value">${c.value}</div></div>`),
    );
  }
}

async function refreshList() {
  const status = document.getElementById('status-filter').value;
  const items = await api.get('/api/inquiries' + (status ? `?status=${status}` : ''));
  const root = document.getElementById('inquiries');
  root.innerHTML = '';
  root.appendChild(
    el(
      `<div class="row header">
        <div>카테고리</div><div>요약</div><div>위험도</div>
        <div>상태</div><div>접수</div><div>AI 초안</div>
      </div>`,
    ),
  );
  if (items.length === 0) {
    root.appendChild(el(`<div class="row" style="cursor:default">표시할 문의가 없습니다.</div>`));
    return;
  }
  for (const it of items) {
    const risk = it.riskLevel || '-';
    const row = el(
      `<div class="row" data-id="${it.id}">
        <div class="meta">${escapeHtml(it.category || '미분류')}</div>
        <div class="excerpt" title="${escapeHtml(it.customerMessage || '')}">
          <strong>${escapeHtml(it.productName || '-')}</strong> · ${escapeHtml(it.customerMessageExcerpt || '')}
        </div>
        <div class="risk-${risk}">${escapeHtml(RISK_LABEL[risk] || '-')}</div>
        <div>${escapeHtml(STATUS_LABEL[it.status] || it.status)}</div>
        <div class="meta">${escapeHtml(fmtDate(it.receivedAt))}</div>
        <div class="meta">${it.draftReply ? '있음' : '없음'}</div>
      </div>`,
    );
    row.addEventListener('click', () => showDetail(it.id));
    root.appendChild(row);
  }
}

async function showDetail(id) {
  selectedId = id;
  const card = document.getElementById('detail-card');
  const body = document.getElementById('detail-body');
  card.hidden = false;
  body.innerHTML = '불러오는 중…';

  let data;
  try {
    data = await api.get(`/api/inquiries/${id}`);
  } catch (err) {
    body.innerHTML = `<div class="toast error">${escapeHtml(err.message)}</div>`;
    return;
  }

  const { inquiry, review, actions } = data;
  document.getElementById('detail-title').textContent =
    `문의 #${inquiry.id} · ${inquiry.productName || ''}`;

  const flagsHtml = (review?.safetyFlags || [])
    .map((f) => {
      const danger = ['LEGAL_THREAT', 'PRIVACY_EXPOSURE', 'REFUND_PROMISE', 'COMPENSATION_PROMISE', 'POLICY_CONFLICT'].includes(f);
      return `<span class="flag-pill ${danger ? 'danger' : ''}">${escapeHtml(f)}</span>`;
    })
    .join('');

  const draft = review?.draftReply || '';
  const charLimit = 1000;

  body.innerHTML = `
    <div class="detail-section">
      <h3>고객 문의 원문</h3>
      <div class="original">${escapeHtml(inquiry.customerMessage)}</div>
      <div class="meta" style="margin-top:6px;color:#5b6175;font-size:12px;">
        주문 ${escapeHtml(inquiry.orderIdMasked || '-')} · 접수 ${escapeHtml(fmtDate(inquiry.receivedAt))} ·
        상태 <strong>${escapeHtml(STATUS_LABEL[inquiry.status] || inquiry.status)}</strong>
      </div>
    </div>
    <div class="detail-section">
      <h3>AI 분석 결과</h3>
      <div>카테고리: <strong>${escapeHtml(review?.category || '-')}</strong>
        · 감정: ${escapeHtml(review?.sentiment || '-')}
        · 위험도: <span class="risk-${review?.riskLevel || '-'}">${escapeHtml(RISK_LABEL[review?.riskLevel] || '-')}</span>
        · 확신도: ${review?.confidence ?? '-'}
      </div>
      <div class="flags" style="margin-top:6px;">${flagsHtml || '<span class="meta">플래그 없음</span>'}</div>
    </div>
    <div class="detail-section draft-edit">
      <h3>AI 답변 초안 (운영자 수정 가능)</h3>
      <textarea id="draft-text" maxlength="${charLimit}">${escapeHtml(draft)}</textarea>
      <div class="charcount" id="charcount">0 / ${charLimit}</div>
      <div class="actions">
        <button class="btn primary" data-action="approve">승인 후 답변 전송</button>
        <button class="btn" data-action="hold">보류</button>
        <button class="btn danger" data-action="direct">직접 답변 (high risk)</button>
        <button class="btn ghost" data-action="reanalyze">재분석</button>
      </div>
    </div>
    <div class="detail-section">
      <h3>액션 로그</h3>
      <div class="meta">${actions.length === 0 ? '아직 기록 없음' : ''}</div>
      ${actions
        .map(
          (a) =>
            `<div style="font-size:12px;padding:6px 0;border-top:1px solid #eef0f5;">
              <strong>${escapeHtml(a.actionType)}</strong> · ${escapeHtml(a.resultStatus || '-')} ·
              ${escapeHtml(fmtDate(a.sentAt))} · ${escapeHtml(a.approvedBy || '-')}
              ${a.errorMessage ? `<div style="color:#c0392b;">${escapeHtml(a.errorMessage)}</div>` : ''}
            </div>`,
        )
        .join('')}
    </div>
  `;

  const textarea = document.getElementById('draft-text');
  const counter = document.getElementById('charcount');
  function updateCount() { counter.textContent = `${textarea.value.length} / ${charLimit}`; }
  textarea.addEventListener('input', updateCount);
  updateCount();

  body.querySelectorAll('[data-action]').forEach((btn) =>
    btn.addEventListener('click', () => runAction(btn.dataset.action, id)),
  );
}

async function runAction(action, id) {
  const textarea = document.getElementById('draft-text');
  const reply = textarea ? textarea.value : '';
  try {
    if (action === 'approve') {
      const r = await api.post(`/api/inquiries/${id}/approve`, { reply });
      toast(r.mock ? 'mock 모드로 전송 완료' : '쿠팡에 답변 전송 완료', 'success');
    } else if (action === 'direct') {
      if (!confirm('직접 답변(direct)으로 전송합니다. 계속할까요?')) return;
      const r = await api.post(`/api/inquiries/${id}/direct`, { reply });
      toast(r.mock ? 'mock 모드로 전송 완료' : '쿠팡에 답변 전송 완료', 'success');
    } else if (action === 'hold') {
      await api.post(`/api/inquiries/${id}/hold`, {});
      toast('보류 처리 완료', 'success');
    } else if (action === 'reanalyze') {
      await api.post(`/api/inquiries/${id}/reanalyze`, {});
      toast('재분석 완료', 'success');
    }
  } catch (err) {
    const flags = err.body?.flags ? ` [${err.body.flags.join(', ')}]` : '';
    toast(`${err.message}${flags}`, 'error');
    return;
  }
  await Promise.all([refreshAll(), showDetail(id)]);
}

async function refreshIpGuard() {
  const s = await api.get('/api/ip-guard/status');
  const cfg = await api.get('/api/config');
  const root = document.getElementById('ip-guard');
  const pillClass =
    s.status === 'OK' ? 'status-ok' : s.status === 'BLOCKED' ? 'status-blocked' : 'status-unknown';
  root.innerHTML = `
    <div class="row"><span class="label">Status</span><span class="status-pill ${pillClass}">${escapeHtml(s.status)}</span></div>
    <div class="row"><span class="label">Registered IP</span><span>${escapeHtml(s.registeredIp || '미설정')}</span></div>
    <div class="row"><span class="label">Current IP</span><span>${escapeHtml(s.currentIp || '-')}</span></div>
    <div class="row"><span class="label">Checked</span><span>${escapeHtml(fmtDate(s.checkedAt))}</span></div>
    ${s.errorMessage ? `<div style="margin-top:6px;color:#c0392b;font-size:12px;">${escapeHtml(s.errorMessage)}</div>` : ''}
    <div style="margin-top:6px;font-size:12px;color:#5b6175;">실제 API 모드: ${cfg.coupang?.apiEnabled ? '활성' : '비활성'}</div>
  `;
  document.getElementById('mode-badge').textContent =
    `mode: ${cfg.mode || 'mock'} · ai: ${cfg.ai?.provider || 'rule-based'}${cfg.coupang?.apiEnabled ? ' · apiEnabled' : ''}`;
}

async function refreshWorker() {
  const w = await api.get('/api/worker/status');
  const root = document.getElementById('worker-status');
  root.innerHTML = `
    <div class="row"><span class="label">Running</span><span>${w.running ? 'Yes' : 'No'}</span></div>
    <div class="row"><span class="label">Last Sync</span><span>${escapeHtml(fmtDate(w.lastSyncAt))}</span></div>
    <div class="row"><span class="label">Run Count</span><span>${w.runCount}</span></div>
    ${w.lastError ? `<div style="margin-top:6px;color:#c0392b;font-size:12px;">${escapeHtml(w.lastError)}</div>` : ''}
    ${w.lastBatchStats ? `<div style="margin-top:6px;font-size:12px;color:#5b6175;">최근 배치: fetched ${w.lastBatchStats.fetched} / inserted ${w.lastBatchStats.inserted} / analyzed ${w.lastBatchStats.analyzed}</div>` : ''}
  `;
}

async function refreshMission() {
  let missions = [];
  try { missions = await api.get('/api/missions'); } catch {}
  const root = document.getElementById('mission');
  if (missions.length === 0) {
    root.innerHTML = '<span class="meta">미션 정보 없음</span>';
    return;
  }
  const m = missions[0];
  root.innerHTML = `
    <div><strong>${escapeHtml(m.title || '')}</strong></div>
    <div style="margin-top:4px;">${escapeHtml(m.summary || '')}</div>
    ${m.principles ? `<div style="margin-top:6px;font-size:12px;color:#5b6175;">원칙</div><ul class="principles">${m.principles.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
    ${m.agents ? `<div style="font-size:12px;color:#5b6175;">에이전트</div><ul class="agents">${m.agents.map((a) => `<li>${escapeHtml(a.name)} – ${escapeHtml(a.role)}</li>`).join('')}</ul>` : ''}
  `;
}

document.getElementById('run-now-btn').addEventListener('click', async () => {
  try {
    await api.post('/api/worker/run-now');
    toast('동기화 실행 완료', 'success');
    await refreshAll();
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('ip-check-btn').addEventListener('click', async () => {
  try {
    await api.post('/api/ip-guard/check');
    await refreshIpGuard();
    toast('IP Guard 갱신', 'success');
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('status-filter').addEventListener('change', refreshList);

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-card').hidden = true;
  selectedId = null;
});

// ---- 설정 모달 ----

const configModal = document.getElementById('config-modal');

document.getElementById('config-btn').addEventListener('click', async () => {
  const cfg = await api.get('/api/config');
  const form = document.getElementById('config-form');
  form.mode.value = cfg.mode || 'mock';
  form.pollIntervalMinutes.value = cfg.pollIntervalMinutes ?? 5;
  form.ipGuardIntervalMinutes.value = cfg.ipGuardIntervalMinutes ?? 1;
  form['coupang.vendorId'].value = cfg.coupang?.vendorId || '';
  form['coupang.registeredIp'].value = cfg.coupang?.registeredIp || '';
  form['coupang.apiEnabled'].checked = !!cfg.coupang?.apiEnabled;
  form['safety.requireApprovalForAll'].checked = cfg.safety?.requireApprovalForAll !== false;
  form['safety.blockHighRisk'].checked = cfg.safety?.blockHighRisk !== false;
  form['safety.maxReplyLength'].value = cfg.safety?.maxReplyLength ?? 1000;
  form['ai.provider'].value = cfg.ai?.provider || 'claude-cli';
  form['ai.fallbackToRules'].checked = cfg.ai?.fallbackToRules !== false;
  form['ai.claudeCli.binary'].value = cfg.ai?.claudeCli?.binary || 'claude';
  form['ai.claudeCli.model'].value = cfg.ai?.claudeCli?.model || '';
  form['ai.claudeCli.timeoutSeconds'].value = cfg.ai?.claudeCli?.timeoutSeconds ?? 60;
  form['ai.claudeCli.maskPiiBeforeSending'].checked = cfg.ai?.claudeCli?.maskPiiBeforeSending !== false;
  document.getElementById('key-status').textContent =
    `accessKey: ${cfg.coupang?.accessKey || '(미설정)'} · secretKey: ${cfg.coupang?.secretKey || '(미설정)'}`;
  document.getElementById('ai-check-status').textContent = '';
  configModal.hidden = false;
});

document.getElementById('ai-check-btn').addEventListener('click', async () => {
  const target = document.getElementById('ai-check-status');
  target.textContent = '점검 중…';
  try {
    const r = await api.get('/api/ai/check?provider=claude-cli');
    target.textContent = `OK · ${r.version || ''}`;
    target.style.color = '#1f7a47';
  } catch (err) {
    target.textContent = `FAIL · ${err.message}`;
    target.style.color = '#c0392b';
  }
});

document.getElementById('config-close').addEventListener('click', () => {
  configModal.hidden = true;
});

document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    mode: form.mode.value,
    pollIntervalMinutes: Number(form.pollIntervalMinutes.value),
    ipGuardIntervalMinutes: Number(form.ipGuardIntervalMinutes.value),
    coupang: {
      vendorId: form['coupang.vendorId'].value,
      registeredIp: form['coupang.registeredIp'].value,
      apiEnabled: form['coupang.apiEnabled'].checked,
    },
    safety: {
      requireApprovalForAll: form['safety.requireApprovalForAll'].checked,
      blockHighRisk: form['safety.blockHighRisk'].checked,
      maxReplyLength: Number(form['safety.maxReplyLength'].value),
    },
    ai: {
      provider: form['ai.provider'].value,
      fallbackToRules: form['ai.fallbackToRules'].checked,
      claudeCli: {
        binary: form['ai.claudeCli.binary'].value || 'claude',
        model: form['ai.claudeCli.model'].value || null,
        timeoutSeconds: Number(form['ai.claudeCli.timeoutSeconds'].value) || 60,
        maskPiiBeforeSending: form['ai.claudeCli.maskPiiBeforeSending'].checked,
      },
    },
  };
  try {
    await api.patch('/api/config', payload);
    toast('설정 저장 완료', 'success');
    configModal.hidden = true;
    await Promise.all([refreshIpGuard(), refreshList()]);
  } catch (err) { toast(err.message, 'error'); }
});

// ---- 초기 로드 + 폴링 ----

(async () => {
  try {
    await Promise.all([refreshAll(), refreshMission()]);
  } catch (err) {
    toast(err.message, 'error');
  }
})();

setInterval(() => {
  refreshStats().catch(() => {});
  refreshWorker().catch(() => {});
  refreshIpGuard().catch(() => {});
  if (!selectedId) refreshList().catch(() => {});
}, 15000);

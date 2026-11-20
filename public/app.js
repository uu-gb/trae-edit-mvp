'use strict';

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const backdrop = $('backdrop');
const highlights = $('highlights');

let state = null;
let config = null;
let busy = false;

/* ---------- 基础 ---------- */

async function api(path, body) {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  return res.json();
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

async function withBusy(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { toast('请求失败: ' + e.message); }
  finally { busy = false; }
}

/* ---------- 选区 / 授权 ---------- */

function selRange() {
  const s = editor.selectionStart, e = editor.selectionEnd;
  return s < e ? { start: s, end: e } : null;
}

function updateSelHint() {
  const r = selRange();
  $('selHint').textContent = r
    ? `已选中 [${r.start}, ${r.end}) 共 ${r.end - r.start} 字符 — 点击「授权当前选区」加入授权区`
    : '在文档中选中一段文字，然后点击「授权当前选区」';
}

async function authorize(ranges) {
  const r = await api('/api/authorize', { ranges });
  if (r.ok) { toast(`授权区已更新：${r.authorizedRanges.length} 个区间`); await refresh(); }
  else toast(r.error || '授权失败');
}

$('btnAuthSel').onclick = () => withBusy(async () => {
  const r = selRange();
  if (!r) return toast('请先在文档中选中一段文字');
  authorize([...state.authorizedRanges, r]);
});

$('btnAuthPara').onclick = () => withBusy(async () => {
  const t = state.content;
  const blank = t.indexOf('\n\n');
  const end = blank === -1 ? t.length : blank;
  authorize([...state.authorizedRanges, { start: 0, end }]);
});

$('btnAuthAll').onclick = () => withBusy(async () => {
  authorize([...state.authorizedRanges, { start: 0, end: state.content.length }]);
});

$('btnClearAuth').onclick = () => withBusy(async () => {
  await api('/api/authorize', { ranges: [] });
  await refresh();
  toast('授权区已清空');
});

$('btnSave').onclick = () => withBusy(async () => {
  const r = await api('/api/doc', { content: editor.value, reason: '手动编辑' });
  if (r.ok) {
    toast(`已保存 v${r.version}${r.rangesCleared ? '（文档变化使授权区失效，已清空）' : ''}`);
    await refresh();
  } else toast(r.error || '保存失败');
});

/* ---------- Agent / 应用 / 回滚 ---------- */

$('btnRun').onclick = () => withBusy(async () => {
  const instruction = $('instruction').value.trim();
  if (!instruction) return toast('请输入修改指令');
  const provider = $('provider').value;
  const r = await api('/api/agent/run', { instruction, provider });
  if (r.error) return renderGatewayError(r);
  await refresh();
  toast(`已生成预览（${r.changeset.changes.length} 处修改，${r.changeset.latencyMs}ms）`);
});

async function apply(force) {
  const r = await api('/api/apply', { force });
  if (r.error) return toast(r.error);
  if (r.blocked) {
    toast(r.message);
  } else {
    toast(`已应用 v${r.applied.version}` + (r.relocated ? `（${r.relocatedCount} 处因文档变化已自动重定位）` : ''));
  }
  await refresh();
}

function rollback(v) {
  return withBusy(async () => {
    const r = await api('/api/rollback', { version: v });
    if (r.error) return toast(r.error);
    toast(`已回滚到 v${r.restoredFrom}（新版本 v${r.version}，历史保留）`);
    await refresh();
  });
}

/* ---------- 渲染 ---------- */

function buildHighlights() {
  if (!state) return '';
  const marks = [];
  for (const r of state.authorizedRanges) marks.push({ ...r, cls: 'auth' });
  if (state.pending) {
    for (const c of state.pending.changeset.changes || []) marks.push({ start: c.start, end: c.end, cls: 'pending' });
  }
  marks.sort((a, b) => a.start - b.start);
  const text = state.content;
  let html = '';
  let cur = 0;
  for (const m of marks) {
    if (m.start < cur || m.end <= m.start) continue;
    if (m.start > cur) html += esc(text.slice(cur, m.start));
    html += `<mark class="${m.cls}">${esc(text.slice(m.start, m.end))}</mark>`;
    cur = m.end;
  }
  html += esc(text.slice(cur));
  return html;
}

function renderEditor() {
  if (editor.value !== state.content && document.activeElement !== editor) {
    editor.value = state.content;
  }
  highlights.innerHTML = buildHighlights();
  $('docMeta').textContent = `${state.content.length} 字符`;
}

function renderChips() {
  const wrap = $('rangeChips');
  if (!wrap) return;
  wrap.innerHTML = '';
  $('rangesEmpty').hidden = state.authorizedRanges.length > 0;
  for (const [i, r] of state.authorizedRanges.entries()) {
    const chip = document.createElement('div');
    chip.className = 'range-chip';
    const label = document.createElement('span');
    label.textContent = `[${r.start}, ${r.end}) ${state.content.slice(r.start, r.end).slice(0, 12).replace(/\n/g, '⏎')}…`;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.onclick = () => withBusy(async () => {
      const next = state.authorizedRanges.filter((_, j) => j !== i);
      await api('/api/authorize', { ranges: next });
      await refresh();
    });
    chip.append(label, btn);
    wrap.appendChild(chip);
  }
}

function renderPreview() {
  const card = $('previewCard');
  const body = $('previewBody');
  const p = state.pending;
  if (!p) {
    card.hidden = true;
    body.innerHTML = '';
    return;
  }
  card.hidden = false;
  const cs = p.changeset;
  const parts = [];
  $('previewStatus').textContent = `pending · base v${cs.baseVersion} · ${cs.provider}/${cs.model}`;

  if (p.status === 'conflict') {
    parts.push(`<div class="banner err"><b>冲突拦截（不可强制）</b><br>文档在生成后被修改，且授权区内找不到原文：
      <ul>${p.report.conflicts.map((c) => `<li>[${c.at}] ${esc(c.reason)}</li>`).join('')}</ul>
      请点击「重新生成」按当前文档重新运行 Agent。</div>`);
  }

  if (p.status === 'blocked' && p.validation) {
    parts.push(`<div class="banner err"><b>护栏拦截（可强制）</b><ul>
      ${p.validation.violations.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></div>`);
  }

  if (p.status === 'preview' || p.status === 'blocked' || p.status === 'conflict') {
    if (cs.policy?.violations?.length) {
      parts.push(`<div class="banner warn"><b>策略预警</b><ul>${cs.policy.violations.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></div>`);
    }
    if (cs.policy?.warnings?.length) {
      parts.push(`<div class="banner warn">${cs.policy.warnings.map(esc).join('<br>')}</div>`);
    }
    if (cs.note) parts.push(`<div class="banner ok">模型备注：${esc(cs.note)}</div>`);

    parts.push(`<div class="diff-meta muted">覆盖率 ${(cs.policy.coverage * 100).toFixed(1)}% / 上限 50%</div>
      <div class="coverage-bar"><div style="width:${Math.min(100, cs.policy.coverage * 100)}%" class="${cs.policy.coverage > 0.5 ? 'hot' : ''}"></div></div>`);

    for (const [i, c] of (cs.changes || []).entries()) {
      parts.push(`<div class="diff-block">
        <div class="diff-meta">#${i + 1} [${c.start}, ${c.end}) → 替换为 ${c.newText.length} 字符</div>
        <div class="diff-text">${diffHtml(c.oldText, c.newText)}</div>
      </div>`);
    }

    if (cs.dropped?.length) {
      parts.push(`<div class="banner warn">已丢弃 ${cs.dropped.length} 条非法修改：<ul>${cs.dropped.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`);
    }

    parts.push(`<details><summary>协议原文（统一格式）</summary><pre>${esc(JSON.stringify({ protocolVersion: cs.protocolVersion, baseVersion: cs.baseVersion, changes: cs.changes, note: cs.note }, null, 2))}</pre></details>`);
  }

  const btns = ['<div class="btn-row">'];
  if (p.status === 'preview') {
    btns.push('<button class="primary" id="btnApply">应用修改</button>');
  }
  if (p.status === 'blocked') {
    btns.push('<button class="danger" id="btnForce">仍要强制应用</button>');
  }
  if (p.status === 'conflict') {
    btns.push('<button class="primary" id="btnRerun">按当前文档重新生成</button>');
  }
  btns.push('<button class="ghost" id="btnReject">拒绝</button></div>');
  parts.push(btns.join(''));

  body.innerHTML = parts.join('');
  const bApply = $('btnApply'), bForce = $('btnForce'), bReject = $('btnReject'), bRerun = $('btnRerun');
  if (bApply) bApply.onclick = () => withBusy(() => apply(false));
  if (bForce) bForce.onclick = () => withBusy(() => apply(true));
  if (bReject) bReject.onclick = () => withBusy(async () => { await api('/api/apply/reject'); await refresh(); toast('已拒绝'); });
  if (bRerun) bRerun.onclick = () => $('btnRun').onclick();
}

function renderGatewayError(r) {
  const card = $('previewCard');
  card.hidden = false;
  $('previewStatus').textContent = 'error';
  $('previewBody').innerHTML =
    `<div class="banner err"><b>网关错误</b><br>${esc(r.error)}</div>` +
    (r.rawSnippet ? `<details><summary>模型原始输出（截断）</summary><pre>${esc(r.rawSnippet)}</pre></details>` : '');
}

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  for (const h of [...state.history].reverse()) {
    const item = document.createElement('div');
    item.className = 'hist-item';
    const who = h.op?.actor === 'ai' ? 'AI' : '手动';
    item.innerHTML = `
      <span class="v">v${h.v}</span>
      <span class="who ${who === 'AI' ? 'ai' : 'user'}">${who}</span>
      <span class="why" title="${esc(h.op?.reason || '')}">${esc(h.op?.reason || '')}</span>
      <span class="muted">${h.contentLen} 字符</span>`;
    if (h.v !== state.version) {
      const btn = document.createElement('button');
      btn.textContent = '回滚到此';
      btn.onclick = () => rollback(h.v);
      item.appendChild(btn);
    } else {
      const cur = document.createElement('span');
      cur.className = 'muted';
      cur.textContent = '当前';
      item.appendChild(cur);
    }
    list.appendChild(item);
  }
}

function renderStatus() {
  $('chipVersion').textContent = 'v' + state.version;
  $('chipRanges').textContent = `授权区 ${state.authorizedRanges.length} 个`;
  const prov = config?.trae?.configured ? `trae(${config.trae.model})`
    : config?.openai?.configured ? `openai(${config.openai.model})`
    : 'mock';
  $('chipProvider').textContent = 'provider: ' + prov + ' + mock';
  const last = state.oplog[state.oplog.length - 1];
  $('statusLeft').textContent = last
    ? `最近操作：${last.actor === 'ai' ? 'AI' : '用户'} · ${last.action} · ${last.reason}`
    : '暂无操作';
}

function renderProviderHint() {
  const o = config?.openai;
  const t = config?.trae;
  let html = '';
  if (t?.configured) {
    html = `trae provider：TRAE CLI 已安装，沙箱 ${esc(t.sandbox)}`;
    html += t.login?.loggedIn
      ? '，登录正常'
      : '，<b>未登录</b> — 首次使用请先在终端 <code>traecli login</code>（或设 <code>TRAECLI_PERSONAL_ACCESS_TOKEN</code> 后 <code>traecli login --with-trae-pat</code>），再重启服务器';
  } else {
    html = 'trae provider 未检测到 TRAE CLI（安装：irm https://trae.cn/trae-cli/install_v2.ps1 | iex）。';
  }
  html += '<br>' + (o?.configured
    ? `openai 兼容端点已配置：${esc(o.model)} @ ${esc(o.endpoint)}`
    : 'openai provider 未配置（OPENAI_API_KEY / OPENAI_BASE_URL / MODEL）。');
  $('providerHint').innerHTML = html;
}

async function refresh() {
  const [s, c] = await Promise.all([api('/api/state'), api('/api/config')]);
  state = s;
  config = c;
  renderEditor();
  renderChips();
  renderPreview();
  renderHistory();
  renderStatus();
  renderProviderHint();
}

/* ---------- 词级 diff（预览用，LCS） ---------- */

function tokenize(s) {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

function diffHtml(a, b) {
  const A = tokenize(a), B = tokenize(b);
  if (A.length * B.length > 2_000_000) {
    return `<mark class="del">${esc(a)}</mark><mark class="ins">${esc(b)}</mark>`;
  }
  const n = A.length, m = B.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = A[i] === B[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const segs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { segs.push(['same', A[i]]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { segs.push(['del', A[i]]); i++; }
    else { segs.push(['ins', B[j]]); j++; }
  }
  while (i < n) segs.push(['del', A[i++]]);
  while (j < m) segs.push(['ins', B[j++]]);

  const merged = [];
  for (const [t, text] of segs) {
    const last = merged[merged.length - 1];
    if (last && last[0] === t) last[1] += text;
    else merged.push([t, text]);
  }
  return merged.map(([t, text]) => t === 'same' ? esc(text) : `<mark class="${t}">${esc(text)}</mark>`).join('');
}

/* ---------- 事件 ---------- */

document.addEventListener('selectionchange', () => {
  if (document.activeElement === editor) updateSelHint();
});
editor.addEventListener('scroll', () => {
  highlights.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
});
editor.addEventListener('input', () => {
  editor.dispatchEvent(new Event('scroll'));
  updateSelHint();
});

window.addEventListener('resize', () => editor.dispatchEvent(new Event('scroll')));

refresh().then(() => {
  editor.dispatchEvent(new Event('scroll'));
  updateSelHint();
});

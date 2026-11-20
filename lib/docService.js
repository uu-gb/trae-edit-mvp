'use strict';
/**
 * 文档服务：版本快照 + 操作日志 + 回滚 + 原子持久化。
 *
 * 状态模型（单文档、单 pending 槽位）：
 *   content           当前全文
 *   version           当前版本号（单调递增，每次变更 +1）
 *   versions[]        全量快照（MVP 文档规模小，直接存快照，回滚 = 取快照开新版本）
 *   oplog[]           操作日志 { ts, actor: 'user'|'ai', action, reason, v }
 *   authorizedRanges[] 已授权区间 [{start,end}]（半开区间，0 起始字符偏移）
 *   pending            待应用的 AI 修改（preview/blocked/conflict/applied/rejected）
 *
 * 设计原则：AI 是唯一受限角色；用户手动编辑是所有者行为，可直接提交。
 * 回滚不删历史：回滚 = 以旧快照内容开一个新版本，历史保持线性。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const SEED_DOC = [
  '# Codex 方案平移 TRAE：最小架构',
  '',
  '如果把博主的 Codex 方案平移到 TRAE，最小架构可以是：',
  '',
  '- 前端编辑器：负责本地输入、光标、选区、展示 AI 修改；',
  '- 文档服务：保存版本、操作日志、冲突状态；',
  '- Agent 网关：接收「改这段」任务，调用模型，要求返回统一格式（JSON Patch / unified diff / 替换区间+新文本）；',
  '- 应用器：把 AI 返回的修改先预览，再按规则合并；',
  '- 回滚：每次 AI 修改都有版本号，可撤销；',
  '- 护栏：AI 不能整篇重写覆盖用户；默认只改被授权段落，越界就拒绝或请求确认。',
  '',
  '需要注意的坑：如果博主依赖了 Codex 的特定工程能力（沙箱执行、代码库级工具调用、IDE 集成、文件系统权限），',
  '那么换模型时，模型只负责理解与生成，执行/工具/权限层需要另外补。',
  '换句话说，模型可以替换「大脑」，不能自动替代「手」和「门禁」。',
  '',
  '结论：能跑，很适合用 TRAE 试 MVP；重点不是「换成 TRAE 是否等价于 Codex」，',
  '而是验证上下文管理 + 并发合并 + 授权预览机制。模型可替换，协作协议和状态管理才是核心。',
  '',
].join('\n');

let state = null;

function defaultState() {
  return {
    content: SEED_DOC,
    version: 1,
    versions: [{ v: 1, content: SEED_DOC, ts: new Date().toISOString() }],
    oplog: [{ ts: new Date().toISOString(), actor: 'user', action: 'seed', reason: '初始文档', v: 1 }],
    authorizedRanges: [],
    pending: null,
  };
}

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = defaultState();
    save();
  }
  return state;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function nextVersion() {
  state.version += 1;
  return state.version;
}

function snapshot(content) {
  state.versions.push({ v: state.version, content, ts: new Date().toISOString() });
}

function log(actor, action, reason) {
  state.oplog.push({ ts: new Date().toISOString(), actor, action, reason, v: state.version });
  if (state.oplog.length > 200) state.oplog = state.oplog.slice(-200);
}

/** 归一化授权区间：过滤非法、夹取到文档长度内、排序、合并重叠/相邻 */
function normalizeRanges(ranges, len) {
  const out = [];
  for (const r of Array.isArray(ranges) ? ranges : []) {
    // 接受 {start,end} 对象或 [start,end] 数组两种形式
    const s0 = Array.isArray(r) ? r[0] : r?.start;
    const e0 = Array.isArray(r) ? r[1] : r?.end;
    let s = Math.floor(Number(s0));
    let e = Math.floor(Number(e0));
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (s > e) [s, e] = [e, s];
    s = Math.max(0, Math.min(s, len));
    e = Math.max(0, Math.min(e, len));
    if (s === e) continue; // 空区间无意义
    out.push({ start: s, end: e });
  }
  out.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push(r);
  }
  return merged;
}

function getState() {
  const st = load();
  return {
    content: st.content,
    version: st.version,
    authorizedRanges: st.authorizedRanges,
    pending: st.pending,
    history: st.versions.map((v, i) => ({
      v: v.v,
      ts: v.ts,
      contentLen: v.content.length,
      op: st.oplog.find((o) => o.v === v.v) || null,
    })),
    oplog: st.oplog.slice(-50),
  };
}

/** 用户手动编辑（所有者行为，可直接提交；会使旧授权区间偏移失效，故清空） */
function userEdit(content, reason) {
  const st = load();
  const v = nextVersion();
  st.content = String(content);
  snapshot(st.content);
  log('user', 'user_edit', reason || '手动编辑');
  const cleared = st.authorizedRanges.length > 0;
  st.authorizedRanges = [];
  if (st.pending) st.pending.stale = true; // 后续 apply 时走冲突检测
  save();
  return { ok: true, version: v, rangesCleared: cleared };
}

function setAuthorizedRanges(ranges) {
  const st = load();
  st.authorizedRanges = normalizeRanges(ranges, st.content.length);
  save();
  return { ok: true, authorizedRanges: st.authorizedRanges };
}

function getAuthorizedRanges() {
  return load().authorizedRanges;
}

function currentContent() {
  return load().content;
}

function currentVersion() {
  return load().version;
}

function getPending() {
  return load().pending;
}

function setPending(changeset) {
  const st = load();
  st.pending = {
    id: Date.now().toString(36),
    provider: changeset.provider,
    model: changeset.model,
    baseVersion: changeset.baseVersion,
    rangesAtGen: st.authorizedRanges.slice(),
    changeset,
    status: 'preview',
    createdAt: new Date().toISOString(),
  };
  save();
  return st.pending;
}

function markPendingBlocked(validation) {
  const st = load();
  if (st.pending) {
    st.pending.status = 'blocked';
    st.pending.validation = validation;
  }
  save();
}

function markPendingConflict(report) {
  const st = load();
  if (st.pending) {
    st.pending.status = 'conflict';
    st.pending.report = report;
  }
  save();
}

function rejectPending() {
  const st = load();
  st.pending = null;
  log('user', 'reject', '拒绝 AI 修改预览');
  save();
  return { ok: true };
}

/** 应用已合并的修改：开新版本、清空授权区（偏移已变化）、落日志 */
function applyChangeSet(adjusted, policy) {
  const st = load();
  const content = applyContent(st.content, adjusted);
  const v = nextVersion();
  st.content = content;
  snapshot(content);
  log('ai', 'apply', `应用 ${adjusted.length} 处修改（覆盖 ${(policy.coverage * 100).toFixed(1)}%）`);
  st.pending = null;
  st.authorizedRanges = [];
  save();
  return { ok: true, version: v, content };
}

/** 按区间降序应用替换，保证偏移不漂移 */
function applyContent(content, changes) {
  const sorted = changes.slice().sort((a, b) => b.start - a.start);
  let out = content;
  for (const c of sorted) {
    out = out.slice(0, c.start) + c.newText + out.slice(c.end);
  }
  return out;
}

/** 回滚：以目标版本快照开一个新版本（不删除历史） */
function rollback(targetV) {
  const st = load();
  const snap = st.versions.find((x) => x.v === Number(targetV));
  if (!snap) return { error: `版本 v${targetV} 不存在` };
  if (snap.v === st.version) return { error: '已是该版本内容' };
  st.content = snap.content;
  const v = nextVersion();
  snapshot(st.content);
  log('user', 'rollback', `回滚到 v${snap.v}（当前新版本 v${v}）`);
  st.pending = null;
  st.authorizedRanges = [];
  save();
  return { ok: true, version: v, restoredFrom: snap.v };
}

module.exports = {
  getState,
  userEdit,
  setAuthorizedRanges,
  getAuthorizedRanges,
  currentContent,
  currentVersion,
  getPending,
  setPending,
  markPendingBlocked,
  markPendingConflict,
  rejectPending,
  applyChangeSet,
  applyContent,
  normalizeRanges,
  rollback,
};

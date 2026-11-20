'use strict';
/**
 * HTTP 服务：静态前端 + REST API。
 *
 * API：
 *   GET  /api/state         文档状态（内容/版本/授权区/pending/历史/日志）
 *   POST /api/doc           用户手动编辑 { content, reason }
 *   POST /api/authorize     设置授权区间 { ranges: [[s,e],...] }
 *   POST /api/agent/run     网关运行 { instruction, provider }
 *   POST /api/apply         应用 pending 修改 { force? }
 *   POST /api/apply/reject  拒绝 pending 修改
 *   POST /api/rollback      回滚 { version }
 *   GET  /api/versions      历史版本
 *   GET  /api/config        provider / 协议配置
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const docService = require('./lib/docService');
const applier = require('./lib/applier');
const gateway = require('./lib/gateway');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 应用 pending：重定位 → 冲突硬拦截 → 策略校验（可 force）→ 落盘 */
function applyPending(force) {
  const st = docService.getState();
  const p = st.pending;
  if (!p) return { error: '没有待应用的修改，请先运行 Agent' };

  const doc = st.content;
  const ranges = st.authorizedRanges;

  const rec = applier.reconcile(doc, ranges, p.changeset.changes);
  if (rec.conflicts.length) {
    docService.markPendingConflict(rec);
    return {
      blocked: true,
      type: 'conflict',
      message: '文档在生成后被修改过，且授权区内找不到可匹配的原文，无法安全合并（结构性冲突，不支持强制）',
      report: rec,
    };
  }
  if (!rec.adjusted.length) {
    return { error: '没有可应用的修改（changes 为空或全部被结构校验丢弃），请调整指令后重新运行 Agent' };
  }

  const policy = applier.validatePolicy(doc, ranges, rec.adjusted);
  if (!policy.ok && !force) {
    docService.markPendingBlocked(policy);
    return {
      blocked: true,
      type: 'policy',
      canForce: true,
      message: '护栏拦截（可强制应用，但请确认风险）',
      validation: policy,
    };
  }

  const applied = docService.applyChangeSet(rec.adjusted, policy);
  return {
    ok: true,
    applied,
    relocated: rec.status === 'relocated',
    relocatedCount: rec.adjusted.filter((c) => c.relocated).length,
    validation: policy,
  };
}

async function handleApi(req, res, url, method) {
  const p = url.pathname;

  if (p === '/api/state' && method === 'GET') return send(res, 200, docService.getState());
  if (p === '/api/versions' && method === 'GET') return send(res, 200, { versions: docService.getState().history });
  if (p === '/api/config' && method === 'GET') return send(res, 200, await gateway.config());

  if (p === '/api/doc' && method === 'POST') {
    const b = await readBody(req);
    return send(res, 200, docService.userEdit(b.content ?? '', b.reason));
  }
  if (p === '/api/authorize' && method === 'POST') {
    const b = await readBody(req);
    return send(res, 200, docService.setAuthorizedRanges(b.ranges));
  }
  if (p === '/api/agent/run' && method === 'POST') {
    const b = await readBody(req);
    const r = await gateway.run({ instruction: b.instruction, provider: b.provider });
    return send(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/apply' && method === 'POST') {
    const b = await readBody(req);
    return send(res, 200, applyPending(Boolean(b.force)));
  }
  if (p === '/api/apply/reject' && method === 'POST') {
    return send(res, 200, docService.rejectPending());
  }
  if (p === '/api/rollback' && method === 'POST') {
    const b = await readBody(req);
    return send(res, 200, docService.rollback(b.version));
  }
  return send(res, 404, { error: `unknown api: ${method} ${p}` });
}

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, req.method);
    if (req.method === 'GET') return serveStatic(req, res, url);
    send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[trae-edit-mvp] http://localhost:${PORT}`);
  console.log(`[trae-edit-mvp] mock provider 可用；openai provider ${process.env.OPENAI_API_KEY ? '已配置' : '未配置（设置 OPENAI_API_KEY / OPENAI_BASE_URL / MODEL 后重启）'}`);
});

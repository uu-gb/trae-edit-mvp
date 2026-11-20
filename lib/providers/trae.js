'use strict';
/**
 * TRAE Provider：通过 traecli（TraeCode CLI 2.0）的 exec 无头模式调用 TRAE 智能体。
 *
 * 「大脑可替换，手和门禁在自己手里」在本 provider 的落地：
 *   - 门禁：-s read-only（模型执行的 shell 走只读沙箱）+ --disallowed-tool 禁用
 *     Edit / Write / MultiEdit / Bash 等工具 —— TRAE 在本 MVP 里只当「大脑」，不能直接改文件；
 *   - 协议：--output-schema 用 JSON Schema 把最终响应约束成协议 v1，
 *     系统 prompt 里再重申规则；网关侧 parseChangeSet 仍是第一道防线（双重保险）；
 *   - 上下文：与 openai provider 相同 —— 带行首偏移标尺的全文 + 已授权区间 + 指令。
 *
 * 环境变量：
 *   TRAECLI_BIN                       CLI 可执行文件路径（默认取本机 TraeCLI 安装位置）
 *   TRAE_MODEL                        指定模型（可选，默认用账号配置）
 *   TRAECLI_PERSONAL_ACCESS_TOKEN     PAT 登录令牌（可选）
 * 首次使用需先登录：traecli login（浏览器授权）或 traecli login --with-trae-pat。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { promptSection } = require('../preferences');

const TIMEOUT_MS = Number(process.env.TRAE_TIMEOUT_MS) || 180000;
const WORKSPACE = path.resolve(__dirname, '..', '..');

/** 定位 CLI 可执行文件：优先环境变量，其次本机安装位置（Windows 默认 junction 路径），最后 PATH */
function bin() {
  if (process.env.TRAECLI_BIN && fs.existsSync(process.env.TRAECLI_BIN)) return process.env.TRAECLI_BIN;
  if (process.platform === 'win32') {
    const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'TraeCLI', 'bin', 'traex.exe');
    if (fs.existsSync(exe)) return exe;
    return 'traecli.cmd';
  }
  return 'traecli';
}

function configured() {
  const b = bin();
  if (b === 'traecli' || b === 'traecli.cmd') return false; // 未找到真实安装文件
  try { fs.accessSync(b, fs.constants.X_OK); return true; } catch { return false; }
}

function model() {
  return process.env.TRAE_MODEL || '账号默认';
}

/** 协议 v1 的 JSON Schema（传给 --output-schema，约束模型最终响应） */
function protocolSchema() {
  return {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
          },
          required: ['start', 'end', 'newText'],
          additionalProperties: false,
        },
      },
      note: { type: 'string' },
    },
    required: ['changes'],
    additionalProperties: false,
  };
}

/** 查询登录状态（traecli login status，10s 超时） */
function loginStatus() {
  return new Promise((resolve) => {
    const child = spawn(bin(), ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); }, 10000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = `${out}\n${err}`;
      const loggedIn = code === 0 && !/not logged in/i.test(text);
      resolve({
        loggedIn,
        detail: text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | '),
        exitCode: code,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ loggedIn: false, detail: `无法执行 ${bin()}：${e.message}`, exitCode: null });
    });
  });
}

/** 组装 PROMPT：协议规则 + 带行首偏移标尺的全文 + 授权区间 + 指令（与 openai provider 同构） */
function buildPrompt({ doc, ranges, instruction, version }) {
  const system = [
    '你是一个严格的文档协作编辑 Agent。本次任务禁用一切工具（Bash/Edit/Write 等），你只能通过返回 JSON 修改文档，不能输出任何其他内容。',
    '',
    '统一返回格式（协议 v1，必须严格遵守）：',
    '{"changes":[{"start":0,"end":0,"oldText":"被替换的原文","newText":"..."}],"note":"..."}',
    '',
    '规则：',
    '1. 每个 change 必须给出 oldText：被替换处的原文，从【当前文档全文】逐字照抄、一字不差。oldText 是定位锚点；start/end 是 0 起始字符偏移（区间 [start,end) 半开），仅作参考，允许略有偏差。',
    '2. 每个 change 的 [start,end) 必须完全落在某个【已授权区间】内；授权区间外的任何字符都不得改动。',
    '3. 禁止整篇重写：所有 change 覆盖的总字符数不得超过全文的 50%，不得用无关的全新内容替换大段原文。',
    '4. 如果指令无法在约束内完成，返回 {"changes":[],"note":"说明原因"}。',
    '5. 不需要修改的段落不要放进 changes；change 之间不得重叠。',
    '6. 只输出一个 JSON 对象：不要 markdown 代码围栏，不要任何解释文字。',
    '7. 返回前自检：对每个 change，doc.slice(start,end) 必须恰好等于该处的原文；若不确定偏移，宁可返回 {"changes":[],"note":"无法确定偏移"}。',
    promptSection(),
  ].filter(Boolean).join('\n');

  const rulerDoc = [];
  const lines = doc.split('\n');
  let offset = 0;
  for (const line of lines) {
    rulerDoc.push(`[${offset}] ${line}`);
    offset += line.length + 1;
  }

  const user = [
    `【当前文档全文】共 ${doc.length} 字符，版本 v${version}（每行行首是行起始偏移，行内字符偏移 = 行起始 + 列位置）`,
    ...rulerDoc,
    '',
    '【已授权区间】（只能改这些区间内的文本）',
    ...(ranges.length
      ? ranges.map((r) => `- [${r.start},${r.end}) 原文: ${JSON.stringify(doc.slice(r.start, r.end))}`)
      : ['（无）']),
    '',
    `【修改指令】${instruction}`,
  ].join('\n');

  return `${system}\n\n${user}`;
}

/** 从 --json JSONL 流里尽力抽最终答复（-o 文件缺失时的兜底） */
function extractFromJsonl(stdout) {
  const lines = String(stdout).split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      for (const k of ['message', 'text', 'content', 'output', 'result']) {
        const v = ev[k] ?? ev?.payload?.[k];
        if (typeof v === 'string' && v.trim()) return v;
      }
    } catch { /* 非 JSON 行，跳过 */ }
  }
  return null;
}

/**
 * 调用 TRAE：exec 无头运行，PROMPT 走 stdin，最终答复落 -o 文件。
 * 返回原始字符串，协议解析/校验由 gateway 负责。
 */
async function run({ doc, ranges, instruction, version }) {
  if (!configured()) {
    throw new Error('未找到 traecli 可执行文件：请先安装 TRAE CLI 2.0（irm https://trae.cn/trae-cli/install_v2.ps1 | iex）或设置 TRAECLI_BIN');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-mvp-'));
  const schemaFile = path.join(tmp, 'protocol-v1.schema.json');
  const outFile = path.join(tmp, 'last-message.txt');
  fs.writeFileSync(schemaFile, JSON.stringify(protocolSchema()));

  const args = [
    'exec',
    '--json',                 // 事件走 JSONL，便于兜底解析与排障
    '--ephemeral',            // 不落会话文件
    '--skip-git-repo-check',  // 工作区非 git 仓库
    '-s', 'read-only',        // 门禁：模型执行的 shell 只读沙箱
    '--disallowed-tool', 'Edit',
    '--disallowed-tool', 'Write',
    '--disallowed-tool', 'MultiEdit',
    '--disallowed-tool', 'Bash', // 双保险：连只读 shell 也不用，纯「大脑」
    '--output-schema', schemaFile,
    '-o', outFile,
    '-C', WORKSPACE,
  ];
  if (process.env.TRAE_MODEL) args.push('-m', process.env.TRAE_MODEL);

  const prompt = buildPrompt({ doc, ranges, instruction, version });

  return await new Promise((resolve, reject) => {
    const child = spawn(bin(), args, { cwd: WORKSPACE, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const cap = (s, c) => (s.length < 200000 ? s + c : s);
    child.stdout.on('data', (c) => { stdout = cap(stdout, c); });
    child.stderr.on('data', (c) => { stderr = cap(stderr, c); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`TRAE 执行超时（${TIMEOUT_MS / 1000}s），已终止`));
    }, TIMEOUT_MS);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${bin()}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) {
          const noise = (l) => l.includes('could not update PATH') || l.includes('os error 5');
          const lines = (stderr || stdout).split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !noise(l));
          const tail = lines.slice(-8).join(' / ');
          throw new Error(`traecli 退出码 ${code}：${tail || '无输出'}（未登录请先 traecli login）`);
        }
        let content = null;
        try { content = fs.readFileSync(outFile, 'utf8'); } catch { /* 无 -o 文件，走兜底 */ }
        if (!content || !content.trim()) content = extractFromJsonl(stdout);
        if (!content || !content.trim()) throw new Error('TRAE 未返回最终答复（-o 文件与 JSONL 流均为空）');
        resolve(content.trim());
      } catch (e) {
        reject(e);
      }
    });

    child.stdin.on('error', () => { /* EPIPE：进程提前退出，close 会处理 */ });
    child.stdin.write(prompt);
    child.stdin.end();
  }).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
  });
}

module.exports = { run, name: 'trae', configured, model, bin, loginStatus };

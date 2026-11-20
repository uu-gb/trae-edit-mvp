'use strict';
/**
 * OpenAI 兼容 Provider：把任意支持 /chat/completions 的模型接进网关。
 * 环境变量：
 *   OPENAI_API_KEY   必填
 *   OPENAI_BASE_URL  默认 https://api.moonshot.cn/v1 （Kimi；换成 DeepSeek/OpenAI 等任意兼容端点即可）
 *   MODEL            默认 kimi-k2
 * 模型只负责「理解与生成」，返回内容由 gateway 解析成统一协议后交给应用器 —— 这就是「大脑可替换、手和门禁在自己手里」。
 */

const BASE = () => (process.env.OPENAI_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const MODEL = () => process.env.MODEL || 'kimi-k2';
const KEY = () => process.env.OPENAI_API_KEY || '';

const { promptSection } = require('../preferences');

function configured() {
  return Boolean(KEY());
}

async function run({ doc, ranges, instruction, version }) {
  if (!configured()) throw new Error('未配置 OPENAI_API_KEY（可改用 mock provider，或设置环境变量后重启）');
  const messages = buildMessages({ doc, ranges, instruction, version });
  const res = await fetch(`${BASE()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY()}` },
    body: JSON.stringify({ model: MODEL(), messages, temperature: 0.2 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回为空');
  return content;
}

function buildMessages({ doc, ranges, instruction, version }) {
  const system = [
    '你是一个严格的文档协作编辑 Agent。你只能通过返回 JSON 修改文档，不能输出任何其他内容。',
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

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

module.exports = { run, name: 'openai', configured, model: MODEL, base: BASE };

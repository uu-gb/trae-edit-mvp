'use strict';
/**
 * Mock Provider：无需 API key 的离线演示。
 * 作用是验证「协议 + 应用器 + 护栏」整条链路，输出与真实模型完全同构的 JSON。
 * 内置若干确定性小变换（只作用于授权区文本），按指令关键词触发：
 *   引用/quote → Markdown 引用块     粗体/bold → **加粗**
 *   列表/list  → 无序列表            修剪/trim/空白 → 空白规范化（默认）
 */

function blockquote(text) {
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? '>' : `> ${l}`))
    .join('\n');
}

function bold(text) {
  return `**${text.replace(/\*\*/g, '')}**`;
}

function listify(text) {
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : `- ${l}`))
    .join('\n');
}

function normalizeWhitespace(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const TRANSFORMS = [
  { re: /引用|quote|blockquote/i, name: '引用块', fn: blockquote },
  { re: /粗体|加粗|bold/i, name: '加粗', fn: bold },
  { re: /列表|清单|list/i, name: '列表', fn: listify },
  { re: /修剪|空白|trim|规范化/i, name: '空白规范化', fn: normalizeWhitespace },
];

async function run({ doc, ranges, instruction, version }) {
  const match = TRANSFORMS.find((t) => t.re.test(instruction)) || TRANSFORMS[TRANSFORMS.length - 1];
  const changes = [];
  for (const r of ranges) {
    const oldText = doc.slice(r.start, r.end);
    const newText = match.fn(oldText);
    if (newText !== oldText) changes.push({ start: r.start, end: r.end, newText });
  }
  const note = changes.length
    ? `mock 演示：对 ${changes.length} 个授权区间执行「${match.name}」（离线确定性变换，无需 API key）`
    : 'mock：目标文本已是最简状态，没有可执行的变换；可换 openai provider 或换指令（引用/粗体/列表/修剪）';
  return JSON.stringify({ changes, note });
}

module.exports = { run, name: 'mock' };

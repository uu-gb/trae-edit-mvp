'use strict';
/**
 * 应用器：护栏 + 合并。
 *
 * 统一修改协议（协议 v1，模型唯一合法输出）：
 *   { "changes": [ { "start": int, "end": int, "oldText"?: string, "newText": string } ], "note": string }
 *   - start/end 为 0 起始字符偏移，半开区间 [start, end)，基于调用时刻的文档全文；
 *   - oldText 为可选定位锚点（被替换处的原文，逐字照抄）：模型算偏移不可靠，
 *     应用器优先按 oldText 在授权区内唯一匹配来重定位，偏移仅作参考；
 *   - 每个 change 必须完全落在【已授权区间】内；
 *   - 总覆盖字符数不得超过全文 50%（防整篇重写）；
 *   - change 之间不得重叠。
 *
 * 三道闸：
 *   1. 结构校验（整数、边界、newText 类型、重叠）——结构错误直接丢弃该条；
 *   2. 冲突重定位（文档在生成后被改过时：原文对不上 → 在授权区内搜索原文重定位；找不到 → 冲突拦截）；
 *   3. 策略校验（越界授权区、覆盖率 > 50%）——拦截但允许用户强制应用。
 */

const { normalizeRanges } = require('./docService');

const MAX_COVERAGE = 0.5;

function inUnion(ranges, s, e) {
  return ranges.some((r) => r.start <= s && e <= r.end);
}

/**
 * 结构校验：返回 { valid: 通过结构校验的 change[], dropped: 被丢弃的说明[], structuralErrors }
 */
function validateStructure(doc, changes) {
  const valid = [];
  const dropped = [];

  for (const c of changes || []) {
    if (!c || typeof c !== 'object') { dropped.push('非对象条目'); continue; }
    if (!Number.isInteger(c.start) || !Number.isInteger(c.end)) { dropped.push(`start/end 必须是整数（收到 ${JSON.stringify(c.start)}/${JSON.stringify(c.end)}）`); continue; }
    if (c.start < 0 || c.end > doc.length || c.start > c.end) { dropped.push(`区间 [${c.start},${c.end}) 越界（文档长度 ${doc.length}）`); continue; }
    if (typeof c.newText !== 'string') { dropped.push('newText 必须是字符串'); continue; }
    if (typeof c.oldText === 'string' && c.oldText && c.newText === c.oldText) { dropped.push(`newText 与 oldText 相同，无实际变化`); continue; }
    if (c.newText === doc.slice(c.start, c.end)) { dropped.push(`[${c.start},${c.end}) 无实际变化`); continue; }
    valid.push({
      start: c.start,
      end: c.end,
      newText: c.newText,
      oldText: doc.slice(c.start, c.end),
      claimed: typeof c.oldText === 'string' && c.oldText.trim() ? c.oldText : null,
    });
  }

  // 重叠检测（对通过结构校验的条目，按 start 排序后相邻比较）
  const byStart = valid.slice().sort((a, b) => a.start - b.start);
  const overlapping = new Set();
  for (let i = 1; i < byStart.length; i++) {
    if (byStart[i].start < byStart[i - 1].end) { overlapping.add(byStart[i]); overlapping.add(byStart[i - 1]); }
  }
  const kept = [];
  for (const v of valid) {
    if (overlapping.has(v)) dropped.push(`[${v.start},${v.end}) 与其他区间重叠，已丢弃`);
    else kept.push(v);
  }
  return { valid: kept, dropped };
}

/**
 * 策略校验：返回 { ok, policyViolations: string[], warnings: string[], coverage }
 * 仅拦截不修改 change 内容；force 可绕过。
 */
function validatePolicy(doc, ranges, changes) {
  const violations = [];
  const warnings = [];
  let covered = 0;
  for (const c of changes) {
    if (!inUnion(ranges, c.start, c.end)) {
      violations.push(`区间 [${c.start},${c.end}) 不在任何已授权区间内（越界）`);
    }
    covered += c.end - c.start;
  }
  const coverage = doc.length ? covered / doc.length : 0;
  if (coverage > MAX_COVERAGE) {
    violations.push(`修改覆盖全文 ${(coverage * 100).toFixed(0)}%，超过 ${MAX_COVERAGE * 100}% 上限，疑似整篇重写`);
  }
  if (!changes.length) warnings.push('changes 为空：模型未在约束内提出修改');
  return { ok: violations.length === 0, violations, warnings, coverage };
}

/**
 * 冲突重定位：文档在生成后可能被用户/其他会话改过。
 * 策略：当前文档在 [start,end) 处仍等于生成时的 oldText → 直接应用；
 *       否则在授权区并集内搜索 oldText 的唯一匹配 → 重定位；
 *       找不到 → 冲突（结构性问题，不可强制）。
 */
function reconcile(doc, ranges, changes) {
  const union = normalizeRanges(ranges, doc.length);
  const adjusted = [];
  const conflicts = [];
  for (const c of changes) {
    // 优先信任模型提供的 oldText 锚点：模型算偏移不可靠（实测连错 4 次），
    // 只要锚点原文在授权区内唯一匹配，就按原文重定位，偏移仅作参考。
    if (c.claimed && c.claimed !== doc.slice(c.start, c.end)) {
      let found = -1;
      let count = 0;
      let from = 0;
      while (true) {
        const idx = doc.indexOf(c.claimed, from);
        if (idx === -1) break;
        if (inUnion(union, idx, idx + c.claimed.length)) { found = idx; count++; }
        from = idx + 1;
      }
      if (count === 1) {
        adjusted.push({ ...c, start: found, end: found + c.claimed.length, relocated: true });
        continue;
      }
      if (count > 1) {
        conflicts.push({ at: c.start, oldText: c.claimed.slice(0, 80), reason: '模型提供的锚点原文在授权区内出现多次，无法唯一定位' });
        continue;
      }
      // count === 0：锚点找不到，落回偏移规则
    }
    if (doc.slice(c.start, c.end) === c.oldText) {
      adjusted.push({ ...c });
      continue;
    }
    if (!c.oldText) {
      adjusted.push({ ...c }); // 纯插入，位置漂移可接受
      continue;
    }
    let found = -1;
    let from = 0;
    while (found === -1) {
      const idx = doc.indexOf(c.oldText, from);
      if (idx === -1) break;
      if (inUnion(union, idx, idx + c.oldText.length)) found = idx;
      else from = idx + 1;
    }
    if (found >= 0) {
      adjusted.push({ ...c, start: found, end: found + c.oldText.length, relocated: true });
    } else {
      conflicts.push({ at: c.start, oldText: c.oldText.slice(0, 80), reason: '原文已变化，且在授权区内找不到可匹配的文本' });
    }
  }
  return {
    adjusted,
    conflicts,
    status: conflicts.length ? 'conflict' : adjusted.some((c) => c.relocated) ? 'relocated' : 'ready',
  };
}

module.exports = { validateStructure, validatePolicy, reconcile, MAX_COVERAGE };

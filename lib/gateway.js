'use strict';
/**
 * Agent 网关：接收「改这段」任务，调用 provider，解析成统一协议后交给应用器。
 *
 * 职责边界（对应方案里的「大脑 vs 手和门禁」）：
 *   - 网关只负责 上下文组装 + 协议解析 + 结构校验，并登记 pending；
 *   - 策略校验/冲突合并/落盘由应用器 + 文档服务负责；
 *   - 模型输出永远是「数据」，网关是第一道防线：非 JSON、结构错误都到不了文档服务。
 */

const docService = require('./docService');
const applier = require('./applier');
const preferences = require('./preferences');
const mock = require('./providers/mock');
const openai = require('./providers/openai');
const trae = require('./providers/trae');

const MAX_DOC_LEN = 30000; // MVP 协议基于全文偏移，限制单次上下文规模

/** 从模型原始输出中提取第一个合法的顶层 JSON 对象（容忍围栏/前后杂文） */
function extractJson(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  // 扫描第一个 '{'，括号配对（字符串感知）
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('未找到 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  throw new Error('JSON 对象不完整');
}

/** 协议解析：返回 { changes, note } 或抛错 */
function parseChangeSet(raw, doc) {
  const json = extractJson(raw);
  const obj = JSON.parse(json);
  if (!Array.isArray(obj.changes)) throw new Error('缺少 changes 数组（协议 v1：{"changes":[{start,end,newText}],"note"}）');
  return {
    changes: obj.changes.map((c, i) => ({
      start: c?.start,
      end: c?.end,
      newText: c?.newText,
      oldText: typeof c?.oldText === 'string' ? c.oldText : undefined,
      _i: i,
    })),
    note: typeof obj.note === 'string' ? obj.note : '',
  };
}

async function run({ instruction, provider }) {
  const st = docService.getState();
  const doc = st.content;
  const ranges = st.authorizedRanges;

  if (!ranges.length) return { error: '请先在编辑器中选中并授权至少一个段落（护栏：无授权区时不允许调用模型改文档）' };
  if (!String(instruction || '').trim()) return { error: '请输入修改指令' };
  if (doc.length > MAX_DOC_LEN) return { error: `文档 ${doc.length} 字符，超过 MVP 上限 ${MAX_DOC_LEN}；请先授权更小的段落范围` };

  const impl = provider === 'openai' ? openai : provider === 'trae' ? trae : mock;
  const t0 = Date.now();

  let raw;
  try {
    raw = await impl.run({ doc, ranges, instruction, version: st.version });
  } catch (e) {
    return { error: `${impl.name} 调用失败：${e.message}` };
  }

  let parsed;
  try {
    parsed = parseChangeSet(raw, doc);
  } catch (e) {
    return { error: `模型返回格式无法解析：${e.message}`, rawSnippet: String(raw).slice(0, 500) };
  }

  // 结构校验（第一道防线：非法条目直接丢弃并说明）
  const struct = applier.validateStructure(doc, parsed.changes);
  // 策略校验（第二道防线：越界/覆盖率，进入 preview 时先给用户预警）
  const policy = applier.validatePolicy(doc, ranges, struct.valid);

  const changeset = {
    protocolVersion: 1,
    provider: impl.name,
    model: provider === 'openai' ? openai.model() : provider === 'trae' ? trae.model() : 'mock(内置变换)',
    baseVersion: st.version,
    instruction,
    changes: struct.valid,
    note: parsed.note,
    dropped: struct.dropped,
    policy,
    latencyMs: Date.now() - t0,
  };

  const pending = docService.setPending(changeset);
  return { ok: true, changeset, pendingId: pending.id };
}

async function config() {
  return {
    mock: true,
    openai: {
      configured: openai.configured(),
      model: openai.model(),
      endpoint: `${openai.base()}/chat/completions`,
    },
    trae: {
      configured: trae.configured(),
      binary: trae.bin(),
      model: trae.model(),
      sandbox: 'read-only',
      login: await trae.loginStatus(),
    },
    protocol: {
      version: 1,
      shape: '{"changes":[{"start":int,"end":int,"oldText":string?,"newText":string}],"note":string}',
      limits: { maxCoverage: applier.MAX_COVERAGE, maxDocLen: MAX_DOC_LEN },
    },
    preferences: {
      dir: preferences.dir(),
      files: preferences.list(),
      loaded: preferences.list().length,
    },
  };
}

module.exports = { run, config };

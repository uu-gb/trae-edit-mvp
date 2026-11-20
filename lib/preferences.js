'use strict';
/**
 * 用户偏好注入：把知识库「个人协作档案」里的偏好文件追加到 provider 的系统提示，
 * 让 AI 修改文档时也遵守用户的表达规则、判断规则与协作协议。
 *
 * 路径：默认 D:\KnowledgeBase\03_Wiki\个人协作档案，可用环境变量 PREF_DIR 覆盖。
 * 缺失的文件静默跳过（不阻塞主流程），加载情况通过 /api/config 的 preferences 字段可见。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = 'D:\\KnowledgeBase\\03_Wiki\\个人协作档案';
const FILES = ['表达偏好.md', '判断偏好.md', '协作协议.md'];

function dir() {
  return process.env.PREF_DIR || DEFAULT_DIR;
}

/** 实际可用的偏好文件列表 */
function list() {
  const d = dir();
  return FILES.filter((f) => {
    try { return fs.existsSync(path.join(d, f)); } catch { return false; }
  });
}

/** 读取全部偏好文件内容（不存在/读取失败则跳过） */
function load() {
  const d = dir();
  const parts = [];
  for (const f of FILES) {
    try {
      const t = fs.readFileSync(path.join(d, f), 'utf8').trim();
      if (t) parts.push(t);
    } catch { /* 跳过 */ }
  }
  return parts;
}

/** 生成注入系统提示的偏好段落；无可用文件时返回空串 */
function promptSection() {
  const parts = load();
  if (!parts.length) return '';
  return [
    '',
    '【用户协作偏好】修改建议的取舍与表达必须遵守以下规则（来自用户知识库「个人协作档案」）；若与上方协议规则冲突，以协议规则为准：',
    ...parts,
  ].join('\n');
}

module.exports = { dir, list, load, promptSection, FILES };

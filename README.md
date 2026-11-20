# AI 段落协作编辑器 MVP（trae-edit-mvp）

> 验证「模型可替换，协作协议与状态管理是核心」命题的最小可行产品：
> **大脑（模型）只负责理解与生成；执行、权限、合并策略全部由本地代码控制。**

零依赖 Node.js 实现，无需 `npm install`，开箱即跑。支持三种模型后端即插即换：mock（离线演示）/ DeepSeek（真实调用）/ TRAE CLI（无头 Agent）。

## 核心架构：大脑 → 手 → 门禁

```
前端编辑器（选区授权/预览 diff/回滚）
        │ 授权区间 + 修改指令
        ▼
Agent 网关 ──► 组装协议 v1 上下文、解析校验（第一道闸）
        │
        ▼
Provider 大脑（mock / DeepSeek / TRAE CLI，只输出协议 JSON）
        │ changes JSON
        ▼
应用器 ──► 策略护栏 + 冲突重定位 + 合并（第二、三道闸）
        │
        ▼
文档服务 ──► 版本快照 + 双角色操作日志 + 一键回滚
```

关键设计：**模型输出永远是「数据」**——任何非 JSON、结构错误、越界修改都到不了文档。协议里模型不负责「算偏移」，只负责逐字照抄原文锚点（`oldText`），由确定性代码完成定位（实测 DeepSeek 连续 4 次偏移错误后引入，修复后一次通过）。

## 功能特性

- **授权预览**：AI 修改必须先预览 diff、经护栏校验、用户确认后才落盘
- **三道闸**：① 网关结构校验 → ② 应用器策略护栏（覆盖率 >50% 拦截，可显式强制）→ ③ 冲突重定位（文档被改后按原文锚点重定位或硬拦截）
- **版本回滚**：每次修改生成带版本号快照，历史线性保留，一键回滚
- **双角色日志**：user / ai 操作全程留痕
- **偏好注入**：从个人知识库实时读取协作规则并注入模型上下文（改文件即生效，无需重启）

## 快速开始

要求：Node.js 18+（无任何第三方依赖）。

```bash
# 1. 配置真实模型（可选，不配置则用 mock provider 演示）
#    Windows PowerShell:
$env:OPENAI_API_KEY='sk-...'
$env:OPENAI_BASE_URL='https://api.deepseek.com/v1'
$env:MODEL='deepseek-chat'

# 2. 启动
npm start        # 或 node server.js
# 输出：[trae-edit-mvp] http://localhost:3000

# 3. 浏览器打开 http://localhost:3000
#    选中一段文字 → 点「授权当前选区」→ 输入修改指令 → 运行 → 预览 diff → 应用 / 回滚
```

## 目录结构

```
trae-edit-mvp/
├── server.js              # HTTP 服务 + 静态前端（零依赖）
├── package.json           # 仅 npm start 脚本，无依赖
├── lib/
│   ├── gateway.js         # Agent 网关：上下文组装 + 协议 v1 解析 + 结构校验 + provider 分发
│   ├── applier.js         # 应用器：策略护栏 + 冲突重定位 + 合并落盘
│   ├── docService.js      # 文档服务：版本快照 + 操作日志 + 回滚 + 原子持久化
│   ├── preferences.js     # 偏好注入：实时读取个人知识库协作规则
│   └── providers/
│       ├── mock.js        # 离线演示（非关键词指令兜底为空白规范化）
│       ├── openai.js      # openai 兼容协议（DeepSeek 等）
│       └── trae.js        # TRAE CLI 无头模式（只读沙箱 + 禁用写工具 + JSON Schema）
├── public/                # 前端：index.html / app.js / style.css
├── data/                  # 运行时状态（不入库）
└── trae-mvp-acceptance/   # 交付验收报告（HTML，含实测记录）
```

## 修改协议 v1

Provider 只输出一种 JSON：

```json
{
  "changes": [
    { "start": 12, "end": 20, "newText": "新内容", "oldText": "被替换的原文逐字照抄" }
  ],
  "note": "修改说明"
}
```

- `oldText` 为**必填锚点**：应用器优先按原文在授权区内唯一匹配定位，偏移降级为参考
- 应用器三道校验：结构 → 覆盖率（≤50%，超限需用户显式强制）→ 原文匹配/冲突重定位

## 三种 Provider

| Provider | 说明 | 状态 |
|---|---|---|
| mock | 离线演示、护栏演示（关键词指令） | 可用 |
| openai 兼容 | DeepSeek 等，配置环境变量即可 | 可用（真实链路已多轮验证） |
| trae | `traecli exec` 无头模式，企业版账号登录后可用 | 代码就绪 |

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 文档状态（内容/版本/授权区/pending/历史/日志） |
| POST | `/api/authorize` | 设置授权区间 |
| POST | `/api/agent/run` | 运行 Agent 生成 pending 预览 |
| POST | `/api/apply` / `/api/apply/reject` | 应用（可 force）/ 拒绝 pending |
| POST | `/api/rollback` | 回滚到指定版本 |
| GET | `/api/config` | provider / 协议 / 登录态配置 |

## 验收报告

完整实测记录（真实模型闭环、两道闸拦截、回滚、缺陷修复）见 [trae-mvp-acceptance/rae-mvp-acceptance.html](trae-mvp-acceptance/rae-mvp-acceptance.html)。

## 说明

个人学习项目。核心结论：**更换算术能力较弱的模型没有破坏系统，反而推动协议在确定性一侧增强——模型本身零改动。**

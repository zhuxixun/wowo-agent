# wowo-agent

从零手搓一个 agent 的学习仓库：**自己先撞墙，再理解现代 Agent Harness 为什么长成这样**。

## 目录

```
├── gpt-plan.md           # 6 阶段学习路线（拆解 DeepSeek Harness 的活体样本）
└── mini-harness/         # 自己从零写的 Mini Harness（~370 行，零运行时依赖）
    ├── DESIGN.md         # 架构蓝图（每撞一次墙就更新一版）
    ├── types.ts          # 唯一状态：messages 数组（OpenAI chat 格式）
    ├── llm.ts            # 模型适配层（OpenAI 兼容，无状态）
    ├── agent-loop.ts     # 核心循环：请求 → 执行工具 → 循环
    ├── permission.ts     # 权限层（实验 A 撞墙产物）
    ├── context.ts        # 上下文压缩（实验 B 撞墙产物）
    ├── tools.ts          # 工具注册表 + read_file / write_file / bash
    ├── session.ts        # JSONL 会话落盘
    ├── bench.ts          # 基准脚本：连续投喂任务看上下文增长
    └── main.ts           # REPL 入口
```

## 运行

```bash
cd mini-harness
export DEEPSEEK_API_KEY=sk-xxx
npm start              # 交互模式
npm start -- --resume  # 恢复上次会话
```

## 撞墙记录约定

每撞一次墙 = 一个 commit，标题格式：

```
feat: 实验 X 撞墙 — 一句话说明发现了什么问题、加了什么
```

历史即学习笔记，随时 `git log --oneline` 回顾演进过程：

| 提交 | 内容 |
|---|---|
| docs | 学习规划 + v1 架构设计 |
| feat | Mini Harness v1 — 最小闭环 |
| feat(permission) | 实验 A：让 agent 删文件，它真删了 → 加权限层 |
| feat(context) | 实验 B：上下文 10 回合涨 26 倍 → 加 Compaction 压缩 |

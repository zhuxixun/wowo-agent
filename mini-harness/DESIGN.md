# Mini Harness 设计文档 (v1 — 最简陋版)

> 目标: 用 ~300 行 TypeScript、**零运行时依赖**，实现一个"能自己干活"的 agent 最小闭环。
> 对照 gpt-plan.md Phase 1: 这个版本**故意**只做最小集，其他一切都留给"撞墙之后"。

---

## 0. 一句话定义

**一个 agent = 一个 while 循环 + 一个 LLM + 一堆字符串进出的工具。**

v1 不引入任何额外概念（没有权限、没有沙箱、没有规划、没有状态机）。

---

## 1. 总览架构

```
┌─────────────────────────────────────────────────────┐
│                   main.ts (REPL 入口)                │
│   读用户输入 → 交给 loop → 打印最终回复               │
└──────────────┬──────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────┐
│              agent-loop.ts (核心循环)                 │
│                                                     │
│   while (步数 < MAX_STEPS):                         │
│     messages + tool schemas ──▶ llm.chat()          │
│                                 │                   │
│                    有 tool_calls ?                  │
│                    ├─ 否 → 返回最终文本              │
│                    └─ 是 → tools.execute()          │
│                                 │                   │
│             结果作为 tool 消息追加回 messages          │
└──────┬──────────────────────────────┬───────────────┘
       ▼                              ▼
┌──────────────┐            ┌──────────────────────┐
│   llm.ts     │            │   permission.ts      │
│ OpenAI 兼容   │            │   执行前拦截          │
│ chat() 无状态 │            │   allow / ask / deny │
└──────────────┘            └──────────┬───────────┘
                                        ▼
                               ┌──────────────────┐
                               │    tools.ts      │
                               │ 注册表 + 3 个工具  │
                               │ read/write/bash  │
                               └──────────────────┘
       ▲                              │
       │  只追加，无状态                ▼
┌──────┴──────────────────────────────┐
│        session.ts (JSONL 落盘)       │
│   每次对话结束把 messages 全量追加写入 │
└─────────────────────────────────────┘
```

七个文件，单向依赖，无环：

```
main.ts → agent-loop.ts → { llm.ts, permission.ts, tools.ts, session.ts }
```

---

## 2. 数据模型（整个系统的唯一事实来源）

**只有一种状态：`messages` 数组。** 没有 agent state、没有 memory 对象、没有会话对象。

```ts
// types.ts
type Message =
  | { role: 'system';  content: string }
  | { role: 'user';    content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';    tool_call_id: string; content: string }

interface ToolCall {
  id: string                       // 例如 "call_abc123"
  type: 'function'
  function: { name: string; arguments: string }  // arguments 是 JSON 字符串
}
```

这就是 OpenAI / DeepSeek chat API 的 messages 格式，原样透传，不做任何包装。

推论（刻意为之）：

- **对话恢复** = 从 JSONL 读回数组
- **上下文** = 数组本身（膨胀了再说，见第 6 节）
- **未来的一切改造**（权限、压缩、日志）都只需要在这一种数据上做文章

---

## 3. 七个模块

### 3.1 `llm.ts` — 模型适配层（无状态）

```ts
interface LLMClient {
  chat(messages: Message[], tools: ToolSchema[]): Promise<AssistantReply>
}
// AssistantReply = { message: Message(assistant), usage?: {…} }
```

- 用 Node 内置 `fetch` 调 `POST {baseURL}/chat/completions`
- 配置走环境变量: `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`(默认 `https://api.deepseek.com`) / `DEEPSEEK_MODEL`(默认 `deepseek-chat`)
- 不流式（全量等回复，最简陋）
- 不做重试、不做超时之外的处理

### 3.2 `tools.ts` — 工具注册表 + 3 个工具

```ts
interface Tool {
  name: string
  description: string                // 给模型看的自然语言
  parameters: Record<string, unknown> // JSON Schema，给模型看
  run(args: Record<string, unknown>): Promise<string>  // 返回纯文本
}
```

- 注册表就是一个 `Map<string, Tool>` + `register() / listSchemas() / execute(name, args)`
- 内置工具只做 3 个：
  - `read_file(path)` — 读文件，超 5000 行截断
  - `write_file(path, content)` — 写文件（自动建目录）
  - `bash(command)` — 在项目根目录跑 shell 命令，返回 stdout+stderr
- **不校验参数 JSON Schema**（模型传错就报错，报错返回给模型自己改）

### 3.3 `agent-loop.ts` — 核心循环

```ts
async function runAgent(messages: Message[], tools: ToolRegistry): Promise<string> {
  const MAX_STEPS = 25
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await llm.chat(messages, tools.listSchemas())
    messages.push(reply.message)

    if (!reply.message.tool_calls?.length) return reply.message.content ?? ''   // ① 停

    for (const call of reply.message.tool_calls) {                              // ② 执行
      const args = JSON.parse(call.function.arguments)
      const d = permission.decide(call.function.name, args)                     // ②' 权限
      allow → 直接执行
      ask   → confirm(question) ? 执行 : '用户拒绝了该操作'
      deny  → '权限拒绝: reason'
      三种结果都作为 tool 消息返回给模型（拒绝是信息，不是崩溃）
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }
  return '(达到步数上限，未完成任务)'
}
```

**终止条件只有两个**：模型不再要工具 / 步数上限。没有别的。

### 3.4 `session.ts` — JSONL 落盘

- `load(file): Message[]` — 读回历史
- `append(file, messages)` — 只追加**本次新增**的消息（按条数偏移量）
- 每次对话结束调用一次，一条消息一行

### 3.5 `permission.ts` — 权限策略层（v1.1 新增）

```ts
type Decision = { action: 'allow' } | { action: 'ask'; question: string } | { action: 'deny'; reason: string }
function decide(toolName: string, args): Decision
```

- 插在 `agent-loop` 与 `tools.execute` 之间，循环只问一句"放不放行"，不写死规则
- 危险命令前缀表（rm / mv / sudo / git push / …），朴素匹配，不做 bash 解析
- 用户确认回调由 `main.ts` 注入；**非交互模式（管道/EOF）默认拒绝**，安全默认

### 3.6 `main.ts` — REPL 入口

- `node main.ts` → 进入 `你 > ` 交互；`node main.ts --resume` → 从 JSONL 恢复上下文
- 每次对话: 读输入 → 组装 system prompt → `runAgent()` → 打印最终回复 → `session.append()`
- Ctrl+C / `exit` 退出

System prompt（就这些，不写花活）：

```
你是 wowo-agent，一个运行在用户电脑上的命令行助手。
你可以使用工具完成任务。工具结果会以 tool 消息返回给你。
复杂任务要一步步来：先了解情况，再行动，最后验证。
回答要简洁，用中文。
```

---

## 4. 三个关键设计决策（以及为什么）

| 决策 | 为什么 | 代价（留到第 6 节炸） |
|---|---|---|
| **messages 数组是唯一状态** | 可序列化、可恢复、零抽象 | 上下文无限膨胀；无法区分"历史"和"工作记忆" |
| **工具返回值是纯文本** | 模型 API 只认字符串 | 结果没法结构化解析 |
| **工具抛错不中断循环，错误文本回传给模型** | 控制权在模型手里——这是 agent 和普通程序的本质区别：模型自己决定怎么恢复 | 可能反复错、浪费步数 |

---

## 5. 故意的"缺失"清单（撞墙点，按 gpt-plan.md 的路线埋伏好）

| 现在没有 | 什么时候会痛 | 对应实验 → 将来长成什么 |
|---|---|---|
| ~~工具执行前检查~~ ✅ v1.1 已加 | 让 agent `rm` 一个文件，它真删了 → 于是有了 `permission.ts` | 实验 A → **Permission 层**（已实现，见 §3.6） |
| 上下文裁剪 | 第 30 轮，token 爆炸，API 报错 | 实验 B → **Compaction / Summary** |
| 多会话隔离 | JSONL 里混着好几天的对话 | 实验 C → **Session 对象**（现在是裸数组） |
| 统一执行环境 | bash 的 cwd 和文件路径对不上，agent 找不着文件 | 实验 D → **Sandbox / Workspace** |
| 多模型 | 想换 Claude/GPT，发现工具调用格式有差异 | 实验 E → **Model Adapter**（现在只有一个 openai-compatible 实现） |

**明确不做**：流式输出、token 计数、并发、多会话、思考/规划模块、JSON Schema 校验、流式 UI。

---

## 6. v1.1 变更日志

- 新增 `permission.ts`：执行前拦截，三种裁决 allow / ask / deny（来自实验 A 的撞墙）
- 关键决策：
  - **政策与执行分离**：工具不自己判断，循环不写死规则，策略集中在 permission 模块
  - **拒绝是信息不是崩溃**：deny / 用户拒绝都作为 tool 消息返回，模型自己换策略（比如改个写法）
  - **默认安全**：非交互模式下 confirm 恒为 false，危险操作一律拒绝
- 已知局限：朴素字符串匹配防不住 `python -c "import os; os.remove(...)"` 这类绕过——真正要堵住得做 bash 解析 + 进程沙箱（那是实验 D 的事）

## 7. 验收标准

1. `node main.ts` 输入 "写一个 hello.py 并用 python 运行它" → 能看到 `write_file → bash` 的工具调用序列 → 正确输出运行结果
2. 输入 "把 hello.py 删掉" → 它真的删了（没有权限层，这就是实验 A 的触发点）
3. 退出后 `node main.ts --resume` → 它记得之前的对话
4. 数一数：总代码 ≤ 500 行（不含 DESIGN.md）

---

## 8. 已知的坑（先写进文档，防止到时候甩锅给 LLM）

- 某些模型要求 `tool_calls` 存在时 `content` 必须为 `null`，注意组装
- `tool` 消息必须**按 tool_calls 的声明顺序**逐条追加，顺序错模型会报错
- `arguments` 是 JSON 字符串，`JSON.parse` 失败时把错误文本返回给模型而不是崩掉
- 一个 turn 里多个 tool_calls 是并行的（API 行为），v1 顺序执行即可

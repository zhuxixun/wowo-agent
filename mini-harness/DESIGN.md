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
│     messages 超阈值? ──▶ context.ts 压缩旧历史      │
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

## 3. 十个模块

### 3.1 `llm.ts` — 模型适配层工厂（v1.5 拆分）

```ts
interface LLMClient {                       // Harness 与 Model 的边界
  chat(messages: Message[], tools: ToolSchema[]): Promise<AssistantReply>
}
createClientFromEnv(): LLMClient             // 按 LLM_PROVIDER 选适配器
```

- 内部词汇表是 OpenAI 形状 → openai 适配器（`llm-openai.ts`）近乎直通，只做字段净化
- anthropic 适配器（`llm-anthropic.ts`）在边界翻译 6 处差异：system 抽顶层、`tool` 角色→`tool_result` block、`tool_calls`→`tool_use` block、tools 形状、max_tokens 必填、连续 tool 消息合并
- 换模型 = 换环境变量：`LLM_PROVIDER=openai|anthropic` + 各家 KEY/BASE_URL/MODEL
- 不流式（全量等回复，最简陋）；不做重试

### 3.10 `mock-anthropic.ts` — 本地 mock Anthropic API（v1.5 新增）

复刻 Anthropic 的校验规则（角色、tools 形状、tool_result 紧邻）和响应形状。没有真 key 也能撞墙、也能验证适配器——也证明了实验 E 的墙是真的。

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

### 3.4 `session.ts` — 会话层（v1.3 重写）

```ts
listSessions(): Promise<SessionInfo[]>          // 列出所有会话, 按更新时间倒序
resolveSession(query?): Promise<Session | null> // 无 query → 最新; 有 → id/标题模糊匹配
appendSession(id, messages, fromIndex)          // 只追加本次新增的消息
```

- 一个会话一个文件 `sessions/<id>.jsonl`（id = 毫秒时间戳，`--new <名字>` 带名字后缀）
- 标题不存储：列出时从第一条 user 消息派生，避免维护元数据
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

### 3.7 `context.ts` — 上下文管理（v1.2 新增）

```ts
estimateTokens(messages): number   // 粗略估算: 中英混合约 3 字符/token
shouldCompact(messages): boolean   // 超阈值(默认 12K, 可环境变量调)
compactMessages(llm, messages)     // 旧历史压成摘要
```

- 压缩策略: 保留 system + 当前回合，中间的旧消息让 LLM 总结成一条 `[历史摘要]`
- **为什么从"最后一个 user 消息"切**：回合内可能有未完成的 tool_calls / tool 结果，从中间切开会产生非法消息序列，API 直接报错
- 摘要也是 LLM 调用，因此 agent 的记忆是"损失压缩"——这是接受了的代价

### 3.9 `workspace.ts` — 工作区 / 沙箱（v1.4 新增）

```ts
export const WORKSPACE: string                 // 默认启动目录, WORKSPACE 环境变量可覆盖
resolveInWorkspace(p): string | null           // 解析并检查; 逃逸返回 null
isInsideWorkspace(fullPath): boolean
```

- 文件工具（read/write）硬性围栏：路径必须落在工作区内，逃逸直接拒绝
- 权限层补充：bash 引用工作区外绝对路径 / `..` 相对穿越 → 需要用户确认
- **诚实边界**：这是"文件工具级"沙箱。bash 里 `cd /`、python 里 `os.open()` 仍可绕——真正的沙箱是 OS 级进程隔离（docker/bwrap/seccomp），这就是为什么真实 Harness 有独立的 Sandbox 组件

---

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
| ~~上下文裁剪~~ ✅ v1.2 已加 | 连续 10 回合上下文涨 26 倍（179 → 4653 tokens）→ 于是有了 `context.ts` | 实验 B → **Compaction / Summary**（已实现，见 §3.7） |
| ~~多会话隔离~~ ✅ v1.3 已加 | 两天两个任务混在同一个 JSONL，resume 后问"第一个任务"它答"第二个任务" → 于是重写了 `session.ts` | 实验 C → **Session 对象**（已实现，见 §3.4） |
| ~~统一执行环境~~ ✅ v1.4 已加 | agent 直接读了 /tmp 下的"机密文件"，`../` 穿越畅通 → 于是有了 `workspace.ts` | 实验 D → **Sandbox / Workspace**（已实现，见 §3.9） |
| ~~多模型~~ ✅ v1.5 已加 | OpenAI 格式原样发给 Claude → 400 "Input should be 'user' or 'assistant'" → 于是有了适配器工厂 | 实验 E → **Model Adapter**（已实现，见 §3.1） |

**明确不做**：流式输出、token 计数、并发、多会话、思考/规划模块、JSON Schema 校验、流式 UI。

---

## 6. 变更日志

### v1.5 — 实验 E：换模型撞格式墙 → Model Adapter（llm.ts 拆成工厂 + 适配器）

- 撞墙实测：OpenAI 格式（role:'system' + type:'function' 工具包装）原样发给 Anthropic → 400：`messages.role: Input should be 'user' or 'assistant' (got "system")`
- 彩蛋：环境里没有真 Anthropic key（~/.zshrc 的 ANTHROPIC_AUTH_TOKEN 其实是 DeepSeek key 的复制品，直连 401）→ 写了 mock-anthropic.ts 复刻 Anthropic 校验规则，本地照样撞墙和验证
- 修复：内部词汇表保持 OpenAI 形状，所有 provider 在边界翻译。llm-anthropic.ts 处理 6 处差异（见 §3.1）
- 验证：mock 全链路（工具调用循环跑通）；翻译单测（system 抽取 / tool 消息合并 / 响应翻译）；DeepSeek 回归正常
- 教训：**Adapter 的职责不是"适配所有模型"，而是把"我们的词汇表"翻译成"各家词汇表"**——所以内部词汇表只要选一个形状，其他都在边界翻译

### v1.4 — 实验 D：agent 能读机器上任何文件 → 工作区沙箱（workspace.ts）

- 撞墙实测：让 agent 读 `/tmp/wowo-secret.txt`，它读到了还开玩笑说"我会保守秘密的"；`../README.md` 穿越也畅通
- 修复：新增 workspace.ts 定义统一执行环境；文件工具硬性围栏（逃逸即拒）；权限层补 bash 绝对路径 + `..` 穿越检查
- 后门实录：`read_file ../` 被拒后，agent 改用 `bash cat ../README.md` 得手 → 补上 `..` 规则 → 再测三层全堵住，agent 老实承认读不到
- 诚实边界：工具级沙箱挡不住进程级逃逸（python os.open / cd /），真正的沙箱 = OS 级进程隔离，这是真实 Harness 有 Sandbox 组件的原因

### v1.3 — 实验 C：会话混成一锅粥 → 一个会话一个文件（session.ts 重写）

- 撞墙实测：两天两个任务写进同一个 session.jsonl，resume 后问"我们之前的第一个任务是什么"，模型把两天当成同一段对话，答"后续第二个任务是计算 57*43"
- 修复：一个会话一个文件 `sessions/<id>.jsonl`；`--list` 列出、`--new <名字>` 新建、`--resume <id|关键字>` 恢复指定
- 标题不存储，列出时从第一条 user 消息派生（不维护元数据）
- 验证：会话 A（hello.py）恢复后只记得自己的任务，正确答出第一个任务，且明确 57*43 属于另一个会话

### v1.2 — 实验 B：上下文膨胀 → 压缩（context.ts + bench.ts）

- 撞墙数据：10 回合无压缩，上下文 179 → 4653 tokens（26 倍）；读大文件一跳 +3.5K
- 修复：超阈值时把"已完成的旧对话"让 LLM 压成摘要，保留 system + 当前回合
- 验证：阈值 4000，12 回合只压缩 1 次（4119 → 484），后续任务答案全部正确（1060 / 338350 / 56088 / 1073741824）
- 已知局限：摘要式压缩是损失压缩，太久远的事实可能丢；压缩本身也消耗一次 LLM 调用

### v1.1 — 实验 A：删文件 → 权限层（permission.ts）

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
4. 数一数：总代码 ≤ 500 行（不含 DESIGN.md、bench.ts）

---

## 8. 已知的坑（先写进文档，防止到时候甩锅给 LLM）

- 某些模型要求 `tool_calls` 存在时 `content` 必须为 `null`，注意组装
- `tool` 消息必须**按 tool_calls 的声明顺序**逐条追加，顺序错模型会报错
- `arguments` 是 JSON 字符串，`JSON.parse` 失败时把错误文本返回给模型而不是崩掉
- 一个 turn 里多个 tool_calls 是并行的（API 行为），v1 顺序执行即可
- 压缩会丢细节：摘要只保留要点，太久远的对话模型只能"凭印象"（损失压缩的代价）
- 会话文件在 `sessions/` 目录（gitignore）；删除即忘，没有回收站
- 沙箱是工具级的：bash 后门（`cd /`、python `os.open`）堵不住，要真隔离得上 OS 进程沙箱
- Anthropic 形状的坑：max_tokens 必填；tool_result 必须紧邻 tool_use 且在同一 user 消息里；arguments 是 JSON 字符串，Anthropic 要对象——这些都是适配器的活，别漏

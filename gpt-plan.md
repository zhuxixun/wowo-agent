可以，而且我建议把目标定得比“学会用 DeepSeek Harness”高一档：**趁它刚开源，把它当成一个活体样本，完整研究“一个现代 Agent Harness 是怎么长出来的”。**

DeepSeek 官方在 2026 年 8 月刚发布这个项目，目前仍是 developer preview，并明确提醒后续会发生 breaking changes。它的核心主张不是某个 Coding Agent 功能，而是 **“Everything is a Plugin”**：模型、工具、Skills、Session、Sandbox、Storage、Agent Loop、调度、UI 都是可替换插件；底层由 Cordis 管理插件生命周期、服务、依赖和事件。([GitHub][1])

所以我建议做一个 **6 阶段、约 5～6 周** 的“拆解—复现—改造”计划。

---

# 一、先把最终目标定清楚

不要把结业标准设成：

> 我会安装 DSH、会配置模型、会写插件。

这太浅。

最终你应该能不看文档回答下面 7 个问题：

1. **LLM 为什么加一层 Harness 就变成 Agent？**
2. 一条用户消息进入 DSH 后，到底经过哪些组件，最后为什么会触发工具？
3. Agent Loop、Tool、Session、Context、Sandbox、Permission 分别解决什么问题？
4. 为什么 DeepSeek 不直接写一个 Agent 类，而要引入 Cordis？
5. “Everything is a Plugin”到底是真架构，还是营销语言？
6. Claude Code / Codex / DSH 的 Harness 设计到底有什么本质差异？
7. 如果让你重新设计 DSH，你会保留什么、删除什么、增加什么？

最后最好做到：

> **自己从零实现一个 Mini Harness + 给 DSH 写 2～3 个真正有意义的插件 + 写一份架构批判报告。**

这才算“弄透”。

---

# 二、整体学习路线

我建议不要：

**读文档 → 读源码 → 写插件**

而是：

**自己造最简 Harness → 理解 Cordis → 拆 DSH → 做实验 → 魔改 → 横向比较**

原因很简单：如果你一上来读 DSH 的源码，你会看到大量 interface、event、context、service、scope、plugin，然后知道“它怎么写”，但不知道：

> **为什么非得这么写。**

自己先撞一次墙，理解会完全不同。

---

# Phase 0：冻结一个“创世版本”

时间：**半天**

第一件事不是学习，而是 fork。

官方现在明确说 API 仍在快速演进、会 breaking。([GitHub][1])

因此建立：

```text
deepseek-harness-lab/
├── upstream/
├── mini-harness/
├── plugins/
├── experiments/
├── notes/
└── CHANGELOG-study.md
```

把你开始学习当天的：

```text
commit hash
日期
版本
目录结构
```

记录下来。

以后每周：

```bash
git fetch upstream
git diff <你的基准commit> upstream/master
```

### 这件事情其实很重要

因为你现在有一个后来者无法获得的机会：

**观察一个 Harness 在开发者预览期里，架构到底怎么演化。**

比如：

* 哪些 API 一周后被废弃？
* 哪些 plugin seam 不够用？
* 哪些 capability 被重新抽象？
* 哪些功能被从 Core 挪成 Plugin？

这些变化甚至比静态源码本身更有研究价值。

---

# Phase 1：不要碰 DSH，先自己写一个 300～500 行 Harness

时间：**3～4 天**

这是整个规划里我最建议你不要跳过的一步。

先实现：

```text
User
 ↓
LLM
 ↓
tool_call?
 ├─ no → response
 └─ yes
     ↓
   execute tool
     ↓
   ToolResult
     ↓
   LLM
     ↓
   ...
```

只需要六个模块：

```text
mini-harness/
├── llm.ts
├── agent-loop.ts
├── tools.ts
├── session.ts
├── bash.ts
└── main.ts
```

能力只做：

* DeepSeek/OpenAI Compatible API
* `read_file`
* `write_file`
* `bash`
* tool calling
* multi-turn loop
* JSONL session log

### 第一阶段要主动制造问题

例如：

**实验 A**

让 Agent 删除一个文件。

你会马上发现：

> 工具不能直接执行，需要 Permission。

**实验 B**

连续工作 30 轮。

发现：

> Context 越来越长，需要 Compaction。

**实验 C**

程序退出再启动。

发现：

> Agent 状态丢了，需要 Session Persistence。

**实验 D**

Shell 和 File 操作目录不一致。

发现：

> 需要统一 Execution Environment / Sandbox。

**实验 E**

换 DeepSeek → Claude → GPT。

发现：

> 需要 LLM Adapter。

这时候你会亲自推导出：

```text
Harness
├── Model Adapter
├── Agent Loop
├── Context
├── Tools
├── Permission
├── Session
├── Sandbox
└── Persistence
```

而不是别人告诉你 Harness 有这些东西。

---

# Phase 2：单独把 Cordis 搞明白

时间：**4～5 天**

这是 DSH 最容易被低估、但实际上最关键的一层。

官方架构直接说明：

> DSH 没有一个“特权 Core”供你不断 patch；Model Adapter、Tool Registry、Session Log、Agent Loop 本身都是插件。([GitHub][2])

也就是说真正结构不是：

```text
DeepSeek Harness
   ↓
Plugin System
```

而更接近：

```text
Cordis
 │
 ├── Agent Loop Plugin
 ├── Session Plugin
 ├── LLM Plugin
 ├── Tool Plugin
 ├── Sandbox Plugin
 ├── UI Plugin
 └── ...
```

所以 Cordis 必须单独学。

官方教程本身就按照：

**Plugin → Lifecycle/Effects → Services → Events → Configuration → Composition/HMR → Harness**

来教学。([Deepseek Harness][3])

你重点搞懂五个概念：

```text
Context
Plugin
Service
Event
Effect
```

尤其是：

### Effect

这是我认为最值得研究的 Cordis 思想。

插件注册：

```text
event
tool
timer
service
```

卸载插件以后，这些副作用能够自动撤销。官方教程明确展示了插件 unload 时注册行为会被清理。([Deepseek Harness][3])

想明白：

> **为什么一个动态可组合 Agent Runtime 特别需要这种 lifecycle semantics？**

这一步吃透以后，DSH 一半源码都会突然变简单。

---

# Phase 3：正式拆 DeepSeek Harness

时间：**约 1 周**

这时候才开始读源码。

而且不要按目录顺序。

按照“一条请求的生命线”读。

## 第一条：Session

先读：

```text
core/session
```

DSH 有个非常重要的设计：

> **Session Event Log 是模型上下文的事实来源。**

所有模型看到过的东西必须可以由日志重建，包括：

* system prompt
* user message
* reasoning
* assistant chunk
* tool call
* tool result
* context injection

Resume、Fork、Replay、Telemetry 都建立在同一个 append-only event stream 上。([GitHub][2])

这个思想要重点研究。

本质接近：

**Agent Runtime + Event Sourcing**

而不是普通 chat history。

---

## 第二条：System Prompt / Context

读：

```text
core/system-prompt
```

搞清：

```text
System Prompt
+
Tools Schema
+
Session History
+
Injected Context
        ↓
最终 Model Input
```

关键问题：

> **谁有资格改变模型看到的 Context？**

---

## 第三条：LLM

读：

```text
llm/llm
```

搞懂：

```text
Model-independent vocabulary
        ↓
LLM Adapter
        ↓
DeepSeek / OpenAI / ...
```

把：

**Harness 与 Model 的边界**

真正找出来。

---

## 第四条：Tools

读：

```text
core/tools
```

然后重点跟一次：

```text
tool/call
 ↓
tools/pre-execute
 ↓
tools/execute
 ↓
tools/post-execute
 ↓
tool/result
```

官方实际上把 Permission、Sandbox、Retry、Metrics 等能力都放在这些 extension point 上，而不是硬编码进 Agent Loop。([GitHub][4])

这就是所谓：

**Capability Seam**

---

## 第五条：Agent / Agent Loop

最后才读：

```text
core/agent
core/agent-loop
```

把官方这条 Turn Flow 自己画出来：

```text
turn/start
   ↓
claim input
   ↓
agent/pre-step
   ↓
step/start
   ↓
assemble prompt
   ↓
agent/request
   ↓
llm/stream
   ↓
assistant/message
   ↓
tool call
   ↓
tool result
   ↓
需要继续？
 ├── Yes → next step
 └── No
       ↓
turn/end
```

官方将 **step** 定义为“一次 model request + 它调用的 tools”，而一个 **turn 可以包含多个 step**。([GitHub][2])

这个概念非常关键。

---

# Phase 4：用插件“攻击”这个架构

时间：**约 1 周**

不要写 Hello World Plugin 就结束。

做五个实验。

### 实验 1：Tool Plugin

自己做：

```text
repo_analyzer
```

输入 repository，输出：

* language
* package
* dependency
* LOC
* entrypoint

目的：

**搞懂 Tool 注册和 Tool Schema。**

官方插件本身就是通过 `ctx.tools.register()` 加入 Tool Registry。([GitHub][4])

---

### 实验 2：Permission Plugin

拦截：

```text
tools/pre-execute
```

规则：

```text
rm → deny
git push → ask
cat → allow
```

目的：

理解：

> Permission 为什么应该是 Policy Plugin，而不是 Tool 内部 if/else。

---

### 实验 3：Context Plugin

每轮自动注入：

```text
当前 repo
当前 branch
最近 commit
当前任务 goal
```

然后观察：

```text
agent/pre-step
```

以及 Session Log。

目的：

理解：

**Context Engineering 到底属于 Harness 的哪一层。**

---

### 实验 4：自己实现一个 Mini Compaction

当 token 超过阈值：

```text
old events
 ↓
summary
 ↓
compact context
```

然后比较：

```text
无 compaction
官方 compaction
你的 compaction
```

---

### 实验 5：自己造一个 Mode

官方目前就有：

* Standard
* Code
* Minimal
* Creator

其中 Minimal 只保留 bash + `str_replace_editor`；Code Mode 则让模型通过生成 TypeScript 程序组合多轮工具调用。([DeepSeek][5])

你自己做：

```text
Research Mode
```

只允许：

```text
web
read
grep
bash read-only
```

禁止：

```text
write
delete
git push
```

这时候你就真正理解：

**Profile / Bundle / Plugin composition。**

---

# Phase 5：做一次“Harness 解剖实验”

时间：**约 1 周**

开始问真正有意思的问题。

把同一个任务跑四遍：

```text
DSH Minimal
DSH Standard
DSH Code
你的 Mini Harness
```

例如：

> 分析一个陌生 GitHub Repository，找到 bug，修改并跑测试。

记录：

| 指标             | Mini | Minimal | Standard | Code |
| -------------- | ---: | ------: | -------: | ---: |
| Model requests |      |         |          |      |
| Tool calls     |      |         |          |      |
| Tokens         |      |         |          |      |
| Wall time      |      |         |          |      |
| Failed calls   |      |         |          |      |
| Context size   |      |         |          |      |
| Task success   |      |         |          |      |

然后你开始研究真正的 Harness 问题：

### Harness 能力究竟来自哪？

到底是：

```text
更聪明的 Prompt
更多 Tools
更好的 Tool Schema
更好的 Loop
更好的 Context
更好的 Planning
更好的 Error Recovery
```

哪个贡献最大？

这比单纯读源码重要得多。

---

# Phase 6：最终毕业项目

我建议最终做一个：

## `dsh-lab`

不是 fork 改个 UI，而是：

```text
dsh-lab
├── architecture-notes
├── mini-harness
├── custom-mode
├── custom-tools
├── custom-context
├── custom-permission
├── benchmark
└── deepseek-harness-analysis.md
```

最终形成三个成果。

### 成果 ① Mini Harness

你自己能解释：

```text
Model
Loop
Context
Tool
Session
Permission
Sandbox
```

每层为什么存在。

### 成果 ② DSH Plugin Pack

至少三个：

```text
dsh-repo-intelligence
dsh-context-manager
dsh-safe-execution
```

### 成果 ③ 《DeepSeek Harness 架构解剖》

内容不要写成教程，而写成判断：

```text
1 Harness 到底是什么
2 DeepSeek Harness 的设计哲学
3 Cordis 为什么存在
4 Agent Loop 解剖
5 Event Sourcing Session
6 Capability Seam
7 Everything is Plugin 的收益
8 Everything is Plugin 的代价
9 与 Claude Code / Codex 的比较
10 我会如何重新设计 DSH
```

最后两章最重要。

---

# 我认为真正值得你重点追的 5 个问题

整个学习过程中，我会反复盯着这五个问题，而不是每个 package 都平均用力：

**① Agent Loop**

到底什么东西决定 Agent “继续工作还是停止工作”。

**② Context**

模型这一轮究竟看到了什么，谁决定它看到这些东西。

**③ Tool Runtime**

模型的“意图”怎样安全地变成真实世界的“动作”。

**④ State / Event**

一个 Agent 为什么能够 Resume、Fork、Replay 和长期工作。

**⑤ Composability**

为什么 DeepSeek 认为 Agent Harness 的正确抽象不是：

```text
Agent Framework
```

而是：

```text
Plugin Runtime
+
Capability Composition
```

DSH 官方架构里甚至明确强调：模型适配器、Tool Registry、Session Log 和 Agent Loop 自己都是插件，并且“没有 privileged core 可以 patch”。([GitHub][2])

**这可能才是 DeepSeek Harness 这次开源真正值得研究的地方。**

---

## 我建议你的节奏

如果业余时间做，不要搞成每天看两小时文档。

更合适的是：

**每周一个“可运行物”。**

```text
Week 1  自己写 Mini Harness
Week 2  Cordis + Plugin Runtime
Week 3  拆 DSH Agent Loop
Week 4  写 3~5 个插件
Week 5  Harness Benchmark
Week 6  架构批判 + 二次设计
```

这样六周以后，你学到的不会只是 **DeepSeek Harness**。

你实际上会建立一套：

> **理解 Claude Code、Codex、OpenCode、DeepSeek Harness 等所有 Agent Harness 的统一分析框架。**

而且现在这个时间点尤其好：DeepSeek 官方文档已经把插件、事件、Capability Seam、Session Log 等骨架放出来了，但整个生态还远没有固化。([Deepseek Harness][3])

如果你愿意继续按这个路线走，我建议我们下一步直接开始 **Phase 0 + Phase 1**：我可以先跟你一起设计那个**“绝对不参考 DeepSeek Harness 源码、从空目录开始实现的 Mini Harness”**，把第一版控制在 **300～500 行**，然后我们再拿它逐层对照 DSH。

[1]: https://github.com/deepseek-ai/deepseek-harness "GitHub - deepseek-ai/deepseek-harness: DeepSeek Harness: Everything is a Plugin. · GitHub"
[2]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"
[3]: https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/ "Your first plugin | DeepSeek Harness"
[4]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md "deepseek-harness/docs/cookbook/extension-cookbook.md at master · deepseek-ai/deepseek-harness · GitHub"
[5]: https://www.deepseek.com/harness/en/ "DeepSeek Harness developer preview: Everything is a plugin"

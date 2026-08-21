// Anthropic Messages API 适配器 (v1.5, 实验 E 撞墙产物)
//
// 撞墙: 把 OpenAI 格式原样发给 Anthropic → 400
//   messages.role: Input should be 'user' or 'assistant' (got "system")
//   之后还有一串: role:'tool' 不存在 / tools 没有 type:'function' 包装 / ...
//
// 与 OpenAI 形状的 6 处关键差异, 全部在这里翻译:
//   ① system 是顶层参数, 不是消息角色
//   ② 没有 role:'tool'; 工具结果 = user 消息里的 tool_result block
//   ③ 工具调用 = assistant content 里的 tool_use block (不是独立 tool_calls 字段)
//   ④ tools 是 {name, description, input_schema}, 无 type:'function' 包装
//   ⑤ max_tokens 必填, 无默认值
//   ⑥ 连续 tool 消息必须合并成一条 user 消息 (Anthropic 要求紧邻)
import type { AssistantReply, Message, ToolCall, ToolSchema } from './types.ts'

export class LLMAnthropicClient {
  constructor(
    private opts: { apiKey: string; baseURL: string; model: string; maxTokens: number },
  ) {}

  async chat(messages: Message[], tools: ToolSchema[]): Promise<AssistantReply> {
    const { system, messages: wireMessages } = toAnthropic(messages)

    const res = await fetch(`${this.opts.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens, // ⑤ 必填
        ...(system ? { system } : {}),
        ...(tools.length ? { tools: tools.map(toAnthropicTool) } : {}),
        messages: wireMessages,
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`)
    }

    return fromAnthropic(await res.json())
  }
}

// ---------- 内部词汇表 → Anthropic 形状 ----------

interface WireBlock {
  type: string
  [k: string]: unknown
}

// 导出供单测/调试用
export function toAnthropic(messages: Message[]): { system: string; messages: unknown[] } {
  let system = ''
  const out: unknown[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      system += m.content + '\n' // ① system 抽到顶层
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] })
    } else if (m.role === 'assistant') {
      const blocks: WireBlock[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        // ③ tool_use block; arguments 是 JSON 字符串, Anthropic 要的是对象
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })
      }
      out.push({ role: 'assistant', content: blocks })
    } else {
      // ② role:'tool' → user 消息里的 tool_result block
      // ⑥ 连续 tool 消息合并进同一条 user 消息
      const last = out[out.length - 1] as { role: string; content: WireBlock[] } | undefined
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content })
      } else {
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
        })
      }
    }
  }

  return { system: system.trim(), messages: out }
}

function toAnthropicTool(t: ToolSchema) {
  // ④ 无 type:'function' 包装, input_schema 就是 parameters
  return { name: t.function.name, description: t.function.description, input_schema: t.function.parameters }
}

// ---------- Anthropic 形状 → 内部词汇表 ----------

// 导出供单测/调试用
export function fromAnthropic(data: any): AssistantReply {
  const blocks: WireBlock[] = data.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('')
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: String(b.id),
      type: 'function' as const,
      function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
    }))

  const usage = data.usage
  return {
    message: {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        }
      : undefined,
  }
}

export function createAnthropicClientFromEnv(): LLMAnthropicClient {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN
  if (!apiKey) {
    throw new Error('缺少环境变量 ANTHROPIC_API_KEY (LLM_PROVIDER=anthropic 时必需)')
  }
  return new LLMAnthropicClient({
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 8192),
  })
}

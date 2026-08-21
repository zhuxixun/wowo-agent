// OpenAI 兼容适配器 (DeepSeek / OpenAI / MiniMax / 一切 /chat/completions)
// 内部词汇表本来就是 OpenAI 形状, 所以这里近乎直通 — 这正是"选 OpenAI 形状当内部
// 词汇表"的好处; 代价是其他形状的 provider (如 Anthropic) 都要在边界翻译
import type { AssistantReply, Message, ToolSchema } from './types.ts'

export class LLMOpenAIClient {
  constructor(
    private opts: { apiKey: string; baseURL: string; model: string },
  ) {}

  async chat(messages: Message[], tools: ToolSchema[]): Promise<AssistantReply> {
    const res = await fetch(`${this.opts.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ model: this.opts.model, messages, tools }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`)
    }

    const data = await res.json()
    const choice = data.choices?.[0]
    if (!choice?.message) throw new Error(`LLM API 返回异常: ${JSON.stringify(data).slice(0, 500)}`)

    // 只保留 OpenAI 标准字段，丢弃 reasoning_content 等厂商扩展字段，
    // 否则把回复原样塞回 messages 再发出去时，部分 API 会拒绝
    const m = choice.message
    const message: Message = {
      role: 'assistant',
      content: m.content ?? null,
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
    }

    return { message, usage: data.usage }
  }
}

export function createOpenAIClientFromEnv(): LLMOpenAIClient {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('缺少环境变量 DEEPSEEK_API_KEY，例如: export DEEPSEEK_API_KEY=sk-xxx')
  }
  return new LLMOpenAIClient({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  })
}

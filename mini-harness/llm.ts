// 模型适配层工厂 (v1.5, 实验 E 撞墙产物)
// 内部词汇表 (types.ts) 是 OpenAI 形状; 每种 provider 一个适配器, 在边界翻译。
// 换模型 = 换环境变量, 一行代码不用改:
//   LLM_PROVIDER=openai     (默认) DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL
//   LLM_PROVIDER=anthropic          ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
import type { AssistantReply, Message, ToolSchema } from './types.ts'
import { createOpenAIClientFromEnv } from './llm-openai.ts'
import { createAnthropicClientFromEnv } from './llm-anthropic.ts'

// 所有适配器都满足这个接口 — 这是 Harness 与 Model 的边界
export interface LLMClient {
  chat(messages: Message[], tools: ToolSchema[]): Promise<AssistantReply>
}

export function createClientFromEnv(): LLMClient {
  const provider = process.env.LLM_PROVIDER ?? 'openai'
  switch (provider) {
    case 'anthropic':
      return createAnthropicClientFromEnv()
    case 'openai':
      return createOpenAIClientFromEnv()
    default:
      throw new Error(`未知 LLM_PROVIDER: ${provider} (支持 openai / anthropic)`)
  }
}

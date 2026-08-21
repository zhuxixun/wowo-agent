// 整个系统的唯一事实来源：messages 数组（OpenAI/DeepSeek chat 格式，原样透传）

export interface ToolCall {
  id: string // 例如 "call_abc123"
  type: 'function'
  function: { name: string; arguments: string } // arguments 是 JSON 字符串
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface AssistantReply {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// 发给 LLM 的 tools 参数格式
export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

// 工具接口：字符串进，字符串出
export interface Tool {
  name: string
  description: string // 给模型看的自然语言
  parameters: Record<string, unknown> // JSON Schema，给模型看
  run(args: Record<string, unknown>): Promise<string> // 返回纯文本
}

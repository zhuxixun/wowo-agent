// 核心循环：这是整个 agent 的心脏，只有两个终止条件
//   ① 模型不再要工具   ② 达到步数上限
import type { LLMClient } from './llm.ts'
import type { ToolRegistry } from './tools.ts'
import type { Message } from './types.ts'

const MAX_STEPS = 25

export async function runAgent(
  llm: LLMClient,
  tools: ToolRegistry,
  messages: Message[],
): Promise<string> {
  for (let step = 1; step <= MAX_STEPS; step++) {
    const { message } = await llm.chat(messages, tools.listSchemas())
    messages.push(message)

    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      return message.content ?? ''
    }

    for (const call of calls) {
      let result: string
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>
        console.log(`  [step ${step}] ${call.function.name} ${shorten(JSON.stringify(args))}`)
        result = await tools.execute(call.function.name, args)
      } catch (err) {
        // 参数解析失败：把错误文本返回给模型而不是崩掉
        result = `参数解析失败: ${err instanceof Error ? err.message : String(err)}`
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }
  return '(达到步数上限，未完成任务)'
}

function shorten(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

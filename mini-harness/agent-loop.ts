// 核心循环：这是整个 agent 的心脏，只有两个终止条件
//   ① 模型不再要工具   ② 达到步数上限
import type { LLMClient } from './llm.ts'
import type { ToolRegistry } from './tools.ts'
import type { Message } from './types.ts'
import { decide } from './permission.ts'
import { estimateTokens, shouldCompact, compactMessages } from './context.ts'

const MAX_STEPS = 25

// confirm: 用户确认回调。缺省拒绝（非交互环境的安全默认）
export async function runAgent(
  llm: LLMClient,
  tools: ToolRegistry,
  messages: Message[],
  confirm: (question: string) => Promise<boolean> = async () => false,
): Promise<string> {
  for (let step = 1; step <= MAX_STEPS; step++) {
    // 实验 B 的墙: 上下文只增不减。超阈值就把旧历史压成摘要再继续
    if (shouldCompact(messages)) {
      console.log(`  [context] ~${estimateTokens(messages)} tokens 超限，压缩历史…`)
      messages.splice(0, messages.length, ...(await compactMessages(llm, messages)))
      console.log(`  [context] 压缩后 ~${estimateTokens(messages)} tokens`)
    }

    const { message, usage } = await llm.chat(messages, tools.listSchemas())
    console.log(
      `  [step ${step}] context ~${estimateTokens(messages)} tokens` +
        (usage?.prompt_tokens ? ` (api prompt ${usage.prompt_tokens})` : ''),
    )
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

        // 执行前先过权限层；拒绝/允许都作为 tool 消息返回给模型，由模型自己调整策略
        const decision = decide(call.function.name, args)
        if (decision.action === 'deny') {
          result = `权限拒绝: ${decision.reason}`
        } else if (decision.action === 'ask') {
          result = (await confirm(decision.question))
            ? await tools.execute(call.function.name, args)
            : '用户拒绝了该操作（权限控制）'
        } else {
          result = await tools.execute(call.function.name, args)
        }
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

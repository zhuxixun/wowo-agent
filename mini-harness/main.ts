// 入口：REPL。每次对话 = 读输入 → 组装 system prompt → runAgent → 落盘
import { createInterface } from 'node:readline'
import { createClientFromEnv } from './llm.ts'
import { createDefaultTools } from './tools.ts'
import { runAgent } from './agent-loop.ts'
import { loadSession, appendSession } from './session.ts'
import type { Message } from './types.ts'

const SYSTEM_PROMPT = `你是 wowo-agent，一个运行在用户电脑上的命令行助手。
你可以使用工具完成任务。工具结果会以 tool 消息返回给你。
复杂任务要一步步来：先了解情况，再行动，最后验证。
回答要简洁，用中文。`

async function main() {
  const resume = process.argv.includes('--resume')

  const llm = createClientFromEnv()
  const tools = createDefaultTools()

  let messages: Message[] = []
  if (resume) {
    messages = await loadSession()
    console.log(`已恢复 ${messages.length} 条历史消息`)
  }
  // system prompt 保证始终存在（恢复旧会话时补上）
  if (messages.length === 0) messages.push({ role: 'system', content: SYSTEM_PROMPT })
  else if (messages[0].role !== 'system') messages.unshift({ role: 'system', content: SYSTEM_PROMPT })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let inputClosed = false
  rl.on('close', () => {
    inputClosed = true
  })
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      // 输入流关闭（EOF）时优雅退出，而不是抛 ERR_USE_AFTER_CLOSE
      if (inputClosed) return resolve('exit')
      rl.question(q, resolve)
      rl.once('close', () => resolve('exit'))
    })

  console.log('wowo-agent (最简陋版) — 输入 exit 退出')

  while (true) {
    const input = (await ask('\n你 > ')).trim()
    if (!input) continue
    if (input === 'exit' || input === 'quit') break

    const persisted = messages.length // 落盘偏移量：只写本次新增的
    messages.push({ role: 'user', content: input })

    try {
      const answer = await runAgent(llm, tools, messages)
      console.log(`\nagent > ${answer}`)
    } catch (err) {
      console.error(`\n出错: ${err instanceof Error ? err.message : err}`)
      messages.length = persisted // 回滚本次对话的全部消息，避免污染上下文
    }

    await appendSession(messages, persisted)
  }

  rl.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

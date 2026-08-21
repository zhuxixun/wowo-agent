// 实验 B 演示/基准脚本: 连续投喂 N 个任务, 观察上下文增长 (也是后续 benchmark 的雏形)
// 用法:
//   MAX_CONTEXT_TOKENS=999999 npx tsx bench.ts   # 不压缩, 看膨胀
//   MAX_CONTEXT_TOKENS=6000   npx tsx bench.ts   # 压缩, 看被压住
//   TURNS=5 npx tsx bench.ts                     # 控制回合数
import { createClientFromEnv } from './llm.ts'
import { createDefaultTools } from './tools.ts'
import { runAgent } from './agent-loop.ts'
import { estimateTokens } from './context.ts'
import type { Message } from './types.ts'

const SYSTEM_PROMPT = `你是 wowo-agent，一个运行在用户电脑上的命令行助手。
你可以使用工具完成任务。工具结果会以 tool 消息返回给你。
复杂任务要一步步来：先了解情况，再行动，最后验证。
回答要简洁，用中文。`

const TASKS = [
  '用 python 计算 123*456',
  '用 python 计算 2 的 30 次方',
  '列出当前目录的文件',
  '读 DESIGN.md 并总结前三章的标题',
  '用 python 算斐波那契第 20 项',
  '用 python 生成 100 个随机数并求和',
  '把今天的日期写进 today.txt',
  '读 today.txt 并告诉我内容',
  '用 python 计算 100 以内所有质数的和',
  '用 python 计算 1 到 100 的平方和',
]

async function main() {
  const llm = createClientFromEnv()
  const tools = createDefaultTools()
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  const turns = Number(process.env.TURNS ?? TASKS.length)
  console.log(`=== 实验 B: 上下文膨胀演示 (${turns} 回合) ===`)
  for (let t = 0; t < turns; t++) {
    const task = TASKS[t % TASKS.length]
    messages.push({ role: 'user', content: `(任务 ${t + 1}) ${task}` })
    const answer = await runAgent(llm, tools, messages)
    console.log(`\n--- 回合 ${t + 1} 完成, 上下文 ~${estimateTokens(messages)} tokens ---`)
    console.log(`${answer.slice(0, 100)}${answer.length > 100 ? '…' : ''}\n`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

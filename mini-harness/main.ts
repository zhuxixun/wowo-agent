// 入口：REPL。每次对话 = 读输入 → 组装 system prompt → runAgent → 落盘
// CLI:
//   node main.ts                    新会话
//   node main.ts --new <名字>        新会话并命名
//   node main.ts --resume            恢复最近会话
//   node main.ts --resume <id|关键字> 恢复指定会话 (id 前缀/名字/标题模糊匹配)
//   node main.ts --list              列出所有会话
import { createInterface } from 'node:readline'
import { createClientFromEnv } from './llm.ts'
import { createDefaultTools } from './tools.ts'
import { runAgent } from './agent-loop.ts'
import { listSessions, resolveSession, appendSession } from './session.ts'
import { WORKSPACE } from './workspace.ts'
import type { Message } from './types.ts'

const SYSTEM_PROMPT = `你是 wowo-agent，一个运行在用户电脑上的命令行助手。
你可以使用工具完成任务。工具结果会以 tool 消息返回给你。
复杂任务要一步步来：先了解情况，再行动，最后验证。
回答要简洁，用中文。`

async function main() {
  const args = process.argv.slice(2)

  // --list 不需要 LLM，先处理掉
  if (args.includes('--list')) {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      console.log('还没有任何会话。跑 npm start 开始第一个。')
    } else {
      console.log('ID                消息  更新于              标题')
      for (const s of sessions) {
        console.log(
          `${s.id}  ${String(s.messageCount).padStart(4)}  ${fmtTime(s.updatedAt)}  ${s.title}`,
        )
      }
    }
    return
  }

  const llm = createClientFromEnv()
  const tools = createDefaultTools()

  let sessionId: string | null = null
  let messages: Message[] = []

  const newIdx = args.indexOf('--new')
  const resumeIdx = args.indexOf('--resume')

  if (newIdx >= 0) {
    const name = args[newIdx + 1]
    sessionId = String(Date.now()) + (name ? '-' + slugify(name) : '')
    console.log(`新会话: ${sessionId}`)
  } else if (resumeIdx >= 0) {
    const query = args[resumeIdx + 1]
    const found = await resolveSession(query)
    if (!found) {
      console.error(query ? `找不到会话 "${query}"` : '还没有任何会话')
      return
    }
    sessionId = found.id
    messages = found.messages
    console.log(`已恢复会话 ${found.id} (${found.messageCount} 条消息): ${found.title}`)
  } else {
    sessionId = String(Date.now())
    console.log(`新会话: ${sessionId}`)
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
  // 权限确认：只有用户输入 y/yes 才算同意；管道/EOF 场景默认拒绝
  const confirm = async (question: string): Promise<boolean> => {
    const answer = (await ask(question)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }

  console.log(`wowo-agent (最简陋版) — 输入 exit 退出`)
  console.log(`工作区: ${WORKSPACE} (WORKSPACE 环境变量可改)`)

  while (true) {
    const input = (await ask('\n你 > ')).trim()
    if (!input) continue
    if (input === 'exit' || input === 'quit') break

    const persisted = messages.length // 落盘偏移量：只写本次新增的
    messages.push({ role: 'user', content: input })

    try {
      const answer = await runAgent(llm, tools, messages, confirm)
      console.log(`\nagent > ${answer}`)
    } catch (err) {
      console.error(`\n出错: ${err instanceof Error ? err.message : err}`)
      messages.length = persisted // 回滚本次对话的全部消息，避免污染上下文
    }

    await appendSession(sessionId, messages, persisted)
  }

  rl.close()
}

function slugify(s: string): string {
  return s.replace(/[^\w\u4e00-\u9fa5-]/g, '-').replace(/-+/g, '-').slice(0, 24)
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

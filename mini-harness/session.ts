// 会话层 (v1.3, 实验 C 撞墙产物)
//
// 墙: 所有对话写进同一个 session.jsonl, 多天/多主题混在一起,
//      resume 时模型把不相干的任务当成同一段对话 (实验 C 实测: 问"第一个任务"答"第二个任务")
// 修: 一个会话一个文件。会话 = messages 数组 + 一个 id, 仅此而已
//
// 文件布局: sessions/<id>.jsonl   (id = 毫秒时间戳, --new <名字> 时带名字后缀)
// 标题不存储: 列出时从第一条 user 消息派生, 避免维护元数据
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Message } from './types.ts'

const SESSIONS_DIR = path.join(process.cwd(), 'sessions')

export interface SessionInfo {
  id: string
  title: string // 从第一条 user 消息派生
  path: string
  messageCount: number
  updatedAt: Date
}

async function readMessages(file: string): Promise<Message[]> {
  const text = await fs.readFile(file, 'utf-8')
  const messages: Message[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      // 跳过损坏的行
    }
  }
  return messages
}

// 按更新时间倒序返回所有会话
export async function listSessions(): Promise<SessionInfo[]> {
  let files: string[]
  try {
    files = (await fs.readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const sessions: SessionInfo[] = []
  for (const f of files) {
    const p = path.join(SESSIONS_DIR, f)
    try {
      const stat = await fs.stat(p)
      const messages = await readMessages(p)
      const firstUser = messages.find((m) => m.role === 'user')
      sessions.push({
        id: f.replace(/\.jsonl$/, ''),
        title:
          firstUser && firstUser.role === 'user'
            ? firstUser.content.replace(/\s+/g, ' ').slice(0, 28)
            : '(空会话)',
        path: p,
        messageCount: messages.length,
        updatedAt: stat.mtime,
      })
    } catch {
      // 跳过损坏的会话文件
    }
  }
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  return sessions
}

// 解析要恢复的会话: 无 query → 最新; 有 query → id 前缀 / 名字 / 标题 模糊匹配, 多个取最新
export async function resolveSession(
  query?: string,
): Promise<(SessionInfo & { messages: Message[] }) | null> {
  const sessions = await listSessions()
  if (sessions.length === 0) return null

  let hit: SessionInfo | null = null
  if (query) {
    const q = query.toLowerCase()
    hit = sessions.find(
      (s) => s.id.toLowerCase().includes(q) || s.title.toLowerCase().includes(q),
    ) ?? null
  } else {
    hit = sessions[0] // listSessions 已倒序 → 最新
  }
  if (!hit) return null

  return { ...hit, messages: await readMessages(hit.path) }
}

// 只追加本次新增的消息 (messages[fromIndex:])，避免重复写入
export async function appendSession(
  id: string,
  messages: Message[],
  fromIndex: number,
): Promise<void> {
  const lines = messages.slice(fromIndex).map((m) => JSON.stringify(m))
  if (lines.length === 0) return
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  await fs.appendFile(path.join(SESSIONS_DIR, `${id}.jsonl`), lines.join('\n') + '\n', 'utf-8')
}

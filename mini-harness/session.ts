// 会话持久化：JSONL，一行一条消息。恢复 = 读回数组
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Message } from './types.ts'

const SESSION_FILE = path.join(process.cwd(), 'session.jsonl')

export async function loadSession(): Promise<Message[]> {
  try {
    const text = await fs.readFile(SESSION_FILE, 'utf-8')
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
  } catch {
    return []
  }
}

// 只追加本次新增的消息（messages[fromIndex:]），避免重复写入
export async function appendSession(messages: Message[], fromIndex: number): Promise<void> {
  const lines = messages.slice(fromIndex).map((m) => JSON.stringify(m))
  if (lines.length === 0) return
  await fs.appendFile(SESSION_FILE, lines.join('\n') + '\n', 'utf-8')
}

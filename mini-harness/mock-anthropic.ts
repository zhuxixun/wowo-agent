// 本地 mock 的 Anthropic Messages API (实验 E 验证工具, 不需要真 key)
// 复刻 Anthropic 的校验规则和响应形状; 返回一个固定的"工具调用回合"以测全链路
//
// 用法: npx tsx mock-anthropic.ts   (默认 127.0.0.1:8787, MOCK_PORT 可改)
// 然后: LLM_PROVIDER=anthropic ANTHROPIC_BASE_URL=http://127.0.0.1:8787 npx tsx main.ts
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8787)

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let payload: any
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }))
      return
    }

    const error = validate(payload)
    if (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error } }))
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(respond(payload)))
  })
})

// 复刻 Anthropic 的请求校验: 撞墙 demo 靠它给出真实的 400 错误
function validate(payload: any): string | null {
  if (payload.max_tokens == null) return 'max_tokens: Field required (Anthropic 无默认值)'

  for (const m of payload.messages ?? []) {
    if (m.role !== 'user' && m.role !== 'assistant') {
      return `messages.role: Input should be 'user' or 'assistant' (got ${JSON.stringify(m.role)})`
    }
  }

  for (const t of payload.tools ?? []) {
    if (!t.name || typeof t.name !== 'string') return 'tools.name: Field required'
    if (!t.input_schema) return 'tools.input_schema: Field required'
    if (t.function || t.type) {
      return 'tools: extra fields not permitted (OpenAI 形状的 type/function 包装不被接受)'
    }
  }

  // tool_use block 之后必须是紧邻的 user 消息 + 匹配的 tool_result block
  for (let i = 0; i < (payload.messages ?? []).length; i++) {
    const m = payload.messages[i]
    const toolUse = (m.content ?? []).filter((b: any) => b.type === 'tool_use')
    if (toolUse.length === 0) continue
    const next = payload.messages[i + 1]
    const results = (next?.content ?? []).filter((b: any) => b.type === 'tool_result')
    const ids = new Set(toolUse.map((b: any) => b.id))
    if (!next || next.role !== 'user' || results.length !== ids.size || !results.every((r: any) => ids.has(r.tool_use_id))) {
      return 'tool_use blocks must be immediately followed by a user message with matching tool_result blocks'
    }
  }
  return null
}

// 固定剧本: 第一轮返回 tool_use (调 bash), 收到 tool_result 后返回收尾文本
function respond(payload: any) {
  const last = payload.messages[payload.messages.length - 1]
  const hasToolResult = (last?.content ?? []).some((b: any) => b.type === 'tool_result')
  if (hasToolResult) {
    return {
      id: 'mock-2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'mock Claude: 工具执行结果已收到，一切正常 ✅' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    }
  }
  return {
    id: 'mock-1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: '我来调用工具。' },
      { type: 'tool_use', id: 'toolu_mock_1', name: 'bash', input: { command: 'echo mock-claude-ok' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 50, output_tokens: 10 },
  }
}

server.listen(PORT, () => console.log(`mock anthropic listening on http://127.0.0.1:${PORT}`))

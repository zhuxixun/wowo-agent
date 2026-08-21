// 工具层：注册表 + 3 个内置工具。执行器只执行、不判断（权限在 permission.ts，沙箱在 workspace.ts）
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { WORKSPACE, resolveInWorkspace } from './workspace.ts'
import type { Tool, ToolSchema } from './types.ts'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool) {
    this.tools.set(tool.name, tool)
  }

  listSchemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  // 无论成功失败都返回字符串；错误不抛出，而是作为文本回传给模型自己处理
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return `错误: 未知工具 ${name}`
    try {
      return await tool.run(args)
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export function createDefaultTools(): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register({
    name: 'read_file',
    description: '读取文件内容。路径相对于工作目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
    async run({ path: p }) {
      const full = resolveInWorkspace(String(p))
      if (!full) return `沙箱拒绝: 路径在工作区之外: ${p}`
      const content = await fs.readFile(full, 'utf-8')
      const lines = content.split('\n')
      if (lines.length > 5000) {
        return `(文件共 ${lines.length} 行，只显示前 5000 行)\n${lines.slice(0, 5000).join('\n')}`
      }
      return content
    },
  })

  registry.register({
    name: 'write_file',
    description: '写入文件（覆盖已存在的内容），自动创建父目录。路径相对于工作目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
    async run({ path: p, content }) {
      const full = resolveInWorkspace(String(p))
      if (!full) return `沙箱拒绝: 路径在工作区之外: ${p}`
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, String(content), 'utf-8')
      return `已写入 ${full} (${String(content).length} 字符)`
    },
  })

  registry.register({
    name: 'bash',
    description: '在 shell 中执行命令（工作目录为项目根目录）。返回 stdout+stderr 合并输出。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
      required: ['command'],
    },
    run({ command }) {
      return new Promise((resolve) => {
        exec(String(command), { cwd: WORKSPACE, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
          if (err) resolve(`退出码 ${err.code ?? '?'}: ${out || err.message}`)
          else resolve(out || '(无输出)')
        })
      })
    },
  })

  return registry
}

// 权限层：在工具执行前拦截，三种裁决 allow / ask / deny
// 设计原则：政策与执行分离 — 工具不自己判断，循环不写死规则，策略全部集中在这里
import path from 'node:path'
import { WORKSPACE, isInsideWorkspace } from './workspace.ts'

export type Decision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; question: string }

// 危险命令前缀表（朴素字符串匹配，不做 bash 语法解析 — 已知局限，见 DESIGN.md §8）
const DANGEROUS_PREFIXES = [
  'rm ', 'mv ', 'sudo ', 'chmod ', 'chown ', 'chgrp ',
  'git push ', 'mkfs', 'dd ', 'shutdown', 'reboot', 'halt',
  'kill ', 'pkill ', 'killall ',
]

function dangerousHit(cmd: string): string | null {
  for (const p of DANGEROUS_PREFIXES) {
    if (cmd.startsWith(p)) return p
    // 也要抓住藏在 "&& rm" / "; rm" / "| rm" 里的危险命令
    for (const sep of ['&& ', '; ', '| ', '|| ']) {
      if (cmd.includes(`${sep}${p}`)) return p
    }
  }
  return null
}

// 朴素匹配 bash 命令里的绝对路径, 返回第一个在工作区之外的 (沙箱围栏的补充)
function outsidePathIn(cmd: string): string | null {
  const matches = cmd.match(/\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*/g) ?? []
  for (const m of matches) {
    if (!isInsideWorkspace(path.resolve(m))) return m
  }
  return null
}

// 相对路径穿越: `cat ../x` / `cd ..` 之类 (朴素匹配, 会被 python os.open 等绕过 — 见 DESIGN.md)
function dotdotIn(cmd: string): boolean {
  return /(?:^|\s)\.\.(?:\/|\s|$)/.test(cmd)
}

export function decide(toolName: string, args: Record<string, unknown>): Decision {
  // v1 只对 bash 做策略：读文件、写文件直接放行
  if (toolName !== 'bash') return { action: 'allow' }

  const cmd = String(args.command ?? '').trim()
  if (!cmd) return { action: 'deny', reason: '空命令' }

  const hit = dangerousHit(cmd)
  if (hit) {
    return {
      action: 'ask',
      question:
        `[权限] bash 命令包含危险操作 (${hit.trim()}): ` +
        `${cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd}\n确认执行? (y/N) `,
    }
  }

  // 沙箱补充: 引用工作区之外绝对路径的命令也要确认 (如 cat /tmp/x, rm /etc/y)
  const outside = outsidePathIn(cmd)
  if (outside) {
    return {
      action: 'ask',
      question:
        `[权限] bash 命令引用工作区之外的路径 (${outside}): ` +
        `${cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd}\n确认执行? (y/N) `,
    }
  }

  // 沙箱补充: 相对路径穿越 (如 cat ../x, cd ..) 也要确认
  if (dotdotIn(cmd)) {
    return {
      action: 'ask',
      question:
        `[权限] bash 命令包含工作区外的相对路径 (..): ` +
        `${cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd}\n确认执行? (y/N) `,
    }
  }
  return { action: 'allow' }
}

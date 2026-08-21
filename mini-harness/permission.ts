// 权限层：在工具执行前拦截，三种裁决 allow / ask / deny
// 设计原则：政策与执行分离 — 工具不自己判断，循环不写死规则，策略全部集中在这里
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
  return { action: 'allow' }
}

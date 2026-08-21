// 工作区 (v1.4, 实验 D 撞墙产物)
//
// 墙: 没有"工作区"概念, agent 能读/写机器上任何文件 (/tmp, /etc, ~/.ssh, ../)
// 修: 定义统一执行环境 — 所有文件操作必须落在工作区内, bash 也以工作区为 cwd
//
// 诚实声明: 这是"文件工具级"沙箱。bash 里写 `cd /` 或 python 里 os.open()
// 仍然可以逃逸 — 那需要 OS 级进程隔离 (docker/bwrap/seccomp), 超出本实验范围
import path from 'node:path'

// 工作区根目录: 默认启动目录, WORKSPACE 环境变量可覆盖
export const WORKSPACE = process.env.WORKSPACE ? path.resolve(process.env.WORKSPACE) : process.cwd()

// 解析路径并检查是否在工作区内; 逃逸返回 null (调用方直接拒绝)
export function resolveInWorkspace(p: string): string | null {
  const full = path.resolve(WORKSPACE, p)
  return isInsideWorkspace(full) ? full : null
}

export function isInsideWorkspace(full: string): boolean {
  const rel = path.relative(WORKSPACE, full)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

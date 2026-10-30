/**
 * 「用系统文件管理器打开一个目录」—— 合集内的唯一实现。
 *
 * 为什么放在这里共享：open-folder 行（插件详情页的「打开目录」）与 preset-bridge 行
 * （预设卡片的「打开目录」）要的是同一件事 —— 各写一份必然漂移，改动也总有一边漏掉。
 * 两边的宿主半都从这里 import，不再自带副本。
 */
import { spawn } from 'node:child_process'

/**
 * 打开目录。**不等待结果、也不与 dsh 进程耦合**：explorer.exe 会一直活着，
 * 若不当成 detached 子进程，dsh 退出时可能把它一起带走。
 *
 * Windows 用 `explorer.exe <目录>`；macOS 用 `open`；其余平台用 `xdg-open`。
 * @param {string} dir 目标目录（空值直接返回 false）
 * @returns {boolean} 是否把子进程拉起来了（**不代表**窗口真的弹出来了：文件管理器自己也可能失败）
 */
export function openFolder(dir) {
  const target = String(dir ?? '').trim()
  if (target === '') return false
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(command, [target], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

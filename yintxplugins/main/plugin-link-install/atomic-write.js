/**
 * 原子写 + 跨进程写者协调 —— 官方 `@deepseek-ai/dsh-atomic-write` 的等价实现（零依赖）。
 *
 * 为什么必须有这一份：profile 的 `package.json` 是**多写者**文件 —— 官方的
 * `pluginManager` 会写它（`change()` 全程持 `<package.json>.lock`，并用 `writeFileAtomic`
 * 提交），`pnpm` 自己也会重写它，我们的 `recordProfileInstall` / `normalizeDependencySpec`
 * 也在写。**用 `writeFileSync` 直写一个多写者文件会写出坏 JSON**：它是「截断 → 写入」，
 * 另一个写者或读者正好落在中间就会看到半截内容。
 *
 * 实测代价（2026-10-10，用户的 profile）：宿主连续三次启动失败
 * `DesktopHostFatalError: Expected double-quoted property name in JSON at position 1080`
 * —— 崩在官方 `readProfileManifest` 的 `JSON.parse` 上。就是直写与 PD 并发的结果。
 *
 * 所以本模块只做两件事，语义与官方那份对齐：
 *   1. `writeFileAtomicSync`：写同目录随机名临时文件（`wx` 独占创建）再 `rename` 覆盖 ——
 *      读者只会看到「完整的旧内容」或「完整的新内容」，永远看不到半截；
 *   2. `withFileLockSync`：用 `<file>.lock`（`wx` 创建 + 记录 `<pid>`）串行化写者，
 *      与官方持的是**同一把锁**（同一路径），拿不到就等，超时则不加锁继续 ——
 *      因为写入本身已经原子，最坏只是「后写覆盖先写」，不会坏文件。
 */
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

/** Windows 上 rename 可能被占用的瞬时错误码（照官方那份的集合）。 */
const TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])

/** 同步睡眠：`Atomics.wait` 是唯一不阻塞事件循环之外的同步等待原语。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 拿不到 SharedArrayBuffer 时退化成忙等一小会儿 */
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* 极短等待，避免引入异步 */
    }
  }
}

/**
 * `rename` 覆盖目标；Windows 上被占用时按 20→200ms 退避重试（最多 8 次），
 * 与官方 `renameAtomicTemp` 的节奏一致。
 */
function renameAtomicSync(temp, filename) {
  let delay = 20
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, filename)
      return
    } catch (error) {
      if (process.platform !== 'win32' || !TRANSIENT_RENAME_ERRORS.has(error?.code ?? '')) throw error
      if (attempt >= 8) throw error
    }
    sleepSync(delay)
    delay = Math.min(delay * 2, 200)
  }
}

/**
 * 原子替换：内容先落到同目录的随机名临时文件（`wx` 独占创建），再 rename 覆盖目标。
 * 失败时清掉临时文件并把错误抛出去。
 */
export function writeFileAtomicSync(filename, content) {
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const fd = openSync(temp, 'wx')
    try {
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
    renameAtomicSync(temp, filename)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* 临时文件可能根本没建起来 */
    }
    throw error
  }
}

/** 锁文件路径：与官方 `withFileLock` 用同一个（同一目录下的 `<file>.lock`）。 */
export function lockPathFor(filename) {
  return `${filename}.lock`
}

/**
 * 锁的持有者是否已经不存在：记录形如 `<pid>\n` 且该 pid 探不到（ESRCH）。
 * 记录形状不符、pid 是自己、或者进程还活着 → 一律当作「有人在用」，不抢。
 */
function holderExited(lockPath) {
  let record
  try {
    record = readFileSync(lockPath, 'utf8')
  } catch {
    return false
  }
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  if (pid === 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * 持 `<filename>.lock` 跑一段同步临界区。
 *
 * 拿不到锁时的行为是**有意的**：等到 `waitMs` 为止（默认 8 秒，够官方的 `pnpm add` 收尾），
 * 超时也不抛错 —— 直接进临界区。理由是写入本身是原子的，代价上限只是「后写覆盖先写」，
 * 而抛错会让用户的安装凭空失败。锁文件由我们独占创建并删掉；只有确认持有者进程已消失时才接管。
 *
 * @param filename 被保护的文件（通常是 profile 的 package.json）
 * @param fn 临界区（同步函数）
 */
export function withFileLockSync(filename, fn, { waitMs = 8000, pollMs = 40 } = {}) {
  const lockPath = lockPathFor(filename)
  const deadline = Date.now() + waitMs
  let fd = null
  let locked = false

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx')
      writeSync(fd, `${process.pid}\n`)
      locked = true
      break
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') break
      // 持有者进程已经没了 → 接管（否则一次崩溃会把 profile 永久锁住）
      if (holderExited(lockPath)) {
        try {
          unlinkSync(lockPath)
        } catch {
          /* 别人先接管了也没有关系，下一轮继续争 */
        }
        continue
      }
      if (Date.now() >= deadline) break
      sleepSync(pollMs)
    }
  }

  try {
    return fn()
  } finally {
    if (locked && fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 已经关了就算了 */
      }
      try {
        unlinkSync(lockPath)
      } catch {
        /* 被别人接管后删掉也无所谓 */
      }
    }
  }
}

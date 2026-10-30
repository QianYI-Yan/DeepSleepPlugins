/**
 * dsh-plugin-link-install —— 宿主半。
 *
 * 给官方「添加插件」对话框补两件事（除此之外不做任何事）：
 *   1. **浏览本地目录 / 选 package.json**：拉起 Windows 原生选择器，默认从**上次选过的目录**开始
 *      （带记忆）。目录模式只显示文件夹；文件模式显示 package.json，选中它即视为选中它所在的插件目录。
 *   2. **本地安装**：把选中的插件目录整份复制到 `DSH_HOME/plugins/<profile>/<name>`，再把这次安装
 *      写进 profile 的记账 —— `dependencies` 写成 `file:../../plugins/<profile>/<name>`、
 *      `dsh.profile.bundles` 加一行、建好 `node_modules` 链接。
 *
 * **本地安装：走官方的安装方法，但把喂给它的规格改成需求要的形态。**
 *
 * 官方 `installBundle(spec)` 会把 spec **原样**交给 `pnpm add`：
 *
 *     run = await this.runPnpm(["add", spec, ...registryArguments(registry)])
 *
 * 而官方 UI 传进去的是**绝对路径**，pnpm 会把它写成 `link:C:/...` —— 不是需求要的形态。
 * 我们的办法不是「自己写记账、绕开官方」，而是**喂给它一个改写过的 spec**：
 * `file:../../plugins/<profile>/<name>`（相对 profile 目录）。这样 pnpm 原样写进
 * `dependencies`，而 lockfile、`node_modules`、`dsh.profile.bundles`（`selectBundle`）
 * 全部由官方按它自己的流程更新 —— 正是需求要的「走官方安装方法，写入 file: 形态」。
 *
 * 两点依据（都读的官方源码）：① 官方 `installBundle` 的规格解析是**宽松**的
 * （`parsedForRegistry` 解析失败即降级成 registry 名，不会拒绝），严格拒绝相对路径的是
 * `inspect()`，而我们不调它；② pnpm 的相对 `file:` 依赖以 package.json 所在目录为基准解析，
 * 即 `profiles/<profile>/../../plugins/<profile>/<name>` = `DSH_HOME/plugins/<profile>/<name>`，
 * 正好是我们刚复制过去的那份。
 *
 * 官方失败时它会自己 `restoreFiles`（把 package.json / pnpm-lock.yaml 恢复原状），不会留半成品；
 * 只有**拿不到官方服务**这种极端情况才降级成自管写入，并在结果里如实标注「degraded」。
 *
 * **`setBundleEnabled` 仍不直接调**：它会触发官方 reconcile，把「安装前在依赖里、安装后不在
 * 依赖里」的 bundle 静默删掉（实测抹掉过用户原有的 yintxplugins）。走 `installBundle` 则不同 ——
 * 它是我们主动装新包，before/after 都在官方自己手上，`selectBundle` 只往 bundles 追加。
 *
 * 路由（挂在 dsh 的 webServer 上，与官方插件共用同一道连接信任闸）：
 *   POST /plugin-local/pick     { initial?, kind? }  → 打开选择器 → { dir, pickedFile, via, elapsedMs }
 *   POST /plugin-local/install  { source, profile? } → 复制到插件仓库 + 写 profile 记账
 *
 * 选择器按「谁吃得下起始目录」排序：
 *   ① **自带的 Windows 原生选择器**（`native-pick.cjs`，koffi 直驱 `IFileDialog`）——
 *      吃得下起始目录（`SetFolder`）与文件模式，是 Windows 上唯一能同时做到
 *      「停在上次那个目录」和「真选 package.json」的一条路；
 *   ② 官方 `directoryPicker` —— 结构上没有 `IFileDialog::SetFolder`，永远只开在它自己的「最近用过」，
 *      而且只有一个目录选择器，只能当兜底。
 *
 * ⚠️ 不要再用 Electron 的 `dialog.showOpenDialog`：桌面端宿主是 `ELECTRON_RUN_AS_NODE=1`
 * 起的 Node 模式子进程，`require('electron')` 在那里是 MODULE_NOT_FOUND（已实测），
 * 那条路从来没生效过 —— 用户反馈的「选择器没记忆 / 选不了 package.json」的根因就在这。
 */
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withFileLockSync, writeFileAtomicSync } from './atomic-write.js'

export const name = 'dsh-plugin-link-install'

/**
 * inject 必须把用到的服务全列上：cordis 的 ctx 代理对没 inject 的属性直接抛
 * 「cannot get property "x" without inject」—— 这正是「浏览本地目录」点了没反应的原因
 * （路由 handler 里访问了未注入的 ctx.connection，整条请求 500）。
 * `pluginManager` 与 `directoryPicker` **不**列在这里：它们按需用 `ctx.get()` 取，取不到就降级。
 */
export const inject = ['webServer', 'connection']

const ROUTE_PICK = '/plugin-local/pick'
/** 只读：读一个本地目录的 package.json，回报给输入框下面那张预览卡片。 */
const ROUTE_INSPECT = '/plugin-local/inspect'
/** 官方那次安装把依赖写进 profile 之后的收尾：复制副本 + 改写依赖形态。 */
const ROUTE_FINISH = '/plugin-local/finish'

/** 默认 profile：桌面端读 desktop，Web 端读 web。 */
const DEFAULT_PROFILE = 'desktop'

/** npm 包名（含 scope）。 */
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/** 官方 directoryPicker 的最长等待（毫秒）。 */
const OFFICIAL_PICK_TIMEOUT_MS = 10 * 60 * 1000

/** 等官方把依赖写进 profile 的最长时间与轮询间隔（官方那次安装要跑 pnpm，慢的时候十几秒）。 */
const OFFICIAL_WRITE_TIMEOUT_MS = 2 * 60 * 1000
const OFFICIAL_WRITE_POLL_MS = 400

/** 复制时一律跳过的目录/文件：版本控制与编辑器元数据，复制进插件仓库没有意义。 */
const COPY_SKIP = new Set(['.git', '.github', '.vscode', '.idea', '.DS_Store', 'Thumbs.db'])

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

// ── 路径解析 ──────────────────────────────────────────────────────────────

/** DSH_HOME（默认 ~/.dsh）。 */
export function dshHome() {
  return (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
}

/** 插件仓库根：DSH_HOME/plugins。 */
export function pluginsRoot(home = dshHome()) {
  return join(home, 'plugins')
}

/** 插件名白名单：只允许普通包名与 `@scope/name`，杜绝 `../` 之类的路径穿越。 */
function isSafeName(value) {
  return NAME_PATTERN.test(String(value ?? '').trim())
}

/** profile 名白名单：单层目录名，不允许分隔符（`../../某工程` 曾能改写别人的 package.json）。 */
function isSafeProfile(value) {
  const text = String(value ?? '').trim()
  return text !== '' && /^[A-Za-z0-9._-]+$/.test(text) && text !== '.' && text !== '..'
}

/** profile 目录与清单位置。非法 profile 名（含分隔符）标记 `safe:false`，`exists` 一律 false。 */
export function resolveProfile(profile = DEFAULT_PROFILE, home = dshHome()) {
  const name = String(profile ?? '').trim() || DEFAULT_PROFILE
  const safe = isSafeProfile(name)
  const dir = join(home, 'profiles', name)
  const packageJsonPath = join(dir, 'package.json')
  return { profile: name, dir, packageJsonPath, exists: safe && existsSync(packageJsonPath), safe }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** child 是否落在 parent 里（同路径也算）。 */
function isInside(child, parent) {
  const from = resolve(parent)
  const to = resolve(child)
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)
}

/**
 * 猜当前跑的是哪个 profile：
 * `DSH_PROFILE` 环境变量 → cwd 落在哪个 profile 目录里 → 只有一个 profile →
 * 常见名优先级 web → default（桌面端 exe）→ desktop → 第一个。
 */
export function detectProfile(home = dshHome()) {
  const fromEnv = (process.env.DSH_PROFILE ?? '').trim()
  if (fromEnv) return fromEnv
  const root = join(home, 'profiles')
  const names = readdirSafe(root).filter((entry) => existsSync(join(root, entry, 'package.json')))
  const cwd = resolve(process.cwd())
  for (const entry of names) {
    if (isInside(cwd, join(root, entry))) return entry
  }
  if (names.length === 1) return names[0]
  for (const preferred of ['web', 'default', 'desktop']) {
    if (names.includes(preferred)) return preferred
  }
  return names.length ? names[0] : DEFAULT_PROFILE
}

/**
 * 安装目标目录：`<plugins>/<profile>/<name>`。
 * 带 scope 的包名会展开成嵌套目录（`@scope/name`）。
 */
export function linkPathFor(name, profile = DEFAULT_PROFILE, home = dshHome()) {
  return join(pluginsRoot(home), profile, ...String(name).split('/'))
}

/** 官方注册时会写进 profile 依赖里的形态（用户要的就是这个）。 */
export function dependencySpec(name, profile = DEFAULT_PROFILE) {
  return `file:../../plugins/${profile}/${name}`
}

// ── 源目录校验 ────────────────────────────────────────────────────────────

/**
 * 把用户给的路径归一到「插件目录」。允许三种输入（实际用法就是这么散）：
 *   1. 插件目录本身（含 package.json）      → 原样用；
 *   2. 目录里没有 package.json，但恰好一个直接子目录有 → 自动下探用它
 *      （GitHub 下载的 `xxx-main/` 解压出来就是这个形状）；多个候选则报错让人选；
 *   3. 直接选了 `package.json` 文件          → 用它所在目录。
 *
 * @returns {{ input, dir, manifestPath, sourceKind: 'dir'|'file'|'nested', adjusted, nestedFrom }}
 */
export function normalizeSource(source) {
  const raw = String(source ?? '').trim()
  if (raw === '') throw new Error('路径为空')
  const resolved = resolve(raw)
  if (!existsSync(resolved)) throw new Error(`目录不存在：${resolved}`)
  let stat
  try {
    stat = statSync(resolved)
  } catch (error) {
    throw new Error(`读不到路径：${resolved}（${messageOf(error)}）`)
  }

  if (stat.isFile()) {
    if (basename(resolved).toLowerCase() !== 'package.json') {
      throw new Error(`只能选 package.json 或插件目录，当前选的是文件：${resolved}`)
    }
    return {
      input: raw,
      dir: dirname(resolved),
      manifestPath: resolved,
      sourceKind: 'file',
      adjusted: 'file',
      nestedFrom: null,
    }
  }
  if (!stat.isDirectory()) throw new Error(`既不是目录也不是文件：${resolved}`)

  const manifestPath = join(resolved, 'package.json')
  if (existsSync(manifestPath)) {
    return { input: raw, dir: resolved, manifestPath, sourceKind: 'dir', adjusted: null, nestedFrom: null }
  }

  // 目录里没有 package.json：看看是不是「包了一层」的压缩包目录
  let children = []
  try {
    children = readdirSync(resolved, { withFileTypes: true })
  } catch (error) {
    throw new Error(`读不到目录：${resolved}（${messageOf(error)}）`)
  }
  const candidates = children
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .filter((entry) => existsSync(join(resolved, entry, 'package.json')))

  if (candidates.length === 1) {
    const dir = join(resolved, candidates[0])
    return {
      input: raw,
      dir,
      manifestPath: join(dir, 'package.json'),
      sourceKind: 'nested',
      adjusted: 'nested',
      nestedFrom: resolved,
    }
  }
  if (candidates.length > 1) {
    throw new Error(
      `该目录下有 ${candidates.length} 个带 package.json 的子目录（${candidates.join('、')}），请直接选其中一个`,
    )
  }
  throw new Error(`不是插件包（缺 package.json）：${resolved}`)
}

/** 读源目录的 package.json；失败抛错。`manifest` 是原始对象，供识别接口复用，避免二次读盘。 */
export function readSource(source) {
  const normalized = normalizeSource(source)
  const { dir, manifestPath } = normalized
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`package.json 解析失败：${messageOf(error)}`)
  }
  const pkgName = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  if (!pkgName) throw new Error('package.json 里没有 name')
  if (!NAME_PATTERN.test(pkgName)) throw new Error(`包名不合法：${pkgName}`)

  const warnings = []
  if (!manifest.dsh) warnings.push('该包没有 dsh 元数据（dsh.bundle / dsh.client），可能不是 DSH 插件')
  else if (!manifest.dsh.bundle && !manifest.dsh.client) warnings.push('dsh 元数据里既没有 bundle 也没有 client 声明')
  if (manifest.private === true) warnings.push('该包声明了 private，仅适合本地安装')

  return {
    dir,
    name: pkgName,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    private: manifest.private === true,
    isDshPlugin: Boolean(manifest.dsh),
    hasBundlePatch: Boolean(manifest.dsh?.bundle?.patch),
    hasClient: Boolean(manifest.dsh?.client),
    runtimeDeps: Object.keys(manifest.dependencies ?? {}),
    manifestPath,
    input: normalized.input,
    sourceKind: normalized.sourceKind,
    adjusted: normalized.adjusted,
    nestedFrom: normalized.nestedFrom,
    warnings,
    manifest,
  }
}

// ── 选择器记忆 ────────────────────────────────────────────────────────────

/** 记忆文件：只存「上次选过什么」与「上次装的是哪个源目录」。 */
export function statePath(home = dshHome()) {
  return join(home, '.link-install-state.json')
}

export function readState(home = dshHome()) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(home), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeState(patch, home = dshHome()) {
  try {
    const next = { ...readState(home), ...patch, updatedAt: new Date().toISOString() }
    // 原子写：选择器路由与安装路由可能同时在写这份记忆
    writeFileAtomicSync(statePath(home), `${JSON.stringify(next, null, 2)}\n`)
    return next
  } catch {
    return null
  }
}

/**
 * 选择器的起始目录：**本次传入 > 上次选过 > 上次安装的源目录 > 用户主目录**。
 * 这就是「记忆路径」的全部实现 —— 每次选完都写回 `lastPicked`，下次从它开始。
 */
export function pickSeed({ initial, home = dshHome() } = {}) {
  const given = typeof initial === 'string' ? initial.trim() : ''
  if (given && existsSync(given)) return given
  const state = readState(home)
  for (const candidate of [state.lastPicked, state.lastSource]) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  return homedir()
}

/** 选中的若是**文件**，归一到它所在目录（记忆与回填一律用目录）。 */
export function normalizePicked(picked, home = dshHome()) {
  let dir = picked ?? null
  let pickedFile = null
  if (dir) {
    try {
      if (existsSync(dir) && statSync(dir).isFile()) {
        pickedFile = dir
        dir = dirname(dir)
        writeState({ lastPicked: dir }, home)
      }
    } catch {}
  }
  return { dir, pickedFile }
}

// ── 复制 ──────────────────────────────────────────────────────────────────

/**
 * 递归复制目录：跳过 `COPY_SKIP`；只复制普通文件与目录，**遇到符号链接/junction 不跟进去**。
 *
 * 为什么必须自己判重解析点：`readdirSync(withFileTypes)` 在 Windows 上把 junction 报成**目录**
 * （Node 的 `lstat` 同样不把 junction 当 symlink），于是源目录里一个指回父目录的 junction
 * 会被无限递归展开 —— 复制出巨量内容甚至撑爆磁盘。
 * @returns {{ files, bytes, skipped }}
 */
export function copyDirectory(source, target, { skip = COPY_SKIP } = {}) {
  let files = 0
  let bytes = 0
  let skipped = 0
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (skip.has(entry.name)) {
        skipped += 1
        continue
      }
      const fromPath = join(from, entry.name)
      const toPath = join(to, entry.name)
      let isReparse = false
      try {
        isReparse = lstatSync(fromPath).isSymbolicLink()
      } catch {}
      if (isReparse) {
        skipped += 1
        continue
      }
      if (entry.isDirectory()) {
        walk(fromPath, toPath)
      } else if (entry.isFile()) {
        copyFileSync(fromPath, toPath)
        files += 1
        bytes += statSync(fromPath).size
      } else {
        skipped += 1
      }
    }
  }
  walk(resolve(source), resolve(target))
  return { files, bytes, skipped }
}

/**
 * 复制：把插件目录整份复制到 `DSH_HOME/plugins/<profile>/<name>`，把这份拷贝的位置回报给调用方。
 *
 * **不改 profile 的任何文件**：这一步只管物理落地。官方那次安装（用户点官方「安装」触发的）
 * 早已由官方自己把 `link:<源目录>` 写进 profile；复制到位之后由 `normalizeDependencySpec()`
 * 把那一行改写成指向这份拷贝的 `file:../../plugins/<profile>/<name>`。
 */
export function stageCopy({ source, profile, home = dshHome() } = {}) {
  const resolved = resolveProfile(profile, home)
  if (!isSafeProfile(resolved.profile)) {
    return { ok: false, message: `profile 名不合法：${resolved.profile}` }
  }
  if (!resolved.exists) {
    return { ok: false, message: `找不到 profile：${resolved.packageJsonPath}` }
  }
  let info
  try {
    info = readSource(source)
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
  if (!isSafeName(info.name)) {
    return { ok: false, message: `插件名不合法：${info.name}` }
  }
  const target = linkPathFor(info.name, resolved.profile, home)
  if (resolve(info.dir) === resolve(target)) {
    return { ok: false, message: `源目录就是安装目标，拒绝操作：${target}` }
  }
  if (!isInside(target, pluginsRoot(home))) {
    return { ok: false, message: `目标不在插件仓库里，拒绝操作：${target}` }
  }
  const warnings = [...info.warnings]
  let replaced = false
  try {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
      replaced = true
      warnings.push(`插件仓库里原有的同名目录已被替换：${target}`)
    }
    const copied = copyDirectory(info.dir, target)
    // 记住这次装的是哪个源目录：下次打开选择器直接从它开始
    writeState({ lastSource: info.dir, lastPicked: info.dir }, home)
    return {
      ok: true,
      name: info.name,
      version: info.version,
      source: info.dir,
      target,
      dependency: dependencySpec(info.name, resolved.profile),
      profile: resolved.profile,
      copiedFiles: copied.files,
      copiedBytes: copied.bytes,
      skipped: copied.skipped,
      replaced,
      warnings,
      restartRequired: true,
    }
  } catch (error) {
    return { ok: false, message: `复制失败：${messageOf(error)}` }
  }
}

/**
 * 把 profile 里那一行**改写成本插件要的目标形态**：`file:../../plugins/<profile>/<name>`。
 *
 * 两种来源都要认得，这是「官方装完、我们改写入内容」的全部要害：
 *
 * 1. **官方刚写的 `link:<源目录>`** —— 官方 UI 装本地路径时就写这个（实测
 *    `link:C:/Users/…/plugins/desktop/<name>`），传 `from: <源目录>` 就认它；
 * 2. pnpm 在 Windows 上写的反斜杠形态，或 workspace 模式下被规范化成的绝对路径 ——
 *    这些指向的已经是插件仓库里的拷贝，不带 `from` 也认。
 *
 * 除这两种之外的值（指向别的目录、registry 版本号）**一律不动**，免得改坏别人的依赖。
 * 改前留时间戳备份；整段「读 → 改 → 写」在官方同一把 `<package.json>.lock` 里跑，
 * 提交走原子写（直写会让宿主读到半截 JSON 起不来）。
 */
export function normalizeDependencySpec({ name, profile, home = dshHome(), from = null } = {}) {
  const resolved = resolveProfile(profile, home)
  if (!isSafeProfile(resolved.profile)) return { ok: false, message: `profile 名不合法：${resolved.profile}` }
  if (!resolved.exists) return { ok: false, message: `找不到 profile：${resolved.packageJsonPath}` }
  if (!isSafeName(name)) return { ok: false, message: `插件名不合法：${name}` }

  // 整段「读 → 改 → 写」都在官方那把锁里跑，判断与改写都基于**锁内**读到的那一份内容
  return withFileLockSync(resolved.packageJsonPath, () => {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(resolved.packageJsonPath, 'utf8'))
    } catch (error) {
      return { ok: false, message: `profile 的 package.json 解析失败：${messageOf(error)}` }
    }

    const current = manifest.dependencies?.[name]
    if (typeof current !== 'string' || current === '') {
      return { ok: false, message: `profile 里没有 ${name} 的依赖行，无法改写` }
    }
    const wanted = dependencySpec(name, resolved.profile)
    if (current === wanted) return { ok: true, changed: false, dependency: wanted }

    const pointsAtCopy = dependencyTargetsCopy(current, { name, profile: resolved.profile, home })
    const pointsAtSource =
      from !== null && dependencyTargetsDir(current, from, { profile: resolved.profile, home })
    if (!pointsAtCopy && !pointsAtSource) {
      return {
        ok: true,
        changed: false,
        dependency: current,
        skipped: `现有依赖 ${current} 既不是插件仓库里的这份拷贝、也不是这次安装的源目录，未改动`,
      }
    }

    const next = { ...manifest, dependencies: { ...manifest.dependencies, [name]: wanted } }
    try {
      copyFileSync(
        resolved.packageJsonPath,
        `${resolved.packageJsonPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      )
      writeFileAtomicSync(resolved.packageJsonPath, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      return { ok: false, message: `改写依赖行失败：${messageOf(error)}` }
    }
    return { ok: true, changed: true, from: current, dependency: wanted }
  })
}

// ── 盯住官方那次安装，等它写完再改写 ──────────────────────────────────────

/** 异步小睡（轮询用）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等**官方**把这次安装写进 profile —— 官方流程完全照跑，我们只在旁边等。
 *
 * 这是整条链路的分工：官方 UI 的「安装」按钮照点、官方自己的 pnpm 照跑、官方把
 * `link:<源目录>` 写进 profile、官方选中 bundle 并提示重启 —— **我们一个都不插手**
 * （拦下来自己调 installBundle 会让官方界面一动不动，那正是被否掉的那一版）。
 * 我们要做的是等那一行真的出现并且稳定，然后才去复制副本、改写形态。
 *
 * 判据：`dependencies[name]` 出现，且解析后的绝对路径**要么是这次安装的源目录**
 * （官方刚写进去的 `link:` 形态），**要么已经是插件仓库里的那份拷贝**。
 * 连续两轮读到同一个值才算稳定 —— pnpm 会重写整个清单，读到一半不能动手。
 *
 * @returns {{ ok: true, value, atSource, atCopy } | { ok: false, message }}
 */
export async function awaitOfficialWrite({
  name,
  source,
  profile,
  home = dshHome(),
  timeoutMs = OFFICIAL_WRITE_TIMEOUT_MS,
  pollMs = OFFICIAL_WRITE_POLL_MS,
} = {}) {
  const resolved = resolveProfile(profile, home)
  const sourceDir = typeof source === 'string' && source !== '' ? resolve(source) : null
  const deadline = Date.now() + timeoutMs
  let lastValue = null
  let stableReads = 0

  while (Date.now() < deadline) {
    await sleep(pollMs)
    const current = readDependency({ name, profile: resolved.profile, home })
    if (typeof current !== 'string' || current === '') {
      lastValue = null
      stableReads = 0
      continue
    }
    const atSource =
      sourceDir !== null && dependencyTargetsDir(current, sourceDir, { profile: resolved.profile, home })
    const atCopy = dependencyTargetsCopy(current, { name, profile: resolved.profile, home })
    if (!atSource && !atCopy) {
      lastValue = null
      stableReads = 0
      continue
    }
    if (current === lastValue) {
      stableReads += 1
      if (stableReads >= 1) return { ok: true, value: current, atSource, atCopy }
    } else {
      lastValue = current
      stableReads = 0
    }
  }
  return {
    ok: false,
    message: `等了 ${Math.round(timeoutMs / 1000)} 秒也没看到官方把 ${name} 写进 profile 的依赖（官方那次安装没成功，或它没碰本地路径）`,
  }
}

/** 删掉一个链接（Windows 的 junction 要用 rmdir，符号链接用 unlink）。 */
function dropLink(linkPath) {
  try {
    unlinkSync(linkPath)
    return
  } catch {}
  try {
    rmdirSync(linkPath)
    return
  } catch {}
  rmSync(linkPath, { recursive: true, force: true })
}

/**
 * 把 `node_modules/<name>` 重指到插件仓库里的那份拷贝。
 *
 * 官方装本地路径时 pnpm 建的是指向**源目录**的链接；依赖被改写成指向拷贝之后，链接也该
 * 跟着指过去 —— 否则源目录一被删或一移动，插件就加载不到了。
 * **只在自己人之间搬**：链接当前指向 `expectedFrom`（这次安装的源目录）、或者根本不存在时才动手；
 * 指向别处一律放过并如实报告。
 */
export function relinkNodeModulesToCopy(name, profileDir, target, expectedFrom = null) {
  if (!isSafeName(name)) return { ok: false, message: `插件名不合法：${name}` }
  const linkPath = join(profileDir, 'node_modules', ...String(name).split('/'))
  const wanted = resolve(target)
  if (existsSync(linkPath)) {
    let points = null
    try {
      // ⚠️ 必须用 `realpathSync.native`：Windows 上 junction 在 JS 版 realpath 里
      // 解析不出来（会原样返回链接自身），只有 native 那条（走 libuv）才认它
      points = resolve(realpathSync.native(linkPath))
    } catch {
      points = null
    }
    if (points === wanted) return { ok: true, reused: true }
    if (expectedFrom === null || points !== resolve(expectedFrom)) {
      return { ok: false, message: `node_modules 里已有 ${name} 且不指向这次安装，未改动：${linkPath}` }
    }
    dropLink(linkPath)
  }
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(wanted, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return { ok: true, relinked: true }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

/**
 * 官方装完之后的两件后置动作：**复制一份副本**进插件仓库、**把 profile 里那一行改写成目标形态**。
 *
 * 顺序就是需求里说的那个顺序：官方先写（`link:<源目录>`），我们再复制 + 改写。
 * 复制必须先做 —— 改写后的相对路径 `file:../../plugins/<profile>/<name>` 得先有东西可指。
 *
 * 官方流程的后续（选中 bundle、写入 `dsh.profile.bundles`、提示重启）**不受影响**：
 * 我们只动 `dependencies` 里那一行的形态与 `node_modules` 链接的指向，两处指向的是同一份代码。
 */
export function rewriteToWarehouse({ source, name, profile, home = dshHome() } = {}) {
  const resolved = resolveProfile(profile, home)
  if (!isSafeProfile(resolved.profile)) return { ok: false, message: `profile 名不合法：${resolved.profile}` }
  if (!resolved.exists) return { ok: false, message: `找不到 profile：${resolved.packageJsonPath}` }

  let info
  try {
    info = readSource(source)
  } catch (error) {
    return { ok: false, message: `读源目录失败：${messageOf(error)}` }
  }
  const pluginName = isSafeName(name) ? name : info.name
  if (pluginName !== info.name) {
    return { ok: false, message: `源目录的包名是 ${info.name}，与这次安装记下的 ${pluginName} 不一致，拒绝改写` }
  }

  const staged = stageCopy({ source: info.dir, profile: resolved.profile, home })
  if (!staged.ok) return staged

  const normalized = normalizeDependencySpec({ name: pluginName, profile: resolved.profile, home, from: info.dir })
  const relinked = relinkNodeModulesToCopy(pluginName, resolved.dir, staged.target, info.dir)

  const warnings = [...staged.warnings]
  if (normalized.skipped) warnings.push(normalized.skipped)
  if (normalized.ok === false && normalized.message) warnings.push(normalized.message)
  if (relinked.ok === false && relinked.message) warnings.push(relinked.message)

  return {
    ok: normalized.ok !== false,
    name: pluginName,
    target: staged.target,
    copiedFiles: staged.copiedFiles,
    replaced: staged.replaced,
    dependency: normalized.dependency ?? dependencySpec(pluginName, resolved.profile),
    rewritten: normalized.changed === true,
    relinked: relinked.ok === true,
    normalized,
    relinkedResult: relinked,
    warnings,
    ...(normalized.ok === false
      ? { message: `副本已复制到 ${staged.target}，但 profile 里那一行没改成：${normalized.message}` }
      : {}),
  }
}

/**
 * 一次完整的「官方安装 + 我们的后置改写」：先等官方把那一行写进 profile，再复制副本 + 改写形态。
 * @returns 改写结果；官方那次没写成 → `{ ok: false, message }`
 */
export async function finishOfficialInstall({ source, profile, home = dshHome(), timeoutMs, pollMs } = {}) {
  let info
  try {
    info = readSource(source)
  } catch (error) {
    return { ok: false, message: `读源目录失败：${messageOf(error)}` }
  }
  const written = await awaitOfficialWrite({
    name: info.name,
    source: info.dir,
    profile,
    home,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pollMs === undefined ? {} : { pollMs }),
  })
  if (!written.ok) return { ok: false, name: info.name, ...written }
  return { ...rewriteToWarehouse({ source: info.dir, name: info.name, profile, home }), observed: written.value }
}

/** 读 profile 里某个依赖当前的值；没有/读不到 → null。 */
export function readDependency({ name, profile, home = dshHome() } = {}) {
  const resolved = resolveProfile(profile, home)
  if (!isSafeProfile(resolved.profile) || !resolved.exists) return null
  try {
    const manifest = JSON.parse(readFileSync(resolved.packageJsonPath, 'utf8'))
    const value = manifest.dependencies?.[String(name)]
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

/**
 * 把依赖值解析成**绝对路径**（`file:` / `link:` / 裸相对路径都认）；不是路径形态 → null。
 *
 * 为什么必须按解析后的绝对路径比，而不是比字符串：同一个目录有好几种合法写法 ——
 * `file:../../plugins/desktop/<name>`（我们要的目标形态）、pnpm 在 Windows 上写的反斜杠形态、
 * 以及 profile 里有 `pnpm-workspace.yaml` 时被规范化成的**绝对路径**
 * （`file:C:/Users/…`，实测形态），还有官方装本地路径时写的 `link:<源目录>`。
 * 非路径形态（registry 版本号、`git+https://…`）解析后落在一个不存在的怪路径上，自然不等于目标。
 */
export function dependencyPathOf(current, { profile, home = dshHome() } = {}) {
  if (typeof current !== 'string' || current === '') return null
  const resolved = resolveProfile(profile, home)
  const raw = current.replace(/^(?:file|link):/i, '').replace(/\\/g, '/').trim()
  if (raw === '') return null
  return /^(?:[A-Za-z]:\/|\/)/.test(raw) ? resolve(raw) : resolve(resolved.dir, raw)
}

/** 现有依赖值是否指向**插件仓库里的这份拷贝**。 */
export function dependencyTargetsCopy(current, { name, profile, home = dshHome() } = {}) {
  const path = dependencyPathOf(current, { profile, home })
  if (path === null) return false
  const resolved = resolveProfile(profile, home)
  return path === resolve(linkPathFor(name, resolved.profile, home))
}

/** 现有依赖值是否指向**某个具体目录**（用来认「官方刚写进去的那个源目录」）。 */
export function dependencyTargetsDir(current, dir, { profile, home = dshHome() } = {}) {
  const path = dependencyPathOf(current, { profile, home })
  return path !== null && dir !== null && dir !== undefined && path === resolve(dir)
}

// ── 自带的 Windows 原生选择器（koffi 直驱 IFileOpenDialog） ────────────────

/** 选择器的最长等待（毫秒）：官方那条也是 10 分钟。 */
const NATIVE_PICK_TIMEOUT_MS = 10 * 60 * 1000

/** worker 的真实文件路径（包内 `native-pick.cjs`）。 */
const NATIVE_WORKER_PATH = fileURLToPath(new URL('./native-pick.cjs', import.meta.url))

/**
 * worker 打在 stdout 上的标记。比「取最后一行当 JSON」可靠得多，而且是**判断要不要回落**的依据：
 * 只要看到 `showing`，就说明窗口已经弹出来了 —— 这时无论如何都不能再回落去弹第二个窗口。
 */
const SHOWING_MARK = 'DshPick:showing'
const RESULT_MARK = 'DshPick:result '

/**
 * 拉起自带的 Win32 选择器 worker（`native-pick.cjs`）。
 *
 * **为什么不能靠 Electron 的 `dialog.showOpenDialog`** —— 这一条是实测出来的硬结论：
 * DSH 桌面版启动宿主进程时设了 `ELECTRON_RUN_AS_NODE=1`（`app.asar/lib/main.js` 的
 * `desktopNodeEnvironment`），于是宿主里的 `require('electron')` 是 **MODULE_NOT_FOUND**
 * （已在本机实测），`electron.dialog` 永远是 undefined。之前那版把 Electron 当首选，
 * 结果每一次都静默回落到官方 `directoryPicker`：**没有起始目录、且只能选目录** ——
 * 正是用户反复反馈的「浏览本地目录没有记忆」「选 package.json 打开的是选文件夹」。
 *
 * 这个 worker 用 koffi 直接驱动 `IFileOpenDialog`：`SetFolder`（起始目录）+ 文件模式
 * （`FOS_FILEMUSTEXIST` + package.json 过滤）都是官方那份 worker 结构上没有的能力。
 *
 * @returns 结果对象；**完全不可用**时返回 null（调用方继续往下兜底）
 */
/**
 * 判定 worker 的 stdout —— 纯函数，好把各种输出形态（有 showing 没 result、有 result、
 * 全是噪音、空的）都测一遍。
 *
 * 关键决策是**要不要回落官方选择器**：stdout 里只要出现过 `DshPick:showing`，就说明窗口已经
 * 弹出来了，这时**一律不回落** —— 回落会让用户刚选完（或刚取消）之后又看到一个窗口，那正是
 * 被反馈的「选完 package.json 又冒出一个选文件夹的窗口」。
 *
 * @returns 结果对象；`null` 表示「worker 根本没跑起来」（这种情况才允许回落）
 */
export function judgeWorkerOutput(stdout, { elapsedMs = 0, seeded = false } = {}) {
  const text = String(stdout ?? '')
  const lines = text.split(/\r?\n/)
  const via = 'Windows 原生选择器（IFileOpenDialog）'
  const resultLine = lines.find((line) => line.startsWith(RESULT_MARK))
  const sawShowing = lines.some((line) => line.startsWith(SHOWING_MARK))
  let parsed = null
  if (resultLine !== undefined) {
    try {
      parsed = JSON.parse(resultLine.slice(RESULT_MARK.length))
    } catch {
      parsed = null
    }
  }

  if (parsed === null) {
    if (!sawShowing) return null // 没弹过窗口也没结果 → 根本没跑起来，可以回落到官方
    const tail = text.trim().slice(-300)
    return {
      noFallback: true,
      reason: `原生选择器弹出了窗口，但没把结果交回来（worker 可能崩了）${tail === '' ? '' : `；输出尾巴：${tail}`}`,
      via,
      shell: 'IFileDialog',
      elapsedMs,
    }
  }

  if (parsed.ok !== true) {
    const unavailable = parsed.code === 'KOFFI_UNAVAILABLE'
    return {
      unavailable,
      noFallback: !unavailable, // 只有「koffi 根本拿不到」才允许回落官方
      reason: typeof parsed.error === 'string' ? parsed.error : '原生选择器未给出结果',
      via,
      shell: 'IFileDialog',
      elapsedMs,
    }
  }

  return {
    path: typeof parsed.path === 'string' && parsed.path !== '' ? parsed.path : null,
    cancelled: parsed.cancelled === true,
    problem: typeof parsed.error === 'string' ? parsed.error : null,
    via,
    shell: 'IFileDialog',
    seeded,
    elapsedMs,
  }
}

export async function pickWithNativeWorker({ seed, kind = 'folder', title, timeoutMs = NATIVE_PICK_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') return null
  const wantFile = kind === 'file'
  const args = [
    NATIVE_WORKER_PATH,
    '--mode',
    wantFile ? 'file' : 'folder',
    '--title',
    title ?? (wantFile ? '选择插件的 package.json（DSH）' : '选择插件目录（DSH）'),
  ]
  if (typeof seed === 'string' && seed !== '') args.push('--seed', seed)

  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      // 与宿主同款的「Electron 以 Node 模式跑」：worker 里要 require 官方 asar 内的 koffi
      child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
    }, timeoutMs)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stdout?.on('error', () => {})
    child.stderr?.on('data', () => {})
    child.stderr?.on('error', () => {})
    child.on('error', () => finish(null))
    child.on('close', () => {
      finish(
        judgeWorkerOutput(stdout, {
          elapsedMs: Date.now() - started,
          seeded: typeof seed === 'string' && seed !== '',
        }),
      )
    })
  })
}

// ── 官方目录选择器（最后的兜底） ──────────────────────────────────────────

/**
 * 读官方的 `ctx.directoryPicker` 服务：`@deepseek-ai/dsh-host-directory-picker` 定义了能力位
 * `capability()`，native 后端返回 `{ kind: 'native', pick(signal) }`；browse 后端只有列目录原语。
 * @returns { kind, pick } 或 null（服务不存在/形状不符）
 */
export function officialPicker(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('directoryPicker') : ctx?.directoryPicker
    if (!service || typeof service.capability !== 'function') return null
    const capability = service.capability()
    if (!capability || typeof capability.kind !== 'string') return null
    if (capability.kind === 'native' && typeof capability.pick === 'function') {
      return { kind: 'native', pick: (signal) => capability.pick(signal) }
    }
    return { kind: capability.kind, pick: null }
  } catch {
    return null
  }
}

/** 用官方 native 选择器挑一个目录；不可用/失败返回 null（调用方继续往下走）。 */
export async function pickWithOfficial(ctx, { timeoutMs = OFFICIAL_PICK_TIMEOUT_MS } = {}) {
  const official = officialPicker(ctx)
  if (!official) return null
  if (official.pick === null) return { unsupported: true, kind: official.kind }
  const started = Date.now()
  /**
   * 官方签名是 `pick(signal)`，**signal 是必需参数**：实现第一行就读 `signal.aborted`。
   * 不传它就是 `Cannot read properties of undefined (reading 'aborted')` —— 实测踩过，
   * 表现是「官方 API 明明可用却每次都失败然后被跳过」。
   */
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const picked = await official.pick(controller.signal)
    const elapsedMs = Date.now() - started
    return {
      path: typeof picked === 'string' && picked !== '' ? picked : null,
      cancelled: !(typeof picked === 'string' && picked !== ''),
      via: 'DSH 官方目录选择器（native）',
      shell: 'dsh',
      elapsedMs,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── 选择器入口 ────────────────────────────────────────────────────────────

async function pickDirectoryRaw({ initial, home = dshHome(), ctx, kind = 'folder' } = {}) {
  const seed = pickSeed({ initial, home })
  const wantFile = kind === 'file'
  /**
   * 「选 package.json」会把**文件全路径**记进记忆，之后点「浏览本地目录」就会把它当种子 ——
   * 文件夹对话框收到文件路径定位不到，所以选目录时先把种子归一到它所在目录。
   */
  let seedDir = seed
  try {
    if (seed && existsSync(seed) && statSync(seed).isFile()) seedDir = dirname(seed)
  } catch {}

  /**
   * ① **自带的 Windows 原生选择器**（`native-pick.cjs`：koffi 直驱 `IFileOpenDialog`）。
   * 它吃得下起始目录（`SetFolder`）与文件模式，是唯一能同时满足
   * 「停在上次那个目录」和「真选 package.json」的一条路。
   */
  const native = await pickWithNativeWorker({ seed: wantFile ? seed : seedDir, kind })
  if (native !== null && native.reason === undefined) return native
  /**
   * 原生选择器**已经把窗口弹出来过**（或报了非「拿不到 koffi」的错误）→ **绝不回落**。
   * 回落会在用户刚选完/刚取消之后又弹一个窗口 —— 就是被反馈的「选完 package.json 又冒出
   * 一个选文件夹的窗口」。这时如实把原因带回界面，让用户看见到底哪一步没成。
   */
  if (native !== null && native.noFallback === true) return native

  /**
   * ② **官方 `directoryPicker`** 兜底（非 Windows、或拿不到 koffi 时）。
   * 它结构上没有 `SetFolder`，永远开在系统自己的 MRU；也只有一个目录选择器，
   * 所以「选 package.json」在它上面拿到的其实是目录 —— 结果里如实标注。
   */
  const official = await pickWithOfficial(ctx)
  if (official !== null) {
    const why = native?.reason ? `原生选择器不可用（${native.reason}），已回落官方选择器；` : ''
    if (official.unsupported) return { ...official, reason: `${why}${official.message ?? ''}`.trim() }
    if (wantFile && official.path) {
      return { ...official, via: `${why}${official.via}（官方只有目录选择器：把所选目录当插件目录）` }
    }
    return why === '' ? official : { ...official, via: `${why}${official.via}` }
  }

  return {
    path: null,
    cancelled: false,
    unavailable: true,
    kind,
    via: 'no-native-picker',
    elapsedMs: 0,
    reason: native?.reason
      ? `原生选择器不可用（${native.reason}），官方目录选择器也没拿到`
      : '原生选择器与官方目录选择器都不可用',
    hint: wantFile ? '请手动把插件目录路径粘到输入框' : '点「选 package.json」，或手动把插件目录路径粘到输入框',
  }
}

/**
 * 对外入口：结果统一「以目录为准」，并把这次的选择写进记忆（下次从它开始）。
 *
 *  - 成功：`dir` 一定是目录（文件模式选中的是 package.json，`pickedFile` 记下它、`dir` 记它所在目录）；
 *  - 不可用：带 `unavailable` 与可读原因，让界面直接说明为什么没有原生选择器。
 */
export async function pickDirectory(options = {}) {
  const home = options.home ?? dshHome()
  const result = await pickDirectoryRaw(options)
  if (result?.unavailable) return result
  const { dir, pickedFile } = normalizePicked(result?.path ?? null, home)
  if (dir) writeState({ lastPicked: dir }, home)
  return { ...result, dir, pickedFile }
}

// ── HTTP 路由 ─────────────────────────────────────────────────────────────

/** 读 JSON 请求体（上限 64 KiB）；空体为 `{}`；非法返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

export function apply(ctx) {
  const register = (path, handler, label) => {
    if (typeof ctx.webServer?.register !== 'function') return false
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `${name}: ${label}`)
    console.log(`[${name}] 已注册路由 ${label}`)
    return true
  }

  const json = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /**
   * 连接信任闸。`connection` 已列进 inject，正常应当可用；万一拿不到（服务缺失/抛错），
   * **失败即拒绝** —— 这三条路由能拉起系统对话框、能往插件仓库里写文件，不能在没有信任校验时放行。
   */
  const trust = (req) => {
    const service = ctx.connection
    if (typeof service?.requestRejection !== 'function') {
      console.warn(`[${name}] connection.requestRejection 不存在，已拒绝请求`)
      return { unavailable: true }
    }
    try {
      const rejection = service.requestRejection(req)
      return { rejection: rejection === undefined || rejection === null ? null : rejection }
    } catch (error) {
      console.warn(`[${name}] 连接信任校验抛错：${messageOf(error)}`)
      return { unavailable: true }
    }
  }

  /** 统一包装：信任检查 + 方法校验 + 体解析。 */
  const route = (method, handler) => async (req, res) => {
    try {
      const checked = trust(req)
      if (checked.unavailable) {
        json(res, 503, { ok: false, message: '连接信任服务不可用，已拒绝请求' })
        return
      }
      if (checked.rejection !== null) {
        // 只接受合法的 HTTP 状态码：信任服务返回对象/字符串时直接赋值会抛错，语义会从「拒绝」变成「服务坏了」
        const code = Number(checked.rejection)
        if (!Number.isInteger(code) || code < 100 || code > 599) {
          console.warn(`[${name}] 连接信任服务给出的拒绝码非法（${JSON.stringify(checked.rejection)}），按 403 处理`)
          json(res, 403, { ok: false, message: '连接信任服务给出的拒绝码非法，已按 403 拒绝' })
          return
        }
        res.statusCode = code
        res.end()
        return
      }
      if (req.method !== method) {
        res.statusCode = 405
        res.setHeader('allow', method)
        res.end()
        return
      }
      let body = {}
      if (method !== 'GET') {
        body = await readJsonBody(req)
        if (body === null) {
          json(res, 400, { ok: false, message: '请求体必须是 JSON 对象' })
          return
        }
      }
      const result = await handler(body, req)
      json(res, result?.status ?? 200, result?.payload ?? result ?? { ok: true })
    } catch (error) {
      json(res, 500, { ok: false, message: messageOf(error) })
    }
  }

  // 打开系统选择器；成功后把这次选择写进记忆（下次从它开始）
  register(
    ROUTE_PICK,
    route('POST', async (body) => {
      try {
        const result = await pickDirectory({
          initial: body?.initial,
          ctx,
          kind: body?.kind === 'file' ? 'file' : 'folder',
        })
        if (result?.unavailable) {
          return {
            status: 200,
            payload: { ok: false, ...result, message: `${result.reason}；${result.hint}` },
          }
        }
        if (result?.unsupported) {
          return {
            status: 200,
            payload: {
              ok: false,
              unsupported: true,
              kind: result.kind,
              via: 'DSH 官方目录选择器',
              message: `当前 DSH 用的是 ${result.kind} 目录选择后端（远程/浏览器场景没有原生选择器），请直接把路径粘到输入框里。`,
            },
          }
        }
        /**
         * 原生选择器**跑完了但没给出路径**（窗口弹过、取不到结果 / 报错）——
         * 如实报错，不能装成「已取消选择」，也不能回落去弹第二个窗口。
         */
        const nativeProblem = result?.reason ?? result?.problem
        if (nativeProblem !== undefined && result?.path == null && result?.cancelled !== true) {
          return {
            status: 200,
            payload: {
              ok: false,
              via: result.via,
              reason: nativeProblem,
              message: `原生选择器没给出路径：${nativeProblem}`,
            },
          }
        }
        return { payload: { ok: true, ...result } }
      } catch (error) {
        return {
          status: 500,
          payload: { ok: false, message: `打开文件夹选择器失败：${messageOf(error)}` },
        }
      }
    }),
    `POST ${ROUTE_PICK}`,
  )

  /**
   * 预览卡片：只读一个本地目录的 package.json，把包名/版本/说明/是不是 DSH 插件回报给界面。
   * 输入框里有路径时，界面会防抖调它，把结果渲染成输入框下面那张小卡片。
   */
  register(
    ROUTE_INSPECT,
    route('POST', (body) => {
      try {
        const info = readSource(body?.source)
        return {
          payload: {
            ok: true,
            dir: info.dir,
            name: info.name,
            version: info.version,
            description: info.description ?? '',
            private: info.private,
            isDshPlugin: info.isDshPlugin,
            hasBundlePatch: info.hasBundlePatch,
            hasClient: info.hasClient,
            runtimeDeps: info.runtimeDeps,
            sourceKind: info.sourceKind,
            adjusted: info.adjusted ?? null,
            nestedFrom: info.nestedFrom ?? null,
            warnings: info.warnings,
          },
        }
      } catch (error) {
        return { payload: { ok: false, message: messageOf(error) } }
      }
    }),
    `POST ${ROUTE_INSPECT}`,
  )

  /**
   * 收尾：**等官方那次安装把依赖写进 profile**，然后把副本复制进插件仓库、把依赖那一行改写成
   * 本插件要的形态（`file:../../plugins/<profile>/<name>`）。
   *
   * 官方流程（点「安装」→ 官方跑 pnpm → 官方写 `link:<源目录>` → 官方选中 bundle → 提示重启）
   * **一步都不拦、也不代替**：用户看到的就是官方自己的进度与结果。我们只做两件后置的事，
   * 而且只在**确实看到官方写了那一行之后**才动手；官方那次没写成，这里如实回报「没等到」。
   */
  register(
    ROUTE_FINISH,
    route('POST', async (body) => {
      const profile = String(body?.profile ?? '').trim() || detectProfile()
      const timeoutMs = Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined
      const outcome = await finishOfficialInstall({ source: body?.source, profile, timeoutMs })
      if (outcome.ok === false && outcome.name === undefined) return { status: 400, payload: outcome }
      return { payload: outcome }
    }),
    `POST ${ROUTE_FINISH}`,
  )

  console.log(
    `[${name}] 已激活（profile=${detectProfile()}，插件仓库=${pluginsRoot()}）——` +
      '勾选「本地安装」时：官方照常装（它写 link:<源目录>），装完由本插件复制一份副本并把依赖改写成 file: 相对形态',
  )
}

/**
 * 测试入口：只给「没有 export、但测试要用」的内部件留个口子。
 *
 * `stageCopy` / `rewriteToWarehouse` 故意**不**放进来 —— 它们会写插件仓库与 profile 清单，
 * 测试误触就是真实安装；要测它们请直接 `import` 并显式传临时 `home`。
 */
export const __internals = {
  isSafeName,
  isSafeProfile,
  readdirSafe,
  isInside,
  readJsonBody,
  pickDirectoryRaw,
  NATIVE_WORKER_PATH,
}

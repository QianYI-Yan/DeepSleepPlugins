/**
 * dsh-preset-bridge —— dsh-preset-dir-scan + dsh-preset-folder-button 的合并版。
 *
 * 一个宿主插件，干两件配套的事：
 *
 *  A. 目录扫描（原 dsh-preset-dir-scan）
 *     把 DSH_HOME/.agent-presets/<id>/ 下的 preset.yml + agent.cordis.yml 读成
 *     agent-preset 声明，交给 ctx.agentPresets.register()，并监视目录变化重同步。
 *     于是 0.1.x 时代的「目录式预设」在 0.2.0 上原样继续可用。
 *
 *  B. 打开目录路由（原 dsh-preset-folder-button）
 *     注册 POST /preset-folder/open：过了 dsh 的连接信任检查后，用系统文件管理器打开预设目录。
 *     入参二选一：`presetId`（目录名）或 `name`（预设显示名，见 findPresetDirByName）；
 *     都不传就打开预设根目录。目录不存在返回 404。
 *     调用方是**客户端半**（main/preset-bridge/client.js）注入到官方预设卡片上的「打开目录」按钮 ——
 *     那按钮是纯 DOM 注入的，不改官方任何文件，所以官方怎么打包（npx 缓存 / 桌面版 app.asar）都有效。
 *
 * 合并要点
 *  - inject 取两者并集 ['agentPresets', 'webServer']；
 *  - 预设目录来源规则只算一次（原先是两份重复实现）；
 *  - config.scan / config.route 可单独关掉其中一半，默认都开；
 *  - 两半互不牵连：扫描出错不影响路由，路由注册失败也不打断扫描。
 *
 * 兼容处理（沿用 dir-scan 的行为，与 0.2.0 官方现状对齐）
 *  - `!!js` 表达式保留为 { __jsExpr: '原文' }，不在注册时求值；
 *  - 相对模块名（./xxx.mjs）改写成基于该预设目录的绝对 file:// 地址；
 *  - 0.2.0 已移除的包 @deepseek-ai/dsh-workflow-worker-thread → workflow-ptc；
 *  - 单份预设出错只跳过它本身，绝不影响 dsh 启动或其它预设。
 */
import { openFolder } from '../../lib/shared/open-dir.js'
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-preset-bridge'

/** 合并后的注入面：预设注册要 agentPresets，路由要 webServer，信任闸要 connection。 */
export const inject = ['agentPresets', 'webServer', 'connection']

/** 预设目录名（位于 DSH_HOME 下）。 */
const PRESET_DIR_NAME = '.agent-presets'

/** 「打开目录」路由路径（原 folder-button 的对外契约，保持不变）。 */
const ROUTE = '/preset-folder/open'

/** 已知由插件自带、与老目录同名的预设：跳过，避免 id 冲突。 */
const SKIP_IDS = new Set(['liangshen'])

/** `!!js` 表达式标签：保留原文，等子插件激活时由加载器求值。 */
const jsExpressionTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ __jsExpr: String(value) }),
}

/** 0.2.0 已移除的包 → 替代行（照 0.2.0 官方 base 的写法）。 */
const ROW_REWRITES = new Map([
  ['@deepseek-ai/dsh-workflow-worker-thread', { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc' }],
])

/** 预设 id 只允许字母、数字与 . _ -（挡住 ../ 之类的路径穿越）。 */
const SAFE_PRESET_ID = /^[A-Za-z0-9._-]+$/

// ── yaml 的运行时装填 ─────────────────────────────────────────────────────
//
// 为什么不能直接 `import YAML from 'yaml'`：本插件常以 file: 依赖 / junction 的形式安装，
// Node 会按**真实路径**解析依赖，于是 `yaml` 会去 D:\Code\...\.local\dsh-preset-bridge\node_modules
// 一路往上找，找不到宿主 profile 里的那份，插件直接 ERR_MODULE_NOT_FOUND 加载失败。
// 所以：先试裸名（依赖装好了就走这条），失败再按宿主的实际位置逐个候选尝试。

let YAML = null
let yamlSource = null

/** 依次尝试的 yaml 位置：自己包内 → 宿主各 profile → DSH_HOME 根。 */
export function yamlCandidates() {
  const here = dirname(fileURLToPath(import.meta.url))
  const home = dshHome()
  // 本文件位于 <包根>/main/preset-bridge/（旧位置是 <包根>/lib/），包根比它高两层。
  const packageRoot = join(here, '..', '..')
  const list = [
    join(packageRoot, 'node_modules', 'yaml', 'dist', 'index.js'),
    join(packageRoot, '..', 'node_modules', 'yaml', 'dist', 'index.js'),
  ]
  try {
    for (const entry of readdirSync(join(home, 'profiles'))) {
      list.push(join(home, 'profiles', entry, 'node_modules', 'yaml', 'dist', 'index.js'))
    }
  } catch {}
  list.push(join(home, 'node_modules', 'yaml', 'dist', 'index.js'))
  list.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'node_modules', 'yaml', 'dist', 'index.js'))
  return list
}

/** 载入 yaml（幂等）。找不到时抛一条能照着做的错误。 */
export async function loadYaml() {
  if (YAML) return YAML
  try {
    const mod = await import('yaml')
    YAML = mod.default ?? mod
    yamlSource = 'bare:yaml'
    return YAML
  } catch {}
  for (const candidate of yamlCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      YAML = mod.default ?? mod
      yamlSource = candidate
      return YAML
    } catch {}
  }
  throw new Error(
    '找不到 yaml 模块：可在本插件目录执行 `pnpm add yaml`，' +
      '或用 `dsh plugin --profile <profile> add link:<本插件目录>` 安装（官方安装会顺带装依赖）',
  )
}

/** 已载入的 yaml 来源（诊断用）。 */
export function yamlLoadedFrom() {
  return yamlSource
}

// ── 共享：DSH_HOME 与预设目录 ────────────────────────────────────────────────

/** DSH_HOME（默认 ~/.dsh）。 */
function dshHome() {
  return (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
}

/** 预设根目录（原两个插件各写了一份，现在只在这里算）。 */
export function presetRoot() {
  return join(dshHome(), PRESET_DIR_NAME)
}

// ── 功能 A 的解析工具 ──────────────────────────────────────────────────────

/** 解析 YAML（支持 `!!js`；重复键不报错，宽容一点）。需先 await loadYaml()。 */
export function parseYaml(text) {
  if (!YAML) throw new Error('yaml 尚未载入：请先 await loadYaml()')
  return YAML.parse(text, { customTags: [jsExpressionTag], uniqueKeys: false })
}

/**
 * 递归处理行列表：替换已移除的包、把相对模块名改成绝对 file:// 地址。
 * @param rows 行列表（agent.cordis.yml 的顶层，或 group 行的 config 数组）
 * @param baseDir 相对名解析的基准目录（该预设自己的目录）
 */
export function rewriteRows(rows, baseDir) {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
    const out = { ...row }
    const replacement = typeof out.name === 'string' ? ROW_REWRITES.get(out.name) : undefined
    if (replacement) {
      return { ...replacement, ...(out.config === undefined ? {} : { config: out.config }) }
    }
    if (typeof out.name === 'string' && (out.name.startsWith('./') || out.name.startsWith('../'))) {
      out.name = pathToFileURL(resolve(baseDir, out.name)).href
    }
    if (out.group === true && Array.isArray(out.config)) {
      out.config = rewriteRows(out.config, baseDir)
    }
    return out
  })
}

/** 读一份预设目录 → `register()` 需要的定义。 */
export function readPresetDefinition(id, dir) {
  const metaFile = join(dir, 'preset.yml')
  const compositionFile = join(dir, 'agent.cordis.yml')
  if (!existsSync(compositionFile)) throw new Error('缺少 agent.cordis.yml')
  const meta = existsSync(metaFile) ? (parseYaml(readFileSync(metaFile, 'utf8')) ?? {}) : {}
  const rows = parseYaml(readFileSync(compositionFile, 'utf8'))
  if (!Array.isArray(rows)) throw new Error('agent.cordis.yml 的顶层必须是行列表')
  return {
    id,
    ...(typeof meta.name === 'string' && meta.name !== '' ? { name: meta.name } : {}),
    ...(typeof meta.description === 'string' && meta.description !== '' ? { description: meta.description } : {}),
    ...(typeof meta.order === 'number' && Number.isFinite(meta.order) ? { order: meta.order } : {}),
    plugins: rewriteRows(rows, dir),
  }
}

/** 列出预设目录（跳过 `_` 开头的公共资源目录与隐藏目录）。 */
export function listPresetDirs(root) {
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    if (existsSync(join(dir, 'agent.cordis.yml'))) found.push({ id: entry.name, dir })
  }
  return found
}

/**
 * 从 `preset.yml` 里抠出 `name:` 一行（**不**引 yaml：这里只需要一个简单标量，
 * 而 yaml 模块可能压根没装 —— 见上面的 yamlCandidates 说明）。
 */
export function readPresetName(dir) {
  const file = join(dir, 'preset.yml')
  if (!existsSync(file)) return null
  try {
    const match = /^name:[ \t]*(.+)$/m.exec(readFileSync(file, 'utf8'))
    if (!match) return null
    const value = match[1].trim().replace(/^["']|["']$/g, '')
    return value === '' ? null : value
  } catch {
    return null
  }
}

/**
 * 按「显示名」找预设目录。
 *
 * 为什么需要它：0.2.0 的预设卡片只把**显示名**渲染进 DOM（在「浏览」按钮的 `aria-label` 里），
 * 目录名（= 预设 id）拿不到，所以靠 DOM 注入的「打开目录」按钮只能回传名字。
 * 匹配顺序：目录名相等 → `preset.yml` 的 `name` 相等。
 */
export function findPresetDirByName(name, root = presetRoot()) {
  const wanted = String(name ?? '').trim()
  if (wanted === '') return null
  const dirs = listPresetDirs(root)
  for (const entry of dirs) {
    if (entry.id === wanted) return entry.dir
  }
  for (const entry of dirs) {
    if (readPresetName(entry.dir) === wanted) return entry.dir
  }
  return null
}

// ── 功能 B 的工具 ──────────────────────────────────────────────────────────

/** 读取请求体（上限 16 KiB）并当 JSON 解析；空体视为 {}；非法则返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) {
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

// ── 插件本体 ──────────────────────────────────────────────────────────────

export async function apply(ctx, config = {}) {
  const enabled = { scan: config.scan !== false, route: config.route !== false }
  const root = presetRoot()
  let closed = false

  const warn = (message) => {
    try {
      console.warn(`[dsh-preset-bridge] ${message}`)
      ctx.logger?.warn?.(`dsh-preset-bridge: ${message}`)
    } catch {}
  }
  const info = (message) => {
    try {
      console.log(`[dsh-preset-bridge] ${message}`)
      ctx.logger?.info?.(`dsh-preset-bridge: ${message}`)
    } catch {}
  }

  info(
    `插件已激活（预设目录：${root}；功能：` +
      `${[enabled.scan ? '目录扫描' : null, enabled.route ? '打开目录路由' : null].filter(Boolean).join(' + ') || '全部关闭'}）`,
  )

  // ── B：POST /preset-folder/open ─────────────────────────────────────────
  if (enabled.route) {
    if (typeof ctx.webServer?.register !== 'function') {
      warn('webServer 不可用，跳过「打开目录」路由注册')
    } else {
      try {
        ctx.effect(
          () =>
            ctx.webServer.register({
              kind: 'exact',
              path: ROUTE,
              handler: async (req, res) => {
                // 与官方插件同一道信任闸：不是本机带令牌的页面调用一律拒掉。
                // connection 已在 inject 里；万一拿不到则失败即拒绝，不放行。
                const json0 = (status, payload) => {
                  res.statusCode = status
                  res.setHeader('content-type', 'application/json; charset=utf-8')
                  res.setHeader('cache-control', 'no-store')
                  res.end(JSON.stringify(payload))
                }
                try {
                  if (typeof ctx.connection?.requestRejection !== 'function') {
                    json0(503, { ok: false, message: '连接信任服务不可用，已拒绝请求' })
                    return
                  }
                  const rejection = ctx.connection.requestRejection(req)
                  if (rejection !== undefined && rejection !== null) {
                    res.statusCode = rejection
                    res.end()
                    return
                  }
                } catch {
                  json0(503, { ok: false, message: '连接信任检查出错，已拒绝请求' })
                  return
                }
                const json = (status, payload) => {
                  res.statusCode = status
                  res.setHeader('content-type', 'application/json; charset=utf-8')
                  res.setHeader('cache-control', 'no-store')
                  res.end(JSON.stringify(payload))
                }
                if (req.method !== 'POST') {
                  res.statusCode = 405
                  res.setHeader('allow', 'POST')
                  res.end()
                  return
                }
                let body
                try {
                  body = await readJsonBody(req)
                } catch {
                  json(400, { ok: false, message: '请求体读取失败' })
                  return
                }
                if (body === null) {
                  json(400, { ok: false, message: '请求体必须是 JSON 对象' })
                  return
                }
                const rawId = body.presetId
                const presetId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : undefined
                const rawName = body.name
                const presetName = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : undefined
                if (presetId !== undefined && (!SAFE_PRESET_ID.test(presetId) || presetId.includes('..'))) {
                  json(400, { ok: false, message: `预设标识不合法：${presetId}` })
                  return
                }
                /**
                 * 两种入参：
                 *   - `presetId`（目录名）—— 老按钮与命令行用；
                 *   - `name`（显示名）—— DOM 注入的按钮只能拿到这个，见 findPresetDirByName。
                 */
                let dir = root
                if (presetId !== undefined) {
                  dir = join(root, presetId)
                } else if (presetName !== undefined) {
                  const matched = findPresetDirByName(presetName, root)
                  if (matched === null) {
                    json(404, { ok: false, message: `按名字找不到预设目录：${presetName}` })
                    return
                  }
                  dir = matched
                }
                if (!existsSync(dir)) {
                  json(404, { ok: false, message: `预设目录不存在：${dir}` })
                  return
                }
                try {
                  openFolder(dir)
                  json(200, { ok: true, path: dir })
                } catch (error) {
                  json(500, { ok: false, message: error instanceof Error ? error.message : String(error) })
                }
              },
            }),
          `preset-bridge: POST ${ROUTE}`,
        )
        info(`已注册路由 POST ${ROUTE}`)
      } catch (error) {
        warn(`路由注册失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ── A：扫描目录 → 注册表 ────────────────────────────────────────────────
  if (!enabled.scan) return undefined
  const registry = ctx.agentPresets
  if (typeof registry?.register !== 'function') {
    warn('agent-preset 注册表不可用，跳过目录扫描')
    return undefined
  }
  // yaml 先拿到手：拿不到就只跳过扫描（「打开目录」路由照常可用），不抛给 dsh
  try {
    await loadYaml()
    info(`yaml 就绪：${yamlLoadedFrom()}`)
  } catch (error) {
    warn(`目录扫描已跳过：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  /** id → 注销函数（register 的返回值）。 */
  const live = new Map()

  /** 扫描目录并与注册表对齐（新增/移除/变化都收敛到当前目录状态）。 */
  const sync = async () => {
    if (closed) return
    const dirs = listPresetDirs(root)
    const seen = new Set()
    for (const { id, dir } of dirs) {
      if (SKIP_IDS.has(id)) continue
      seen.add(id)
      if (live.has(id)) continue
      try {
        const definition = readPresetDefinition(id, dir)
        const release = await registry.register(definition)
        live.set(id, release)
        info(`已注册预设 ${id}${definition.name ? `（${definition.name}）` : ''}`)
      } catch (error) {
        warn(`注册预设 ${id} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const [id, release] of [...live]) {
      if (seen.has(id)) continue
      try {
        await release()
      } catch {}
      live.delete(id)
      info(`已注销预设 ${id}（目录已移除）`)
    }
  }

  /** 目录监视：有改动就重新同步（失败不影响注册本身）。 */
  let watcher
  try {
    if (existsSync(root)) {
      watcher = watch(root, { persistent: false }, () => {
        void sync().catch((error) => warn(`同步失败：${error instanceof Error ? error.message : String(error)}`))
      })
    }
  } catch (error) {
    warn(`目录监视不可用（不影响使用）：${error instanceof Error ? error.message : String(error)}`)
  }

  /** 卸载时：停监视、注销所有已注册预设。 */
  ctx.effect?.(() => () => {
    closed = true
    try {
      watcher?.close()
    } catch {}
    for (const release of live.values()) {
      try {
        void release()
      } catch {}
    }
    live.clear()
  })

  return sync().catch((error) => warn(`首次同步失败：${error instanceof Error ? error.message : String(error)}`))
}

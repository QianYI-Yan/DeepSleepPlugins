/**
 * dsh-plugin-session-popout —— 宿主半（合集 yintxplugins 的子插件之一）。
 *
 * 能力：把当前会话**拖出来**（或点一下按钮）开成独立小窗，小窗里是一份精简过的同一个 GUI。
 * 开窗动作在浏览器侧（`window.open`），所以宿主半只负责两件事：
 *
 *   1. 小窗配置的服务端副本：`DSH_HOME/yintxplugins/session-popout/config.json`
 *      —— 默认尺寸与是否精简界面（本地 localStorage 优先，这里兜底，跨浏览器/清缓存后不丢）。
 *   2. 诊断路由：`/plugin-session-popout/ping` 回答「宿主半挂上了没有、版本多少、配置存哪」。
 *
 * 路由（过官方连接信任闸，与合集其它子插件同一道）：
 *   GET  /plugin-session-popout/ping    探活 + 版本 + DSH_HOME + 是否有服务端配置
 *   GET  /plugin-session-popout/config  读配置（没有时返回默认值）
 *   POST /plugin-session-popout/config  写配置（字段先校验夹紧再落盘）
 *
 * 写盘策略与 todo-float 一致：临时文件 + rename 原子替换，失败只记警告。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { sendJson, sendMethodNotAllowed } from '../../lib/shared/respond.js'

export const name = 'dsh-plugin-session-popout'

/** webServer 是硬依赖；connection 只用于信任闸，缺席时放行。 */
export const inject = ['webServer']

/** 宿主半版本号（改动功能时同步递增）。 */
const VERSION = '0.1.0'

const ROUTE_PING = '/plugin-session-popout/ping'
const ROUTE_CONFIG = '/plugin-session-popout/config'

/** 小窗默认配置（客户端拿不到存档时就用这一份）。 */
const DEFAULT_CONFIG = {
  /** 小窗宽（CSS 像素）。 */
  width: 520,
  /** 小窗高（CSS 像素）。 */
  height: 760,
  /** 是否在小窗里隐藏侧栏等旁支，只留会话列。 */
  slim: true,
  /** 开窗后是否尝试聚焦已存在的小窗（而不是再开一个）。 */
  reuse: true,
  /**
   * 开窗方式：
   *   - `inline`（默认）：在主界面里开**内嵌小窗**（iframe 加载同一地址）。
   *     DSH 桌面端是 Tauri + WebView2，宿主没有开新窗口的处理器，`window.open` 会静默什么也不做，
   *     所以默认不能指望系统弹窗。
   *   - `window`：坚持用 `window.open` 开独立窗口（浏览器里更顺手）。
   *   - `auto`：先试 `window.open`，明确被拒（返回 null）再退回内嵌。
   */
  mode: 'inline',
}

/** 允许的 mode 取值。 */
const MODES = ['inline', 'window', 'auto']

/** 配置字段的取值约束。 */
const CONFIG_FIELDS = {
  width: { min: 320, max: 3840 },
  height: { min: 240, max: 2160 },
}

/** DSH_HOME（默认 ~/.dsh）。 */
export function dshHome() {
  return (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
}

/** 配置存档路径：`<DSH_HOME>/yintxplugins/session-popout/config.json`。 */
export function configFile(home = dshHome()) {
  return join(home, 'yintxplugins', 'session-popout', 'config.json')
}

/**
 * 校验并夹紧一份配置：只认已知字段，数值夹到区间，未知字段丢弃。
 * @param value 待校验对象
 * @returns `{ ok: true, config } | { ok: false, message }`
 */
export function normalizeConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'config 必须是对象' }
  }
  const config = {}
  for (const [key, range] of Object.entries(CONFIG_FIELDS)) {
    const raw = value[key]
    if (raw === undefined || raw === null) continue
    const num = Number(raw)
    if (!Number.isFinite(num)) return { ok: false, message: `${key} 不是有限数：${String(raw)}` }
    config[key] = Math.min(range.max, Math.max(range.min, Math.round(num)))
  }
  for (const flag of ['slim', 'reuse']) {
    if (typeof value[flag] === 'boolean') config[flag] = value[flag]
  }
  // mode 是枚举：只认已知取值，乱写的不写进存档（客户端另有回落）
  if (value.mode !== undefined && value.mode !== null) {
    if (!MODES.includes(value.mode)) {
      return { ok: false, message: `mode 只能是 ${MODES.join(' / ')}，收到：${String(value.mode)}` }
    }
    config.mode = value.mode
  }
  if (Object.keys(config).length === 0) return { ok: false, message: 'config 里没有任何可识别的字段' }
  return { ok: true, config }
}

/** 读配置；没有或坏了返回默认值（`from: 'default'`）。 */
export function readConfig(home = dshHome()) {
  const file = configFile(home)
  if (!existsSync(file)) return { config: { ...DEFAULT_CONFIG }, updatedAt: null, from: 'default' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const checked = normalizeConfig(parsed?.config)
    if (!checked.ok) return { config: { ...DEFAULT_CONFIG }, updatedAt: null, from: 'default' }
    return { config: { ...DEFAULT_CONFIG, ...checked.config }, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null, from: 'file' }
  } catch {
    return { config: { ...DEFAULT_CONFIG }, updatedAt: null, from: 'default' }
  }
}

/** 原子写配置。 */
export function writeConfig(config, home = dshHome()) {
  const file = configFile(home)
  const temp = `${file}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, JSON.stringify({ config, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    renameSync(temp, file)
    return { ok: true, file }
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {}
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 读请求体（16KB 上限）。 */
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
    // 只收普通对象：数组/标量一律当作非法体（否则会被当成合法 JSON 再报字段错误，语义含混）。
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const home = typeof config.home === 'string' && config.home.trim() !== '' ? config.home.trim() : dshHome()
  const requireTrust = config.requireTrust !== false

  const log = (message) => {
    try {
      console.log(`[${name}] ${message}`)
      ctx.logger?.info?.(`${name}: ${message}`)
    } catch {}
  }
  const warn = (message) => {
    try {
      console.warn(`[${name}] ${message}`)
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {}
  }

  log(`宿主半已激活 v${VERSION}（配置存档 ${configFile(home)}）`)

  /** 过官方连接信任闸；服务缺失或抛错时放行。 */
  const rejected = (req) => {
    if (!requireTrust) return null
    try {
      const verdict = ctx.connection?.requestRejection?.(req)
      return verdict === undefined || verdict === null ? null : verdict
    } catch {
      return null
    }
  }

  /** 同路径的读与写必须合成一条路由（官方 webServer 按精确路径注册，重复会互相覆盖）。 */
  const routes = [
    {
      path: ROUTE_PING,
      allow: 'GET',
      handler: (req, res) => {
        const stored = readConfig(home)
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          version: VERSION,
          dshHome: home,
          configFile: configFile(home),
          hasConfig: stored.from === 'file',
          defaults: { ...DEFAULT_CONFIG },
          requireTrust,
        })
      },
    },
    {
      path: ROUTE_CONFIG,
      allow: 'GET, POST',
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const stored = readConfig(home)
          sendJson(res, 200, { ok: true, config: stored.config, updatedAt: stored.updatedAt, from: stored.from })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          sendJson(res, 400, { ok: false, message: '请求体读取失败' })
          return
        }
        if (body === null) {
          sendJson(res, 400, { ok: false, message: '请求体必须是 JSON 对象' })
          return
        }
        const checked = normalizeConfig(body.config)
        if (!checked.ok) {
          sendJson(res, 400, { ok: false, message: checked.message })
          return
        }
        const merged = { ...readConfig(home).config, ...checked.config }
        const written = writeConfig(merged, home)
        if (!written.ok) {
          warn(`配置落盘失败：${written.message}`)
          sendJson(res, 500, { ok: false, message: written.message })
          return
        }
        sendJson(res, 200, { ok: true, config: merged })
      },
    },
  ]

  if (typeof ctx.webServer?.register !== 'function') {
    warn('webServer 不可用，路由没注册')
    return { home, configFile: configFile(home), registered: 0 }
  }

  let registered = 0
  for (const route of routes) {
    try {
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: (req, res) => {
              const rejection = rejected(req)
              if (rejection !== null) {
                res.statusCode = rejection
                res.end()
                return
              }
              const method = String(req.method ?? 'GET').toUpperCase()
              const allowed = route.allow.split(',').map((item) => item.trim())
              if (!allowed.includes(method)) {
                sendMethodNotAllowed(res, route.allow)
                return
              }
              try {
                const result = route.handler(req, res)
                if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
                  return result.catch((error) => {
                    try {
                      sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
                    } catch {}
                  })
                }
                return result
              } catch (error) {
                sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
                return undefined
              }
            },
          }),
        `${name}: ${route.allow} ${route.path}`,
      )
      registered += 1
      log(`已注册路由 ${route.allow} ${route.path}`)
    } catch (error) {
      warn(`注册路由 ${route.path} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect?.(() => () => log('已卸载'))

  return { home, configFile: configFile(home), registered }
}

export { VERSION, ROUTE_PING, ROUTE_CONFIG, DEFAULT_CONFIG, MODES }

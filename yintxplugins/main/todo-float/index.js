/**
 * dsh-plugin-todo-float —— 宿主半（合集 yintxplugins 的子插件之一）。
 *
 * 客户端半是**纯浏览器**的：它直接订阅官方客户端会话投影（`sessions.binding(id).session.projections.faceOf('todos')`）
 * 拿到当前会话的待办，因此宿主半不参与数据流。宿主半只做两件浏览器做不到/做不长的事：
 *
 *   1. **窗口几何的服务端副本**：浏览器 localStorage 会被清、会随 profile 走，
 *      换浏览器/清缓存后悬浮窗就回原位了。这里把几何存到 `DSH_HOME/yintxplugins/todo-float/geom.json`，
 *      客户端半启动时本地没有记录就回这里取（本地优先，服务端兜底）。
 *   2. **诊断路由**：`GET /plugin-todo-float/ping` 回答「宿主半挂上了没有、版本多少、几何存在哪」，
 *      客户端半与冒烟测试都靠它确认链路。
 *
 * 路由（都过官方连接信任闸，与合集其它子插件同一道）：
 *   GET  /plugin-todo-float/ping   探活 + 版本 + DSH_HOME/profile + 是否有服务端几何
 *   GET  /plugin-todo-float/geom   { ok, geom, updatedAt } —— 没有记录时 geom 为 null
 *   POST /plugin-todo-float/geom   { geom: {left,top,width,height,maximized,collapsed} } → 落盘
 *
 * 写盘策略：临时文件 + rename 原子替换；任何失败只记警告，绝不影响宿主启动。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { sendJson, sendMethodNotAllowed } from '../../lib/shared/respond.js'

export const name = 'dsh-plugin-todo-float'

/** webServer 是硬依赖（要注册路由）；connection 只用于信任闸，缺席时放行。 */
export const inject = ['webServer']

/** 宿主半版本号（改动功能时同步递增）。 */
const VERSION = '0.1.0'

const ROUTE_PING = '/plugin-todo-float/ping'
const ROUTE_GEOM = '/plugin-todo-float/geom'

/** 几何里允许出现的字段与取值范围（越界值一律夹紧，脏数据不落盘）。 */
const GEOM_FIELDS = {
  left: { min: -100000, max: 100000 },
  top: { min: -100000, max: 100000 },
  width: { min: 120, max: 100000 },
  height: { min: 60, max: 100000 },
}
/** 布尔字段：原样接受 true/false。 */
const GEOM_FLAGS = ['maximized', 'collapsed']

/** DSH_HOME（默认 ~/.dsh）。 */
export function dshHome() {
  return (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
}

/** 几何存档路径：`<DSH_HOME>/yintxplugins/todo-float/geom.json`。 */
export function geomFile(home = dshHome()) {
  return join(home, 'yintxplugins', 'todo-float', 'geom.json')
}

/**
 * 校验并夹紧一份几何：只保留认识的字段，数值夹到合法区间。
 * @param value 待校验的对象
 * @returns {{ ok: true, geom: object } | { ok: false, message: string }}
 */
export function normalizeGeom(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'geom 必须是对象' }
  }
  const geom = {}
  for (const [key, range] of Object.entries(GEOM_FIELDS)) {
    const raw = value[key]
    if (raw === undefined || raw === null) continue
    const num = Number(raw)
    if (!Number.isFinite(num)) return { ok: false, message: `${key} 不是有限数：${String(raw)}` }
    geom[key] = Math.min(range.max, Math.max(range.min, Math.round(num)))
  }
  for (const flag of GEOM_FLAGS) {
    if (typeof value[flag] === 'boolean') geom[flag] = value[flag]
  }
  if (Object.keys(geom).length === 0) return { ok: false, message: 'geom 里没有任何可识别的字段' }
  return { ok: true, geom }
}

/** 读服务端几何；没有或坏了都返回 null（客户端会退回默认位置）。 */
export function readGeom(home = dshHome()) {
  const file = geomFile(home)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const checked = normalizeGeom(parsed?.geom)
    if (!checked.ok) return null
    return { geom: checked.geom, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null }
  } catch {
    return null
  }
}

/**
 * 原子写几何（临时文件 + rename）。目录不存在就建。
 * @returns {{ ok: true, file: string } | { ok: false, message: string }}
 */
export function writeGeom(geom, home = dshHome()) {
  const file = geomFile(home)
  const temp = `${file}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, JSON.stringify({ geom, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    renameSync(temp, file)
    return { ok: true, file }
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {}
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 读请求体（超过 16KB 直接放弃，避免被大请求拖住）。 */
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

  log(`宿主半已激活 v${VERSION}（几何存档 ${geomFile(home)}）`)

  /** 过官方连接信任闸；服务缺失或抛错时放行（与合集其它子插件一致）。 */
  const rejected = (req) => {
    if (!requireTrust) return null
    try {
      const verdict = ctx.connection?.requestRejection?.(req)
      return verdict === undefined || verdict === null ? null : verdict
    } catch {
      return null
    }
  }

  /**
   * 路由表。注意 `/geom` 的读与写在**同一条路由**里按 method 分派：
   * 官方 webServer 按精确路径注册，同路径注册两次会互相覆盖（谁后注册谁生效），
   * 所以一条路径只能挂一个 handler。
   */
  const routes = [
    {
      path: ROUTE_PING,
      allow: 'GET',
      handler: (req, res) => {
        const stored = readGeom(home)
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          version: VERSION,
          dshHome: home,
          geomFile: geomFile(home),
          hasGeom: stored !== null,
          requireTrust,
        })
      },
    },
    {
      path: ROUTE_GEOM,
      allow: 'GET, POST',
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const stored = readGeom(home)
          sendJson(res, 200, { ok: true, geom: stored?.geom ?? null, updatedAt: stored?.updatedAt ?? null })
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
        const checked = normalizeGeom(body.geom)
        if (!checked.ok) {
          sendJson(res, 400, { ok: false, message: checked.message })
          return
        }
        const written = writeGeom(checked.geom, home)
        if (!written.ok) {
          warn(`几何落盘失败：${written.message}`)
          sendJson(res, 500, { ok: false, message: written.message })
          return
        }
        sendJson(res, 200, { ok: true, geom: checked.geom })
      },
    },
  ]

  if (typeof ctx.webServer?.register !== 'function') {
    warn('webServer 不可用，路由没注册')
    return { home, geomFile: geomFile(home), registered: 0 }
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
                // 把 handler 的结果交回调用方（异步 handler 的 promise 也一并冒泡），
                // 同时保证 reject 不会变成未处理拒绝。
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

  return { home, geomFile: geomFile(home), registered }
}

export { VERSION, ROUTE_PING, ROUTE_GEOM }

/**
 * yintxplugins 合集的父 host 半。
 *
 * 它几乎不做业务：**读生成好的行目录（lib/rows.json）+ 提供一个中文状态的只读路由**。
 * 真正的功能都在三个子插件里（open-folder / preset-bridge / link-install），
 * 各自由 `../shell.js` 挂载。
 *
 *   GET /yintx/status → 合集与每个子插件的中文说明、当前是否挂上、有没有降级
 *   GET /yintx/rows   → 活跃行 id 列表（见 shared/health.js）
 *   GET /yintx/degraded → 降级记录
 *   GET /yintx/client/<subpath>.js → 按 clientEntry 读出子插件的**客户端 bundle**
 *
 * 前三条路由是只读状态；最后一条把子插件的**客户端 bundle 原样送出去**——
 * 子插件的包名在 link:/file: 安装下解析不到，浏览器没法按包名 import 它，
 * 官方客户端模块图的每行又只按包名建，所以这条路是客户端半取子插件客户端的**唯一通道**
 * （见 lib/client.js 的「客户端半怎么取到子插件」注释）。
 *
 * 四条路由都走同一道连接信任闸（拿不到信任服务就 503，不放行）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { holdHealthRoutes, jsonRoute } from './shared/health.js'
import { sendJson, sendMethodNotAllowed } from './shared/respond.js'
import { listActiveRows, listDegraded } from './shared/state.js'
import { trustRejectionCode, trustRejectionPayload } from './shared/trust.js'

export const name = 'yintxplugins'

/** 需要 webServer 挂路由；connection 是信任闸。 */
export const inject = ['webServer', 'connection']

export const ROUTE_STATUS = '/yintx/status'

/** 子插件客户端 bundle 的前缀路由；浏览器侧按 `<ROUTE_CLIENT>/<subpath>.js` 取。 */
export const ROUTE_CLIENT = '/yintx/client'

/** 合集包根目录（`lib/index.js` 的上一层）：`clientEntry` 的相对基准。 */
const PACKAGE_ROOT = new URL('../', import.meta.url)

/** 读生成物 lib/rows.json（与 aggregate.json 同源，由 scripts/aggregate.mjs 生成）。 */
export function readCatalog() {
  try {
    const raw = readFileSync(new URL('./rows.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0) return parsed
  } catch (error) {
    console.warn('[yintxplugins] 读 lib/rows.json 失败（跑一次 node scripts/aggregate.mjs）：', error?.message ?? error)
  }
  return { namespace: 'yintx', title: 'yintxplugins 合集', summary: '', rows: [] }
}

/**
 * 把目录 + 实时状态合成一次快照（父路由与客户端半都吃这个形状）。
 * @returns {{ namespace, title, summary, rows: Array, degraded: Array, mounted: string[] }}
 */
export function snapshot() {
  const catalog = readCatalog()
  const mounted = new Set(listActiveRows())
  const degraded = listDegraded()
  const degradedByRow = new Map(degraded.map((item) => [item.row, item]))
  // 账本里出现无法对回目录的键（典型是外壳没拿到行 id 时的 '(no-row)'）说明账本不可信：
  // 客户端半据此退化为「全部挂载」，避免把「账本坏了」误读成「所有子行都被禁用」。
  const subRowIds = new Set(catalog.rows.filter((row) => row.kind === 'sub').map((row) => row.id))
  const ledgerReliable = mounted.size > 0 && [...mounted].every((id) => subRowIds.has(id))
  const rows = catalog.rows.map((row) => {
    const bad = degradedByRow.get(row.id)
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      summary: row.summary,
      kind: row.kind,
      plugin: row.plugin,
      client: row.client === true,
      /** 'self' 行由父半自己承载；子行看账本 */
      mounted: row.kind === 'self' ? true : mounted.has(row.id),
      degraded: bad
        ? { stage: bad.stage, reason: bad.reason, at: bad.at }
        : null,
    }
  })
  return { namespace: catalog.namespace, title: catalog.title, summary: catalog.summary, rows, degraded, mounted: listActiveRows(), ledgerReliable }
}

/**
 * 取出某个子插件的客户端 bundle（`/yintx/client/<subpath>.js`）。
 * 只认 `client: true` 且在 lib/rows.json 里有 `clientEntry` 的行；其余一律 null（→ 404）。
 * @returns {{ row: object, path: string } | null}
 */
export function clientAssetOf(rawUrl) {
  try {
    const pathname = new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname
    if (!pathname.startsWith(ROUTE_CLIENT + '/')) return null
    const name = pathname.slice(ROUTE_CLIENT.length + 1)
    if (!/^[a-z0-9-]+\.js$/.test(name)) return null
    const subpath = name.slice(0, -3)
    const row = readCatalog().rows.find(
      (item) => item.kind === 'sub' && item.client === true && item.subpath === subpath,
    )
    if (row === undefined || typeof row.clientEntry !== 'string') return null
    return { row, path: fileURLToPath(new URL(row.clientEntry, PACKAGE_ROOT)) }
  } catch {
    return null
  }
}

export function apply(ctx) {
  // 健康路由（壳行也会调，引用计数保证只注册一次）
  holdHealthRoutes(ctx)

  const webServer = ctx?.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') {
    console.warn('[yintxplugins] 没有 webServer，/yintx/status 未注册（合集仍可用，只是看不到状态路由）')
    return
  }

  const guard = (req) => trustRejectionCode(ctx?.connection, req)

  try {
    // 与健康路由共用同一套「信任闸 → 405 → JSON」语义（这一份实现只在 shared/health.js）
    webServer.register(jsonRoute(ROUTE_STATUS, () => ({ ok: true, ...snapshot() }), ctx?.connection))
  } catch (error) {
    console.warn('[yintxplugins] 注册 /yintx/status 失败：', error)
  }

  try {
    webServer.register({
      kind: 'prefix',
      path: ROUTE_CLIENT,
      handler: (req, res) => {
        const code = guard(req)
        if (code !== null) {
          sendJson(res, code, trustRejectionPayload(code))
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendMethodNotAllowed(res, 'GET, HEAD')
          return
        }
        const asset = clientAssetOf(req.url)
        if (asset === null) {
          sendJson(res, 404, { ok: false, message: `没有这个子插件的客户端 bundle：${req.url ?? ''}` })
          return
        }
        try {
          const bytes = readFileSync(asset.path)
          res.statusCode = 200
          res.setHeader('content-type', 'text/javascript; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(req.method === 'HEAD' ? undefined : bytes)
        } catch (error) {
          sendJson(res, 404, {
            ok: false,
            message: `读不到 ${asset.row.clientEntry}：${error?.code ?? error?.message ?? error}`,
          })
        }
      },
    })
  } catch (error) {
    console.warn('[yintxplugins] 注册 ' + ROUTE_CLIENT + ' 失败：', error)
  }
}

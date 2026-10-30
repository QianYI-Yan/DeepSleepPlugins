/**
 * 合集的健康路由（读一遍就知道每个子插件到底挂上了没有）：
 *
 *   GET /yintx/rows      → { ok, namespace, rows: [<行 id>...] }
 *   GET /yintx/degraded  → { ok, degraded: [{ row, stage, reason, at }] }
 *
 * 与三个子插件自己的路由（`/plugin-open-folder/*`、`/plugin-local/*`、`/preset-folder/*`）用不同命名空间，
 * 装在一起也不会互相覆盖。
 *
 * 信任闸：和主行一个取向 —— 拿不到连接信任服务就**拒绝**（503），不放行。
 * 引用计数照抄 `@linxin666/dsh-web-all` 的 holdHealthRoutes 语义：只注册一次，
 * 最后一个持有者退出时才摘。
 */
import { sendJson, sendMethodNotAllowed } from './respond.js'
import { listActiveRows, listDegraded, shellState } from './state.js'
import { trustRejectionCode, trustRejectionPayload } from './trust.js'

export const ROUTE_ROWS = '/yintx/rows'
export const ROUTE_DEGRADED = '/yintx/degraded'

/**
 * 「统一 GET JSON 路由」工厂：**信任闸 → 405 → JSON** 三件事只写一遍。
 * 本文件的健康路由与父半的 `/yintx/status` 同构，都用它，免得两份实现各改一半。
 * @param path 路由路径
 * @param payload 返回响应体的函数
 * @param connection 注册时捕获的连接信任服务
 */
export function jsonRoute(path, payload, connection) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const rejection = trustRejectionCode(connection, req)
      if (rejection !== null) {
        sendJson(res, rejection, trustRejectionPayload(rejection))
        return
      }
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      sendJson(res, 200, payload())
    },
  }
}

/**
 * 持有两条健康路由。可安全重复调用：第一次真正注册，之后只加计数。
 * @returns 注销函数（本持有者退出时调用一次）
 */
export function holdHealthRoutes(ctx) {
  const register = (webServer, connection) => {
    if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
    const health = shellState().health
    if (health.count === 0) {
      const disposers = []
      try {
        disposers.push(
          webServer.register(jsonRoute(ROUTE_ROWS, () => ({ ok: true, namespace: 'yintx', rows: listActiveRows() }), connection)),
        )
        disposers.push(
          webServer.register(jsonRoute(ROUTE_DEGRADED, () => ({ ok: true, degraded: listDegraded() }), connection)),
        )
      } catch (error) {
        console.warn('[yintxplugins] 健康路由注册失败：', error)
      }
      health.unregister = () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {}
        }
      }
    }
    health.count += 1
    let released = false
    return () => {
      if (released) return
      released = true
      health.count = Math.max(0, health.count - 1)
      if (health.count === 0) {
        try {
          health.unregister?.()
        } catch {}
        health.unregister = null
      }
    }
  }

  // ① 主行：webServer / connection 已在 inject 里，直接读
  try {
    const webServer = ctx?.webServer
    if (webServer !== undefined) {
      const release = register(webServer, ctx?.connection)
      try {
        ctx.effect?.(() => () => release(), 'yintxplugins: health routes')
      } catch {}
      return release
    }
  } catch {}

  // ② 外壳行（inject = []）：等 webServer + connection 出现再挂，随本 entry 销毁
  try {
    return ctx.inject?.(
      ['webServer', 'connection'],
      (scoped) => (scoped?.webServer === undefined ? undefined : register(scoped.webServer, scoped.connection)),
    )
  } catch {
    return () => {}
  }
}

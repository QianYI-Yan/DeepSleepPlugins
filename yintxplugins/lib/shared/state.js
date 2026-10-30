/**
 * 合集共享状态：行账本（哪些子插件行真的被 loader apply 过）+ 降级记录 + 健康路由的引用计数。
 *
 * 为什么要账本：外壳是「永不失败」的，所以 import/启动失败不会让整组回滚 ——
 * 代价是失败会静默。账本把这类失败显式记下来，客户端与 `/yintx/*` 路由据此展示。
 * 只有「loader 从未 apply」的行（被用户在设置里停用）不进账本。
 */

/** 本进程的账本。合集里所有入口（父半、外壳、健康路由）共用这一份。 */
const state = {
  /** 行 id → { id, at }：本 entry 当前服务的行 */
  active: new Map(),
  /** 行 id → { row, stage, reason, at }：降级记录（同 key 后写覆盖） */
  degraded: new Map(),
  /** 健康路由的引用计数（只注册一次，最后卸载时摘掉） */
  health: { count: 0, unregister: null },
}

export function shellState() {
  return state
}

/** 降级原因最长保留多少字符（避免把整个堆栈塞进 UI）。 */
export const DEGRADED_REASON_MAX = 500

/** 把任意错误整理成一条可读原因。 */
export function failureReason(error, maxLength = DEGRADED_REASON_MAX) {
  const text =
    error === undefined || error === null
      ? '(无原因)'
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/** 记一条活跃行（外壳在挂载前调用）。 */
export function recordActiveRow(id) {
  if (typeof id !== 'string' || id === '') return
  state.active.set(id, { id, at: new Date().toISOString() })
  return true
}

/** 摘掉一条活跃行（外壳卸载时调用）。 */
export function removeActiveRow(id) {
  return state.active.delete(id)
}

/** 活跃行 id 列表（排序后返回，便于断言）。 */
export function listActiveRows() {
  return [...state.active.keys()].sort()
}

/**
 * 记一条降级：某行的真实实现 import/启动失败。
 * @param id    行 id（`yintx-<subpath>`）或说明符
 * @param stage 'import' | 'shape' | 'start' | 'config'
 * @param error 原始错误
 */
export function recordDegraded(id, stage, error) {
  const key = typeof id === 'string' && id !== '' ? id : '(unknown)'
  const entry = {
    row: key,
    stage: String(stage),
    reason: failureReason(error),
    at: new Date().toISOString(),
  }
  state.degraded.set(key, entry)
  return entry
}

/** 清掉一条降级（例如回退加载成功后）。 */
export function clearDegraded(id) {
  return state.degraded.delete(id)
}

/** 降级列表（稳定排序：先按行 id）。 */
export function listDegraded() {
  return [...state.degraded.values()].sort((a, b) => a.row.localeCompare(b.row))
}

/** 测试用：把账本与健康路由计数清空（生产代码不该调它）。 */
export function resetState() {
  state.active.clear()
  state.degraded.clear()
  state.health.count = 0
  state.health.unregister = null
}

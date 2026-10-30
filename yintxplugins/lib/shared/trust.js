/**
 * 连接信任闸：合集所有 `/yintx/*` 路由共用同一道闸。
 *
 * 取向：**拿不到信任服务就拒绝**（503），不放行；信任服务给出拒绝码就原样透传。
 * （三个子插件里 preset-bridge / link-install 也是这一档；open-folder 为了让详情页按钮
 * 不因服务缺失而失效，选择「拿不到就放行」——合集这几条只读路由按更严的那一档来。）
 * 这段逻辑原先在 `lib/index.js`（两处）与 `lib/shared/health.js`（一处）各写了一遍，
 * 现在只有这一份。
 */

/** 拿不到信任服务时用的拒绝码。 */
export const TRUST_UNAVAILABLE = 503

/**
 * 算出这次请求该被拒绝的码。
 * @param connection 宿主注入的连接信任服务（缺失即视为不可用）
 * @param req 原始请求
 * @returns {number|null} 拒绝码；`null` 表示放行
 */
export function trustRejectionCode(connection, req) {
  try {
    if (typeof connection?.requestRejection !== 'function') return TRUST_UNAVAILABLE
    const rejection = connection.requestRejection(req)
    if (rejection === undefined || rejection === null) return null
    const code = Number(rejection)
    return Number.isInteger(code) && code >= 100 && code <= 599 ? code : 403
  } catch {
    return TRUST_UNAVAILABLE
  }
}

/**
 * 被拒绝时统一的响应体。
 * @param code `trustRejectionCode` 给出的拒绝码
 */
export function trustRejectionPayload(code) {
  return {
    ok: false,
    message: code === TRUST_UNAVAILABLE ? '连接信任服务不可用，已拒绝请求' : '已被连接信任服务拒绝',
  }
}

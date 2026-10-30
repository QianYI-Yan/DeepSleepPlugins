/**
 * 路由响应的两个公共动作：统一 JSON（不缓存）与 405。
 * 原先 `lib/index.js` 与 `lib/shared/health.js` 各写了一份 `json()`，现在只有这一份。
 */

/**
 * 送出一个 JSON 响应。
 * @param res 宿主给的响应对象
 * @param status HTTP 状态码
 * @param payload 负载；传 `undefined` 表示只回状态码（无响应体）
 */
export function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload === undefined ? undefined : JSON.stringify(payload))
}

/**
 * 送出一个 405（带 `Allow` 头）。
 * @param res 宿主给的响应对象
 * @param allow `Allow` 头的值，如 `'GET'` 或 `'GET, HEAD'`
 */
export function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

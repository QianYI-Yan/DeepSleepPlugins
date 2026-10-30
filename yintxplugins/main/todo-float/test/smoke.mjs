/**
 * dsh-plugin-todo-float 宿主半冒烟测试：`node test/smoke.mjs`
 *
 * 覆盖：
 *   - 几何校验/夹紧（`normalizeGeom`）与原子落盘/读取（临时 DSH_HOME，不碰真实 ~/.dsh）；
 *   - `apply()` 注册的三条路由：ping / GET geom / POST geom，含 405 与信任闸；
 *   - 缺 webServer 时安静降级（不抛、不注册）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../index.js')
const { normalizeGeom, readGeom, writeGeom, geomFile, apply, name, VERSION } = mod

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error.message}`])
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error.message}`])
  }
}

// ── 假宿主物件 ────────────────────────────────────────────────────────────
function fakeReq({ method = 'GET', url = '/', body, reject } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    __reject: reject,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    resume() {},
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    payload: undefined,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(payload) {
      this.payload = payload
    },
    json() {
      return this.payload === undefined ? undefined : JSON.parse(this.payload)
    },
  }
}

/** 造一个 ctx：注册的路由收进 map，effect 的清理函数收进数组。 */
function fakeCtx({ withWebServer = true, reject } = {}) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    connection: { requestRejection: () => reject },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    webServer: withWebServer
      ? {
          register: ({ path, handler }) => {
            routes.set(path, handler)
            return () => routes.delete(path)
          },
        }
      : undefined,
  }
  return { ctx, routes, disposers }
}

// ── 校验与落盘 ────────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'yintx-todo-float-'))

check('导出形状：包名与版本', () => {
  assert.equal(name, 'dsh-plugin-todo-float')
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})

check('normalizeGeom 接受合法几何并四舍五入', () => {
  const result = normalizeGeom({ left: 10.4, top: 20.6, width: 300, height: 400, maximized: true, collapsed: false })
  assert.equal(result.ok, true)
  assert.deepEqual(result.geom, { left: 10, top: 21, width: 300, height: 400, maximized: true, collapsed: false })
})

check('normalizeGeom 拒绝非对象与空对象', () => {
  assert.equal(normalizeGeom(null).ok, false)
  assert.equal(normalizeGeom('x').ok, false)
  assert.equal(normalizeGeom({}).ok, false)
})

check('normalizeGeom 夹紧越界尺寸并忽略 NaN', () => {
  const small = normalizeGeom({ width: 10, height: 10 })
  assert.equal(small.geom.width, 120)
  assert.equal(small.geom.height, 60)
  assert.equal(normalizeGeom({ left: Number.NaN }).ok, false)
  assert.equal(normalizeGeom({ width: 320 }).geom.left, undefined, '未给的字段不该被编造')
})

check('writeGeom 之前读回 null', () => {
  assert.equal(readGeom(home), null)
})

check('writeGeom 落盘后能读回，且是原子替换（无残留 .tmp）', () => {
  const written = writeGeom({ left: 12, top: 34, width: 300, height: 400 }, home)
  assert.equal(written.ok, true)
  const read = readGeom(home)
  assert.deepEqual(read.geom, { left: 12, top: 34, width: 300, height: 400 })
  assert.match(String(read.updatedAt), /^\d{4}-\d{2}-\d{2}T/)
  const raw = JSON.parse(readFileSync(geomFile(home), 'utf8'))
  assert.equal(raw.geom.width, 300)
  // 临时文件必须已被 rename 掉，不留垃圾
  let leftover = false
  try {
    readFileSync(`${geomFile(home)}.tmp-${process.pid}`, 'utf8')
    leftover = true
  } catch {}
  assert.equal(leftover, false, '不该残留 .tmp 文件')
})

check('坏存档读回 null（不抛）', () => {
  const brokenHome = mkdtempSync(join(tmpdir(), 'yintx-todo-float-broken-'))
  writeGeom({ width: 320 }, brokenHome)
  writeFileSync(geomFile(brokenHome), '{ broken', 'utf8')
  assert.equal(readGeom(brokenHome), null)
  // 结构不对（几何不合法）也算坏存档
  writeFileSync(geomFile(brokenHome), JSON.stringify({ geom: { left: 'nope' } }), 'utf8')
  assert.equal(readGeom(brokenHome), null)
  rmSync(brokenHome, { recursive: true, force: true })
})

// ── 路由 ──────────────────────────────────────────────────────────────────
await checkAsync('apply 注册 ping 与 geom 路由，ping 报告版本与存档路径', async () => {
  const { ctx, routes, disposers } = fakeCtx()
  const info = apply(ctx, { home })
  assert.equal(routes.size, 2, `应注册两条路由（geom 的读写同路），实际 ${routes.size}`)
  assert.equal(info.registered, 2)

  const res = fakeRes()
  await routes.get('/plugin-todo-float/ping')(fakeReq(), res)
  const body = res.json()
  assert.equal(res.statusCode, 200)
  assert.equal(body.plugin, 'dsh-plugin-todo-float')
  assert.equal(body.version, VERSION)
  assert.equal(body.geomFile, geomFile(home))
  assert.equal(typeof body.hasGeom, 'boolean')
  assert.ok(disposers.length >= 1)
})

await checkAsync('GET geom 返回当前存档，POST geom 落盘并回显', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { home })

  const before = fakeRes()
  await routes.get('/plugin-todo-float/geom')(fakeReq(), before)
  assert.equal(before.json().ok, true)
  assert.deepEqual(before.json().geom, { left: 12, top: 34, width: 300, height: 400 })

  const post = fakeRes()
  await routes.get('/plugin-todo-float/geom')(fakeReq({ method: 'POST', body: { geom: { left: 1, top: 2, width: 260, height: 200, collapsed: true } } }), post)
  assert.equal(post.statusCode, 200)
  assert.deepEqual(post.json().geom, { left: 1, top: 2, width: 260, height: 200, collapsed: true })
  assert.deepEqual(readGeom(home).geom, { left: 1, top: 2, width: 260, height: 200, collapsed: true })
})

await checkAsync('POST geom 拒绝非法体（非对象 / 空 geom）', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { home })
  const handler = routes.get('/plugin-todo-float/geom')

  const notObject = fakeRes()
  await handler(fakeReq({ method: 'POST', body: '[]' }), notObject)
  assert.equal(notObject.statusCode, 400)
  assert.match(notObject.json().message, /JSON 对象/)

  const emptyGeom = fakeRes()
  await handler(fakeReq({ method: 'POST', body: { geom: {} } }), emptyGeom)
  assert.equal(emptyGeom.statusCode, 400)

  const badJson = fakeRes()
  await handler(fakeReq({ method: 'POST', body: '{ nope' }), badJson)
  assert.equal(badJson.statusCode, 400)
})

await checkAsync('方法不匹配回 405 + Allow', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { home })
  const res = fakeRes()
  routes.get('/plugin-todo-float/ping')(fakeReq({ method: 'DELETE' }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
})

await checkAsync('信任闸拒绝时直接回状态码、不执行业务', async () => {
  const { ctx, routes } = fakeCtx({ reject: 503 })
  apply(ctx, { home })
  const res = fakeRes()
  await routes.get('/plugin-todo-float/ping')(fakeReq(), res)
  assert.equal(res.statusCode, 503)
  assert.equal(res.payload, undefined)

  const relaxed = fakeCtx({ reject: 503 })
  apply(relaxed.ctx, { home, requireTrust: false })
  const ok = fakeRes()
  await relaxed.routes.get('/plugin-todo-float/ping')(fakeReq(), ok)
  assert.equal(ok.statusCode, 200, 'requireTrust:false 时应放行')
})

check('没有 webServer 时安静降级（返回 registered:0，不抛）', () => {
  const { ctx } = fakeCtx({ withWebServer: false })
  const info = apply(ctx, { home })
  assert.equal(info.registered, 0)
})

rmSync(home, { recursive: true, force: true })

for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed === 0 ? 0 : 1)

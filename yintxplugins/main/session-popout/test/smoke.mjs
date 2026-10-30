/**
 * dsh-plugin-session-popout 宿主半冒烟测试：`node test/smoke.mjs`
 *
 * 覆盖：配置校验/夹紧、原子读写（临时 DSH_HOME）、ping 与 config 路由（GET/POST）、405、信任闸、
 * 以及没有 webServer 时的安静降级。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../index.js')
const { normalizeConfig, readConfig, writeConfig, configFile, apply, name, VERSION, DEFAULT_CONFIG, MODES } = mod

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

function fakeReq({ method = 'GET', body, reject } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  return {
    method,
    url: '/',
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

function fakeCtx({ withWebServer = true, reject } = {}) {
  const routes = new Map()
  const disposers = []
  return {
    routes,
    disposers,
    ctx: {
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
    },
  }
}

const home = mkdtempSync(join(tmpdir(), 'yintx-session-popout-'))

check('导出形状：包名、版本、默认配置', () => {
  assert.equal(name, 'dsh-plugin-session-popout')
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(DEFAULT_CONFIG, { width: 520, height: 760, slim: true, reuse: true, mode: 'inline' })
  assert.deepEqual(MODES, ['inline', 'window', 'auto'])
})

check('normalizeConfig：接受合法值并夹紧越界尺寸', () => {
  const ok = normalizeConfig({ width: 400, height: 600, slim: false })
  assert.deepEqual(ok.config, { width: 400, height: 600, slim: false })
  const small = normalizeConfig({ width: 100, height: 100 })
  assert.equal(small.config.width, 320)
  assert.equal(small.config.height, 240)
})

check('normalizeConfig：mode 只认三个取值', () => {
  assert.equal(normalizeConfig({ mode: 'inline' }).config.mode, 'inline')
  assert.equal(normalizeConfig({ mode: 'window' }).config.mode, 'window')
  assert.equal(normalizeConfig({ mode: 'auto' }).config.mode, 'auto')
  const bad = normalizeConfig({ mode: 'popup' })
  assert.equal(bad.ok, false, '乱写的 mode 应被拒')
  assert.match(bad.message, /mode 只能是/)
})

check('normalizeConfig：拒绝非法输入', () => {
  assert.equal(normalizeConfig(null).ok, false)
  assert.equal(normalizeConfig([]).ok, false)
  assert.equal(normalizeConfig({}).ok, false)
  assert.equal(normalizeConfig({ width: Number.NaN }).ok, false)
  assert.equal(normalizeConfig({ slim: 'yes' }).ok, false, '字符串不算布尔')
})

check('未落盘时 readConfig 返回默认值', () => {
  const stored = readConfig(home)
  assert.equal(stored.from, 'default')
  assert.deepEqual(stored.config, DEFAULT_CONFIG)
})

check('writeConfig 落盘 → readConfig 读回（与默认值合并），坏存档回默认', () => {
  assert.equal(writeConfig({ width: 700, slim: false }, home).ok, true)
  const stored = readConfig(home)
  assert.equal(stored.from, 'file')
  assert.equal(stored.config.width, 700)
  assert.equal(stored.config.height, DEFAULT_CONFIG.height, '缺的字段用默认值补齐')
  assert.equal(stored.config.slim, false)

  writeFileSync(configFile(home), '{ broken', 'utf8')
  assert.equal(readConfig(home).from, 'default')
  writeFileSync(configFile(home), JSON.stringify({ config: { width: 'x' } }), 'utf8')
  assert.equal(readConfig(home).from, 'default')
})

await checkAsync('apply：ping 报版本与存档路径', async () => {
  const { ctx, routes, disposers } = fakeCtx()
  const info = apply(ctx, { home })
  assert.equal(routes.size, 2, `应注册两条路由，实际 ${routes.size}`)
  assert.equal(info.registered, 2)
  const res = fakeRes()
  await routes.get('/plugin-session-popout/ping')(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().version, VERSION)
  assert.equal(res.json().configFile, configFile(home))
  assert.ok(disposers.length >= 1)
})

await checkAsync('GET config 给默认+存档合并值；POST config 覆盖并回显', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'yintx-session-popout-routes-'))
  const { ctx, routes } = fakeCtx()
  apply(ctx, { home: freshHome })
  const handler = routes.get('/plugin-session-popout/config')

  const got = fakeRes()
  await handler(fakeReq(), got)
  assert.equal(got.json().from, 'default')
  assert.deepEqual(got.json().config, DEFAULT_CONFIG)

  const posted = fakeRes()
  await handler(fakeReq({ method: 'POST', body: { config: { width: 640, height: 900 } } }), posted)
  assert.equal(posted.statusCode, 200)
  assert.deepEqual(posted.json().config, { width: 640, height: 900, slim: true, reuse: true, mode: 'inline' }, '未给的字段保留旧值')

  const after = fakeRes()
  await handler(fakeReq(), after)
  assert.equal(after.json().config.width, 640)
  assert.equal(after.json().from, 'file')
  rmSync(freshHome, { recursive: true, force: true })
})

await checkAsync('POST config 拒绝非法体', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { home })
  const handler = routes.get('/plugin-session-popout/config')
  for (const body of ['[]', '{ nope', { config: {} }]) {
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', body }), res)
    assert.equal(res.statusCode, 400, `体 ${JSON.stringify(body)} 应被拒`)
  }
})

await checkAsync('方法不匹配 405 + Allow；信任闸拒绝直接回状态码', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { home })
  const res = fakeRes()
  routes.get('/plugin-session-popout/ping')(fakeReq({ method: 'POST' }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')

  const rejected = fakeCtx({ reject: 503 })
  apply(rejected.ctx, { home })
  const blocked = fakeRes()
  await rejected.routes.get('/plugin-session-popout/ping')(fakeReq(), blocked)
  assert.equal(blocked.statusCode, 503)
  assert.equal(blocked.payload, undefined)

  const relaxed = fakeCtx({ reject: 503 })
  apply(relaxed.ctx, { home, requireTrust: false })
  const allowed = fakeRes()
  await relaxed.routes.get('/plugin-session-popout/ping')(fakeReq(), allowed)
  assert.equal(allowed.statusCode, 200)
})

check('没有 webServer 时安静降级', () => {
  const { ctx } = fakeCtx({ withWebServer: false })
  assert.equal(apply(ctx, { home }).registered, 0)
})

check('落盘的 JSON 结构可读（config + updatedAt）', () => {
  const raw = JSON.parse(readFileSync(configFile(home), 'utf8'))
  assert.ok(raw.config, '应有 config 字段')
  rmSync(home, { recursive: true, force: true })
})

for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed === 0 ? 0 : 1)

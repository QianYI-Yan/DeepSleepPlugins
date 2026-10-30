/**
 * dsh-plugin-open-folder 宿主半冒烟测试：node test/smoke-host.mjs
 * 不需要装进 dsh；`openCommand` 用假的，绝不会真的弹文件管理器。
 *
 * 三类安装来源全部用**临时 DSH_HOME fixture** 造出来，不读这台机器上装了什么
 * —— 原先直接断言真实 profile（依赖 dsh-demo-host-shell 恰好是 link: 安装）会随机器状态飘。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as mod from '../index.js'

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error.message}`])
  }
}

check('包名/注入面', () => {
  assert.equal(mod.name, 'dsh-plugin-open-folder')
  assert.deepEqual(mod.inject, ['webServer'])
  assert.equal(typeof mod.apply, 'function')
})

// ── fixture：临时 DSH_HOME 里造出 link: / file: / npm 三种安装来源 ─────────
const fixtureRoot = mkdtempSync(join(tmpdir(), 'open-folder-fixture-'))
// 目录名就叫 .dsh：和真实布局一致，断言里“路径含 .dsh\plugins”才有意义
const home = join(fixtureRoot, '.dsh')
const profile = 'desktop'
const profileDir = join(home, 'profiles', profile)
const linkSrc = join(fixtureRoot, '.local', 'dsh-demo-host-shell')
const repoDir = join(home, 'plugins', profile, 'dsh-infinite-gen-4')
const npmDir = join(profileDir, 'node_modules', 'dsh-whale-widget')
for (const dir of [linkSrc, repoDir, npmDir]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: basename(dir), version: '1.0.0' }, null, 2) + '\n')
}
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {
        'dsh-demo-host-shell': `link:${linkSrc}`,
        'dsh-infinite-gen-4': 'file:../../plugins/desktop/dsh-infinite-gen-4',
        'dsh-whale-widget': '^0.3.18',
      },
      dsh: { profile: { bundles: [] } },
    },
    null,
    2,
  ) + '\n',
)
// apply() 内部走 dshHome()，所以路由那段也必须读到 fixture
process.env.DSH_HOME = home
console.log(`   fixture DSH_HOME = ${home}`)

check('profile 探测出 desktop（fixture）', () => assert.equal(mod.detectProfile(home), profile))

// ── 三种安装来源 ──────────────────────────────────────────────────────────
const linked = mod.resolvePluginDir('dsh-demo-host-shell', profile, home)
console.log(`   link:          ${linked?.source} → ${linked?.path}`)
check('link: 安装解析到源目录（.local）', () => {
  assert.ok(linked, '没解析出来')
  assert.equal(linked.source, 'link')
  assert.ok(linked.path.toLowerCase().endsWith(join('.local', 'dsh-demo-host-shell').toLowerCase()))
  assert.ok(existsSync(join(linked.path, 'package.json')))
})

const filed = mod.resolvePluginDir('dsh-infinite-gen-4', profile, home)
console.log(`   file:/git:     ${filed?.source} → ${filed?.path}`)
check('file: 安装解析到仓库目录', () => {
  assert.ok(filed, '没解析出来')
  assert.ok(filed.path.toLowerCase().includes(join('.dsh', 'plugins').toLowerCase()))
  assert.ok(existsSync(join(filed.path, 'package.json')))
})

const npmd = mod.resolvePluginDir('dsh-whale-widget', profile, home)
console.log(`   npm:           ${npmd?.source} → ${npmd?.path}`)
check('npm 安装解析到 node_modules 里的真身', () => {
  assert.ok(npmd, '没解析出来')
  assert.equal(npmd.source, 'node_modules')
  assert.ok(existsSync(join(npmd.path, 'package.json')))
})

const missing = mod.resolvePluginDir('dsh-plugin-open-folder', profile, home)
console.log(`   本插件自身:     ${missing?.source ?? '未安装'} → ${missing?.path ?? '(还没装，符合预期)'}`)

check('非法包名一律拒绝', () =>
  ['', '  ', '../evil', 'a/b/c', '@scope', 'x y', 'a\\b'].forEach((bad) =>
    assert.equal(mod.resolvePluginDir(bad, profile, home), null, `不该解析出 ${bad}`)))

check('不存在的包 → null', () => assert.equal(mod.resolvePluginDir('zzz-not-a-package', profile, home), null))

// ── 路由 ──────────────────────────────────────────────────────────────────
const routes = []
const opened = []
const ctx = {
  logger: { info() {}, warn() {} },
  webServer: { register: (opts) => (routes.push(opts), () => {}) },
  effect: (fn) => fn(),
  connection: {},
}
mod.apply(ctx, { profile, openCommand: (dir) => opened.push(dir) })

check('注册了 3 条路由', () => assert.equal(routes.length, 3))
check('路由路径正确', () =>
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    ['/plugin-open-folder/open', '/plugin-open-folder/ping', '/plugin-open-folder/resolve'],
  ))

const byPath = (p) => routes.find((r) => r.path === p)

/** 调一条路由。 */
const call = (path, method, { body, query } = {}) =>
  new Promise((resolve) => {
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = {
      method,
      url: `/plugin-open-folder/${path}${query ? `?${query}` : ''}`,
      async *[Symbol.asyncIterator]() {
        for (const c of raw) yield c
      },
      resume() {},
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(payload) {
        resolve({ status: this.statusCode, headers: this.headers, body: payload ? JSON.parse(payload) : null })
      },
    }
    void byPath(`/plugin-open-folder/${path}`).handler(req, res)
  })

const ping = await call('ping', 'GET')
check('GET /ping → 200 且报告 profile', () => {
  assert.equal(ping.status, 200)
  assert.equal(ping.body.ok, true)
  assert.equal(ping.body.profile, profile)
})

const resolveOk = await call('resolve', 'GET', { query: 'name=dsh-demo-host-shell' })
check('GET /resolve 命中 → 200 且带路径与来源', () => {
  assert.equal(resolveOk.status, 200)
  assert.equal(resolveOk.body.ok, true)
  assert.equal(resolveOk.body.source, 'link')
  assert.equal(resolveOk.body.opened, false)
  assert.ok(resolveOk.body.path.includes('dsh-demo-host-shell'))
})

const resolveBad = await call('resolve', 'GET', { query: 'name=..%2F..%2Fevil' })
check('GET /resolve 非法包名 → 400', () => assert.equal(resolveBad.status, 400))

const resolveMissing = await call('resolve', 'GET', { query: 'name=zzz-nope' })
check('GET /resolve 找不到 → 404', () => assert.equal(resolveMissing.status, 404))

const openOk = await call('open', 'POST', { body: { name: 'dsh-demo-host-shell' } })
check('POST /open → 200 且调用打开动作', () => {
  assert.equal(openOk.status, 200)
  assert.equal(openOk.body.opened, true)
  assert.equal(opened.length, 1)
  assert.ok(opened[0].includes('dsh-demo-host-shell'))
})

const openMissingName = await call('open', 'POST', { body: {} })
check('POST /open 缺 name → 400', () => assert.equal(openMissingName.status, 400))

const openWrongMethod = await call('open', 'GET')
check('GET /open → 405 且带 Allow', () => {
  assert.equal(openWrongMethod.status, 405)
  assert.equal(openWrongMethod.headers.allow, 'POST')
})

const openBadJson = await call('open', 'POST', { body: { name: '..\\evil' } })
check('POST /open 非法包名 → 400', () => assert.equal(openBadJson.status, 400))

// 信任闸：connection 拒绝时应原样返回状态码
const routes2 = []
mod.apply(
  {
    logger: { info() {}, warn() {} },
    webServer: { register: (opts) => (routes2.push(opts), () => {}) },
    effect: (fn) => fn(),
    connection: { requestRejection: () => 403 },
  },
  { profile, openCommand: () => {} },
)
const rejectedCall = await new Promise((resolve) => {
  const req = { method: 'GET', url: '/plugin-open-folder/ping', async *[Symbol.asyncIterator]() {}, resume() {} }
  const res = {
    statusCode: 0,
    setHeader() {},
    end() {
      resolve(this.statusCode)
    },
  }
  void routes2.find((r) => r.path === '/plugin-open-folder/ping').handler(req, res)
})
check('信任闸拒绝 → 原样返回 403', () => assert.equal(rejectedCall, 403))

// 收尾：把 fixture 和它带来的环境变量收拾干净
rmSync(fixtureRoot, { recursive: true, force: true })
delete process.env.DSH_HOME

for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

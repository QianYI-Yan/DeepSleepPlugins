/**
 * yintxplugins 合集自测（零依赖，纯 Node）：
 *   node test/smoke.mjs
 *
 * 断言的是**行为**，不是文案：
 *   · 清单合法、生成物与清单一致（生成器内存输出 vs 磁盘产物）
 *   · package.json 的 exports / dsh 字段 / 依赖齐全
 *   · 外壳能挂上三个真实子插件；同名解析失败走 fallback；import/启动失败只记降级
 *   · 健康路由与 /yintx/status 的信任闸（没有 connection 必须 503）
 *   · 客户端目录与 lib/rows.json 同源（id/name/subpath/plugin/client 必须一致；文案只在 /yintx/status）
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_URL = new URL('../', import.meta.url).href
const results = []
function check(label, fn) {
  try {
    fn()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error?.message ?? error}`])
  }
}
async function checkAsync(label, fn) {
  try {
    await fn()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error?.message ?? error}`])
  }
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(read(rel))

const manifest = readJson('aggregate.json')
const pkg = readJson('package.json')
const rows = readJson('lib/rows.json')
const generator = await import(pathToFileURL(join(ROOT, 'scripts', 'aggregate.mjs')).href)
const shell = await import(pathToFileURL(join(ROOT, 'lib', 'shell.js')).href)
const state = await import(pathToFileURL(join(ROOT, 'lib', 'shared', 'state.js')).href)
const health = await import(pathToFileURL(join(ROOT, 'lib', 'shared', 'health.js')).href)

// ── 假 ctx：忠实模拟 cordis 的最小面 ──────────────────────────────────────────
function fakeCtx({ withWebServer = true, withConnection = true, connectionVerdict = null } = {}) {
  const routes = []
  const mounts = []
  const effects = []
  const listeners = new Map()
  const ctx = {
    webServer: withWebServer
      ? {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index !== -1) routes.splice(index, 1)
            }
          },
        }
      : undefined,
    connection: withConnection
      ? {
          requestRejection() {
            return connectionVerdict
          },
        }
      : undefined,
    plugin(plugin, config) {
      mounts.push({ plugin, config })
      if (typeof plugin === 'function') plugin(ctx, config)
      else if (plugin && typeof plugin.apply === 'function') plugin.apply(ctx, config)
      return { dispose: () => {} }
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    on(event, fn) {
      listeners.set(event, fn)
    },
    inject(_deps, fn) {
      return fn ? fn(ctx) : () => {}
    },
    routes,
    mounts,
    effects,
    listeners,
  }
  return ctx
}

/** 假 req/res：读出状态码与 JSON body。 */
function fakeReqRes(method = 'GET', url = '/yintx/status') {
  const out = { statusCode: 0, headers: {}, body: '' }
  const res = {
    set statusCode(value) {
      out.statusCode = value
    },
    get statusCode() {
      return out.statusCode
    },
    setHeader(name, value) {
      out.headers[name.toLowerCase()] = value
    },
    end(body) {
      out.body = Buffer.isBuffer(body) ? body.toString('utf8') : (body ?? '')
    },
  }
  return { req: { method, url }, res, out }
}

// ── ① 清单与 package.json ────────────────────────────────────────────────────
check('aggregate.json 通过自身校验', () => {
  assert.deepEqual(generator.validate(manifest), [])
})
check('每个子插件都带中文标题与说明', () => {
  // 数字不写死：合集会长，断言的是「每条规则成立」，不是「现在是三个」。
  assert.ok(manifest.plugins.length >= 3, `至少要有三个子插件，实际 ${manifest.plugins.length}`)
  for (const item of manifest.plugins) {
    assert.match(item.title, /[\u4e00-\u9fa5]/, `${item.subpath} 标题应含中文`)
    assert.match(item.summary, /[\u4e00-\u9fa5]/, `${item.subpath} 说明应含中文`)
    assert.match(item.fallback, /^\.\/main\//, `${item.subpath} 的兜底路径应指向包内 main/`)
  }
})
check('带客户端半的行必须给出 clientEntry（同仓相对路径）', () => {
  const withClient = manifest.plugins.filter((item) => item.client === true)
  // 名单不写死（增删客户端半不用回来改这里）：用「集合非空 + 只有 client: true 的行才能带
  // clientEntry」这两条规则保住断言力度，避免退化成「和空数组比也通过」。
  assert.ok(withClient.length >= 1, '至少要有一行带客户端半，否则这条断言等于空转')
  for (const item of withClient) {
    assert.match(item.clientEntry, /^\.\/main\/.*\/client\.js$/, `${item.subpath} 的 clientEntry 应是包内子插件客户端 bundle`)
  }
  for (const item of manifest.plugins) {
    if (item.client !== true) assert.equal(item.clientEntry, undefined, `${item.subpath} 没有客户端半，不该写 clientEntry`)
  }
})
check('clientEntry 指向真实存在、且注册 id 就是子插件包名的 bundle', () => {
  assert.deepEqual(generator.checkClientEntries(manifest), [])
})
check('父插件介绍是中文（package.json description）', () => {
  assert.match(pkg.description, /^yintxplugins 合集：/)
  assert.match(pkg.description, /[\u4e00-\u9fa5]{10,}/)
  assert.match(pkg.name, /^yintxplugins$/)
  assert.equal(pkg.private, true)
})
check('exports 覆盖父半 / 客户端半 / 外壳 / 每个子路径 / 包内实现 / rows', () => {
  const keys = new Set(Object.keys(pkg.exports))
  // 固定几条：合集自己的门面。
  for (const fixed of ['.', './client', './package.json', './rows', './shell']) {
    assert.ok(keys.has(fixed), `exports 缺 ${fixed}`)
  }
  // 其余按清单同源推导：每加一个子插件，必须同时给出子路径外壳与双语 locale，
  // 否则官方插件列表里那一行会没有名字/说明，或 loader 解析不到外壳。
  for (const item of manifest.plugins) {
    assert.ok(keys.has(`./${item.subpath}`), `exports 缺 ./${item.subpath}`)
    assert.equal(pkg.exports[`./${item.subpath}`].default, './lib/shells/shell.js', `${item.subpath} 应指向薄壳`)
    for (const lang of ['en', 'zh']) {
      const localeKey = `./${item.subpath}/locale/${lang}.json`
      assert.ok(keys.has(localeKey), `exports 缺 ${localeKey}`)
      assert.ok(existsSync(join(ROOT, pkg.exports[localeKey])), `${localeKey} 指向的 locale 文件应存在`)
    }
    assert.ok(existsSync(join(ROOT, item.fallback)), `${item.subpath} 的包内实现应存在：${item.fallback}`)
  }
  // 包名本身不该被当子路径导出（exports 里不留无关键）
  assert.equal(keys.has('./yintxplugins'), false)
})
check('dsh 字段：bundle.patch + 客户端半 web', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.engines.dsh.includes('0.2.0'))
})
check('自包含：不再声明外部子插件依赖', () => {
  const deps = pkg.dependencies ?? {}
  for (const name of ['dsh-plugin-open-folder', 'dsh-preset-bridge', 'dsh-plugin-link-install']) {
    assert.equal(deps[name], undefined, `${name} 不该再出现在 dependencies（代码已进包内 main/，合集自包含）`)
  }
  // 代码全在包内 main/，所以合集应当**零运行时依赖**；这条空表断言让「自包含」契约真正生效
  // （原先只遍历 dependencies，该字段不存在时循环一次都不跑，等于没测）。
  assert.deepEqual(Object.keys(deps), [], '合集应零运行时依赖')
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), [], '合集自测也零依赖（纯 Node）')
})

// ── ② 生成物与清单一致 ───────────────────────────────────────────────────────
check('cordis.patch.yml == 生成器输出', () => {
  const { patch } = generator.build()
  assert.equal(read('cordis.patch.yml'), patch, '生成物与清单不一致，请跑 node scripts/aggregate.mjs')
})
check('lib/rows.json == 生成器输出', () => {
  const { rows: rendered } = generator.build()
  assert.equal(read('lib/rows.json'), rendered, '生成物与清单不一致，请跑 node scripts/aggregate.mjs')
})
check('rows.json 带 subpath / clientEntry（客户端 bundle 路由按它读盘）', () => {
  for (const item of manifest.plugins) {
    const row = rows.rows.find((entry) => entry.id === `yintx-${item.subpath}`)
    assert.ok(row, `rows.json 缺少 yintx-${item.subpath}`)
    assert.equal(row.subpath, item.subpath)
    assert.equal(row.clientEntry, item.clientEntry, '两边的 clientEntry 必须同源')
  }
})
check('patch 里三行子插件 + 主行，id 带命名空间', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /- id: yintx-self\n\s+name: 'yintxplugins'/)
  for (const item of manifest.plugins) {
    assert.match(patch, new RegExp(`- id: yintx-${item.subpath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s+name: 'yintxplugins/${item.subpath}'`))
    assert.match(patch, new RegExp(`fallback: ${item.fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
  assert.match(patch, /AUTO-GENERATED/)
})

// ── ③ 薄壳与外壳导出 ────────────────────────────────────────────────────────
await checkAsync('薄壳再导出外壳的全部入口', async () => {
  const thin = await import(pathToFileURL(join(ROOT, 'lib', 'shells', 'shell.js')).href)
  assert.equal(typeof thin.apply, 'function')
  assert.equal(thin.name, shell.name)
  assert.deepEqual(thin.inject, [])
  assert.equal(thin.loadImpl, shell.loadImpl)
})
check('外壳不 inject 任何服务（必须在任何东西之前激活）', () => {
  assert.deepEqual(shell.inject, [])
})
check('implConfigOf 剥掉外壳字段、保留实现配置', () => {
  assert.deepEqual(shell.implConfigOf({ plugin: 'x', fallback: 'y', mode: 'copy' }), { mode: 'copy' })
  assert.deepEqual(shell.implConfigOf(null), {})
})

// ── ④ 外壳挂载三个真实子插件 ────────────────────────────────────────────────
await checkAsync('三行都能挂上真实子插件（走 fallback 相对路径）', async () => {
  for (const item of manifest.plugins) {
    state.resetState()
    const ctx = fakeCtx()
    await shell.apply(ctx, { id: `${manifest.namespace}-${item.subpath}`, plugin: item.plugin, fallback: item.fallback })
    assert.equal(ctx.mounts.length, 1, `${item.subpath} 应挂载一次`)
    const mountedPlugin = ctx.mounts[0].plugin
    const mountedName = mountedPlugin?.name ?? mountedPlugin?.default?.name
    assert.equal(mountedName, item.plugin, `${item.subpath} 挂的应是 ${item.plugin}`)
    assert.ok(state.listActiveRows().includes(`yintx-${item.subpath}`), `${item.subpath} 应进活跃账本`)
    assert.deepEqual(state.listDegraded(), [], `${item.subpath} 不该有降级`)
  }
  state.resetState()
})
await checkAsync('同名解析失败 → 走 fallback 不算降级，但要警告', async () => {
  state.resetState()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const ctx = fakeCtx()
    await shell.apply(ctx, { id: 'yintx-open-folder', plugin: 'definitely-not-an-installed-package-xyz', fallback: './main/plugin-open-folder/index.js' })
    assert.equal(ctx.mounts.length, 1)
    assert.deepEqual(state.listDegraded(), [], '兜底成功不应记为降级')
    assert.ok(warnings.some((line) => line.includes('已回退到')), '应留下一条回退警告')
  } finally {
    console.warn = originalWarn
    state.resetState()
  }
})
await checkAsync('import 失败（无 fallback）→ 记降级且不抛', async () => {
  state.resetState()
  const ctx = fakeCtx()
  await shell.apply(ctx, { id: 'yintx-missing', plugin: 'definitely-not-an-installed-package-xyz' })
  assert.equal(ctx.mounts.length, 0, '不该挂任何东西')
  const degraded = state.listDegraded()
  assert.equal(degraded.length, 1)
  assert.equal(degraded[0].row, 'yintx-missing')
  assert.equal(degraded[0].stage, 'import')
  assert.ok(degraded[0].reason.length > 0)
  state.resetState()
})
await checkAsync('启动失败（apply 抛错）→ 记降级且不抛', async () => {
  state.resetState()
  const ctx = fakeCtx()
  // fallback 相对**合集包根**，所以是 ./test/fixtures/boom.js
  await shell.apply(ctx, { id: 'yintx-boom', plugin: 'definitely-not-an-installed-package-xyz', fallback: './test/fixtures/boom.js' })
  const degraded = state.listDegraded()
  assert.equal(degraded.length, 1, '应有一条降级')
  assert.equal(degraded[0].stage, 'start')
  assert.match(degraded[0].reason, /故意抛错/)
  state.resetState()
})
await checkAsync('行 id 缺失时退化为实现名，账本仍有记录', async () => {
  state.resetState()
  const ctx = fakeCtx()
  await shell.apply(ctx, { plugin: 'dsh-plugin-preset-bridge-x', fallback: './main/preset-bridge/index.js' })
  assert.ok(state.listActiveRows().includes('dsh-plugin-preset-bridge-x'))
  state.resetState()
})

// ── ⑤ 健康路由与父路由的信任闸 ──────────────────────────────────────────────
await checkAsync('健康路由：注册 /yintx/rows 与 /yintx/degraded，放行时 200', async () => {
  state.resetState()
  const ctx = fakeCtx()
  health.holdHealthRoutes(ctx)
  const paths = ctx.routes.map((route) => route.path).sort()
  assert.deepEqual(paths, ['/yintx/degraded', '/yintx/rows'])
  for (const route of ctx.routes) {
    const { req, res, out } = fakeReqRes()
    await route.handler(req, res)
    assert.equal(out.statusCode, 200, `${route.path} 应 200`)
    assert.equal(JSON.parse(out.body).ok, true)
  }
})
await checkAsync('健康路由：没有 connection → 503（失败即拒绝）', async () => {
  state.resetState()
  const ctx = fakeCtx({ withConnection: false })
  health.holdHealthRoutes(ctx)
  assert.equal(ctx.routes.length, 2, '本用例必须真的注册到路由，否则是假通过')
  for (const route of ctx.routes) {
    const { req, res, out } = fakeReqRes()
    await route.handler(req, res)
    assert.equal(out.statusCode, 503, `${route.path} 没有信任服务时必须 503`)
    assert.equal(JSON.parse(out.body).ok, false)
  }
})
await checkAsync('健康路由：信任服务给出拒绝码 → 透传', async () => {
  state.resetState()
  const ctx = fakeCtx({ connectionVerdict: 403 })
  health.holdHealthRoutes(ctx)
  assert.equal(ctx.routes.length, 2, '本用例必须真的注册到路由')
  const { req, res, out } = fakeReqRes()
  await ctx.routes[0].handler(req, res)
  assert.equal(out.statusCode, 403)
})
await checkAsync('引用计数：多次持有只注册一次，全部释放后摘掉', async () => {
  state.resetState()
  const ctx = fakeCtx()
  const releaseA = health.holdHealthRoutes(ctx)
  const releaseB = health.holdHealthRoutes(ctx)
  assert.equal(ctx.routes.length, 2, '只应注册两条路由')
  releaseA()
  assert.equal(ctx.routes.length, 2, '还有持有者时不该摘')
  releaseB()
  assert.equal(ctx.routes.length, 0, '最后一个持有者退出后应摘掉')
})
await checkAsync('/yintx/status：放行时返回中文目录与挂载状态', async () => {
  state.resetState()
  state.recordActiveRow('yintx-open-folder')
  state.recordDegraded('yintx-link-install', 'import', new Error('模拟缺失'))
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  assert.deepEqual(index.inject.slice(0, 2), ['webServer', 'connection'])
  const ctx = fakeCtx()
  index.apply(ctx)
  const route = ctx.routes.find((item) => item.path === '/yintx/status')
  assert.ok(route, '/yintx/status 应被注册')
  const { req, res, out } = fakeReqRes()
  await route.handler(req, res)
  assert.equal(out.statusCode, 200)
  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, true)
  assert.match(payload.title, /yintxplugins/)
  assert.equal(payload.rows.length, manifest.plugins.length + 1, 'self + 每个子插件各一行')
  const self = payload.rows.find((row) => row.kind === 'self')
  assert.equal(self.mounted, true)
  const openFolder = payload.rows.find((row) => row.id === 'yintx-open-folder')
  assert.equal(openFolder.mounted, true)
  const linkInstall = payload.rows.find((row) => row.id === 'yintx-link-install')
  assert.equal(linkInstall.degraded.stage, 'import')
  state.resetState()
})
await checkAsync('/yintx/status：没有信任服务 → 503', async () => {
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const ctx = fakeCtx({ withConnection: false })
  index.apply(ctx)
  const route = ctx.routes.find((item) => item.path === '/yintx/status')
  const { req, res, out } = fakeReqRes()
  await route.handler(req, res)
  assert.equal(out.statusCode, 503)
})

// ── ⑤b 客户端 bundle 路由（浏览器侧按它把子插件的客户端半拉进来） ─────────────
await checkAsync('/yintx/client/<subpath>.js：原样送出子插件的客户端 bundle', async () => {
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const ctx = fakeCtx()
  index.apply(ctx)
  const route = ctx.routes.find((item) => item.path === index.ROUTE_CLIENT)
  assert.ok(route, `应注册 ${index.ROUTE_CLIENT} 路由`)
  assert.equal(route.kind, 'prefix', '按前缀注册（一个路由服务所有子插件）')
  const clientRows = rows.rows.filter((item) => item.kind === 'sub' && item.client === true)
  // 不写死个数：rows.json（生成物）里带客户端半的行，必须与 aggregate.json（唯一事实来源）
  // 声明的名单完全一致 —— 这条是两处清单的交叉约束，不会退化成空转。
  assert.deepEqual(
    clientRows.map((row) => row.subpath).sort(),
    manifest.plugins.filter((item) => item.client === true).map((item) => item.subpath).sort(),
    'rows.json 与 aggregate.json 的客户端半名单必须一致',
  )
  assert.ok(clientRows.length >= 1, '本用例要覆盖所有带客户端半的子插件（空集等于没测）')
  for (const row of clientRows) {
    const { req, res, out } = fakeReqRes('GET', `${index.ROUTE_CLIENT}/${row.subpath}.js`)
    route.handler(req, res)
    assert.equal(out.statusCode, 200, `${row.subpath} 应 200`)
    assert.match(out.headers['content-type'], /javascript/, '必须以 JS 送出（浏览器当模块导入）')
    assert.equal(out.body, readFileSync(join(ROOT, row.clientEntry), 'utf8'), '必须原样送出（子插件源码是唯一事实来源）')
  }
  // HEAD 只走一遍头部，不带 body
  const head = fakeReqRes('HEAD', `${index.ROUTE_CLIENT}/open-folder.js`)
  route.handler(head.req, head.res)
  assert.equal(head.out.statusCode, 200)
  assert.equal(head.out.body, '')
})
await checkAsync('/yintx/client：未知名字 404、非 GET/HEAD 405', async () => {
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const ctx = fakeCtx()
  index.apply(ctx)
  const route = ctx.routes.find((item) => item.path === index.ROUTE_CLIENT)
  // 「不存在的名字」从清单推导：挑一个保证不是任何真行 subpath 的名字（万一撞了就继续加后缀），
  // 免得写死的假名字哪天变成真有的行、又踩一次（原先是写死的 '/yintx/client/not-a-row.js'）。
  const knownSubpaths = new Set(rows.rows.filter((item) => item.kind === 'sub').map((item) => item.subpath))
  let ghost = 'not-a-row'
  while (knownSubpaths.has(ghost)) ghost += '-x'
  const notServed = [`${index.ROUTE_CLIENT}/${ghost}.js`, `${index.ROUTE_CLIENT}/open-folder.txt`]
  // 「存在、但没有客户端半」的行也一律 404 —— 名单同样从清单推导
  for (const row of rows.rows.filter((item) => item.kind === 'sub' && item.client !== true)) {
    notServed.push(`${index.ROUTE_CLIENT}/${row.subpath}.js`)
  }
  for (const bad of notServed) {
    const { req, res, out } = fakeReqRes('GET', bad)
    route.handler(req, res)
    assert.equal(out.statusCode, 404, `${bad} 应 404（没有客户端半的行不给读）`)
  }
  const { req, res, out } = fakeReqRes('POST', `${index.ROUTE_CLIENT}/open-folder.js`)
  route.handler(req, res)
  assert.equal(out.statusCode, 405)
  assert.equal(out.headers.allow, 'GET, HEAD')
})
await checkAsync('/yintx/client：没有信任服务 → 503（不放行）', async () => {
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const ctx = fakeCtx({ withConnection: false })
  index.apply(ctx)
  const route = ctx.routes.find((item) => item.path === index.ROUTE_CLIENT)
  const { req, res, out } = fakeReqRes('GET', `${index.ROUTE_CLIENT}/open-folder.js`)
  route.handler(req, res)
  assert.equal(out.statusCode, 503)
})

// ── ⑥ 客户端半（经典脚本 bundle）与 rows.json 同源 ──────────────────────────
//
// 客户端 bundle 是**经典脚本**：它执行时只调一次 window.__ModuleLoader__.load({id, factory})
// 注册自己（exports["./client"] 的文件被官方 loader 当 classic script 直接执行）。
// 所以这里用 window 桩接住注册，再自己把 factory(require) 跑出来当模块用——
// 与子插件自己的客户端冒烟测试同一套做法。
let capturedRegistration
async function loadClientRegistration() {
  if (capturedRegistration === undefined) {
    const captured = []
    const previousWindow = globalThis.window
    globalThis.window = { __ModuleLoader__: { load: (registration) => captured.push(registration) } }
    try {
      await import(pathToFileURL(join(ROOT, 'lib', 'client.js')).href)
    } finally {
      globalThis.window = previousWindow
    }
    assert.equal(captured.length, 1, '客户端 bundle 应当只注册一次')
    capturedRegistration = captured[0]
  }
  return capturedRegistration
}
/** 客户端半的导出（factory 的返回值）；requireStub 模拟浏览器侧的模块表。 */
async function clientExports(requireStub = () => { throw new Error('（测试）没有模块表') }) {
  const registration = await loadClientRegistration()
  return registration.factory(requireStub)
}

check('客户端 bundle 是经典脚本形状（无 import/export 语句）', () => {
  const text = read('lib/client.js')
  assert.doesNotMatch(
    text,
    /^[ \t]*(?:import|export)[\s{]/m,
    '经典脚本里出现 import/export 语句会让整段 combo 解析失败（Unexpected token），必须去掉',
  )
  assert.match(text, /window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(/, '必须先注册 factory')
})
await checkAsync('拼进官方 combo 后仍是合法经典脚本（前一个 bundle 没留分号也不炸）', async () => {
  const vm = await import('node:vm')
  const glued = 'window.__yintxPrev = (function () { return {} })()\n' + read('lib/client.js')
  assert.doesNotThrow(() => new vm.Script(glued, { filename: 'combo.js' }), 'combo 拼接后必须能解析')
})
await checkAsync('注册 id 就是包名（官方客户端模块图按包名建行认领这条 entry）', async () => {
  const registration = await loadClientRegistration()
  assert.equal(registration.id, pkg.name)
  assert.equal(typeof registration.factory, 'function')
})
await checkAsync('子插件的客户端 bundle 能被当 ESM 导入并注册（合集按包名 require 它的前提）', async () => {
  for (const item of manifest.plugins.filter((row) => row.client === true)) {
    const captured = []
    const previousWindow = globalThis.window
    globalThis.window = { __ModuleLoader__: { load: (registration) => captured.push(registration) } }
    try {
      await import(pathToFileURL(join(ROOT, item.clientEntry)).href)
    } finally {
      globalThis.window = previousWindow
    }
    assert.equal(captured.length, 1, `${item.subpath} 的 bundle 应注册一次`)
    assert.equal(captured[0].id, item.plugin, '注册 id 必须就是包名（客户端半按包名 require 回来）')
    assert.equal(typeof captured[0].factory, 'function', `${item.subpath} 应给出 factory`)
  }
})
await checkAsync('客户端目录与 rows.json 同源（结构字段一致，文案不硬编码）', async () => {
  const client = await clientExports()
  assert.deepEqual(client.inject, [])
  const subRows = rows.rows.filter((row) => row.kind === 'sub')
  assert.equal(client.CATALOG.length, subRows.length)
  for (const row of subRows) {
    const found = client.CATALOG.find((item) => item.id === row.id)
    assert.ok(found, `客户端目录缺少 ${row.id}`)
    assert.equal(found.name, row.name, `${row.id} 的 name 与 rows.json 不一致`)
    assert.equal(found.subpath, row.subpath, `${row.id} 的 subpath 与 rows.json 不一致`)
    assert.equal(found.plugin, row.plugin, `${row.id} 的包名与 rows.json 不一致`)
    assert.equal(found.client, row.client === true, `${row.id} 的 client 标记与 rows.json 不一致`)
    assert.equal(found.title, undefined, `${row.id} 不该在客户端硬编码标题（文案只从 /yintx/status 取）`)
    assert.equal(found.summary, undefined, `${row.id} 不该在客户端硬编码说明`)
  }
  assert.match(client.INTRO.title, /yintxplugins/)
  assert.match(client.INTRO.summary, /[\u4e00-\u9fa5]{6,}/)
})
await checkAsync('客户端目录每项都带 subpath（缺了会把脚本 URL 拼成 undefined.js）', async () => {
  const client = await clientExports()
  const withClient = client.CATALOG.filter((item) => item.client === true)
  // 不写死个数：客户端目录里「带客户端半」的包名集合，必须与清单声明的集合完全一致
  // （CATALOG 里没有 clientEntry 字段，所以只比包名，不比路径）
  const declared = manifest.plugins.filter((row) => row.client === true).map((row) => row.plugin).sort()
  assert.ok(declared.length >= 1, '至少要有一行带客户端半，否则这条断言等于空转')
  assert.deepEqual(withClient.map((item) => item.plugin).sort(), declared, 'CATALOG 带客户端半的名单必须与清单一致')
  for (const row of withClient) {
    assert.equal(typeof row.subpath, 'string', `${row.id} 缺 subpath`)
    assert.equal(client.clientScriptUrl(row), `/yintx/client/${row.subpath}.js`)
  }
})
await checkAsync('客户端半：没有可用席位时安静退出，不抛', async () => {
  const client = await clientExports()
  await client.apply({ get: () => undefined })
})
await checkAsync('客户端半：子插件客户端半挂不上也只是警告（不抛、不阻断）', async () => {
  const client = await clientExports()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    // 模块表里既没有注册过的子插件、也取不到 /yintx/client/*.js（测试环境没有 webServer）→ 走警告分支
    await client.apply({ get: () => undefined, plugin: () => ({ dispose: () => {} }) })
    assert.ok(warnings.some((line) => line.includes('未能由合集挂载')), '应留下客户端半未挂载的警告')
  } finally {
    console.warn = originalWarn
  }
})
await checkAsync('客户端半：子插件已单独安装（模块表里已注册）→ 直接挂，不再拉脚本', async () => {
  const mountedNames = []
  const stub = (spec) => {
    const item = manifest.plugins.find((row) => row.plugin === spec)
    if (item === undefined) throw new Error(`模块表里没有 ${spec}`)
    return { name: spec, inject: [], apply: () => mountedNames.push(spec) }
  }
  const client = await clientExports(stub)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const ctx = { get: () => undefined, plugin: (plugin) => mountedNames.push(plugin.name) }
    // 期望名单与顺序都从清单推导（客户端目录的顺序 = 清单顺序），不写死具体是哪几个；
    // 另有「挂载数 === 期望数」这条独立约束，所以「一个都没挂上」不会被放过。
    const expected = manifest.plugins.filter((row) => row.client === true).map((row) => row.plugin)
    assert.ok(expected.length >= 1, '至少要有一行带客户端半，否则这条断言等于空转')
    // 直接调挂载逻辑（apply 会顺带探测席位与状态路由，掺进来不好断言）
    const mounted = await client.mountSubClients(ctx)
    assert.equal(mounted, expected.length, '所有有客户端半的子插件都应挂上')
    assert.deepEqual(mountedNames, expected)
    assert.deepEqual(warnings, [], '已注册的子插件不该产生警告')
  } finally {
    console.warn = originalWarn
  }
})
await checkAsync('客户端半的 URL 与宿主路由同源（两边都改才生效，写死会漂移）', async () => {
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const client = await clientExports()
  assert.equal(client.ROUTE_CLIENT, index.ROUTE_CLIENT)
  for (const row of rows.rows.filter((item) => item.kind === 'sub' && item.client === true)) {
    assert.equal(client.clientScriptUrl(row), `${index.ROUTE_CLIENT}/${row.subpath}.js`)
  }
})

// ── ⑥b 子行开关要跟着走（关掉子插件 = 它的客户端半也得消失）───────────────
//
// 用户报过：在「设置 → 插件」里关掉某个子行，界面上那个功能还在。
// 原因是父客户端半按 CATALOG 无条件挂载，不看那一行在 loader 里是否被启用。
// 现在挂载名单来自 /yintx/status 的 mounted（= 宿主半账本：行没被 apply 就不记账）。
await checkAsync('rowEnabled：从 /yintx/status 读出「这一行有没有被启用」', async () => {
  const client = await clientExports()
  const id = client.CATALOG[0].id
  assert.equal(client.rowEnabled({ rows: [{ id, mounted: true }] }, id), true, 'mounted=true → 启用')
  assert.equal(client.rowEnabled({ rows: [{ id, mounted: false }] }, id), false, 'mounted=false → 禁用')
  assert.equal(client.rowEnabled({ rows: [{ id: 'yintx-not-this-row', mounted: true }] }, id), undefined, '快照里没有这一行 → 不知道')
  assert.equal(client.rowEnabled(null, id), undefined, '拿不到状态 → 不知道')
  assert.equal(client.rowEnabled(undefined, id), undefined)
})

await checkAsync('pickEnabledRows：禁用行被排除；读不到状态时退回全挂（旧宿主半兼容）', async () => {
  const client = await clientExports()
  assert.ok(client.CATALOG.length >= 2, '这条断言至少要两行才有意义')
  const disabledId = client.CATALOG[0].id
  const status = {
    ok: true,
    rows: client.CATALOG.map((row) => ({ id: row.id, mounted: row.id !== disabledId })),
  }
  const picked = client.pickEnabledRows(client.CATALOG, status)
  assert.equal(picked.length, client.CATALOG.length - 1, '禁用的那行不该留在挂载名单里')
  assert.ok(!picked.some((row) => row.id === disabledId), '禁用的行必须被排除')
  assert.equal(
    client.pickEnabledRows(client.CATALOG, null).length,
    client.CATALOG.filter((row) => row.client === true).length,
    '拿不到状态时退回全挂（宁可多挂，也不能因为读不到状态就让功能整体消失）',
  )
})

await checkAsync('unmountOne：停用后能真的卸下已挂的客户端半（dispose 子插件 fiber）', async () => {
  const client = await clientExports()
  const row = client.CATALOG[0]
  let disposed = 0
  const fibers = new Map([[row.id, { dispose: () => { disposed += 1 } }]])
  assert.equal(client.unmountOne(fibers, row), true, '卸了一个就该返回 true')
  assert.equal(disposed, 1, '必须真的 dispose 子插件的 fiber（子插件靠它跑 cleanup 移除 DOM）')
  assert.equal(fibers.size, 0, '卸完要清账')
  assert.equal(client.unmountOne(fibers, row), false, '重复卸载要返回 false，不能抛')
})

await checkAsync('startRowSync：浏览器外不启动轮询（node 测试不会被定时器吊住）', async () => {
  const client = await clientExports()
  const stop = client.startRowSync({}, new Map())
  assert.equal(typeof stop, 'function', '必须返回停止函数')
  stop()
  assert.ok(Number.isInteger(client.ROW_SYNC_INTERVAL) && client.ROW_SYNC_INTERVAL >= 1000, '轮询间隔应是合理的毫秒数')
})

// ── ⑥c 行开关与账本的真实链路 ───────────────────────────────────────────────
//
// 开关机制依赖「外壳 apply 时把行 id 记进账本 → /yintx/status 的 mounted=true」。
// 一旦生成物漏了 config.id，账本会记成 '(no-row)'，所有子行都被判成「已禁用」，
// 客户端半全不挂载。2026-10-23 那次「关掉子包功能还在」的修复就翻过这个车。
check('cordis.patch.yml 每行的 config 都带行 id（漏了账本会记成 (no-row)）', () => {
  const patch = read('cordis.patch.yml')
  for (const item of manifest.plugins) {
    const rowId = `${manifest.namespace}-${item.subpath}`
    const at = patch.indexOf(`fallback: ${item.fallback}`)
    assert.ok(at > 0, `patch 里找不到 ${item.subpath} 的 fallback`)
    const configBlock = patch.slice(Math.max(0, at - 400), at)
    assert.ok(configBlock.includes(`id: ${rowId}`), `${rowId} 的 config 里缺 id: ${rowId}`)
  }
})

await checkAsync('外壳 apply 后账本记录真实行 id，/yintx/status 随之 mounted=true', async () => {
  state.resetState()
  // 只提供外壳 apply 真正用到的那几样；plugin 故意不真跑实现（账本在 loadImpl 之前就记了）
  const ctx = {
    webServer: { register() {} },
    effect(fn) {
      try {
        fn()
      } catch {}
    },
    plugin() {
      return { dispose() {} }
    },
    on() {},
    get() {},
    provide() {},
  }
  try {
    await shell.apply(ctx, { id: 'yintx-todo-float', fallback: './main/todo-float/index.js' })
  } catch {
    // 实现 import/启动失败不影响「记账」这一段
  }
  const ledger = state.listActiveRows()
  assert.ok(ledger.includes('yintx-todo-float'), `账本应记录真实行 id，实际 ${JSON.stringify(ledger)}`)
  assert.ok(!ledger.includes('(no-row)'), '账本不能记成 (no-row)：那会让所有子行都被判成已禁用')
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const snap = index.snapshot()
  assert.equal(snap.ledgerReliable, true, '账本与目录对得上时 ledgerReliable 应为 true')
  assert.equal(snap.rows.find((row) => row.id === 'yintx-todo-float')?.mounted, true, '外壳挂上后该行 mounted 应为 true')
  state.resetState()
})

checkAsync('snapshot 在账本对不上目录时给 ledgerReliable=false（客户端会退回全挂）', async () => {
  const index = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  state.resetState()
  state.recordActiveRow('(no-row)')
  assert.equal(index.snapshot().ledgerReliable, false, '账本里出现对不回目录的键 → 不可信')
  state.resetState()
})

await checkAsync('pickEnabledRows：宿主半说账本不可信时退回全挂', async () => {
  const client = await clientExports()
  const status = {
    ok: true,
    ledgerReliable: false,
    rows: client.CATALOG.map((row) => ({ id: row.id, mounted: false })),
  }
  assert.equal(
    client.pickEnabledRows(client.CATALOG, status).length,
    client.CATALOG.filter((row) => row.client === true).length,
    '账本坏了不能把整个界面清空，必须退回全挂',
  )
})

// ── ⑦ 降级记录的形状 ────────────────────────────────────────────────────────
check('降级原因会截断，不塞进整个堆栈', () => {
  state.resetState()
  const long = new Error('x'.repeat(state.DEGRADED_REASON_MAX * 3))
  const entry = state.recordDegraded('yintx-long', 'import', long)
  assert.ok(entry.reason.length <= state.DEGRADED_REASON_MAX, `原因应被截断到 ${state.DEGRADED_REASON_MAX}`)
  assert.match(entry.reason, /…$/)
  state.resetState()
})

// ── ⑧ 展示元信息（官方卡片里显示中文标题，而不是 yintxplugins/xxx 这种生路径名） ──
//
// 官方 @deepseek-ai/dsh-app-boot 的 readPluginMeta 是这么读的：
//   ① 解析 `<行 name>/locale/<语言>.json`（英文那份是必需的回退）
//   ② 解析 `<行 name>/package.json`（icon 从它的 icon 字段来）
// 行 name 形如 `yintxplugins/open-folder`，所以资源路径就是我们 exports 里映射的那几条。
await checkAsync('子行的展示元信息可解析（卡片显示中文标题）', async () => {
  const localRequire = createRequire(ROOT_URL + 'lib/index.js')
  for (const item of manifest.plugins) {
    const specifier = `${pkg.name}/${item.subpath}`
    for (const lang of ['en.json', 'zh.json']) {
      const resolved = localRequire.resolve(`${specifier}/locale/${lang}`)
      const dict = JSON.parse(readFileSync(resolved, 'utf8'))
      assert.equal(typeof dict.meta?.title, 'string', `${specifier}/locale/${lang} 缺 meta.title`)
      assert.equal(typeof dict.meta?.description, 'string', `${specifier}/locale/${lang} 缺 meta.description`)
    }
    const zh = JSON.parse(readFileSync(localRequire.resolve(`${specifier}/locale/zh.json`), 'utf8'))
    assert.match(zh.meta.title, /[\u4e00-\u9fa5]/, `${specifier} 的中文标题应含中文`)
    assert.equal(zh.meta.title, item.title, `${specifier} 的中文标题应与 aggregate.json 的 title 一致`)
  }
})

for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

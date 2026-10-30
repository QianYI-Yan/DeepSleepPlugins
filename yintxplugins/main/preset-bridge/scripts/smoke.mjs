/**
 * dsh-preset-bridge 冒烟测试。
 *
 * 重点验证两件在真实安装里出过问题的东西：
 *  1. **yaml 能不能拿到** —— 插件以 file:/junction 形式安装时，Node 按真实路径解析，
 *     裸 `import 'yaml'` 会失败；这里断言候选回退真的生效（并打印用的是哪一份）。
 *  2. **cordis 的 inject 面** —— 用忠实模拟的 ctx（未 inject 的属性一律抛错）跑一遍 apply，
 *     并真的调用路由处理函数，确认信任闸不会 500。
 *
 * 用法：node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const mod = await import('../index.js')

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

// ── 1) yaml 载入 ──────────────────────────────────────────────────────────
let yamlSource = null
await checkAsync('loadYaml 能拿到 yaml（裸名失败时回退候选路径）', async () => {
  const YAML = await mod.loadYaml()
  assert.equal(typeof YAML.parse, 'function')
  yamlSource = mod.yamlLoadedFrom()
  console.log(`   yaml 来源: ${yamlSource}`)
  assert.ok(yamlSource, 'yamlSource 为空')
})
await checkAsync('loadYaml 幂等', async () => {
  const again = await mod.loadYaml()
  assert.equal(again, await mod.loadYaml())
})
check('候选清单包含宿主 profile 里的 yaml 位置', () => {
  const list = mod.yamlCandidates()
  assert.ok(list.length >= 3, '候选太少')
  assert.ok(list.some((item) => item.includes('profiles')), '没有 profile 候选')
})

// ── 2) 解析与行改写 ───────────────────────────────────────────────────────
check('parseYaml 支持 !!js 且不求值', () => {
  const doc = mod.parseYaml('rows:\n  - id: x\n    name: !!js ctx.foo(1)\n')
  assert.equal(typeof doc.rows[0].name.__jsExpr, 'string')
})
check('rewriteRows：相对名转 file://、已移除包改写、group 递归', () => {
  const rows = mod.rewriteRows(
    [
      { id: 'a', name: './local.mjs' },
      { id: 'b', name: '@deepseek-ai/dsh-workflow-worker-thread' },
      { id: 'g', group: true, config: [{ name: '../up.mjs' }] },
    ],
    'C:\\presets\\demo',
  )
  assert.ok(rows[0].name.startsWith('file:///'))
  assert.deepEqual(rows[1], { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc' })
  assert.ok(rows[2].config[0].name.startsWith('file:///'))
})
check('inject 面写全了（connection 不能漏，否则路由 500）', () => {
  assert.deepEqual([...mod.inject].sort(), ['agentPresets', 'connection', 'webServer'])
})

// ── 3) 按显示名找目录：客户端半注入的按钮只能回传显示名（DOM 里拿不到预设 id）──
check('readPresetName 能从 preset.yml 抠出 name（不引 yaml 模块）', () => {
  const dirs = mod.listPresetDirs(mod.presetRoot())
  if (dirs.length === 0) return
  assert.ok(
    dirs.some((entry) => typeof mod.readPresetName(entry.dir) === 'string'),
    '一个预设都没读到 name',
  )
})
check('findPresetDirByName：目录名 / 显示名都能命中，未知名返回 null', () => {
  const root = mod.presetRoot()
  const dirs = mod.listPresetDirs(root)
  if (dirs.length === 0) return
  const first = dirs[0]
  assert.equal(mod.findPresetDirByName(first.id, root), first.dir, '按目录名没命中')
  const name = mod.readPresetName(first.dir)
  if (typeof name === 'string') {
    assert.equal(mod.findPresetDirByName(name, root), first.dir, '按显示名没命中')
  }
  assert.equal(mod.findPresetDirByName('绝不存在的预设名-xyz', root), null)
  assert.equal(mod.findPresetDirByName('', root), null)
})

// ── 3) 真实预设目录 ───────────────────────────────────────────────────────
const root = mod.presetRoot()
const dirs = mod.listPresetDirs(root)
console.log(`   预设根目录: ${root}`)
console.log(`   发现目录: ${dirs.map((d) => d.id).join(', ') || '(无)'}`)
await checkAsync('真实预设目录能逐份读成注册定义', async () => {
  if (dirs.length === 0) return
  for (const { id, dir } of dirs) {
    const def = mod.readPresetDefinition(id, dir)
    assert.equal(def.id, id)
    assert.ok(Array.isArray(def.plugins))
    console.log(`   - ${def.id}${def.name ? ` (${def.name})` : ''}：顶层行 ${def.plugins.length}`)
  }
})

// ── 4) apply + 路由（忠实模拟 cordis ctx） ───────────────────────────────
function cordisCtx(services, declared, sink) {
  const base = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      if (declared.includes(prop)) return services[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

const routes = []
const registered = []
const services = {
  webServer: {
    register: (options) => {
      routes.push(options)
      return () => {}
    },
  },
  agentPresets: {
    register: async (definition) => {
      registered.push(definition)
      return async () => {}
    },
  },
  connection: { requestRejection: () => undefined },
}

await checkAsync('apply() 在忠实 ctx 下不抛错，并注册路由与预设', async () => {
  await mod.apply(cordisCtx(services, mod.inject, routes))
  assert.equal(routes.length, 1, '路由没注册')
  assert.equal(routes[0].path, '/preset-folder/open')
  const expected = dirs.filter((d) => d.id !== 'liangshen').length
  assert.equal(registered.length, expected, `预设注册数量不符：${registered.length} vs ${expected}`)
})

const call = (method, body, reject) =>
  new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = {
      method,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
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
    void routes[0].handler(req, res)
  })

await checkAsync('路由：非 POST 405、非法 JSON 400、不存在的预设 404', async () => {
  const method = await call('GET')
  assert.equal(method.status, 405)
  assert.equal(method.headers.allow, 'POST')
  const target = await call('POST', { presetId: 'zzz-not-exist' })
  assert.equal(target.status, 404)
  const traversal = await call('POST', { presetId: '../evil' })
  assert.equal(traversal.status, 400)
})

await checkAsync('信任服务不可用时 503 拒绝（不再 500）', async () => {
  const routes2 = []
  const weakServices = {
    webServer: {
      register: (options) => {
        routes2.push(options)
        return () => {}
      },
    },
    agentPresets: services.agentPresets,
    connection: {},
  }
  await mod.apply(cordisCtx(weakServices, mod.inject, routes2), { scan: false })
  const handler = routes2[0].handler
  const result = await new Promise((resolve) => {
    const req = { method: 'POST', async *[Symbol.asyncIterator]() {}, resume() {} }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(payload) {
        resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null })
      },
    }
    void handler(req, res)
  })
  assert.equal(result.status, 503)
  assert.match(result.body.message, /连接信任服务不可用/)
})

await checkAsync('config.route=false 时只做扫描、不注册路由', async () => {
  const routes3 = []
  const scanOnly = {
    webServer: {
      register: (options) => {
        routes3.push(options)
        return () => {}
      },
    },
    agentPresets: services.agentPresets,
    connection: services.connection,
  }
  await mod.apply(cordisCtx(scanOnly, mod.inject, routes3), { route: false })
  assert.equal(routes3.length, 0)
})

check('cordis 模拟 ctx 真的会拦未 inject 的属性', () => {
  const strict = cordisCtx(services, ['webServer'])
  assert.throws(() => strict.connection, /without inject/)
})

check('实现文件齐备（宿主半 + 客户端半），且合集清单里声明了这一行', () => {
  const scripts = new URL('.', import.meta.url)
  assert.ok(existsSync(new URL('../index.js', import.meta.url)), '缺宿主半 index.js')
  assert.ok(existsSync(new URL('../client.js', import.meta.url)), '缺客户端半 client.js')
  assert.ok(existsSync(new URL('smoke.mjs', scripts)), '缺冒烟测试 smoke.mjs')
  const manifest = JSON.parse(readFileSync(new URL('../../../aggregate.json', import.meta.url), 'utf8'))
  const item = manifest.plugins.find((entry) => entry.subpath === 'preset-bridge')
  assert.ok(item, 'aggregate.json 缺少 preset-bridge 行')
  assert.equal(item.plugin, 'dsh-preset-bridge')
  // 预设卡片的「打开目录」按钮靠客户端半注入，缺了这两项按钮就不会出现
  assert.equal(item.client, true, 'preset-bridge 带客户端半，清单里必须声明 client: true')
  assert.equal(item.clientEntry, './main/preset-bridge/client.js')
})

for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

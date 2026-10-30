/**
 * dsh-plugin-open-folder 客户端半冒烟测试：node test/smoke-client.mjs
 *
 * 自带极小 React（createElement / hooks 索引式）+ 极小 primitives + 假 slots/locale，
 * 真实 import lib/client.js 并执行 apply，然后：
 *   - 断言注册进的是官方席位 plugins.detail.actions，注册参数形状正确；
 *   - 断言组件对 bundle/row 渲染、对 item（官方插件）返回 null；
 *   - 造一个「挂起中的 fetch」断言 busy 文案，再放行断言成功文案与 fetch 的 URL/body；
 *   - 造一个失败响应断言错误文案；
 *   - 断言注入的 <style> 与清理函数成对存在。
 */
import assert from 'node:assert/strict'

const CLIENT_URL = new URL('../client.js', import.meta.url).href

// ── 极小 React ─────────────────────────────────────────────────────────────
let hookIndex = 0
let hooks = []
let rerenderFn = null

const React = {
  createElement(type, props, ...children) {
    return {
      $$element: true,
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const i = hookIndex++
    if (hooks[i] === undefined) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
    const setter = (next) => {
      hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next
      rerenderFn?.()
    }
    return [hooks[i].value, setter]
  },
  useRef(initial) {
    const i = hookIndex++
    if (hooks[i] === undefined) hooks[i] = { value: { current: initial } }
    return hooks[i].value
  },
  useEffect(fn) {
    hookIndex++
    const i = hookIndex - 1
    if (hooks[i] === undefined) hooks[i] = { effect: fn }
    return undefined
  },
  useCallback(fn) {
    hookIndex++
    return fn
  },
  useMemo(fn) {
    hookIndex++
    return fn()
  },
  memo: (component) => component,
  forwardRef: (fn) => (props) => fn(props, { current: null }),
}

const jsxRuntime = {
  jsx: React.createElement,
  jsxs: React.createElement,
  Fragment: React.Fragment,
}

const primitives = {
  Button: (props) => React.createElement('button', props, props.children),
  IconFolderOpenOutlineRegular: (props) => React.createElement('svg', props ?? {}),
}

const requireStub = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`客户端半 require 了未声明的模块：${name}`)
}

/** 渲染一次组件，返回渲染树；之后 setState 会自动重渲染并更新 latest。 */
function mount(Component, props) {
  const bag = { tree: null }
  rerenderFn = () => {
    hookIndex = 0
    bag.tree = Component({ ...props, ...bag.extraProps })
  }
  rerenderFn()
  return bag
}

// ── 渲染树小工具 ───────────────────────────────────────────────────────────
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node.$$element) {
    visit(node)
    for (const child of node.children ?? []) walk(child, visit)
  }
}

function allText(tree) {
  const parts = []
  walk(tree, (node) => {
    for (const child of node.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child))
    }
  })
  return parts.join(' ')
}

function clickable(tree) {
  let found = null
  walk(tree, (node) => {
    if (!found && typeof node.props?.onClick === 'function') found = node
  })
  return found
}

// ── 加载客户端半 ───────────────────────────────────────────────────────────
let captured = null
globalThis.window = { __ModuleLoader__: { load: (opts) => (captured = opts) } }
globalThis.document = { body: { appendChild() {}, removeChild() {} }, createElement: () => ({}) }

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error.message}`])
  }
}

await import(CLIENT_URL)

check('loader id 与包名一致', () => assert.equal(captured?.id, 'dsh-plugin-open-folder'))
check('factory 是函数', () => assert.equal(typeof captured.factory, 'function'))

const mod = captured.factory(requireStub)
check('exports.inject 含 slots（locale 走可选注入）', () => {
  assert.ok(Array.isArray(mod.inject), 'inject 不是数组')
  assert.ok(mod.inject.includes('slots'), '没注入 slots')
})
check('导出 apply', () => assert.equal(typeof mod.apply, 'function'))

// ── apply：拿注册项 ───────────────────────────────────────────────────────
const injections = []
const registrations = []
const localeDicts = []
const injectedDeps = []
const disposers = []

/** 假的 locale 上下文：绑定词典里的文案带「·词典」后缀，便于断言"确实跟着词典走"。 */
const fakeLocaleCtx = {
  locale: {
    bind: (ns) => (key) =>
      ({ open: '打开目录·词典', opening: '打开中…·词典', openLabel: '在文件管理器中打开 {name} 的目录·词典' }[key] ?? key),
    register(ns, dict) {
      localeDicts.push({ ns, dict })
      return () => {}
    },
  },
  effect: (fn) => fn(),
}

const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  /** 可选注入：本插件用 ctx.inject(['locale'], …) 拿语言，服务缺席时退回内置中文。 */
  inject(deps, callback) {
    injectedDeps.push(deps)
    callback(fakeLocaleCtx)
  },
  locale: {
    register(ns, dict) {
      localeDicts.push({ ns, dict })
      return () => {}
    },
  },
  slots: {
    inject(name, fn) {
      injections.push(name)
      return fn()
    },
    register(opts, Component) {
      registrations.push({ opts, Component })
      return () => {}
    },
  },
}

mod.apply(ctx)

check('通过 ctx.slots.inject 注册了 plugins.detail.actions', () => {
  assert.ok(injections.includes('plugins.detail.actions'), `实际注入：${injections.join(',')}`)
})
check('注册项形状正确（name/id/order）', () => {
  assert.equal(registrations.length, 1, '注册项数量不对')
  const { opts } = registrations[0]
  assert.equal(opts.name, 'plugins.detail.actions')
  assert.equal(typeof opts.id, 'string')
  assert.ok(opts.id.length > 0, 'id 为空')
  assert.equal(typeof opts.order, 'number', 'order 不是数字')
})
check('可选注入 locale：注册了字典', () => {
  assert.ok(injectedDeps.some((deps) => deps.includes('locale')), `实际注入：${JSON.stringify(injectedDeps)}`)
  const dict = localeDicts.find((d) => d.ns === 'pluginOpenFolder')
  assert.ok(dict, '没注册 pluginOpenFolder 字典')
  assert.equal(dict.dict.zh.open, '打开目录')
  assert.equal(dict.dict.en.open, 'Open folder')
})

const { Component } = registrations[0]
/** 框架注入的 t：真实环境由 locale 字典给出；这里用组件内置的那套中文文案等价替代。 */
const ZH = {
  open: '打开目录',
  opening: '打开中…',
  openLabel: '在文件管理器中打开 {name} 的目录',
  copyPath: '点击复制路径：{path}',
  copied: '已复制',
  copyFailed: '复制失败，请手动选中路径',
  requestFailed: '请求失败：{message}',
}
const t = (key, params) =>
  String(ZH[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => (params?.[name] === undefined ? match : String(params[name])))
const baseProps = { t }

const bundleSubject = {
  kind: 'bundle',
  pkg: { name: 'dsh-demo-host-shell', version: '0.1.0', installed: true, enabled: true, rows: [] },
}
const rowSubject = {
  kind: 'row',
  pkg: { name: 'dsh-demo-host-shell', version: '0.1.0', installed: true, enabled: true, rows: [] },
  row: { rowId: 'dsh-demo-host-shell', moduleName: 'dsh-demo-host-shell', enabled: true },
}
const itemSubject = { kind: 'item', id: '@deepseek-ai/dsh-core' }

check('bundle 页渲染出按钮', () => {
  const tree = Component({ ...baseProps, subject: bundleSubject })
  assert.notEqual(tree, null, 'bundle 页返回了 null')
  assert.ok(clickable(tree), '渲染树里没有可点的按钮')
})
check('row 页也渲染出按钮', () => {
  const tree = Component({ ...baseProps, subject: rowSubject })
  assert.notEqual(tree, null, 'row 页返回了 null')
})
check('官方插件页（item）返回 null', () => {
  assert.equal(Component({ ...baseProps, subject: itemSubject }), null)
})
check('没有 t 时（locale 未就绪）用活动词典/内置中文兜底照常渲染', () => {
  const tree = Component({ subject: bundleSubject })
  const button = clickable(tree)
  assert.ok(button, '无 t 时没渲染出按钮')
  assert.match(allText(tree), /打开目录/, `实际文案：${allText(tree)}`)
})
check('文案跟随 locale 词典（绑定后的 translate 真的在用）', () => {
  const text = allText(Component({ subject: bundleSubject }))
  assert.match(text, /打开目录·词典/, `实际文案：${text}`)
})

// ── 点击：挂起中的 fetch → busy 文案 → 成功文案 ───────────────────────────
let resolveFetch = null
const fetchCalls = []
globalThis.fetch = (url, init) => {
  fetchCalls.push({ url, init })
  return new Promise((resolve) => {
    resolveFetch = (payload) => resolve(payload)
  })
}

/** 假事件对象。 */
const fakeEvent = () => ({
  currentTarget: {},
  preventDefault() {},
  stopPropagation() {},
})

const bag = mount(Component, { ...baseProps, subject: bundleSubject })
clickable(bag.tree).props.onClick(fakeEvent())
await new Promise((r) => setTimeout(r, 0))

check('点击后 fetch 打到了宿主半路由且 body 带包名', () => {
  assert.equal(fetchCalls.length, 1, '没有发出 fetch')
  assert.match(String(fetchCalls[0].url), /\/plugin-open-folder\/open$/)
  const body = JSON.parse(fetchCalls[0].init.body)
  assert.equal(body.name, 'dsh-demo-host-shell')
})
check('请求中显示 busy 文案', () => {
  const text = allText(bag.tree)
  assert.match(text, /打开中|Opening/i, `实际文案：${text}`)
})

resolveFetch({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, path: 'C:\\FAKE\\PLUGIN\\DIR', source: 'link', opened: true }),
})
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

check('成功后把解析出的路径显示出来', () => {
  const text = allText(bag.tree)
  assert.match(text, /C:\\FAKE\\PLUGIN\\DIR/, `实际文案：${text}`)
})

// ── 失败路径 ──────────────────────────────────────────────────────────────
globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  json: async () => ({ ok: false, message: '找不到 xxx 的本地目录' }),
})
const bag2 = mount(Component, { ...baseProps, subject: bundleSubject })
clickable(bag2.tree).props.onClick(fakeEvent())
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

check('失败时显示宿主半给的 message', () => {
  const text = allText(bag2.tree)
  assert.match(text, /找不到 xxx 的本地目录/, `实际文案：${text}`)
})

check('注册了清理函数（卸载时撤掉注入物）', () => assert.ok(disposers.length >= 1))
check('清理函数可调用且不抛错', () => disposers.forEach((d) => d()))

for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

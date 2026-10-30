/**
 * dsh-plugin-link-install **客户端半**冒烟测试：`node test/smoke-client.mjs`
 *
 * 这一半是纯 DOM 注入（不用 React），所以这里自带一个**极小 DOM**，真实 import
 * `../client.js`（它顶层会调 `window.__ModuleLoader__.load`）、取出 exports，然后直接测三件事：
 *
 *  1. **预览卡片**：`state.card` 有值时画出来（包名 / 版本 / DSH 标签 / 说明 / 目录 / 警告），
 *     没有值时必须**收起来**（`data-open` 不设），不留空壳；
 *  2. **防抖**：同一条路径不重复请求宿主；不是路径就收起卡片；
 *  3. **不拦官方那次点击**：勾了复选框点官方「安装」时，我们只调 `/plugin-local/finish` 登记收尾，
 *     **不** preventDefault —— 官方流程必须自己跑完（这是被反复要求的一条）。
 *
 * 只碰内存里的假 DOM，不碰真实浏览器、不碰真实 `.dsh`。
 */
import assert from 'node:assert/strict'

// ── 极小 DOM ────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.attributes = new Map()
    this.childNodes = []
    this.listeners = new Map()
    this.textContent = ''
    this.parentNode = null
    this.parentElement = null
    this.nextSibling = null
    this.value = ''
    this.checked = false
    this.disabled = false
    this.title = ''
    this.id = ''
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value))
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null
  }
  removeAttribute(name) {
    this.attributes.delete(String(name))
  }
  appendChild(child) {
    if (child === null || child === undefined) return child
    child.parentNode = this
    child.parentElement = this.tagName === 'DIV' || this.tagName === 'LABEL' ? this : this.parentElement
    this.childNodes.push(child)
    return child
  }
  insertBefore(child, ref) {
    const at = ref ? this.childNodes.indexOf(ref) : -1
    if (at < 0) return this.appendChild(child)
    child.parentNode = this
    this.childNodes.splice(at, 0, child)
    return child
  }
  remove() {
    const parent = this.parentNode
    if (!parent) return
    const at = parent.childNodes.indexOf(this)
    if (at >= 0) parent.childNodes.splice(at, 1)
    this.parentNode = null
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  dispatchEvent(event) {
    for (const fn of this.listeners.get(event.type) || []) fn(event)
    return !event.defaultPrevented
  }
  get firstChild() {
    return this.childNodes.length ? this.childNodes[0] : null
  }
  /** 只支持属性选择器的极简版：`[data-x]` / `[data-x="1"]`。 */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector) {
    const match = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(String(selector).trim())
    if (!match) return []
    const [, name, wanted] = match
    const out = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.attributes && child.attributes.has(name)) {
          if (wanted === undefined || child.attributes.get(name) === wanted) out.push(child)
        }
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

const documentStub = {
  head: new FakeNode('head'),
  body: new FakeNode('body'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode('#text')
    node.textContent = String(text)
    return node
  },
  getElementById: () => null,
  addEventListener: () => {},
  querySelectorAll: () => [],
}

const storage = new Map()
globalThis.document = documentStub
globalThis.HTMLInputElement = class HTMLInputElement {}
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}

/** 记下每一次 fetch；默认回一个空的成功 JSON。 */
const calls = []
let fetchResponder = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
globalThis.fetch = (url, options) => {
  calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null })
  const response = fetchResponder(url, options)
  return Promise.resolve(response)
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  localStorage: globalThis.localStorage,
}

// ── 载入真实的客户端 bundle ─────────────────────────────────────────────────

const CLIENT_URL = new URL('../client.js', import.meta.url).href
await import(CLIENT_URL)

assert.ok(loaded !== null, 'client.js 顶层必须调 window.__ModuleLoader__.load 注册自己')
assert.equal(loaded.id, 'dsh-plugin-link-install', '注册 id 必须是包名')
const plugin = loaded.factory(() => {
  throw new Error('客户端半不该 require 任何东西')
})
const t = plugin.__test

let passed = 0
let failed = 0
function check(title, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${title}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${title}\n      ${(error && error.message) || error}`)
  }
}
async function checkAsync(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${title}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${title}\n      ${(error && error.message) || error}`)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 预览卡片 ────────────────────────────────────────────────────────────────

check('预览卡片：有信息时画出来（包名 / 版本 / DSH 标签 / 说明 / 目录 / 警告）', () => {
  const card = new FakeNode('div')
  t.state.card = {
    ok: true,
    name: 'demo-plugin',
    version: '1.2.3',
    description: '一个演示插件',
    dir: 'D:\\Code\\DeepSeek\\demo-plugin',
    isDshPlugin: true,
    hasBundlePatch: true,
    hasClient: true,
    private: true,
    runtimeDeps: ['a', 'b'],
    warnings: ['该包声明了 private'],
  }
  t.paintCard(card)
  assert.equal(card.getAttribute('data-open'), '1', '有内容时必须展开')
  assert.equal(card.querySelector('[data-dsh-link-card-name]').textContent, 'demo-plugin')
  assert.equal(card.querySelector('[data-dsh-link-card-version]').textContent, 'v1.2.3')
  assert.equal(card.querySelector('[data-dsh-link-card-desc]').textContent, '一个演示插件')
  assert.equal(card.querySelector('[data-dsh-link-card-path]').textContent, 'D:\\Code\\DeepSeek\\demo-plugin')
  const texts = card.querySelectorAll('[data-dsh-link-card-tag]').map((el) => el.textContent)
  assert.deepEqual(texts, ['DSH 插件', 'bundle', '客户端半', 'private', '运行时依赖 2'])
  const notes = card.querySelectorAll('[data-dsh-link-card-note]').map((el) => el.textContent)
  assert.deepEqual(notes, ['该包声明了 private'])
})

check('预览卡片：没有信息时收起来（不留空壳）', () => {
  const card = new FakeNode('div')
  card.setAttribute('data-open', '1')
  t.state.card = null
  t.paintCard(card)
  assert.equal(card.getAttribute('data-open'), null, 'data-open 必须被摘掉')
  assert.equal(card.childNodes.length, 0, '不留任何子节点')
})

check('预览卡片：不是 DSH 插件时标签是警告色', () => {
  const card = new FakeNode('div')
  t.state.card = { ok: true, name: 'plain', version: '', dir: 'C:\\plain', isDshPlugin: false, warnings: [] }
  t.paintCard(card)
  assert.equal(card.querySelector('[data-dsh-link-card-tag]').getAttribute('data-kind'), 'warn')
  assert.equal(card.querySelector('[data-dsh-link-card-tag]').textContent, '不是 DSH 插件')
  assert.equal(card.querySelector('[data-dsh-link-card-version]'), null, '没有版本就不显示 v')
})

// ── 防抖与请求 ──────────────────────────────────────────────────────────────

await checkAsync('输入框不是路径 → 不请求宿主，卡片收起', async () => {
  calls.length = 0
  t.state.card = { ok: true, name: 'stale', version: '', dir: 'x', isDshPlugin: true, warnings: [] }
  t.scheduleInspect('dsh-whale-pet')
  await tick()
  assert.equal(calls.length, 0, '包名不是路径，不该去读盘')
  assert.equal(t.state.card, null, '卡片要收起')
})

await checkAsync('输入框是路径 → 防抖后请求 /plugin-local/inspect，且同值不重复请求', async () => {
  calls.length = 0
  fetchResponder = () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ ok: true, name: 'demo-plugin', version: '1.0.0', dir: 'D:\\x', isDshPlugin: true, warnings: [] }),
  })
  t.state.inspected = ''
  t.scheduleInspect('D:\\Code\\DeepSeek\\demo-plugin')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(calls.length, 1, '一次路径变化只发一次请求')
  assert.equal(calls[0].url, '/plugin-local/inspect')
  assert.deepEqual(calls[0].body, { source: 'D:\\Code\\DeepSeek\\demo-plugin' })

  t.scheduleInspect('D:\\Code\\DeepSeek\\demo-plugin')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(calls.length, 1, '同一条路径不再重复请求')
})

await checkAsync('宿主说读不到 → 卡片显示成「不是插件目录」并带上原因', async () => {
  fetchResponder = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, message: '缺 package.json' }) })
  t.state.inspected = ''
  t.scheduleInspect('D:\\Code\\DeepSeek\\not-a-plugin')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(t.state.card.name, '不是插件目录')
  assert.ok(String(t.state.card.warnings[0]).includes('缺 package.json'))
})

// ── 不拦官方那次点击 ────────────────────────────────────────────────────────

await checkAsync('勾了复选框点官方「安装」→ 只登记 /plugin-local/finish，不拦官方流程', async () => {
  calls.length = 0
  fetchResponder = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
  t.state.busy = false
  t.state.localMode = true
  t.armWarehouse('D:\\Code\\DeepSeek\\demo-plugin')
  await tick()
  assert.equal(calls.length, 1, '应当只发一次收尾请求')
  assert.equal(calls[0].url, '/plugin-local/finish', '打的是收尾路由（官方自己那次安装不受影响）')
  assert.deepEqual(calls[0].body, { source: 'D:\\Code\\DeepSeek\\demo-plugin' })
  await new Promise((resolve) => setTimeout(resolve, 10))
})

check('客户端 bundle 里没有 preventDefault 拦官方安装点击的代码', () => {
  // 这一条是行为回归：曾经那版在捕获阶段 preventDefault + stopImmediatePropagation，
  // 官方界面一动不动 —— 用户明确不要那种方式。
  const source = t.armWarehouse.toString()
  assert.ok(!source.includes('preventDefault'), '收尾逻辑不该阻止默认行为')
})

// ── 收尾 ────────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failed} 通过`)
process.exit(failed === 0 ? 0 : 1)

/**
 * dsh-plugin-session-popout 客户端半冒烟测试：`node test/smoke-client.mjs`
 *
 * 覆盖：注册形状、URL 构造（**必须原样保留 token**）、小窗判定、features 计算、
 * 拖拽阈值、配置解析、胶囊视图（点击/拖出/取消拖）、小窗浮条，以及 `openPopout` 的开窗参数。
 * 自带极简 DOM stub，不依赖浏览器、不装任何包。
 */
import assert from 'node:assert/strict'

class FakeElement {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.parentNode = null
    this.attrs = new Map()
    this.style = {}
    this.listeners = new Map()
    this.className = ''
    this._text = ''
  }

  setAttribute(key, value) {
    this.attrs.set(key, String(value))
  }

  getAttribute(key) {
    return this.attrs.has(key) ? this.attrs.get(key) : null
  }

  removeAttribute(key) {
    this.attrs.delete(key)
  }

  appendChild(node) {
    node.parentNode = this
    this.children.push(node)
    return node
  }

  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    node.parentNode = null
    return node
  }

  remove() {
    this.parentNode?.removeChild(this)
  }

  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type, extra = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...extra }
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }
}

class FakeWindow {
  constructor(href = 'http://127.0.0.1:19387/?token=SECRET') {
    this.innerWidth = 1440
    this.innerHeight = 900
    this.location = { href }
    this.listeners = new Map()
    this.openCalls = []
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type, extra = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, preventDefault() {}, stopPropagation() {}, ...extra })
  }

  open(url, name, features) {
    this.openCalls.push({ url, name, features })
    return { focus() {} }
  }
}

function createFakeDocument(href) {
  return {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    defaultView: new FakeWindow(href),
    createElement: (tag) => new FakeElement(tag),
    querySelector: () => null,
  }
}

let registered = null
globalThis.window = { __ModuleLoader__: { load: (opts) => (registered = opts) } }

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

/** 深度收集整棵子树（含自身）。 */
function flatten(node, out = []) {
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

await import(new URL('../client.js', import.meta.url).href)
const mod = registered?.factory?.(() => {
  throw new Error('客户端半不该 require 任何模块')
})

check('loader 注册 id 与包名一致', () => assert.equal(registered?.id, 'dsh-plugin-session-popout'))
check('导出形状：name / apply / inject 为空', () => {
  assert.equal(mod.name, 'dsh-plugin-session-popout')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, [])
})

// ── URL 与判定 ────────────────────────────────────────────────────────────
check('小窗 URL：打上 yintx_popout=1 且原样保留 token 与其它参数', () => {
  const href = 'http://127.0.0.1:19387/?token=SECRET&profile=desktop#leaf'
  const url = new URL(mod.buildPopoutUrl(href))
  assert.equal(url.searchParams.get('token'), 'SECRET', 'token 必须保留（新窗口靠它认证）')
  assert.equal(url.searchParams.get('profile'), 'desktop')
  assert.equal(url.searchParams.get(mod.FLAG_PARAM), '1')
  assert.equal(url.hash, '#leaf')
})

check('小窗 URL：坏地址原样返回、不抛', () => {
  assert.equal(mod.buildPopoutUrl('not a url'), 'not a url')
})

check('isPopoutLocation 只认 yintx_popout=1', () => {
  assert.equal(mod.isPopoutLocation('http://x/?yintx_popout=1'), true)
  assert.equal(mod.isPopoutLocation('http://x/?yintx_popout=0'), false)
  assert.equal(mod.isPopoutLocation('http://x/'), false)
  assert.equal(mod.isPopoutLocation('nonsense'), false)
})

check('popoutFeatures：带 popup 标记、尺寸按配置、位置不出屏幕', () => {
  const features = mod.popoutFeatures({ width: 520, height: 760 }, { width: 1440, height: 900 })
  assert.match(features, /^popup=yes,width=520,height=760,left=\d+,top=\d+$/)
  const left = Number(/left=(\d+)/.exec(features)[1])
  assert.ok(left >= 0 && left <= 1440 - 520 + 200, `left 应在屏幕内：${left}`)
})

check('dragReached：阈值按欧氏距离，脏值不误判', () => {
  assert.equal(mod.dragReached(0, 0), false)
  assert.equal(mod.dragReached(59, 0), false)
  assert.equal(mod.dragReached(60, 0), true)
  assert.equal(mod.dragReached(40, 50), true, '3-4-5 斜向也应按距离算（≈64）')
  assert.equal(mod.dragReached(Number.NaN, 10), false)
})

check('resolveConfig：脏值回落默认、布尔严格、mode 只认已知取值', () => {
  const config = mod.resolveConfig({ width: 100, height: 'x', slim: 'yes', reuse: true })
  assert.equal(config.width, 320, '低于下限夹到 320')
  assert.equal(config.height, mod.DEFAULT_CONFIG.height)
  assert.equal(config.slim, false, '只有真正的 true 才算开')
  assert.equal(config.reuse, true)
  assert.equal(config.mode, 'inline', '没写 mode 时默认内嵌（桌面端 window.open 静默失效）')
  assert.deepEqual(mod.resolveConfig(null), { ...mod.DEFAULT_CONFIG })
  assert.equal(mod.resolveConfig({ mode: 'window' }).mode, 'window')
  assert.equal(mod.resolveConfig({ mode: 'auto' }).mode, 'auto')
  assert.equal(mod.resolveConfig({ mode: 'nonsense' }).mode, 'inline', '乱写的 mode 回落默认')
})

// ── 内嵌小窗几何 ──────────────────────────────────────────────────────────
check('resolveInlineGeometry：默认落在视口内、尺寸夹紧、脏值回落', () => {
  const geom = mod.resolveInlineGeometry(null, { width: 1280, height: 800 })
  assert.equal(geom.width, mod.INLINE_DEFAULT.width)
  assert.equal(geom.height, mod.INLINE_DEFAULT.height)
  assert.equal(geom.left, 1280 - geom.width - 24)
  assert.ok(geom.top >= 16 && geom.top + geom.height <= 800, `应落在视口内：${JSON.stringify(geom)}`)

  const small = mod.resolveInlineGeometry({ width: 10, height: 10 }, { width: 800, height: 600 })
  assert.equal(small.width, 320)
  assert.equal(small.height, 240)

  const wild = mod.resolveInlineGeometry({ left: 99999, top: -99999, width: 'x' }, { width: 1000, height: 700 })
  assert.ok(wild.left <= 1000 - 80, `left 应留在视口内：${wild.left}`)
  assert.equal(wild.top, 0)
  assert.equal(wild.width, mod.INLINE_DEFAULT.width)
})

// ── 胶囊视图 ──────────────────────────────────────────────────────────────
check('主窗口视图：挂在 body 上，含胶囊 / 提示条 / 可见反馈条', () => {
  const doc = createFakeDocument()
  const view = mod.createLauncher(doc, 'main', {})
  assert.equal(doc.body.children.length, 1)
  assert.equal(view.root.getAttribute('data-dsh-plugin'), 'session-popout')
  assert.equal(view.getMode(), 'main')
  const parts = view.root.children.map((node) => node.getAttribute('data-dsh-part'))
  assert.deepEqual(parts, ['popout-launcher', 'popout-hint', 'popout-toast'])
})

check('主窗口视图：toast 能弹能收（开窗方式回退时的可见反馈）', () => {
  const doc = createFakeDocument()
  const view = mod.createLauncher(doc, 'main', {})
  assert.equal(view.root.getAttribute('data-toast'), null)
  view.showToast('系统弹窗不可用，已改用内嵌小窗', 9000)
  assert.equal(view.root.getAttribute('data-toast'), 'true')
  assert.match(view.toast.textContent, /内嵌小窗/)
  view.hideToast()
  assert.equal(view.root.getAttribute('data-toast'), 'false')
  view.destroy()
})

// ── 内嵌小窗视图 ──────────────────────────────────────────────────────────
check('内嵌小窗：show 才挂进 body，iframe 指向带标记的地址；hide 摘掉并清空 src', () => {
  const doc = createFakeDocument()
  const geometries = []
  const view = mod.createInlineWindow(doc, { onGeometry: (geom, reason) => geometries.push([geom, reason]) })
  assert.equal(doc.body.children.length, 0, '构造时不该进 DOM')
  assert.equal(view.isOpen(), false)

  const geom = view.show('http://x/?token=t&yintx_popout=1')
  assert.equal(doc.body.children.length, 1)
  assert.equal(view.isOpen(), true)
  assert.equal(view.root.getAttribute('data-role'), 'inline')
  assert.equal(view.frame.getAttribute('src'), 'http://x/?token=t&yintx_popout=1')
  assert.equal(geom.width, mod.INLINE_DEFAULT.width)

  view.show('http://x/?token=t&yintx_popout=1&again=1')
  assert.equal(doc.body.children.length, 1, '重复 show 不该叠出两个小窗')
  assert.match(view.frame.getAttribute('src'), /again=1/)

  view.hide('test')
  assert.equal(doc.body.children.length, 0)
  assert.equal(view.isOpen(), false)
  assert.equal(view.frame.getAttribute('src'), 'about:blank', '关闭应释放那条连接')
  assert.equal(geometries.at(-1)[1], 'test')
})

check('内嵌小窗：拖标题栏与拖右下角手柄都改几何', () => {
  const doc = createFakeDocument()
  const view = mod.createInlineWindow(doc, {})
  view.show('about:blank')
  const before = view.getGeometry()

  const bar = view.win.children.find((node) => node.getAttribute('data-dsh-part') === 'inline-bar')
  bar.dispatch('pointerdown', { button: 0, clientX: 200, clientY: 200 })
  doc.defaultView.dispatch('pointermove', { clientX: 140, clientY: 150 })
  doc.defaultView.dispatch('pointerup', { clientX: 140, clientY: 150 })
  const afterDrag = view.getGeometry()
  assert.equal(afterDrag.left, before.left - 60)
  assert.equal(afterDrag.top, before.top - 50)

  const handle = view.win.children.find((node) => node.getAttribute('data-dir') === 'se')
  handle.dispatch('pointerdown', { button: 0, clientX: 500, clientY: 500 })
  doc.defaultView.dispatch('pointermove', { clientX: 560, clientY: 520 })
  doc.defaultView.dispatch('pointerup', { clientX: 560, clientY: 520 })
  const afterResize = view.getGeometry()
  assert.equal(afterResize.width, afterDrag.width + 60)
  assert.equal(afterResize.height, afterDrag.height + 20)
})

check('内嵌小窗：控制按钮各司其职（刷新 / 弹出 / 关闭）', () => {
  const doc = createFakeDocument()
  const calls = []
  const view = mod.createInlineWindow(doc, { onDetach: () => calls.push('detach'), onClose: () => calls.push('close') })
  view.show('about:blank')
  const button = (ctl) => view.win.children
    .find((node) => node.getAttribute('data-dsh-part') === 'inline-bar')
    .children.flatMap((node) => node.children ?? [])
    .find((node) => node.getAttribute('data-ctl') === ctl)
  button('refresh').dispatch('click')
  button('detach').dispatch('click')
  button('close').dispatch('click')
  assert.deepEqual(calls, ['detach', 'close'])
  assert.equal(view.isOpen(), false, '点关闭后小窗应摘掉')
})

check('内嵌小窗：标题栏上的按钮不会触发拖动', () => {
  const doc = createFakeDocument()
  const view = mod.createInlineWindow(doc, {})
  view.show('about:blank')
  const before = view.getGeometry()
  const bar = view.win.children.find((node) => node.getAttribute('data-dsh-part') === 'inline-bar')
  const closeBtn = flatten(bar).find((node) => node.getAttribute('data-ctl') === 'close')
  assert.ok(closeBtn, '标题栏里应有 close 按钮')
  bar.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, target: closeBtn })
  doc.defaultView.dispatch('pointermove', { clientX: 300, clientY: 300 })
  assert.deepEqual(view.getGeometry(), before, '点在按钮上不该拖动')
  view.destroy()
})

// ── 会话重命名 ────────────────────────────────────────────────────────────
check('currentSessionId 只认 retainedBy.mainView > 0', () => {
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 0 } }, b: { retainedBy: { mainView: 2 } } } }),
    },
  }
  assert.equal(mod.currentSessionId(sessions), 'b')
  assert.equal(mod.currentSessionId(null), undefined)
  assert.equal(mod.currentSessionId({ list: { getSnapshot: () => null } }), undefined)
})

await checkAsync('renameSession：走 sessions.rename，成功/失败/脏输入各自的返回值', async () => {
  const calls = []
  const sessions = {
    rename: async (sessionId, title) => {
      calls.push([sessionId, title])
      return title === '好名字' ? { ok: true } : { ok: false, error: 'nope' }
    },
  }
  assert.equal(await mod.renameSession(sessions, 's1', '  好名字  '), true, '两边空白应被 trim 再提交')
  assert.deepEqual(calls[0], ['s1', '好名字'])
  assert.equal(await mod.renameSession(sessions, 's1', '坏名字'), false, '宿主拒绝时回 false')
  assert.equal(await mod.renameSession(sessions, 's1', '   '), false, '空标题不发起请求')
  assert.equal(await mod.renameSession(sessions, 's1', 'x'.repeat(121)), false, '超长不发起请求')
  assert.equal(await mod.renameSession(sessions, undefined, '名字'), false, '没有会话不发起请求')
  assert.equal(calls.length, 2)
})

await checkAsync('renameSession：退回 binding.session.rename；抛错/缺失都只回 false', async () => {
  const sessions = { binding: () => ({ session: { rename: async (title) => ({ ok: title === 'ok' }) } }) }
  assert.equal(await mod.renameSession(sessions, 's1', 'ok'), true)
  assert.equal(await mod.renameSession(sessions, 's1', 'no'), false)
  const throwing = { rename: async () => { throw new Error('boom') } }
  assert.equal(await mod.renameSession(throwing, 's1', '名字'), false)
  assert.equal(await mod.renameSession({}, 's1', '名字'), false)
})

await checkAsync('内嵌小窗：✎ 就地重命名（Enter 提交成功改标题 / 失败保留并反馈 / Esc 取消）', async () => {
  const doc = createFakeDocument()
  const failed = []
  const received = []
  let accept = true
  const view = mod.createInlineWindow(doc, {
    onRename: (next) => {
      received.push(next)
      return accept
    },
    onRenameFailed: (next) => failed.push(next),
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  view.setTitle('旧标题')
  view.show('about:blank')
  const bar = view.win.children.find((node) => node.getAttribute('data-dsh-part') === 'inline-bar')
  const renameBtn = flatten(bar).find((node) => node.getAttribute('data-ctl') === 'rename')
  const input = flatten(bar).find((node) => node.getAttribute('data-ctl') === 'rename-input')
  assert.ok(renameBtn && input, '标题栏里应有 ✎ 与内联输入框')

  // 进入输入态：标题隐藏、输入框预填当前标题
  assert.equal(view.isRenaming(), false)
  renameBtn.dispatch('click')
  assert.equal(view.isRenaming(), true)
  assert.equal(input.value, '旧标题')
  assert.equal(view.root.getAttribute('data-renaming'), 'true')

  // Enter 提交成功：退出输入态、标题更新
  input.value = '新标题'
  input.dispatch('keydown', { key: 'Enter' })
  await flush()
  assert.equal(view.isRenaming(), false)
  assert.equal(view.getTitle(), '新标题')
  assert.match(bar.textContent, /新标题/)
  assert.deepEqual(received, ['新标题'], '提交的应是 trim 后的标题')

  // 失败：退出输入态、标题不动、宿主收到反馈
  accept = false
  renameBtn.dispatch('click')
  input.value = '不会成功的名字'
  input.dispatch('keydown', { key: 'Enter' })
  await flush()
  assert.equal(view.isRenaming(), false)
  assert.equal(view.getTitle(), '新标题', '失败不该改标题')
  assert.deepEqual(failed, ['不会成功的名字'])

  // Esc 取消
  view.beginRename()
  input.dispatch('keydown', { key: 'Escape' })
  assert.equal(view.isRenaming(), false)
  assert.equal(view.getTitle(), '新标题')
  view.destroy()
})

check('主窗口视图：点一下胶囊触发开窗', () => {
  const doc = createFakeDocument()
  const reasons = []
  const view = mod.createLauncher(doc, 'main', { onPopout: (reason) => reasons.push(reason) })
  view.launcher.dispatch('click')
  assert.deepEqual(reasons, ['click'])
})

check('主窗口视图：拖出 60px 松手 → 提示条亮起并触发开窗（且不再重复触发 click）', () => {
  const doc = createFakeDocument()
  const reasons = []
  const view = mod.createLauncher(doc, 'main', { onPopout: (reason) => reasons.push(reason) })
  view.launcher.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100 })
  doc.defaultView.dispatch('pointermove', { clientX: 140, clientY: 130 })
  assert.equal(view.root.getAttribute('data-hinting'), 'false', '还没到阈值不该提示')
  doc.defaultView.dispatch('pointermove', { clientX: 180, clientY: 120 })
  assert.equal(view.root.getAttribute('data-hinting'), 'true', '过了阈值应给出「松手开小窗」提示')
  doc.defaultView.dispatch('pointerup', { clientX: 180, clientY: 120 })
  assert.deepEqual(reasons, ['drag'])
  assert.equal(view.root.getAttribute('data-hinting'), 'false', '松手后提示应消失')
  view.launcher.dispatch('click')
  assert.deepEqual(reasons, ['drag'], '紧随拖拽的 click 应被吞掉，不能开两次窗')
  view.launcher.dispatch('click')
  assert.deepEqual(reasons, ['drag', 'click'], '再点一下才应该重新开窗')
})

check('主窗口视图：拖不到阈值 → 不开窗、提示不亮', () => {
  const doc = createFakeDocument()
  const reasons = []
  const view = mod.createLauncher(doc, 'main', { onPopout: (reason) => reasons.push(reason) })
  view.launcher.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100 })
  doc.defaultView.dispatch('pointermove', { clientX: 114, clientY: 118 })
  doc.defaultView.dispatch('pointerup', { clientX: 114, clientY: 118 })
  assert.deepEqual(reasons, [])
  assert.equal(view.root.getAttribute('data-hinting'), 'false')
})

check('小窗视图：两条动作按钮各自回调', () => {
  const doc = createFakeDocument()
  const calls = []
  const view = mod.createLauncher(doc, 'popout', {
    onBackToMain: () => calls.push('back'),
    onCloseWindow: () => calls.push('close'),
  })
  assert.equal(view.getMode(), 'popout')
  const buttons = view.root.children
  assert.equal(buttons.length, 2)
  buttons[0].dispatch('click')
  buttons[1].dispatch('click')
  assert.deepEqual(calls, ['back', 'close'])
  view.destroy()
  assert.equal(doc.body.children.length, 0)
})

// ── 配置持久化 ────────────────────────────────────────────────────────────
check('localStorage 配置读写；坏 JSON 回 null', () => {
  const store = new Map()
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
  assert.equal(mod.readLocalConfig(storage), null)
  assert.equal(mod.writeLocalConfig(storage, { width: 600 }), true)
  assert.deepEqual(mod.readLocalConfig(storage), { width: 600 })
  store.set(mod.CONFIG_KEY, '{{')
  assert.equal(mod.readLocalConfig(storage), null)
})

// ── openPopout ────────────────────────────────────────────────────────────
check('openPopout：用固定窗口名与 features 调 window.open，并聚焦新窗口', () => {
  const view = new FakeWindow()
  const handle = mod.openPopout('http://x/?token=t&yintx_popout=1', { width: 500, height: 700 }, view)
  assert.equal(view.openCalls.length, 1)
  assert.equal(view.openCalls[0].name, mod.WINDOW_NAME)
  assert.match(view.openCalls[0].features, /popup=yes,width=500,height=700/)
  assert.ok(handle !== null)
})

check('openPopout：被拦截（open 返回 null）时返回 null 且不抛', () => {
  const view = new FakeWindow()
  view.open = () => null
  assert.equal(mod.openPopout('http://x/', { width: 500, height: 700 }, view), null)
})

// ── apply 全链路 ──────────────────────────────────────────────────────────
await checkAsync('apply（主窗口，mode=inline 默认）：快捷键开的是**内嵌小窗**而不是系统弹窗', async () => {
  const doc = createFakeDocument()
  globalThis.document = doc
  globalThis.location = doc.defaultView.location
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
  let hostConfigReads = 0
  globalThis.fetch = async () => {
    hostConfigReads += 1
    return { ok: true, json: async () => ({ ok: true, config: { width: 600, height: 800, slim: false, reuse: true } }) }
  }

  const disposers = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  await mod.apply(ctx)
  assert.equal(doc.head.children.length, 1, '样式应注入')
  assert.equal(doc.body.children.length, 1, '胶囊应挂上')
  assert.equal(hostConfigReads, 1, '本地没有配置时应读一次宿主配置')

  doc.defaultView.dispatch('keydown', { altKey: true, shiftKey: true, key: 'P' })
  assert.equal(doc.defaultView.openCalls.length, 0, '默认 mode=inline：不该走系统弹窗（桌面端会被静默吞掉）')
  const inlineRoot = doc.body.children.find((node) => node.getAttribute('data-role') === 'inline')
  assert.ok(inlineRoot, '应出现内嵌小窗')
  const frame = inlineRoot.children
    .find((node) => node.getAttribute('data-dsh-part') === 'inline-win')
    .children.find((node) => node.getAttribute('data-dsh-part') === 'inline-frame')
  assert.match(frame.getAttribute('src'), /yintx_popout=1/, '内嵌小窗应指向带标记的地址')

  // 几何写进了 INLINE_KEY（持久化）
  assert.ok(store.has(mod.INLINE_KEY), '内嵌小窗几何应被记住')

  // 内嵌小窗里的浮条按钮通过 postMessage 请父窗口关闭
  doc.defaultView.dispatch('message', {
    data: { type: `${mod.MSG_PREFIX}close` },
    origin: doc.defaultView.location.origin,
  })
  assert.equal(
    doc.body.children.some((node) => node.getAttribute('data-role') === 'inline'),
    false,
    '收到子窗 close 消息应关掉内嵌小窗',
  )

  for (const dispose of disposers) dispose()
  assert.equal(doc.body.children.length, 0, '卸载后胶囊应移除')
  assert.equal(doc.head.children.length, 0, '卸载后样式应移除')
  delete globalThis.document
  delete globalThis.location
  delete globalThis.localStorage
  delete globalThis.fetch
})

await checkAsync('apply（主窗口，mode=window）：坚持系统弹窗；被拒时自动回退内嵌并给可见提示', async () => {
  const doc = createFakeDocument()
  globalThis.document = doc
  globalThis.location = doc.defaultView.location
  const store = new Map([
    [mod.CONFIG_KEY, JSON.stringify({ mode: 'window' })],
  ])
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: null }) })

  const disposers = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }

  await mod.apply(ctx)
  // 先让 window.open 成功一次
  doc.defaultView.dispatch('keydown', { altKey: true, shiftKey: true, key: 'P' })
  assert.equal(doc.defaultView.openCalls.length, 1, 'mode=window 应先试系统弹窗')
  assert.equal(
    doc.body.children.some((node) => node.getAttribute('data-role') === 'inline'),
    false,
    '弹窗成功时不该同时开内嵌',
  )

  // 再让 window.open 被拒 → 回退内嵌 + 可见提示
  doc.defaultView.open = () => null
  doc.defaultView.dispatch('keydown', { altKey: true, shiftKey: true, key: 'P' })
  assert.equal(
    doc.body.children.some((node) => node.getAttribute('data-role') === 'inline'),
    true,
    '弹窗被拒应回退到内嵌小窗',
  )
  const capsule = doc.body.children.find((node) => node.getAttribute('data-role') !== 'inline')
  assert.equal(capsule.getAttribute('data-toast'), 'true', '回退时应给出可见提示')
  assert.match(capsule.children.find((node) => node.getAttribute('data-dsh-part') === 'popout-toast').textContent, /内嵌小窗/)

  for (const dispose of disposers) dispose()
  delete globalThis.document
  delete globalThis.location
  delete globalThis.localStorage
  delete globalThis.fetch
})

await checkAsync('apply（小窗）：打 html 标记 + 精简样式 + 回到/关闭按钮', async () => {
  const doc = createFakeDocument('http://127.0.0.1:19387/?token=SECRET&yintx_popout=1')
  globalThis.document = doc
  globalThis.opener = { focus() {} }
  const disposers = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  await mod.apply(ctx)
  assert.equal(doc.documentElement.getAttribute('data-yintx-popout'), '1')
  assert.equal(doc.body.children.length, 1)
  const parts = doc.body.children[0].children.map((node) => node.getAttribute('data-dsh-part'))
  assert.deepEqual(parts, ['popout-action', 'popout-action'])
  const css = doc.head.children[0].textContent
  assert.match(css, /data-yintx-popout="1"/, '精简样式应以 html 标记为门控')

  for (const dispose of disposers) dispose()
  assert.equal(doc.documentElement.getAttribute('data-yintx-popout'), null, '卸载后应摘掉标记')
  delete globalThis.document
  delete globalThis.opener
})

for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed === 0 ? 0 : 1)

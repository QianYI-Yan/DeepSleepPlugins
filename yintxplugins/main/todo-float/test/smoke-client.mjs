/**
 * dsh-plugin-todo-float 客户端半冒烟测试：`node test/smoke-client.mjs`
 *
 * 客户端半是经典脚本 bundle（`window.__ModuleLoader__.load`），当 ESM 解析也只会执行那一次注册，
 * 所以这里直接 `import()` 它，再从一个**极简 DOM stub** 上把整棵树建出来跑：
 *   - 注册 id / factory 形状；
 *   - 几何纯函数：默认落右下角、夹紧、最小尺寸、八向缩放、最大化；
 *   - 官方 TodoItem[] → 视图模型的投影（过滤空串、未知状态回落 pending、计数）；
 *   - 视图：列表条目与 data-status、进度条宽度、关闭→胶囊→恢复、最大化/最小化按钮；
 *   - 数据源：会话切换重新绑定、投影变化触发回调；
 *   - apply 全链路：localStorage 坏值 → 宿主兜底 → 挂载 → 卸载清理。
 *
 * 全部断言不依赖浏览器、不装任何包。
 */
import assert from 'node:assert/strict'

// ── 极简 DOM stub ─────────────────────────────────────────────────────────
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

  /** 触发一次事件（测试用；事件对象给出最小可用字段）。 */
  dispatch(type, extra = {}) {
    const event = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
      ...extra,
    }
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  /** 只认 `[data-ctl]`（client 里唯一的 closest 用法）。 */
  closest(selector) {
    if (selector !== '[data-ctl]') return null
    let node = this
    while (node) {
      if (node.getAttribute?.('data-ctl')) return node
      node = node.parentNode
    }
    return null
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
    this.innerWidth = 1280
    this.innerHeight = 800
    this.location = { href }
    this.listeners = new Map()
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
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...extra })
  }
}

function createFakeDocument(href) {
  const doc = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    defaultView: new FakeWindow(href),
    createElement: (tag) => new FakeElement(tag),
    querySelector: () => null,
  }
  return doc
}

// ── 加载客户端 bundle ─────────────────────────────────────────────────────
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

await import(new URL('../client.js', import.meta.url).href)

const mod = registered?.factory?.(() => {
  throw new Error('客户端半不该 require 任何模块')
})

check('loader 注册 id 与包名一致', () => assert.equal(registered?.id, 'dsh-plugin-todo-float'))
check('factory 是函数并导出 { name, apply }', () => {
  assert.equal(typeof registered?.factory, 'function')
  assert.equal(mod?.name, 'dsh-plugin-todo-float')
  assert.equal(typeof mod?.apply, 'function')
  assert.deepEqual(mod?.inject, [], 'inject 必须为空数组：席位在 apply 里探测')
})

// ── 几何纯函数 ────────────────────────────────────────────────────────────
check('默认几何落在右下角且不小于最小尺寸', () => {
  const geom = mod.resolveGeometry(null, { width: 1280, height: 800 })
  assert.equal(geom.width, 330)
  assert.equal(geom.height, 420)
  assert.equal(geom.left, 1280 - 330 - 24)
  assert.equal(geom.top, 800 - 420 - 48)
})

check('脏几何：非法字段回落、尺寸夹到最小值、越界位置拉回可见', () => {
  const geom = mod.resolveGeometry({ left: 'abc', top: -99999, width: 10, height: 'NaN', maximized: 'yes' }, { width: 1000, height: 700 })
  assert.equal(geom.width, mod.MIN_WIDTH, '数值合法但过小 → 夹到最小宽度')
  assert.equal(geom.height, 420, '完全解析不出的高度 → 回落默认高度')
  assert.equal(geom.top, 0)
  assert.equal(geom.maximized, false, '非布尔 true 不算最大化')
  assert.ok(geom.left <= 1000 - 96, `left 应留在视口内：${geom.left}`)
  const small = mod.resolveGeometry({ width: 10, height: 10 }, { width: 1000, height: 700 })
  assert.equal(small.width, mod.MIN_WIDTH)
  assert.equal(small.height, mod.MIN_HEIGHT)
})

check('拖动不会把窗口拖出视口（保持标题栏可见）', () => {
  const start = mod.resolveGeometry({ left: 100, top: 100, width: 300, height: 300 }, { width: 1000, height: 700 })
  const moved = mod.dragGeometry(start, 99999, 99999, { width: 1000, height: 700 })
  assert.equal(moved.left, 1000 - 96)
  assert.equal(moved.top, 700 - mod.TITLEBAR_HEIGHT)
  const back = mod.dragGeometry(start, -99999, -99999, { width: 1000, height: 700 })
  assert.equal(back.left, 96 - 300)
  assert.equal(back.top, 0)
})

check('八向缩放：右/下只改尺寸，左/上同时移动原点', () => {
  const start = mod.resolveGeometry({ left: 200, top: 200, width: 300, height: 300 }, { width: 1200, height: 900 })
  const se = mod.resizeGeometry(start, 'se', 50, 40, { width: 1200, height: 900 })
  assert.equal(se.width, 350)
  assert.equal(se.height, 340)
  assert.equal(se.left, 200)
  assert.equal(se.top, 200)

  const nw = mod.resizeGeometry(start, 'nw', -40, -30, { width: 1200, height: 900 })
  assert.equal(nw.width, 340)
  assert.equal(nw.height, 330)
  assert.equal(nw.left, 160)
  assert.equal(nw.top, 170)

  const tiny = mod.resizeGeometry(start, 'se', -9999, -9999, { width: 1200, height: 900 })
  assert.equal(tiny.width, mod.MIN_WIDTH)
  assert.equal(tiny.height, mod.MIN_HEIGHT)
})

check('最大化铺满视口并留边距', () => {
  const geom = mod.maximizeGeometry({ width: 1000, height: 700 })
  assert.equal(geom.maximized, true)
  assert.equal(geom.collapsed, false)
  assert.equal(geom.width, 1000 - 48)
  assert.equal(geom.height, 700 - 48)
})

// ── 投影 ──────────────────────────────────────────────────────────────────
check('TodoItem[] 投影：过滤空条目、未知状态回落 pending、计数正确', () => {
  const view = mod.projectTodos([
    { content: '写插件', status: 'in_progress' },
    { content: '  ', status: 'pending' },
    { content: '跑测试', status: 'completed' },
    { content: '写文档', status: 'weird' },
    'not-an-object',
  ])
  assert.deepEqual(view.items, [
    { content: '写插件', status: 'in_progress' },
    { content: '跑测试', status: 'completed' },
    { content: '写文档', status: 'pending' },
  ])
  assert.equal(view.total, 3)
  assert.equal(view.done, 1)
  assert.equal(view.active, 1)
  assert.equal(view.pending, 1)
  assert.equal(view.hasActive, true)
})

check('null / 非数组投影收敛成空清单', () => {
  assert.deepEqual(mod.projectTodos(null).items, [])
  assert.deepEqual(mod.projectTodos(undefined).total, 0)
  assert.deepEqual(mod.projectTodos('x').items, [])
})

// ── goal 投影 ─────────────────────────────────────────────────────────────
check('goal 投影：正常目标 → 视图模型（阶段 / 轮次 / 受阻原因）', () => {
  const goal = mod.projectGoal({
    goal: {
      id: 'g1',
      revision: 3,
      objective: '  把插件做完  ',
      phase: 'blocked',
      maxGoalRounds: 8,
      blockedReason: { code: 'waiting', message: '等用户确认' },
    },
    roundsStarted: 2,
    createdAt: 1,
    updatedAt: 2,
  })
  assert.equal(goal.objective, '把插件做完')
  assert.equal(goal.phase, 'blocked')
  assert.equal(goal.roundsStarted, 2)
  assert.equal(goal.maxGoalRounds, 8)
  assert.equal(goal.blockedReason, '等用户确认')
})

check('goal 投影：没有目标 / 空目标 / 脏值 → null，未知阶段回落 active', () => {
  assert.equal(mod.projectGoal(null), null)
  assert.equal(mod.projectGoal(undefined), null)
  assert.equal(mod.projectGoal({}), null)
  assert.equal(mod.projectGoal({ goal: null }), null)
  assert.equal(mod.projectGoal({ goal: { objective: '   ', phase: 'active' } }), null)
  const fallback = mod.projectGoal({ goal: { objective: 'x', phase: 'weird', maxGoalRounds: 0 }, roundsStarted: 'x' })
  assert.equal(fallback.phase, 'active')
  assert.equal(fallback.maxGoalRounds, 1)
  assert.equal(fallback.roundsStarted, 0)
})

check('goalMeta：四个阶段各自的中文标签与语气', () => {
  assert.equal(mod.goalMeta('active').label, '进行中')
  assert.equal(mod.goalMeta('paused').label, '已暂停')
  assert.equal(mod.goalMeta('blocked').label, '受阻')
  assert.equal(mod.goalMeta('complete').label, '已完成')
})

check('视图：goal 行有目标才显示、阶段徽章上色、轮次显示 已用/上限', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  const goalRow = collect(view.root).filter((node) => node.getAttribute('data-dsh-part') === 'goal')[0]
  assert.equal(goalRow.getAttribute('data-empty'), 'true', '默认隐藏')
  view.setState({
    ...mod.projectTodos([]),
    goal: { objective: '写文档', phase: 'paused', roundsStarted: 1, maxGoalRounds: 5, blockedReason: '' },
    source: 'projection',
  })
  assert.equal(goalRow.getAttribute('data-empty'), 'false')
  const phase = collect(view.root).filter((node) => node.getAttribute('data-dsh-part') === 'goal-phase')[0]
  assert.equal(phase.getAttribute('data-phase'), 'paused')
  assert.equal(
    collect(view.root).filter((node) => node.getAttribute('data-dsh-part') === 'goal-rounds')[0].textContent,
    '1/5',
  )
  assert.match(goalRow.textContent, /写文档/)
})

// ── 视图 ──────────────────────────────────────────────────────────────────
check('视图建树：标题栏三个按钮 + 八向手柄 + 列表 + 状态栏', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  const find = (part) => view.root.children.length >= 0 && collect(view.root).filter((node) => node.getAttribute('data-dsh-part') === part)
  const controls = collect(view.root).filter((node) => node.getAttribute('data-dsh-part') === 'controls')[0]
  assert.equal(view.root.getAttribute('data-dsh-plugin'), 'todo-float')
  assert.equal(controls.children.length, 3, '应有最小化/最大化/关闭三个按钮')
  assert.equal(find('resize').length, 8, '应有八个缩放手柄')
  assert.equal(find('list').length, 1)
  assert.equal(find('launcher').length, 1)
})

check('视图状态：条目按状态着色、进度条按完成率、计数正确', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  view.setState({
    ...mod.projectTodos([
      { content: '正在做的事', status: 'in_progress' },
      { content: '做完的事', status: 'completed' },
    ]),
    sessionTitle: '测试会话',
    source: 'projection',
    updatedAt: '10:00:00',
  })
  const nodes = collect(view.root)
  const items = nodes.filter((node) => node.getAttribute('data-dsh-part') === 'item')
  assert.equal(items.length, 2)
  assert.equal(items[0].getAttribute('data-status'), 'in_progress')
  assert.equal(items[1].getAttribute('data-status'), 'completed')
  assert.match(items[0].textContent, /正在做的事/)
  const fill = nodes.filter((node) => node.getAttribute('data-dsh-part') === 'progress-fill')[0]
  assert.equal(fill.style.width, '50%')
  assert.match(nodes.filter((node) => node.getAttribute('data-dsh-part') === 'session')[0].textContent, /测试会话/)
})

check('空清单给提示文案', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  view.setState({ ...mod.projectTodos(null), source: 'projection' })
  const empty = collect(view.root).filter((node) => node.getAttribute('data-dsh-part') === 'empty')
  assert.equal(empty.length, 1)
  assert.match(empty[0].textContent, /暂无待办/)
})

check('关闭 → 胶囊 → 点胶囊恢复', () => {
  const doc = createFakeDocument()
  const closed = []
  const view = mod.createView(doc, { onClose: () => closed.push(true) })
  const nodes = collect(view.root)
  const closeBtn = nodes.find((node) => node.getAttribute('data-ctl') === 'close')
  closeBtn.dispatch('click')
  assert.equal(view.isHidden(), true)
  assert.equal(closed.length, 1)
  view.launcher.dispatch('click')
  assert.equal(view.isHidden(), false)
})

check('最大化 / 最小化按钮改几何并通知外部', () => {
  const doc = createFakeDocument()
  const seen = []
  const view = mod.createView(doc, { onGeometry: (geom, reason) => seen.push([geom, reason]) })
  const nodes = collect(view.root)
  nodes.find((node) => node.getAttribute('data-ctl') === 'maximize').dispatch('click')
  assert.equal(view.getGeometry().maximized, true)
  assert.equal(seen.at(-1)[1], 'maximize')
  nodes.find((node) => node.getAttribute('data-ctl') === 'maximize').dispatch('click')
  assert.equal(view.getGeometry().maximized, false)
  assert.equal(seen.at(-1)[1], 'restore')
  nodes.find((node) => node.getAttribute('data-ctl') === 'collapse').dispatch('click')
  assert.equal(view.getGeometry().collapsed, true)
  assert.equal(seen.at(-1)[1], 'collapse')
})

check('双击标题栏切换最大化', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  const bar = collect(view.root).find((node) => node.getAttribute('data-dsh-part') === 'titlebar')
  bar.dispatch('dblclick')
  assert.equal(view.getGeometry().maximized, true)
})

check('拖动标题栏：pointer 事件走完 move → up，几何随之改变', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  view.setGeometry(mod.resolveGeometry({ left: 100, top: 100, width: 300, height: 300 }, { width: 1280, height: 800 }))
  const bar = collect(view.root).find((node) => node.getAttribute('data-dsh-part') === 'titlebar')
  bar.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  doc.defaultView.dispatch('pointermove', { clientX: 160, clientY: 130 })
  doc.defaultView.dispatch('pointerup', { clientX: 160, clientY: 130 })
  assert.equal(view.getGeometry().left, 160)
  assert.equal(view.getGeometry().top, 130)
})

check('标题栏上的按钮不触发拖动', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  view.setGeometry(mod.resolveGeometry({ left: 100, top: 100, width: 300, height: 300 }, { width: 1280, height: 800 }))
  const nodes = collect(view.root)
  const closeBtn = nodes.find((node) => node.getAttribute('data-ctl') === 'close')
  const bar = nodes.find((node) => node.getAttribute('data-dsh-part') === 'titlebar')
  bar.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, target: closeBtn, pointerId: 1 })
  doc.defaultView.dispatch('pointermove', { clientX: 400, clientY: 400 })
  assert.equal(view.getGeometry().left, 100, '点在按钮上不应拖动窗口')
  assert.equal(view.isHidden(), false, 'pointerdown 不该触发点击')
})

check('视口变小后窗口被拉回可见范围', () => {
  const doc = createFakeDocument()
  const view = mod.createView(doc, {})
  view.setGeometry(mod.resolveGeometry({ left: 900, top: 600, width: 300, height: 300 }, { width: 1280, height: 800 }))
  doc.defaultView.innerWidth = 600
  doc.defaultView.innerHeight = 500
  doc.defaultView.dispatch('resize')
  const geom = view.getGeometry()
  assert.ok(geom.left <= 600 - 96, `left 应在新的视口内：${geom.left}`)
  assert.ok(geom.top <= 500 - mod.TITLEBAR_HEIGHT)
})

// ── 数据源 ────────────────────────────────────────────────────────────────
function fakeSessions(initialTodos, sessionId = 's-1') {
  let todos = initialTodos
  let current = sessionId
  const faceListeners = new Set()
  const listListeners = new Set()
  const face = {
    getSnapshot: () => todos,
    subscribe: (fn) => {
      faceListeners.add(fn)
      return () => faceListeners.delete(fn)
    },
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: current === undefined ? {} : { [current]: { id: current, title: '会话标题', retainedBy: { mainView: 1 } } } }),
      subscribe: (fn) => {
        listListeners.add(fn)
        return () => listListeners.delete(fn)
      },
    },
    binding: (id) => (id === undefined || id !== current ? undefined : { sessionId: id, session: { projections: { faceOf: (key) => (key === 'todos' ? face : undefined) } } }),
  }
  return {
    sessions,
    setTodos(next) {
      todos = next
      for (const fn of [...faceListeners]) fn()
    },
    switchTo(id) {
      current = id === null ? undefined : id
      for (const fn of [...listListeners]) fn()
    },
  }
}

check('数据源：初次读取即拿到当前会话待办', () => {
  const hub = fakeSessions([{ content: 'A', status: 'pending' }])
  const seen = []
  const sub = mod.subscribeTodos(hub.sessions, (payload) => seen.push(payload))
  assert.equal(seen.length >= 1, true)
  assert.equal(seen.at(-1).source, 'projection')
  assert.equal(seen.at(-1).total, 1)
  assert.equal(seen.at(-1).sessionTitle, '会话标题')
  sub.dispose()
})

check('数据源：投影变化触发回调（实时性）', () => {
  const hub = fakeSessions([{ content: 'A', status: 'pending' }])
  const seen = []
  const sub = mod.subscribeTodos(hub.sessions, (payload) => seen.push(payload))
  const before = seen.length
  hub.setTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress' },
  ])
  assert.ok(seen.length > before, '投影变化应触发回调')
  assert.equal(seen.at(-1).done, 1)
  assert.equal(seen.at(-1).active, 1)
  sub.dispose()
})

check('数据源：切换会话后重新绑定到新会话', () => {
  const hub = fakeSessions([{ content: 'A', status: 'pending' }])
  const seen = []
  const sub = mod.subscribeTodos(hub.sessions, (payload) => seen.push(payload))
  hub.switchTo(null)
  assert.equal(seen.at(-1).source, 'waiting', '无当前会话时进入等待态')
  hub.switchTo('s-1')
  assert.equal(seen.at(-1).source, 'projection')
  sub.dispose()
})

check('数据源：会话语义缺失时不抛错、走等待态', () => {
  const seen = []
  const sub = mod.subscribeTodos(undefined, (payload) => seen.push(payload))
  assert.equal(seen.at(-1).source, 'waiting')
  sub.dispose()
})

check('currentSessionId 只认 retainedBy.mainView > 0', () => {
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          a: { retainedBy: { mainView: 0 } },
          b: { retainedBy: { mainView: 2 } },
        },
      }),
    },
  }
  assert.equal(mod.currentSessionId(sessions), 'b')
  assert.equal(mod.currentSessionId(undefined), undefined)
})

// ── 几何持久化 ────────────────────────────────────────────────────────────
check('localStorage 读写几何；坏 JSON 不抛错', () => {
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  }
  assert.equal(mod.readLocalGeometry(storage), null)
  assert.equal(mod.writeLocalGeometry(storage, { left: 1, top: 2 }), true)
  assert.deepEqual(mod.readLocalGeometry(storage), { left: 1, top: 2 })
  store.set(mod.GEOM_KEY, '{oops')
  assert.equal(mod.readLocalGeometry(storage), null)
  assert.equal(mod.readLocalGeometry(undefined), null)
})

// ── apply 全链路 ──────────────────────────────────────────────────────────
await checkAsync('apply：宿主兜底几何 + 挂载 + 卸载清理', async () => {
  const doc = createFakeDocument()
  globalThis.document = doc
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init })
    return {
      ok: true,
      json: async () => ({ ok: true, geom: { left: 40, top: 60, width: 300, height: 320 } }),
    }
  }

  const hub = fakeSessions([{ content: '来自投影的待办', status: 'in_progress' }])
  const disposers = []
  const ctx = {
    get: (key) => (key === 'sessions' ? hub.sessions : undefined),
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }

  await mod.apply(ctx)

  assert.equal(doc.body.children.length, 1, '悬浮窗应挂到 body 上')
  assert.equal(doc.head.children.length, 1, '样式应注入 head')
  const mounted = doc.body.children[0]
  assert.equal(mounted.getAttribute('data-dsh-plugin'), 'todo-float')
  const win = collect(mounted).find((node) => node.className === 'ytf-win')
  assert.equal(win.style.left, '40px', '几何应来自宿主兜底')
  assert.equal(win.style.top, '60px')
  assert.ok(fetchCalls.some((call) => String(call.url).includes('/plugin-todo-float/geom')), '应读过宿主几何路由')
  const items = collect(mounted).filter((node) => node.getAttribute('data-dsh-part') === 'item')
  assert.equal(items.length, 1)
  assert.match(items[0].textContent, /来自投影的待办/)

  assert.ok(disposers.length >= 1, '应注册清理函数')
  for (const dispose of disposers) dispose()
  assert.equal(doc.body.children.length, 0, '卸载后悬浮窗应移除')
  assert.equal(doc.head.children.length, 0, '卸载后样式应移除')
  delete globalThis.document
  delete globalThis.localStorage
  delete globalThis.fetch
})

/** 深度收集整棵树。 */
function collect(node, out = []) {
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

await checkAsync('apply：小窗模式（yintx_popout=1）下不再叠一层待办浮窗', async () => {
  const doc = createFakeDocument('http://127.0.0.1:19387/?token=SECRET&yintx_popout=1')
  globalThis.document = doc
  globalThis.localStorage = { getItem: () => null, setItem: () => {} }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, geom: null }) })
  const hub = fakeSessions([{ content: '不该渲染', status: 'pending' }])
  const ctx = {
    get: (key) => (key === 'sessions' ? hub.sessions : undefined),
    effect: (fn) => fn(),
  }
  await mod.apply(ctx)
  assert.equal(doc.body.children.length, 0, '小窗里不该挂待办浮窗（会挡住会话本身）')
  assert.equal(doc.head.children.length, 0, '也不该注入样式')
  delete globalThis.document
  delete globalThis.localStorage
  delete globalThis.fetch
})

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const [status, label] of results) console.log(`${status}  ${label}`)
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed === 0 ? 0 : 1)

/**
 * dsh-plugin-todo-float —— 客户端半（浏览器侧）：Windows 风格的可拖动/可缩放悬浮窗，
 * 实时显示**当前会话**的待办清单（官方会话投影 `todos`）。
 *
 * ⚠ 本文件必须是「经典脚本 bundle」形状（与合集里其它子插件一致）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 * 官方客户端模块系统把它当 classic script 拼进 combo 直接执行，所以**不能出现 import / export 语句**
 * （合集父客户端半用 `import()` 取这份文件，顶层那一次注册调用当 ESM 解析也一样执行）。
 * 也因此本文件**零依赖**：不用 React、不用构建、不引任何包——全部原生 DOM。
 *
 * 数据来自哪里（不经过宿主半）：
 *   官方客户端服务 `sessions`（ctx.get('sessions')）→ 当前会话（`retainedBy.mainView > 0` 的那条）
 *   → `sessions.binding(id).session.projections.faceOf('todos')` → 快照 store（getSnapshot/subscribe）
 *   → `TodoItem[] | null`（`{ content, status: 'pending'|'in_progress'|'completed' }`）；
 *   同一会话的 `faceOf('goal')` 给出 `GoalProjection`
 *   （`{ goal: { objective, phase, maxGoalRounds, blockedReason? }, roundsStarted }`），
 *   有目标时在汇总行下方多显示一行「目标 · 阶段 · 轮次」，没有目标时整行隐藏。
 *   这套形状是官方 UI 自己用的（`dsh-client-ui-conversation` 的 TodoDock 就是 `useProjection('todos')`），
 *   但属于版本内的实现细节，所以本文件**全部特性探测 + 兜底轮询**，任何一步不可用都只降级、不抛错。
 *
 * 窗口能力：拖动（标题栏）、八向缩放（边框手柄）、双击标题栏最大化、最小化、关闭（收成右下角胶囊）、
 * 几何持久化（localStorage 优先，宿主半 `/plugin-todo-float/geom` 兜底）。
 * 视觉上刻意做成「Windows 窗口」：标题栏 + 三个控制按钮 + 1px 边框 + 投影，并留出毛玻璃与主题令牌
 * （`--dsw-alias-*`）的接口，以便与壁纸引擎类插件共存时仍然可读。
 */
;(function () {
  /** 客户端插件名（loader 会显示在「设置 → 插件」里）。 */
  const NAME = 'dsh-plugin-todo-float'

  /** 注入 <style> 的标记属性（卸载时按它精确移除）。 */
  const STYLE_ATTR = 'data-yintx-todo-float-style'

  /** 窗口几何的 localStorage 键。 */
  const GEOM_KEY = 'yintx.todo-float.geom.v1'

  /** 宿主半的几何兜底路由。 */
  const ROUTE_GEOM = '/plugin-todo-float/geom'

  /** 窗口最小尺寸（再小就点不到手柄也读不到字）。 */
  const MIN_WIDTH = 220
  const MIN_HEIGHT = 120

  /** 标题栏高度：最小化后就剩这一条。 */
  const TITLEBAR_HEIGHT = 34

  /** 默认尺寸与距视口边距。 */
  const DEFAULT_WIDTH = 330
  const DEFAULT_HEIGHT = 420
  const EDGE_GAP = 24

  /** 拖动/缩放时至少留在视口里的标题栏宽度（防止把窗口拖到完全看不见）。 */
  const KEEP_VISIBLE_X = 96
  const KEEP_VISIBLE_Y = TITLEBAR_HEIGHT

  /** 数据源订阅不上时的轮询间隔（毫秒）：投影订阅是主路径，这只是兜底。 */
  const POLL_INTERVAL = 2000

  /** 会话服务最多等多久（官方服务随启动注册，早于它会拿不到）。 */
  const SESSION_WAIT_TIMEOUT = 20000
  const SESSION_WAIT_STEP = 400

  /** 官方 goal 阶段枚举（`GoalSnapshot.phase`）。 */
  const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete']

  // ── 纯函数区（导出给冒烟测试直接调用；不碰 DOM）─────────────────────────────

  /** 数值夹紧：非有限数一律回落到 fallback。 */
  function clampNumber(value, lo, hi, fallback) {
    const num = typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.min(hi, Math.max(lo, num))
  }

  /**
   * 把一份（可能来自 localStorage / 宿主 / 旧版本的）几何解析成可用几何：
   * 只认已知字段、数值夹紧、尺寸不小于最小值，并把窗口挪进视口内。
   * @param raw 待解析的几何（任意值）
   * @param viewport `{ width, height }`（缺省时按 1440×900 估）
   * @returns 规范化后的几何 `{ left, top, width, height, maximized, collapsed }`
   */
  function resolveGeometry(raw, viewport) {
    const vw = clampNumber(viewport?.width, 240, 100000, 1440)
    const vh = clampNumber(viewport?.height, 200, 100000, 900)
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const width = clampNumber(source.width, MIN_WIDTH, Math.max(MIN_WIDTH, vw), DEFAULT_WIDTH)
    const height = clampNumber(source.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, vh), DEFAULT_HEIGHT)
    const fallbackLeft = vw - width - EDGE_GAP
    const fallbackTop = vh - height - EDGE_GAP * 2
    const left = clampNumber(source.left, KEEP_VISIBLE_X - width, vw - KEEP_VISIBLE_X, fallbackLeft)
    const top = clampNumber(source.top, 0, vh - KEEP_VISIBLE_Y, fallbackTop)
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
      maximized: source.maximized === true,
      collapsed: source.collapsed === true,
    }
  }

  /**
   * 拖动：把窗口移动 (dx, dy)，并保证标题栏留在视口内。
   * @param start 起始几何
   * @param dx 水平位移
   * @param dy 垂直位移
   * @param viewport `{ width, height }`
   * @returns 新几何
   */
  function dragGeometry(start, dx, dy, viewport) {
    const vw = clampNumber(viewport?.width, 240, 100000, 1440)
    const vh = clampNumber(viewport?.height, 200, 100000, 900)
    const left = clampNumber(start.left + dx, KEEP_VISIBLE_X - start.width, vw - KEEP_VISIBLE_X, start.left)
    const top = clampNumber(start.top + dy, 0, vh - KEEP_VISIBLE_Y, start.top)
    return { ...start, left: Math.round(left), top: Math.round(top) }
  }

  /**
   * 八向缩放：按方向手柄把窗口拉成新尺寸（左上/上/左这三个方向同时移动原点）。
   * @param start 起始几何
   * @param dir 方向：'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
   * @param dx 水平位移
   * @param dy 垂直位移
   * @param viewport `{ width, height }`
   * @returns 新几何（宽高不小于最小值，且不越出视口上/左边）
   */
  function resizeGeometry(start, dir, dx, dy, viewport) {
    const vw = clampNumber(viewport?.width, 240, 100000, 1440)
    const vh = clampNumber(viewport?.height, 200, 100000, 900)
    let width = start.width
    let height = start.height
    let left = start.left
    let top = start.top

    if (dir.includes('e')) width = start.width + dx
    if (dir.includes('w')) width = start.width - dx
    if (dir.includes('s')) height = start.height + dy
    if (dir.includes('n')) height = start.height - dy

    width = clampNumber(width, MIN_WIDTH, 100000, start.width)
    height = clampNumber(height, MIN_HEIGHT, 100000, start.height)

    if (dir.includes('w')) left = start.left + (start.width - width)
    if (dir.includes('n')) top = start.top + (start.height - height)

    left = clampNumber(left, 0, Math.max(0, vw - KEEP_VISIBLE_X), left)
    top = clampNumber(top, 0, Math.max(0, vh - KEEP_VISIBLE_Y), top)

    return { ...start, left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) }
  }

  /** 最大化几何：铺满视口（留一点边距，免得遮住滚动条）。 */
  function maximizeGeometry(viewport) {
    const vw = clampNumber(viewport?.width, 240, 100000, 1440)
    const vh = clampNumber(viewport?.height, 200, 100000, 900)
    return {
      left: EDGE_GAP,
      top: EDGE_GAP,
      width: Math.max(MIN_WIDTH, vw - EDGE_GAP * 2),
      height: Math.max(MIN_HEIGHT, vh - EDGE_GAP * 2),
      maximized: true,
      collapsed: false,
    }
  }

  /**
   * 把官方 `TodoItem[] | null` 收敛成视图模型（顺序保持官方给的顺序）。
   * @param todos 官方投影值
   * @returns `{ items, total, done, pending, active, hasActive }`
   */
  function projectTodos(todos) {
    const list = Array.isArray(todos) ? todos : []
    const items = []
    let done = 0
    let pending = 0
    let active = 0
    for (const raw of list) {
      const content = typeof raw?.content === 'string' ? raw.content.trim() : ''
      if (content === '') continue
      const status = raw.status === 'completed' || raw.status === 'in_progress' || raw.status === 'pending'
        ? raw.status
        : 'pending'
      if (status === 'completed') done += 1
      else if (status === 'in_progress') active += 1
      else pending += 1
      items.push({ content, status })
    }
    return { items, total: items.length, done, pending, active, hasActive: active > 0 }
  }

  /** 状态 → 图形符号与中文短标签。 */
  function statusMeta(status) {
    if (status === 'completed') return { mark: '✓', label: '已完成' }
    if (status === 'in_progress') return { mark: '◐', label: '进行中' }
    return { mark: '○', label: '待办' }
  }

  /** goal 阶段 → 中文短标签与语气（语气只用来给徽章上色）。 */
  function goalMeta(phase) {
    if (phase === 'paused') return { label: '已暂停', tone: 'paused' }
    if (phase === 'blocked') return { label: '受阻', tone: 'blocked' }
    if (phase === 'complete') return { label: '已完成', tone: 'complete' }
    return { label: '进行中', tone: 'active' }
  }

  /**
   * 把官方 goal 投影值收敛成视图模型；没有目标（或目标被清空）时返回 null。
   * @param raw `GoalProjection | null`（`projections.faceOf('goal').getSnapshot()`）
   * @returns `{ objective, phase, roundsStarted, maxGoalRounds, blockedReason } | null`
   */
  function projectGoal(raw) {
    if (raw === null || raw === undefined || typeof raw !== 'object') return null
    const goal = raw.goal
    if (goal === null || goal === undefined || typeof goal !== 'object') return null
    const objective = typeof goal.objective === 'string' ? goal.objective.trim() : ''
    if (objective === '') return null
    const phase = GOAL_PHASES.includes(goal.phase) ? goal.phase : 'active'
    const maxGoalRounds = clampNumber(goal.maxGoalRounds, 1, 100000, 1)
    const roundsStarted = clampNumber(raw.roundsStarted, 0, 100000, 0)
    const blockedReason =
      goal.blockedReason !== null && typeof goal.blockedReason === 'object' && typeof goal.blockedReason.message === 'string'
        ? goal.blockedReason.message.trim()
        : ''
    return { objective, phase, roundsStarted, maxGoalRounds, blockedReason }
  }

  // ── 样式 ──────────────────────────────────────────────────────────────────

  /** 悬浮窗样式表。颜色优先吃 DSH 主题令牌，取不到就用自带的一套，保证在壁纸之上仍可读。 */
  const STYLE_TEXT = `
[data-dsh-plugin="todo-float"] {
  --ytf-bg: var(--dsw-alias-bg-layer-2, rgba(24, 26, 33, 0.94));
  --ytf-fg: var(--dsw-alias-label-primary, #e9ecf4);
  --ytf-fg-dim: var(--dsw-alias-label-secondary, #9aa3b5);
  --ytf-border: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
  --ytf-accent: var(--dsw-alias-accent, #4f8cff);
  --ytf-danger: #e5484d;
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  pointer-events: none;
  /* 整屏 body 级浮层的硬要求（与壁纸引擎类插件同族）：必须声明 initial，
     否则桌面壳会把这块矩形从窗口可拖区里几何挖除（写 none 也等于没修）。 */
  -webkit-app-region: initial !important;
  font-family: var(--dsw-font-family, "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif);
  font-size: 13px;
  color: var(--ytf-fg);
}
[data-dsh-plugin="todo-float"] .ytf-win {
  position: absolute;
  display: flex;
  flex-direction: column;
  min-width: 220px;
  min-height: 120px;
  border: 1px solid var(--ytf-border);
  border-radius: 9px;
  background: var(--ytf-bg);
  -webkit-backdrop-filter: blur(18px) saturate(1.25);
  backdrop-filter: blur(18px) saturate(1.25);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.32);
  overflow: hidden;
  pointer-events: auto;
}
[data-dsh-plugin="todo-float"][data-maximized="true"] .ytf-win { border-radius: 6px; }
[data-dsh-plugin="todo-float"][data-collapsed="true"] .ytf-win { height: 34px !important; min-height: 34px; }
[data-dsh-part="titlebar"] {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  flex: 0 0 34px;
  padding: 0 4px 0 10px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02));
  border-bottom: 1px solid var(--ytf-border);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
[data-dsh-part="titlebar"]:active { cursor: grabbing; }
[data-dsh-part="title"] {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  font-size: 12.5px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-part="session"] { font-weight: 400; color: var(--ytf-fg-dim); }
[data-dsh-part="controls"] { display: flex; align-items: center; flex: 0 0 auto; }
[data-dsh-part="controls"] button {
  width: 38px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ytf-fg-dim);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
[data-dsh-part="controls"] button:hover { background: rgba(255, 255, 255, 0.12); color: var(--ytf-fg); }
[data-dsh-part="controls"] button[data-ctl="close"]:hover { background: var(--ytf-danger); color: #fff; }
[data-dsh-part="goal"] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ytf-border);
  background: rgba(79, 140, 255, 0.08);
  font-size: 12px;
  flex: 0 0 auto;
}
[data-dsh-part="goal"][data-empty="true"] { display: none; }
[data-dsh-part="goal-mark"] { flex: 0 0 auto; color: var(--ytf-accent); opacity: 0.9; }
[data-dsh-part="goal-text"] {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-part="goal-phase"] {
  flex: 0 0 auto;
  padding: 1px 7px;
  border: 1px solid var(--ytf-border);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ytf-accent);
}
[data-dsh-part="goal-phase"][data-phase="paused"] { color: #d29922; }
[data-dsh-part="goal-phase"][data-phase="blocked"] { color: var(--ytf-danger); }
[data-dsh-part="goal-phase"][data-phase="complete"] { color: #3fb950; }
[data-dsh-part="goal-rounds"] { flex: 0 0 auto; font-size: 11px; color: var(--ytf-fg-dim); }
[data-dsh-part="summary"] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--ytf-border);
  font-size: 12px;
  color: var(--ytf-fg-dim);
  flex: 0 0 auto;
}
[data-dsh-part="progress"] {
  flex: 1 1 auto;
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}
[data-dsh-part="progress-fill"] {
  display: block;
  height: 100%;
  width: 0%;
  border-radius: 3px;
  background: var(--ytf-accent);
  transition: width 0.24s ease;
}
[data-dsh-part="list"] {
  flex: 1 1 auto;
  margin: 0;
  padding: 6px 4px 8px 4px;
  list-style: none;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
}
[data-dsh-part="item"] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  line-height: 1.45;
  word-break: break-word;
}
[data-dsh-part="item"][data-status="in_progress"] { background: rgba(79, 140, 255, 0.16); font-weight: 600; }
[data-dsh-part="item"][data-status="completed"] { color: var(--ytf-fg-dim); }
[data-dsh-part="item"][data-status="completed"] [data-dsh-part="text"] { text-decoration: line-through; }
[data-dsh-part="mark"] { flex: 0 0 14px; text-align: center; opacity: 0.9; }
[data-dsh-part="item"][data-status="in_progress"] [data-dsh-part="mark"] { color: var(--ytf-accent); opacity: 1; }
[data-dsh-part="item"][data-status="completed"] [data-dsh-part="mark"] { color: #3fb950; opacity: 1; }
[data-dsh-part="text"] { flex: 1 1 auto; min-width: 0; }
[data-dsh-part="empty"] {
  padding: 18px 12px;
  text-align: center;
  color: var(--ytf-fg-dim);
  font-size: 12px;
}
[data-dsh-part="status"] {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-top: 1px solid var(--ytf-border);
  font-size: 11px;
  color: var(--ytf-fg-dim);
}
[data-dsh-part="dot"] {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #3fb950;
  flex: 0 0 auto;
}
[data-dsh-part="dot"][data-state="waiting"] { background: #d29922; }
[data-dsh-part="dot"][data-state="idle"] { background: #6e7681; }
[data-dsh-part="spacer"] { flex: 1 1 auto; }
[data-dsh-part="resize"] { position: absolute; z-index: 3; touch-action: none; }
[data-dsh-part="resize"][data-dir="n"] { top: -3px; left: 8px; right: 8px; height: 7px; cursor: ns-resize; }
[data-dsh-part="resize"][data-dir="s"] { bottom: -3px; left: 8px; right: 8px; height: 7px; cursor: ns-resize; }
[data-dsh-part="resize"][data-dir="e"] { right: -3px; top: 8px; bottom: 8px; width: 7px; cursor: ew-resize; }
[data-dsh-part="resize"][data-dir="w"] { left: -3px; top: 8px; bottom: 8px; width: 7px; cursor: ew-resize; }
[data-dsh-part="resize"][data-dir="ne"] { top: -3px; right: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
[data-dsh-part="resize"][data-dir="nw"] { top: -3px; left: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
[data-dsh-part="resize"][data-dir="se"] { bottom: -3px; right: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
[data-dsh-part="resize"][data-dir="sw"] { bottom: -3px; left: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
[data-dsh-plugin="todo-float"][data-maximized="true"] [data-dsh-part="resize"] { display: none; }
[data-dsh-plugin="todo-float"][data-collapsed="true"] [data-dsh-part="resize"] { display: none; }
[data-dsh-part="launcher"] {
  position: absolute;
  right: 18px;
  bottom: 18px;
  display: none;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--ytf-border);
  border-radius: 17px;
  background: var(--ytf-bg);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  color: var(--ytf-fg);
  font-size: 12px;
  cursor: pointer;
  pointer-events: auto;
}
[data-dsh-part="launcher"]:hover { border-color: var(--ytf-accent); }
[data-dsh-plugin="todo-float"][data-hidden="true"] [data-dsh-part="launcher"] { display: inline-flex; }
`

  // ── DOM 小工具 ────────────────────────────────────────────────────────────

  /**
   * 建一个元素。`part` 会写成 `data-dsh-part`（语义属性，供皮肤/调试锚定）。
   * @param doc document 对象
   * @param tag 标签名
   * @param part 部件名（可省略）
   * @param className class 名（可省略）
   */
  function el(doc, tag, part, className) {
    const node = doc.createElement(tag)
    if (part) node.setAttribute('data-dsh-part', part)
    if (className) node.className = className
    return node
  }

  /** 注入样式（已存在就复用），返回移除函数。 */
  function injectStyle(doc) {
    if (!doc?.head) return () => {}
    const existing = typeof doc.querySelector === 'function' ? doc.querySelector(`style[${STYLE_ATTR}]`) : null
    if (existing) return () => {}
    const style = doc.createElement('style')
    style.setAttribute(STYLE_ATTR, '')
    style.textContent = STYLE_TEXT
    doc.head.appendChild(style)
    return () => {
      try {
        style.remove ? style.remove() : style.parentNode?.removeChild(style)
      } catch {}
    }
  }

  // ── 窗口视图 ──────────────────────────────────────────────────────────────

  /**
   * 建出悬浮窗的 DOM 骨架。**不做任何数据订阅**：视图只认 `setState()` 推来的状态与
   * `setGeometry()` 推来的几何，这样测试可以拿一个极简 DOM stub 直接把整棵树建出来。
   *
   * @param doc document
   * @param handlers `{ onGeometry(geom, reason), onClose(), onReopen() }`
   * @returns 视图对象
   */
  function createView(doc, handlers = {}) {
    const root = el(doc, 'div')
    root.setAttribute('data-dsh-plugin', 'todo-float')
    root.setAttribute('data-hidden', 'false')

    const win = el(doc, 'section', undefined, 'ytf-win')
    win.setAttribute('role', 'dialog')
    win.setAttribute('aria-label', '当前会话待办')

    // 标题栏
    const titlebar = el(doc, 'header', 'titlebar')
    const title = el(doc, 'span', 'title')
    const titleText = el(doc, 'span')
    titleText.textContent = '待办清单'
    const session = el(doc, 'span', 'session')
    session.textContent = ' · 等待会话'
    title.appendChild(titleText)
    title.appendChild(session)

    const controls = el(doc, 'div', 'controls')
    const btnCollapse = el(doc, 'button')
    btnCollapse.setAttribute('data-ctl', 'collapse')
    btnCollapse.setAttribute('type', 'button')
    btnCollapse.setAttribute('title', '最小化')
    btnCollapse.setAttribute('aria-label', '最小化')
    btnCollapse.textContent = '─'
    const btnMax = el(doc, 'button')
    btnMax.setAttribute('data-ctl', 'maximize')
    btnMax.setAttribute('type', 'button')
    btnMax.setAttribute('title', '最大化')
    btnMax.setAttribute('aria-label', '最大化')
    btnMax.textContent = '□'
    const btnClose = el(doc, 'button')
    btnClose.setAttribute('data-ctl', 'close')
    btnClose.setAttribute('type', 'button')
    btnClose.setAttribute('title', '关闭（收成右下角小胶囊）')
    btnClose.setAttribute('aria-label', '关闭')
    btnClose.textContent = '✕'
    controls.appendChild(btnCollapse)
    controls.appendChild(btnMax)
    controls.appendChild(btnClose)
    titlebar.appendChild(title)
    titlebar.appendChild(controls)

    // 汇总行（计数 + 进度条）
    const summary = el(doc, 'div', 'summary')
    const counter = el(doc, 'span', 'counter')
    counter.textContent = '0 / 0'
    const progress = el(doc, 'div', 'progress')
    const progressFill = el(doc, 'span', 'progress-fill')
    progress.appendChild(progressFill)
    summary.appendChild(counter)
    summary.appendChild(progress)

    // 目标行（官方 goal 投影；没有目标时整行隐藏）
    const goal = el(doc, 'div', 'goal')
    goal.setAttribute('data-empty', 'true')
    const goalMark = el(doc, 'span', 'goal-mark')
    goalMark.textContent = '◎'
    const goalText = el(doc, 'span', 'goal-text')
    const goalPhase = el(doc, 'span', 'goal-phase')
    goalPhase.setAttribute('data-phase', 'active')
    const goalRounds = el(doc, 'span', 'goal-rounds')
    goal.appendChild(goalMark)
    goal.appendChild(goalText)
    goal.appendChild(goalPhase)
    goal.appendChild(goalRounds)

    // 列表
    const list = el(doc, 'ul', 'list')
    list.setAttribute('role', 'list')

    // 状态栏
    const status = el(doc, 'footer', 'status')
    const dot = el(doc, 'span', 'dot')
    dot.setAttribute('data-state', 'idle')
    const statusText = el(doc, 'span')
    statusText.textContent = '等待会话数据'
    const spacer = el(doc, 'span', 'spacer')
    const updated = el(doc, 'span')
    updated.textContent = ''
    status.appendChild(dot)
    status.appendChild(statusText)
    status.appendChild(spacer)
    status.appendChild(updated)

    // 八向缩放手柄
    const handles = []
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = el(doc, 'div', 'resize')
      handle.setAttribute('data-dir', dir)
      handles.push({ dir, node: handle })
      win.appendChild(handle)
    }

    win.appendChild(titlebar)
    win.appendChild(summary)
    win.appendChild(goal)
    win.appendChild(list)
    win.appendChild(status)

    // 关闭后的小胶囊（点它把窗口叫回来）
    const launcher = el(doc, 'button', 'launcher')
    launcher.setAttribute('type', 'button')
    launcher.setAttribute('title', '打开当前会话待办')
    const launcherMark = el(doc, 'span')
    launcherMark.textContent = '◐'
    const launcherText = el(doc, 'span')
    launcherText.textContent = '待办'
    launcher.appendChild(launcherMark)
    launcher.appendChild(launcherText)

    root.appendChild(win)
    root.appendChild(launcher)

    /** 当前几何（视图自己拿着，外部只推不改）。 */
    let geometry = resolveGeometry(null, { width: 1440, height: 900 })
    /** 最大化前的几何，用于还原。 */
    let restoreGeometry = null
    /** 当前视图状态（用于避免无谓重绘）。 */
    let state = { items: [], total: 0, done: 0, pending: 0, active: 0, sessionTitle: '', goal: null, source: 'idle', message: '' }

    /** 把几何写到 DOM 上。 */
    const paintGeometry = () => {
      win.style.left = `${geometry.left}px`
      win.style.top = `${geometry.top}px`
      win.style.width = `${geometry.width}px`
      win.style.height = `${geometry.collapsed ? TITLEBAR_HEIGHT : geometry.height}px`
      root.setAttribute('data-maximized', geometry.maximized ? 'true' : 'false')
      root.setAttribute('data-collapsed', geometry.collapsed ? 'true' : 'false')
      btnCollapse.textContent = geometry.collapsed ? '❐' : '─'
      btnCollapse.setAttribute('title', geometry.collapsed ? '还原' : '最小化')
      btnMax.textContent = geometry.maximized ? '❐' : '□'
      btnMax.setAttribute('title', geometry.maximized ? '还原' : '最大化')
    }

    /** 视图内部改几何：重绘 + 通知外部（外部据此持久化）。 */
    const setGeometry = (next, reason) => {
      geometry = resolveGeometry(next, viewportSize())
      paintGeometry()
      handlers.onGeometry?.(geometry, reason ?? 'set')
      return geometry
    }

    /** 当前视口尺寸（jsdom 之类没有 innerWidth 时给 1440×900 的合理默认）。 */
    function viewportSize() {
      const win_ = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined)
      return {
        width: clampNumber(win_?.innerWidth, 240, 100000, 1440),
        height: clampNumber(win_?.innerHeight, 200, 100000, 900),
      }
    }

    /**
     * 渲染待办列表。只在内容真的变化时重建条目（避免每次轮询都重建 DOM）。
     * @param next 状态
     */
    const setState = (next) => {
      const merged = { ...state, ...(next ?? {}) }
      const changed =
        merged.sessionTitle !== state.sessionTitle ||
        merged.source !== state.source ||
        merged.message !== state.message ||
        JSON.stringify(merged.goal ?? null) !== JSON.stringify(state.goal ?? null) ||
        merged.items.length !== state.items.length ||
        merged.items.some((item, index) => item.content !== state.items[index]?.content || item.status !== state.items[index]?.status)
      state = merged
      if (!changed) {
        counter.textContent = `${state.done} / ${state.total}`
        return
      }

      session.textContent = state.sessionTitle ? ` · ${state.sessionTitle}` : ' · 等待会话'
      counter.textContent = `${state.done} / ${state.total}`
      const percent = state.total === 0 ? 0 : Math.round((state.done / state.total) * 100)
      progressFill.style.width = `${percent}%`

      // 目标行：有目标才显示（阶段徽章上色，轮次显示 已用/上限，受阻原因进 title）
      const goalView = state.goal ?? null
      if (goalView === null) {
        goal.setAttribute('data-empty', 'true')
      } else {
        const meta = goalMeta(goalView.phase)
        goal.setAttribute('data-empty', 'false')
        goalText.textContent = goalView.objective
        goalText.setAttribute('title', goalView.blockedReason !== '' ? `受阻原因：${goalView.blockedReason}` : goalView.objective)
        goalPhase.textContent = meta.label
        goalPhase.setAttribute('data-phase', meta.tone)
        goalRounds.textContent = `${goalView.roundsStarted}/${goalView.maxGoalRounds}`
      }

      while (list.firstChild) list.removeChild(list.firstChild)
      if (state.items.length === 0) {
        const empty = el(doc, 'li', 'empty')
        empty.textContent = state.message !== '' ? state.message : '当前会话暂无待办'
        list.appendChild(empty)
      } else {
        for (const item of state.items) {
          const row = el(doc, 'li', 'item')
          row.setAttribute('data-status', item.status)
          const mark = el(doc, 'span', 'mark')
          const meta = statusMeta(item.status)
          mark.textContent = meta.mark
          mark.setAttribute('title', meta.label)
          const text = el(doc, 'span', 'text')
          text.textContent = item.content
          row.appendChild(mark)
          row.appendChild(text)
          list.appendChild(row)
        }
      }

      dot.setAttribute('data-state', state.source === 'projection' ? 'live' : state.source === 'waiting' ? 'waiting' : 'idle')
      statusText.textContent = state.source === 'projection'
        ? (state.total === 0 ? '已连接 · 无待办' : `${state.done}/${state.total} 已完成`)
        : state.source === 'waiting'
          ? (state.message || '等待会话数据')
          : '数据源不可用'
      updated.textContent = state.updatedAt ? `${state.updatedAt}` : ''
    }

    // ── 交互：拖动 ──────────────────────────────────────────────────────────
    const onPointerDown = (event, kind, dir) => {
      if (event?.button !== undefined && event.button !== 0) return
      const start = { ...geometry }
      const startX = clampNumber(event?.clientX, -1e6, 1e6, 0)
      const startY = clampNumber(event?.clientY, -1e6, 1e6, 0)
      event?.preventDefault?.()
      try {
        event?.target?.setPointerCapture?.(event.pointerId)
      } catch {}
      const view = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined)
      if (!view?.addEventListener) return
      const move = (moveEvent) => {
        const dx = clampNumber(moveEvent?.clientX, -1e6, 1e6, startX) - startX
        const dy = clampNumber(moveEvent?.clientY, -1e6, 1e6, startY) - startY
        const next = kind === 'drag'
          ? dragGeometry(start, dx, dy, viewportSize())
          : resizeGeometry(start, dir, dx, dy, viewportSize())
        geometry = next
        paintGeometry()
      }
      const finish = () => {
        view.removeEventListener?.('pointermove', move)
        view.removeEventListener?.('pointerup', finish)
        view.removeEventListener?.('pointercancel', finish)
        handlers.onGeometry?.(geometry, kind === 'drag' ? 'drag-end' : 'resize-end')
      }
      view.addEventListener('pointermove', move)
      view.addEventListener('pointerup', finish)
      view.addEventListener('pointercancel', finish)
    }

    if (titlebar.addEventListener) {
      titlebar.addEventListener('pointerdown', (event) => {
        const target = event?.target
        if (target?.closest?.('[data-ctl]')) return
        if (target?.getAttribute?.('data-ctl')) return
        onPointerDown(event, 'drag')
      })
      titlebar.addEventListener('dblclick', () => {
        toggleMaximize()
      })
    }
    for (const handle of handles) {
      handle.node.addEventListener?.('pointerdown', (event) => onPointerDown(event, 'resize', handle.dir))
    }

    // ── 交互：三个控制按钮 ──────────────────────────────────────────────────
    const toggleMaximize = () => {
      if (geometry.maximized) {
        const back = restoreGeometry ?? geometry
        restoreGeometry = null
        return setGeometry({ ...back, maximized: false }, 'restore')
      }
      restoreGeometry = { ...geometry }
      return setGeometry(maximizeGeometry(viewportSize()), 'maximize')
    }
    const toggleCollapse = () => setGeometry({ ...geometry, collapsed: !geometry.collapsed }, 'collapse')
    const hide = () => {
      root.setAttribute('data-hidden', 'true')
      launcher.style.display = 'inline-flex'
      handlers.onClose?.()
    }
    const show = () => {
      root.setAttribute('data-hidden', 'false')
      launcher.style.display = 'none'
      handlers.onReopen?.()
    }

    btnCollapse.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      toggleCollapse()
    })
    btnMax.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      toggleMaximize()
    })
    btnClose.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      hide()
    })
    launcher.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      show()
    })

    // 视口变化：窗口别跑到屏幕外
    const view = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined)
    const onResize = () => {
      if (geometry.maximized) {
        geometry = maximizeGeometry(viewportSize())
        paintGeometry()
        return
      }
      const fixed = resolveGeometry(geometry, viewportSize())
      if (fixed.left !== geometry.left || fixed.top !== geometry.top || fixed.width !== geometry.width || fixed.height !== geometry.height) {
        geometry = fixed
        paintGeometry()
      }
    }
    view?.addEventListener?.('resize', onResize)

    paintGeometry()

    return {
      root,
      win,
      launcher,
      setGeometry: (next) => {
        geometry = resolveGeometry(next, viewportSize())
        paintGeometry()
      },
      setState,
      getGeometry: () => ({ ...geometry }),
      getState: () => ({ ...state }),
      toggleMaximize,
      show,
      hide,
      isHidden: () => root.getAttribute('data-hidden') === 'true',
      destroy: () => {
        view?.removeEventListener?.('resize', onResize)
      },
    }
  }

  // ── 会话待办数据源 ────────────────────────────────────────────────────────

  /**
   * 找「当前会话」：官方多个 UI 包用的判据是 `retainedBy.mainView > 0` 的那条。
   * @param sessions `ctx.get('sessions')`
   */
  function currentSessionId(sessions) {
    try {
      const snapshot = sessions?.list?.getSnapshot?.()
      const byId = snapshot?.byId ?? {}
      for (const id of Object.keys(byId)) {
        if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
      }
    } catch {}
    return undefined
  }

  /** 取某会话的 todos 投影 store（拿不到返回 undefined）。 */
  function todosFace(sessions, sessionId) {
    if (sessionId === undefined) return undefined
    try {
      const binding = sessions?.binding?.(sessionId)
      const face = binding?.session?.projections?.faceOf?.('todos')
      return face && typeof face.getSnapshot === 'function' ? face : undefined
    } catch {
      return undefined
    }
  }

  /** 取某会话的 goal 投影 store（拿不到返回 undefined）。 */
  function goalFace(sessions, sessionId) {
    if (sessionId === undefined) return undefined
    try {
      const binding = sessions?.binding?.(sessionId)
      const face = binding?.session?.projections?.faceOf?.('goal')
      return face && typeof face.getSnapshot === 'function' ? face : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 订阅「当前会话的待办」。
   * 主路径：sessions.list 变化 → 重新绑定；todos 投影 store 变化 → 回调。
   * 兜底：轮询（订阅 API 在别的版本里可能不同），只在快照变化时回调。
   *
   * @param sessions 会话服务
   * @param onChange `(payload) => void`，payload 见 `readOnce`
   * @returns `{ dispose, refresh }`
   */
  function subscribeTodos(sessions, onChange) {
    let disposed = false
    let boundSessionId
    let face
    let faceUnsubscribe
    let goalStore
    let goalUnsubscribe
    let listUnsubscribe
    let lastKey = null
    let timer

    /** 读一次并推给视图。 */
    const readOnce = () => {
      if (disposed) return
      const sessionId = currentSessionId(sessions)
      if (sessionId !== boundSessionId) {
        try {
          faceUnsubscribe?.()
        } catch {}
        try {
          goalUnsubscribe?.()
        } catch {}
        faceUnsubscribe = undefined
        goalUnsubscribe = undefined
        boundSessionId = sessionId
        face = todosFace(sessions, sessionId)
        try {
          faceUnsubscribe = face?.subscribe?.(() => readOnce())
        } catch {}
        goalStore = goalFace(sessions, sessionId)
        try {
          goalUnsubscribe = goalStore?.subscribe?.(() => readOnce())
        } catch {}
        lastKey = null
      }
      const binding = sessionId === undefined ? undefined : sessions?.binding?.(sessionId)
      const title = (() => {
        try {
          const summary = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
          return typeof summary?.title === 'string' ? summary.title : ''
        } catch {
          return ''
        }
      })()
      const raw = (() => {
        try {
          return face?.getSnapshot?.() ?? null
        } catch {
          return null
        }
      })()
      const rawGoal = (() => {
        try {
          return goalStore?.getSnapshot?.() ?? null
        } catch {
          return null
        }
      })()
      const view = projectTodos(raw)
      const goal = projectGoal(rawGoal)
      const key = JSON.stringify([sessionId ?? '', title, view.items, goal])
      const connected = sessionId !== undefined && binding !== undefined && face !== undefined
      const outcome = {
        ...view,
        goal,
        sessionTitle: title,
        source: connected ? 'projection' : 'waiting',
        message: sessionId === undefined ? '等待会话打开…' : connected ? '' : '未接入会话数据源',
        updatedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      }
      if (key !== lastKey || !connected) {
        lastKey = key
        onChange(outcome)
      }
      return outcome
    }

    // 会话列表本身的变化（切换会话、标题变化）也要重新取
    try {
      listUnsubscribe = sessions?.list?.subscribe?.(() => readOnce())
    } catch {}

    readOnce()
    timer = setInterval(readOnce, POLL_INTERVAL)

    return {
      dispose: () => {
        disposed = true
        if (timer !== undefined) clearInterval(timer)
        try {
          faceUnsubscribe?.()
        } catch {}
        try {
          goalUnsubscribe?.()
        } catch {}
        try {
          listUnsubscribe?.()
        } catch {}
      },
      refresh: readOnce,
    }
  }

  /** 等官方客户端服务就绪（loader 的服务按顺序注册，早于 sessions 时这里重试）。 */
  async function waitForService(ctx, key, timeout = SESSION_WAIT_TIMEOUT, step = SESSION_WAIT_STEP) {
    const started = Date.now()
    for (;;) {
      let service
      try {
        service = ctx?.get?.(key)
      } catch {}
      if (service !== undefined && service !== null) return service
      if (Date.now() - started >= timeout) return undefined
      await new Promise((resolve) => setTimeout(resolve, step))
    }
  }

  // ── 几何持久化 ────────────────────────────────────────────────────────────

  /** 读 localStorage 里的几何（不可用/坏了都返回 null）。 */
  function readLocalGeometry(storage) {
    try {
      const raw = storage?.getItem?.(GEOM_KEY)
      if (typeof raw !== 'string' || raw === '') return null
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** 写 localStorage（配额/隐私模式失败静默）。 */
  function writeLocalGeometry(storage, geometry) {
    try {
      storage?.setItem?.(GEOM_KEY, JSON.stringify(geometry))
      return true
    } catch {
      return false
    }
  }

  /** 读宿主半的几何兜底（拿不到返回 null）。 */
  async function readHostGeometry() {
    try {
      const response = await fetch(ROUTE_GEOM, { credentials: 'same-origin' })
      if (!response.ok) return null
      const payload = await response.json()
      return payload?.ok === true && payload.geom ? payload.geom : null
    } catch {
      return null
    }
  }

  /** 把几何同步到宿主半（best-effort，失败只留一条 debug）。 */
  function pushHostGeometry(geometry) {
    try {
      void fetch(ROUTE_GEOM, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ geom: geometry }),
      }).catch(() => {})
    } catch {}
  }

  // ── 插件本体 ──────────────────────────────────────────────────────────────

  /**
   * 用官方客户端席位挂载：sessions 走可选注入（`ctx.inject`），拿不到就轮询等它出现。
   * 任何一步失败都只留警告——外部插件绝不能把 GUI 拖下水。
   */
  async function apply(ctx) {
    const doc = typeof document !== 'undefined' ? document : undefined
    if (!doc?.body) {
      console.warn(`[${NAME}] 没有 document.body，跳过挂载`)
      return
    }

    // 小窗里（session-popout 开的独立窗口/内嵌小窗）不再叠一层待办浮窗：
    // 那块地方本来就小，浮窗会挡住会话本身。
    try {
      const pageUrl = new URL(String(doc.defaultView?.location?.href ?? globalThis.location?.href ?? ''))
      if (pageUrl.searchParams.get('yintx_popout') === '1') {
        console.info(`[${NAME}] 检测到小窗模式（yintx_popout=1），跳过挂载`)
        return
      }
    } catch {}

    const sessions = await waitForService(ctx, 'sessions')
    if (sessions === undefined) {
      console.warn(`[${NAME}] 等不到 sessions 服务，悬浮窗未挂载（DSH 版本可能过旧）`)
      return
    }

    const removeStyle = injectStyle(doc)
    const storage = (() => {
      try {
        return typeof localStorage !== 'undefined' ? localStorage : undefined
      } catch {
        return undefined
      }
    })()

    // 几何：本地优先，宿主兜底
    const local = readLocalGeometry(storage)
    let geometry = local
    let source = local === null ? 'default' : 'local'
    if (local === null) {
      const hostGeom = await readHostGeometry()
      if (hostGeom) {
        geometry = hostGeom
        source = 'host'
      }
    }

    let saveTimer
    const persist = (next, reason) => {
      if (reason === 'drag-end' || reason === 'resize-end' || reason === 'maximize' || reason === 'restore' || reason === 'collapse' || reason === 'host-sync') {
        writeLocalGeometry(storage, next)
        if (saveTimer !== undefined) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => pushHostGeometry(next), 600)
      }
    }

    const view = createView(doc, {
      onGeometry: persist,
      onClose: () => console.info(`[${NAME}] 悬浮窗已收起（点右下角胶囊可叫回）`),
      onReopen: () => console.info(`[${NAME}] 悬浮窗已恢复`),
    })
    view.setGeometry(geometry ?? resolveGeometry(null, {
      width: doc.defaultView?.innerWidth ?? globalThis.innerWidth,
      height: doc.defaultView?.innerHeight ?? globalThis.innerHeight,
    }))

    doc.body.appendChild(view.root)

    let lastState
    const todos = subscribeTodos(sessions, (payload) => {
      lastState = payload
      view.setState(payload)
    })
    // 先给视图一个"等待"状态，免得空窗看起来像坏了
    view.setState(lastState ?? { items: [], total: 0, done: 0, pending: 0, active: 0, sessionTitle: '', source: 'waiting', message: '等待会话数据…' })

    const cleanup = () => {
      try {
        todos.dispose()
      } catch {}
      try {
        view.destroy()
      } catch {}
      try {
        removeStyle()
      } catch {}
      try {
        view.root.remove ? view.root.remove() : view.root.parentNode?.removeChild(view.root)
      } catch {}
      try {
        ctx?.effect?.(() => () => {})
      } catch {}
    }
    try {
      ctx?.effect?.(() => cleanup)
    } catch {
      // 没有 effect 席位就退化成随页面生命周期存在
    }

    console.info(`[${NAME}] 悬浮窗已挂载（几何来源：${source}）`)
  }

  /**
   * 注册本插件：**这是本文件唯一的对外形状**，见文件头。
   * 顺手把纯函数与数据源一并导出（自己人测试用，与仓库里其它子插件一致）。
   */
  const exported = {
    name: NAME,
    /** 不声明 inject：席位一律在 apply 里探测，任何 DSH 版本都能安全挂载。 */
    inject: [],
    apply,
    STYLE_ATTR,
    GEOM_KEY,
    ROUTE_GEOM,
    MIN_WIDTH,
    MIN_HEIGHT,
    TITLEBAR_HEIGHT,
    clampNumber,
    resolveGeometry,
    dragGeometry,
    resizeGeometry,
    maximizeGeometry,
    projectTodos,
    projectGoal,
    statusMeta,
    goalMeta,
    createView,
    subscribeTodos,
    currentSessionId,
    todosFace,
    goalFace,
    readLocalGeometry,
    writeLocalGeometry,
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__?.load) {
    window.__ModuleLoader__.load({
      // 注册 id 必须是**字面量**：合集生成器按文本校验它与子插件包名同源。
      id: 'dsh-plugin-todo-float',
      factory: (require) => {
        void require
        return exported
      },
    })
  }
  // 供 node 侧测试直接 import（本文件当 ESM 解析时上面那段不执行）
  if (typeof globalThis !== 'undefined') globalThis.__yintxTodoFloatExports = exported
})()

/**
 * dsh-plugin-session-popout —— 客户端半（浏览器侧）：把当前会话**拖出来**开成独立小窗。
 *
 * ⚠ 与合集里其它子插件同款：本文件必须是「经典脚本 bundle」形状，零 import / export、零依赖：
 *   window.__ModuleLoader__.load({ id: 'dsh-plugin-session-popout', factory })
 *
 * 两个方向的能力都在这里：
 *
 *   ① 主窗口侧：视口右上角一枚小胶囊（悬停才明显）。点它、或**按住它拖出 60px 再松手**，
 *      就把会话弹成小窗；快捷键 Alt+Shift+P 同效。开窗用 `window.open`，窗口名固定，
 *      所以重复触发只会聚焦已有小窗（不叠窗口）。
 *   ② 小窗侧：URL 带 `yintx_popout=1` 时，本插件给 html 打上 `data-yintx-popout="1"`
 *      并注入「精简界面」样式（默认只留会话列），右上角给一条「回到主窗口 / 关闭小窗」的小条。
 *
 * 为什么开的是**同一个 GUI 的地址**而不是自绘一份会话：DSH 的认证 token 在 URL 查询串里，
 * 官方客户端又是单页应用（没有会话路由），所以最稳的小窗就是「同一地址的新窗口」——
 * 带的是同一份 token，能连、能输入、能实时跟随；界面精简靠小窗侧注入样式做。
 */
;(function () {
  const NAME = 'dsh-plugin-session-popout'

  /** 样式表标记属性（卸载时按它移除）。 */
  const STYLE_ATTR = 'data-yintx-session-popout-style'

  /** 小窗标记：URL 查询参数名 + html 属性名。 */
  const FLAG_PARAM = 'yintx_popout'
  const FLAG_ATTR = 'data-yintx-popout'

  /** 小窗窗口名：固定值 → 同名的 window.open 只会聚焦已存在的窗口。 */
  const WINDOW_NAME = 'yintx-session-popout'

  /** 配置的 localStorage 键。 */
  const CONFIG_KEY = 'yintx.session-popout.config.v1'

  /** 内嵌小窗几何的 localStorage 键。 */
  const INLINE_KEY = 'yintx.session-popout.inline.v1'

  /** 内嵌小窗默认尺寸（比独立窗口略大，因为它浮在主界面之上）。 */
  const INLINE_DEFAULT = { width: 560, height: 780 }

  /** 内嵌小窗浮层的 z-index（比待办浮窗略高，免得互相压）。 */
  const INLINE_Z = 2147482200

  /** 宿主半配置路由。 */
  const ROUTE_CONFIG = '/plugin-session-popout/config'

  /**
   * 默认配置（与宿主半 DEFAULT_CONFIG 同值；客户端本地优先、宿主兜底）。
   *
   * `mode` 决定「开小窗」走哪条路：
   *   - `inline`（默认）：在页面里开一个**内嵌浮窗**（iframe 加载同一地址）。
   *     为什么默认是这个 —— DSH 桌面端是 **Tauri + WebView2**，宿主没有开新窗口的处理器，
   *     `window.open` 会**静默什么也不做**（既不报错也不返回可用句柄），实测"拖了没反应"。
   *     内嵌浮窗在任何宿主里都能用，效果就是"会话被拖出来浮在界面上"。
   *   - `window`：坚持用 `window.open` 开真·独立窗口（浏览器里更顺手）。
   *   - `auto`：先试 `window.open`，被明确拒绝（返回 null）再退回内嵌。
   */
  const DEFAULT_CONFIG = { width: 520, height: 760, slim: true, reuse: true, mode: 'inline' }

  /** 允许的 mode 取值。 */
  const MODES = ['inline', 'window', 'auto']

  /** 拖拽多少像素算「拖出来了」。 */
  const DRAG_THRESHOLD = 60

  /** 跨窗口（内嵌小窗 ↔ 主窗口）的消息前缀。 */
  const MSG_PREFIX = 'yintx-session-popout:'

  /** 会话标题最多接受多少字（再长就交给宿主裁决，这里只挡明显无效值）。 */
  const RENAME_MAX_LENGTH = 120

  // ── 纯函数（导出给冒烟测试）─────────────────────────────────────────────

  /** 数值夹紧：非有限数回落 fallback。 */
  function clampNumber(value, lo, hi, fallback) {
    const num = typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.min(hi, Math.max(lo, num))
  }

  /**
   * 解析一份小窗配置（脏值一律回默认/夹紧）。
   * @param raw 待解析对象
   * @returns `{ width, height, slim, reuse, mode }`
   */
  function resolveConfig(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const mode = MODES.includes(source.mode) ? source.mode : DEFAULT_CONFIG.mode
    return {
      width: clampNumber(source.width, 320, 3840, DEFAULT_CONFIG.width),
      height: clampNumber(source.height, 240, 2160, DEFAULT_CONFIG.height),
      slim: source.slim === undefined ? DEFAULT_CONFIG.slim : source.slim === true,
      reuse: source.reuse === undefined ? DEFAULT_CONFIG.reuse : source.reuse === true,
      mode,
    }
  }

  /**
   * 夹紧内嵌小窗的几何：默认落在视口右下方，标题栏必须留在视口内。
   * @param raw 待解析几何
   * @param viewport `{ width, height }`
   */
  function resolveInlineGeometry(raw, viewport) {
    const vw = clampNumber(viewport?.width, 320, 100000, 1440)
    const vh = clampNumber(viewport?.height, 240, 100000, 900)
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const width = clampNumber(source.width, 320, Math.max(320, vw - 16), INLINE_DEFAULT.width)
    const height = clampNumber(source.height, 240, Math.max(240, vh - 16), INLINE_DEFAULT.height)
    const fallbackLeft = vw - width - 24
    const fallbackTop = Math.max(16, vh - height - 64)
    const left = clampNumber(source.left, 80 - width, vw - 80, fallbackLeft)
    const top = clampNumber(source.top, 0, vh - 34, fallbackTop)
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    }
  }

  /**
   * 小窗 URL：在当前地址上打 `yintx_popout=1`（**原样保留** token 与其它查询参数）。
   * @param href 当前地址
   * @returns 小窗地址（href 不可解析时原样返回）
   */
  function buildPopoutUrl(href) {
    try {
      const url = new URL(String(href))
      url.searchParams.set(FLAG_PARAM, '1')
      return url.href
    } catch {
      return String(href)
    }
  }

  /** 当前地址是不是小窗（由本插件自己开的）。 */
  function isPopoutLocation(href) {
    try {
      return new URL(String(href)).searchParams.get(FLAG_PARAM) === '1'
    } catch {
      return false
    }
  }

  /**
   * `window.open` 的 features 串：按配置算出居中的弹窗，带上 popup 标记。
   * @param config 已解析配置
   * @param screen `{ width, height }`（视口或屏幕）
   */
  function popoutFeatures(config, screen) {
    const width = config.width
    const height = config.height
    const left = Math.max(0, Math.round(((screen?.width ?? 1440) - width) / 2) + 80)
    const top = Math.max(0, Math.round(((screen?.height ?? 900) - height) / 2) - 20)
    return `popup=yes,width=${width},height=${height},left=${left},top=${top}`
  }

  /** 拖拽是否达到「拖出来」的阈值（按欧氏距离）。 */
  function dragReached(dx, dy, threshold = DRAG_THRESHOLD) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
    const limit = clampNumber(threshold, 1, 10000, DRAG_THRESHOLD)
    return Math.sqrt(dx * dx + dy * dy) >= limit
  }

  // ── 样式 ──────────────────────────────────────────────────────────────────

  /**
   * 两段样式：
   *   1. 主窗口的小胶囊（右上角，悬停才显眼）；
   *   2. 小窗模式的精简规则（只在 html[data-yintx-popout="1"] 下生效）。
   * 整屏浮层的硬要求与 todo-float 一致：pointer-events: none + -webkit-app-region: initial。
   */
  const STYLE_TEXT = `
[data-dsh-plugin="session-popout"] {
  position: fixed;
  top: 52px;
  right: 16px;
  z-index: 2147482100;
  pointer-events: none;
  -webkit-app-region: initial !important;
  font-family: var(--dsw-font-family, "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif);
}
[data-dsh-part="popout-launcher"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
  border-radius: 15px;
  background: var(--dsw-alias-bg-layer-2, rgba(24, 26, 33, 0.82));
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  color: var(--dsw-alias-label-primary, #e9ecf4);
  font-size: 12px;
  line-height: 1;
  opacity: 0.42;
  cursor: grab;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  transition: opacity 0.15s ease, border-color 0.15s ease;
}
[data-dsh-part="popout-launcher"]:hover {
  opacity: 1;
  border-color: var(--dsw-alias-accent, #4f8cff);
}
[data-dsh-part="popout-launcher"]:active { cursor: grabbing; }
[data-dsh-part="popout-launcher"][data-dragging="true"] {
  opacity: 1;
  border-color: var(--dsw-alias-accent, #4f8cff);
}
[data-dsh-part="popout-hint"] {
  display: none;
  margin-top: 6px;
  padding: 4px 9px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(24, 26, 33, 0.92));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
  color: var(--dsw-alias-label-primary, #e9ecf4);
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
}
[data-dsh-plugin="session-popout"][data-hinting="true"] [data-dsh-part="popout-hint"] { display: inline-block; }
/* 小窗模式的浮条 */
[data-dsh-plugin="session-popout"][data-mode="popout"] {
  top: 8px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(24, 26, 33, 0.86));
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  opacity: 0.55;
}
[data-dsh-plugin="session-popout"][data-mode="popout"]:hover { opacity: 1; }
[data-dsh-plugin="session-popout"] [data-dsh-part="popout-action"] {
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa3b5);
  font-size: 11.5px;
  cursor: pointer;
  pointer-events: auto;
}
[data-dsh-plugin="session-popout"] [data-dsh-part="popout-action"]:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid, rgba(255, 255, 255, 0.12));
  color: var(--dsw-alias-label-primary, #e9ecf4);
}
/* ── 小窗精简：只留会话列（选择器都是尽力而为，猜不中就没有副作用）── */
[data-yintx-popout="1"] [class*="leftSidebar"],
[data-yintx-popout="1"] [class*="leftPanel"],
[data-yintx-popout="1"] [class*="sidebarCol"],
[data-yintx-popout="1"] [class*="workspaceRail"],
[data-yintx-popout="1"] [class*="titleBar"],
[data-yintx-popout="1"] [class*="titlebar"] { display: none !important; }
/* ── 内嵌小窗（桌面端 window.open 静默失效时的默认路径）── */
[data-dsh-plugin="session-popout"][data-role="inline"] {
  position: fixed;
  inset: 0;
  z-index: 2147482200;
  pointer-events: none;
  -webkit-app-region: initial !important;
  font-family: var(--dsw-font-family, "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif);
}
[data-role="inline"] [data-dsh-part="inline-win"] {
  position: absolute;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(20, 22, 28, 0.96));
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55), 0 2px 10px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  pointer-events: auto;
}
[data-role="inline"] [data-dsh-part="inline-bar"] {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  flex: 0 0 32px;
  padding: 0 4px 0 10px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02));
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
  color: var(--dsw-alias-label-primary, #e9ecf4);
  font-size: 12.5px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
[data-role="inline"] [data-dsh-part="inline-bar"]:active { cursor: grabbing; }
[data-role="inline"] [data-dsh-part="inline-title"] {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-role="inline"] [data-dsh-part="inline-rename-input"] {
  flex: 1 1 auto;
  min-width: 0;
  display: none;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-accent, #4f8cff);
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.35);
  color: var(--dsw-alias-label-primary, #e9ecf4);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
[data-role="inline"][data-renaming="true"] [data-dsh-part="inline-title"] { display: none; }
[data-role="inline"][data-renaming="true"] [data-dsh-part="inline-rename-input"] { display: block; }
[data-role="inline"] [data-dsh-part="inline-bar"] button {
  width: 34px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa3b5);
  font-size: 12.5px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
[data-role="inline"] [data-dsh-part="inline-bar"] button:hover { background: rgba(255, 255, 255, 0.12); color: var(--dsw-alias-label-primary, #e9ecf4); }
[data-role="inline"] [data-dsh-part="inline-bar"] button[data-ctl="close"]:hover { background: #e5484d; color: #fff; }
[data-role="inline"] [data-dsh-part="inline-frame"] { flex: 1 1 auto; width: 100%; border: 0; background: #14161c; }
[data-role="inline"] [data-dsh-part="inline-resize"] { position: absolute; z-index: 3; touch-action: none; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="n"] { top: -3px; left: 8px; right: 8px; height: 7px; cursor: ns-resize; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="s"] { bottom: -3px; left: 8px; right: 8px; height: 7px; cursor: ns-resize; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="e"] { right: -3px; top: 8px; bottom: 8px; width: 7px; cursor: ew-resize; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="w"] { left: -3px; top: 8px; bottom: 8px; width: 7px; cursor: ew-resize; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="ne"] { top: -3px; right: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="nw"] { top: -3px; left: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="se"] { bottom: -3px; right: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
[data-role="inline"] [data-dsh-part="inline-resize"][data-dir="sw"] { bottom: -3px; left: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
/* 主窗口上的一行提示（开窗方式回退时给个可见反馈，别让用户以为没反应） */
[data-dsh-part="popout-toast"] {
  display: none;
  margin-top: 6px;
  max-width: 260px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
  background: var(--dsw-alias-bg-layer-1, rgba(24, 26, 33, 0.92));
  color: var(--dsw-alias-label-primary, #e9ecf4);
  font-size: 11px;
  line-height: 1.5;
  pointer-events: none;
}
[data-dsh-plugin="session-popout"][data-toast="true"] [data-dsh-part="popout-toast"] { display: block; }
`

  /** 建元素（与 todo-float 同款小工具）。 */
  function el(doc, tag, part, className) {
    const node = doc.createElement(tag)
    if (part) node.setAttribute('data-dsh-part', part)
    if (className) node.className = className
    return node
  }

  /** 注入样式，返回移除函数。 */
  function injectStyle(doc) {
    if (!doc?.head) return () => {}
    if (typeof doc.querySelector === 'function' && doc.querySelector(`style[${STYLE_ATTR}]`)) return () => {}
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

  // ── 视图 ──────────────────────────────────────────────────────────────────

  /**
   * 建出「胶囊 + 提示条」（主窗口模式）或「小窗浮条」（小窗模式）的 DOM。
   *
   * @param doc document
   * @param mode `'main' | 'popout'`
   * @param handlers `{ onPopout(), onBackToMain(), onCloseWindow() }`
   * @returns 视图对象（含 `setHinting` / `destroy` 等）
   */
  function createLauncher(doc, mode = 'main', handlers = {}) {
    const root = el(doc, 'div')
    root.setAttribute('data-dsh-plugin', 'session-popout')
    root.setAttribute('data-mode', mode === 'popout' ? 'popout' : 'main')
    root.setAttribute('data-hinting', 'false')

    const attach = (node) => {
      if (doc?.body) doc.body.appendChild(node)
      return node
    }

    if (mode === 'popout') {
      // 小窗模式：两条动作 + 一句说明
      const labels = handlers.labels ?? { back: '回到主窗口', close: '关闭' }
      const back = el(doc, 'button', 'popout-action')
      back.setAttribute('type', 'button')
      back.setAttribute('title', labels.backTitle ?? labels.back)
      back.textContent = labels.back
      const close = el(doc, 'button', 'popout-action')
      close.setAttribute('type', 'button')
      close.setAttribute('title', labels.closeTitle ?? labels.close)
      close.textContent = labels.close
      back.addEventListener?.('click', () => handlers.onBackToMain?.())
      close.addEventListener?.('click', () => handlers.onCloseWindow?.())
      root.appendChild(back)
      root.appendChild(close)
      attach(root)
      return {
        root,
        getMode: () => root.getAttribute('data-mode'),
        destroy: () => {
          try {
            root.remove ? root.remove() : root.parentNode?.removeChild(root)
          } catch {}
        },
      }
    }

    // 主窗口模式：胶囊 + 提示
    const launcher = el(doc, 'button', 'popout-launcher')
    launcher.setAttribute('type', 'button')
    launcher.setAttribute('title', '把当前会话拖出来（拖 60px 或点一下）· Alt+Shift+P')
    const icon = el(doc, 'span')
    icon.textContent = '⇱'
    const label = el(doc, 'span')
    label.textContent = '会话小窗'
    launcher.appendChild(icon)
    launcher.appendChild(label)

    const hint = el(doc, 'div', 'popout-hint')
    hint.textContent = '松手 → 开成小窗'

    /** 可见反馈：开窗方式回退/失败时别再只写 console（用户会以为"拖了没反应"）。 */
    const toast = el(doc, 'div', 'popout-toast')
    toast.textContent = ''
    let toastTimer

    root.appendChild(launcher)
    root.appendChild(hint)
    root.appendChild(toast)
    attach(root)

    /** 拖拽跟踪：只有「按住胶囊」才算，不干扰会话里的选择与滚动。 */
    /** 拖拽已经触发过开窗时要吞掉紧随其后的 click（否则会开两次）。 */
    let suppressClick = false
    const startDrag = (event) => {
      if (event?.button !== undefined && event.button !== 0) return
      const startX = clampNumber(event?.clientX, -1e6, 1e6, 0)
      const startY = clampNumber(event?.clientY, -1e6, 1e6, 0)
      let reached = false
      const view = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined)
      if (!view?.addEventListener) return
      const move = (moveEvent) => {
        const dx = clampNumber(moveEvent?.clientX, -1e6, 1e6, startX) - startX
        const dy = clampNumber(moveEvent?.clientY, -1e6, 1e6, startY) - startY
        const now = dragReached(dx, dy)
        if (now !== reached) {
          reached = now
          root.setAttribute('data-hinting', now ? 'true' : 'false')
          launcher.setAttribute('data-dragging', now ? 'true' : 'false')
        }
      }
      const finish = () => {
        view.removeEventListener?.('pointermove', move)
        view.removeEventListener?.('pointerup', finish)
        view.removeEventListener?.('pointercancel', finish)
        root.setAttribute('data-hinting', 'false')
        launcher.setAttribute('data-dragging', 'false')
        suppressClick = reached
        if (reached) handlers.onPopout?.('drag')
      }
      view.addEventListener('pointermove', move)
      view.addEventListener('pointerup', finish)
      view.addEventListener('pointercancel', finish)
    }

    launcher.addEventListener?.('pointerdown', (event) => {
      event?.preventDefault?.()
      startDrag(event)
    })
    launcher.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      if (suppressClick) {
        suppressClick = false
        return
      }
      handlers.onPopout?.('click')
    })

    return {
      root,
      launcher,
      hint,
      toast,
      setHinting: (on) => root.setAttribute('data-hinting', on ? 'true' : 'false'),
      /** 弹一条小提示（毫秒后自动收起）。 */
      showToast: (text, ms = 4200) => {
        toast.textContent = String(text ?? '')
        root.setAttribute('data-toast', 'true')
        if (toastTimer !== undefined) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => {
          root.setAttribute('data-toast', 'false')
        }, clampNumber(ms, 800, 20000, 4200))
      },
      hideToast: () => {
        if (toastTimer !== undefined) clearTimeout(toastTimer)
        root.setAttribute('data-toast', 'false')
      },
      getMode: () => root.getAttribute('data-mode'),
      destroy: () => {
        if (toastTimer !== undefined) clearTimeout(toastTimer)
        try {
          root.remove ? root.remove() : root.parentNode?.removeChild(root)
        } catch {}
      },
    }
  }

  /** 内嵌小窗 → 主窗口 的一条 postMessage（同源；取不到 origin 就退到 `*`）。 */
  function postToParent(action) {
    try {
      const view = typeof window !== 'undefined' ? window : undefined
      const target = view?.parent ?? globalThis.parent
      if (!target || typeof target.postMessage !== 'function') return false
      target.postMessage({ type: `${MSG_PREFIX}${action}` }, view?.location?.origin ?? '*')
      return true
    } catch {
      return false
    }
  }

  // ── 内嵌小窗视图 ──────────────────────────────────────────────────────────

  /**
   * 建出「内嵌小窗」：标题栏（可拖）+ iframe + 八向缩放手柄。
   *
   * 这是**桌面端的默认开窗方式**：DSH 桌面端跑在 Tauri + WebView2 上，宿主没有新窗口处理器，
   * `window.open` 会静默什么都不做；内嵌浮窗不依赖任何宿主能力，效果就是"会话被拖出来浮在界面上"。
   * 懒插入：构造时不进 DOM，第一次 `open(url)` 才挂上 body；`close()` 摘掉并清空 `src`（断开那条连接）。
   *
   * @param doc document
   * @param handlers `{ onClose(), onDetach(), onGeometry(geom, reason) }`
   */
  function createInlineWindow(doc, handlers = {}) {
    const root = el(doc, 'div')
    root.setAttribute('data-dsh-plugin', 'session-popout')
    root.setAttribute('data-role', 'inline')
    root.setAttribute('data-open', 'false')

    const win = el(doc, 'section', 'inline-win')
    win.setAttribute('role', 'dialog')
    win.setAttribute('aria-label', '会话小窗')

    const bar = el(doc, 'header', 'inline-bar')
    const title = el(doc, 'span', 'inline-title')
    title.textContent = '会话小窗'
    // 重命名输入框（点 ✎ 后才出现；Enter 提交、Esc 取消）
    const renameInput = el(doc, 'input', 'inline-rename-input')
    renameInput.setAttribute('data-ctl', 'rename-input')
    renameInput.setAttribute('type', 'text')
    renameInput.setAttribute('maxlength', String(RENAME_MAX_LENGTH))
    renameInput.setAttribute('aria-label', '会话标题')
    renameInput.value = ''

    const controls = el(doc, 'div')
    const makeButton = (ctl, label, glyph, tip) => {
      const button = el(doc, 'button')
      button.setAttribute('data-ctl', ctl)
      button.setAttribute('type', 'button')
      button.setAttribute('aria-label', label)
      button.setAttribute('title', tip)
      button.textContent = glyph
      return button
    }
    const btnRename = makeButton('rename', '重命名会话', '✎', '重命名当前会话标题')
    const btnRefresh = makeButton('refresh', '重新加载', '⟳', '重新加载小窗内容')
    const btnDetach = makeButton('detach', '弹出为独立窗口', '⇱', '尝试用系统弹窗打开（浏览器里有效）')
    const btnClose = makeButton('close', '关闭小窗', '✕', '关闭小窗')
    controls.appendChild(btnRename)
    controls.appendChild(btnRefresh)
    controls.appendChild(btnDetach)
    controls.appendChild(btnClose)
    bar.appendChild(title)
    bar.appendChild(renameInput)
    bar.appendChild(controls)

    const frame = el(doc, 'iframe', 'inline-frame')
    frame.setAttribute('title', '会话小窗')

    const handles = []
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = el(doc, 'div', 'inline-resize')
      handle.setAttribute('data-dir', dir)
      handles.push({ dir, node: handle })
      win.appendChild(handle)
    }

    win.appendChild(bar)
    win.appendChild(frame)
    root.appendChild(win)

    const viewOf = () => doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined)
    const viewportSize = () => {
      const view = viewOf()
      return {
        width: clampNumber(view?.innerWidth, 320, 100000, 1440),
        height: clampNumber(view?.innerHeight, 240, 100000, 900),
      }
    }

    let geometry = resolveInlineGeometry(null, viewportSize())
    let open = false
    /** 当前会话标题（重命名预填与显示用）。 */
    let currentTitle = ''
    /** 是否正处在重命名输入态。 */
    let renaming = false

    const paint = () => {
      win.style.left = `${geometry.left}px`
      win.style.top = `${geometry.top}px`
      win.style.width = `${geometry.width}px`
      win.style.height = `${geometry.height}px`
      root.setAttribute('data-open', open ? 'true' : 'false')
    }

    /** 打开（或重新指向）小窗内容。 */
    const show = (url) => {
      if (typeof url === 'string' && url !== '') frame.setAttribute('src', url)
      if (!open) {
        open = true
        doc?.body?.appendChild(root)
        try {
          viewOf()?.addEventListener('resize', onResize)
        } catch {}
      } else {
        // 已经开着：把 URL 更新一次（重新聚焦同一会话）
        if (typeof url === 'string' && url !== '') frame.setAttribute('src', url)
      }
      geometry = resolveInlineGeometry(geometry, viewportSize())
      paint()
      handlers.onGeometry?.(geometry, 'inline-show')
      try {
        frame.focus?.()
      } catch {}
      return geometry
    }

    const hide = (reason) => {
      if (!open) return
      open = false
      root.remove ? root.remove() : root.parentNode?.removeChild(root)
      try {
        frame.setAttribute('src', 'about:blank')
      } catch {}
      try {
        viewOf()?.removeEventListener('resize', onResize)
      } catch {}
      handlers.onGeometry?.(geometry, reason ?? 'close')
    }

    const onResize = () => {
      geometry = resolveInlineGeometry(geometry, viewportSize())
      paint()
    }

    /** 拖动 / 缩放的共同入口。 */
    const startPointer = (event, kind, dir) => {
      if (event?.button !== undefined && event.button !== 0) return
      const start = { ...geometry }
      const startX = clampNumber(event?.clientX, -1e6, 1e6, 0)
      const startY = clampNumber(event?.clientY, -1e6, 1e6, 0)
      event?.preventDefault?.()
      try {
        event?.target?.setPointerCapture?.(event.pointerId)
      } catch {}
      const view = viewOf()
      if (!view?.addEventListener) return
      const move = (moveEvent) => {
        const dx = clampNumber(moveEvent?.clientX, -1e6, 1e6, startX) - startX
        const dy = clampNumber(moveEvent?.clientY, -1e6, 1e6, startY) - startY
        if (kind === 'drag') {
          geometry = resolveInlineGeometry({ ...start, left: start.left + dx, top: start.top + dy }, viewportSize())
        } else {
          let width = start.width
          let height = start.height
          let left = start.left
          let top = start.top
          if (dir.includes('e')) width = start.width + dx
          if (dir.includes('w')) width = start.width - dx
          if (dir.includes('s')) height = start.height + dy
          if (dir.includes('n')) height = start.height - dy
          if (dir.includes('w')) left = start.left + (start.width - width)
          if (dir.includes('n')) top = start.top + (start.height - height)
          geometry = resolveInlineGeometry({ left, top, width, height }, viewportSize())
        }
        paint()
      }
      const finish = () => {
        view.removeEventListener?.('pointermove', move)
        view.removeEventListener?.('pointerup', finish)
        view.removeEventListener?.('pointercancel', finish)
        handlers.onGeometry?.(geometry, kind === 'drag' ? 'inline-drag-end' : 'inline-resize-end')
      }
      view.addEventListener('pointermove', move)
      view.addEventListener('pointerup', finish)
      view.addEventListener('pointercancel', finish)
    }

    /** 点在这些控制按钮上时不触发拖动。 */
    const isControl = (target) => {
      if (!target?.getAttribute) return false
      if (target.getAttribute('data-ctl')) return true
      return typeof target.closest === 'function' && target.closest('[data-ctl]') !== null
    }
    bar.addEventListener?.('pointerdown', (event) => {
      if (isControl(event?.target)) return
      startPointer(event, 'drag')
    })
    for (const handle of handles) {
      handle.node.addEventListener?.('pointerdown', (event) => startPointer(event, 'resize', handle.dir))
    }

    // ── 重命名：标题栏里就地改（Enter 提交、Esc 取消、点 ✎ 再来一次）──
    /** 改标题栏文字（打开小窗时由宿主传入当前会话标题）。 */
    const setTitle = (text) => {
      currentTitle = typeof text === 'string' ? text.trim() : ''
      title.textContent = currentTitle !== '' ? `会话小窗 · ${currentTitle}` : '会话小窗'
    }

    /** 进入重命名：标题换成输入框，预填当前会话标题。 */
    const beginRename = () => {
      if (renaming) return false
      renaming = true
      root.setAttribute('data-renaming', 'true')
      renameInput.value = currentTitle
      try {
        renameInput.focus?.()
        renameInput.select?.()
      } catch {}
      return true
    }
    /** 退出重命名（取消或提交完）。 */
    const endRename = () => {
      renaming = false
      root.setAttribute('data-renaming', 'false')
      renameInput.value = ''
    }
    /** 提交：成功就改标题，失败回滚并让宿主给可见反馈。 */
    const commitRename = async () => {
      if (!renaming) return false
      const next = String(renameInput.value ?? '').trim()
      if (next === '' || next.length > RENAME_MAX_LENGTH) {
        endRename()
        return false
      }
      const ok = await handlers.onRename?.(next)
      if (ok === true) {
        endRename()
        setTitle(next)
        return true
      }
      endRename()
      handlers.onRenameFailed?.(next)
      return false
    }

    btnRename.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      if (renaming) void commitRename()
      else beginRename()
    })
    renameInput.addEventListener?.('keydown', (event) => {
      const key = String(event?.key ?? '')
      if (key === 'Enter') {
        event?.preventDefault?.()
        void commitRename()
      } else if (key === 'Escape') {
        event?.preventDefault?.()
        endRename()
      }
    })
    renameInput.addEventListener?.('blur', () => {
      // 点 ✎ 提交时也会先触发 blur：让 click 先跑，再兜底关掉输入态
      setTimeout(() => {
        if (renaming) endRename()
      }, 0)
    })

    btnRefresh.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      const src = frame.getAttribute?.('src') ?? ''
      try {
        if (typeof frame.setAttribute === 'function') frame.setAttribute('src', src)
      } catch {}
    })
    btnDetach.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      handlers.onDetach?.()
    })
    btnClose.addEventListener?.('click', (event) => {
      event?.stopPropagation?.()
      hide('close-button')
      handlers.onClose?.()
    })

    paint()

    return {
      root,
      win,
      frame,
      show,
      hide,
      isOpen: () => open,
      setTitle,
      beginRename,
      isRenaming: () => renaming,
      getTitle: () => currentTitle,
      setGeometry: (next) => {
        geometry = resolveInlineGeometry(next, viewportSize())
        paint()
      },
      getGeometry: () => ({ ...geometry }),
      destroy: () => {
        hide('destroy')
        try {
          root.remove ? root.remove() : root.parentNode?.removeChild(root)
        } catch {}
      },
    }
  }

  // ── 配置读写 ──────────────────────────────────────────────────────────────

  /** 读任意 JSON（localStorage 不可用或坏值都回 null）。 */
  function readJson(storage, key) {
    try {
      const raw = storage?.getItem?.(key)
      if (typeof raw !== 'string' || raw === '') return null
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** 写任意 JSON（配额/隐私模式失败静默）。 */
  function writeJson(storage, key, value) {
    try {
      storage?.setItem?.(key, JSON.stringify(value))
      return true
    } catch {
      return false
    }
  }

  /** 读本地配置（坏值/不可用回 null）。 */
  function readLocalConfig(storage) {
    try {
      const raw = storage?.getItem?.(CONFIG_KEY)
      if (typeof raw !== 'string' || raw === '') return null
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  /** 写本地配置（失败静默）。 */
  function writeLocalConfig(storage, config) {
    try {
      storage?.setItem?.(CONFIG_KEY, JSON.stringify(config))
      return true
    } catch {
      return false
    }
  }

  /** 读宿主半配置（拿不到回 null）。 */
  async function readHostConfig() {
    try {
      const response = await fetch(ROUTE_CONFIG, { credentials: 'same-origin' })
      if (!response.ok) return null
      const payload = await response.json()
      return payload?.ok === true && payload.config ? payload.config : null
    } catch {
      return null
    }
  }

  // ── 会话重命名（走官方 sessions 服务，不自己拼接口）──────────────────────

  /** 当前会话：官方判据 `retainedBy.mainView > 0` 的那条。 */
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

  /**
   * 调官方客户端服务重命名会话：优先 `sessions.rename(sessionId, title)`，
   * 退而求其次 `session.rename(title)`。返回是否成功；任何失败只回 false，不抛。
   * @param sessions `ctx.get('sessions')`
   * @param sessionId 目标会话
   * @param title 新标题
   */
  async function renameSession(sessions, sessionId, title) {
    const next = typeof title === 'string' ? title.trim() : ''
    if (next === '' || next.length > RENAME_MAX_LENGTH || sessionId === undefined) return false
    try {
      if (typeof sessions?.rename === 'function') {
        const result = await sessions.rename(sessionId, next)
        return result?.ok === true
      }
      const binding = sessions?.binding?.(sessionId)
      if (binding?.session && typeof binding.session.rename === 'function') {
        const result = await binding.session.rename(next)
        return result?.ok === true
      }
    } catch {}
    return false
  }

  // ── 插件本体 ──────────────────────────────────────────────────────────────

  /** 开小窗（同名窗口复用；返回窗口句柄或 null）。 */
  function openPopout(url, config, view) {
    try {
      const screen = {
        width: view?.innerWidth ?? globalThis.innerWidth ?? 1440,
        height: view?.innerHeight ?? globalThis.innerHeight ?? 900,
      }
      const handle = view?.open?.(url, WINDOW_NAME, popoutFeatures(config, screen))
      if (handle === null || handle === undefined) {
        console.warn(`[${NAME}] 小窗被浏览器拦截了：请允许本站弹窗，或改用快捷键后再试`)
        return null
      }
      try {
        handle.focus?.()
      } catch {}
      return handle
    } catch (error) {
      console.warn(`[${NAME}] 开小窗失败：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 挂载。主窗口与小窗共用一份代码，按 `location` 分岔：
   *   - 小窗：打 html 标记 + 精简样式 + 「回到主窗口 / 关闭」浮条；
   *   - 主窗口：小胶囊（点击/拖出）+ 快捷键。
   */
  async function apply(ctx) {
    const doc = typeof document !== 'undefined' ? document : undefined
    if (!doc?.body) {
      console.warn(`[${NAME}] 没有 document.body，跳过挂载`)
      return
    }
    const view = doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined)
    const href = view?.location?.href ?? globalThis.location?.href ?? ''
    const popout = isPopoutLocation(href)

    const removeStyle = injectStyle(doc)
    const disposers = []
    const remember = (fn) => {
      if (typeof fn === 'function') disposers.push(fn)
    }

    if (popout) {
      doc.documentElement?.setAttribute?.(FLAG_ATTR, '1')
      // 被内嵌在主页面里时（桌面端的默认路径），浮条的动作要交给父窗口去做：
      // 内嵌 iframe 里 window.close() 无效，也没有 opener 可聚焦。
      const embedded = (() => {
        try {
          return Boolean(view?.self && view?.top && view.self !== view.top)
        } catch {
          return true
        }
      })()
      const ui = createLauncher(doc, 'popout', {
        labels: embedded
          ? { back: '弹出为独立窗口', close: '关闭小窗', backTitle: '让主窗口用系统弹窗打开', closeTitle: '关闭这个内嵌小窗' }
          : { back: '回到主窗口', close: '关闭', backTitle: '聚焦主窗口', closeTitle: '关闭小窗' },
        onBackToMain: () => {
          if (embedded) {
            postToParent('detach')
            return
          }
          try {
            const opener = view?.opener ?? globalThis.opener
            if (opener && typeof opener.focus === 'function') opener.focus()
            else console.info(`[${NAME}] 主窗口已经关掉了`)
          } catch {}
        },
        onCloseWindow: () => {
          if (embedded) {
            postToParent('close')
            return
          }
          try {
            view?.close?.()
          } catch {}
        },
      })
      remember(() => {
        ui.destroy()
        doc.documentElement?.removeAttribute?.(FLAG_ATTR)
      })
      console.info(`[${NAME}] 小窗模式已就绪（${embedded ? '内嵌' : '独立窗口'}）`)
    } else {
      const storage = (() => {
        try {
          return typeof localStorage !== 'undefined' ? localStorage : undefined
        } catch {
          return undefined
        }
      })()
      // 会话服务（重命名要用；拿不到只影响重命名按钮，不影响开小窗）
      const sessions = (() => {
        try {
          return ctx?.get?.('sessions')
        } catch {
          return undefined
        }
      })()
      const local = readLocalConfig(storage)
      const config = resolveConfig(local ?? (await readHostConfig()))
      if (local === null) writeLocalConfig(storage, config)

      const urlOf = () => buildPopoutUrl(view?.location?.href ?? href)

      /** 内嵌小窗（懒建；几何记在本地）。 */
      let inline
      const openInline = (reason) => {
        if (inline === undefined) {
          inline = createInlineWindow(doc, {
            onGeometry: (geom) => writeJson(storage, INLINE_KEY, geom),
            onRename: async (title) => renameSession(sessions, currentSessionId(sessions), title),
            onRenameFailed: () => ui?.showToast('重命名失败：当前会话不可用，或标题被宿主拒绝'),
            onDetach: () => {
              if (tryWindowPopup('detach')) inline?.hide('detached')
              else ui?.showToast('这个桌面宿主不允许系统弹窗（DSH 桌面端是 Tauri/WebView2），小窗继续内嵌显示')
            },
          })
          const saved = readJson(storage, INLINE_KEY)
          if (saved !== null) inline.setGeometry(saved)
        }
        inline.setTitle(typeof doc.title === 'string' ? doc.title : '')
        inline.show(urlOf())
        console.info(`[${NAME}] 已开内嵌小窗（${reason}）`)
      }

      /** 试一次系统弹窗；返回"到底开没开成"。 */
      const tryWindowPopup = (reason) => {
        console.info(`[${NAME}] 尝试系统弹窗（${reason}）`)
        return openPopout(urlOf(), config, view) !== null
      }

      let ui
      const trigger = (reason) => {
        const url = urlOf()
        console.info(
          `[${NAME}] 开小窗（${reason}，mode=${config.mode}）：${url.replace(/([?&])token=[^&]*/i, '$1token=***')}`,
        )
        // inline（默认）：桌面端 window.open 静默失效，直接走内嵌
        if (config.mode === 'inline') {
          openInline(reason)
          return
        }
        if (config.mode === 'window') {
          if (tryWindowPopup(reason)) return
          ui?.showToast('系统弹窗被宿主拒绝了，已改用内嵌小窗')
          openInline(`${reason}+fallback`)
          return
        }
        // auto：先弹窗，明确失败再退回内嵌
        if (tryWindowPopup(reason)) return
        ui?.showToast('系统弹窗不可用，已改用内嵌小窗')
        openInline(`${reason}+auto`)
      }

      ui = createLauncher(doc, 'main', { onPopout: trigger })
      remember(() => ui.destroy())
      remember(() => inline?.destroy())

      /** 内嵌小窗里的浮条按钮通过 postMessage 请父窗口做事。 */
      const onMessage = (event) => {
        const data = event?.data
        if (!data || typeof data !== 'object') return
        if (typeof data.type !== 'string' || !data.type.startsWith(MSG_PREFIX)) return
        const action = data.type.slice(MSG_PREFIX.length)
        if (action === 'close') {
          inline?.hide('child-request')
          return
        }
        if (action === 'detach') {
          if (tryWindowPopup('child-detach')) inline?.hide('detached')
          else ui?.showToast('这个桌面宿主不允许系统弹窗（DSH 桌面端是 Tauri/WebView2），小窗继续内嵌显示')
        }
      }
      view?.addEventListener?.('message', onMessage)
      remember(() => view?.removeEventListener?.('message', onMessage))

      const onKey = (event) => {
        if (!event?.altKey || !event?.shiftKey) return
        if (String(event.key ?? '').toLowerCase() !== 'p') return
        event.preventDefault?.()
        trigger('hotkey')
      }
      view?.addEventListener?.('keydown', onKey)
      remember(() => view?.removeEventListener?.('keydown', onKey))

      console.info(
        `[${NAME}] 已就绪（mode=${config.mode}）：拖右上角胶囊出 60px（或点它 / Alt+Shift+P）即可把会话开成小窗`,
      )
    }

    const cleanup = () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {}
      }
      try {
        removeStyle()
      } catch {}
    }
    try {
      ctx?.effect?.(() => cleanup)
    } catch {
      // 没有 effect 席位就随页面生命周期存在
    }
  }

  const exported = {
    name: NAME,
    inject: [],
    apply,
    STYLE_ATTR,
    FLAG_PARAM,
    FLAG_ATTR,
    WINDOW_NAME,
    CONFIG_KEY,
    INLINE_KEY,
    INLINE_DEFAULT,
    INLINE_Z,
    MODES,
    MSG_PREFIX,
    ROUTE_CONFIG,
    DRAG_THRESHOLD,
    DEFAULT_CONFIG,
    clampNumber,
    resolveConfig,
    resolveInlineGeometry,
    buildPopoutUrl,
    isPopoutLocation,
    popoutFeatures,
    dragReached,
    createLauncher,
    createInlineWindow,
    postToParent,
    currentSessionId,
    renameSession,
    readJson,
    writeJson,
    readLocalConfig,
    writeLocalConfig,
    openPopout,
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__?.load) {
    window.__ModuleLoader__.load({
      // 注册 id 必须是**字面量**：合集生成器按文本校验它与子插件包名同源。
      id: 'dsh-plugin-session-popout',
      factory: (require) => {
        void require
        return exported
      },
    })
  }
  if (typeof globalThis !== 'undefined') globalThis.__yintxSessionPopoutExports = exported
})()

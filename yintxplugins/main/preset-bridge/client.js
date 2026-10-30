/**
 * dsh-preset-bridge —— 客户端半（浏览器）。
 *
 * 0.1.5 的官方预设卡片上有一个「打开目录」图标按钮，0.2.0 把那个宿主接口和按钮整块删了。
 * 包里原来靠 `scripts/patch-agent-preset.ps1` **给官方文件打补丁**把它加回来，但那个脚本只在
 * `npm-cache\_npx` 里找目标 —— 桌面版的官方代码打包在 `app.asar` 里，脚本根本够不到，
 * 所以桌面版里那个按钮永远不会出现。
 *
 * 这个客户端半改用**纯 DOM 注入**把按钮加回来：不动官方任何文件，官方怎么打包都有效。
 * 点击时调宿主半的 `POST /preset-folder/open`，body 传预设的**显示名** —— 因为 DOM 里只有
 * 显示名（见下），由宿主在 `DSH_HOME/.agent-presets` 下按名字找到目录再交给文件管理器。
 *
 * ⚠️ 必须是「经典脚本 bundle」：官方客户端模块系统把 `exports["./client"]` 指向的文件当
 * classic script 直接执行，所以本文件里**不能出现 `import` / `export` 语句**。
 *
 * 定位官方卡片的方式（0.2.0 实测结构，取自 `dsh-client-ui-agent-preset/lib/client.js`）：
 *   卡片里的图标按钮 = `button[class*="_iconButton"]`（类名带 hash 前缀如 `KZf9OG_`，
 *   所以只匹配后缀）；它的 `aria-label` 形如 `<浏览>: <预设显示名>`，
 *   于是显示名 = 第一个 ": " 之后的全部内容。
 */
window.__ModuleLoader__.load({
  id: 'dsh-preset-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 插进去的按钮挂这个属性：既是识别标记，也用来存它对应的预设显示名。 */
    var ATTR = 'data-dsh-preset-open'
    var STYLE_ID = 'dsh-preset-open-css'
    /** 宿主路由（preset-bridge 宿主半注册）。 */
    var ENDPOINT = '/preset-folder/open'
    /** 官方「浏览」按钮的类名特征 —— hash 前缀会随构建变化，只匹配后缀。 */
    var ANCHOR_SELECTOR = 'button[class*="_iconButton"]'
    /** 兜底轮询间隔（毫秒）：MutationObserver 之外的保险，防止某些渲染时机漏掉。 */
    var SWEEP_INTERVAL_MS = 1000

    /**
     * 样式照官方卡片上那排图标按钮写（主 CSS 里的 `._iconButton_*`）：
     * 28×28 见方、6 内边距、radius-sm、label-secondary、悬停用 interactive-bg-hover、
     * 图标 15×15 —— 这样插进去的这颗和它旁边官方那几颗看起来是一套的。
     */
    var CSS = [
      '[data-dsh-preset-open]{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);line-height:1;cursor:pointer}',
      '[data-dsh-preset-open]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-preset-open]:disabled{cursor:default;opacity:.4}',
      '[data-dsh-preset-open]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '[data-dsh-preset-open][data-failed="1"]{color:var(--dsw-alias-state-error-primary)}',
      '[data-dsh-preset-open] svg{width:15px;height:15px}',
    ].join('')

    /** Lucide `folder-open` 的路径数据（ISC 许可证，https://lucide.dev，24×24 描边式）。 */
    var FOLDER_OPEN_PATH =
      'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'

    var SVG_NS = 'http://www.w3.org/2000/svg'

    /** 建一个内联 svg 图标（用 DOM API 而不是 innerHTML，免得碰 CSP）。 */
    function icon() {
      var svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      var path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', FOLDER_OPEN_PATH)
      svg.appendChild(path)
      return svg
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return
      try {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (error) {}
    }

    /**
     * 从官方「浏览」按钮上读出预设显示名。
     * `aria-label` 是 `<浏览>: <显示名>`，取第一个 ": " **之后**的全部内容
     * （用第一次出现的位置而不是 split，这样显示名里再带冒号也不会被截断）。
     */
    function presetNameOf(anchor) {
      var label = ''
      try {
        label = String(anchor.getAttribute('aria-label') || '')
      } catch (error) {
        return ''
      }
      var index = label.indexOf(': ')
      return index < 0 ? '' : label.slice(index + 2).trim()
    }

    /** POST 一个 JSON，永不抛：失败也返回 { ok:false, status, payload }。 */
    function postJson(path, body) {
      return fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(
        function (response) {
          return response.text().then(
            function (text) {
              var payload = null
              try {
                payload = text ? JSON.parse(text) : null
              } catch (error) {
                payload = null
              }
              return { status: response.status, ok: response.ok !== false, payload: payload }
            },
            function () {
              return { status: response.status, ok: false, payload: null }
            },
          )
        },
        function (error) {
          return { status: 0, ok: false, payload: null, error: String(error) }
        },
      )
    }

    /** 造一个「打开目录」按钮；`name` 就是预设显示名。 */
    function makeButton(name) {
      var button = document.createElement('button')
      button.type = 'button'
      button.setAttribute(ATTR, name)
      button.setAttribute('data-tip', '打开目录')
      button.setAttribute('aria-label', '打开目录: ' + name)
      button.appendChild(icon())
      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        if (button.getAttribute('data-busy') === '1') return
        button.setAttribute('data-busy', '1')
        button.removeAttribute('data-failed')
        button.title = '正在打开…'
        postJson(ENDPOINT, { name: name }).then(function (result) {
          button.removeAttribute('data-busy')
          var payload = result.payload || {}
          if (!result.ok || payload.ok !== true) {
            var message = payload.message || ('HTTP ' + result.status)
            button.setAttribute('data-failed', '1')
            button.title = message
            console.warn('[dsh-preset-bridge] 打开预设目录失败：', message)
            return
          }
          button.title = payload.path || '已打开'
        })
      })
      return button
    }

    /** 一轮巡检：给每张还没有「打开目录」按钮的预设卡片补一个。 */
    function sweep() {
      var anchors
      try {
        anchors = Array.prototype.slice.call(document.querySelectorAll(ANCHOR_SELECTOR))
      } catch (error) {
        return
      }
      for (var i = 0; i < anchors.length; i += 1) {
        var anchor = anchors[i]
        var parent = anchor && anchor.parentNode
        if (!parent) continue
        var name = presetNameOf(anchor)
        // 拿不到显示名（不是预设卡片上的那个按钮）就跳过，免得往别处乱插
        if (name === '') continue
        var existing = null
        try {
          existing = parent.querySelector('[' + ATTR + ']')
        } catch (error) {}
        if (existing) {
          // 卡片换了预设（列表刷新复用节点）→ 跟着改
          if (existing.getAttribute(ATTR) !== name) existing.setAttribute(ATTR, name)
          continue
        }
        try {
          parent.insertBefore(makeButton(name), anchor.nextSibling)
        } catch (error) {}
      }
    }

    function apply() {
      installStyle()
      try {
        var observer = new MutationObserver(function () {
          sweep()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch (error) {}
      try {
        setInterval(sweep, SWEEP_INTERVAL_MS)
      } catch (error) {}
      try {
        sweep()
      } catch (error) {}
    }

    exports.name = 'dsh-preset-bridge'
    exports.inject = []
    exports.apply = apply
    /** 供离线冒烟测试使用。 */
    exports.__test = {
      sweep: sweep,
      presetNameOf: presetNameOf,
      makeButton: makeButton,
      ATTR: ATTR,
      STYLE_ID: STYLE_ID,
      ANCHOR_SELECTOR: ANCHOR_SELECTOR,
      ENDPOINT: ENDPOINT,
      CSS: CSS,
      FOLDER_OPEN_PATH: FOLDER_OPEN_PATH,
    }
    return module.exports
  },
})

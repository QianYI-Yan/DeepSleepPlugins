/**
 * dsh-plugin-link-install —— 客户端半（浏览器）。
 *
 * 往官方「添加插件」对话框里补一行：浏览本地目录 + 选 package.json + ☑ 本地安装；下面再挂一张
 * 预览卡片。
 *  - 浏览：调宿主 POST /plugin-local/pick 拉系统原生选择器（起始目录 = 上次那个），把绝对路径
 *          写回输入框（React 受控 input 用原型 value setter + input 事件，绕过它的 value tracker）；
 *  - 选 package.json：同一路由带 { kind: 'file' }，打开的是**文件**窗口；宿主会把文件路径归一到
 *          它所在的目录；
 *  - 预览卡片：输入框里有路径时（防抖 250ms）问一次 POST /plugin-local/inspect，把那个插件的
 *          包名 / 版本 / 说明 / 是否 DSH 插件 / 警告画成卡片；
 *  - 本地安装：勾选后点官方「安装」——**我们不拦那次点击**，官方照常跑它自己的流程（它自己跑
 *          pnpm、自己把 `link:<源目录>` 写进 profile、自己选中 bundle、自己提示重启）。我们只在
 *          旁边调 POST /plugin-local/finish 等官方写完，然后把副本复制进
 *          DSH_HOME/plugins/<profile>/<name>，并把那一行改写成
 *          `file:../../plugins/<profile>/<name>`。
 *
 * 不打官方补丁：纯 DOM 注入 + MutationObserver（另加 1s 轮询兜底），官方更新后依然可用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-link-install',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var ROW_ATTR = 'data-dsh-link-install'
    var STYLE_ID = 'dsh-link-install-css'
    /** 复选框（本地安装）状态 + 上次浏览过的目录。 */
    var STORE_KEY = 'dsh-link-install:mode'
    var LAST_KEY = 'dsh-link-install:last-dir'

    /**
     * 样式一律照官方设计语言写：数值取自 `@deepseek-ai/dsh-client-ui-primitives` 的
     * `Button.module.css` / `Checkbox.module.css` / `Tag.module.css` / `settings-form/fields.module.css`，
     * 颜色只用官方主题里真实存在的变量（别再写 `--dsw-alias-label-danger` 这种不存在的名字，
     * 那样只会一直落到兜底的硬编码色，和官方配色对不上）。
     */
    var CSS = [
      // 容器：官方 field 提示文字口径
      '[data-dsh-link-install]{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      // 按钮：官方 Button 的 sm + outline（28 高 / 0 10 内边距 / 0.5px 描边 / radius-sm）
      '[data-dsh-link-install] button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '[data-dsh-link-install] button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-link-install] button:active:enabled{background:var(--dsw-alias-interactive-bg-active)}',
      '[data-dsh-link-install] button:disabled{cursor:not-allowed;opacity:.4}',
      '[data-dsh-link-install] button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      // 复选框：官方 Checkbox 口径（6 间距 / 16px 见方 / 品牌色勾选）
      '[data-dsh-link-install] label{display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}',
      '[data-dsh-link-install] input[type=checkbox]{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
      '[data-dsh-link-install] input[type=checkbox]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '[data-dsh-link-install] svg{flex:none}',
      '[data-dsh-link-status]{display:inline-flex;align-items:center;gap:6px}',
      '[data-dsh-link-install] [data-dsh-link-status]{flex:1 1 100%;word-break:break-word}',
      '[data-dsh-link-status][data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
      '[data-dsh-link-status][data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
      '[data-dsh-link-status][data-tone=busy]{color:var(--dsw-alias-label-tertiary)}',
      '[data-dsh-link-status][data-tone=busy] svg{animation:dshLinkSpin 1s linear infinite}',
      '[data-dsh-link-install] [data-dsh-link-pick-file]{white-space:nowrap}',
      // 预览卡片：跟着官方 field 口径走（0.5px 描边 + radius-sm + 12px 正文）
      '[data-dsh-link-card]{display:none;flex:1 1 100%;box-sizing:border-box;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}',
      '[data-dsh-link-card][data-open="1"]{display:block}',
      '[data-dsh-link-card-head]{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:4px}',
      '[data-dsh-link-card-name]{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);word-break:break-all}',
      '[data-dsh-link-card-version]{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '[data-dsh-link-card-tag]{padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary)}',
      '[data-dsh-link-card-tag][data-kind=ok]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '[data-dsh-link-card-tag][data-kind=warn]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '[data-dsh-link-card-desc]{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin-bottom:4px;word-break:break-word}',
      '[data-dsh-link-card-path]{font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);word-break:break-all;cursor:text;user-select:text}',
      '[data-dsh-link-card-note]{margin-top:4px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warn-primary)}',
      '@keyframes dshLinkSpin{to{transform:rotate(360deg)}}',
    ].join('')

    /**
     * 图标：Lucide（ISC 许可证，https://lucide.dev），24×24 描边式，内联成 SVG。
     * 路径数据与上游 raw.githubusercontent.com/lucide-icons/lucide/main/icons/*.svg 逐字一致
     * （已用代理端口抓取比对过），不引外链、不加载字体、不依赖宿主图标模块，也不用 emoji。
     */
    var ICONS = {
      folderOpen: [['path', { d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' }]],
      link: [
        ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
        ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
      ],
      check: [
        ['circle', { cx: '12', cy: '12', r: '10' }],
        ['path', { d: 'm16 9-5.5 5.5L8 12' }],
      ],
      alert: [
        ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
        ['path', { d: 'M12 9v4' }],
        ['path', { d: 'M12 17h.01' }],
      ],
      spinner: [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
      file: [
        ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
        ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
      ],
    }

    /** 造一个内联 SVG 图标（拿不到 DOM 就返回 null，绝不因此中断注入）。 */
    function svgIcon(iconName, size) {
      var shapes = ICONS[iconName]
      if (!shapes) return null
      try {
        var ns = 'http://www.w3.org/2000/svg'
        var svg = document.createElementNS(ns, 'svg')
        svg.setAttribute('viewBox', '0 0 24 24')
        svg.setAttribute('width', String(size || 14))
        svg.setAttribute('height', String(size || 14))
        svg.setAttribute('fill', 'none')
        svg.setAttribute('stroke', 'currentColor')
        svg.setAttribute('stroke-width', '2')
        svg.setAttribute('stroke-linecap', 'round')
        svg.setAttribute('stroke-linejoin', 'round')
        svg.setAttribute('aria-hidden', 'true')
        svg.setAttribute('data-dsh-link-icon', iconName)
        for (var i = 0; i < shapes.length; i += 1) {
          var spec = shapes[i]
          var node = document.createElementNS(ns, spec[0])
          var fields = spec[1] || {}
          for (var key in fields) {
            if (Object.prototype.hasOwnProperty.call(fields, key)) node.setAttribute(key, fields[key])
          }
          svg.appendChild(node)
        }
        return svg
      } catch (error) {
        return null
      }
    }

    /** 状态行对应的图标：成功打勾、出错警示、进行中转圈、其余不带图标。 */
    function toneIcon(tone) {
      if (tone === 'ok') return svgIcon('check', 13)
      if (tone === 'error') return svgIcon('alert', 13)
      if (tone === 'busy') return svgIcon('spinner', 13)
      return null
    }

    var state = { localMode: true, busy: false, lastPicked: null, via: '', text: '', tone: '', card: null, inspected: '' }
    /** 客户端插件上下文（apply 时记下），用来取官方的 uiWorkspace 服务。 */
    var ctxRef = null

    /**
     * 复选框的悬停说明。**只在 title 里用** —— 界面上那行文字刻意写短，完整解释放到悬停时出现。
     */
    function describeToggle() {
      return state.localMode
        ? '点官方「安装」按钮时，由本插件把插件目录复制到 .dsh\\plugins\\<profile>\\<name>，再交官方安装流程注册（写入 file:../../plugins/<profile>/<name>）'
        : '点官方「安装」按钮时，完全走 DSH 默认安装（不碰任何文件）'
    }

    // ── 小工具 ─────────────────────────────────────────────────────────────
    function list(scope, selector) {
      try {
        return Array.prototype.slice.call((scope || document).querySelectorAll(selector))
      } catch (error) {
        return []
      }
    }

    function attr(el, name) {
      try {
        return el && el.getAttribute ? el.getAttribute(name) || '' : ''
      } catch (error) {
        return ''
      }
    }

    function textOf(el) {
      return ((el && el.textContent) || '').replace(/\s+/g, '')
    }

    /**
     * 严格识别「添加插件」的包名输入框。
     * 只认官方那两条文案（中文 aria-label「包名或地址」/ 英文「Package name or address」，
     * 或占位符里的 dsh-plugin-whale-pet 示例）—— 宽泛的 /name|address/ 匹配会把设置页里
     * 一堆普通输入框（例如「low 发送值」）也算进来，之前就是那样误注入到模型设置页的。
     */
    function isInstallInput(el) {
      if (!el || String(el.tagName).toUpperCase() !== 'INPUT') return false
      var type = attr(el, 'type')
      if (type !== '' && type !== 'text') return false
      var label = attr(el, 'aria-label').trim()
      var placeholder = attr(el, 'placeholder').trim()
      if (/^包名或地址/.test(label)) return true
      if (/^package name or address/i.test(label)) return true
      if (/whale-pet/i.test(placeholder)) return true
      return false
    }

    /** 找「添加插件」的输入框；strict 为真时绝不退回「第一个文本输入框」。 */
    function findInput(scope, strict) {
      var inputs = list(scope, 'input[type="text"]')
      for (var i = 0; i < inputs.length; i += 1) if (isInstallInput(inputs[i])) return inputs[i]
      if (strict === true) return null
      return inputs.length ? inputs[0] : null
    }

    /**
     * 找「添加插件」对话框：必须同时满足
     *   ① 里面有官方的包名输入框；② 里面有「安装 / Install」按钮。
     * 只满足其一的模态（设置抽屉、Agent 预设、技能页……）一律不碰。
     */
    function findDialog() {
      var dialogs = list(document, '[role="dialog"][aria-modal="true"], [role="dialog"]')
      for (var i = dialogs.length - 1; i >= 0; i -= 1) {
        if (!findInput(dialogs[i], true)) continue
        if (!findInstallButton(dialogs[i])) continue
        return dialogs[i]
      }
      return null
    }

    function findInstallButton(dialog) {
      var buttons = list(dialog, 'button')
      for (var i = 0; i < buttons.length; i += 1) {
        var text = textOf(buttons[i])
        if (text === '安装' || text === 'Install') return buttons[i]
      }
      return null
    }

    function looksLikePath(value) {
      return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
    }

    /** React 受控 input 的写法：绕过 value tracker，再派发 input 事件。 */
    function setInputValue(input, value) {
      if (!input) return false
      try {
        var proto = typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : Object.getPrototypeOf(input)
        var descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        if (descriptor && descriptor.set) descriptor.set.call(input, value)
        else input.value = value
      } catch (error) {
        try {
          input.value = value
        } catch (inner) {
          return false
        }
      }
      try {
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      } catch (error) {}
      return true
    }

    // ── 宿主通信 ───────────────────────────────────────────────────────────
    /** 读响应体：优先 text()（能把非 JSON 的错误页也带回来），退而求其次用 json()。 */
    function readBody(response) {
      var parse = function (text) {
        var payload = null
        try {
          payload = text ? JSON.parse(text) : null
        } catch (error) {
          payload = null
        }
        return { status: response.status, ok: response.ok !== false, payload: payload, raw: payload ? '' : String(text || '') }
      }
      if (typeof response.text === 'function') {
        return response.text().then(parse, function () {
          return { status: response.status, ok: false, payload: null, raw: '' }
        })
      }
      return response.json().then(parse, function () {
        return { status: response.status, ok: false, payload: null, raw: '' }
      })
    }

    function postJson(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      }).then(readBody)
    }

    /** 上次选过的目录：浏览器本地优先，其次本次会话里记下的。 */
    function lastDirectory() {
      try {
        var stored = window.localStorage && window.localStorage.getItem(LAST_KEY)
        if (stored) return stored
      } catch (error) {}
      return state.lastPicked || null
    }

    function rememberDirectory(path) {
      state.lastPicked = path
      try {
        if (window.localStorage) window.localStorage.setItem(LAST_KEY, path)
      } catch (error) {}
    }

    function setStatus(text, tone) {
      state.text = text || ''
      state.tone = tone || ''
      paint()
    }

    /** 输入框当前值（去空白）。 */
    function inputPath(input) {
      return input && input.value ? String(input.value).trim() : ''
    }

    // ── DOM 注入 ───────────────────────────────────────────────────────────
    function installStyle() {
      try {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
        var tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (error) {}
    }

    function buildRow() {
      var row = document.createElement('div')
      row.setAttribute(ROW_ATTR, '1')

      var browse = document.createElement('button')
      browse.type = 'button'
      browse.setAttribute('data-dsh-link-browse', '1')
      var browseIcon = svgIcon('folderOpen', 16)
      if (browseIcon) browse.appendChild(browseIcon)
      var browseText = document.createElement('span')
      browseText.textContent = '浏览本地目录'
      browse.appendChild(browseText)
      browse.addEventListener('click', function (event) {
        event.preventDefault()
        void browseDirectory()
      })

      // 选 package.json：同一路由，kind=file；选中后宿主会归一到它所在的目录
      var pickFile = document.createElement('button')
      pickFile.type = 'button'
      pickFile.setAttribute('data-dsh-link-pick-file', '1')
      var pickFileIcon = svgIcon('file', 16)
      if (pickFileIcon) pickFile.appendChild(pickFileIcon)
      var pickFileText = document.createElement('span')
      pickFileText.textContent = '选 package.json'
      pickFile.appendChild(pickFileText)
      pickFile.title =
        '直接选 package.json；' +
        '官方只提供目录选择器时，这个窗口选的是目录，我们会把该目录当插件目录用'
      pickFile.addEventListener('click', function (event) {
        event.preventDefault()
        void pickPackageJson()
      })

      var label = document.createElement('label')
      var check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = state.localMode
      check.setAttribute('data-dsh-link-mode', '1')
      label.title = describeToggle()
      check.addEventListener('change', function () {
        state.localMode = check.checked === true
        saveMode()
      })
      label.appendChild(check)
      var labelIcon = svgIcon('link', 13)
      if (labelIcon) label.appendChild(labelIcon)
      var span = document.createElement('span')
      span.textContent = '本地安装（复制一份副本、把依赖改写成 file: 相对形态）'
      label.appendChild(span)

      var status = document.createElement('span')
      status.setAttribute('data-dsh-link-status', '1')

      /** 预览卡片：输入框里有路径时把那个插件的 package.json 摆出来（只在有内容时 display:block）。 */
      var card = document.createElement('div')
      card.setAttribute('data-dsh-link-card', '1')

      row.appendChild(browse)
      row.appendChild(pickFile)
      row.appendChild(label)
      row.appendChild(status)
      row.appendChild(card)
      return row
    }

    function rowOf(dialog) {
      try {
        return dialog.querySelector('[' + ROW_ATTR + ']')
      } catch (error) {
        return null
      }
    }

    function paint() {
      var dialog = findDialog()
      if (!dialog) return
      var row = rowOf(dialog)
      if (!row) return
      var status = row.querySelector('[data-dsh-link-status]')
      if (status) {
        while (status.firstChild) status.firstChild.remove()
        var icon = toneIcon(state.tone)
        if (icon) status.appendChild(icon)
        if (state.text) status.appendChild(document.createTextNode(state.text))
        if (state.tone) status.setAttribute('data-tone', state.tone)
        else status.removeAttribute('data-tone')
      }
      var browse = row.querySelector('[data-dsh-link-browse]')
      if (browse) browse.disabled = state.busy === true
      var pickFile = row.querySelector('[data-dsh-link-pick-file]')
      if (pickFile) pickFile.disabled = state.busy === true
      paintCard(row.querySelector('[data-dsh-link-card]'))
    }

    /** 造一个带属性/文本的小节点（一律 textContent，不拼 HTML）。 */
    function node(tag, attrs, text) {
      var el = document.createElement(tag)
      if (attrs) {
        for (var key in attrs) {
          if (Object.prototype.hasOwnProperty.call(attrs, key)) el.setAttribute(key, attrs[key])
        }
      }
      if (text !== undefined && text !== null && text !== '') el.textContent = String(text)
      return el
    }

    /**
     * 把宿主回报的插件信息画成**预览卡片**（输入框下面那张）：包名 / 版本 / 是不是 DSH 插件 /
     * 有没有 bundle 与客户端半 / 运行时依赖条数 / 说明 / 真实目录 / 警告。
     *
     * `state.card` 为空时整张卡片收起来（`data-open` 不设）—— 没东西可预览就不留空壳占位。
     */
    function paintCard(card) {
      if (!card) return
      while (card.firstChild) card.firstChild.remove()
      var info = state.card
      if (!info) {
        card.removeAttribute('data-open')
        return
      }
      card.setAttribute('data-open', '1')

      var head = node('div', { 'data-dsh-link-card-head': '1' })
      head.appendChild(node('span', { 'data-dsh-link-card-name': '1' }, info.name))
      if (info.version) head.appendChild(node('span', { 'data-dsh-link-card-version': '1' }, 'v' + info.version))
      head.appendChild(
        node(
          'span',
          { 'data-dsh-link-card-tag': '1', 'data-kind': info.isDshPlugin ? 'ok' : 'warn' },
          info.isDshPlugin ? 'DSH 插件' : '不是 DSH 插件',
        ),
      )
      if (info.hasBundlePatch) head.appendChild(node('span', { 'data-dsh-link-card-tag': '1' }, 'bundle'))
      if (info.hasClient) head.appendChild(node('span', { 'data-dsh-link-card-tag': '1' }, '客户端半'))
      if (info.private) head.appendChild(node('span', { 'data-dsh-link-card-tag': '1' }, 'private'))
      if (info.runtimeDeps && info.runtimeDeps.length) {
        head.appendChild(node('span', { 'data-dsh-link-card-tag': '1' }, '运行时依赖 ' + info.runtimeDeps.length))
      }
      card.appendChild(head)

      if (info.description) card.appendChild(node('div', { 'data-dsh-link-card-desc': '1' }, info.description))
      if (info.dir) card.appendChild(node('div', { 'data-dsh-link-card-path': '1' }, info.dir))
      if (info.adjusted === 'nested') {
        card.appendChild(node('div', { 'data-dsh-link-card-note': '1' }, '所选目录里没有 package.json，已自动下探到上面这个目录'))
      }
      var warnings = Array.isArray(info.warnings) ? info.warnings : []
      for (var i = 0; i < warnings.length; i += 1) {
        card.appendChild(node('div', { 'data-dsh-link-card-note': '1' }, warnings[i]))
      }
    }

    /**
     * 输入框里那条路径变了就（防抖 250ms）问一次宿主，把插件信息画出来。
     * 值没变就不再发请求；路径清空 / 不是路径 → 把卡片收起来。
     */
    var inspectTimer = null
    function scheduleInspect(value) {
      if (value === state.inspected) return
      state.inspected = value
      if (inspectTimer) {
        clearTimeout(inspectTimer)
        inspectTimer = null
      }
      if (!value || !looksLikePath(value)) {
        state.card = null
        paint()
        return
      }
      inspectTimer = setTimeout(function () {
        inspectTimer = null
        void inspectPath(value)
      }, 250)
    }

    function inspectPath(target) {
      return postJson('/plugin-local/inspect', { source: target })
        .then(function (result) {
          // 期间用户又改了输入框 → 这次结果作废，别把旧目录的卡片画上去
          if (state.inspected !== target) return
          var payload = result.payload || {}
          state.card = payload.ok === true
            ? payload
            : {
                name: '不是插件目录',
                version: '',
                isDshPlugin: false,
                description: '',
                dir: target,
                warnings: [String(payload.message || '读不到这个目录的 package.json')],
              }
          paint()
        })
        .catch(function () {})
    }

    /** 把这一行挂到对话框里（插在输入框那一格之后）。 */
    function decorate(dialog) {
      var input = findInput(dialog, true)
      if (!input) return false
      if (rowOf(dialog)) return true
      var field = input.parentElement || input.parentNode || dialog
      var row = buildRow()
      try {
        if (field && field.parentNode && field.parentNode.insertBefore) {
          field.parentNode.insertBefore(row, field.nextSibling || null)
        } else if (field && field.appendChild) {
          field.appendChild(row)
        } else {
          dialog.appendChild(row)
        }
      } catch (error) {
        return false
      }
      var install = findInstallButton(dialog)
      if (install && !dialog.__dshLinkInstallBound) {
        dialog.__dshLinkInstallBound = true
        dialog.addEventListener(
          'click',
          function (event) {
            if (state.localMode !== true) return
            var target = event.target
            // 官方按钮可能被 React 重建，所以每次点击都重新找，并按文本兜底
            var button = findInstallButton(dialog)
            var isInstallClick =
              button !== null && (target === button || (button.contains && button.contains(target)))
            if (!isInstallClick && target && String(target.tagName).toUpperCase() === 'BUTTON') {
              var text = textOf(target)
              isInstallClick = text === '安装' || text === 'Install'
            }
            if (!isInstallClick) return
            var current = findInput(findDialog() || dialog, true)
            var value = current && current.value ? String(current.value).trim() : ''
            if (!looksLikePath(value)) return
            /**
             * **不拦这次点击** —— 官方要自己把它的流程跑完：官方的 pnpm、官方把
             * `link:<源目录>` 写进 profile、官方选中 bundle、官方提示重启，界面上的进度也是官方的。
             * 我们只登记一句「盯住这个源目录」：等官方写完之后，宿主半再把副本复制进插件仓库、
             * 把那一行改写成 `file:../../plugins/<profile>/<name>`。
             *
             * （拦下来自己调 installBundle 会让官方界面一动不动 —— 那是被否掉的那一版。）
             */
            void armWarehouse(value)
          },
          true,
        )
      }
      paint()
      return true
    }

    // ── 动作 ───────────────────────────────────────────────────────────────
    function currentInput() {
      var dialog = findDialog()
      return dialog ? findInput(dialog, true) : null
    }

    /** 清掉挂在别处（非「添加插件」对话框）的残留行，避免旧误注入一直留在页面上。 */
    function sweep(dialog) {
      var rows = list(document, '[' + ROW_ATTR + ']')
      for (var i = 0; i < rows.length; i += 1) {
        if (dialog && dialog.contains(rows[i])) continue
        try {
          rows[i].remove()
        } catch (error) {}
      }
    }

    /** 把一次请求的失败讲清楚：HTTP 状态 + 宿主给的 message（没有就把响应文本截断带上）。 */
    function failureText(prefix, result) {
      var payload = result && result.payload
      var detail = payload && payload.message ? payload.message : result && result.raw ? String(result.raw).slice(0, 200) : ''
      if (!detail) detail = 'HTTP ' + (result ? result.status : '?')
      return prefix + detail
    }

    /**
     * 走宿主路由 `/plugin-local/pick`。
     *
     * 宿主侧顺序：**先用 Electron 原生对话框**（只有它吃得下 `defaultPath`，也就是「停在上次
     * 那个目录」），不行才落官方 `directoryPicker`（它没有 SetFolder，永远只开在自己的 MRU）。
     * 整条路都不可用时（unavailable）退回「选 package.json」。
     */
    function pickViaRoute(initial) {
      return postJson('/plugin-local/pick', { initial: initial }).then(function (result) {
        state.busy = false
        var payload = result.payload || {}
        if (!payload.ok) {
          if (payload.unavailable) {
            state.busy = false
            setStatus('目录选择器不可用，改为选插件的 package.json…', 'busy')
            return pickPackageJson({ force: true })
          }
          setStatus(failureText('浏览失败：', result), 'error')
          return
        }
        var took = payload.elapsedMs
          ? '（' + (payload.elapsedMs / 1000).toFixed(1) + 's' + (payload.shell ? ' · ' + payload.shell : '') + '）'
          : ''
        if (!payload.path) {
          setStatus('已取消选择' + took + memoryNote(payload), '')
          return
        }
        applyPickedPath(payload.dir || payload.path, (payload.via || '选择器') + took + seededNote(payload))
      })
    }

    /**

    /**
     * 官方选择器**结构上不支持起始目录**（宿主只传 DSH_DIALOG_TITLE，COM 调用里没有
     * IFileDialog::SetFolder），所以它打开的位置由系统自己的"上次位置"决定。
     * 记忆存在时如实告诉用户，方便直接粘回输入框。
     */
    function memoryNote(payload) {
      var via = (payload && payload.via) || ''
      if (via.indexOf('官方') === -1) return ''
      var memory = lastDirectory()
      return memory ? '；记忆目录：' + memory + '（官方选择器无法指定起始目录，可粘贴回输入框）' : ''
    }

    /** 选择器确实是从「上次那个目录」起跳时说一句 —— 这是用户最在意的一件事。 */
    function seededNote(payload) {
      return payload && payload.seeded ? '，已从上次那个目录开始' : ''
    }

    /**
     * 选中之后的统一收尾：**只记住目录 + 写回输入框**，不自动安装。
     * 是否走「本地安装」，由用户点官方「安装」那一刻决定（见 armWarehouse）。
     */
    function applyPickedPath(path, note) {
      rememberDirectory(path)
      setInputValue(currentInput(), path)
      setStatus('已填入路径' + (note ? '（' + note + '）' : ''), 'ok')
    }

    function browseDirectory() {
      var input = currentInput()
      var typed = input && input.value ? String(input.value).trim() : ''
      var preferred = typed && looksLikePath(typed) ? typed : lastDirectory() || undefined
      state.busy = true
      setStatus('已打开文件夹选择器…', 'busy')
      /**
       * 一律走宿主路由：起始目录（记忆 / 输入框里的路径）只有宿主侧能真正送进对话框
       * （Electron 的 `defaultPath`）；Electron 不可用时宿主会自己落到官方选择器。
       */
      pickViaRoute(preferred).catch(function (error) {
        state.busy = false
        setStatus('浏览失败：' + String(error), 'error')
      })
    }

    /**
     * 选 package.json：官方只提供目录选择器，所以这里直接走自建路由，带 kind=file。
     * 选完复用 applyPickedPath（记住目录 + 写回输入框，不自动安装），
     * 再顺手识别一次，让卡片立刻出来。
     * @param options.force 目录选择路线失败后的自动重试会带它，绕过 busy 守卫
     * @returns Promise（调用方可以等它）
     */
    function pickPackageJson(options) {
      var force = options && options.force === true
      if (state.busy === true && !force) return Promise.resolve()
      var input = currentInput()
      var typed = inputPath(input)
      var initial = typed && looksLikePath(typed) ? typed : lastDirectory() || undefined
      state.busy = true
      setStatus('已打开选择器（可选中 package.json，也可直接选插件目录）…', 'busy')
      return postJson('/plugin-local/pick', { initial: initial, kind: 'file' })
        .then(function (result) {
          state.busy = false
          var payload = result.payload || {}
          if (!payload.ok) {
            setStatus(failureText('选择 package.json 失败：', result), 'error')
            return
          }
          var took = payload.elapsedMs
            ? '（' + (payload.elapsedMs / 1000).toFixed(1) + 's' + (payload.shell ? ' · ' + payload.shell : '') + '）'
            : ''
          if (!payload.path) {
            setStatus('已取消选择' + took + memoryNote(payload), '')
            return
          }
          // 回填与记忆统一用**目录**（选中 package.json 时宿主会把 dir 一起给回来）
          var dir = payload.dir || payload.path
          var derived = payload.pickedFile ? '，已由 package.json 反推目录' : ''
          applyPickedPath(dir, (payload.via || '选择器') + took + derived + seededNote(payload))
        })
        .catch(function (error) {
          state.busy = false
          setStatus('选择 package.json 失败：' + String(error), 'error')
        })
    }

    /**
     * 勾选「本地安装」后点官方「安装」时走这里 —— **不拦官方**，只登记收尾。
     *
     * 官方那条流程照常跑（它自己跑 pnpm、自己把 `link:<源目录>` 写进 profile、自己选中 bundle、
     * 自己提示重启，界面上的进度也是官方的）。宿主侧做的只有两件后置的事，而且只在**确实看到
     * 官方写了那一行之后**才动手：把源目录复制一份到 `DSH_HOME\plugins\<profile>\<name>`，
     * 再把 profile 里那一行改写成 `file:../../plugins/<profile>/<name>`。
     *
     * 所以这里的等待通常比一次安装久（要等官方跑完 pnpm）—— 状态行如实说明在等什么。
     */
    function armWarehouse(source) {
      if (state.busy === true) return
      state.busy = true
      setStatus('已介入：等官方那次安装把依赖写进 profile，然后复制副本并改写形态…', 'busy')
      postJson('/plugin-local/finish', { source: source })
        .then(function (result) {
          state.busy = false
          var payload = result.payload || {}
          if (payload.ok !== true) {
            // 官方那次没写成（它自己的界面会告诉用户为什么），这里只如实说没等到
            setStatus(failureText('收尾未完成：', result), 'error')
            return
          }
          var warn = payload.warnings && payload.warnings.length ? '；注意：' + payload.warnings.join('；') : ''
          var what =
            '已复制 ' + (payload.copiedFiles || 0) + ' 个文件到 ' + payload.target +
            '，依赖已改写为 ' + payload.dependency + warn
          setStatus(what + '；官方安装的后续（选中 bundle、提示重启）已由官方完成', payload.warnings && payload.warnings.length ? 'error' : 'ok')
        })
        .catch(function (error) {
          state.busy = false
          setStatus('收尾未完成：' + String(error), 'error')
        })
    }

    // ── 复选框状态持久化（只有一个开关，所以只存它） ───────────────────────
    function loadMode() {
      try {
        var stored = window.localStorage && window.localStorage.getItem(STORE_KEY)
        if (stored === '0') state.localMode = false
        else if (stored === '1') state.localMode = true
      } catch (error) {}
    }

    function saveMode() {
      try {
        if (!window.localStorage) return
        window.localStorage.setItem(STORE_KEY, state.localMode ? '1' : '0')
      } catch (error) {}
    }

    // ── 启动 ───────────────────────────────────────────────────────────────
    /** 一轮巡检：找到「添加插件」对话框就挂行，并把挂在别处的残留行清掉。 */
    function tick() {
      var dialog = findDialog()
      sweep(dialog)
      if (dialog) {
        decorate(dialog)
        // 输入框里那条路径变了就（防抖）刷一次预览卡片
        var input = findInput(dialog, true)
        scheduleInspect(input && input.value ? String(input.value).trim() : '')
      }
    }

    function apply(ctx) {
      ctxRef = ctx
      installStyle()
      loadMode()
      try {
        var observer = new MutationObserver(function () {
          tick()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch (error) {}
      try {
        setInterval(function () {
          tick()
        }, 1000)
      } catch (error) {}
      try {
        tick()
      } catch (error) {}
    }

    exports.name = 'dsh-plugin-link-install'
    exports.inject = []
    exports.apply = apply
    /** 供离线冒烟测试使用。 */
    exports.__test = {
      state: state,
      describeToggle: describeToggle,
      lastDirectory: lastDirectory,
      rememberDirectory: rememberDirectory,
      memoryNote: memoryNote,
      applyPickedPath: applyPickedPath,
      setCtx: function (ctx) {
        ctxRef = ctx
      },
      findDialog: findDialog,
      findInput: findInput,
      findInstallButton: findInstallButton,
      setInputValue: setInputValue,
      decorate: decorate,
      buildRow: buildRow,
      sweep: sweep,
      tick: tick,
      svgIcon: svgIcon,
      toneIcon: toneIcon,
      ICONS: ICONS,
      looksLikePath: looksLikePath,
      isInstallInput: isInstallInput,
      ROW_ATTR: ROW_ATTR,
      CSS: CSS,
      inputPath: inputPath,
      pickPackageJson: pickPackageJson,
      paint: paint,
      paintCard: paintCard,
      scheduleInspect: scheduleInspect,
      armWarehouse: armWarehouse,
    }
    return module.exports
  },
})

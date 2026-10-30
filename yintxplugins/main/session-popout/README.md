# 会话拖出小窗（yintxplugins/session-popout）

把**当前会话拖出来**开成一个浮在界面上的小窗：按住视口右上角那枚小胶囊拖出 60px 松手就行，
也可以点它一下，或者按 `Alt+Shift+P`。小窗里是**同一份 GUI 的精简版**（默认只留会话列），
可以拖动、八向缩放、点 `✕` 关掉。

- 行 id：`yintx-session-popout` ｜ 插件列表显示为 `yintxplugins/session-popout`
- 子插件包名（客户端注册 id）：`dsh-plugin-session-popout`
- 目录：`main/session-popout/`（`index.js` 宿主半 + `client.js` 客户端半 + `test/`）

## 开窗方式（`mode`）—— 桌面端为什么默认内嵌

| mode | 行为 | 什么时候用 |
|---|---|---|
| `inline`（默认） | 在主界面里开一个**内嵌小窗**（`iframe` 加载同一地址），可拖可缩可关 | **DSH 桌面端**：宿主是 **Tauri + WebView2**，没有开新窗口的处理器，`window.open` 会**静默什么都不做**（不报错、也没句柄），实测就是"拖了没反应" |
| `window` | 用 `window.open(..., 'popup=yes,...')` 开真·独立窗口（固定窗口名 → 重复触发只聚焦） | 浏览器里的 DSH Web GUI |
| `auto` | 先试 `window.open`，明确被拒（返回 `null`）再退回内嵌 | 不确定自己的宿主是什么 |

配置落点：客户端 `localStorage` 的 `yintx.session-popout.config.v1`（**本地优先**），
宿主半 `<DSH_HOME>/yintxplugins/session-popout/config.json` 兜底。在浏览器里想切成真窗口，
可以在 DSH 的 Web GUI 控制台里写：

```js
localStorage.setItem('yintx.session-popout.config.v1', JSON.stringify({ mode: 'window' }))
location.reload()
```

> 桌面端也可以改成 `mode: 'auto'`：内嵌小窗标题栏上的 `⇱`（弹出为独立窗口）就是这条路径的手动入口，
> 被宿主拒绝时会弹一条可见提示，而不是默默不动。

## 两个方向的能力

| 位置 | 行为 |
|---|---|
| 主窗口 | 右上角一枚小胶囊（默认 42% 不透明度，悬停才明显）。**拖出 ≥60px** 时亮起「松手 → 开成小窗」提示，松手即开；**点一下**也开；`Alt+Shift+P` 同效。开窗方式回退时弹一条小 toast（不再只写 console） |
| 内嵌小窗 | 标题栏（可拖）+ `iframe` + 八向缩放手柄 + 三个按钮：`⟳` 重新加载、`⇱` 弹出为独立窗口、`✕` 关闭。几何记在 `localStorage` 的 `yintx.session-popout.inline.v1` |
| 内嵌小窗标题栏 | 带 `✎`：点一下标题变成输入框（预填当前会话标题），`Enter` 提交、`Esc` 取消、再点 `✎` 也提交。提交走官方 `sessions.rename(sessionId, title)`（当前会话由 `retainedBy.mainView > 0` 判定），成功后标题栏立即更新，失败弹 toast 且标题不动 |
| 内嵌小窗里的页面 | 检测到自己在 iframe 里，浮条换成「**弹出为独立窗口** / **关闭小窗**」，并通过 `postMessage` 请父窗口执行（iframe 里 `window.close()` 无效、也没有 `opener`） |

- 拖拽跟踪只在**按住胶囊**时进行，不影响会话里的选择、滚动与消息交互。
- 拖拽已经开过窗时，紧随其后的 `click` 会被吞掉（不会开两次）。
- 内嵌小窗重复触发只会把 URL 重设一次并前置，不会叠出第二个。
- 关闭内嵌小窗会把 `iframe` 的 `src` 置成 `about:blank`，**断开那条连接**，不留后台页面。

## 为什么小窗里是「同一地址」而不是自绘一份会话

1. **认证 token 在 URL 里**：DSH 的客户端连接用查询参数携带 launch token
   （`dsh-client-connection` 的 `authenticatedUrl()` 就是 `searchParams.set(TOKEN_QUERY, launchToken)`）。
   复制当前地址 = 复制同一份 token，新窗口 / 内嵌 iframe 里直接可用，不需要任何额外握手。
2. **官方客户端是单页应用，没有会话路由**：没有 `?session=<id>` 这类深链可用；自绘一份会话又要重做
   消息渲染、输入、附件、审批……收益极低、风险极高。
3. 代价（如实说明）：小窗是**第二条页面连接**，各自持有自己的客户端状态（与"开第二个标签页"完全一样）；
   官方若某天支持会话深链，本插件只需改 `buildPopoutUrl`。

## 宿主半（`index.js`）

| 路由 | 说明 |
|---|---|
| `GET /plugin-session-popout/ping` | 探活：版本、`DSH_HOME`、配置路径、是否有存档、默认值 |
| `GET /plugin-session-popout/config` | 读配置（与默认值合并；无存档时 `from: 'default'`） |
| `POST /plugin-session-popout/config` | 写配置（字段校验夹紧 + 与旧值合并 + 原子替换） |

配置字段：`width`（320–3840）、`height`（240–2160）、`slim`（是否精简界面）、
`reuse`（是否复用已有小窗）、`mode`（`inline` / `window` / `auto`，非法值直接 400）。
存档落点：`<DSH_HOME>/yintxplugins/session-popout/config.json`。

## 与壁纸引擎类插件共存

主窗口侧与 todo-float 用同一套浮层纪律（来源是该插件源码里写死的同族硬要求）：

- 浮层挂在 `document.body`、z-index 取正数（胶囊层 2147482100、内嵌小窗层 2147482200），不碰 `-2`/`-1` 的壁纸层；
- 整屏浮层 `pointer-events: none` + `-webkit-app-region: initial !important`；
- 颜色一律读 `--dsw-alias-*`（`bg-layer-2` / `border-l2` / `label-*` / `interactive-bg-hover-solid`），
  自动继承壁纸引擎改写过的玻璃配方；不读 `--dsw-alias-bg-base`（壁纸激活时是 `transparent`）。

内嵌小窗是 iframe，壁纸引擎插件会在里面照常生效（背景壁纸依旧）。

## 自测

```powershell
node main/session-popout/test/smoke.mjs          # 宿主半：12 项（配置校验/落点/路由/信任闸/降级）
node main/session-popout/test/smoke-client.mjs   # 客户端半：25 项（URL/判定/几何/三个视图/apply 三条路径）
```

重点断言：

- **小窗 URL 必须原样保留 token** —— 漏了它新窗口 / iframe 就打不开；
- **`mode` 三条路径**：`inline` 直接内嵌、`window` 先弹窗且被拒时回退内嵌并弹 toast、`auto` 先弹窗；
- **内嵌小窗的开关与几何**：`show` 才进 DOM、重复 `show` 不叠加、`hide` 清空 `src`、拖动 / 缩放按位移生效、
  点在标题栏按钮上不触发拖动；
- **跨窗口消息**：iframe 里点「关闭小窗」→ 父窗口收起；点「弹出为独立窗口」→ 走 `window.open`。

真实浏览器 e2e（含内嵌小窗全流程：开窗、拖动、缩放、iframe 内关闭回传）在仓库外：
`D:\Code\DeepSeek\.e2e-yintx\` → `node run.mjs`（本机 Edge + puppeteer-core，产出 `shots/*.png`）。

## 已知限制

- **桌面端无法开真正的独立窗口**：Tauri 宿主没暴露开窗能力，`window.open` 静默失效。
  内嵌小窗是等价替代（浮在界面上、可拖可缩），但不是操作系统级独立窗口；"永远置顶"要等宿主提供窗口 API。
- 内嵌小窗里的页面是**第二份 GUI 实例**（第二条连接），内存占用与开一个标签页相当。
- 精简样式靠类名匹配（`[class*="leftSidebar"]` 等）。官方改了类名只会"没精简"，不会造成损坏。
- 内嵌小窗的标题取自 `document.title`（官方会把当前会话标题写进去）；标题为空时显示「会话小窗」。

# 会话待办悬浮窗（yintxplugins/todo-float）

一个**客户端悬浮窗**，实时显示**当前会话**的待办清单：Windows 窗口式的标题栏 + 三个控制按钮，
可拖动、可八向缩放、可最大化/收起，位置与尺寸持久化。它不碰官方文件，也不改任何既有 DOM 结构，
只是往 `document.body` 追加一层自己的浮层。

- 行 id：`yintx-todo-float` ｜ 插件列表显示为 `yintxplugins/todo-float`
- 子插件包名（客户端注册 id）：`dsh-plugin-todo-float`
- 目录：`main/todo-float/`（`index.js` 宿主半 + `client.js` 客户端半 + `test/`）

## 数据从哪来

**不经过宿主半**：客户端直接订阅官方会话投影里的 `todos`。

```
ctx.get('sessions')
  → 当前会话：Object.values(sessions.list.getSnapshot().byId)
                 .find(s => (s.retainedBy.mainView ?? 0) > 0)
  → sessions.binding(id).session.projections.faceOf('todos')   // 快照 store：getSnapshot / subscribe
  → TodoItem[] | null                                          // { content, status: 'pending'|'in_progress'|'completed' }
```

这与官方自己对 todo 的做法同源（`dsh-client-ui-conversation` 的 TodoDock 就是 `useProjection('todos')`），
但那属于版本内的实现细节，所以客户端半**全程特性探测**：

| 情况 | 行为 |
|---|---|
| `sessions` 服务还没注册 | 每 400ms 重试，最多 20s（loader 服务按顺序注册） |
| 没有当前会话 | 显示「等待会话打开…」，绿点变黄 |
| 投影取不到 / 换了形状 | 退化为每 2s 轮询一次快照；仍拿不到就显示「未接入会话数据源」 |
| 任何一步抛错 | 只记一条 console 警告，绝不让页面报错 |

**同时订阅当前会话的目标（`goal` 投影）**，在清单上方显示一行「目标 · 阶段 · 轮次」：

```
sessions.binding(id).session.projections.faceOf('goal')
  → GoalProjection | null
    { goal: { objective, phase: 'active'|'paused'|'blocked'|'complete',
              maxGoalRounds, blockedReason?: { code, message } },
      roundsStarted }
```

| 阶段 | 悬浮窗里显示 |
|---|---|
| `active` | 「目标 · 进行中 · 3/8 轮」 |
| `paused` | 「目标 · 已暂停 · 3/8 轮」 |
| `blocked` | 「目标 · 受阻」，并带出 `blockedReason.message` |
| `complete` | 「目标 · 已完成」 |

没有目标时这一行整体隐藏（`data-empty="true"`），不占高度、不影响清单；目标变化同样走投影订阅，实时刷新。

## 窗口能力

| 交互 | 行为 |
|---|---|
| 拖动标题栏 | 移动窗口；标题栏**始终留在视口内**（横向至少留 96px，纵向留标题栏高度） |
| 八向缩放 | 四边 + 四角手柄；左侧/上侧拖动时原点同步移动；不小于 220×120 |
| 双击标题栏 | 最大化 / 还原（最大化 = 铺满视口并留 24px 边距） |
| `─` 最小化 | 收成只剩标题条（不销毁内容） |
| `✕` 关闭 | 隐藏窗口，并在右下角留一枚「◐ 待办」胶囊；点胶囊唤回 |
| 视口变化 | 自动把窗口拉回可见范围；最大化态跟随视口 |

几何持久化：**localStorage 优先**（`yintx.todo-float.geom.v1`），宿主半的
`GET/POST /plugin-todo-float/geom` 作为兜底（换个浏览器/清缓存后仍能回到原位）。
拖动/缩放在松手时写一次，另有 600ms 去抖同步到宿主半。

## 宿主半（`index.js`）

浏览器做不到、或做不长的两件事：

| 路由 | 说明 |
|---|---|
| `GET /plugin-todo-float/ping` | 探活：版本、`DSH_HOME`、几何存档路径、是否有存档 |
| `GET /plugin-todo-float/geom` | 读几何（无存档时 `geom: null`） |
| `POST /plugin-todo-float/geom` | 写几何：字段先校验夹紧，再**临时文件 + rename 原子替换** |

存档落点：`<DSH_HOME>/yintxplugins/todo-float/geom.json`。
两条路由都过官方连接信任闸（拿不到信任服务 → `503`），与合集其它子插件同一道。
**同一条路径只注册一个 handler**（按 method 分派）——官方 webServer 按精确路径注册，重复会互相覆盖。

## 与壁纸引擎类插件共存

按 `dsh-plugin-wallpaper-engine`（v1.3.1）源码里写死的同族硬要求做的：

1. **挂 `document.body`，z-index 取正数高值**（本插件 2147482000）。壁纸/暗化/光效三层占着 `-2`/`-1`，
   且那个插件会重新 append 壁纸层、每帧核对负 z 层的文档序 —— 第三方在负 z 区间排上下必输。
2. **整屏浮层必须 `pointer-events: none` + `-webkit-app-region: initial !important`**：
   前者让鼠标穿透（只有窗口本体吃事件），后者是桌面壳"body 下非 #root 直接子元素一律 no-drag、
   Electron 会把这块矩形从窗口拖拽区几何挖除"的对应要求（必须是 `initial`，写 `none` 等于没修）。
3. **底色读 `--dsw-alias-bg-layer-2`、边框读 `--dsw-alias-border-l2`、文字读 `--dsw-alias-label-*`**，
   这样会自动继承那份玻璃配方与「可读性下限」；**不读 `--dsw-alias-bg-base`**（壁纸激活时它被置成 `transparent`）。
4. 不给 `html`/`body`/自己的整屏容器写不透明背景或常驻 `filter`，避免盖住宿主的负 z 壁纸层与白闪。
5. 不给整屏层设 `contain: paint`（会裁掉毛玻璃的采样范围）。
6. 字体走 `var(--dsw-font-family, …)` 继承，不硬写字体与光标。

## 自测

```powershell
node main/todo-float/test/smoke.mjs          # 宿主半：13 项（校验/落盘/路由/信任闸/降级）
node main/todo-float/test/smoke-client.mjs   # 客户端半：25 项（几何数学/投影/视图/数据源/apply 全链路）
```

客户端半的测试自带一个**极简 DOM stub**（`createElement/appendChild/setAttribute/派发事件`），
所以整个视图树、拖拽与缩放数学、关闭→胶囊→唤回都能在 node 里跑，不需要浏览器、不装任何包。

真实浏览器里的端到端验证（渲染、拖动、缩放、最大化、实时刷新、开小窗）在仓库外的
`D:\Code\DeepSeek\.e2e-yintx\`：`node run.mjs`（用本机 Edge + puppeteer-core，产出 `shots/*.png`）。

### 小窗里不挂载

`session-popout` 开出来的小窗（无论独立窗口还是桌面端的**内嵌 iframe**）会带上 `yintx_popout=1`；
本插件检测到这个标记就**跳过挂载** —— 那块地方本来就小，再叠一层待办浮窗只会挡住会话本身。

## 已知限制

- 悬浮窗的「当前会话」判据是 `retainedBy.mainView > 0`，与官方 UI 一致；同时开着多个面板时以官方的归属为准。
- 投影里只有待办本身（没有「谁在什么时候改的」），所以窗口只展示 `content` 与 `status`。
- 小窗/悬浮窗都不改官方 DOM：官方若要换类名或换投影形状，本插件只会退化成等待态，不会崩。

# yintxplugins 合集

把五个本地子插件打成一个**聚合插件**：装上这一包，就有「本地插件安装」「插件详情页·打开目录」「预设目录桥接」「会话待办悬浮窗」「会话拖出小窗」五件事；
每个子插件在插件列表里是**独立一行**，可以单独开关（关掉后它的客户端半也会同步卸下，见下文「客户端半与子行开关」）；某一行的实现 import 或启动失败，**只记一条降级，不会拖垮整组、不会让 `dsh web` 起不来**。

做法学自 `@linxin666/dsh-web-all`（同一套「聚合包 + 每行一个子路径外壳」的结构）。

## 包含哪五个子插件

| 行 id | 插件列表里显示为 | 实现（包内） | 做什么 |
|---|---|---|---|
| `yintx-open-folder` | `yintxplugins/open-folder` | `main/plugin-open-folder/` | 在官方**插件详情页页头**（卸载按钮那一排）加「打开目录」按钮：点击用系统文件管理器打开该插件在磁盘上的真实目录，自动还原 `link:` / `file:` / `node_modules` 三种安装来源。 |
| `yintx-preset-bridge` | `yintxplugins/preset-bridge` | `main/preset-bridge/` | 扫描 `DSH_HOME/.agent-presets/` 下的 `preset.yml` / `agent.cordis.yml`，注册成预设声明并**热同步**；提供预设卡片「打开目录」按钮的后端路由，并由客户端半（纯 DOM 注入，不动官方文件）把官方 0.2.0 删掉的那个按钮加回卡片。 |
| `yintx-link-install` | `yintxplugins/link-install` | `main/plugin-link-install/` | 给官方**「添加插件」对话框**补上「浏览本地目录 / 选 package.json」；勾选后先把目录整份复制到 `DSH_HOME/plugins/<profile>/<name>`，再把路径交回官方 `installBundle`（依赖由官方写、pnpm 由官方跑）。 |
| `yintx-todo-float` | `yintxplugins/todo-float` | `main/todo-float/` | **客户端悬浮窗**实时显示当前会话的待办（官方会话投影 `todos`）与**当前活跃目标**（`goal` 投影：目标 · 阶段 · 轮次）：Windows 窗口式标题栏与三按钮，可拖动、可八向缩放、可最大化/收起、双击标题栏最大化；几何本地优先、宿主半兜底持久化。 |
| `yintx-session-popout` | `yintxplugins/session-popout` | `main/session-popout/` | **把会话拖出来开成小窗**：按住视口右上角胶囊拖出 60px 松手（或点它 / `Alt+Shift+P`）；小窗是同一地址的一页（带同一份 token），默认精简掉侧栏只留会话列。**桌面端（Tauri/WebView2）`window.open` 静默失效，所以默认开的是界面内可拖可缩的内嵌小窗**；浏览器里可切 `mode: window` 开真独立窗口。小窗标题栏带 `✎`，可就地重命名当前会话（官方 `sessions.rename`）。 |

合集自己（行 id `yintx-self`，显示为 `yintxplugins`）不做业务：它是这五个子插件的**宿主与账本**，另外提供三条只读状态路由与一条子插件客户端取件路由。

## 为什么要有合集

1. **容错**：DSH 的 loader 把一个 bundle 的所有 patch 行当成一个事务组——任何一行 import/启动失败，整组回滚、`dsh web` 起不来。所以每行挂的不是实现本体，而是「永不失败」的外壳（`lib/shell.js`）：它按行里的 `config.fallback`（**相对包根**的包内路径，如 `./main/plugin-open-folder/index.js`）动态 import 真实实现，失败就记降级、安静退出。
2. **可单独开关**：外壳把 `name` 里的子路径显示成独立一行，于是在「设置 → 插件」里可以逐个子插件禁用；客户端半会跟着开关联动（见下一节）。
3. **不撞 id**：行 id 统一带 `yintx-` 命名空间。独立安装 `dsh-plugin-open-folder` 时它的行 id 就是包名；走合集则是 `yintx-open-folder`——两种装法不会互相覆盖行。
4. **自包含，不依赖外部包**：五个子插件的代码都在本包 `main/` 里，行里只写包内相对路径（`config.fallback`，相对包根），所以**不需要**按包名解析、也不需要把 `dsh-plugin-open-folder` 之类的包装进 profile——装上合集就是全部。

## 客户端半与子行开关

客户端半（浏览器里注入 UI 的那一半）不是 loader 单独挂载的——它由合集自己的父客户端半统一 `ctx.plugin()` 挂上，所以**子行开关不会自动生效**，父半必须自己去问宿主「这一行现在算数吗」。

做法：父半每次挂载前先取一次 `/yintx/status`，只挂 `rows[].mounted === true` 的子插件（`mounted` 来自宿主账本：被用户在设置里停用的行，loader 根本不会 apply，也就不进账本）；之后每 3 秒轮询一次（页面不可见时暂停），发现某行 `mounted` 变 `false` 就把对应的客户端 fiber 卸掉——于是关掉子行，悬浮窗 / 胶囊 / 按钮会跟着消失；重新打开，它自己回来。

> 一个容易翻车的点：`mounted` 依赖外壳把行 id 记进账本。外壳从 `row.id` 取 id，而 `cordis.patch.yml` 里每行的 `config` 必须显式写 `id: <命名空间>-<子路径>`——漏了它外壳会退化成 `(no-row)`，账本与目录对不上，`/yintx/status` 就会把所有子行判成「已禁用」，客户端半全不挂载（界面看起来像「功能全没了」）。所以生成器给每行写 `config.id`，根测试里另有两条断言（生成物必带 id + 真实 `apply` 后账本记对 id）专门锁死这个回归。

拿不到状态（旧宿主 / 路由暂时不可达），或宿主半自报账本不可信（`ledgerReliable: false`，例如账本里出现对不回目录的键）时，退化成「全部挂载」，不会因为一个状态接口让整组客户端半失效。

## 目录结构

```
yintxplugins/
├─ aggregate.json          # 唯一事实来源：合集信息 + 五行子插件（中文标题/说明）
├─ scripts/aggregate.mjs   # 生成器（零依赖）：清单 → cordis.patch.yml + lib/rows.json
├─ cordis.patch.yml        # 【生成物】loader 应用的补丁层
├─ main/                   # 【五个子插件的真实代码：一个功能一个文件夹】
│  ├─ plugin-open-folder/  #   打开插件目录（index.js + client.js + test/）
│  ├─ preset-bridge/       #   预设目录桥接（index.js + client.js + scripts/）
│  ├─ plugin-link-install/ #   本地插件安装（index.js + client.js + locale/）
│  ├─ todo-float/          #   会话待办悬浮窗（index.js + client.js + locale/ + test/）
│  └─ session-popout/      #   会话拖出小窗（index.js + client.js + locale/ + test/）
├─ lib/                    # 【合集自己的骨架】
│  ├─ rows.json            # 【生成物】机器可读的行目录（父半与测试用）
│  ├─ index.js             # 父 host 半：账本 + /yintx/status + 健康路由
│  ├─ client.js            # 父客户端半：**经典脚本 bundle**（门面 + 送出/挂载子插件客户端半）
│  ├─ shell.js             # 通用子插件外壳（一份代码服务每一行）
│  ├─ shells/shell.js      # 子路径薄壳：每个子行的 `name` 都指向它
│  └─ shared/
│     ├─ state.js          # 行账本 + 降级记录
│     ├─ trust.js          # 连接信任闸（父半与健康路由共用一份）
│     ├─ respond.js        # JSON / 405 响应助手
│     └─ open-dir.js       # 「用文件管理器打开目录」的唯一实现（open-folder 与 preset-bridge 共用）
├─ test/smoke.mjs          # 合集自测：清单/生成物/外壳/路由/客户端目录一致性
├─ test/fixtures/boom.js    # 【测试夹具】故意在 apply 里抛错，验证「启动失败只记降级」
└─ .github/todolist        # 待办与决策快照（防丢）
```

## 安装与卸载

```powershell
# 装（把 <本目录> 换成 yintxplugins 的绝对路径；profile 按需换成 desktop）
dsh plugin --profile desktop add "link:<本目录>"

# 卸
dsh plugin --profile desktop remove yintxplugins
```

也可以在 profile 的 `package.json` 里写 `"yintxplugins": "file:../../plugins/desktop/yintxplugins"` 之类的本地路径依赖。

> ℹ️ 合集**自包含**：五个子插件的代码都在本包 `main/` 里，`package.json` 不再声明任何 `file:` 依赖。
> 安装合集**不会**连带安装 `dsh-plugin-open-folder` / `dsh-preset-bridge` / `dsh-plugin-link-install` 这三个包；
> 如果你以前单独装过它们，建议卸载，避免两套行重复调用同样的路由与席位。

## 改清单

```powershell
node scripts/aggregate.mjs          # 生成 cordis.patch.yml 与 lib/rows.json
node scripts/aggregate.mjs --check  # 只校验生成物与清单一致（不一致退出码 1）
```
`test/smoke.mjs` 里的断言用的是「生成器内存输出 == 磁盘产物」，所以改了清单不重新生成会被测试拦住。

`aggregate.json` 里每个子插件一份：`subpath` / `plugin`（客户端模块表注册的包名）/ `fallback`（包内实现的相对路径，相对包根）/ 中文 `title`+`summary`，
带客户端半的再加 `client: true` 与 `clientEntry`（包内客户端 bundle 的相对路径，如
`./main/plugin-open-folder/client.js`）。生成器会顺带校验 `clientEntry` 读得到、且里面的注册 id 就是 `plugin`。

## 客户端半（浏览器侧）

**合集自己的客户端半必须是「经典脚本 bundle」**：官方客户端模块系统（`@deepseek-ai/dsh-client-modules`）把
`package.json` 的 `exports["./client"]` 指向的文件当 **classic script** 拼进 `/plugins/??...` 的 combo 里直接执行，
它只认这一种形状：

```js
window.__ModuleLoader__.load({
  id: 'yintxplugins',                       // 必须等于包名：客户端模块图按包名建行认领这条 entry
  factory: (require) => { /* … */ return module.exports },
})
```

所以 `lib/client.js` 里**不能出现 `import` / `export` 语句**。写成 ESM 的后果是整个 combo 解析失败
（`Uncaught SyntaxError: Unexpected token 'export'`），页面报 `1 entry did not activate: yintxplugins`——
其它行会各自回退到单独 URL 继续加载，只有合集这一条 entry 挂不上。

**子插件的客户端半由合集送出去**，原因有两个，缺一不可：

1. 客户端模块图的**每行只按包名建**（`exactPackageSpecifier`：带子路径的 loader 行拿不到客户端行），
   所以「合集里多插一行指向子插件」这条路走不通；
2. 子插件在 `link:` / `file:` 安装下**按包名解析不到**（pnpm 不会替被 `link:` 的包装依赖，profile 的
   `node_modules` 里没有 `dsh-plugin-*`），浏览器就更没法按包名 import。

于是链路是：

```
浏览器 lib/client.js
  └─ import('/yintx/client/open-folder.js')      ← 合集宿主半把子插件的 bundle 原样送出来
       └─ 子 bundle 顶层执行 window.__ModuleLoader__.load({ id: 'dsh-plugin-open-folder', factory })
  └─ require('dsh-plugin-open-folder')           ← 惰性模块表里已注册 → 物化出 exports
  └─ ctx.plugin(exports)                         ← 挂上（inject / 生命周期由官方 loader 管）
```

细节：

- 子 bundle 顶层只是一次注册调用，**当 ESM 解析也一样执行**，所以 `import()` 是安全的取件方式
  （子插件自己的客户端冒烟测试也是这么加载 `lib/client.js` 的）。
- 子插件若被**单独安装**（它自己就有一行、客户端半已注册），合集直接用模块表里的那份，**不再重复加载**，
  也就不会撞 `duplicate factory registration`。
- 某一步失败只留一条警告（缺少对应按钮），不影响其它子插件，也不会让页面报错。
- 走的是浏览器原生的模块取件（`import()`）+ 官方惰性模块表（`require`），**没有 eval / `new Function`**，不碰 CSP。
- 改动子插件或合集的客户端半后需要**重启宿主**：客户端 bundle 的字节在插件激活时就被快照了，只刷新页面拿到的还是同一份。
- 清单里 `client: true` 的行必须给出 `clientEntry`（子插件客户端 bundle 的同仓相对路径）；生成器会校验
  「文件读得到」且「注册 id 就是子插件包名」，两边不同源会有报错而不是静默挂不上。

## 只读路由

| 路由 | 内容 |
|---|---|
| `GET /yintx/status` | 合集与每个子插件的中文说明、**当前是否挂上**、有没有降级 |
| `GET /yintx/rows` | 活跃行 id 列表（被停用的行不在这里） |
| `GET /yintx/degraded` | 降级记录：`{ row, stage: import/shape/start/config, reason, at }` |
| `GET /yintx/client/<subpath>.js` | 按 `clientEntry` 读出子插件的**客户端 bundle**，原样送出（客户端半的唯一取件口） |

四条都走同一道**连接信任闸**：拿不到信任服务 → `503` 拒绝（不放行）。命名空间是 `/yintx/*`，与子插件自己的路由（`/plugin-open-folder/*`、`/plugin-local/*`、`/preset-folder/*`）互不干扰。

## 自测

```powershell
node test/smoke.mjs
```
覆盖：清单校验（含 `clientEntry`）、生成物一致性、每个子路径导出、外壳挂载每一行（含真实子插件）、同名解析失败→相对路径兜底、import/启动失败→降级且不抛、健康路由与 `/yintx/status` 的信任闸（无 connection 必须 503）、`/yintx/client/<subpath>.js`（原样送出 / 404 / 405 / 503）、客户端 bundle 是经典脚本形状（无 `import`/`export`）、注册 id == 包名、子插件客户端 bundle 可当 ESM 导入并注册、客户端目录与 `rows.json` 同源。

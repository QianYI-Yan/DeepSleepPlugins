# dsh-plugin-link-install（本地插件安装）

给官方「添加插件」对话框补**三件事**：**挑目录**、**预览插件信息**、**本地安装**。

头两件是本插件自己的能力；第三件**不代替官方** —— 勾上复选框后点官方「安装」，官方流程照常跑完
（官方跑 pnpm、官方把 `link:<源目录>` 写进 profile、官方选中 bundle、官方提示重启），本插件只在
官方写完**之后**做两件后置的事：复制一份副本进插件仓库、把那一行改写成 `file:` 相对形态（见第二节）。

---

## 一、界面上多出来的东西

打开官方「设置 → 插件 → 添加插件」对话框，里面会多出一行 + 一张卡片：

| 控件 | 作用 |
|---|---|
| **浏览本地目录** | 拉起 Windows 原生 `IFileDialog`，**默认停在你去过的那个目录**（见第三节），把选中的文件夹绝对路径填进官方输入框 |
| **选 package.json** | 同一个对话框的文件模式：挂 `package.json` 过滤、预填文件名；选中 `package.json` **等于**选中它所在的插件目录 |
| **☑ 本地安装** | 勾上后，点官方「安装」时本插件才介入：官方的安装流程**一步不拦**，等它写完之后复制副本 + 改写依赖形态 |
| **预览卡片** | 输入框里有路径时（防抖 250ms）自动出现：包名 / 版本 / 是不是 DSH 插件 / 有没有 bundle 与客户端半 / `private` / 运行时依赖条数 / 说明 / 真实目录 / 警告 |

**不勾**复选框 ＝ 完全不管，官方原样处理你输入的东西。

宿主半与浏览器半是分开的两块，随合集一起装：宿主半提供下面第四节那三条路由，浏览器半只做界面注入
（纯 DOM + MutationObserver，不打官方补丁，官方改版也不会连坐）。

## 二、安装链路（勾了复选框、点官方「安装」之后到底发生什么）

**官方那条流程一步都不拦、也不代替**（拦下来自己调 `installBundle`，官方界面会一动不动 ——
那正是被否掉的那一版）。分工是这样：

1. **官方自己跑**：官方 UI 收到点击 → 它自己跑 pnpm → 把 `link:<源目录>` 写进 profile 的
   `dependencies` → 选中 bundle（写 `dsh.profile.bundles`）→ 提示重启。
   界面上那些进度与结果**都是官方给的**。
2. **我们只登记一句「盯住这个源目录」**：点「安装」的同一刻，浏览器半调
   `POST /plugin-local/finish`，宿主半开始轮询 profile，等那一行**真的出现并且稳定**
   （`awaitOfficialWrite`）才动手 —— 官方那次没装成，这里就如实回报「没等到」，绝不假装成功。
3. **复制副本**：把源目录整份复制到 `DSH_HOME\plugins\<profile>\<插件包名>\`
   （跳过 `.git`、`.github`、`.vscode`、`.idea` 这类目录）。
4. **改写那一行**：把 profile 里官方才写下的 `link:<源目录>` 改成
   `file:../../plugins/<profile>/<插件包名>`（原子写 + 官方同一把锁，改前留时间戳备份）。
   **只认两种来源**：本次安装的源目录、或已经指向插件仓库里这份拷贝 —— 指向别处一律不动。
5. **把 `node_modules` 的链接指过去**：官方装本地路径时 pnpm 建的是指向**源目录**的链接，
   依赖改写之后链接也跟着指到副本，免得源目录一删一移插件就加载不到。

**结果**：profile 里那一行就是你要的形态 ——

```
file:../../plugins/<profile>/<插件包名>
```

> **为什么必须改写**：官方装本地路径时 pnpm 写的是 `link:C:/…`（指向你那份源目录）。
> 需求要的是「先复制一份进插件仓库，依赖指向那份拷贝」—— 所以复制 + 改写这两步是必须的，
> 而它们都发生在官方写完之后，官方流程本身完全没被改动。

**官方那次没装成怎么办**：官方自己的界面会告诉用户为什么（pnpm 的报错、版本不兼容、需要重启……），
本插件**不替它写任何东西** —— 我们的等待会超时，然后在状态行如实说「没等到官方把依赖写进 profile」。

> 这里有一个踩过的硬坑值得记住：官方 `installBundle` **不抛业务错误** —— 它的 `change()` 把一切失败
> 折叠进**返回值**（`{ application: 'failed', error: { code, diagnostic } }`），Promise 照样 resolve，
> 只有文件锁/销毁错误才真的 reject。所以「await 没抛」**不等于**「装上了」。
> 早先那版就是在这里假成功：官方明明失败（pnpm 装完又被 `restoreFiles` 回滚）、界面却报
> 「官方已安装并注册」，而 profile 里一行都没写 —— 用户看到的现象就是「改了多少次都没变化」。
> 现在这条链路根本不自己调官方安装，只等官方的**落盘结果**，所以从根上不会有假成功。

**重复安装同一个插件**：官方会再装一次，我们照旧在它写完之后复制副本 + 改写那一行（幂等）。

> **写 profile 必须原子 + 持官方那把锁**：profile 的 `package.json` 是多写者文件
> （官方 `change()` 全程持 `<package.json>.lock`、`pnpm` 自己也重写它）。
> 用 `writeFileSync` 直写会与并发写者交错出**坏 JSON** —— 实测代价是宿主连续三次启动失败：
> `readProfileManifest: Expected double-quoted property name in JSON at position 1080`。
> 所以 `normalizeDependencySpec` 的整段「读 → 改 → 写」都在 `withFileLockSync` 里跑，
> 提交用 `writeFileAtomicSync`（同目录临时文件 + rename）。

> **为什么要防重解析点**：Windows 的 junction（目录联接）在 Node 眼里**不是符号链接**，
> `readdir` 会把它当成普通目录。所以复制前必须自己用 `lstat` 判一次 —— 否则源目录里一个
> 指回父目录的 junction 会被无限递归展开，复制出巨量内容甚至撑爆磁盘。同理，复制时
> junction 一律不跟进去。
>
> 顺带一个实测坑：**判断 junction 指向必须用 `realpathSync.native`** —— JS 版 `realpathSync`
> 在 Windows 上解析不出 junction（原样返回链接自身），用它判断等于永远判错。

> **我们绝不删不属于自己的东西**：`node_modules` 链接只在「当前指向这次安装的源目录」或
> 「根本不存在」时才动；指向别处一律如实报告并**放过**（那可能是你用别的方式装的）。

## 三、选择器：两种模式 + 记住上次的目录

| 你要做什么 | 打开的窗口 |
|---|---|
| 只挑文件夹 | 系统原生「选择文件夹」—— `FOS_PICKFOLDERS`，**只显示文件夹** |
| 挑插件的 `package.json` | 系统原生**「打开」文件对话框**（就是资源管理器那套：左边树、右上搜索、下方「文件名(N):」输入框与文件类型下拉）—— 类型下拉是 `package.json` / `所有文件`，**默认落在 `package.json` 上**，文件名框预填 `package.json`，窗口开在起始目录 |

**起始目录（记忆）**：按下面顺序取，取到存在的那一个就用它 ——

1. 输入框里已有的路径（手输的，或上次选完留下的）
2. 上次**选过**的目录（存在 `DSH_HOME\.link-install-state.json` 的 `lastPicked`）
3. 上次**安装**用过的源目录（同一文件的 `lastSource`）
4. 你的用户主目录

每次选完都会写回 `lastPicked`，所以**下次打开就停在上次那个目录**。

**靠什么实现** —— 这里有一条踩过的硬坑，别再走回头路：

| 顺序 | 实现 | 吃得下起始目录吗 | 能选 package.json 吗 |
|---|---|---|---|
| ① | **自带的 Win32 原生选择器**（`native-pick.cjs`：koffi 直驱 `IFileOpenDialog`，独立子进程里跑模态 `Show`） | ✅ `IFileDialog::SetFolder`（vtable 槽位 12） | ✅ `FOS_FILEMUSTEXIST` + `package.json` 过滤（槽位 15 预填文件名） |
| ② | 官方 `ctx.directoryPicker` | ❌ 结构上**没有** `SetFolder`，只开在系统自己的 MRU | ❌ 写死 `FOS_PICKFOLDERS`，只能选目录 |

> ⚠️ **不要试图用 Electron 的 `dialog.showOpenDialog`**。DSH 桌面版起宿主进程时设了
> `ELECTRON_RUN_AS_NODE=1`（`app.asar/lib/main.js` 的 `desktopNodeEnvironment`），
> 于是宿主里的 `require('electron')` 是 **MODULE_NOT_FOUND**（本机实测），`electron.dialog`
> 永远是 undefined。曾经把 Electron 当首选的那一版，每次请求都静默回落到 ② ——
> 表现就是「浏览本地目录没有记忆」「选 package.json 打开的其实是选文件夹」。
>
> ① 拿不到 koffi（非桌面端、安装结构不同）时才走 ②，并在结果里如实标注回落原因。

**自检两遍**（都不用点，第二遍的窗口会自己关）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
$exe = "<DSH 安装目录>\DeepSeek Harness.exe"
$w   = "<包根>\main\plugin-link-install\native-pick.cjs"

# ① 不弹窗：把对话框设一遍 + 走一遍「IShellItem → GetDisplayName」取路径链
& $exe $w --probe --with-seed
# 期望（三个 0 = S_OK；displayName 就是补上的那条链）：
# {"ok":true,"probe":true,"setOptions":0,"setFileOptions":0,"setTitle":0,
#  "setFolder":{"ok":true,"hr":0},
#  "fileMode":{"applied":true,"setFileTypes":0,"setFileTypeIndex":0},
#  "displayName":{"hr":0,"path":"C:\\Users\\<你>"}}

# ② 弹一下会自己关：Show → 返回 → 写出结果 → 进程退出
& $exe $w --selftest --close-after=1200
# 期望：DshPick:showing → DshPick:shown -2147023673（ERROR_CANCELLED）→ DshPick:result {...}
```

> ⚠️ pwsh 的 `&` 调 GUI 子进程**不会等它**（输出迟到，看着像"没输出"）；要完整输出请用
> `Start-Process -PassThru -RedirectStandardOutput <文件>` 再轮询那个文件。**清理时只停你记下的那个
> PID**，别按进程名批量杀 —— 宿主进程同名。
>
> 三个踩过的坑都写进测试里了：`SLOT_GET_DISPLAY_NAME`（IShellItem 的槽位 5）漏定义时，「选完
> package.json」会抛错并让宿主回落到官方选择器（**又弹一个选文件夹的窗口**）；
> `SetFileTypes` 的第三个参数写成 `void *` 时 koffi 不按结构体编码（过滤器静默失效）；
> `CLOSER_SOURCE` 是模板字符串，里面出现一个反引号就会把它截断。

## 四、宿主路由（只有三条）

| 路由 | 输入 | 输出 | 会写盘吗 |
|---|---|---|---|
| `POST /plugin-local/pick` | `{ initial?, kind? }`（kind 为 `folder` 或 `file`） | `{ ok, dir, pickedFile, via, seeded, elapsedMs }` | 不写 |
| `POST /plugin-local/inspect` | `{ source }` | `{ ok, name, version, description, isDshPlugin, hasBundlePatch, hasClient, private, runtimeDeps, dir, warnings }` | 不写 |
| `POST /plugin-local/finish` | `{ source, profile?, timeoutMs? }` | `{ ok, name, target, copiedFiles, dependency, rewritten, relinked, warnings }` | **写** |

- `pick` 只拉起窗口，`inspect` 只读一个 `package.json`（给预览卡片用）。
- `finish` 是唯一会写盘的：等官方把依赖写进 profile（轮询，默认最多 2 分钟）→ 复制副本 →
  改写那一行 → 把 `node_modules` 链接指到副本。
- 三条都过 dsh 的**连接信任检查**：拿不到信任服务就 `503` 拒绝 —— 它们能拉起系统窗口、
  能往插件仓库里写文件，不能在没有校验的情况下放行。

## 五、环境开关与定位变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME=<目录>` | DSH 主目录（默认 `C:\Users\<你>\.dsh`）。记忆文件与插件仓库都在它下面 |
| `DSH_PROFILE=<名>` | 指定 profile（默认按「cwd 落在哪个 profile → 只有一个 profile → web → default → desktop」猜）。副本目标是 `DSH_HOME\plugins\<profile>\<name>` |

## 六、排查

**没有日志文件** —— readme 只要求「挑目录 / 预览 / 本地安装」，选择器日志属于多余功能，已删。

| 现象 | 先看哪里 |
|---|---|
| 点「浏览本地目录」没反应 | 打开浏览器 F12 控制台：这一行是纯 DOM 注入，注入失败会打警告 |
| 选择器停了别处、没有记忆 | 状态行会写走的是哪条路（`Windows 原生选择器（IFileOpenDialog）` 才吃起始目录）；回落官方选择器时会标出来 |
| 预览卡片不出现 | 输入框里得是**本地路径**（`D:\…` / `\\…` / `/…`）；包名不会去读盘 |
| 路径没被填进官方输入框 | 官方那个输入框是 React 受控组件，本插件用原型 value setter 绕过它的 value tracker；官方若换了实现，注入会失效 —— 看控制台 |
| 装完了没生效 | 重启 dsh；再看 `DSH_HOME\profiles\<profile>\package.json` 里那一行是不是 `file:../../plugins/...` |
| 状态行说「没等到官方…」 | 说明官方那次安装没写成 —— 以**官方界面**给的错误为准（本插件不替它写） |

## 七、自测

```powershell
cd <yintxplugins 包根>\main\plugin-link-install
node test/smoke.mjs        # 40 项：复制 / 改写 / 等官方落盘 / 链接重指 / 原子写与文件锁 / 选择器契约 / 记忆路径
node test/smoke-client.mjs # 8 项：预览卡片渲染 / 防抖与请求 / 不拦官方那次点击
```

这两个文件**只碰临时目录与内存里的假 DOM**（现造的假 `DSH_HOME`），不会动你真实的 `.dsh`。

合集侧还有一条走包内相对路径挂载的断言：

```powershell
cd <yintxplugins 包根>
node test/smoke.mjs        # 41 项，含「三行都能挂上真实子插件」
```

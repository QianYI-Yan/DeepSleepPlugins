# dsh-preset-bridge

`dsh-preset-dir-scan` + `dsh-preset-folder-button` 的**合并版**——一个宿主插件，两件配套的事。

```
⚙ dsh-preset-bridge（宿主半 + 客户端半）
├─ A. 目录扫描    DSH_HOME/.agent-presets/<id>/ → agent-preset 声明 → 注册表（热同步）
└─ B. 打开目录    POST /preset-folder/open → 系统文件管理器
    C. 卡片按钮   往官方预设卡片的「浏览」按钮旁注入「打开目录」按钮（纯 DOM，不改官方文件）→ 调 B
```

## 为什么合并

两个插件本来就是一体的：同一个预设目录来源规则、同一个 `DSH_HOME` 解析、一起服务于「老式目录预设」这一件事，却要装两个包、往 profile 里插两行 bundle。合并后：

| | 合并前 | 合并后 |
|---|---|---|
| 包数 / bundle 行 | 2 | 1 |
| `inject` | `['agentPresets']` + `['webServer']` 各一份 | `['agentPresets', 'webServer']` 一份 |
| 预设目录来源规则 | 两份重复实现 | 只算一次（`presetRoot()`） |
| 关闭其中一半 | 只能卸载整个包 | `config: { scan: false }` / `{ route: false }` |

## 功能 A：目录扫描（原 dsh-preset-dir-scan）

把 0.1.x 时代的「目录式预设」带回 0.2.0：0.2.0 改成「声明行」制后注册表不再扫描目录，本插件替你扫，把每份目录读成 `agent-presets.register()` 需要的定义：

- 读取 `<预设目录>/preset.yml`（元数据：`name` / `description` / `order`）与 `agent.cordis.yml`（行列表）；
- `!!js` 表达式保留为 `{ __jsExpr: '原文' }`，不在注册时求值（交给官方 Loader）；
- 相对模块名（`./xxx.mjs`、`../xxx.mjs`）改写成基于该预设目录的绝对 `file://` 地址；
- 0.2.0 已移除的包自动换成替代行：`@deepseek-ai/dsh-workflow-worker-thread` → `workflow-ptc`；
- `group: true` 行的 `config` 数组递归处理；
- 目录有增删改就重新同步（`fs.watch`），新增即注册、删除即注销；
- 单份预设出错只跳过它本身（打警告），绝不影响 dsh 启动或其它预设；
- 内置跳过名单 `SKIP_IDS`（默认跳过与插件自带同名的 `liangshen`）。

## 功能 B：打开目录路由（原 dsh-preset-folder-button）

注册 `POST /preset-folder/open`，由客户端半注入的按钮（见功能 C）调用：

- 先过 dsh 的连接信任检查（`connection.requestRejection`），不是本机带令牌的页面一律拒；
- body 二选一：`{ presetId }`（预设目录名）或 `{ name }`（预设**显示名** —— DOM 注入的按钮只能拿到这个，
  见 `findPresetDirByName`）；都不传 = 打开预设根目录；
- `presetId` 只允许 `[A-Za-z0-9._-]` 且不许含 `..`（挡路径穿越）；
- 目录不存在返回 404（**不自动创建**，免得用户以为预设丢了）；
- 非 POST → 405；非法 JSON → 400；请求体上限 16 KiB；
- 「打开目录」这一下**不再由本插件自己实现**：调 `lib/shared/open-dir.js` 里那份合集内唯一实现
  （win：`explorer.exe`，mac：`open`，linux：`xdg-open`，detached 且不与 dsh 进程耦合），
  与 `plugin-open-folder` 行共用同一份代码；不依赖官方那个只认「已注册应用」的 open-in-app。

## 安装

正常情况下**不用单独装**：它是 `yintxplugins` 合集里的一行（显示名「预设目录桥接」），
装合集即可，还能在「设置 → 插件」里单独开关这一行。

要脱离合集单独装，用**本目录**的绝对路径：

```powershell
dsh plugin --profile desktop add link:'<yintxplugins 包根>\main\preset-bridge'
# 然后重启 dsh（或刷新 Web 界面）
```

自检：

```powershell
dsh --profile desktop --dump-config | Select-String 'preset-bridge'   # 必须恰好 1 行
```

浏览器控制台里，`window.__DSH_BOOT__.entries.find(({ id }) => id === 'dsh-preset-bridge')` 应返回带 `url` 的登记。

**依赖**：`yaml ^2.5.0`（profile 的 `node_modules` 里已有 `yaml`，link 安装后可直接解析；若单独跑本包，先 `npm i yaml`）。

## config 开关

```yaml
- id: dsh-preset-bridge
  name: dsh-preset-bridge
  config:
    scan: true    # false = 只保留「打开目录」路由
    route: true   # false = 只保留目录扫描
```

## 功能 C：预设卡片上的「打开目录」按钮（客户端半）

0.1.5 的官方预设卡片上本来有一个「打开目录」图标按钮，0.2.0 把宿主接口和按钮一起删掉了。
本插件的客户端半把它加回来 —— **纯 DOM 注入，不改官方任何文件**。

> 为什么不用「给官方文件打补丁」那个办法：它只在 `npm-cache\_npx` 里找得到目标文件，而**桌面版**
> 的官方代码打包在 `app.asar` 里，脚本根本够不到 —— 表现就是「按钮从来没出现过」。

**它怎么定位卡片**：官方 0.2.0 的卡片上有一个图标按钮（class 形如 `<哈希>_iconButton`，
`aria-label` 形如 `<浏览>: <预设显示名>`）。客户端半按这个特征找，在它后面插一个自己的按钮
（同一个父容器，外观一致，图标是文件夹）。

**它怎么知道是哪个预设**：DOM 里只有**显示名**（预设 id 拿不到），所以按钮把显示名回传给宿主，
宿主按「目录名相等 → `preset.yml` 的 `name` 相等」在 `DSH_HOME\.agent-presets` 下找到目录。

**官方改版怎么办**：如果官方换了类名或 `aria-label` 格式，这个按钮会**安静地不出现**
（不报错、不影响页面别处）。排查：F12 控制台里搜 `_iconButton`，看官方按钮的 `aria-label` 现在长什么样。

## 与两个旧包的关系

`dsh-preset-dir-scan` 与 `dsh-preset-folder-button` 已归档在 `..\.d\` 下，装本包后**不要再装它们**——`inject` 面重叠、预设会被注册两次（id 冲突时后者失败并打警告）。迁移：

```powershell
dsh plugin --profile desktop remove dsh-preset-dir-scan
dsh plugin --profile desktop remove dsh-preset-folder-button
dsh plugin --profile desktop add link:'D:\Code\DeepSeek\.DeepSeekHarnessPlugins\dsh-preset-bridge'
```

## 验证

跑过 13 项冒烟断言（导出面 / inject 并集 / 行改写与 `!!js` / 真实预设目录读取 / 假 ctx 下的路由注册与预设注册 / 405·400·404 分支），全部通过。

```powershell
cd <yintxplugins 包根>\main\preset-bridge
node scripts\smoke.mjs      # 13/13
```

## License

沿用原两个插件的做法，无额外声明。

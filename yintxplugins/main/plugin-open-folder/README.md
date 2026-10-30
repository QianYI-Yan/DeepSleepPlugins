# dsh-plugin-open-folder（插件详情页 · 打开目录）

在官方**插件详情页的页头**（开关与「卸载」按钮那一排）加一个 **「打开目录」** 按钮：
点它用系统文件管理器打开该插件在磁盘上的**真实目录** —— 不管这个插件是 `link:` 装的、
`file:` 装的，还是从 `node_modules` 里装的，都会还原到它真正躺着的地方。

它是合集里**唯一**提供「打开目录」的那一行；preset-bridge 的预设卡片按钮复用同一份实现
（`lib/shared/open-dir.js`），不再各写一份。

## 界面上多出来的东西

插件详情页页头会出现 `[📂 打开目录]`，后面跟着一行小字：

- 成功 → 显示真实路径，**点一下可以复制**；
- 失败 → 显示宿主给的原因（比如「这个包不在磁盘上」）。

拿不到官方席位（slots 服务不可用时）**安静退出**，不影响页面其它部分 —— 这一行没了，
但插件的其它功能照常。

## 宿主路由（三条）

| 路由 | 干什么 |
|---|---|
| `GET /plugin-open-folder/ping` | 健康检查：宿主在不在、版本多少 |
| `GET /plugin-open-folder/resolve?name=<包名>&profile=<可选>` | **只解析**：告诉我这个插件装在哪，不打开任何窗口 |
| `POST /plugin-open-folder/open` | 解析 + 用系统文件管理器打开 |

三条都过 dsh 的**连接信任检查**；`name` 还要过包名白名单（挡掉 `../` 之类的路径穿越）。

## 它怎么找到插件的真实目录

按 profile 里记着的东西**四级探测**，第一个命中的赢：

| 顺序 | 依据 | 命中场景 |
|---|---|---|
| ① | profile 依赖写着 `link:<路径>` | 你用 `dsh plugin add link:...` 装的 |
| ② | profile 依赖写着 `file:<路径>` | 本地路径依赖（合集自己就是这种） |
| ③ | `DSH_HOME/plugins/<profile>/<包名>`，再退 `DSH_HOME/plugins/<包名>` | 本地安装（整份复制进插件仓库）的两种布局 |
| ④ | `<profile>/node_modules/<包名>` | npm / git 正常装的；这里用 `realpath` 还原 junction，把链接还原成**源目录** |

四级都不命中就如实返回「找不到」，界面显示原因 —— 不会瞎开一个目录。

## 自测

```powershell
cd <yintxplugins 包根>\main\plugin-open-folder
node test\smoke-host.mjs      # 18 项：三条路由、四级路径解析、信任闸、405
node test\smoke-client.mjs    # 18 项：席位注入、按钮状态、清理函数
```

## 单独安装

这个子插件可以脱离合集单独安装（它自己就是一份完整的宿主半 + 客户端半）。
走合集时它显示为 `yintxplugins/open-folder` 一行，可以单独开关。

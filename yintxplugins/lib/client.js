/**
 * yintxplugins 合集的父客户端半（浏览器侧）。
 *
 * ⚠ 本文件**必须**是「经典脚本 bundle」形状——官方客户端模块系统把 `exports["./client"]`
 * 指向的文件当 classic script 拼进 `/plugins/??...` 的 combo 里直接执行，它只认这一种：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ...; return module.exports } })
 *
 * 所以本文件里**不能出现 `import` / `export` 语句**（连 `export const` 也不行）：带 export 的
 * ESM 会让整段 combo 解析失败（`Unexpected token 'export'`），这一条 entry 就挂不上，
 * 页面报 `1 entry did not activate`。三个子插件的 lib/client.js 也是同一形状，可以对着看。
 *
 * 客户端半怎么取到子插件的界面：子插件在 link:/file: 安装下**按包名解析不到**，官方客户端
 * 模块图又只按**包名**建行，所以子插件的客户端半没法自己成一行。合集的做法是：
 *   ① 宿主半 `GET /yintx/client/<subpath>.js` 把子插件的客户端 bundle **原样**送出去；
 *   ② 这里 `import()` 它（子 bundle 顶层只是一次 `__ModuleLoader__.load` 注册，当 ESM 解析
 *      也一样执行）、再 `require('<包名>')` 把注册好的插件拿回来，`ctx.plugin` 挂上。
 *   ③ 子插件若被**单独安装**（它自己就有一行、客户端半已注册），第 ① 步直接跳过，不重复挂。
 *
 * 目标很克制：**只负责把合集的中文介绍与三个子插件的状态显示出来**，不接管子插件的 UI。
 * 客户端可用的席位随 DSH 版本变动，所以这里一律**特性探测 + try/catch**：
 * 找不到席位就安静退出，绝不因为合集而让页面报错。子插件的功能不受影响。
 */
;(function () {
  /** 客户端插件名（loader 会显示在「设置 → 插件」里）。 */
  const NAME = 'yintxplugins'

  /** 子插件客户端 bundle 的送出路由前缀（与宿主半 lib/index.js 的 ROUTE_CLIENT 同值）。 */
  const ROUTE_CLIENT = '/yintx/client'

  /**
   * 子插件「行是否被启用」的轮询间隔（毫秒）。
   *
   * 子插件的客户端半由本文件代挂，官方 loader 不会因为**子行**被禁用就顺带卸掉它
   * （子行的客户端模块图按包名建，link: 安装下解析不到包名，那一行根本没有自己的客户端行）。
   * 所以只能主动问宿主半：`/yintx/status` 里每行的 `mounted` 就是「这一行有没有被 apply」的账，
   * 被禁用的行不进账本 → `mounted: false`。切开关后最多一个间隔就能对上。
   */
  const ROW_SYNC_INTERVAL = 3000

  /**
   * factory 拿到的客户端 `require`（惰性 CJS 模块表的同步 require）。
   * 子插件的客户端半只能靠它按包名取回来，所以记在这里给 apply 用。
   */
  let liveRequire

  /**
   * 不 inject 任何客户端服务：这样在任何 DSH 版本上都能安全挂载，
   * 具体席位在 apply 里按需探测。
   */
  const inject = []

  /**
   * 子插件目录：**只放结构字段**，与 lib/rows.json 同源（测试断言两边一致，防漂移）。
   *
   * 中文标题与说明**不在这里硬编码** —— 一律取自宿主半的 `/yintx/status`
   * （文案的唯一事实来源是 `aggregate.json`）。原先这里各写了一份简写版文案，
   * 已经和清单漂移了，且少了取脚本 URL 必需的 `subpath`（拼出来是 `undefined.js`）。
   */
  const CATALOG = [
    {
      id: 'yintx-open-folder',
      name: 'yintxplugins/open-folder',
      subpath: 'open-folder',
      plugin: 'dsh-plugin-open-folder',
      client: true,
    },
    {
      id: 'yintx-preset-bridge',
      name: 'yintxplugins/preset-bridge',
      subpath: 'preset-bridge',
      plugin: 'dsh-preset-bridge',
      client: true,
    },
    {
      id: 'yintx-link-install',
      name: 'yintxplugins/link-install',
      subpath: 'link-install',
      plugin: 'dsh-plugin-link-install',
      client: true,
    },
    {
      id: 'yintx-todo-float',
      name: 'yintxplugins/todo-float',
      subpath: 'todo-float',
      plugin: 'dsh-plugin-todo-float',
      client: true,
    },
    {
      id: 'yintx-session-popout',
      name: 'yintxplugins/session-popout',
      subpath: 'session-popout',
      plugin: 'dsh-plugin-session-popout',
      client: true,
    },
  ]

  /** 合集的中文自我介绍（父插件的门面文案）。 */
  const INTRO = {
    title: 'yintxplugins 合集',
    summary: '五个本地子插件打成一个聚合包：本地插件安装、插件详情页「打开目录」、预设目录桥接、会话待办悬浮窗、会话拖出小窗。',
    note: '每个子插件各占一行，可在「设置 → 插件」里单独开关；客户端半会跟随开关自动挂载/卸下（3 秒同步一次），某一行失败只记降级，不影响其它行。',
  }

/** 探测一个可选的客户端席位（不同 DSH 版本字段名不同，探测不到就返回 null）。 */
function findSlot(ctx) {
  const candidates = ['uiPluginDetail', 'uiPluginManager', 'uiSettings', 'uiWorkspace']
  for (const key of candidates) {
    try {
      const service = ctx?.get?.(key)
      if (service && typeof service === 'object') return { key, service }
    } catch {}
  }
  return null
}

/** 子插件客户端 bundle 的送出 URL（宿主半按 lib/rows.json 的 clientEntry 读盘）。 */
function clientScriptUrl(row) {
  return `${ROUTE_CLIENT}/${row.subpath}.js`
}

/** module → 可挂的插件（函数，或 { apply }）；没有可用形状返回 null。 */
function pluginShapeOf(loaded) {
  const plugin = loaded?.default ?? loaded
  if (typeof plugin === 'function') return plugin
  if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') return plugin
  return null
}

/** 已经注册过的包名（独立安装的子插件）就同步 require 回来；没注册返回 undefined。 */
function requireIfRegistered(spec) {
  if (typeof liveRequire !== 'function') return undefined
  try {
    return liveRequire(spec)
  } catch {
    return undefined
  }
}

/**
 * 取一个子插件的客户端半。
 *
 * 先看它是不是已经注册过（子插件被**单独安装**时它自己就有一行，别重复加载、也别重复挂）；
 * 否则 `import()` 合集宿主半送出的那份 bundle——子 bundle 顶层就是一次
 * `window.__ModuleLoader__.load({ id: '<包名>', factory })`，当 ESM 解析也照样执行、注册。
 * @returns 可挂的插件（函数或 `{ apply }`）
 */
async function loadSubClient(row) {
  const registered = requireIfRegistered(row.plugin)
  if (registered !== undefined) return pluginShapeOf(registered)
  await import(clientScriptUrl(row))
  return pluginShapeOf(liveRequire(row.plugin))
}

/**
 * 挂一个子插件的客户端半。
 *
 * 单独 try/catch：挂不上只留一条警告，**绝不冒泡**（外部插件不能把 GUI 拖下水）。
 * @returns 记下来的 fiber（供随行开关卸载）；拿不到可卸载的 fiber 时返回 `null`；
 *          挂不上（没有 `ctx.plugin`、没有可用形状、加载失败）返回 `undefined`
 */
async function mountOne(ctx, row) {
  if (row.client !== true) return undefined
  if (typeof ctx?.plugin !== 'function') {
    console.warn(`[yintxplugins] 上下文没有 ctx.plugin，子插件客户端半 ${row.plugin} 未挂载`)
    return undefined
  }
  try {
    const plugin = await loadSubClient(row)
    if (plugin === null) {
      console.warn(`[yintxplugins] 子插件客户端半 ${row.plugin} 没有可用形状（应为函数或 { apply }），已跳过`)
      return undefined
    }
    const fiber = ctx.plugin(plugin, {})
    if (fiber !== null && typeof fiber === 'object' && typeof fiber.dispose === 'function') return fiber
    // 没有 fiber 可退订（客户端 ctx 形状随版本变）：挂上了但后续开关只有刷新页面才生效
    return null
  } catch (error) {
    console.warn(
      `[yintxplugins] 子插件客户端半 ${row.plugin} 未能由合集挂载（${error?.message ?? error}）；` +
        `若界面缺少对应按钮，请看 README「客户端半」一节`,
    )
    return undefined
  }
}

/**
 * 依次把给定的子插件客户端半挂上。
 *
 * @param catalog 要挂的行（`pickEnabledRows` 的结果；测试里可直接传 CATALOG）
 * @param fibers 挂上的 fiber 记账表（`row.id → fiber`），供后续卸载
 * @returns 真正挂上的个数（0 表示这个 DSH 版本/装法下客户端半由别处负责）
 */
async function mountSubClients(ctx, catalog = CATALOG, fibers) {
  let mounted = 0
  for (const row of catalog) {
    const fiber = await mountOne(ctx, row)
    if (fiber === undefined) continue
    if (fibers instanceof Map) fibers.set(row.id, fiber)
    mounted += 1
  }
  return mounted
}

/**
 * 卸一个已挂的子插件客户端半。
 *
 * 子插件自己的 `apply` 会用 `ctx.effect(() => cleanup)` 登记清理（移除 DOM、退掉数据订阅），
 * 所以 dispose 掉这里的 fiber 之后，界面上的悬浮窗/胶囊就真的没了。
 * @returns 是否真的卸了一个
 */
function unmountOne(fibers, row) {
  const fiber = fibers.get?.(row.id)
  if (fiber === undefined) return false
  try {
    fiber?.dispose?.()
  } catch (error) {
    console.warn(`[yintxplugins] 卸载子插件客户端半 ${row.plugin} 失败：`, error)
  }
  fibers.delete(row.id)
  return true
}

/**
 * 从 `/yintx/status` 的快照里读「某一行是否被启用」。
 *
 * `mounted` 反映宿主半账本（`lib/shared/state.js` 的 `listActiveRows`）：
 * 只有 loader **真的 apply 了那一行**，外壳才会 `recordActiveRow`；
 * 被用户在「设置 → 插件」里停用的行不会 apply，因此不进账本 → `mounted === false`。
 *
 * @returns `true`/`false`；快照里没有这一行（或根本没拿到快照）→ `undefined`（调用方按「挂」回退）
 */
function rowEnabled(status, rowId) {
  if (status === null || status === undefined || !Array.isArray(status.rows)) return undefined
  const row = status.rows.find((item) => item?.id === rowId)
  if (row === undefined || row === null) return undefined
  return row.mounted === true
}

/**
 * 从目录里挑出「宿主半说已启用」的行。
 *
 * 拿不到状态（旧宿主半没有 `/yintx/status`、网络失败、信任闸拒绝）时**退回全挂**：
 * 宁可多挂（旧行为），也不能因为读不到状态就让功能整体消失。
 */
function pickEnabledRows(catalog = CATALOG, status) {
  // 账本不可信（拿不到快照、或宿主半自己标记 ledgerReliable=false）时退回全挂（旧行为）：
  // 宁可多挂，也不能把「账本坏了」误读成「所有子行都被禁用」而让整个界面空掉。
  const reliable = status !== null && status !== undefined && status.ledgerReliable !== false
  return catalog.filter((row) => {
    if (row.client !== true) return false
    if (!reliable) return true
    const enabled = rowEnabled(status, row.id)
    return enabled === undefined ? true : enabled
  })
}

/**
 * 盯着「设置 → 插件」里的子行开关：启用就挂、禁用就卸。
 *
 * 只在浏览器里跑（`document` 存在）；页面隐藏时跳过这一轮，省电。
 * 拿不到 `ctx.effect` 席位时退化成随页面生命周期存在。
 * @returns 停止函数
 */
function startRowSync(ctx, fibers) {
  if (typeof document === 'undefined' || typeof setInterval !== 'function') return () => {}
  let timer
  const tick = async () => {
    try {
      if (document.hidden) return
      const status = await fetchStatus()
      if (status === null) return
      const wanted = new Set(pickEnabledRows(CATALOG, status).map((row) => row.id))
      for (const row of CATALOG) {
        if (row.client !== true) continue
        const tracked = fibers.has(row.id)
        if (wanted.has(row.id) && !tracked) {
          const fiber = await mountOne(ctx, row)
          if (fiber !== undefined) fibers.set(row.id, fiber)
        } else if (!wanted.has(row.id) && tracked) {
          console.info(`[yintxplugins] 子插件行 ${row.id} 已停用，卸下它的客户端半`)
          unmountOne(fibers, row)
        }
      }
    } catch (error) {
      console.warn('[yintxplugins] 同步子插件开关状态失败：', error?.message ?? error)
    }
  }
  timer = setInterval(tick, ROW_SYNC_INTERVAL)
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  try {
    ctx?.effect?.(() => stop, 'yintxplugins: row sync')
  } catch {}
  return stop
}

/**
 * 读一次父 host 半的状态路由（拿不到就返回 null，不抛）。
 * 注意：不带 cookie 时会 401/503 —— 那也是正常结果，不当作错误。
 */
async function fetchStatus() {
  try {
    const response = await fetch('/yintx/status', { credentials: 'same-origin' })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function apply(ctx) {
  try {
    // 先问一次宿主半：被禁用的子行不该挂客户端半（否则设置里关掉开关，功能还赖在界面上）
    const status = await fetchStatus()
    const fibers = new Map()
    // 挂上「已启用」的子插件客户端半（挂不上不影响宿主侧，也不该让页面报错）
    const mountedSubs = await mountSubClients(ctx, pickEnabledRows(CATALOG, status), fibers)

    // 之后持续跟着「设置 → 插件」里的子行开关走：启用就挂、禁用就卸
    startRowSync(ctx, fibers)

    if (findSlot(ctx) === null) {
      // 没有可用席位：合集不带 UI，功能全在子插件里，所以这不是错误
      return
    }
    const rows = Array.isArray(status?.rows) && status.rows.length > 0 ? status.rows : CATALOG
    // 只在真的拿到席位时暴露一点只读信息，供宿主的插件详情/设置页显示
    try {
      ctx?.provide?.('yintxCatalog', {
        intro: INTRO,
        mountedSubClients: mountedSubs,
        rows: rows.map((row) => ({
          // 文案的唯一来源是宿主半 /yintx/status（它读 aggregate.json）；
          // 拿不到就退回模块名，绝不在这里硬编码中文，免得又和清单漂移。
          title: row.title ?? row.name,
          summary: row.summary ?? '',
          mounted: row.mounted === true,
          degraded: row.degraded ?? null,
        })),
      })
    } catch {}
  } catch (error) {
    // 客户端半边只做门面展示与子半装载，任何异常都不该冒泡
    console.warn('[yintxplugins] 客户端半初始化跳过：', error?.message ?? error)
  }
}

  /**
   * 注册本插件：**这是本文件唯一的对外形状**，见文件头。
   * 顺手把目录与工具函数一起导出（自己人测试用，子插件客户端半也是这么留的）。
   */
  window.__ModuleLoader__.load({
    id: NAME,
    factory: (require) => {
      liveRequire = require
      return {
        name: NAME,
        inject,
        apply,
        CATALOG,
        INTRO,
        ROUTE_CLIENT,
        ROW_SYNC_INTERVAL,
        clientScriptUrl,
        fetchStatus,
        rowEnabled,
        pickEnabledRows,
        mountOne,
        mountSubClients,
        unmountOne,
        startRowSync,
      }
    },
  })
})()

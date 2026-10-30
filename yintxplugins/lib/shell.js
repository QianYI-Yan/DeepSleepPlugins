/**
 * 通用子插件外壳（fault-isolation shell）—— 做法学自 `@linxin666/dsh-web-all` 的聚合包：
 *
 * DSH 的 loader 把一个 bundle 的所有 patch 行当成**一个事务组**挂载：任何一行
 * import 或启动失败，整组回滚、`dsh web` 起不来。于是合集让每个子插件行挂的
 * 不是实现本体，而是这个「永不失败」的外壳：它把 `config.plugin` 指名的真实实现
 * 动态 import 进来，失败就记一条降级并安静退出，其余行照常起。
 *
 * 行形态（cordis.patch.yml，由 scripts/aggregate.mjs 生成）：
 *   - insert:
 *       - id: yintx-open-folder
 *         name: 'yintxplugins/open-folder'                  # ← 本外壳（子路径导出）
 *         config:
 *           fallback: ./main/plugin-open-folder/index.js    # ← 包内真实实现（相对包根）
 *
 * 清单当前**只写 `fallback`**（合集自包含，子插件包不再单独安装）；`config.plugin` 是
 * 可选的「先按包名解析」路径，只有子插件被单独安装时才写（解析失败会自动回退 `fallback`）。
 *
 * `inject = []`：外壳必须在任何东西之前激活，不能依赖 webServer。健康路由走嵌套 inject。
 */
import { clearDegraded, recordActiveRow, recordDegraded, removeActiveRow } from './shared/state.js'
import { holdHealthRoutes } from './shared/health.js'

export const name = 'yintxplugins-shell'

/** 合集包根目录（`lib/shell.js` 的上一层）：`config.fallback` 的相对基准。 */
const PACKAGE_ROOT = new URL('../', import.meta.url)

/** 必需服务：无。外壳只是个装载器。 */
export const inject = []

/**
 * 剥出实现的配置：`plugin` / `fallback` 是外壳的字段，其余原样传给实现
 * （子插件自己的配置写在同一条行的 config 里即可）。
 */
export function implConfigOf(config) {
  if (!config || typeof config !== 'object') return {}
  const { plugin, fallback, ...rest } = config
  return rest
}

/**
 * 加载真实实现：先按 `config.plugin` 说明符 import；失败再按 `config.fallback` import。
 * **`fallback` 相对合集包根目录**（不是相对本文件），因为合集常用 link:/file: 安装，
 * 兄弟子插件就在包根的上一层同级目录——写成 `../dsh-plugin-xxx/lib/index.js` 最直观。
 * @returns {{ ok: true, module, via: string, recovered: Error|null } | { ok: false, stage: string, error: unknown }}
 */
export async function loadImpl(spec, fallback) {
  let firstError
  if (typeof spec === 'string' && spec.trim() !== '') {
    try {
      return { ok: true, module: await import(/* @vite-ignore */ spec), via: spec, recovered: null }
    } catch (error) {
      firstError = error
    }
  }
  if (typeof fallback === 'string' && fallback.trim() !== '') {
    try {
      const url = new URL(fallback.trim(), PACKAGE_ROOT).href
      return { ok: true, module: await import(/* @vite-ignore */ url), via: url, recovered: firstError }
    } catch (error) {
      return { ok: false, stage: 'import', error: firstError ?? error }
    }
  }
  return {
    ok: false,
    stage: 'import',
    error: firstError ?? new Error('外壳行的 config 里既没有 plugin 也没有 fallback'),
  }
}

/** module → 可挂的插件（函数，或 { apply }）。 */
export function pluginShapeOf(module) {
  const plugin = module?.default ?? module
  if (typeof plugin === 'function') return plugin
  if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') return plugin
  return null
}

export async function apply(ctx, config) {
  holdHealthRoutes(ctx)

  let mounted
  let activeRow
  /** 串行化：配置更新可能在上一次挂载还没结束时到达。 */
  let tail = Promise.resolve()

  const publishRow = (id) => {
    if (activeRow === id) return
    if (activeRow !== undefined) removeActiveRow(activeRow)
    activeRow = id
    if (id !== undefined) recordActiveRow(id)
  }

  try {
    ctx.effect?.(() => () => publishRow(undefined), 'yintxplugins: active row ledger')
  } catch {}

  /** 行的稳定标识：优先用 loader 给的 id，其次用实现名。 */
  const rowIdOf = (row) => {
    const id = row && typeof row.id === 'string' ? row.id.trim() : ''
    if (id !== '') return id
    const spec = row && typeof row.plugin === 'string' ? row.plugin.trim() : ''
    return spec !== '' ? spec : '(no-row)'
  }

  const sync = async () => {
    const row = config && typeof config === 'object' ? config : {}
    const spec = typeof row.plugin === 'string' && row.plugin.trim() !== '' ? row.plugin.trim() : ''
    const rowId = rowIdOf(row)

    if (spec === '' && (typeof row.fallback !== 'string' || row.fallback.trim() === '')) {
      publishRow(undefined)
      recordDegraded(rowId, 'config', new Error('外壳行的 config 里既没有 plugin 也没有 fallback，本行挂空'))
      return
    }
    if (mounted !== undefined && mounted.spec === spec && mounted.fallback === row.fallback) return

    if (mounted !== undefined) {
      const previous = mounted
      mounted = undefined
      try {
        await previous.dispose?.()
      } catch (error) {
        console.warn('[yintxplugins] 卸载上一个子插件失败：', error)
      }
    }

    publishRow(rowId)
    const loaded = await loadImpl(spec, row.fallback)
    if (!loaded.ok) {
      recordDegraded(rowId, loaded.stage, loaded.error)
      return
    }
    if (loaded.recovered) {
      console.warn(
        `[yintxplugins] ${spec || '(no spec)'} 说明符解析失败（${loaded.recovered.message ?? loaded.recovered}），已回退到 ${loaded.via}`,
      )
    }
    clearDegraded(rowId)

    const plugin = pluginShapeOf(loaded.module)
    if (plugin === null) {
      recordDegraded(rowId, 'shape', new Error('模块里没有可用的插件形状（应为函数或 { apply }）'))
      return
    }

    try {
      const fiber = ctx.plugin(plugin, implConfigOf(row))
      mounted = { spec, fallback: row.fallback, dispose: fiber?.dispose }
      Promise.resolve(fiber).then(
        () => {
          clearDegraded(rowId)
        },
        (error) => recordDegraded(rowId, 'start', error),
      )
    } catch (error) {
      recordDegraded(rowId, 'start', error)
    }
  }

  const schedule = () => {
    tail = tail.then(() =>
      sync().catch((error) => {
        console.error('[yintxplugins] 应用外壳行配置失败：', error)
      }),
    )
    return tail
  }

  try {
    ctx.on?.('loader/volatile-update', () => {
      void schedule()
    })
  } catch {}

  await schedule()
}

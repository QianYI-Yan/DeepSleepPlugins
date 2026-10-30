/**
 * dsh-plugin-open-folder —— 宿主半。
 *
 * 干两件事：
 *   1. 解析「某个插件包在磁盘上的真实目录」。profile 的 dependencies 里有三种写法，
 *      都要能还原到**源目录**（不是 node_modules 里那层壳）：
 *        link:<绝对路径>            → 直接就是源目录（本机 .local / 工作区里的插件）
 *        file:../../plugins/...     → junction 指向的仓库目录，realpath 还原到源
 *        git+/semver（真实安装）     → 只有 node_modules/<name> 这一份，realpath 即真身
 *   2. 提供路由给客户端半调用：
 *        GET  /plugin-open-folder/ping              探活 + 报告当前 profile/DSH_HOME
 *        GET  /plugin-open-folder/resolve?name=…    只解析路径，不打开
 *        POST /plugin-open-folder/open              { name, profile? } → 解析并打开
 *
 * 客户端半在官方插件详情页的 `plugins.detail.actions` 席位渲染「打开目录」按钮，
 * 点击后调 POST /plugin-open-folder/open。前端那边不碰文件系统，路径全在这里算。
 */
import { openFolder } from '../../lib/shared/open-dir.js'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-plugin-open-folder'

/** webServer 必装；connection 用于和官方插件同一道信任闸（拿不到就跳过检查）。 */
export const inject = ['webServer']

const DEMO_VERSION = '0.1.0'

/** npm 包名（含 scope）。挡掉 ../ 之类的路径穿越。 */
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

const ROUTE_PING = '/plugin-open-folder/ping'
const ROUTE_RESOLVE = '/plugin-open-folder/resolve'
const ROUTE_OPEN = '/plugin-open-folder/open'

// ── 路径解析 ──────────────────────────────────────────────────────────────

/** DSH_HOME（默认 ~/.dsh）。 */
export function dshHome() {
  return (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** cwd 是否落在 dir 里（两边都取真实路径，兼容 junction）。 */
function isInside(cwd, dir) {
  const a = realpathSafe(cwd)
  const b = realpathSafe(dir)
  if (a === b) return true
  const withSep = b.endsWith('\\') || b.endsWith('/') ? b : b + (process.platform === 'win32' ? '\\' : '/')
  return a.toLowerCase().startsWith(withSep.toLowerCase())
}

function realpathSafe(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * 猜当前跑的是哪个 profile：
 * 显式参数 → DSH_PROFILE → cwd 落在哪个 profile 目录里 → 只有一个 profile →
 * 常见名 web → desktop → default → 第一个 → 兜底 desktop。
 */
export function detectProfile(home = dshHome(), explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const fromEnv = (process.env.DSH_PROFILE ?? '').trim()
  if (fromEnv) return fromEnv
  const root = join(home, 'profiles')
  const names = readdirSafe(root).filter((entry) => existsSync(join(root, entry, 'package.json')))
  const cwd = resolve(process.cwd())
  for (const entry of names) {
    if (isInside(cwd, join(root, entry))) return entry
  }
  if (names.length === 1) return names[0]
  for (const preferred of ['web', 'desktop', 'default']) {
    if (names.includes(preferred)) return preferred
  }
  return names.length ? names[0] : 'desktop'
}

/** 读 profile 的 package.json（失败返回 null）。 */
export function readProfileManifest(profile, home = dshHome()) {
  const dir = join(home, 'profiles', profile)
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try {
    return { dir, file, manifest: JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return null
  }
}

/**
 * 解析包名 → 源目录。
 * @returns {{ path: string, source: 'link'|'file'|'plugins'|'node_modules', dependency: string|null, isLink: boolean } | null}
 */
export function resolvePluginDir(pkgName, profile, home = dshHome()) {
  if (typeof pkgName !== 'string' || !NAME_PATTERN.test(pkgName.trim())) return null
  const name = pkgName.trim()
  const segs = name.split('/')

  const profileInfo = readProfileManifest(profile, home)
  const profileDir = profileInfo?.dir ?? join(home, 'profiles', profile)
  const dependency = profileInfo?.manifest?.dependencies?.[name] ?? null

  /** @type {Array<{dir: string, source: 'link'|'file'|'plugins'|'node_modules'}>} */
  const candidates = []

  if (typeof dependency === 'string') {
    const spec = dependency.trim()
    if (spec.startsWith('link:')) {
      const raw = spec.slice('link:'.length).trim()
      candidates.push({ dir: isAbsolute(raw) ? raw : resolve(profileDir, raw), source: 'link' })
    } else if (spec.startsWith('file:')) {
      candidates.push({ dir: resolve(profileDir, spec.slice('file:'.length).trim()), source: 'file' })
    }
  }

  // 仓库布局（dsh-plugin-link-install 的两种布局都试一遍）
  candidates.push({ dir: join(home, 'plugins', profile, ...segs), source: 'plugins' })
  candidates.push({ dir: join(home, 'plugins', ...segs), source: 'plugins' })

  // 真实安装（npm / git）：node_modules 里的那份，realpath 会还原 junction/符号链接
  candidates.push({ dir: join(profileDir, 'node_modules', ...segs), source: 'node_modules' })

  for (const candidate of candidates) {
    try {
      if (!statSync(candidate.dir).isDirectory()) continue
      if (!existsSync(join(candidate.dir, 'package.json'))) continue
      const real = realpathSafe(candidate.dir)
      return {
        path: real,
        source: candidate.source,
        dependency,
        isLink: real !== candidate.dir,
      }
    } catch {
      continue
    }
  }
  return null
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function json(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

// ── 插件本体 ──────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const home = dshHome()
  const openCommand = typeof config.openCommand === 'function' ? config.openCommand : openFolder
  const requireTrust = config.requireTrust !== false

  const log = (message) => {
    try {
      console.log(`[${name}] ${message}`)
      ctx.logger?.info?.(`${name}: ${message}`)
    } catch {}
  }
  const warn = (message) => {
    try {
      console.warn(`[${name}] ${message}`)
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {}
  }

  const profile = detectProfile(home, config.profile)
  log(`已激活 v${DEMO_VERSION}（DSH_HOME=${home}，profile=${profile}）`)

  /** 过 dsh 的连接信任检查（官方插件同款）。服务缺失或抛错时放行。 */
  const rejected = (req) => {
    if (!requireTrust) return null
    try {
      const verdict = ctx.connection?.requestRejection?.(req)
      return verdict === undefined || verdict === null ? null : verdict
    } catch {
      return null
    }
  }

  /** 统一处理：解析 +（可选）打开。 */
  const handle = (res, { pkgName, open, requestedProfile }) => {
    if (typeof pkgName !== 'string' || pkgName.trim() === '') {
      json(res, 400, { ok: false, message: '缺少参数 name（插件包名）' })
      return
    }
    if (!NAME_PATTERN.test(pkgName.trim())) {
      json(res, 400, { ok: false, message: `包名不合法：${pkgName}` })
      return
    }
    const targetProfile = typeof requestedProfile === 'string' && requestedProfile.trim() !== ''
      ? requestedProfile.trim()
      : profile
    const found = resolvePluginDir(pkgName, targetProfile, home)
    if (!found) {
      json(res, 404, {
        ok: false,
        message: `找不到 ${pkgName} 的本地目录（profile=${targetProfile}）。若它是官方/内置插件，磁盘上没有独立目录。`,
      })
      return
    }
    if (!open) {
      json(res, 200, {
        ok: true,
        name: pkgName,
        path: found.path,
        source: found.source,
        dependency: found.dependency,
        profile: targetProfile,
        opened: false,
      })
      return
    }
    try {
      openCommand(found.path)
      log(`已打开 ${pkgName} → ${found.path}（来源 ${found.source}）`)
      json(res, 200, {
        ok: true,
        name: pkgName,
        path: found.path,
        source: found.source,
        dependency: found.dependency,
        profile: targetProfile,
        opened: true,
      })
    } catch (error) {
      json(res, 500, {
        ok: false,
        message: `打开失败：${error instanceof Error ? error.message : String(error)}`,
        path: found.path,
      })
    }
  }

  const routes = [
    {
      method: 'GET',
      path: ROUTE_PING,
      handler: (req, res) =>
        json(res, 200, {
          ok: true,
          plugin: name,
          version: DEMO_VERSION,
          dshHome: home,
          profile,
          requireTrust,
        }),
    },
    {
      method: 'GET',
      path: ROUTE_RESOLVE,
      handler: (req, res, url) =>
        handle(res, {
          pkgName: url?.searchParams?.get('name') ?? '',
          open: false,
          requestedProfile: url?.searchParams?.get('profile') ?? undefined,
        }),
    },
    {
      method: 'POST',
      path: ROUTE_OPEN,
      handler: async (req, res) => {
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          json(res, 400, { ok: false, message: '请求体读取失败' })
          return
        }
        if (body === null) {
          json(res, 400, { ok: false, message: '请求体必须是 JSON 对象' })
          return
        }
        handle(res, { pkgName: body.name, open: true, requestedProfile: body.profile })
      },
    },
  ]

  if (typeof ctx.webServer?.register !== 'function') {
    warn('webServer 不可用，路由没注册')
    return undefined
  }

  for (const route of routes) {
    try {
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: (req, res) => {
              const rejection = rejected(req)
              if (rejection !== null) {
                res.statusCode = rejection
                res.end()
                return
              }
              if (req.method !== route.method) {
                res.statusCode = 405
                res.setHeader('allow', route.method)
                res.end()
                return
              }
              let url
              try {
                url = new URL(req.url ?? route.path, 'http://127.0.0.1')
              } catch {
                url = undefined
              }
              try {
                void route.handler(req, res, url)
              } catch (error) {
                json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
              }
            },
          }),
        `${name}: ${route.method} ${route.path}`,
      )
      log(`已注册路由 ${route.method} ${route.path}`)
    } catch (error) {
      warn(`注册路由 ${route.method} ${route.path} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect?.(() => () => log('已卸载'))

  return { profile, home, resolve: (n, p = profile) => resolvePluginDir(n, p, home) }
}

// 供测试脚本直接调用（不影响 dsh 加载）
export { openFolder }

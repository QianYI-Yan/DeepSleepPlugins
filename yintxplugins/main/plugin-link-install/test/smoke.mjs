/**
 * dsh-plugin-link-install 宿主半自测。
 *
 * ⚠️ 只碰临时目录：所有 `home` 都指向 `os.tmpdir()` 下现造的假 DSH_HOME，绝不触碰真实的 `~/.dsh`。
 *
 * 要紧的三条保护：
 *   1. `rewriteToWarehouse` 只动**那一行**依赖的形态 —— 原有依赖与 bundles 一条都不能少。
 *   2. `copyDirectory` 遇到 junction 必须**跳过而不是跟进去** —— Windows 上 Node 把 junction
 *      报成普通目录，跟进去会无限递归、把磁盘写爆。
 *   3. 官方那次安装必须**等它真的写进 profile** 才动手（`awaitOfficialWrite`），写 profile 只能走
 *      原子写 + 官方那把锁 —— 直写会让宿主读到半截 JSON，起不来。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFileLockSync, writeFileAtomicSync } from '../atomic-write.js'

import {
  __internals,
  awaitOfficialWrite,
  copyDirectory,
  dependencySpec,
  dependencyTargetsCopy,
  dependencyTargetsDir,
  judgeWorkerOutput,
  normalizeDependencySpec,
  normalizePicked,
  pickSeed,
  pickWithNativeWorker,
  readDependency,
  readState,
  relinkNodeModulesToCopy,
  rewriteToWarehouse,
  stageCopy,
  writeState,
} from '../index.js'

let passed = 0
let failed = 0
const tempDirs = []

function check(title, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${title}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${title}\n      ${(error && error.message) || error}`)
  }
}

async function checkAsync(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${title}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${title}\n      ${(error && error.message) || error}`)
  }
}

const assert = {
  equal(actual, expected, note) {
    if (actual !== expected) {
      throw new Error(`${note ? `${note}：` : ''}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    }
  },
  ok(value, note) {
    if (!value) throw new Error(`${note ? `${note}：` : ''}期望为真，实际 ${JSON.stringify(value)}`)
  },
  deepEqual(actual, expected, note) {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) throw new Error(`${note ? `${note}：` : ''}期望 ${b}，实际 ${a}`)
  },
}

/** 造一个假 DSH_HOME：desktop profile（带一条「原有依赖」）+ 空的插件仓库。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'li-home-'))
  tempDirs.push(home)
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: { 'existing-plugin': '^1.0.0' },
        dsh: { profile: { bundles: ['existing-plugin'] } },
      },
      void 0,
      2,
    )}\n`,
  )
  mkdirSync(join(home, 'plugins', 'desktop'), { recursive: true })
  return home
}

/** 造一个假插件源目录。 */
function makeSource(name = 'demo-plugin', version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'li-src-'))
  tempDirs.push(root)
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version }, void 0, 2)}\n`)
  writeFileSync(join(dir, 'index.js'), 'export default {}\n')
  return dir
}

/** 造一个空临时目录（当「别的目录」用）。 */
function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// ── dependencySpec：需求要的那个形态 ──────────────────────────────────────

check('dependencySpec：写成 file:../../plugins/<profile>/<name>', () => {
  assert.equal(dependencySpec('demo-plugin', 'desktop'), 'file:../../plugins/desktop/demo-plugin')
})

check('dependencySpec：带作用域的包名照原样写', () => {
  assert.equal(dependencySpec('@someone/demo', 'desktop'), 'file:../../plugins/desktop/@someone/demo')
})

// ── 安全校验 ──────────────────────────────────────────────────────────────

check('isSafeName：拒绝路径穿越与非法字符', () => {
  const { isSafeName } = __internals
  assert.equal(isSafeName('demo-plugin'), true)
  assert.equal(isSafeName('@scope/demo'), true)
  assert.equal(isSafeName('../evil'), false)
  assert.equal(isSafeName('a/b/c'), false)
  assert.equal(isSafeName('has space'), false)
})

check('isSafeProfile：只接受单层安全名字', () => {
  const { isSafeProfile } = __internals
  assert.equal(isSafeProfile('desktop'), true)
  assert.equal(isSafeProfile('../evil'), false)
  assert.equal(isSafeProfile('a/b'), false)
})

check('isInside：同名前缀不算「在内部」', () => {
  const { isInside } = __internals
  assert.equal(isInside(join('C:\\', 'a', 'b', 'c'), join('C:\\', 'a', 'b')), true)
  assert.equal(isInside(join('C:\\', 'a', 'bc'), join('C:\\', 'a', 'b')), false, 'C:\\a\\bc 不在 C:\\a\\b 里')
})

// ── copyDirectory：junction 保护（真踩过坑） ──────────────────────────────

check('copyDirectory：跳过 .git 等版本控制目录', () => {
  const source = makeSource()
  mkdirSync(join(source, '.git'), { recursive: true })
  writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const target = join(makeDir('li-dst-'), 'out')
  const result = copyDirectory(source, target)
  assert.ok(!existsSync(join(target, '.git')), '.git 不该被复制')
  assert.ok(result.skipped >= 1, '要记一次跳过')
  assert.ok(existsSync(join(target, 'package.json')), '正常文件要复制')
})

check('copyDirectory：源里的 junction 一律不跟进去（防无限递归写爆磁盘）', () => {
  const source = makeSource()
  const loop = join(source, 'loop')
  try {
    symlinkSync(source, loop, 'junction')
  } catch {
    console.log('      （本环境不允许建 junction，跳过这条）')
    return
  }
  const target = join(makeDir('li-dst-'), 'out')
  const result = copyDirectory(source, target)
  assert.ok(!existsSync(join(target, 'loop')), 'junction 不该被复制成目录')
  assert.ok(result.files < 50, `复制的文件数应很少（实际 ${result.files}），不能把递归展开`)
})

// ── stageCopy ─────────────────────────────────────────────────────────────

check('stageCopy：profile 名不合法 → 拒绝', () => {
  const home = makeHome()
  const outcome = stageCopy({ source: makeSource(), profile: '../evil', home })
  assert.equal(outcome.ok, false)
  assert.ok(String(outcome.message).includes('profile 名不合法'))
})

check('stageCopy：找不到 profile → 拒绝', () => {
  const home = makeHome()
  const outcome = stageCopy({ source: makeSource(), profile: 'nope', home })
  assert.equal(outcome.ok, false)
  assert.ok(String(outcome.message).includes('找不到 profile'))
})

check('stageCopy：源目录没有 package.json → 拒绝', () => {
  const home = makeHome()
  assert.equal(stageCopy({ source: makeDir('li-empty-'), profile: 'desktop', home }).ok, false)
})

check('stageCopy：把插件仓库自己当源 → 拒绝（防自我复制）', () => {
  const home = makeHome()
  const target = join(home, 'plugins', 'desktop', 'demo-plugin')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name: 'demo-plugin', version: '1.0.0' })}\n`)
  const outcome = stageCopy({ source: target, profile: 'desktop', home })
  assert.equal(outcome.ok, false)
  assert.ok(String(outcome.message).includes('拒绝操作'))
})

check('stageCopy：正常路径 → 复制进插件仓库并回报 file: 依赖', () => {
  const home = makeHome()
  const outcome = stageCopy({ source: makeSource(), profile: 'desktop', home })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.name, 'demo-plugin')
  assert.equal(outcome.dependency, 'file:../../plugins/desktop/demo-plugin')
  assert.ok(existsSync(join(home, 'plugins', 'desktop', 'demo-plugin', 'package.json')), '该复制到位')
  assert.equal(outcome.restartRequired, true)
})

// ── 新链路：官方照常装，我们等它写完再复制副本 + 改写依赖形态 ──────────────

check('官方装本地路径会写 link:<源目录> —— 改写必须认得这种形态（这次安装的源目录）', () => {
  const home = makeHome()
  const source = 'D:\\Code\\DeepSeek\\某插件'
  const linkValue = `link:${source.replace(/\\/g, '/')}`
  seedDependency(home, 'demo-plugin', linkValue)
  assert.equal(dependencyTargetsDir(linkValue, source, { profile: 'desktop', home }), true, 'link: 指向源目录要认得出来')
  const outcome = normalizeDependencySpec({ name: 'demo-plugin', profile: 'desktop', home, from: source })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.changed, true, '指向这次安装的源目录 → 必须改写成目标形态')
  assert.equal(outcome.dependency, 'file:../../plugins/desktop/demo-plugin')
})

check('normalizeDependencySpec：没带 from 时，指向别处的 link: 一律不动', () => {
  const home = makeHome()
  seedDependency(home, 'demo-plugin', 'link:C:/somewhere/else')
  const outcome = normalizeDependencySpec({ name: 'demo-plugin', profile: 'desktop', home })
  assert.equal(outcome.changed, false)
  assert.ok(String(outcome.skipped).includes('未改动'))
})

await checkAsync('awaitOfficialWrite：官方把依赖写成 link:<源目录> 之后才放行', async () => {
  const home = makeHome()
  const source = 'D:\\Code\\DeepSeek\\某插件'
  const pending = awaitOfficialWrite({
    name: 'demo-plugin',
    source,
    profile: 'desktop',
    home,
    timeoutMs: 4000,
    pollMs: 20,
  })
  setTimeout(() => seedDependency(home, 'demo-plugin', `link:${source.replace(/\\/g, '/')}`), 80)
  const written = await pending
  assert.equal(written.ok, true, '官方写了之后必须放行')
  assert.equal(written.atSource, true, '要认出这是「官方写的源目录」形态')
})

await checkAsync('awaitOfficialWrite：官方那次没写成 → 超时如实回报（不假装成功）', async () => {
  const home = makeHome()
  const written = await awaitOfficialWrite({
    name: 'never-written',
    source: 'C:\\nope',
    profile: 'desktop',
    home,
    timeoutMs: 150,
    pollMs: 20,
  })
  assert.equal(written.ok, false)
  assert.ok(String(written.message).includes('没看到官方'))
})

check('relinkNodeModulesToCopy：官方指到源目录 → 改成指向副本', () => {
  const home = makeHome()
  const profileDir = join(home, 'profiles', 'desktop')
  const source = makeDir('li-src-')
  const copy = join(home, 'plugins', 'desktop', 'demo-plugin')
  mkdirSync(copy, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const linkPath = join(profileDir, 'node_modules', 'demo-plugin')
  symlinkSync(source, linkPath, 'junction')
  const outcome = relinkNodeModulesToCopy('demo-plugin', profileDir, copy, source)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.relinked, true)
  assert.equal(realpathSync.native(linkPath), realpathSync.native(copy), '链接必须指到副本')
})

check('relinkNodeModulesToCopy：指向别处一律放过（不碰别人的东西）', () => {
  const home = makeHome()
  const profileDir = join(home, 'profiles', 'desktop')
  const other = makeDir('li-other-')
  const copy = join(home, 'plugins', 'desktop', 'demo-plugin')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(copy, { recursive: true })
  const linkPath = join(profileDir, 'node_modules', 'demo-plugin')
  symlinkSync(other, linkPath, 'junction')
  const outcome = relinkNodeModulesToCopy('demo-plugin', profileDir, copy, 'C:\\not-this-one')
  assert.equal(outcome.ok, false)
  assert.equal(realpathSync.native(linkPath), realpathSync.native(other), '别人的链接必须原样不动')
})

check('rewriteToWarehouse：复制副本 + 把那一行改写成目标形态，一步到位', () => {
  const home = makeHome()
  const source = makeSource()
  seedDependency(home, 'demo-plugin', `link:${source.replace(/\\/g, '/')}`)
  const outcome = rewriteToWarehouse({ source, name: 'demo-plugin', profile: 'desktop', home })
  assert.equal(outcome.ok, true, outcome.message ?? '')
  assert.ok(outcome.copiedFiles >= 1, '副本要真的复制过去')
  assert.equal(outcome.rewritten, true, '那一行要被改写')
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['demo-plugin'], 'file:../../plugins/desktop/demo-plugin')
})

check('stageCopy 产出的 dependency 就是喂给官方的 spec（两处必须一致）', () => {
  const home = makeHome()
  const staged = stageCopy({ source: makeSource(), profile: 'desktop', home })
  assert.equal(staged.dependency, 'file:../../plugins/desktop/demo-plugin')
  assert.ok(
    !/^[A-Za-z]:/.test(staged.dependency.replace(/^file:/, '')),
    'spec 必须是相对形态，不能是绝对路径（那样 pnpm 会写成 link:C:/...）',
  )
})

// ── normalizeDependencySpec：把官方写入的形态改对（「改写入的内容」那一步） ──

/** 把 profile 里某个依赖改成给定值，模拟官方装完后的样子。 */
function seedDependency(home, name, value) {
  const path = join(home, 'profiles', 'desktop', 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.dependencies[name] = value
  writeFileSync(path, `${JSON.stringify(manifest, void 0, 2)}\n`)
  return path
}

check('normalizeDependencySpec：pnpm 写的反斜杠形态 → 改成正斜杠（实测 pnpm 真的写反斜杠）', () => {
  const home = makeHome()
  const path = seedDependency(home, 'demo-plugin', 'file:..\\..\\plugins\\desktop\\demo-plugin')
  const outcome = normalizeDependencySpec({ name: 'demo-plugin', profile: 'desktop', home })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.changed, true, '该改写')
  assert.equal(outcome.dependency, 'file:../../plugins/desktop/demo-plugin')
  const after = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(after.dependencies['demo-plugin'], 'file:../../plugins/desktop/demo-plugin', '文件里也要是正斜杠')
  assert.equal(after.dependencies['existing-plugin'], '^1.0.0', '别人的依赖不许被动')
})

check('normalizeDependencySpec：形态已经对了 → 不动文件', () => {
  const home = makeHome()
  seedDependency(home, 'demo-plugin', 'file:../../plugins/desktop/demo-plugin')
  const outcome = normalizeDependencySpec({ name: 'demo-plugin', profile: 'desktop', home })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.changed, false, '已正确就不该改')
})

check('normalizeDependencySpec：指向别处 → 跳过（不改坏别人的依赖）', () => {
  const home = makeHome()
  const path = seedDependency(home, 'demo-plugin', 'link:C:/somewhere/else')
  const outcome = normalizeDependencySpec({ name: 'demo-plugin', profile: 'desktop', home })
  assert.equal(outcome.changed, false, '不是同一条路径就不该改')
  assert.ok(outcome.skipped, '要留下跳过原因')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).dependencies['demo-plugin'], 'link:C:/somewhere/else', '原值要保住')
})

check('normalizeDependencySpec：pnpm 在 workspace 模式下写的**绝对路径** → 也要能改写成相对（实测形态）', () => {
  const home = makeHome()
  const target = join(home, 'plugins', 'desktop', 'demo-plugin')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), '{}')
  const path = seedDependency(home, 'demo-plugin', `file:${target.replace(/\\/g, '/')}`)
  const outcome = normalizeDependencySpec({ name: 'demo-plugin', profile: 'desktop', home })
  assert.equal(outcome.changed, true, '绝对路径指向同一份拷贝 → 必须认出来并改写成相对')
  assert.equal(outcome.dependency, 'file:../../plugins/desktop/demo-plugin')
  assert.equal(
    JSON.parse(readFileSync(path, 'utf8')).dependencies['demo-plugin'],
    'file:../../plugins/desktop/demo-plugin',
    '文件里要落成相对形态',
  )
})

check('normalizeDependencySpec：profile 里没有这一行 → ok:false（不抛）', () => {
  const home = makeHome()
  const outcome = normalizeDependencySpec({ name: 'never-installed', profile: 'desktop', home })
  assert.equal(outcome.ok, false)
  assert.ok(String(outcome.message).includes('没有'))
})

// ── dependencyTargetsCopy / readDependency：「这行依赖是不是指向插件仓库里那份拷贝」 ──

check('dependencyTargetsCopy：正斜杠 / 反斜杠 / 绝对路径 / link: 前缀都算同一份拷贝', () => {
  const home = makeHome()
  const absolute = join(home, 'plugins', 'desktop', 'demo-plugin').replace(/\\/g, '/')
  for (const value of [
    'file:../../plugins/desktop/demo-plugin',
    'file:..\\..\\plugins\\desktop\\demo-plugin',
    `file:${absolute}`,
    `link:${absolute}`,
  ]) {
    assert.equal(dependencyTargetsCopy(value, { name: 'demo-plugin', profile: 'desktop', home }), true, value)
  }
})

check('dependencyTargetsCopy：指向别处 / registry 版本号 / 空值 → 一律不认', () => {
  const home = makeHome()
  const options = { name: 'demo-plugin', profile: 'desktop', home }
  assert.equal(dependencyTargetsCopy('link:C:/somewhere/else', options), false)
  assert.equal(dependencyTargetsCopy('^1.2.3', options), false)
  assert.equal(dependencyTargetsCopy('git+https://github.com/x/y.git', options), false)
  assert.equal(dependencyTargetsCopy('', options), false)
  assert.equal(dependencyTargetsCopy(null, options), false)
})

check('readDependency：读得到就是原值，没有这一行就是 null', () => {
  const home = makeHome()
  assert.equal(readDependency({ name: 'demo-plugin', profile: 'desktop', home }), null)
  seedDependency(home, 'demo-plugin', 'file:../../plugins/desktop/demo-plugin')
  assert.equal(
    readDependency({ name: 'demo-plugin', profile: 'desktop', home }),
    'file:../../plugins/desktop/demo-plugin',
  )
})

// ── 选择器记忆（需求：用上次的路径，不要每次重置） ────────────────────────

check('writeState/readState：记忆能落盘、能读回', () => {
  const home = makeHome()
  assert.deepEqual(readState(home), {}, '一开始是空的')
  writeState({ lastPicked: 'C:\\somewhere' }, home)
  assert.equal(readState(home).lastPicked, 'C:\\somewhere')
})

check('pickSeed：输入框里有路径时优先用它', () => {
  const home = makeHome()
  const typed = makeDir('li-seed-')
  writeState({ lastPicked: 'C:\\nowhere' }, home)
  assert.equal(pickSeed({ initial: typed, home }), typed, '存在且合法的输入应优先')
})

check('pickSeed：没有输入时回落到上次记忆的目录', () => {
  const home = makeHome()
  const remembered = makeDir('li-remembered-')
  writeState({ lastPicked: remembered }, home)
  assert.equal(pickSeed({ initial: '', home }), remembered, '这就是「下次停在上次那个目录」')
})

check('normalizePicked：选中的是文件 → 归一到它所在的目录并记住', () => {
  const home = makeHome()
  const dir = makeDir('li-norm-')
  const file = join(dir, 'package.json')
  writeFileSync(file, '{}')
  const result = normalizePicked(file, home)
  assert.equal(result.dir, dir, '文件要归一到目录')
  assert.equal(result.pickedFile, file, '原文件路径要记下来')
  assert.equal(readState(home).lastPicked, dir, '记忆里存目录')
})

check('normalizePicked：选中的是目录 → 原样返回', () => {
  const home = makeHome()
  const dir = makeDir('li-norm2-')
  const result = normalizePicked(dir, home)
  assert.equal(result.dir, dir)
  assert.equal(result.pickedFile, null)
})

// ── 原子写与文件锁：profile 是多写者文件，直写会写出坏 JSON ─────────────────
//
// 回归保护：2026-10-10 实测宿主连续三次启动失败
// `readProfileManifest: Expected double-quoted property name in JSON at position 1080`
// —— 就是「我们直写 profile，官方/pnpm 同时在写」造成的。

check('writeFileAtomicSync：内容原子落地，且不残留 .tmp', () => {
  const dir = makeDir('li-atomic-')
  const file = join(dir, 'package.json')
  writeFileSync(file, '{"a":1}\n')
  writeFileAtomicSync(file, '{"b":2}\n')
  assert.equal(readFileSync(file, 'utf8'), '{"b":2}\n')
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
    '临时文件必须被 rename 掉，不留残渣',
  )
})

check('withFileLockSync：临界区内持锁、跑完释放（lock 文件不残留）', () => {
  const dir = makeDir('li-lock-')
  const file = join(dir, 'package.json')
  writeFileSync(file, '{}\n')
  let lockedInside = null
  const value = withFileLockSync(file, () => {
    lockedInside = existsSync(`${file}.lock`)
    return 42
  })
  assert.equal(value, 42)
  assert.equal(lockedInside, true, '临界区内必须持着锁')
  assert.equal(existsSync(`${file}.lock`), false, '跑完必须把锁删掉')
})

check('withFileLockSync：锁被别人拿着 → 等到超时后照进临界区（不让安装凭空失败）', () => {
  const dir = makeDir('li-lock2-')
  const file = join(dir, 'package.json')
  writeFileSync(file, '{}\n')
  // 记录的是「自己」的 pid → 不算死锁持有者，只能等
  writeFileSync(`${file}.lock`, `${process.pid}\n`)
  const started = Date.now()
  const value = withFileLockSync(file, () => 'done', { waitMs: 120, pollMs: 20 })
  assert.equal(value, 'done', '超时后仍要执行：原子写兜底，抛错等于安装凭空失败')
  assert.ok(Date.now() - started >= 100, '确实等过一段时间')
})

check('withFileLockSync：持有者进程已消失 → 立刻接管，不干等', () => {
  const dir = makeDir('li-lock3-')
  const file = join(dir, 'package.json')
  writeFileSync(file, '{}\n')
  writeFileSync(`${file}.lock`, '2147483646\n')
  const started = Date.now()
  const value = withFileLockSync(file, () => 'taken', { waitMs: 2000, pollMs: 20 })
  assert.equal(value, 'taken')
  assert.ok(Date.now() - started < 1500, '应当立刻接管，而不是等满 2 秒')
})

check('走完一次收尾之后 profile 清单永远能 JSON.parse（宿主启动的硬前提），且不留临时文件', () => {
  const home = makeHome()
  const source = makeSource()
  seedDependency(home, 'demo-plugin', `link:${source.replace(/\\/g, '/')}`)
  rewriteToWarehouse({ source, name: 'demo-plugin', profile: 'desktop', home })
  const dir = join(home, 'profiles', 'desktop')
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
    '不留临时文件',
  )
})

// ── 自带 Win32 选择器：官方那份结构上没有 SetFolder，能力必须自带 ──────────
//
// 回归保护：桌面端宿主是 `ELECTRON_RUN_AS_NODE=1` 起的（`require('electron')` = MODULE_NOT_FOUND，
// 已实测），所以唯一的「停在上次那个目录 + 真选 package.json」手段就是这个 koffi worker。

check('native-pick.cjs 在位，且驱动了官方没有的槽位（SetFolder 12 / SetFileName 15 / 文件模式过滤器）', () => {
  const workerPath = __internals.NATIVE_WORKER_PATH
  assert.equal(existsSync(workerPath), true, 'worker 必须在包内（宿主半按 URL 相对它定位）')
  const source = readFileSync(workerPath, 'utf8')
  assert.ok(/SLOT_SET_FOLDER\s*=\s*12/.test(source), 'SetFolder 是 IFileDialog 的第 12 个槽位')
  assert.ok(/SLOT_SET_FILENAME\s*=\s*15/.test(source), 'SetFileName 是第 15 个槽位')
  assert.ok(source.includes('SHCreateItemFromParsingName'), 'SetFolder 只吃 IShellItem，必须自己造')
  assert.ok(/FOS_FOLDER\s*=\s*104/.test(source), '文件夹模式沿用官方那组的数值')
  assert.ok(/FOS_FILE\s*=\s*8 \+ 64 \+ 4096/.test(source), '文件模式必须 FOS_FILEMUSTEXIST')
  assert.ok(source.includes('--mode') && source.includes('--seed'), 'argv 契约：模式 + 起始目录')
  assert.ok(source.includes('--probe'), '留了不弹窗的自检入口（验证 koffi/COM 链）')
  // 文件模式必须是那种「打开」窗口：过滤器按结构体传（写成 void* 时 koffi 不会编码，
  // 旧版就是这么静默失败的 —— 实测报 `spec is not a function`），并且默认落在 package.json 上
  assert.ok(source.includes('COMDLG_FILTERSPEC *specs'), 'SetFileTypes 的第三个参数必须按结构体声明')
  assert.ok(source.includes('pszSpec') && source.includes("'package.json'"), '要挂 package.json 过滤器')
  assert.ok(source.includes('setFileTypeIndex'), '默认选中 package.json 那一档，否则下拉停在「所有文件」')
})

await checkAsync('pickWithNativeWorker：非 Windows 直接返回 null（交给官方兜底）', async () => {
  if (process.platform === 'win32') return // 本机就是 Windows：真跑会弹窗，只在别的平台断言
  assert.equal(await pickWithNativeWorker({ seed: 'C:\\' }), null)
})

// ── worker 输出判定：决定「要不要回落官方选择器」——回落 = 用户看到第二个窗口 ──

check('judgeWorkerOutput：出现过 showing 却没有结果 → 绝不回落（不许再弹第二个窗口）', () => {
  const outcome = judgeWorkerOutput('DshPick:showing\n', { elapsedMs: 1200 })
  assert.equal(outcome.noFallback, true, '窗口弹过了就不能回落')
  assert.ok(String(outcome.reason).includes('没把结果交回来'))
})

check('judgeWorkerOutput：有结果 → 解析出路径', () => {
  const outcome = judgeWorkerOutput(
    'DshPick:showing\nDshPick:shown 0\nDshPick:result {"ok":true,"path":"D:\\\\x\\\\package.json","cancelled":false}\n',
  )
  assert.equal(outcome.path, 'D:\\x\\package.json')
  assert.equal(outcome.cancelled, false)
  assert.equal(outcome.problem, null)
})

check('judgeWorkerOutput：用户取消 → cancelled（当成取消，不当错误）', () => {
  const outcome = judgeWorkerOutput('DshPick:showing\nDshPick:result {"ok":true,"path":null,"cancelled":true}\n')
  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.path, null)
})

check('judgeWorkerOutput：跑完了但取不到路径 → 带回问题，且不回落', () => {
  const outcome = judgeWorkerOutput(
    'DshPick:showing\nDshPick:result {"ok":true,"path":null,"cancelled":false,"error":"取选中路径失败：HRESULT 0x80004005"}\n',
  )
  assert.equal(outcome.path, null)
  assert.ok(String(outcome.problem).includes('HRESULT'))
})

check('judgeWorkerOutput：koffi 拿不到 → 允许回落官方（这是唯一的回落理由）', () => {
  const outcome = judgeWorkerOutput('DshPick:result {"ok":false,"code":"KOFFI_UNAVAILABLE","error":"加载 koffi 失败"}\n')
  assert.equal(outcome.unavailable, true)
  assert.equal(outcome.noFallback, false)
})

check('judgeWorkerOutput：其它错误 → 不回落，把原因如实带回界面', () => {
  const outcome = judgeWorkerOutput('DshPick:result {"ok":false,"error":"Show 失败：HRESULT 0x80070005"}\n')
  assert.equal(outcome.unavailable, false)
  assert.equal(outcome.noFallback, true)
  assert.ok(String(outcome.reason).includes('Show 失败'))
})

check('judgeWorkerOutput：完全没输出／只有噪音 → null（这种才交给调用方回落）', () => {
  assert.equal(judgeWorkerOutput(''), null)
  assert.equal(judgeWorkerOutput('随便什么噪音\n'), null)
})

check('judgeWorkerOutput：噪音里夹着结果行也能认出来', () => {
  const outcome = judgeWorkerOutput(
    'koffi 警告\nDshPick:showing\n别的噪音\nDshPick:result {"ok":true,"path":"D:\\\\a","cancelled":false}\n尾巴\n',
  )
  assert.equal(outcome.path, 'D:\\a')
})

// ── 守住 worker 源码里两个踩过的坑 ──────────────────────────────────────────

check('native-pick.cjs：IShellItem 的 GetDisplayName 槽位必须在（漏了它＝选完之后又弹一个窗口）', () => {
  const source = readFileSync(__internals.NATIVE_WORKER_PATH, 'utf8')
  assert.ok(/SLOT_GET_DISPLAY_NAME\s*=\s*5/.test(source), 'IShellItem 的槽位 5 必须定义出来')
  assert.ok(/displayNameOf/.test(source), '取路径要共用 displayNameOf（探测与真实取结果同一段代码）')
  assert.ok(/createShellItem/.test(source), '探测模式也要能造 IShellItem，才能覆盖这条链')
})

check('native-pick.cjs 源码语法可解析（CLOSER_SOURCE 是模板串，一个反引号就能截断它）', () => {
  const source = readFileSync(__internals.NATIVE_WORKER_PATH, 'utf8')
  let failure = null
  try {
    // 只解析不执行：require 之类要真跑才会报，语法错误在这一步就会抛
    new Function(source)
  } catch (error) {
    failure = String(error?.message ?? error)
  }
  assert.equal(failure, null, failure === null ? '' : failure)
})

// ── 收尾 ──────────────────────────────────────────────────────────────────

for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

console.log(`\n${passed}/${passed + failed} 通过`)
process.exit(failed === 0 ? 0 : 1)

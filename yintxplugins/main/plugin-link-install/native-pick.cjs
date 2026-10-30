/**
 * Win32 原生选择器 worker —— koffi 直驱 `IFileOpenDialog`（COM），支持**起始目录**。
 *
 * 为什么要自己写这一份，而不是直接用官方的 `ctx.directoryPicker`：
 * 官方 `@deepseek-ai/dsh-host-directory-picker-native` 的 worker 只驱动了四个 vtable 槽位
 * （SetOptions / SetTitle / Show / GetResult），**结构上没有 `IFileDialog::SetFolder`（槽位 12）**
 * —— 所以官方选择器永远开在系统自己的 MRU 上，做不到「停在上次那个目录」；
 * 而且它写死了 `FOS_PICKFOLDERS`，**永远只能选目录**，选不了 package.json。
 * 用户为此提了四遍（「浏览本地目录还是没有记忆」「选 package.json 实际开的是选文件夹的」）。
 *
 * 本 worker 在官方那份的 COM 调用序列之上补两个槽位：
 *   SLOT_SET_FOLDER = 12   ← 起始目录（`SHCreateItemFromParsingName` 造 IShellItem）
 *   SLOT_SET_FILENAME = 15 ← 默认文件名（选 package.json 时预填）
 * 并按模式切换 `FOS_*` 与文件类型过滤：
 *   --mode folder → `FOS_PICKFOLDERS`：窗口里只显示文件夹
 *   --mode file   → `FOS_FILEMUSTEXIST` + `package.json` 过滤器：选文件
 *
 * 用法（由宿主半 spawn，stdout 回一行 JSON）：
 *   <electron|node> native-pick.cjs --mode folder|file --seed <目录> --title <标题>
 * 输出：`{"ok":true,"path":"…"}` / `{"ok":true,"path":null,"cancelled":true}` / `{"ok":false,"error":"…"}`
 *
 * 与官方同款取舍：**在独立子进程里阻塞模态 `Show`**，原生故障不会楔住宿主事件循环；
 * 官方那套「合成一次 Alt 按键把窗口顶到前台」「按 DPI 上下文逐级降级」也照抄
 * （后台宿主 spawn 的子进程没有前台权，不点一下 Alt 对话框不会激活）。
 */
'use strict'

const { createRequire } = require('node:module')
const { writeSync } = require('node:fs')
const { dirname, join } = require('node:path')

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { mode: 'folder', seed: '', title: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--mode') out.mode = argv[i + 1] === 'file' ? 'file' : 'folder'
    else if (flag === '--seed') out.seed = argv[i + 1] ?? ''
    else if (flag === '--title') out.title = argv[i + 1] ?? ''
  }
  return out
}

/**
 * koffi 是原生模块：它的 JS 入口在 DSH 的 asar 里，二进制在同级 `app.asar.unpacked`。
 * 本 worker 跑在插件目录下，**按包名解析不到** koffi，所以要显式以 DSH 自带的
 * `node_modules` 为解析基点 —— 基点从 `process.execPath`（DSH 的 Electron 二进制）推出来。
 * 推不出来（非桌面端）就返回 null，调用方回落到官方选择器。
 */
function loadKoffi() {
  const candidates = []
  const exeDir = dirname(process.execPath ?? '')
  if (exeDir) {
    candidates.push(join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules', '_dsh_base_.cjs'))
    candidates.push(join(exeDir, 'resources', 'app', 'node_modules', '_dsh_base_.cjs'))
  }
  const errors = []
  for (const base of candidates) {
    try {
      const koffi = createRequire(base)('koffi')
      koffiBaseUsed = base
      return koffi
    } catch (error) {
      errors.push(`${base}: ${error?.code ?? error?.message}`)
    }
  }
  // 最后再试一次「按包名解析」：万一插件被装在能解析到 koffi 的地方
  try {
    const koffi = require('koffi')
    koffiBaseUsed = __filename
    return koffi
  } catch (error) {
    errors.push(`koffi: ${error?.code ?? error?.message}`)
  }
  const message = `加载 koffi 失败（${errors.join(' | ')}）`
  const failure = new Error(message)
  failure.code = 'KOFFI_UNAVAILABLE'
  throw failure
}

/** 主线程用的是哪个基点加载到 koffi 的 —— `--selftest` 的关闭线程要照它再加载一次。 */
let koffiBaseUsed = __filename

/**
 * 关闭线程跑的那段代码（`worker_threads` + `eval`）：睡够之后枚举**主线程**的窗口
 * （`EnumThreadWindows` 接受任意线程 id）并给每个窗口发 `WM_CLOSE`。
 * Show 阻塞的是主线程，所以关闭动作必须由另一个线程做 —— 官方 host 也是这么干的。
 */
const CLOSER_SOURCE = `
const { workerData } = require('node:worker_threads')
const { createRequire } = require('node:module')
const { writeSync } = require('node:fs')
const WM_CLOSE = 16
const WM_KEYDOWN = 256
const WM_KEYUP = 257
const VK_RETURN = 13
// ⚠️ 上报必须走 writeSync(1, ...)：主线程此刻正阻塞在 Show 里，
// parentPort.postMessage 的回调在那边永远轮不到执行（之前整个 closer 就是这么"哑"掉的）
const report = (text) => { try { writeSync(1, 'DshPick:closer ' + text + '\\n') } catch {} }
const koffi = createRequire(workerData.koffiBase)('koffi')
const user32 = koffi.load('user32.dll')
const enumThreadWindows = user32.func('__stdcall', 'EnumThreadWindows', 'int', ['uint32', 'void *', 'intptr'])
const postMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
const isWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *'])
const getClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['void *', 'void *', 'int'])
// 函数指针类型只能定义一次（重名 koffi 会抛），而且必须用 koffi.proto + koffi.pointer：
// 直接给 koffi.register 一个裸类型字符串会报 Unexpected character '('
const enumProcType = koffi.pointer(koffi.proto('int __stdcall DshEnumProc(void *hwnd, intptr lparam)'))
const classNameOf = (hwnd) => {
  const buf = Buffer.alloc(128)
  const len = getClassNameW(hwnd, buf, 64)
  return len > 0 ? buf.toString('ucs2', 0, len * 2) : ''
}
const collect = () => {
  const windows = []
  const callback = koffi.register((hwnd) => {
    windows.push(hwnd)
    return 1
  }, enumProcType)
  enumThreadWindows(workerData.threadId, callback, 0)
  koffi.unregister(callback)
  return windows
}
/**
 * 只挑**可见的对话框窗口**：这个进程里有一堆 Electron 自己的隐藏窗口（实测一次枚举到 18 个），
 * 对它们发消息毫无意义。对话框的窗口类固定是 #32770。
 */
const dialogsOf = (windows) => windows.filter((hwnd) => isWindowVisible(hwnd) === 1 && classNameOf(hwnd) === '#32770')
/**
 * enter 模式：把回车**定向发给对话框本人**（WM_KEYDOWN / WM_KEYUP），等价于点「打开」。
 *
 * 为什么不用全局 keybd_event：那会把回车发给**当前前台窗口** —— 抢不到前台时就会打到
 * 用户正在用的窗口上（实测在前后台切换的瞬间时灵时不灵）。定向发消息既不需要前台，也不会外溢，
 * 所以这个线程里一个反引号都不敢用（CLOSER_SOURCE 本身就是模板字符串）。
 * 发完 1.5 秒再查一次：对话框还在就补一刀 WM_CLOSE，绝不让窗口挂着。
 */
setTimeout(() => {
  report('start threadId=' + workerData.threadId + ' mode=' + workerData.mode)
  let tries = 0
  const tick = () => {
    tries += 1
    let targets = []
    let total = 0
    try {
      const windows = collect()
      total = windows.length
      targets = dialogsOf(windows)
    } catch (error) {
      report('error ' + String((error && error.message) || error))
      return
    }
    report('tries=' + tries + ' windows=' + total + ' dialogs=' + targets.length)
    if (targets.length === 0) {
      if (tries < 6) {
        setTimeout(tick, 400)
        return
      }
      report('done nothing-to-do')
      return
    }
    if (workerData.mode === 'enter') {
      for (const hwnd of targets) {
        postMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0)
        postMessageW(hwnd, WM_KEYUP, VK_RETURN, 0)
      }
      report('sent-enter x' + targets.length)
      setTimeout(() => {
        const left = dialogsOf(collect())
        if (left.length > 0) {
          report('enter 没生效，兜底 WM_CLOSE')
          for (const hwnd of left) postMessageW(hwnd, WM_CLOSE, 0, 0)
        }
      }, 1500)
      return
    }
    for (const hwnd of targets) postMessageW(hwnd, WM_CLOSE, 0, 0)
    report('sent-close x' + targets.length)
  }
  tick()
}, workerData.ms)
`

// ── COM 常量 ────────────────────────────────────────────────────────────────

const COINIT_APARTMENTTHREADED = 2
const CLSCTX_INPROC_SERVER = 1
const SIGDN_FILESYSPATH = -2147123200
/** `FOS_NOCHANGEDIR | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM`（与官方那份同值）。 */
const FOS_FOLDER = 104
/** `FOS_NOCHANGEDIR | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST`：必须选到一个已存在的文件。 */
const FOS_FILE = 8 + 64 + 4096

/** `IFileOpenDialog` 的 vtable 槽位（Vista 起冻结的 ABI，取自官方同一份实现）。 */
const SLOT_RELEASE = 2
const SLOT_SHOW = 3
const SLOT_SET_FILE_TYPES = 4
const SLOT_SET_FILE_TYPE_INDEX = 5
const SLOT_SET_OPTIONS = 9
const SLOT_SET_FOLDER = 12
const SLOT_SET_FILENAME = 15
const SLOT_SET_TITLE = 17
const SLOT_GET_RESULT = 20
/**
 * `IShellItem` 的 `GetDisplayName` 槽位。
 *
 * ⚠️ 这个常量当初漏了定义，代价是：用户在文件窗口里**选完 package.json 之后**，
 * `resultPath()` 立刻抛 `SLOT_GET_DISPLAY_NAME is not defined` → worker 报失败 →
 * 宿主回落到官方目录选择器 → **又弹一个选文件夹的窗口**。就是被反馈的那个现象。
 */
const SLOT_GET_DISPLAY_NAME = 5

const DPI_AWARENESS_CONTEXTS = [-4, -3, -2]
const VK_MENU = 18
const KEYEVENTF_KEYUP = 2
const HRESULT_CANCELLED = -2147023673

// ── koffi 绑定 ──────────────────────────────────────────────────────────────

function guidBytes(text) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text)
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(match[1], 16), 0)
  bytes.writeUInt16LE(parseInt(match[2], 16), 4)
  bytes.writeUInt16LE(parseInt(match[3], 16), 6)
  Buffer.from(match[4] + match[5], 'hex').copy(bytes, 8)
  return bytes
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7')
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960')
const IID_ISHELL_ITEM = guidBytes('43826d1e-e718-42ee-bc55-a1e261c37bfe')

/** 把一段 UTF-16 地址解成 JS 字符串（koffi 的 `str16` 参数要的是「指向字符串的指针」）。 */
function readUtf16(koffi, address, pointerSize) {
  const pointer = Buffer.alloc(8)
  pointer.writeBigUInt64LE(BigInt(address))
  return koffi.decode(pointer.subarray(0, pointerSize), 'str16')
}

function loadBindings(koffi) {
  // 先注册结构体：下面 `protoSetFileTypes` 的签名要按名字引用它（koffi 不允许重复定义同名 struct）
  filterSpecOf(koffi)
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const shell32 = koffi.load('shell32.dll')
  const pointerSize = koffi.sizeof('void *')

  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [
    'void *',
    'void *',
    'uint32',
    'void *',
    'void *',
  ])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', [])
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr'])
  /** 把一个路径变成 `IShellItem` —— `IFileDialog::SetFolder` 只吃这个。 */
  const shCreateItemFromParsingName = shell32.func('__stdcall', 'SHCreateItemFromParsingName', 'int32', [
    'str16',
    'void *',
    'void *',
    'void *',
  ])

  const protoShow = koffi.proto('int32 __stdcall DshDialogShow(void *self, void *owner)')
  const protoSetOptions = koffi.proto('int32 __stdcall DshDialogSetOptions(void *self, uint32 options)')
  const protoSetTitle = koffi.proto('int32 __stdcall DshDialogSetTitle(void *self, str16 title)')
  const protoSetFolder = koffi.proto('int32 __stdcall DshDialogSetFolder(void *self, void *item)')
  const protoSetFileName = koffi.proto('int32 __stdcall DshDialogSetFileName(void *self, str16 name)')
  const protoSetFileTypes = koffi.proto(
    'int32 __stdcall DshDialogSetFileTypes(void *self, uint32 count, COMDLG_FILTERSPEC *specs)',
  )
  const protoSetFileTypeIndex = koffi.proto('int32 __stdcall DshDialogSetFileTypeIndex(void *self, uint32 index)')
  const protoGetResult = koffi.proto('int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)')
  const protoGetDisplayName = koffi.proto(
    'int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)',
  )
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)')

  /** 把 COM 对象 `self` 的第 `slot` 个 vtable 槽位绑成一个可调用函数。 */
  const method = (self, slot, proto) => {
    const vtable = koffi.decode(self, 'void *')
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *')
    return (...args) => koffi.call(fn, proto, self, ...args)
  }

  /** 取 `IShellItem` 的文件系统路径（`SIGDN_FILESYSPATH`）—— 对话框取结果与探测模式共用这一段。 */
  const displayNameOf = (item) => {
    const nameOut = [null]
    const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut)
    if (gotName < 0) return { hr: gotName }
    const path = readUtf16(koffi, nameOut[0], pointerSize)
    coTaskMemFree(nameOut[0])
    return { hr: gotName, path }
  }

  return {
    pointerSize,
    setThreadDpiAwareness: () => {
      let setContext
      try {
        setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr'])
      } catch {
        return
      }
      for (const context of DPI_AWARENESS_CONTEXTS) if (setContext(context) !== null) return
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED),
    coUninitialize: () => coUninitialize(),
    currentThreadId: () => getCurrentThreadId(),
    pressAltForForeground: () => {
      keybdEvent(VK_MENU, 0, 0, 0)
      keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    },
    createDialog: () => {
      const out = Buffer.alloc(pointerSize)
      const created = coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, out)
      if (created < 0) throw new Error(`CoCreateInstance(FileOpenDialog) 失败：HRESULT 0x${(created >>> 0).toString(16)}`)
      const dialog = koffi.decode(out, 'void *')
      return {
        setOptions: (options) => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
        setTitle: (title) => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
        setName: (name) => method(dialog, SLOT_SET_FILENAME, protoSetFileName)(name),
        setFileTypes: (specs) => method(dialog, SLOT_SET_FILE_TYPES, protoSetFileTypes)(specs.length, specs),
        setFileTypeIndex: (index) => method(dialog, SLOT_SET_FILE_TYPE_INDEX, protoSetFileTypeIndex)(index),
        /** 起始目录：只喂已存在的目录，喂错也只是「没定位」，不该让整次选择失败。 */
        setFolder: (dir) => {
          let item = null
          try {
            const out = Buffer.alloc(pointerSize)
            const created = shCreateItemFromParsingName(dir, null, IID_ISHELL_ITEM, out)
            if (created < 0) return { ok: false, hr: created }
            item = koffi.decode(out, 'void *')
            const hr = method(dialog, SLOT_SET_FOLDER, protoSetFolder)(item)
            return { ok: hr >= 0, hr }
          } catch (error) {
            return { ok: false, thrown: String(error?.message ?? error) }
          } finally {
            if (item !== null) {
              try {
                method(item, SLOT_RELEASE, protoRelease)()
              } catch {
                /* 释放失败不影响结果 */
              }
            }
          }
        },
        show: () => method(dialog, SLOT_SHOW, protoShow)(null),
        resultPath: () => {
          const itemOut = [null]
          const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut)
          if (gotItem < 0) return { hr: gotItem }
          const item = itemOut[0]
          try {
            return displayNameOf(item)
          } finally {
            method(item, SLOT_RELEASE, protoRelease)()
          }
        },
        release: () => {
          method(dialog, SLOT_RELEASE, protoRelease)()
        },
      }
    },
    /**
     * 从一个路径造 `IShellItem` —— 探测模式用它验证「IShellItem → GetDisplayName」这条链
     * （`SLOT_GET_DISPLAY_NAME` 那个槽位常量漏掉时，正是这一步在真实选择里抛错）。
     */
    createShellItem: (path) => {
      const out = Buffer.alloc(pointerSize)
      const created = shCreateItemFromParsingName(path, null, IID_ISHELL_ITEM, out)
      if (created < 0) throw new Error(`SHCreateItemFromParsingName(${path}) 失败：0x${(created >>> 0).toString(16)}`)
      return koffi.decode(out, 'void *')
    },
    displayNameOf,
    releaseObject: (object) => method(object, SLOT_RELEASE, protoRelease)(),
  }
}

function check(hr, what) {
  if (hr < 0) throw new Error(`${what} 失败：HRESULT 0x${(hr >>> 0).toString(16)}`)
  return hr
}

/**
 * 跑一次模态选择：DPI → STA → 建对话框 → SetOptions/SetTitle/SetFolder/SetFileName → Show → 取结果。
 * 任何一步失败都抛出，由调用方转成 stdout 上的 JSON。
 */
/**
 * `COMDLG_FILTERSPEC` 结构体**只能定义一次** —— koffi 对重名 struct 会抛
 * `Duplicate type name`，而每次调用都 `koffi.struct(...)` 正好会踩到（旧版就是这么被
 * try/catch 静默吃掉的，结果是文件对话框里根本没有 package.json 过滤器）。所以缓存起来。
 */
let filterSpecStruct = null
function filterSpecOf(koffi) {
  if (filterSpecStruct === null) {
    filterSpecStruct = koffi.struct('COMDLG_FILTERSPEC', { pszName: 'str16', pszSpec: 'str16' })
  }
  return filterSpecStruct
}

/**
 * 文件模式该有的样子（用户给的那张「打开」窗口就是它）：
 *   · `FOS_FILEMUSTEXIST` —— 必须选到一个真实存在的文件；
 *   · 类型下拉：`package.json` / `所有文件`，并把 `package.json` 设为默认项（slot 5）；
 *   · 文件名框预填 `package.json`（slot 15），配合起始目录就能直接看到它。
 * 过滤器设不上也**不该让整次选择失败**（那只是外观），所以单独 try 住。
 */
function configureFileMode(koffi, dialog) {
  let filters = { applied: false }
  try {
    filterSpecOf(koffi) // 确保结构体已注册（proto 的签名按名字引用它）
    // koffi 认的是「结构体类型的数组」：直接给普通对象数组，它会按 COMDLG_FILTERSPEC 编码
    const specs = [
      { pszName: 'package.json', pszSpec: 'package.json' },
      { pszName: '所有文件', pszSpec: '*' },
    ]
    const configured = dialog.setFileTypes(specs)
    const indexed = configured >= 0 ? dialog.setFileTypeIndex(1) : -1
    filters = { applied: configured >= 0, setFileTypes: configured, setFileTypeIndex: indexed }
  } catch (error) {
    filters = { applied: false, error: String(error?.message ?? error) }
  }
  check(dialog.setName('package.json'), 'SetFileName')
  return filters
}

/**
 * 跑一次模态选择：DPI → STA → 建对话框 → SetOptions/SetTitle（+ 文件模式三件套）→ SetFolder
 * → Show → 取结果。
 *
 * **每一步都把 HRESULT 记下来**，而且「取不到路径」**不再抛**：窗口已经弹过了，这时候抛错会让
 * 宿主以为 worker 没起来、于是回落到官方选择器 —— 用户就会看到**第二个窗口**（选完 package.json
 * 之后又冒出一个选文件夹的窗口，就是这么来的）。现在改成：只要跑到了 Show 之后，就一定给出一个
 * 带 `ok:true` 的结果（用 `error` 字段说明哪里没成），宿主据此**绝不回落**。
 */
function runDialog(koffi, bindings, options) {
  const diagnostics = { show: null, result: null }
  bindings.setThreadDpiAwareness()
  check(bindings.coInitializeSta(), 'CoInitializeEx')
  try {
    const dialog = bindings.createDialog()
    try {
      const wantFile = options.mode === 'file'
      check(dialog.setOptions(wantFile ? FOS_FILE : FOS_FOLDER), 'SetOptions')
      if (options.title) check(dialog.setTitle(options.title), 'SetTitle')
      const filters = wantFile ? configureFileMode(koffi, dialog) : null
      if (options.seed) dialog.setFolder(options.seed)
      // 窗口马上要弹出来：先报一声，宿主据此认定「这个 worker 已经弹过窗口，绝不再回落弹第二个」
      if (typeof options.onShowing === 'function') options.onShowing(bindings.currentThreadId())
      bindings.pressAltForForeground()
      const shown = dialog.show()
      diagnostics.show = shown
      if (typeof options.onShown === 'function') options.onShown(shown)
      if (shown === HRESULT_CANCELLED) return { path: null, cancelled: true, filters, diagnostics }
      if (shown < 0) {
        return {
          path: null,
          cancelled: false,
          filters,
          diagnostics,
          error: `Show 失败：HRESULT 0x${(shown >>> 0).toString(16)}`,
        }
      }
      const result = dialog.resultPath()
      diagnostics.result = result.hr
      if (result.hr < 0 || typeof result.path !== 'string' || result.path === '') {
        return {
          path: null,
          cancelled: false,
          filters,
          diagnostics,
          error: `取选中路径失败：HRESULT 0x${(Number(result.hr) >>> 0).toString(16)}`,
        }
      }
      return { path: result.path, cancelled: false, filters, diagnostics }
    } finally {
      dialog.release()
    }
  } finally {
    bindings.coUninitialize()
  }
}

/** 同步写一行到 stdout —— `process.stdout.write` 是异步的，紧跟 `process.exit()` 会丢数据。 */
function writeLine(text) {
  try {
    writeSync(1, `${text}\n`)
  } catch {
    /* stdout 不可用就算了 */
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  let outcome
  try {
    const koffi = loadKoffi()
    const bindings = loadBindings(koffi)
    outcome = {
      ok: true,
      ...runDialog(koffi, bindings, {
        ...options,
        onShowing: () => {
          writeLine(`DshPick:boot ${Math.round(process.uptime() * 1000)}`)
          writeLine('DshPick:showing')
        },
        onShown: (hr) => writeLine(`DshPick:shown ${hr}`),
      }),
    }
  } catch (error) {
    outcome = { ok: false, error: String(error?.message ?? error), code: error?.code ?? null }
  }
  // 结果行带标记：宿主按标记取，不再靠「stdout 的最后一行」（koffi/Electron 的噪音会混进来）
  writeLine(`DshPick:result ${JSON.stringify(outcome)}`)
  // 主动退出：COM/koffi 留下的句柄会把事件循环吊住，宿主就永远等不到 close
  process.exit(0)
}

/**
 * `--selftest`：把窗口弹出来，再由**另一个线程**（`worker_threads`）在 `--close-after=<ms>` 之后
 * 给它发 `WM_CLOSE`，用来验证「Show → 返回 → 写出结果 → 进程退出」这条链是不是通的。
 * 只闪一下就自己关，不需要人点。
 */
function selfTest() {
  const options = parseArgs(process.argv.slice(2))
  const arg = process.argv.find((item) => item.startsWith('--close-after='))
  const ms = Number(arg ? arg.split('=')[1] : 1500) || 1500
  const { Worker } = require('node:worker_threads')
  let closer = null
  let outcome
  try {
    const koffi = loadKoffi()
    const bindings = loadBindings(koffi)
    outcome = {
      ok: true,
      selfTest: true,
      ...runDialog(koffi, bindings, {
        mode: options.mode === 'file' ? 'file' : 'folder',
        title: options.title || 'DSH 选择器自测（会自动关闭）',
        ...(options.seed ? { seed: options.seed } : {}),
        onShowing: (threadId) => {
          writeLine(`DshPick:boot ${Math.round(process.uptime() * 1000)}`)
          writeLine('DshPick:showing')
          closer = new Worker(CLOSER_SOURCE, {
            eval: true,
            workerData: {
              threadId,
              ms,
              koffiBase: koffiBaseUsed,
              mode: process.argv.includes('--press-enter') ? 'enter' : 'close',
            },
          })
          closer.on('error', (error) => writeLine(`DshPick:closer-error ${String(error?.message ?? error)}`))
        },
        onShown: (hr) => writeLine(`DshPick:shown ${hr}`),
      }),
    }
  } catch (error) {
    outcome = { ok: false, selfTest: true, error: String(error?.message ?? error), code: error?.code ?? null }
  }
  writeLine(`DshPick:result ${JSON.stringify(outcome)}`)
  if (closer) void closer.terminate()
  process.exit(0)
}

// 自测入口：`--probe` 只建 COM 对象、不弹窗，用来验证 koffi/COM 调用链本身没问题
if (process.argv.includes('--selftest')) {
  selfTest()
} else if (process.argv.includes('--probe')) {
  try {
    const koffi = loadKoffi()
    const bindings = loadBindings(koffi)
    bindings.setThreadDpiAwareness()
    check(bindings.coInitializeSta(), 'CoInitializeEx')
    const dialog = bindings.createDialog()
    const options = dialog.setOptions(FOS_FOLDER)
    const fileOptions = dialog.setOptions(FOS_FILE)
    const folder = process.argv.includes('--with-seed')
      ? dialog.setFolder(process.env.USERPROFILE ?? 'C:\\')
      : { ok: null, skipped: true }
    // SetTitle（17）/ SetFolder（12）/ SetFileTypes（4）/ SetFileTypeIndex（5）/ SetFileName（15）
    // 的槽位必须真实存在：返回负值就是槽位号或参数形状错了
    const title = dialog.setTitle('探测用标题')
    const fileMode = configureFileMode(koffi, dialog)
    dialog.release()
    // IShellItem → GetDisplayName 的整条链：真实选择里的「取选中路径」走的就是它
    // （槽位常量漏掉时，这一步必然抛错 —— 探测必须覆盖到）
    let displayName = null
    try {
      const item = bindings.createShellItem(process.env.USERPROFILE ?? 'C:\\')
      displayName = bindings.displayNameOf(item)
      bindings.releaseObject(item)
    } catch (error) {
      displayName = { error: String(error?.message ?? error) }
    }
    bindings.coUninitialize()
    writeLine(
      `DshPick:result ${JSON.stringify({
        ok: true,
        probe: true,
        setOptions: options,
        setFileOptions: fileOptions,
        setTitle: title,
        setFolder: folder,
        fileMode,
        displayName,
      })}`,
    )
  } catch (error) {
    writeLine(`DshPick:result ${JSON.stringify({ ok: false, probe: true, error: String(error?.message ?? error) })}`)
    process.exit(1)
  }
  process.exit(0)
} else {
  main()
}

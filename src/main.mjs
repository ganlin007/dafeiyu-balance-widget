// main.mjs — 桌面端主进程。
//
// 结构：
//   · mini 宿主 + 未改动的上游插件   → 提供全部 /dsh-whale/* 接口（见 src/host/）
//   · 自定义协议 dshw://app/         → 渲染层页面与插件同源（localStorage 稳定，不占端口）
//   · 透明置顶悬浮窗                 → 铺满工作区 + 鼠标穿透命中测试（见 src/host/shell.mjs）
//   · DSH 联动                       → 检测 DSH 是否在跑（见 src/dsh/）
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, protocol, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startPluginHost, resolveDshHome } from './host/plugin-host.mjs'
import { createDshLink } from './dsh/dsh-link.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const VENDOR_ASSETS = path.join(ROOT, 'vendor', 'dsh-whale', 'assets')
const SELFTEST = process.argv.includes('--selftest')
const SCREENCHECK = process.argv.includes('--screencheck')
const SELFTEST_OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(ROOT, 'selftest.png')

// 任务结束音等提示音不是手势触发的，必须放开自动播放限制（与 DSH 桌面端同类处理）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// 音频改在浏览器进程内跑：--no-sandbox 下独立的 Audio Service 会周期性崩溃
//（日志里能看到 child-process-gone: audio.mojom.AudioService crashed），连点触发音效时尤其明显。
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess')

// 注册 AppUserModelID：否则 Windows 通知/托盘气泡的标题会显示成默认的 "electron.app.<名字>"
try { app.setAppUserModelId('com.meteornox.dsh.whale.desktop') } catch (err) {}

// 用户配置里可以钉死渲染模式（避免每次都靠命令行参数 / 自动降级）：
//   "rendererMode": "auto"（默认）| "normal" | "safe"（软件渲染）| "single-process"（不创建子进程）
//
// ⚠️ 这段必须在 app ready **之前** 跑（要赶在窗口创建前追加 Chromium 开关），
//    而 ready 之前 `app.getPath('userData')` 未必等于最终目录（实测它没指到 productName 目录），
//    所以这里按 package.json 的 productName 自己拼，并与 ready 之后的路径保持一致。
function userDataDir() {
  const appdata = process.env.APPDATA || ''
  let productName = ''
  let pkgName = ''
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    productName = String(pkg.productName || '')
    pkgName = String(pkg.name || '')
  } catch (err) {}
  const cands = []
  if (appdata && productName) cands.push(path.join(appdata, productName))
  try { const p = app.getPath('userData'); if (p) cands.push(p) } catch (err) {}
  if (appdata && pkgName) cands.push(path.join(appdata, pkgName))
  const unique = [...new Set(cands.filter(Boolean))]
  for (const d of unique) { try { if (fs.existsSync(d)) return d } catch (err) {} }
  return unique[0] || path.join(appdata || '.', productName || pkgName || 'dsh-whale-desktop')
}
const USER_DATA_DIR = userDataDir()
function readUserConfigSync() {
  // 注意剥掉 UTF-8 BOM：记事本 / PowerShell 写出来的 JSON 常带 BOM，JSON.parse 会直接抛错
  try {
    const raw = fs.readFileSync(path.join(USER_DATA_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) || {}
  } catch (err) { return {} }
}
const USER_CONFIG = readUserConfigSync()
const FORCED_MODE = String(USER_CONFIG.rendererMode || process.env.DSHW_RENDERER_MODE || 'auto').toLowerCase()
const MODE_LABEL = { auto: '自动', normal: '硬件渲染', 'no-sandbox': '无渲染沙箱', safe: '软件渲染', 'single-process': '单进程' }

// 降级级别（实测：Chromium 自带的渲染沙箱在某些受限环境 / 安全软件的主动防御下会 launch-failed，
// 加 --no-sandbox 立刻就正常了，所以「关渲染沙箱」是第一级，也是最有效的一级）：
//   0 正常：Chromium 渲染沙箱 + 硬件渲染
//   1 关 Chromium 渲染沙箱（--no-sandbox）
//   2 再关 GPU（软件渲染）
//   3 再单进程（完全不创建子进程）
const renderFailedMarker = () => path.join(USER_DATA_DIR, '.renderer-launch-failed')
function readSafeStage() {
  try {
    const n = Number(String(fs.readFileSync(renderFailedMarker(), 'utf8')).trim())
    return Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : 1
  } catch (err) { return 0 }
}
function writeSafeStage(n) {
  try {
    fs.mkdirSync(path.dirname(renderFailedMarker()), { recursive: true })
    fs.writeFileSync(renderFailedMarker(), String(Math.min(3, Math.max(0, n))))
  } catch (err) {}
}
const SAFE_STAGE = FORCED_MODE === 'single-process' ? 3
  : FORCED_MODE === 'safe' ? 2
    : FORCED_MODE === 'no-sandbox' ? 1
      : FORCED_MODE === 'normal' ? 0
        : readSafeStage()
if (SAFE_STAGE >= 1) app.commandLine.appendSwitch('no-sandbox')
if (SAFE_STAGE >= 2) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}
if (SAFE_STAGE >= 3) {
  app.commandLine.appendSwitch('single-process')
  app.commandLine.appendSwitch('in-process-gpu')
}

// 自定义协议必须在 ready 之前声明为标准 + 安全，renderer 里才有 localStorage / fetch 语义
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dshw',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false },
  },
])

// ---------- 配置 ----------
const configFile = () => path.join(USER_DATA_DIR, 'config.json')
function readConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) || {}
  } catch (err) { return {} }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  try { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(next, null, 2)) } catch (err) {}
  return next
}

// ---------- 日志落盘 ----------
// 桌面端出问题时用户看不到控制台，所以把关键日志同时写进 userData/whale-desktop.log。
function logFile() { return path.join(USER_DATA_DIR, 'whale-desktop.log') }
const nativeLog = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) }
function installFileLogger() {
  const write = (level, args) => {
    try {
      const line = `[${new Date().toISOString()}] [${level}] ` + args.map((a) => {
        if (a instanceof Error) return a.stack || a.message
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch (err) { return String(a) }
      }).join(' ') + '\n'
      const file = logFile()
      try { if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.rmSync(file) } catch (err) {}
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line)
    } catch (err) {}
  }
  for (const level of ['log', 'warn', 'error']) {
    const orig = nativeLog[level]
    console[level] = (...args) => { orig(...args); write(level, args) }
  }
  process.on('uncaughtException', (err) => { nativeLog.error('[main] 未捕获异常：', err); write('error', ['未捕获异常：', err]) })
  process.on('unhandledRejection', (err) => { nativeLog.error('[main] 未处理的 Promise 拒绝：', err); write('error', ['未处理的 Promise 拒绝：', err]) })
}

let pluginHost = null
let dshLink = null
let win = null
let tray = null
let quitting = false
let shellLoaded = false
let httpFallback = false
let httpBase = ''
// 鼠标穿透：默认开（指针不在挂件上时点击穿到桌面）。
// ⚠️ 窗口刻意**不铺满全屏**：全屏透明置顶窗在 Windows 上合成开销很大（实测卡到鼠标都动不了），
//    而且一旦穿透判定出问题会把整块桌面都吃掉。现在只在工作区右下角占一块，风险与开销都可控。
let clickThrough = USER_CONFIG.clickThrough !== false
// 窗口范围：pet = 只有鲸鱼那么大的一块（默认，BongoCat 式：**拖鲸鱼就是移动窗口**）；
//          corner = 右下一大块；full = 整个工作区（⚠️ 全屏透明窗实测切到可交互时会整屏变黑，别用）
let windowMode = String(USER_CONFIG.windowMode || 'pet').toLowerCase()
// 自动贴边：拖完窗口后吸附到屏幕边缘（QQ 企鹅那种手感）
let autoSnap = USER_CONFIG.autoSnap !== false
// 挂件窗口上次的位置（拖动把手拖动后持久化）
let petPos = USER_CONFIG.petPos && Number.isFinite(USER_CONFIG.petPos.x) && Number.isFinite(USER_CONFIG.petPos.y)
  ? { x: USER_CONFIG.petPos.x, y: USER_CONFIG.petPos.y }
  : null
// 总在最前（挂件菜单里也有一行开关）
let alwaysOnTop = USER_CONFIG.alwaysOnTop !== false
function applyTopmost(v) {
  alwaysOnTop = !!v
  writeConfig({ alwaysOnTop })
  try { if (win) win.setAlwaysOnTop(alwaysOnTop, 'floating') } catch (err) {}
}

/**
 * 重申「总在最前」。
 * ⚠️ 实测：Electron 每次切换 setIgnoreMouseEvents（鼠标进出鲸鱼时一直在切）都会重写 GWL_EXSTYLE，
 *    把 WS_EX_TOPMOST 位一起抹掉 —— 表现就是"点了浏览器它就被压到下面去了"。
 *    所以只要开着置顶，就在关键时刻主动重申一次（代价极小：一次 SetWindowPos）。
 */
function assertTopmost() {
  if (!win || SELFTEST || !alwaysOnTop) return
  try { win.setAlwaysOnTop(true, 'floating') } catch (err) {}
}
const SHELL_MAX_W = 1200
const SHELL_MAX_H = 900
// 「宠物窗口」尺寸：鲸鱼本体最大 625px，菜单/设置面板约 330×430，所以给一块能容下它们的区域
const PET_W = 560
const PET_H = 640
const SHELL_MARGIN = 16
const WINDOW_MODE_LABEL = { pet: '只占一块（推荐）', corner: '右下一大块', full: '整个工作区' }

/** 挂件窗口的初始区域：默认右下角那一块（尺寸固定）。 */
function shellBounds() {
  const { workArea } = currentDisplay()
  const { w, h } = fixedPetSize()
  let x = workArea.x + Math.max(0, workArea.width - w - SHELL_MARGIN)
  let y = workArea.y + Math.max(0, workArea.height - h - SHELL_MARGIN)
  if (petPos) {
    x = Math.min(Math.max(workArea.x, petPos.x), workArea.x + Math.max(0, workArea.width - w))
    y = Math.min(Math.max(workArea.y, petPos.y), workArea.y + Math.max(0, workArea.height - h))
  }
  return { x, y, width: w, height: h }
}

function applyMouseMode() {
  if (!win || SELFTEST) return
  try {
    if (clickThrough) win.setIgnoreMouseEvents(true, { forward: true })
    else win.setIgnoreMouseEvents(false)
  } catch (err) {}
  assertTopmost() // setIgnoreMouseEvents 会抹掉 TOPMOST 位，紧跟一次重申
}
let moveTimer = null
let moveGuard = false
let windowDragging = false   // 渲染层正在拖鲸鱼（此时由渲染层驱动窗口，别让吸附插一脚）
/** 拖完窗口后：夹进工作区（吸附在松手时按插件自己的吸附区算，见 end-window-drag）。 */
function onWindowMoved() {
  if (!win || SELFTEST) return
  if (moveGuard) { moveGuard = false; return }
  const b = win.getBounds()
  const next = setPetBounds(b.x, b.y)
  petPos = { x: next.x, y: next.y }
  writeConfig({ petPos, windowMode })
}

function setTrayTitle() {
  if (!tray) return
  const s = dshLink ? dshLink.status() : { mode: 'off' }
  const modeText = { off: '未检测到 DSH', display: '已联动（只读）', account: '已联动（桌面端记账）' }[s.mode] || s.mode
  tray.setToolTip(`小鲸鱼桌面挂件\nDSH：${modeText}${s.dshPort ? ` · 端口 ${s.dshPort}` : ''}`)
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const template = [
    { label: '显示 / 隐藏挂件', click: () => toggleWindow() },
    { label: '重新加载挂件', click: () => { try { win && win.reload() } catch (err) {} } },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => { applyTopmost(!!item.checked) },
    },
    {
      label: '鼠标穿透（空白处点击穿到桌面）',
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => {
        clickThrough = !!item.checked
        writeConfig({ clickThrough })
        applyMouseMode()
      },
    },
    {
      label: `窗口范围：${WINDOW_MODE_LABEL[windowMode] || windowMode}`,
      submenu: ['pet', 'corner', 'full'].map((m) => ({
        label: WINDOW_MODE_LABEL[m] + (m === 'full' ? '（⚠️ 全屏透明窗可能整屏变黑）' : ''),
        type: 'radio',
        checked: windowMode === m,
        click: () => {
          windowMode = m
          petPos = null
          writeConfig({ windowMode, petPos: null })
          fitWindowToDisplay()
        },
      })),
    },
    {
      label: '自动贴边（松手吸附到屏幕边缘）',
      type: 'checkbox',
      checked: autoSnap,
      click: (item) => {
        autoSnap = !!item.checked
        writeConfig({ autoSnap })
        if (!autoSnap) { try { win && win.webContents.send('dshw:set-pin', null) } catch (err) {} }
      },
    },
    {
      label: '屏幕自检（写报告 + 截图）',
      click: () => { runScreenCheck({ thenExit: false }).catch((err) => console.error('[main] 自检失败：' + (err && err.message))) },
    },
    { type: 'separator' },
    { label: `DSH：${modeText}${s.dshPort ? `（127.0.0.1:${s.dshPort}）` : ''}`, enabled: false },
  ]
  // 渲染模式切换（切换后自动重启，用于绕开安全软件对子进程的拦截）
  template.push({
    label: `渲染模式：${MODE_LABEL[FORCED_MODE] || FORCED_MODE}（当前级别 ${SAFE_STAGE}）`,
    submenu: ['auto', 'normal', 'no-sandbox', 'safe', 'single-process'].map((m) => ({
      label: MODE_LABEL[m] + (m === 'no-sandbox' ? '（推荐，兼容性最好）' : m === 'safe' ? '（不用 GPU）' : m === 'single-process' ? '（不创建子进程）' : ''),
      type: 'radio',
      checked: FORCED_MODE === m,
      click: () => switchRendererMode(m),
    })),
  })
  if (displays.length > 1) {
    template.push({
      label: '挂到哪个显示器',
      submenu: displays.map((d, i) => ({
        label: `显示器 ${i + 1} ${d.bounds.width}×${d.bounds.height}${d.id === primary.id ? '（主）' : ''}`,
        type: 'radio',
        checked: !!(win && win.getBounds().x >= d.bounds.x && win.getBounds().x < d.bounds.x + d.bounds.width),
        click: () => moveToDisplay(d),
      })),
    })
  }
  template.push(
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!readConfig().openAtLogin,
      click: (item) => {
        writeConfig({ openAtLogin: !!item.checked })
        try { app.setLoginItemSettings({ openAtLogin: !!item.checked }) } catch (err) {}
      },
    },
    { label: '打开数据目录（$DSH_HOME）', click: () => { try { shell.openPath(resolveDshHome()) } catch (err) {} } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  )
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

/** 切换渲染模式并重启（安全软件拦子进程时，这是最省事的自救手段）。 */
function switchRendererMode(mode) {
  try {
    writeConfig({ rendererMode: mode })
    if (mode === 'auto') { try { fs.rmSync(renderFailedMarker(), { force: true }) } catch (err) {} }
  } catch (err) {}
  console.log(`[main] 渲染模式切换为 ${MODE_LABEL[mode] || mode}，正在重启…`)
  try {
    quitting = true
    app.relaunch()
    app.exit(0)
  } catch (err) {
    console.error('[main] 重启失败：' + (err && err.message))
  }
}

function moveToDisplay(display) {
  if (!win) return
  const { workArea } = display
  const { w, h } = fixedPetSize()
  const x = workArea.x + Math.max(0, workArea.width - w - SHELL_MARGIN)
  const y = workArea.y + Math.max(0, workArea.height - h - SHELL_MARGIN)
  try { win.setBounds({ x, y, width: w, height: h }) } catch (err) {}
  petPos = { x, y }
  writeConfig({ petPos })
  win.showInactive()
}

/** 宠物窗口的**固定**尺寸（绝不把读回来的尺寸再写回去 —— 负坐标/半出屏时 Windows 会把它越放越大，
 *  日志里那串 560→2064×2111 的膨胀就是这么来的，鲸鱼因此只能待在屏幕底部）。 */
function fixedPetSize() {
  const { workArea } = currentDisplay()
  if (windowMode === 'full') return { w: workArea.width, h: workArea.height }
  if (windowMode === 'corner') {
    return { w: Math.max(360, Math.min(workArea.width, SHELL_MAX_W)), h: Math.max(320, Math.min(workArea.height, SHELL_MAX_H)) }
  }
  return { w: Math.max(320, Math.min(workArea.width, PET_W)), h: Math.max(320, Math.min(workArea.height, PET_H)) }
}

/** 设置窗口位置：固定尺寸 + 夹进工作区（不让它半出屏，避免被系统改尺寸）。 */
function setPetBounds(x, y) {
  if (!win) return { x: 0, y: 0 }
  const { workArea } = currentDisplay()
  const { w, h } = fixedPetSize()
  const cx = Math.round(Math.min(Math.max(Number.isFinite(x) ? x : workArea.x, workArea.x), workArea.x + Math.max(0, workArea.width - w)))
  const cy = Math.round(Math.min(Math.max(Number.isFinite(y) ? y : workArea.y, workArea.y), workArea.y + Math.max(0, workArea.height - h)))
  try { win.setBounds({ x: cx, y: cy, width: w, height: h }) } catch (err) {}
  return { x: cx, y: cy }
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible()) win.hide()
  else { fitWindowToDisplay(); win.showInactive() }
}

function currentDisplay() {
  // 已放置过的窗口跟随它所在的那块屏，否则用主屏
  try {
    if (win) return screen.getDisplayMatching(win.getBounds())
  } catch (err) {}
  return screen.getPrimaryDisplay()
}

function fitWindowToDisplay() {
  if (!win || SELFTEST) return
  try { const p = setPetBounds(shellBounds().x, shellBounds().y); petPos = p } catch (err) {}
}

function createWindow() {
  const opts = SELFTEST
    ? (() => { const { workArea } = currentDisplay(); return { x: Math.max(0, workArea.x + workArea.width - 760), y: Math.max(0, workArea.y + workArea.height - 560), width: 760, height: 560 } })()
    : shellBounds()

  win = new BrowserWindow({
    ...opts,
    show: false,
    frame: false,
    transparent: !SELFTEST,
    backgroundColor: SELFTEST ? '#ffffff' : '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: !SELFTEST,
    acceptFirstMouse: true,
    title: '小鲸鱼桌面挂件',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  win.setMenuBarVisibility(false)
  if (!SELFTEST) {
    if (alwaysOnTop) win.setAlwaysOnTop(true, 'floating')
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false }) } catch (err) {}
    applyMouseMode()
    console.log(`[main] 挂件窗口区域：${JSON.stringify(shellBounds())}（鼠标穿透=${clickThrough} 置顶=${alwaysOnTop} 贴边=${autoSnap}）`)
  }

  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })
  win.on('closed', () => { win = null })
  // 点别的窗口时（我们的窗口失焦）立刻重申置顶，不然用户会看到它被压下去
  win.on('blur', () => assertTopmost())
  win.on('show', () => assertTopmost())
  // 拖动过程中由渲染层驱动窗口，不做吸附；松手后（end-window-drag）再吸附
  win.on('moved', () => {
    if (windowDragging) return
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => { moveTimer = null; onWindowMoved() }, 350)
  })

  win.webContents.on('did-finish-load', () => {
    shellLoaded = true
    console.log('[main] 页面加载完成：' + win.webContents.getURL())
    verifyWidgetMounted()
  })
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    // 渲染层日志（含挂件自己的报错）一并落盘，方便远程排查
    if (level >= 2) console.warn(`[renderer] ${message} (${source}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] 渲染进程异常退出：', JSON.stringify(details))
    noteRenderFailure('渲染进程 ' + (details && details.reason))
  })
  win.webContents.on('unresponsive', () => console.error('[main] 渲染进程无响应'))
  app.on('child-process-gone', (_e, details) => {
    console.error('[main] 子进程异常退出：', JSON.stringify(details))
    if (details && details.type === 'GPU') noteRenderFailure('GPU 进程 ' + (details.reason || details.exitCode))
  })
  win.webContents.on('preload-error', (_e, file, err) => {
    console.error('[main] preload 出错：', file, err && err.message)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] 页面加载失败 code=${code} desc=${desc} url=${url}`)
    // dshw:// 自定义协议若在某些环境不可用，退回同源 http（功能完全一致，只是 origin 变了）
    if (!httpFallback && !shellLoaded && String(url).startsWith('dshw://') && httpBase) {
      httpFallback = true
      console.warn('[main] 自定义协议加载失败，回退到 ' + httpBase)
      win.loadURL(httpBase + '/')
    }
  })

  loadShell()
  return win
}

/** 渲染/GPU 进程起不来时：落标记（下次逐级降级）并在托盘冒泡告知用户。 */
function noteRenderFailure(what) {
  const forced = FORCED_MODE !== 'auto'
  const next = Math.min(3, SAFE_STAGE + 1)
  if (!forced) writeSafeStage(next)
  if (noteRenderFailure.warned) return
  noteRenderFailure.warned = true
  console.error(`[main] ${what}：界面无法渲染（渲染模式=${MODE_LABEL[FORCED_MODE] || FORCED_MODE}，降级级别 ${SAFE_STAGE}）。`)
  if (!forced) {
    console.error('[main] 下次启动会自动降级：① 关 Chromium 渲染沙箱（--no-sandbox）→ ② 软件渲染 → ③ 单进程。'
      + '也可以在托盘菜单里直接切换「渲染模式」。实测第 ① 级就能解决绝大多数受限环境/安全软件拦截。')
  } else if (SAFE_STAGE < 1) {
    console.error('[main] 请切换到「无渲染沙箱」模式再试（托盘菜单 → 渲染模式）。')
  } else if (SAFE_STAGE < 3) {
    console.error('[main] 请在托盘菜单里继续降级（软件渲染 / 单进程），或把程序目录加入安全软件信任区。')
  } else {
    console.error('[main] 已经是最宽松的单进程模式仍起不来：请把程序目录加入安全软件信任区。')
  }
  try {
    // 气球通知可在配置里关掉："quiet": true
    if (!USER_CONFIG.quiet && tray && tray.displayBalloon) {
      tray.displayBalloon({
        title: '小鲸鱼桌面挂件',
        content: `界面没渲染出来（当前渲染模式：${MODE_LABEL[FORCED_MODE] || FORCED_MODE}）。`
          + '请在托盘菜单里切换「渲染模式」重试，或把程序目录加入安全软件信任区。',
      })
    }
  } catch (err) {}
}

function loadShell() {
  const transport = String(process.env.DSHW_TRANSPORT || '').toLowerCase()
  const query = `?autoSnap=${autoSnap ? '1' : '0'}&topmost=${alwaysOnTop ? '1' : '0'}`
  if (transport === 'http' && httpBase) return win.loadURL(httpBase + '/' + query)
  return win.loadURL('dshw://app/' + query)
}

/**
 * 屏幕自检：一次性把「窗口是否真的显示、位置尺寸、渲染与挂件状态、余额接口、鼠标穿透」查一遍，
 * 写一份 JSON 报告 + 一张页面截图到数据目录，并在托盘冒泡给出结论。
 */
async function runScreenCheck({ thenExit = false } = {}) {
  const wc = win && win.webContents
  const report = {
    at: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    rendererMode: { forced: FORCED_MODE, stage: SAFE_STAGE, label: MODE_LABEL[FORCED_MODE] || FORCED_MODE },
    window: null,
    display: null,
    page: null,
    balance: null,
    screenshot: null,
    ok: false,
  }
  try {
    const d = screen.getPrimaryDisplay()
    report.display = { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, id: d.id }
    report.window = win ? {
      visible: win.isVisible(),
      alwaysOnTop: win.isAlwaysOnTop(),
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      title: win.getTitle(),
      windowMode,
      clickThrough,
      autoSnap,
    } : null
  } catch (err) { report.window = { error: String(err && err.message) } }

  if (wc) {
    try {
      report.page = await Promise.race([
        wc.executeJavaScript(`(async () => {
          const root = document.querySelector('.dshwv-root')
          const img = document.querySelector('.dshwv-img')
          const r = root ? root.getBoundingClientRect() : null
          const ir = img ? img.getBoundingClientRect() : null
          let snap = null
          try { snap = JSON.parse(localStorage.getItem('dshw-snap') || 'null') } catch (e) {}
          let balance = null
          try { const res = await fetch('/dsh-whale/balance.json', { cache: 'no-store' }); balance = await res.json() } catch (e) { balance = { error: String(e && e.message) } }
          return {
            origin: location.origin,
            viewport: [innerWidth, innerHeight],
            dpr: devicePixelRatio,
            rootExists: !!root,
            rootRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
            imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
            imgNatural: img ? [img.naturalWidth, img.naturalHeight] : null,
            imgRect: ir ? [Math.round(ir.x), Math.round(ir.y), Math.round(ir.width), Math.round(ir.height)] : null,
            snapMode: snap ? snap.mode : null,
            balance: balance ? { ok: balance.ok, total: balance.totalBalance, today: balance.todayUsage, code: balance.code || null } : null,
          }
        })()`, true),
        new Promise((r) => setTimeout(() => r({ error: '页面诊断超时（渲染进程可能没起来）' }), 8000)),
      ])
      report.balance = report.page && report.page.balance ? report.page.balance : null
    } catch (err) { report.page = { error: String(err && err.message) } }

    try {
      const image = await wc.capturePage()
      const shot = path.join(USER_DATA_DIR, 'screen-check.png')
      fs.mkdirSync(path.dirname(shot), { recursive: true })
      fs.writeFileSync(shot, image.toPNG())
      report.screenshot = shot
    } catch (err) { report.screenshot = 'failed: ' + String(err && err.message) }
  }

  const p = report.page || {}
  report.ok = !!(report.window && report.window.visible && p.rootExists && p.imgLoaded)
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(USER_DATA_DIR, 'screen-check.json'), JSON.stringify(report, null, 2))
  } catch (err) {}

  const balText = report.balance && report.balance.ok ? `余额 ¥${report.balance.total}，今日已用 ¥${report.balance.today}` : '余额未取到'
  const lines = [
    `结论：${report.ok ? '✅ 挂件已在屏幕上正常显示' : '❌ 有异常，见报告'}`,
    `窗口：visible=${report.window && report.window.visible} bounds=${JSON.stringify(report.window && report.window.bounds)} 穿透=${clickThrough} 贴边=${autoSnap}`,
    `挂件：DOM=${p.rootExists} 角色图已加载=${p.imgLoaded} rect=${JSON.stringify(p.rootRect)} 视口=${JSON.stringify(p.viewport)}`,
    `吸附：mode=${p.snapMode}`,
    balText,
    `报告：${path.join(USER_DATA_DIR, 'screen-check.json')}`,
    report.screenshot && !String(report.screenshot).startsWith('failed') ? `截图：${report.screenshot}` : `截图：${report.screenshot}`,
  ]
  console.log('[screencheck]\n' + lines.join('\n'))
  try {
    if (tray && tray.displayBalloon && !USER_CONFIG.quiet) {
      tray.displayBalloon({ title: '小鲸鱼桌面挂件 · 屏幕自检', content: lines.slice(0, 4).join('\n') })
    }
  } catch (err) {}

  if (thenExit) {
    quitting = true
    setTimeout(() => process.exit(report.ok ? 0 : 1), 300)
    app.exit(report.ok ? 0 : 1)
  }
  return report
}

/** 启动后确认挂件真的挂上了：把结果写进日志（正常启动时用户看不到控制台）。 */
async function verifyWidgetMounted() {
  const wc = win && win.webContents
  if (!wc) return
  const started = Date.now()
  for (let i = 0; i < 25; i++) {
    let state = null
    try {
      state = await Promise.race([
        wc.executeJavaScript(`(() => {
          const root = document.querySelector('.dshwv-root')
          const img = document.querySelector('.dshwv-img')
          return {
            root: !!root,
            img: !!(img && img.complete && img.naturalWidth > 0),
            origin: location.origin,
            bodyLen: document.body ? document.body.innerHTML.length : -1,
            viewport: [innerWidth, innerHeight],
          }
        })()`, true),
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ])
    } catch (err) { state = null }
    if (state && state.root) {
      console.log(`[main] 挂件已挂载（耗时 ${Date.now() - started}ms）：渲染模式=${MODE_LABEL[FORCED_MODE] || FORCED_MODE} origin=${state.origin} 图片已加载=${state.img} 视口=${state.viewport.join('x')}`)
      // 渲染正常 ⇒ 清掉失败标记，下次回到硬件渲染（用户钉死的模式不动）
      if (FORCED_MODE === 'auto') { try { fs.rmSync(renderFailedMarker(), { force: true }) } catch (err) {} }
      // 锚点以主进程为准：启动时先按窗口所在半屏给一次（之后每次拖拽结束都会再发）
      try {
        const b = win.getBounds()
        const { workArea: wa } = currentDisplay()
        win.webContents.send('dshw:set-pin', {
          left: (b.x + b.width / 2) < (wa.x + wa.width / 2),
          top: (b.y + b.height / 2) < (wa.y + wa.height / 2),
        })
      } catch (err) {}
      return
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  try {
    const dump = await Promise.race([
      wc.executeJavaScript(`({ origin: location.origin, url: location.href, ready: document.readyState, root: !!document.querySelector('.dshwv-root'), bodyLen: document.body ? document.body.innerHTML.length : -1 })`, true),
      new Promise((r) => setTimeout(() => r('诊断超时'), 3000)),
    ])
    console.error('[main] 20 秒内没检测到 .dshwv-root，页面诊断：' + JSON.stringify(dump))
  } catch (err) {
    console.error('[main] 20 秒内没检测到 .dshwv-root，且诊断失败：' + (err && err.message))
  }
}

async function main() {
  pluginHost = await startPluginHost({ port: 0 })
  const base = `http://127.0.0.1:${pluginHost.port}`
  httpBase = base
  console.log(`[main] 插件宿主已启动：${base}（$DSH_HOME=${pluginHost.home}）`)

  // dshw://app/<path> → 本地插件宿主（保持插件的 node:http 语义完全不变）
  protocol.handle('dshw', async (request) => {
    const url = new URL(request.url)
    const target = base + url.pathname + url.search
    const headers = new Headers()
    for (const [k, v] of request.headers) {
      const key = k.toLowerCase()
      // 同源代理：丢掉浏览器附加的跨站标记与 Origin，避免插件的信任栅栏把本机请求判成跨站
      if (['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'host', 'connection', 'content-length'].includes(key)) continue
      headers.set(key, v)
    }
    const init = { method: request.method, headers, redirect: 'manual' }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const body = Buffer.from(await request.arrayBuffer())
      if (body.length) init.body = body
    }
    let res
    try {
      res = await fetch(target, init)
    } catch (err) {
      return new Response('桌面宿主不可达', { status: 502 })
    }
    const outHeaders = new Headers()
    for (const [k, v] of res.headers) {
      const key = k.toLowerCase()
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) continue
      outHeaders.set(key, v)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return new Response(buf.length ? buf : null, { status: res.status, statusText: res.statusText, headers: outHeaders })
  })

  // 配置里的端口（可选）→ 供 DSH 探测使用
  const cfg = readConfig()
  if (cfg.dshPort && !process.env.DSHW_DSH_PORT) process.env.DSHW_DSH_PORT = String(cfg.dshPort)

  // 注意：DSH 联动需要两样东西 —— webServer（装只读覆写）与事件总线（account 模式投事件）。
  // mini 宿主把服务挂在 ctx 上，所以这里显式把两个入口传进去（曾经只传 host 导致覆写静默装不上）。
  dshLink = createDshLink({
    home: pluginHost.home,
    host: { webServer: pluginHost.webServer, emit: pluginHost.host.emit },
  })
  dshLink.start()

  // 托盘要先于窗口建好：渲染/GPU 失败时靠它冒泡告知用户
  if (!SELFTEST) {
    try {
      const iconPath = path.join(VENDOR_ASSETS, 'DSniang1.png')
      let icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })
      tray = new Tray(icon)
      tray.on('click', () => toggleWindow())
    } catch (err) {
      console.error('[main] 托盘创建失败：', err && err.message)
    }
    setTrayTitle()
    setInterval(setTrayTitle, 15000)
    // 心跳兜底：即使某次状态变化没触发重申，也在 2 秒内把置顶补回来
    setInterval(() => assertTopmost(), 2000)
  }

  createWindow()
  win.showInactive() // 用 showInactive 出场，避免启动瞬间抢走当前窗口的焦点

  // --screencheck：等挂件挂载后跑一次屏幕自检，写出报告与截图再退出
  if (SCREENCHECK) {
    const waitMount = async () => {
      for (let i = 0; i < 50; i++) {
        try {
          const ok = await Promise.race([
            win.webContents.executeJavaScript(`!!document.querySelector('.dshwv-root')`, true),
            new Promise((r) => setTimeout(() => r(false), 3000)),
          ])
          if (ok) return true
        } catch (err) {}
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    }
    await waitMount()
    await new Promise((r) => setTimeout(r, 2500)) // 等余额轮询跑一轮
    await runScreenCheck({ thenExit: true })
    return
  }

  // 显示器变化时重新铺满工作区
  screen.on('display-metrics-changed', () => fitWindowToDisplay())
  screen.on('display-added', () => fitWindowToDisplay())
  screen.on('display-removed', () => fitWindowToDisplay())

  let lastInteractive = null
  let lastIgnoreApplied = null
  ipcMain.on('dshw:set-interactive', (_e, interactive) => {
    if (!win || SELFTEST) return
    const want = clickThrough ? !interactive : false
    // ⚠️ 只在真的变化时才调用 setIgnoreMouseEvents：这个调用会重写 GWL_EXSTYLE，
    //    频繁调用会抹掉 WS_EX_TOPMOST（置顶失效）、并可能让透明窗渲染成黑底。
    if (want === lastIgnoreApplied) return
    lastIgnoreApplied = want
    if (interactive !== lastInteractive) {
      lastInteractive = interactive
      console.log(`[main] 鼠标交互态 → ${interactive ? '可交互（指针在鲸鱼的不透明像素上）' : '穿透'}`)
    }
    try { win.setIgnoreMouseEvents(want, { forward: true }) } catch (err) {}
    assertTopmost()
  })

  // 拖鲸鱼 = 移动窗口（BongoCat 式：渲染层给增量，这里只负责挪窗口，期间不做吸附）
  ipcMain.on('dshw:move-window', (_e, dx, dy) => {
    if (!win) return
    const ndx = Number(dx), ndy = Number(dy)
    if (!Number.isFinite(ndx) || !Number.isFinite(ndy)) return
    windowDragging = true
    try {
      const b = win.getBounds()
      const { w, h } = fixedPetSize()
      win.setBounds({ x: Math.round(b.x + ndx), y: Math.round(b.y + ndy), width: w, height: h })
    } catch (err) {}
  })

  ipcMain.on('dshw:end-window-drag', (_e, info) => {
    if (!win) return
    windowDragging = false
    const { workArea: wa } = currentDisplay()
    const M = SHELL_MARGIN // 与 CSS 里鲸鱼距窗口边的留白一致
    const { w: W, h: H } = fixedPetSize()
    const whale = info && info.whale && Number.isFinite(info.whale.x) && info.whale.w > 0 ? info.whale : null
    const zones = info && info.zones ? info.zones : null

    // 左右/上下锚点：贴到哪边就钉哪边；都没贴时按鲸鱼在屏幕哪个半区决定（面板朝屏幕内侧开）
    let pinLeft = pinStateFromWhale(whale, wa, zones, 'h')
    let pinTop = pinStateFromWhale(whale, wa, zones, 'v')
    let wx = whale ? whale.x : 0
    let wy = whale ? whale.y : 0

    if (whale && autoSnap && zones) {
      // ⭐ 用**插件自己「吸附与翻转」里配的吸附区**，桌面端只读不写 —— 这就是"原先的吸附设置生效"
      const zl = zones.mode === 'off' ? 0 : (zones.mode === 'px' ? zones.L : wa.width * zones.L / 100)
      const zt = zones.mode === 'off' ? 0 : (zones.mode === 'px' ? zones.T : wa.height * zones.T / 100)
      const zr = zones.mode === 'off' ? 0 : (zones.mode === 'px' ? zones.R : wa.width * zones.R / 100)
      const zb = zones.mode === 'off' ? 0 : (zones.mode === 'px' ? zones.B : wa.height * zones.B / 100)
      const inL = zl > 0 && (whale.x - wa.x) <= zl
      const inR = zr > 0 && (wa.x + wa.width - (whale.x + whale.w)) <= zr
      const inT = zt > 0 && (whale.y - wa.y) <= zt
      const inB = zb > 0 && (wa.y + wa.height - (whale.y + whale.h)) <= zb
      if (inL) pinLeft = true
      if (inR) pinLeft = false
      if (inT) pinTop = true
      if (inB) pinTop = false
      if (inL) wx = wa.x + M
      if (inR) wx = wa.x + wa.width - whale.w - M
      if (inT) wy = wa.y + M
      if (inB) wy = wa.y + wa.height - whale.h - M
      console.log(`[main] 贴边：吸附区=[${Math.round(zl)},${Math.round(zt)},${Math.round(zr)},${Math.round(zb)}]px 命中=${inL ? '左' : ''}${inR ? '右' : ''}${inT ? '上' : ''}${inB ? '下' : ''} 锚点=${pinLeft ? '左' : '右'}${pinTop ? '上' : '下'}`)
    }

    if (whale) {
      // 由「鲸鱼在窗口里的锚点」反推窗口位置（窗口整体留在屏内，不再半出屏——那会让系统把窗口越撑越大）
      const nx = pinLeft ? wx - M : wx - (W - whale.w - M)
      const ny = pinTop ? wy - M : wy - (H - whale.h - M)
      moveGuard = true
      const placed = setPetBounds(nx, ny)
      petPos = placed
      writeConfig({ petPos, windowMode })
      try { win.webContents.send('dshw:set-pin', { left: pinLeft, top: pinTop }) } catch (err) {}
      assertTopmost()
      console.log(`[main] 窗口=${JSON.stringify(win.getBounds())} 鲸鱼=${JSON.stringify({ x: Math.round(wx), y: Math.round(wy) })}`)
      return
    }
    const b = win.getBounds()
    petPos = setPetBounds(b.x, b.y)
    writeConfig({ petPos, windowMode })
    assertTopmost()
  })

  /** 鲸鱼该贴窗口哪一角：优先看它落进了插件的哪个吸附区，否则按所在半区（含翻转线 F）。 */
  function pinStateFromWhale(whale, wa, zones, axis) {
    if (!whale) return axis === 'v' ? false : true
    const cx = whale.x + whale.w / 2
    const cy = whale.y + whale.h / 2
    if (axis === 'h') {
      const flip = zones && Number.isFinite(zones.F) && zones.F >= 0 ? zones.F : 50
      return ((cx - wa.x) * 100 / wa.width) < flip
    }
    return cy < wa.y + wa.height / 2
  }

  // 挂件菜单里注入的「总在最前」那一行
  ipcMain.on('dshw:set-topmost', (_e, on) => {
    applyTopmost(on)
    setTrayTitle()
    console.log(`[main] 总在最前 → ${alwaysOnTop ? '开' : '关'}（来自挂件菜单）`)
  })

  if (SELFTEST) await runSelftest()
}

async function runSelftest() {
  const wc = win.webContents
  let done = false
  const hardStop = setTimeout(async () => {
    if (done) return
    done = true
    console.error('[selftest] 超时：挂件没有在 45 秒内挂载')
    try {
      // 渲染进程可能已经死了 ⇒ 这里绝不能再无限等（否则进程退不出去）
      const diag = await Promise.race([
        wc.executeJavaScript(`({ url: location.href, ready: document.readyState, bodyLen: document.body ? document.body.innerHTML.length : -1 })`, true),
        new Promise((r) => setTimeout(() => r('诊断超时'), 2000)),
      ])
      console.error('[selftest] 诊断：' + JSON.stringify(diag))
    } catch (err) {}
    quitting = true
    setTimeout(() => process.exit(3), 200)
    app.exit(3)
  }, 45000)

  const waitFor = async (expr, timeoutMs) => {
    const t0 = Date.now()
    for (;;) {
      let v = null
      try { v = await Promise.race([
        wc.executeJavaScript(expr, true),
        new Promise((r) => setTimeout(() => r(null), 5000)),
      ]) } catch (err) { v = null }
      if (v) return v
      if (Date.now() - t0 > timeoutMs) return null
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  const mounted = await waitFor(`!!document.querySelector('.dshwv-root')`, 25000)
  const info = await wc.executeJavaScript(`(() => {
    const r = document.querySelector('.dshwv-root')
    const img = document.querySelector('.dshwv-img')
    const rect = r ? r.getBoundingClientRect() : null
    return {
      origin: location.origin,
      hasRoot: !!r,
      hasImg: !!img,
      imgSrc: img ? img.getAttribute('src') : null,
      imgComplete: img ? img.complete : null,
      imgNatural: img ? (img.naturalWidth + 'x' + img.naturalHeight) : null,
      rect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null,
      viewport: [innerWidth, innerHeight],
      rootCount: document.querySelectorAll('.dshwv-root').length,
    }
  })()`, true).catch(() => null)
  console.log('[selftest] mounted=' + !!mounted)
  console.log('[selftest] ' + JSON.stringify(info))
  try {
    const image = await wc.capturePage()
    fs.mkdirSync(path.dirname(SELFTEST_OUT), { recursive: true })
    fs.writeFileSync(SELFTEST_OUT, image.toPNG())
    console.log('[selftest] 截图已保存：' + SELFTEST_OUT)
  } catch (err) {
    console.error('[selftest] 截图失败：' + (err && err.message))
  }
  clearTimeout(hardStop)
  done = true
  quitting = true
  app.exit(mounted ? 0 : 1)
}

// ---------- 生命周期 ----------
// 屏幕自检是一次性进程：不受单实例锁限制（否则挂着挂件时命令行自检跑不起来）
if (!SCREENCHECK && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { fitWindowToDisplay(); win.showInactive() }
  })

  app.whenReady().then(async () => {
    installFileLogger()
    console.log(`[main] 启动：selftest=${SELFTEST} 渲染模式=${MODE_LABEL[FORCED_MODE] || FORCED_MODE} 降级级别=${SAFE_STAGE} argv=${process.argv.slice(1).join(' ')}`)
    console.log(`[main] Electron ${process.versions.electron} / Node ${process.versions.node}`)
    console.log(`[main] 数据目录=${USER_DATA_DIR}（配置文件 rendererMode=${JSON.stringify(USER_CONFIG.rendererMode || 'auto')}）日志：${logFile()}`)
    // 启动环境诊断：用来判断这次启动是不是在受限/沙箱环境里（DSH 的沙箱会带上 DSH_* 变量与私有 TEMP）
    try {
      const dshEnv = Object.keys(process.env).filter((k) => k.startsWith('DSH')).map((k) => `${k}=${process.env[k]}`)
      console.log(`[main] cwd=${process.cwd()} ppid=${process.ppid} TEMP=${process.env.TEMP} TMP=${process.env.TMP}`)
      console.log(`[main] DSH 环境变量：${dshEnv.length ? dshEnv.join(' | ') : '（无，说明不是在 DSH 沙箱里启动的）'}`)
    } catch (err) {}
    Menu.setApplicationMenu(null)
    // 自启状态与配置保持一致
    try { app.setLoginItemSettings({ openAtLogin: !!readConfig().openAtLogin }) } catch (err) {}
    try {
      await main()
    } catch (err) {
      console.error('[main] 启动失败：', err)
      app.quit()
    }
  })

  app.on('window-all-closed', (e) => {
    // 托盘常驻：不因窗口关闭而退出
    e.preventDefault && e.preventDefault()
  })

  app.on('before-quit', () => { quitting = true })

  app.on('will-quit', async (e) => {
    if (pluginHost) {
      e.preventDefault()
      const p = pluginHost
      pluginHost = null
      try { dshLink && dshLink.stop() } catch (err) {}
      try { await p.dispose() } catch (err) {}
      app.quit()
    }
  })
}

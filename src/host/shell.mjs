// shell.mjs — 桌面壳的 index.html。
//
// 这份 HTML 会先过一遍插件的注入管线（webServer.renderIndex），插件据此把
// /dsh-whale/widget.js 注入进来 —— 与 DSH 网页端/桌面端走的是同一条通道。
//
// 交互层的设计参考了 BongoCat（原生桌面宠物）的做法：
//   ① **拖鲸鱼 = 移动窗口**（用全局鼠标坐标；窗口跟着光标走，指针始终不离开窗口）
//   ② **按渲染像素的 alpha 判定鼠标穿透**（只有鲸鱼不透明的地方才接鼠标）
//   ③ **只在状态真的变化时才调用 setIgnoreMouseEvents**（频繁重写 GWL_EXSTYLE 会抹掉置顶位、
//      甚至让透明窗变黑；实测全屏透明窗切到可交互时会整屏变黑）
// 为了让"移动窗口"不与插件自身的拖拽打架，这里用宿主 CSS 把 `.dshwv-root` **钉在窗口右下角**
// （插件写的是内联 left/top，`!important` 的外部规则会盖住它），插件的菜单定位用的是
// getBoundingClientRect，所以钉住之后菜单依旧跟着鲸鱼，不受影响。
export function shellHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鲸鱼桌面挂件</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;
    -webkit-user-select:none;user-select:none;font-family:"Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
  /* 挂件自检用的“聊天界面”桩：零尺寸、绝对定位、不可见，不参与布局 */
  #root{position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0}
  #root [data-composer-input]{width:0;height:0;overflow:hidden}
  /* ① 把鲸鱼钉在窗口的一角：插件写内联 left/top，这里用 !important 盖掉，
        于是"拖鲸鱼"由宿主驱动窗口移动来实现，两者不会各动各的。
        钉哪一角由宿主动态决定（鲸鱼在屏幕哪个半区就钉那一侧），所以鲸鱼能放到屏幕任意位置。 */
  .dshwv-root{left:auto !important;top:auto !important;right:16px !important;bottom:16px !important}
  .dshwv-root.dshw-pin-bl{left:16px !important;right:auto !important;top:auto !important;bottom:16px !important}
  .dshwv-root.dshw-pin-tr{left:auto !important;right:16px !important;top:16px !important;bottom:auto !important}
  .dshwv-root.dshw-pin-tl{left:16px !important;right:auto !important;top:16px !important;bottom:auto !important}
  /* 让鲸鱼尺寸不再随这个小窗口的视口缩放（否则窗口一小，鲸鱼也跟着缩水）。
     仍然保留用户自己的大小滑块（--dshw-scale）。 */
  .dshwv-root{--dshw-base:calc(250px * var(--dshw-scale, 1)) !important}
  /* ② 面板打开时那层"压暗整页"的遮罩在桌面端没有页面可压暗，抹掉底色、只保留它拦点击的作用 */
  .dshwv-usage-mask,.dshwv-snapmask,.dshwv-bubmask,.dshwv-confirmmask,.dshwv-cropmask,.dshwv-audiomask{
    background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}
</style>
<script>
// —— 吸附设置不再由宿主覆写 ——
// 插件自己的「吸附与翻转」面板把设置存在 localStorage['dshw-snap']（mode: ratio|px|off + 各边数值 + F 翻转线）。
// 桌面端**只读**这份设置、用它来做屏幕边缘吸附（见下面交互层的 readZones），
// 绝不在启动时改写它 —— 之前会在 URL 里带 autoSnap=1 时强行写 mode:'ratio'，
// 把用户在插件面板里的设置冲掉，表现就是"原先的吸附设置不生效"。
</script>
</head>
<body>
<div id="root"><div data-composer-input="true" role="textbox" aria-multiline="true" contenteditable="false"></div></div>
<script>
// ===== 交互层 =====
(function () {
  var api = window.dshwShell
  if (!api) return

  // —— 元素归属判定：插件的菜单/面板/遮罩挂在 document.body 下（类名 dshwv-*），不都在 .dshwv-root 里 ——
  function clsOf(n) {
    try { return typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '' } catch (e) { return '' }
  }
  function belongsToWidget(el) {
    var n = el
    for (var i = 0; i < 6 && n && n !== document.body && n !== document.documentElement; i++) {
      if (clsOf(n).indexOf('dshwv') >= 0) return true
      n = n.parentElement
    }
    return false
  }

  // —— ② 鲸鱼素材的 alpha 采样（桌面宠物应有的"只有不透明的像素才吃鼠标"）——
  var ac = null, actx = null, adata = null, aw = 0, ah = 0, asrc = ''
  function rebuildAlpha(img, w, h) {
    try {
      if (w < 1 || h < 1) return
      if (!ac) { ac = document.createElement('canvas'); actx = ac.getContext('2d', { willReadFrequently: true }) }
      ac.width = w; ac.height = h
      actx.clearRect(0, 0, w, h)
      actx.drawImage(img, 0, 0, w, h)
      adata = actx.getImageData(0, 0, w, h).data
      aw = w; ah = h; asrc = img.currentSrc || img.src || ''
    } catch (e) { adata = null }
  }
  function alphaAt(x, y) {
    var img = document.querySelector('.dshwv-img')
    if (!img || !img.complete || !img.naturalWidth) return 255
    var r = img.getBoundingClientRect()
    if (!r.width || !r.height) return 255
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height))
    if (!adata || aw !== w || ah !== h || asrc !== (img.currentSrc || img.src || '')) rebuildAlpha(img, w, h)
    if (!adata) return 255
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return 0
    var px = Math.min(w - 1, Math.max(0, Math.round((x - r.left) * w / r.width)))
    var py = Math.min(h - 1, Math.max(0, Math.round((y - r.top) * h / r.height)))
    return adata[(py * w + px) * 4 + 3]
  }

  // —— 命中测试：UI 元素（菜单/面板/按钮/文字）一律算命中；鲸鱼素材按 alpha ——
  function overWidget(x, y) {
    try {
      var el = document.elementFromPoint(x, y)
      if (!el || el === document.body || el === document.documentElement) return false
      if (!belongsToWidget(el)) return false
      // 素材本体：按不透明像素判定；其余（菜单、面板、按钮）都算命中
      if (el.classList && (el.classList.contains('dshwv-img') || el.classList.contains('dshwv-pop'))) {
        return alphaAt(x, y) > 8
      }
      return true
    } catch (e) { return false }
  }

  // —— ③ 只在状态变化时通知主进程 ——
  var interactive = false
  function apply(v) {
    v = !!v
    if (v === interactive) return
    interactive = v
    try { api.setInteractive(v) } catch (e) {}
  }

  // —— ① 拖鲸鱼 = 移动窗口（BongoCat 的做法）：用 screenX/screenY 的增量，超过 3px 才算拖动 ——
  var dragArmed = false      // 指针按在鲸鱼上，等待是否构成拖动
  var dragging = false
  var startX = 0, startY = 0
  var lastX = 0, lastY = 0
  function pointerXY(e) {
    var sx = typeof e.screenX === 'number' ? e.screenX : 0
    var sy = typeof e.screenY === 'number' ? e.screenY : 0
    return [sx, sy]
  }
  window.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return
    var xy = pointerXY(e)
    lastX = xy[0]; lastY = xy[1]
    if (alphaAt(e.clientX, e.clientY) > 8 || overWidget(e.clientX, e.clientY)) {
      dragArmed = true
      startX = xy[0]; startY = xy[1]
      apply(true)
    }
  }, true)
  window.addEventListener('pointermove', function (e) {
    var xy = pointerXY(e)
    if (dragging) {
      var dx = xy[0] - lastX, dy = xy[1] - lastY
      lastX = xy[0]; lastY = xy[1]
      if (dx || dy) { try { api.moveWindowBy(dx, dy) } catch (err) {} }
      return
    }
    if (dragArmed) {
      var ddx = xy[0] - startX, ddy = xy[1] - startY
      if (ddx * ddx + ddy * ddy >= 9) {
        dragging = true
        lastX = xy[0]; lastY = xy[1]
      }
      return
    }
    // 普通移动：rAF 合并做命中测试
    lastMoveX = e.clientX; lastMoveY = e.clientY
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(function () { rafPending = false; apply(overWidget(lastMoveX, lastMoveY)) })
  }, true)
  var rafPending = false, lastMoveX = -1, lastMoveY = -1
  function endPointer() {
    if (dragging) {
      var st = pinState()
      var rect = whaleScreenRect()
      // 把鲸鱼当前位置 + 插件里配的吸附区一起交给主进程做贴边
      try { api.endWindowDrag({ left: st.left, top: st.top, whale: rect, zones: readZones() }) } catch (e) {}
    }
    dragging = false
    dragArmed = false
    // 松手后不立刻切回穿透：连点两下时第二下必须还能落在鲸鱼上
    setTimeout(function () { if (!dragging) apply(overWidget(lastMoveX, lastMoveY)) }, 600)
  }
  window.addEventListener('pointerup', endPointer, true)
  window.addEventListener('pointercancel', endPointer, true)
  document.addEventListener('mouseleave', function () { setTimeout(function () { if (!dragging) apply(false) }, 700) })

  // —— 锚点（鲸鱼贴窗口哪一角）与贴左镜像，都由「窗口在屏幕的哪半边」决定 ——
  // —— 锚点（鲸鱼贴窗口哪一角）、镜像、以及插件吸附设置（只读） ——
  function pinState() {
    var availW = (window.screen && window.screen.availWidth) || innerWidth
    var availH = (window.screen && window.screen.availHeight) || innerHeight
    return {
      left: (window.screenX + innerWidth / 2) < (availW / 2),
      top: (window.screenY + innerHeight / 2) < (availH / 2),
    }
  }
  function applyPin(st) {
    try {
      var root = document.querySelector('.dshwv-root')
      if (!root || !st) return
      root.classList.toggle('dshw-pin-tl', !!(st.left && st.top))
      root.classList.toggle('dshw-pin-bl', !!(st.left && !st.top))
      root.classList.toggle('dshw-pin-tr', !!(!st.left && st.top))
      // 贴左时整体镜像（插件的文字反向规则照旧生效）
      root.classList.toggle('dshwv-left', !!st.left)
    } catch (e) {}
  }
  // 锚点由**主进程**决定（它才知道插件的吸附区与屏幕工作区）；这里只在启动时先按窗口位置给个初值，
  // 之后一律听主进程的 —— 之前这个 400ms 轮询会和主进程的判定打架，把贴边结果覆盖掉。
  function markPinFromMain() {
    try {
      var root = document.querySelector('.dshwv-root')
      if (root) root.classList.add('dshw-pin-set')
    } catch (e) {}
  }
  setInterval(function () {
    try {
      var root = document.querySelector('.dshwv-root')
      if (!root || root.classList.contains('dshw-pin-set')) return
      applyPin(pinState())
    } catch (e) {}
  }, 400)

  // 读插件「吸附与翻转」的设置：桌面端只读它、用它做屏幕边缘吸附，不改写
  var SNAP_DEFAULTS = { mode: 'ratio', ratio: { L: 10, T: 0, R: 10, B: 15, F: 50 }, px: { L: 0, T: 0, R: 0, B: 0, F: -1 } }
  function readZones() {
    try {
      var raw = localStorage.getItem('dshw-snap')
      var cfg = raw ? JSON.parse(raw) : null
      if (!cfg || typeof cfg !== 'object') cfg = SNAP_DEFAULTS
      var mode = cfg.mode === 'px' || cfg.mode === 'off' ? cfg.mode : 'ratio'
      var src = mode === 'px' ? (cfg.px || SNAP_DEFAULTS.px) : (cfg.ratio || SNAP_DEFAULTS.ratio)
      return { mode: mode, L: Number(src.L) || 0, T: Number(src.T) || 0, R: Number(src.R) || 0, B: Number(src.B) || 0, F: Number(src.F) }
    } catch (e) { return { mode: 'ratio', L: 10, T: 0, R: 10, B: 15, F: 50 } }
  }

  function whaleScreenRect() {
    try {
      var root = document.querySelector('.dshwv-root')
      if (!root) return null
      var r = root.getBoundingClientRect()
      return { x: window.screenX + r.left, y: window.screenY + r.top, w: Math.round(r.width), h: Math.round(r.height) }
    } catch (e) { return null }
  }
  try { if (api.onSetPin) api.onSetPin(function (st) { markPinFromMain(); applyPin(st) }) } catch (e) {}

  // —— 鲸鱼被钉在窗口顶部时，插件仍会把菜单渲染到它上方（会顶出窗口）→ 宿主把它翻到下方 ——
  setInterval(function () {
    try {
      var menu = document.querySelector('.dshwv-menu')
      if (!menu || !menu.classList.contains('dshwv-menu-open')) return
      var root = document.querySelector('.dshwv-root')
      if (!root) return
      var r = root.getBoundingClientRect()
      var mb = menu.getBoundingClientRect()
      if (mb.top < 4 && mb.height) {
        menu.style.top = Math.round(r.bottom + 6) + 'px'
        menu.style.bottom = 'auto'
        menu.style.transformOrigin = 'top left'
      }
    } catch (e) {}
  }, 150)
})();
</script>
<script>
// —— 往挂件自己的菜单里注入一行「总在最前」 ——
// 插件本体不能改，但宿主可以往它的菜单 DOM 里加一行，并复用插件自己的样式类
// （.dshwv-menu-row / .dshwv-check），所以看起来与原生项完全一致。
(function () {
  var api = window.dshwShell
  var want = new URLSearchParams(location.search || '').get('topmost') === '1'
  function inject() {
    try {
      var menu = document.querySelector('.dshwv-menu')
      if (!menu || menu.querySelector('.dshw-host-topmost')) return false
      var row = document.createElement('div')
      row.className = 'dshwv-menu-row dshw-host-topmost'
      var label = document.createElement('span')
      label.textContent = '总在最前'
      var chk = document.createElement('input')
      chk.type = 'checkbox'
      chk.className = 'dshwv-check'
      chk.checked = want
      chk.title = '让鲸鱼始终显示在其它窗口之上（桌面端专有选项）'
      chk.addEventListener('change', function () {
        want = chk.checked
        try { if (api && api.setAlwaysOnTop) api.setAlwaysOnTop(chk.checked) } catch (err) {}
      })
      row.appendChild(label)
      row.appendChild(chk)
      var rows = menu.querySelectorAll('.dshwv-menu-row')
      var anchor = null
      for (var i = 0; i < rows.length; i++) {
        var t = rows[i].textContent || ''
        if (t.indexOf('避让滚动条') >= 0 || t.indexOf('吸附与翻转') >= 0) { anchor = rows[i]; break }
      }
      if (!anchor && rows.length) anchor = rows[rows.length - 1]
      if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(row, anchor.nextSibling)
      else if (menu.lastElementChild && menu.children.length > 1) menu.insertBefore(row, menu.lastElementChild)
      else menu.appendChild(row)
      return true
    } catch (err) { return false }
  }
  var n = 0
  var t = setInterval(function () { if (inject() || ++n > 240) clearInterval(t) }, 500)
  if (document.readyState === 'complete') inject()
})();
</script>
</body>
</html>
`
}

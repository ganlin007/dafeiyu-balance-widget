// preload.cjs — 渲染层与主进程之间的最小桥。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshwShell', {
  // 鼠标穿透（只在状态真正变化时才会被调用）
  setInteractive(interactive) {
    ipcRenderer.send('dshw:set-interactive', !!interactive)
  },
  // 挂件菜单里「总在最前」那一行
  setAlwaysOnTop(on) {
    ipcRenderer.send('dshw:set-topmost', !!on)
  },
  // 拖鲸鱼 = 移动窗口（BongoCat 式：渲染层给屏幕坐标增量）
  moveWindowBy(dx, dy) {
    ipcRenderer.send('dshw:move-window', Number(dx) || 0, Number(dy) || 0)
  },
  // 松手：把鲸鱼在屏幕上的位置与本侧锚点交给主进程去做贴边
  endWindowDrag(info) {
    ipcRenderer.send('dshw:end-window-drag', info || null)
  },
  // 主进程贴边后回传最终锚点
  onSetPin(cb) {
    if (typeof cb !== 'function') return
    ipcRenderer.on('dshw:set-pin', (_e, st) => cb(st))
  },
})

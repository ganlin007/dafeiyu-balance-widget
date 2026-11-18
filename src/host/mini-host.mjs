// mini-host.mjs — 最小 cordis 兼容上下文。
//
// 原插件只用到四种能力（见 vendor/dsh-whale/lib/index.js）：
//   root.effect(cb)                 注册副作用（cb 返回 disposer）
//   root.on(event, listener)        监听事件（返回取消函数）
//   root.inject([names], cb)        等一组服务就绪后执行 cb
//   ctx.get(name) / ctx.<service>   读取服务
// 本模块按同一语义提供一个极小的 Context，用来承载未改动的插件本体。
export function createHost() {
  const services = new Map()
  const listeners = new Map()
  const disposers = []
  const pending = []
  let disposed = false

  function on(event, listener) {
    if (typeof listener !== 'function') return () => {}
    const key = String(event)
    let set = listeners.get(key)
    if (!set) { set = new Set(); listeners.set(key, set) }
    set.add(listener)
    return () => { const s = listeners.get(key); if (s) s.delete(listener) }
  }

  function emit(event, ...args) {
    const set = listeners.get(String(event))
    if (!set || set.size === 0) return
    for (const fn of [...set]) {
      try { fn(...args) } catch (err) { /* 监听器异常不打断其它监听器 */ }
    }
  }

  function effect(cb) {
    if (typeof cb !== 'function') return () => {}
    let result
    try { result = cb() } catch (err) { console.error('[host] effect failed:', err) }
    if (typeof result === 'function') {
      disposers.push(result)
      return result
    }
    return () => {}
  }

  function tryRunPending() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i]
      if (entry.names.every((n) => services.has(n))) {
        pending.splice(i, 1)
        try { entry.cb(ctx) } catch (err) { console.error('[host] inject callback failed:', err) }
      }
    }
  }

  function inject(names, cb) {
    const list = Array.isArray(names) ? names.map(String) : [String(names)]
    if (list.every((n) => services.has(n))) {
      try { cb(ctx) } catch (err) { console.error('[host] inject callback failed:', err) }
      return
    }
    pending.push({ names: list, cb })
  }

  const ctx = {
    get(name) { return services.get(String(name)) ?? null },
    on,
    emit,
    effect,
    inject,
    /** 本宿主没有真实的 cordis scope；插件没有用到 scope。 */
    get scope() { return undefined },
  }

  function provide(name, service) {
    const key = String(name)
    services.set(key, service)
    ctx[key] = service
    tryRunPending()
    return () => { services.delete(key); try { delete ctx[key] } catch (err) { ctx[key] = undefined } }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const d of disposers.reverse()) {
      try { d() } catch (err) {}
    }
    disposers.length = 0
    listeners.clear()
    pending.length = 0
  }

  return { root: ctx, ctx, provide, emit, on, effect, dispose, get services() { return services } }
}

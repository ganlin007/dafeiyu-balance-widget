// connection.mjs — DSH `connection` 服务的等价物（桌面端只需要“请求信任栅栏”这一部分）。
//
// 原插件的三层校验是：① 插件自带的回环/同源校验（永远先跑）→ ② 委托宿主栅栏 requestRejection
// → ③ 没有栅栏时只靠 ①。桌面端所有请求都来自本机 127.0.0.1 代理，Host 恒为回环，
// 因此这里的栅栏返回 null（= 不拒绝），语义与 DSH 的“已通过信任校验”一致。
export function createConnection() {
  return {
    /**
     * @returns {number|false|null|undefined} 拒绝时返回 HTTP 状态码，放行返回 null
     */
    requestRejection(req) {
      return null
    },
    /** 桌面端没有浏览器会话这个概念：本机用户就是操作者。 */
    get operator() { return null },
    rpc: {
      async open() { throw new Error('connection.rpc 在桌面端不可用（插件未使用）') },
    },
  }
}

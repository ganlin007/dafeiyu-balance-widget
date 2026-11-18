# 小鲸鱼桌面挂件（DSH Whale Desktop）

把 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
（DSH 网页右下角的 DeepSeek 余额小鲸鱼）做成**独立桌面端**：鲸鱼娘常驻 Windows 桌面右下角，
余额 / 今日已用 / 峰谷定价 / 泡泡系统 / 自定义角色 / 音效 / 拖拽吸附翻转**全部保留**。

> **上游插件本体一行未改。** `vendor/dsh-whale/` 是从上游 `main`（commit `770d3f55`，版本 `0.3.18`）
> 逐字节拷贝进来的，`npm run verify-vendor` 会做哈希 + 逐字节双重校验。
> 所有桌面端能力都写在 `src/` 里，通过「复刻 DSH 宿主契约」实现，而不是改插件。

## 功能介绍

给 Windows 用的 DeepSeek 余额小鲸鱼。不嵌在网页里，而是一块透明、总在最前的桌面挂件。

- **桌面上的小鲸鱼**：默认待在主屏工作区右下角。平时鼠标穿透，只有点在鲸鱼、泡泡或菜单上才响应，不挡别的窗口。
- **DeepSeek 余额**：点鲸鱼打开菜单，底部进「用量记录」，选内置的「DeepSeek（内置）」，再进「设置 → 密钥 / 接口」粘贴 API 密钥。显示的是这个 DeepSeek **账号**的余额和今日已用，单位人民币。同一账号新建一把密钥，看到的仍是同一份余额，不必和别的软件共用同一串密钥。
- **密钥不在程序里**：凭据和账本在本机用户目录（默认 `~/.dsh`）。只把程序拷给别人，不会带上你的余额；对方要自己填密钥，没有单独的首次填写向导。
- **Codex（本地会话）**：可以在用量记录里另加这一项。它只读本机 `~/.codex/sessions` 里的会话日志，统计 token，不算人民币，也不去读 Codex 的配置文件。Codex 若把 DeepSeek 当作接口，人民币余额仍要在「DeepSeek（内置）」里填该账号的密钥。
- **其他厂商**：可以按模板添加余额或订阅额度，或自己填一个 HTTP 余额接口。官方没有余额接口的厂商，余额位置显示「—」。
- **挂件上的其余能力**：今日已用、峰谷定价、泡泡、自定义角色和音效、拖拽、贴边、贴左边时镜像翻转、余额预警、今日预算。托盘里可以显示或隐藏、重新加载、总在最前、切换显示器、开机自启、退出。
- **跟 DSH 的关系**：只看 DeepSeek 余额时，不必安装或打开 DSH。每轮对话消耗、对话名、提问音和授权音，要本机 DSH 正在运行才会出现。

---

## 快速开始

```powershell
cd whale-desktop
npm install                 # 已装好 electron + fzstd 的话可跳过
npm start                   # 启动桌面挂件
```

启动后：

- 鲸鱼娘出现在**主屏工作区右下角**，在桌面最上层；
- 窗口整体**鼠标穿透**，只有指针落在鲸鱼/泡泡/菜单上时才会接住点击 —— 不挡桌面操作；
- 托盘图标（鲸鱼头像）里可以：显示/隐藏、重新加载、总在最前、切显示器、开机自启、退出。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动桌面挂件 |
| `npm test` | 冒烟 + 联动 + 完整性三套自检 |
| `npm run smoke` | 起 mini 宿主跑通全部 `/dsh-whale/*` 接口（写在临时目录，不动真实数据） |
| `npm run link-test` | DSH 检测、会话日志多帧 zstd 增量读取、两种联动模式 |
| `npm run render-check` | 用系统 Edge/Chrome 无头渲染并断言挂件 DOM（含鼠标穿透命中测试），产出 `render-check.png` |
| `npm run selftest` | Electron 自检：挂载后截图到 `selftest.png` 再退出（45 秒硬超时） |
| `npm run verify-vendor` | 校验 `vendor/dsh-whale` 与上游逐字节一致 |

---

## 它是怎么跑起来的

上游插件是标准 DSH bundle 插件：宿主侧 `lib/index.js` 注册 23 条 `/dsh-whale/*` 路由，
前端 `assets/whale-widget.js` 由宿主注入 index.html。它只依赖三个宿主服务，
因此桌面端做了一层**等价宿主**，插件原样 `apply()`：

```
src/
├── main.mjs                    Electron 主进程：窗口 / 托盘 / 自定义协议 / 生命周期
├── preload.cjs                 只暴露一个能力：告诉主进程「指针在不在鲸鱼上」
├── host/
│   ├── mini-host.mjs           cordis 兼容 Context（effect / on / inject / get）
│   ├── web-server.mjs          等价 @deepseek-ai/dsh-host-webserver（register / tapIndex / 注入表）
│   ├── credentials.mjs         等价 dsh-credentials：读写 $DSH_HOME/.credentials.yaml
│   ├── connection.mjs          等价 connection 的请求信任栅栏（本机请求直接放行）
│   ├── shell.mjs               桌面壳页面：composer 桩 + 鼠标穿透命中测试
│   └── plugin-host.mjs         装配上述服务并 apply 未改动的插件
└── dsh/
    ├── detect.mjs              检测本机 DSH 是否在跑、是否已装本插件
    ├── zstd-frames.mjs         DSH 会话日志的多帧 zstd 读取（Node 只解第一帧，这里自己切帧）
    ├── session-log.mjs         会话日志发现 + 增量跟进（含半帧容错）
    └── dsh-link.mjs            DSH 联动：display / account 两种模式
```

几个关键设计点：

- **同源、且 origin 稳定**：渲染层走自定义协议 `dshw://app/`，由主进程转发到本地宿主
  （`http://127.0.0.1:<随机端口>`）。这样挂件的相对路径 `/dsh-whale/*` 原样可用，
  而且 localStorage（位置 / 尺寸 / 已看过的 seq 记忆）在每次启动之间保持稳定。
  若个别环境自定义协议不可用，会自动回退到 `http://127.0.0.1` 传输（`DSHW_TRANSPORT=http` 可强制）。
- **桌面壳提供「聊天界面桩」**：挂件启动时会自检 `#root` 里有没有 composer 输入区
  （`dshwIsChatRoot`，用来避免挂在插件市场等非聊天页）。桌面端没有 DSH 聊天界面，
  于是 `shell.mjs` 放了一个**零尺寸、不参与布局、不可见**的 composer 桩满足检测，除此之外不碰任何东西。
- **透明置顶 + 鼠标穿透**：窗口铺满工作区、`transparent + alwaysOnTop + skipTaskbar`，
  默认 `setIgnoreMouseEvents(true, { forward: true })`；渲染层每次 `mousemove` 用
  `document.elementFromPoint` 做命中测试，只有指针真的落在 `.dshwv-root` 内才把窗口切成可交互，
  离开即恢复穿透（拖拽期间锁定，避免快速拖动被中断）。
- **共用 DSH 的数据**：`$DSH_HOME`（默认 `~/.dsh`）下的凭据、账本、角色图库、音效库、
  泡泡配置全部直接用 —— DSH 里已经配好的余额、记账、自定义角色/音效，桌面端开箱即用，两端同一份。

---

## DSH 联动：检测到 DSH 在跑就激活

余额、今日已用、峰谷、泡泡这些都不依赖 DSH；但「每轮对话消耗」「对话名」「提问/授权提醒」
来自 DSH 的会话事件。桌面端的做法是**检测本机 DSH 是否在运行**：

```
每 10 秒探测一次：GET http://127.0.0.1:3080/  → 401 + "dsh web authentication required" = DSH 在跑
再探一次：       GET /dsh-whale/balance.json    → 401/403/200 = 跑着的 DSH 里装了本插件；404 = 没装
```

据此选一种模式（可用 `DSHW_LINK_MODE=display|account|off` 强制，端口可用 `DSHW_DSH_PORT` 指定）：

| 模式 | 何时 | 做法 | 会不会重复记账 |
|---|---|---|---|
| **display（只读联动）** | DSH 在跑**且已装本插件**（你的机器就是这种） | 不往插件投任何事件；只读 `/dsh-whale/last-turn.json` 与 `/dsh-whale/wait.json` 两个**只读**接口，数据取自 DSH 已经写好的账本与 `.dshw-turn.json`，挂起状态由会话日志推导 | **不会**：全程不写任何文件 |
| **account（桌面端记账）** | DSH 在跑但**没装**本插件 | 把会话日志合成为 `session/event` 投给插件，走插件自己的记账与挂起逻辑（含启动时补投进行中那一轮） | 不会：此时桌面端是唯一记账者 |
| **off** | DSH 没在跑 | 功能静默失效，界面与设置项全在 | — |

> ⚠️ **为什么必须分两种模式**：桌面端与 DSH 共用同一个 `$DSH_HOME`。如果 DSH 里也装了本插件，
> 同一轮对话被两个实例各记一次，账本的 `events`（用量记录 / 本机模型费用）就会**翻倍**。
> （余额口径的「今日已用」不会翻倍：`observeBalance` 是按共享 `lastUnits` 求差、并拒绝乱序样本。）
> 所以 display 模式刻意做成**纯只读**：把 DSH 已经算好的结果端给桌面界面，自己不落一笔账。
> 托盘菜单里会直接写明当前模式（`DSH：已联动（只读）`）。

---

## 与原插件的功能对照

| 功能 | 桌面端 | 说明 |
|---|---|---|
| 余额（API key / DSH 账号登录态） | ✅ 全保留 | API key 走 `$DSH_HOME/.credentials.yaml`（与 DSH 同一份） |
| 今日已用、余额校正、逐日/逐模型账本 | ✅ 全保留 | 账本文件与 DSH 共用 |
| 峰谷定价、梁文峰谷样式、倒计时 | ✅ 全保留 | |
| 泡泡系统（点击序列 / 并列加权 / 模块化 / 随机语句图片 / 拖拽排版 / 模块库） | ✅ 全保留 | |
| 主菜单、大小滑块、悬浮快捷编辑、资源管理、余额预警、今日预算 | ✅ 全保留 | |
| 自定义角色 / 泡泡图库 / 音效片段 / 音效组 / 各事件独立音量 | ✅ 全保留 | 图库与音效库目录与 DSH 共用 |
| 拖拽 + 四边吸附 + 左吸附镜像翻转 + 按压 Q 弹 | ✅ 全保留 | 吸附边界即屏幕工作区边界 |
| 每轮消耗泡泡 / 任务结束音 | ✅ DSH 在跑时激活 | display 模式读 DSH 账本；account 模式自己记账 |
| 提问音 / 授权音 | ✅ DSH 在跑时激活 | display 模式由会话日志推导挂起 |
| 对话名 `{session}` 占位符 | ✅ DSH 在跑时激活 | |
| 自定义 API 多厂商余额 / 额度 / Codex 本地统计 | ✅ 全保留 | 密钥仍写入 DSH 凭据文档 |
| 移动端触摸逻辑 | ➖ 不适用 | 桌面端用鼠标；代码原样在，不触发 |

---

## 渲染模式（安全软件 / 受限环境适配）

实测：**Chromium 自带的渲染进程沙箱**在部分受限环境或安全软件（360 安全卫士、火绒、联想电脑管家）的主动防御下会
`render-process-gone: launch-failed, exitCode 18` —— 表现就是窗口空白、随后 GPU 判定不可用直接退出。
加 `--no-sandbox` 后立刻正常（本机实测：页面加载 + 挂件挂载 + 角色图加载全部成功）。

桌面端因此内置逐级自动降级，也可以在**托盘菜单 → 渲染模式**里手动指定（切换后自动重启）：

| 模式 | 说明 |
|---|---|
| 自动（默认） | 正常启动；一旦检测到渲染失败就自动记下降级级别，下次启动逐级降级 |
| 硬件渲染 | 保持 Chromium 渲染沙箱（最安全，干净机器用这个） |
| **无渲染沙箱** | `--no-sandbox`。**兼容性最好**，受限环境/HIPS 拦截时首选 |
| 软件渲染 | 再额外关掉 GPU（`disableHardwareAcceleration` + `--disable-gpu`） |
| 单进程 | 再额外 `--single-process --in-process-gpu`：完全不创建子进程，兜底用 |

配置写在 `%APPDATA%\DSH Whale Desktop\config.json`，例如：

```json
{ "rendererMode": "no-sandbox", "clickThrough": true }
```

## 窗口、拖动与自动贴边

交互层的设计参考了 [BongoCat](https://github.com/vladelaina/BongoCat)（原生桌面宠物）的做法：

- **窗口只有一块**（默认 560×640），**刻意不铺满全屏**：全屏透明窗在切到"可交互"时会整屏变黑，
  而且窗口越大越容易抢鼠标。实测数据见下。
- **拖鲸鱼 = 移动窗口**（BongoCat 的 `window_drag_*`）：渲染层用 `screenX/screenY` 的增量驱动窗口，
  窗口跟着光标走，所以鲸鱼能放到屏幕任意位置。为了不和插件自己的拖拽各动各的，
  宿主用 CSS（`!important`）把 `.dshwv-root` **钉在窗口下沿**，插件写内联 `left/top` 会被盖掉。
- **鼠标穿透按渲染像素的 alpha 判定**（BongoCat 的 `window_visible_at_pointer`）：把鲸鱼素材画进
  离屏 canvas，命中时读该点 alpha，>8 才算"在鲸鱼身上"；菜单/面板这类不透明 UI 直接算命中。
  实测素材三角 alpha=0、中心 alpha=255 ⇒ 鲸鱼方框的空白处点击直接穿到桌面。
- **只在穿透状态真的变化时才调 `setIgnoreMouseEvents`**：这个调用会重写窗口的 `GWL_EXSTYLE`，
  **会抹掉 `WS_EX_TOPMOST` 位**（置顶失效）并可能让透明窗渲染成黑底 —— 这是之前"点一下就被压下去 /
  别的页面全黑"的根因。另外还在窗口失焦、显示、以及 2 秒心跳时重申一次置顶。
- **自动贴边**（托盘开关，默认开）：松手时算出鲸鱼本体在屏幕上的矩形，离左/右边缘 200px 内就
  **把鲸鱼本体贴到边缘**（不是贴窗口），同时把锚点切到那一侧，让菜单始终朝屏幕内侧开；贴左时整体镜像翻转。
  垂直方向只保证窗口完整可见 —— 插件把菜单渲染在鲸鱼上方且不做越界夹取，鲸鱼贴屏幕上沿会把菜单切掉。
- 托盘里仍可切换窗口范围（只占一块 / 右下一大块 / 整个工作区，最后一个带黑屏风险提示）。


## 屏幕自检

两个入口，结论都会写进日志并冒泡提示：

- 托盘菜单 → **屏幕自检（写报告 + 截图）**
- 命令行：`"DSH Whale Desktop.exe" --screencheck`（跑完自动退出，退出码 0 = 通过）

它会一次性检查并输出：窗口是否真的可见 / 位置尺寸 / 置顶 / 穿透与贴边开关、显示器工作区与缩放、
页面 origin 与视口、挂件 DOM 是否挂载、角色图是否加载、鲸鱼矩形、当前吸附模式、余额接口是否取到数，
并保存 `screen-check.json` + `screen-check.png` 到 `%APPDATA%\DSH Whale Desktop\`。

一次通过的输出长这样：

```
[screencheck]
结论：✅ 挂件已在屏幕上正常显示
窗口：visible=true bounds={"x":0,"y":0,"width":2048,"height":1280} 穿透=true 贴边=true
挂件：DOM=true 角色图已加载=true rect=[0,1030,250,250] 视口=[2048,1280]
吸附：mode=ratio
余额 ¥441.66，今日已用 ¥8.66
```

## 数据与安全

- 凭据读取顺序与 DSH 一致：**启动环境变量 → `$DSH_HOME/.credentials.yaml` 的 `refs` 段 → 项目 `.env` → `$DSH_HOME/.env`**。
  写入用「外科手术式行编辑」，只动 `refs` 里那一行，`records` 段与注释、排版原样保留（`npm run smoke` 有断言）。
  ⚠️ `resolve()` 必须返回 DSH 的 `{ value, source }` 结构（插件读 `cred.value`）；返回裸字符串会让余额接口拿到
  `Bearer undefined` → 401。
- 宿主 HTTP 只监听 `127.0.0.1` 随机端口，从不对外暴露；插件自带的回环/同源校验与写请求只认本机的规则原样生效。
- 桌面配置（开机自启、渲染模式、窗口范围、穿透、贴边等）在 `%APPDATA%\DSH Whale Desktop\config.json`，与 DSH 数据分开。

## 已知限制

- **会话类功能的实时性**：display 模式靠「会话日志 + 账本」推导，晚于 DSH 自身的实时事件
  （日志是追加写，账本在每轮结束时落盘），泡泡通常在同一秒内出现。
- **不修改插件**带来的取舍：display 模式接管的是两个**只读**接口；插件自身的路由表与写路径一点没动。
- **Electron 需要能启动渲染进程**：在某些受限/沙箱环境里 Electron 的渲染进程会被拒绝启动
  （表现为窗口空着）。此时可先用 `npm run render-check` 在系统浏览器里验证挂件本身是好的。
- 目前只在主屏/所选显示器的**工作区**内活动（不会覆盖任务栏）。

## 打包（已构建过，可重复执行）

已经产出（`dist/`）：

| 产物 | 说明 |
|---|---|
| `DSH-Whale-Desktop-portable-0.3.18.exe` | **免安装便携版**，双击即用 |
| `DSH Whale Desktop Setup 0.3.18.exe` | NSIS 安装包（可选安装目录、创建桌面快捷方式「小鲸鱼桌面挂件」） |
| `win-unpacked/` | 解包目录，便于排查 |

重新构建：

```powershell
npm run dist          # portable + nsis
npm run dist:dir      # 只出解包目录，最快
```

国内网络建议带上镜像（electron 与 electron-builder 的二进制都走 npmmirror）：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist
```

`vendor/` 会被一并打进 asar；托盘图标取自 `vendor/dsh-whale/assets/DSniang1.png`。

## 许可

上游插件为 MIT（见 `vendor/dsh-whale/LICENSE`）。本桌面壳同样是 MIT。

# dsh-desktop-bridge

在屏幕**右下角**弹 Windows 系统通知：会话**需要你确认**时一条，**任务完成**时一条。

一个插件搞定，没有配套桌面程序、没有第二个端口、没有发现文件、没有要手动启动的东西。

## 为什么是这两类时机

DSH 页面里的确认面板只在你**正看着 DSH** 时才有用。真正会丢消息的情况是反过来的——你在别的窗口忙，会话卡在等你批准，或者已经跑完了，而页面在后台。

所以这里只在两个**边沿**上打扰你：

- **需要你确认**：`pendingInteraction` 从无到有。`kind` 有 `approval`（批准操作）、`plan-review`（确认计划）、`question`（回答问题）三种，通知正文会写明是哪一种。
- **任务完成**：`running` 从 true 变 false。也看 `completionUnread`，但它**只对非主视图的会话**设置，只看它会漏掉「你正看着它跑完」这个最常见的情况。

首次观测到的会话只记基线不通知，否则一刷页面就会把所有在等的会话重播一遍。同一会话同一类型还有冷却，避免状态反复发布把提示刷屏。

## 架构

```
浏览器渲染进程                        宿主进程（DSH 自己）
──────────────                       ─────────────────────
uiSession.sessionStatus
   │ 订阅、比对、取边沿
   ▼
POST /__dsh-desktop-bridge/ingest
   │（同源，带 Bearer token）
   └───────────────────────────► 路由 → 调度器 → Toast
                                  （去重/免打扰/限流/AUMID）
```

会话状态只存在于**渲染进程**（`ui-session` 的宿主半边是个空 `apply() {}`），而发系统通知只能在**宿主进程**里做。所以两边必须有一次进程内通信——这就是那条 HTTP 路由的由来。

路由挂在 **DSH 自带的 web 服务器**上（`ctx.webServer.register`），不另开端口。浏览器端是同源请求，没有 CORS。

## 文件

| 路径 | 职责 |
|---|---|
| `lib/client.js` | 浏览器半边：订阅 `sessionStatus`、取边沿、POST 事件 |
| `lib/index.js` | 宿主入口：注册路由、注入 token、生命周期 |
| `lib/ingest.js` | 路由处理：鉴权、限体积、把载荷规范化成事件 |
| `lib/notifier.js` | 事件 → 通知：调度器、AUMID 预热、销毁 |
| `lib/host/toast.js` | 常驻 PowerShell 5.1 工作进程发 toast（预热后 0 延迟） |
| `lib/host/dispatch.js` | 去重、免打扰时段、焦点门控、限流 |
| `lib/host/aumid.js` | 注册 AUMID，让通知标题显示为「DSH 任务提醒」 |
| `lib/host/activate.js` | 把 DSH 窗口拉到前台（点通知时用） |
| `lib/host/state.js` | 日志与 `settings.json` |
| `lib/host/ps.js` | 守护式调用 PowerShell 5.1（PS 7 没有 WinRT，硬约束） |

## 路由

| 路由 | 认证 | 用途 |
|---|---|---|
| `POST /__dsh-desktop-bridge/ingest` | Bearer token | 浏览器端上报事件 |
| `GET /__dsh-desktop-bridge/health` | 无 | 存活探测 + 各阶段计数，不泄露任何内容 |
| `POST /__dsh-desktop-bridge/probe` | Bearer token | 仅在 `debug` 开启时：浏览器端把每次状态发布的内容记进日志 |

"同源"不等于"可信"——本机任何进程都能连 127.0.0.1。所以宿主每个进程随机生成一个 token，用 `webserver/index-inject` 注入进 index.html，`/ingest` 要求它作 Bearer 凭证，随进程消亡。

```js
globalThis.__DSH_DESKTOP_BRIDGE__ = { token: "…", protocol: 1, debug: false }
```

每次渲染 index 都会重新注入，刷新页面后 token 不会失效。

## 事件格式

```json
{
  "v": 1,
  "kind": "waiting",
  "sessionId": "abc123",
  "title": "重构登录模块",
  "detail": "等待你确认计划",
  "at": 1792206130837,
  "dedupeKey": "waiting:abc123:1792206130"
}
```

`dedupeKey` 由宿主按 `kind:sessionId:秒` 盖出来，浏览器端只管发前五个字段——重复投递由宿主识别。

`title` 取 `sessions.list` 的行投影，无标题时退化为 `会话 <前8位id>`。

`isMain` 由浏览器端补上（该会话是否正占据主视图）。宿主看得见窗口，但只有页面知道屏幕上摆的是哪个会话，焦点门控需要这一位——否则「你在看 DSH」会连带压掉其它会话的完成提醒。

## 提醒规则（`lib/host/dispatch.js`）

按顺序判定，先命中先返回：

1. **去重**：最近 200 条 `dedupeKey` 命中即丢弃
2. **免打扰**：`quietHours` 内只记日志
3. **焦点门控**（默认关闭）：**只门控 `done`**，且只在「该会话正是主视图那一个 + DSH 在前台」时压掉；`waiting` 从不门控，因为等待需要你动手，跟你在看什么无关
4. **限流**：同类最小间隔 3 秒，超限的攒成一条摘要（「另外 2 个会话也在等你」）

设置写在 `%LOCALAPPDATA%\dsh-desktop-notifier\settings.json`（改完重启 DSH 生效）：

```json
{
  "throttleMs": 3000,
  "suppressWhenFocused": false,
  "quietHours": { "enabled": false, "from": "23:00", "to": "08:00" },
  "debug": false
}
```

`suppressWhenFocused` 默认 **false**：一轮任务结束时页面本身不给任何提示，这正是这个插件存在的理由——默认静音会把它变成一个看起来坏掉的功能。`debug` 打开后浏览器端会把每次 `sessionStatus` 发布的快照 POST 到 `/probe`，用来判断「渲染进程到底有没有看见这次状态变化」。

## 没弹窗怎么查

日志在 `%LOCALAPPDATA%\dsh-desktop-notifier\notifier.log`，一条事件的完整生命线都会留下痕迹：

| 日志 | 含义 |
|---|---|
| 完全没有 `ingest:` | 事件没离开浏览器（渲染半边未订阅上，或 token 没注入） |
| `auth: POST /ingest rejected` | token 不匹配，通常是页面缓存了上一个进程的 token，刷新即可 |
| `ingest: done "…"` + `dispatch: shown` | 已交给系统，问题在 Windows 通知设置/专注助手 |
| `dispatch: suppressed (…quiet hours…)` | 免打扰窗口命中 |
| `dispatch: suppressed (…on screen and DSH is focused…)` | 焦点门控命中，把 `suppressWhenFocused` 改回 `false` |
| `dispatch: throttled` | 3 秒限流，事件攒成了摘要 |
| `dispatch: duplicate` | 同一事件重复投递，正常情况下不该出现 |

`GET /__dsh-desktop-bridge/health` 用计数器把这几段分开：`received`（到达宿主）→ `shown`（真的弹了）/ `suppressed`。

## 已知边界

- **没有逐条 todo 清单。** `todos` 是 session 作用域的 keyed projection，只有会话内的对话视图能读，这里拿不到。通知只能给会话级信号。
- **`title` 依赖投影就绪。** 会话刚建立时投影可能还没算出来，此时标题退化为 id 片段。
- **事件不落盘。** 通知是即时的，补发过时通知只会制造噪音。
- **通知标题「DSH 任务提醒」来自本机 AUMID 注册**，不是插件名。
- **Windows 专属。** toast 走 WinRT，只有 Windows 有。

## 出错时的行为

所有失败路径都只记日志、不抛异常。插件起不来**绝不能**拖垮 DSH——`apply` 抛错会触发红色「Failed to load plugins」横幅，还会连累同一 profile 的其它插件。

同样地，`lib/client.js` 必须保持 `window.__ModuleLoader__.load({ id, factory })` 的经典脚本信封：一个顶层 `export` 就会让渲染进程抛 `Unexpected token 'export'`，导致整个 web boot 失败（`web boot: 1 entry did not activate`）。这是本项目真实踩过的坑，`test/contract.mjs` 专门守着它。

## 测试

```bash
node test/contract.mjs    # 浏览器半边：信封格式、inject 完整性、边沿行为
node test/defaults.mjs    # 默认值与路由命名：默认静音这类回归由它守着
node test/host-apply.mjs  # 宿主半边：路由注册、token 注入、鉴权、去重
                          # 会真的弹一条通知，这是刻意的
node scripts/check-bundle.mjs    # bundle 静态契约
node scripts/verify-profile.mjs  # profile 接线是否完好
```

## 安装

```json
// <profile>/package.json 里
"dependencies": { "dsh-desktop-bridge": "link:D:/Workspace/DeepSeek Harness/dsh-desktop-bridge" },
"dsh": { "profile": { "bundles": ["…", "dsh-desktop-bridge"] } }
```

```yaml
# <profile>/cordis.patch.yml 里
- insert:
    - id: dsh-desktop-bridge
      name: dsh-desktop-bridge
```

改完需要重启 DSH（宿主半边不会热加载）。

## 许可

MIT

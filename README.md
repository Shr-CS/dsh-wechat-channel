# dsh-wechat-channel

微信公众号通道插件：**在微信里发指令操控 DeepSeek Harness，并把结果推回微信。**

> ## ⚠️ 两个实测踩到的坑（改了名字和路径就是为了避开它们）
>
> **1. 包名不能叫 `dsh-wechat`**
> npm 上已有一个同名第三方包 [`dsh-wechat`](https://github.com/pan17/dsh-wechat)（走腾讯 iLink bot 协议）。
> DSH 的插件世代系统**按名字解析依赖**：用 `dsh-wechat` 这个名字，
> 你的 `link:` 会被替换成 `.generations/live/dsh-wechat+<版本>` 的 junction，
> 加载的就不再是你写的那份代码了。本包因此命名 `dsh-wechat-channel`。
>
> **2. 路由不能占用 `/wechat/status`**
> 上面那个第三方包注册了 `/wechat/qr` 与 `/wechat/status`。
> DSH 的 webserver 对**重复路由直接抛错**（`duplicate exact route "..."`），
> 会让本插件的 effect 整体失败、插件**静默不激活**（没有明显报错）。
> 本插件因此使用独立前缀 **`/wechat-mp`**，两者互不干扰、可以共存。

```
微信 App ──发消息──▶ 腾讯服务器 ──HTTPS 回调──▶ cloudflared 隧道
                                                      │
                                               dsh-wechat 插件
                                                      │
                                    ① 立刻被动回复「已收到」（≤5 秒）
                                    ② 后台跑 DSH 会话（可能几分钟）
                                    ③ 客服消息接口把结果推回微信
```

---

## 一、先明确一条硬约束：微信回调**必须公网**

微信的消息回调是**腾讯的服务器**主动 POST 到你填的地址。发起方是腾讯机房，**不是你的手机**。所以：

- 回调地址必须**公网可达**，且是 **HTTPS + 有效证书**
- **局域网内手机和电脑同一个 WiFi 没有任何用**——腾讯照样连不上你的内网

因此：

| 场景 | 可用方案 |
|---|---|
| **公网** | 本插件（微信） |
| **局域网** | 用 `@linxin666/dsh-remote-web-ui` 的手机浏览器方案（扫码配对 + 完整 GUI），本插件不覆盖 |

这两条路不是替代关系，是互补的。局域网里想用手机操作 DSH，请走 remote-web-ui。

---

## 二、安装

**从 npm 安装（推荐）**

```bash
dsh plugin --profile web add dsh-wechat-channel
```

**从本地目录安装（开发用）**

```bash
dsh plugin --profile web add link:<本目录绝对路径>
```

DSH Desktop 的 pnpm runner 会自动把 `dsh-wechat-channel` 注册进 `dsh.profile.bundles`。
新装的 bundle 需要**重启 `dsh web`** 才会加载（`patchReload: live` 只对补丁层生效，不管新包）。

> ### ⚠️ 为什么包名不叫 `dsh-wechat`
>
> npm 上已有一个同名第三方包 [`dsh-wechat`](https://github.com/pan17/dsh-wechat)（走腾讯 iLink bot 协议）。
> DSH 的插件世代系统**按名字解析依赖**：如果你把本包命名成 `dsh-wechat` 并用 `link:` 装进去，
> DSH Desktop 会在加载失败时触发「插件恢复」，去 npm 装那个同名包顶上，
> 你的 `link:` 会被替换成 `.generations/live/dsh-wechat+<版本>` 的 junction，
> 加载的就不再是你写的那份代码了。本包因此命名 `dsh-wechat-channel`。

## 三、配置

在 profile 的用户补丁层 `<DSH_HOME>/profiles/web/cordis.patch.yml` 里写：

```yaml
- id: wechat
  config:
    # 必须与公众号后台「服务器配置」里填的 Token 完全一致
    token: 你自定的一个字符串
    # 测试号页面上的 appID / appsecret（异步回复必需）
    appId: wx********
    appSecret: ********
    # 回调路径。刻意避开 /wechat —— 第三方包 dsh-wechat 注册了 /wechat/status，
    # DSH 的 webserver 对重复路由直接抛错，会让本插件整个激活失败。
    path: /wechat-mp
    # 允许下指令的 openid 白名单（见下）
    allowFrom: []
    requireWhitelist: true
    agentPreset: standard
    turnTimeoutMs: 600000
    diagnostics: true
```

> `Token` 是**你自己编的**，不是微信给你的。3–32 位字母数字下划线。

## 四、接上公网

任意隧道都可以，本项目自带 `cloudflared` 二进制（`bin/cloudflared.exe`）。

**注意：国内网络下 QUIC(UDP) 常被阻断**，会表现为隧道注册成功但立刻返回 502/530，日志里刷
`datagram manager error: timeout: no recent network activity`。加上 `--protocol http2` 走 TCP 即可：

```bash
bin/cloudflared.exe tunnel --url http://127.0.0.1:<dsh web 端口> --no-autoupdate --protocol http2
```

拿到 `https://xxxx.trycloudflare.com` 后，公众号后台填 `https://xxxx.trycloudflare.com/wechat-mp`。

> ⚠️ `trycloudflare.com` 地址是**临时的**，重启就变。微信要求回调 URL 稳定，
> 正式使用请用固定域名（`@linxin666/dsh-remote-web-ui` 自带的固定域名中继，或自有域名的命名隧道）。

## 五、第一次使用

1. 后台「服务器配置」填 URL 与 Token，点提交 → 应显示**配置成功**（插件日志会打印「验证通过 ✓」）
2. 用微信**关注测试号**，随便发一句话
3. 插件会回信告诉你的 **openid**，把它填进 `allowFrom`
4. 重启后即可正常下指令

`allowFrom` 为空时**所有人都被拒绝**，这是刻意的安全默认。

## 六、安全模型

**配对设备 = 完全控制凭据。** DSH 的 agent 能执行命令、读写你的文件，而这个插件把它暴露到公网。

- `allowFrom` 白名单是**唯一**准入控制，请保持 `requireWhitelist: true`
- 回调入口有签名校验（SHA1 + 定长比较），错误签名一律 403
- 状态端点 `/wechat-mp/status` 需要 `?key=<token>`，且**绝不回显 token**
- 只把你自己的 openid 加进白名单

## 七、分层结构

| 文件 | 职责 | 依赖 |
|---|---|---|
| `lib/protocol.js` | 微信签名、XML 解析与组装 | **零依赖** |
| `lib/server.js` | HTTP 路由处理 | 仅 protocol.js |
| `lib/wechat-api.js` | access_token 管理 + 客服消息推送 | fetch 可注入 |
| `lib/bridge.js` | 微信消息 ↔ DSH 会话 | agent 形状可注入 |
| `lib/index.js` | Cordis 胶水：配置、服务装配、生命周期 | schemastery |

刻意这样分层，是为了让前四层都能**脱离 harness 单独测试**。

## 八、测试与工具

```bash
npm test          # 82 项
```

覆盖：签名排序、CDATA 注入、白名单、5 秒死线、token 缓存与并发去重、失效重试、
长文分条、每用户串行、超时取消、会话淘汰，以及**完整的异步链路**
（微信消息 → 回执 → 后台跑 DSH → 客服消息推送）。

排查工具：

```bash
node tools/sign.js <token> /wechat-mp ECHO   # 生成带正确签名的回调 URL
node tools/mock-wechat-server.js             # 假微信服务端，接收并记录推送
```

## 九、状态端点

```
GET <path>/status?key=<token>
```

默认即 `/wechat-mp/status`（`path` 跟配置走）。返回配置状态、白名单、会话数、模型路由，
以及最近的会话事件时间线（由 `diagnostics` 控制）。
排查「消息发出去了但没反应」时这个端点最有用。

## 十、踩过的坑（都已在代码里注释说明）

1. **`[hidden]` 被作者样式覆盖**（在 WordMaster 项目里）——提醒同类问题
2. **微信签名是「值的字典序」**，不是参数顺序
3. **公众号被动回复只有 5 秒**——必须先回执再异步推送
4. **`resume` 的参数是 `resumeSessionId`**，传 `sessionId` 会静默走错分支
5. **消息必须带 `role: 'user'` 与唯一 `id`**，否则进得了收件箱却成不了模型输入
6. **不要在 setup 上下文里访问 `sessionCtx.agent`**——没注入 `agent` 服务，Cordis 会抛
   `cannot get property "agent" without inject`，导致**每一轮 turn 都以错误结束**、
   step 空转、日志里既没有 `user/message` 也没有 `request/header`。
   这个 bug 耗时最久，最终靠插件自己的事件诊断监听器才抓出来。

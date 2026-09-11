# Key 端点下发设计（F11 最小版 · M5-A 第一项）

- **日期**: 2026-09-11
- **状态**: 待评审
- **上游**: `docs/plans/2026-09-05-voicepilot-prd.md`（PRD §5.8 / §5.9 / §8 M5-A）
- **范围**: 客户端不再由人工分发 DashScope Key，改为运行时从公司内网 HTTPS 端点取回。含一个最小服务端。**不含**按人 token、设备白名单、配置版本化多环境、F11 的其余配置下发（词表/默认快捷键）——那些留 M5-B。

## 0. 已拍板的关键决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 服务端由谁写 | **服务和客户端都本项目写**；部署由用户做 | 用户拍板 |
| token 模型 | **一个共享 token，构建时打包进客户端**（方案「甲」） | 用户拍板：内网环境可接受；正式版会做登录体系，这是临时桥 |
| 真正的访问控制 | **内网边界**（端点仅公司内网可达）。token 是第二道，不是主控制 | 同上 |
| 端点用什么 | **必须是 HTTPS**，内网也不放宽 | Key 明文过网不可接受（PRD §5.9） |
| 端点契约 | `GET /config` + `X-VP-Token` 头，返回 `{version, apiKey, workspaceId}` | 本设计 §2 |
| 拉取时机 | 启动时**后台拉取，不阻塞**；本地有缓存就先用缓存 | 端点挂掉应用仍要能用（PRD A11 精神） |
| 手填 Key 窗口 | **保留，但降级为托盘菜单里的隐藏兜底入口**（给管理员/自己排查用）。试用者拿不到 Key，给他手填表单也没用——端点失败时给他的是「一句明确提示 + 重试」 | 试用期端点故障时不改代码即可自救 |
| token 与端点地址 | **不进 git**，打包时注入 gitignore 的 `endpoint.built.json` | 写死在源码里 = 令牌永久留在 git 历史 |

### 明确接受的代价（不修）

1. **包外泄 = token 外泄**。拿到安装包的人可解出 token，从而换到 Key（前提是能访问内网端点）。
2. **换 token 要重新发包**。因此「轮换 Key」由服务端完成（有效），「轮换 token」需重新打包。
3. **客户端取回 Key 后必然持有明文**，有本机权限的人可提取。要根治只有服务端代理，本期不做。

> 这三条是被「内网 + 正式版做登录」这个前提换掉的。**不要**在后续 review 里把 1/2 当缺陷——它们是已接受的权衡。若将来试用范围超出内网，先回头改这里。

## 1. 组件与文件

**新增**

| 文件 | 职责 |
|---|---|
| `app/electron/config-endpoint.js` | 客户端唯一负责「拿 token 换凭据」的模块。将来 F11 全套或登录体系来了，直接替换它 |
| `app/electron/endpoint.example.json` | 配置样例（提交进 git，值为占位） |
| `app/electron/endpoint.built.json` | 真实端点地址 + token（**gitignore**；打包前由人工/CI 生成） |
| `app/electron/selftest/config-endpoint.js` | 离线自测：本地起 mock 端点，断言五条路径 |
| `app/scripts/prepack-check.mjs` | 打包前置检查：`endpoint.built.json` 缺失或字段不全则非零退出、报明确错误 |
| `server/config-endpoint/server.js` | 服务端：Node 原生 `http/https`，`GET /config` 校验 token 返回 JSON |
| `server/config-endpoint/README.md` | 一句话部署说明（怎么起、Key 从哪读、怎么轮换） |

**修改**

| 文件 | 改动 |
|---|---|
| `app/electron/asr/config.js` | 凭据来源链改为 `.env`(仅开发) → 本地缓存 → 端点；新增 `refreshFromEndpoint()` / `bootstrapCredentials()` |
| `app/electron/main.js` | 启动改用 `bootstrapCredentials()`；托盘菜单加「重新获取授权」；无凭据时用 `dialog.showMessageBox` 给提示 + 重试 |
| `app/electron/ipc.js` | 仅一处：`vp:key/save` 把 `saveCredentials` 抛出的硬编码中文错误转成 i18n 文案。**不新增通道**（兜底窗口沿用现有 `vp:key/*`） |
| `app/package.json` | `dist:win` / `dist:win:portable` / `dist:mac` 前置 `node scripts/prepack-check.mjs` |
| `shared/i18n/*` | 新增提示文案 key（三语）：三类错误提示、「重新获取授权」托盘项 |
| `.gitignore` | 加 `app/electron/endpoint.built.json` |
| `README.md` | 补一节「Key 下发（内网端点）」 |
| `docs/plans/2026-09-05-voicepilot-prd.md` | §5.9 补最小版契约 |

**渲染进程零改动** —— 方案甲对试用者是完全无感的：装完就能用，没有任何新窗口、新字段。

## 2. 端点契约

```
GET <endpoint>          ← endpoint 字段本身即完整 URL（…/config），客户端原样请求，不做任何路径拼接
X-VP-Token: <token>

200 → {"version": 3, "apiKey": "sk-…", "workspaceId": "…"}
401 → {"error": "unauthorized"}
5xx / 其他 → 客户端按 bad-response 处理
```

> **`endpoint` 是完整 URL，不是 base 地址。** 客户端直接把该字段当作请求目标
> （`fetch(config.endpoint)`），**不会**再拼 `/config`。所以配置里必须写
> `https://host/config` 这种带路径的完整地址，写成 `https://host` 会让每台客户端 404。
> `prepack-check.mjs` 会在打包前校验「可解析 + 有主机名 + pathname 以 `/config` 结尾」，拦住这类包。

- `version`：**单调递增整数**（配置版本）。客户端把它记进 SQLite `meta` 表的 `config_version`，**只用于日志与统计**（「还有多少台机器在用哪个版本的 Key」）——客户端**不做版本比较**，每次 200 都覆盖缓存，省掉一套 diff 逻辑。
- 服务端从**自己的环境变量**读 Key（`VP_DASHSCOPE_API_KEY` / `VP_DASHSCOPE_WORKSPACE_ID` / `VP_CONFIG_TOKEN`），不落盘、不进代码。
- 响应不签名、不加密传输之外的内容。**明确不做**：响应签名、防重放、限流（超范围）。

## 3. 数据流

凭据来源链：**`.env`（仅开发）→ 本地缓存 `credentials.json` → 端点**。

**启动**
```
bootstrapCredentials()
  ├─ loadDevEnv() 命中（仅 !app.isPackaged）→ 直接返回 true，不碰端点
  ├─ 本地缓存命中 → 返回 true，并后台触发 refreshFromEndpoint()（不 await）
  └─ 无任何来源 → await refreshFromEndpoint()（3s 超时）
        ├─ 成功 → 写缓存 → true
        └─ 失败 → false → 主进程弹 dialog：「未获取到授权，请联系管理员」+「重试」按钮
                  （给试用者的是一句提示 + 重试，不是手填表单——他本来就没有 Key）
```

**成功路径**：`refreshFromEndpoint()` → 200 → 校验 `apiKey` 以 `sk-` 开头、`workspaceId` 非空 → `safeStorage` 写 `credentials.json` → `setMeta('config_version', version)`。

**兜底路径**：托盘菜单「重新获取授权」→ 手动触发 `refreshFromEndpoint()`；成功静默（打日志），失败弹 `dialog.showMessageBox` 显示原因 + 「重试」。启动时无凭据的提示走**同一个 dialog、同一套文案**，不另写一套。

**手填 API Key 的入口**：留在托盘菜单里（沿用现有 `createKeyEntryWindow`），只给管理员/开发自查用，**不出现在启动路径上**。

**缓存优先的取舍**：只要 `credentials.json` 里有可用凭据，端点失败一律**静默沿用缓存**，只在日志里记。只有「无任何可用凭据」才打扰用户——否则每次网络抖动都弹窗，试用体验会崩。

## 4. 错误处理

三类错误，各自一句人话提示（走 i18n，**不再出现硬编码中文** —— `saveCredentials` 现有那句中文字面量顺手一并收编）：

| 类别 | 触发 | 提示 |
|---|---|---|
| `network` | 超时（3s）、DNS/连接失败、证书失败 | 「未获取到授权，请联系管理员」（仅在无缓存时可见） |
| `unauthorized` | 401 | 「授权已失效，请联系管理员」 |
| `bad-response` | 非 200/401、JSON 解析失败、字段缺失或不合法 | 「授权信息异常，请联系管理员」 |

- 证书失败由既有 `tls-ca.js`（并入系统信任 CA）覆盖；若公司 CA 已在系统钥匙串里被信任，则无需额外配置。
- `credentials.json` 解密失败（换签名/换机器）沿用现状：当作无缓存，走端点重新拉取。
- 用户可见的提示**统一走 `dialog.showMessageBox`**（Electron 内置，零新增依赖）。不搭 toast、不用通知中心——3–5 人的试用不值得再引入一套通知机制。

## 5. 配置注入（构建期）

`app/electron/endpoint.example.json`（提交进 git）：

```json
{ "endpoint": "https://voicepilot.example.internal/config", "token": "REPLACE_ME" }
```

> 注意 `endpoint` 是**完整 URL**（含 `/config`），不是 base 地址——客户端不做路径拼接，见 §2。

打包流程：

1. 人工/CI 把真实值写进 `app/electron/endpoint.built.json`（同结构，**gitignore**）
2. `npm run dist:*` 先跑 `prepack-check.mjs`——文件缺失、字段为空、token 仍是 `REPLACE_ME`、或 `endpoint` 不是 `https://` 完整 URL（不可解析 / 无主机名 / 路径不以 `/config` 结尾）都直接失败并打印怎么修
3. `files` 已含 `electron/**/*`，该文件随包进 `app.asar`

开发模式不读它（`.env` 优先级更高），因此本地开发无需这个文件。

## 6. 服务端

`server/config-endpoint/server.js` 单文件，无框架、无数据库：

- 读环境变量：`VP_CONFIG_TOKEN`、`VP_DASHSCOPE_API_KEY`、`VP_DASHSCOPE_WORKSPACE_ID`、`VP_PORT`（默认 8443）、`VP_TLS_CERT` / `VP_TLS_KEY`
- `GET /config`：`X-VP-Token` 不匹配 → 401；匹配 → `{version, apiKey, workspaceId}`；其他路径 → 404
- `version` 取 `VP_CONFIG_VERSION`（默认 `1`）——**换 Key 时把它加一**，客户端才会覆盖缓存
- TLS：直接用公司签发的证书起 HTTPS；若前置了内网网关，则设 `VP_PORT` 为回环端口、由网关转发
- 启动方式与轮换步骤写进 `server/config-endpoint/README.md`（一句话级别的说明，不做部署自动化）

## 7. 测试

**自测 `VP_CONFIG_SELFTEST=1`** —— 沿用现有离线自测模式（不建窗口、跑完即退、用退出码表达成败），在 `app/electron/selftest/config-endpoint.js` 里本地起 mock 端点（`127.0.0.1` 随机端口），断言：

1. 200 且字段合法 → 写入缓存、`config_version` 落库、返回成功
2. 401 → 归为 `unauthorized`，不写缓存
3. 连接被拒 / 超时 → 归为 `network`；**此时若已有缓存，`loadCredentials()` 仍返回旧值**
4. 无缓存 + 端点失败 → `bootstrapCredentials()` 返回 false（即「该弹提示 dialog」）
5. 200 但字段不合法（缺 `workspaceId`、`apiKey` 不以 `sk-` 开头）→ 归为 `bad-response`，不写缓存

**服务端自测**：`server/config-endpoint/` 下加一个 `test.mjs`，起服务后断言 401 / 200 / 404 三个响应与字段。

**前置**：`main.js` 的 selftest 分发链要加 `VP_CONFIG_SELFTEST` 分支（现有链是 `VP_ASR_SELFTEST ?? VP_SM_SELFTEST ?? …` 的形式）。同时 `preload.cjs` 无需改动（自测不经过渲染进程）。

## 8. 待验证点（代码中留注释）

1. **真实内网端点的证书是否被客户端信任** —— 若证书链由公司 CA 签发且该 CA 已装进系统钥匙串，`tls-ca.js` 应已覆盖；须在真机发一次请求确认。若失败，先查根证书是否被信任，**不要**改成 `rejectUnauthorized:false`。
2. **端点地址与 token 的实际值**由用户提供，本设计只定义格式。
3. **谁来部署、机器在哪、怎么保证开机自启** —— 属用户侧，`server/config-endpoint/README.md` 给示例命令，不做自动化。

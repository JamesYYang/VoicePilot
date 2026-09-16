# 发版清单（复验 → 部署端点 → 打包 → 分发）

> **用途**：一次「从复验到把包发给同事」的**执行顺序**。这事跨三台机器（Windows 开发机 / 公司 Mac / 内网服务端），
> 把命令、闸门与突发处置收在一处，免得来回翻文档。
>
> **细节不在这里**（避免多份文档漂移）：Mac 上的用例步骤 / 预期 / 失败判据全在
> [`macos-test-runbook.md`](macos-test-runbook.md)（阶段 0–6）；端点服务端见
> [`../server/config-endpoint/README.md`](../server/config-endpoint/README.md)。本文件只给**顺序、命令、闸门与处置**。
>
> **本次执行日**：2026-09-16 —— 验的是 `2590057` 那批 macOS 采纳写回修复（+ `40d1655` 文档同步），目标是首次发出可用的试用包。
>
> **✅ 执行结果（2026-09-16）：全部走通，无一项触发第五节的处置。**
>
> - **第 0 步**：已 push，Mac 上 `git pull` 后 `git log -1` = `2996dc7`（含本清单本身），期望的 `40d1655` 或更新成立。
> - **一、Mac 复验**：阶段 0 门禁与手册预期**完全一致**（`tsc` 干净、SM **77**/77、STORE / SHORTCUT / I18N 全过、INJECT **24**/24、UI **138**/138、BAR **17**/17）；阶段 1–4 通过；**阶段 5（打包 `.app`，从 Finder 启动）通过**。
> - **5.2 降级触发点未触发**：打包版 `.node` 能 `dlopen`，**没有**加 `afterPack` 的 adhoc 签名。→ Plan 2B 的 macOS 侧按「完整实现」收口，不做纯剪贴板降级。
> - **6.1**：打包版**不弹**「设置 API Key」表单。
> - **二、端点**：内网端点已部署，`/config` 带 token 200 / 不带 401 如期。
> - **三、四、打包与分发**：Windows（`dist:win:portable`）与 Mac（`dist:mac` → `VoicePilot.app` + dmg）均已打出，**两条平台的包都已发给同事**。
> - **没有需要特别记录的观察项**：深链可跳到辅助功能页、授权后无需重启即生效、终端与 Dock 行为、右下角点击均符合预期。
> - 逐条回填见 §七；细粒度结论在四本手册的状态表里。

---

## 第 0 步：出发前（Windows 侧，5 分钟）

- [x] **`git push`**。不推的话 Mac 上 `git pull` 只能拿到旧代码，你会测到**修之前**的版本。
      核对：`git log --oneline origin/main..HEAD` 应为空。
- [x] 备好 **`app/electron/endpoint.built.json`**：`endpoint` 必须是**完整 URL 含 `/config`**
      （写成 `https://host` 会每台机器 404）+ 真 token。
      ⚠️ 该文件在 `.gitignore`，**不跟 push 走** → **打包的那台机器上必须各有一份**（Windows 与 Mac 都要）。
- [x] 备好服务端材料：`VP_CONFIG_TOKEN` / `VP_DASHSCOPE_API_KEY` / `VP_DASHSCOPE_WORKSPACE_ID` /
      TLS 证书与私钥路径 / `VP_CONFIG_VERSION`。
- [x] 定好内网域名与端口（默认 `8443`）。

---

## 一、Mac 复验（**先验后打，顺序别倒**）

| # | 做什么 | 闸门 / 坑 |
|---|---|---|
| 1 | `git pull` → `git log --oneline -1` | 期望 `40d1655` 或更新。**若仍是 `e99065e` 就停下**，别往下走（第 0 步没生效） |
| 2 | `cd app && npm install`；仓库根放 `.env` | 开发模式需要 |
| 3 | **阶段 0 门禁** | `tsc` 干净；**SM 77** / STORE / SHORTCUT / I18N / **INJECT 24**；再 **先 `npm run build`** 后 **UI 138** / **BAR 17**。⚠️ 漏 build 会拿旧产物跑出「假绿」 |
| 4 | **阶段 2（最重）** | **2.3** 采纳后**不点鼠标**就能继续打字 / **2.6** 连按快捷键**不吃掉**下一次听写 / 2.1 未授权→授权（记深链能否跳到）/ 2.2 应用矩阵 |
| 5 | 阶段 3 抽查 | 3.1 选择器拿到键盘 / 3.2 焦点归还 / 3.3 常用语→采纳 |
| 6 | 阶段 4 | 4.1 贴边不漂移 / 4.2 穿透 |
| 7 | **打包 + 阶段 5**（当天的分水岭） | 放好 `endpoint.built.json` → `npm run dist:mac` → **从 Finder 启动**（不要从终端起） |

阶段 5 必须逐项看的四条：

- **5.2 打包版 `.node` 能否 `dlopen`** —— **降级决策的触发点**。过不去就**停下来回头改设计**
  （退回纯剪贴板方案），不要硬上、也不要硬发。
- **5.3** 焦点类四条：2.3 / 3.1 / 3.2 / 采纳后光标是否留在目标。
- **5.5** 打包版勾的是 **VoicePilot**（不是终端 / Electron）。
- **6.1** 打包版**不弹**「设置 API Key」表单；终端日志里 `[授权] 凭据来源=endpoint`。

---

## 二、部署端点（内网机器）

```bash
export VP_CONFIG_TOKEN='<发给客户端的 token>'
export VP_DASHSCOPE_API_KEY='sk-…'
export VP_DASHSCOPE_WORKSPACE_ID='<业务空间 ID>'
export VP_CONFIG_VERSION=1
export VP_TLS_CERT=/etc/ssl/voicepilot/fullchain.pem
export VP_TLS_KEY=/etc/ssl/voicepilot/privkey.pem
export VP_PORT=8443
node server/config-endpoint/server.js        # 建议照 README 配 systemd 开机自启
```

- [x] ⚠️ **没配证书时服务是裸 HTTP 且只绑 `127.0.0.1`** —— 网关不在同一台机器上就**必须**配证书。
      Key 明文过网不可接受，内网也不放宽。
- [x] 前台验证：`curl -H "X-VP-Token: $VP_CONFIG_TOKEN" https://<内网域名>/config`
      → 期望 **200 + JSON**；`curl https://<内网域名>/config` → 期望 **401**。
- [x] 自测：`node server/config-endpoint/test.mjs`。
- [x] **顺序**：把这一步放在**打包之前** —— 这样打包后的冒烟能顺带把 6.1（不弹 Key 表单）验掉。

---

## 三、打包 Windows

```bash
cd app
npm run dist:win:portable     # 发同事用便携单文件版；要安装包则 npm run dist:win
```

- `prepack-check` 会拦住缺失 / 占位 / 非 https / URL 形态不对 —— 宁可在这里失败一次，
  也不要打出一个「装完拿不到 Key」的包。
- [x] 在**干净机器**上冒烟一次：双击即用、**不弹** Key 表单、说一句能上屏。

---

## 四、打包 Mac + 分发

- 产物：`app/release/mac*/VoicePilot.app` + `VoicePilot-0.1.0.dmg`（由阶段 5 的 `dist:mac` 打出）。
- [x] 未做 Developer ID 签名与公证 → **首次打开要「右键 → 打开」**，这条必须写进发给同事的消息里。

**给同事的消息里必须有三条**：

1. **Mac**：首次打开「右键 → 打开」（未签名，绕过 Gatekeeper）；
2. **Mac**：去「系统设置 → 隐私与安全性 → 辅助功能」**手动勾上** VoicePilot，否则全局快捷键不生效；
3. **Windows**：SmartScreen 提示「未知发布者」→ 点「**仍要运行**」。

> ⚠️ **只发安装包，不发 Key。** Key 由客户端启动时从内网端点自动取回。
>
> ⚠️ **试用期收不到日志**：遥测（F10）与诊断导出（F13）都还没做。请同事反馈时**附上条上的提示原文 + 截图**
> —— 提示文案直接对应内部 `reason`，是现在唯一的现场证据。

---

## 五、突发情况 → 处置

| 现象 | 处置 |
|---|---|
| Mac `git pull` 后 `git log -1` 还是 `e99065e` | push 没生效。回 Windows 侧看 `git log origin/main..HEAD` 是否为空 |
| 打包时 `prepack-check` 失败 | `endpoint.built.json` 缺失 / 含占位 / 非 https / URL 少了 `/config` |
| **打包版启动报 koffi 加载失败** | **★降级触发点**。先试 `afterPack` 里对 `.node` 做 adhoc 签名（`codesign -s -`）；仍不行 → 退回纯剪贴板方案，**当天不要硬发** |
| 打包版弹「设置 API Key」 | 端点不可达 / token 不匹配 / 证书问题。查内网与代理；托盘「重新获取授权」可手动重试 |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 公司 CA 没进系统信任库。**不要**改成 `rejectUnauthorized:false` |
| Mac 快捷键不生效 | 辅助功能勾错对象：开发模式勾**终端 / Electron**，打包版勾 **VoicePilot** |
| 采纳没写回 | 用 `VP_INJECT_DEBUG=1` 起，看「编排结果 / 发键: pid=…」日志行，`reason` 对照 [`adopt-injection-test-runbook.md`](adopt-injection-test-runbook.md) §二 |
| 采纳后**要先用鼠标点一下**才能打字 | 缺陷②复现。查三处：① 条在 `idle` 是否**真的 `hide()`** ② 焦点归还是否在拆编辑区**之后** ③ 有无 `[采纳] 拆条两帧…` 告警（有 = 帧被饿死、走了 1500ms 超时后路） |
| 连按快捷键吞掉下一次听写 | 抓 `vp:adopt/close` 返回的 `closed`；`false` 是**预期行为**（状态已被用户抢走），不是漏关条 |
| 条挡住屏幕右下角的点击 | 三步法：从托盘退出 VoicePilot 再点同一个按钮 —— 变好 = 确实是我们挡的；不变好 = 另有成因 |
| 授权后仍报 `permission` | 试重启应用，并**记下是否需要重启才生效**（手册明确要求记这条） |

---

## 六、时间不够时的优先级 / 明确不做

**优先级**：`5.2`（降级触发点）> `2.3` / `2.6` > `6.1` > 阶段 3 抽查 > 阶段 0 里的 BAR。
门禁保底：`tsc` + `SM` + `INJECT`。

**今天不要碰**（设计里已拍板的代价，看到不要当缺陷报，见
`docs/superpowers/specs/2026-09-12-trial-feedback-design.md` §0）：

- 「不抢焦点」只保证**聆听期**；
- 注入的天花板：管理员权限窗口（UIPI）、终端与特殊控件的粘贴行为、中文 IME 组字态；
- `flash` 模型相对 `pro` 的质量权衡（速度优先，代价未量化）；
- 开机启动、诊断导出（F13）、遥测（F10）**都不在当天的范围**。

---

## 七、收尾：回填状态表

跑完按项目惯例把结论回填，避免下次又分不清「验过没有」：

- [x] [`macos-test-runbook.md`](macos-test-runbook.md) 的阶段表 / §八
- [x] [`adopt-injection-test-runbook.md`](adopt-injection-test-runbook.md) §一（采纳写回状态表 + §十判据）
- [x] [`common-phrases-test-runbook.md`](common-phrases-test-runbook.md) §一（F16 状态表 + §十判据）
- [x] [`plans/2026-09-05-voicepilot-prd.md`](plans/2026-09-05-voicepilot-prd.md) §8 的进度条目
- [x] 若阶段 5 这次真的跑了：把上述文档里**「阶段 5 未做」/「控制台启动，替代不了」**那几处**翻过来**
      （检索这两个串即可定位）

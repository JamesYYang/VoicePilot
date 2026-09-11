# 配置端点（F11 最小版）

拿 token 换 DashScope 凭据的内网 HTTPS 端点。设计见
`docs/superpowers/specs/2026-09-11-key-delivery-design.md`。

## 起服务

```bash
export VP_CONFIG_TOKEN='<发给客户端的 token>'
export VP_DASHSCOPE_API_KEY='sk-…'
export VP_DASHSCOPE_WORKSPACE_ID='<业务空间 ID>'
export VP_CONFIG_VERSION=1
export VP_TLS_CERT=/etc/ssl/voicepilot/fullchain.pem
export VP_TLS_KEY=/etc/ssl/voicepilot/privkey.pem
export VP_PORT=8443
node server/config-endpoint/server.js
```

> **明文回退仅限本机。** 未设置 `VP_TLS_CERT` / `VP_TLS_KEY` 时，服务以裸 HTTP 启动且**只绑定 `127.0.0.1`**，仅同机前置网关可达。网关不在同一台机器上时**必须**配置证书——Key 明文过网不可接受，内网也不放宽。

前台验证：

```bash
curl -H "X-VP-Token: $VP_CONFIG_TOKEN" https://<内网域名>/config
# 期望 200 + {"version":1,"apiKey":"sk-…","workspaceId":"…"}
curl https://<内网域名>/config
# 期望 401
```

开机自启（systemd 示例）：

```ini
[Unit]
Description=VoicePilot config endpoint
After=network.target
[Service]
EnvironmentFile=/etc/voicepilot/config-endpoint.env
ExecStart=/usr/bin/node /opt/voicepilot/server/config-endpoint/server.js
Restart=always
[Install]
WantedBy=multi-user.target
```

## 轮换 Key

1. 改 `VP_DASHSCOPE_API_KEY`
2. **`VP_CONFIG_VERSION` 加一**
3. 重启服务

客户端下次启动即拉取新 Key（客户端不做版本比较，每次 200 都覆盖缓存；version 只用于日志与统计）。

## 轮换 token

改 `VP_CONFIG_TOKEN` → 重启服务 → **重新打包客户端并重发**（token 是打包时注入的，这是已接受的代价）。

## 自测

```bash
node server/config-endpoint/test.mjs
```

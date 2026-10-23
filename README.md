# ModelPort

**一个跑在自己机器上的模型口岸：独立 Web 控制台、本地 URL、API Key，任意 Agent 都能接。**

「口岸」是它实际在做的事：模型从各条渠道进来，统一在一处落地，再由一个本地地址发出去。
客户端只认一个 Base URL 和一把 Key，不必知道背后是哪家渠道、哪次登录。

它把模型来源合并成同一份清单，用同一个端口同时说 **OpenAI Chat Completions**、
**OpenAI Responses**、**Anthropic Messages** 三种协议：

| 模型来源 | 需要什么 | 说明 |
| --- | --- | --- |
| **账号渠道** | 每个渠道登录一次 | **13 家**：CodeArts、CodeBuddy、WorkBuddy、LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini |
| 降级链路 | — | 把渠道模型串成 `combo:xxx` 虚拟模型，前一环失败自动换下一环 |

> **只有这两条来源。** 早先版本还有匿名免费车道（opencode.ai）、Kilo 免费池，以及用自己
> Key 接入的 75 家聚合提供商；三者都已移除，连同为它们服务的请求指纹、可用性探测与
> 上游出口代理。现在模型只来自你自己登录的渠道——代价是装好之后要先登录，收益是不再
> 依赖任何“别人家的免费额度”。

> 本项目的引擎源自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT），
> 在它的基础上做成独立的本地服务：去掉了宿主插件形态与 EAC 协付车道。
> 来源与逐条改动见 [NOTICE.md](NOTICE.md)。

---

## 快速开始

### 前置

只需要 **Node.js**：`^22.19.0 || >=24.0.0`（`node --version` 看一眼）。

### 第一步：拿到代码

```bash
git clone https://github.com/2025101234/modelport.git
cd modelport
```

### 第二步：装控制台的构建依赖

**只有这一步需要联网装包**，而且只影响控制台界面；推理服务本身零依赖。

```bash
npm install --prefix app --ignore-scripts
```

> 仓库里已经带了构建好的 `app/web/`，所以**这一步可以跳过**——除非你改了 `app/ui/` 下的界面源码。
> 跳过它，`node app/cli.mjs` 一样能跑，只是界面停在仓库里那一版。

### 第三步：启动

```bash
node app/cli.mjs
```

终端会打印四行：

```
modelport 1.0.0
管理页面（10 分钟内一次性登录）：http://127.0.0.1:18900/#login=<一次性令牌>
API：http://127.0.0.1:18900/v1
API Key 保存在：~/.modelport/settings.json
```

### 第四步：打开控制台

把第二行那个**完整链接**（带 `#login=...`）粘进浏览器。它会自动登录并跳转到控制台。

- 这个链接 **10 分钟内有效、只能兑换一次**；
- 兑换后换成 **8 小时的会话 Cookie**，期间刷新页面不用重新登录。

#### 10 分钟后会怎么样

链接本身失效，但**你不会被关在门外**——有三条路进来，只有第一条会过期：

| 方式 | 有效期 | 说明 |
| --- | --- | --- |
| 启动链接（`#login=...`） | **10 分钟，一次** | 过期后打开会停在登录页，提示「登录链接已失效或 API Key 不正确」 |
| 已兑换的会话 Cookie | **8 小时** | 从兑换那一刻算起；期间刷新、切页都正常 |
| **API Key** | **永久，除非你轮换它** | 存在 `~/.modelport/settings.json` 的 `forwardKey`，重启服务也不变 |

所以链接过期只影响「首次进门」这一下。要继续用：

1. **直接用 API Key 登录**（推荐，不用重启）：在登录页粘贴 `forwardKey`，或者在登录页点
   **「打开 PowerShell 获取令牌」**——它会自动读取并复制到剪贴板，粘进去即可；
2. **或者重启服务**：`Ctrl+C` 后重新 `node app/cli.mjs`，会打印一条新的 10 分钟链接。

**注意**：8 小时会话到期后，同样是用上面两种方式之一重新登录——不是重新启动服务，
也不是重新登录各个渠道。渠道的登录状态存在 `channel-credentials.json` 里，和会话无关。

### 第五步（可选）：登录账号渠道

控制台左侧 **「账号渠道」** → 选一个渠道 → 右上角 **「添加账号」** → 浏览器弹出该渠道
自己的登录页 → 登录完回到控制台，页面每 2.5 秒轮询一次，授权完成后显示「已接入」，
它的模型随即并入清单。

13 个渠道都是这个流程。**Gemini 例外**，见下方「Gemini 需要自带 OAuth 客户端」。

### 第六步：把模型接给你的 Agent

控制台 **「API 接入」** 页按实际端口和真实密钥生成配方，六种客户端都有，
也可以直接抄下面「接入任意 Agent」一节。

### 停止服务

终端里按 `Ctrl+C`。正常退出会释放端口和 `service.lock`。
如果进程被强杀留下陈旧锁，下次启动会检测到锁的 pid 已不存在并自动回收。

### Gemini 需要自带 OAuth 客户端

Gemini 渠道原本硬编码了一对 Google OAuth 客户端凭据，本仓库把它清空了
（否则 GitHub 的 secret scanning 会拒绝推送，见 `vendor/channel-pack/NOTICE.md`）。
要用 Gemini 就先自己申请一对，然后启动时带上：

```powershell
# PowerShell
$env:CMDC_PAK_GOOGLE_CLIENT_ID = "你的-client-id"
$env:CMDC_PAK_GOOGLE_CLIENT_SECRET = "你的-client-secret"
node app/cli.mjs
```

```bash
# bash / zsh
export CMDC_PAK_GOOGLE_CLIENT_ID=你的-client-id
export CMDC_PAK_GOOGLE_CLIENT_SECRET=你的-client-secret
node app/cli.mjs
```

其余 12 个渠道不需要任何额外配置。

### 命令行参数

| 参数 | 作用 |
| --- | --- |
| `--port <端口>` | 监听端口，默认 `18900`；被占用时自动退避到可用端口 |
| `--data-dir <目录>` | 数据目录，默认 `$MODELPORT_HOME` 或 `~/.modelport` |
| `--no-refresh` | 跳过启动与周期刷新；手动刷新和推理仍然可用 |
| `--lan` / `--no-lan` | 开启 / 关闭局域网推理中继 |
| `--lan-port <端口>` | 保存局域网期望端口（`0` = 每次自动分配），不会单独开启中继 |

> 早先还有一个 `--probe`（启用可用性探测）。探测是随免费车道来的，车道移除后这个
> 开关已经删掉，传它会被当成未知选项报错。

环境变量：`MODELPORT_HOME`、`CMDC_PAK_GOOGLE_CLIENT_ID`、`CMDC_PAK_GOOGLE_CLIENT_SECRET`。

---

## 接入任意 Agent

控制台的「API 接入」页会按**实际绑定的端口**与**真实的 Key** 生成可复制的配方。六个客户端：

### Claude Code

ModelPort 原生说 Anthropic Messages，不需要任何翻译层：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18900
export ANTHROPIC_AUTH_TOKEN=mp-你的密钥
export ANTHROPIC_MODEL=deepseek-v4.1-flash-free
```

### Codex CLI

写进 `~/.codex/config.toml`：

```toml
model_provider = "modelport"
model = "deepseek-v4.1-flash-free"

[model_providers.modelport]
name = "ModelPort"
base_url = "http://127.0.0.1:18900/v1"
wire_api = "responses"
env_key = "MODELPORT_API_KEY"
```

### Cursor / Continue / Cline 等 OpenAI 兼容工具

Base URL 填 `http://127.0.0.1:18900/v1`，Key 填 `mp-…`，模型 ID 从 `/v1/models` 里挑。

### OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:18900/v1", api_key="mp-你的密钥")
client.chat.completions.create(model="deepseek-v4.1-flash-free",
                               messages=[{"role": "user", "content": "hi"}])
```

### Anthropic SDK

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://127.0.0.1:18900", api_key="mp-你的密钥")
client.messages.create(model="deepseek-v4.1-flash-free", max_tokens=1024,
                       messages=[{"role": "user", "content": "hi"}])
```

### curl

```bash
curl http://127.0.0.1:18900/v1/chat/completions \
  -H "Authorization: Bearer mp-你的密钥" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"你好"}]}'
```

---

## HTTP 接口

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /health` | 无 | 存活探测，不返回任何凭据 |
| `GET /v1/models` | Bearer | OpenAI 模型清单，含 `x_mp_efforts` / `x_mp_effort_default` 扩展字段 |
| `POST /v1/chat/completions` | Bearer | OpenAI Chat，支持 SSE 流式 |
| `POST /v1/responses` | Bearer | OpenAI Responses |
| `POST /v1/messages` | Bearer | Anthropic Messages（含 thinking / tool_use 块） |
| `POST /v1/messages/count_tokens` | Bearer | 本地估算，不产生上游请求 |
| `GET /` `/assets/*` | 无 | 控制台静态页 |
| `GET/POST /api/management/*` | Cookie 或 Bearer | 控制台 API，仅回环地址可访问 |

无前缀写法（`/models`、`/chat/completions`、`/messages`）同样可用，方便只认裸路径的客户端。

---

## 控制台七页

| 页面 | 内容 |
| --- | --- |
| 概览 | 可接入模型数、Token 用量、最近 7 天曲线、各渠道的模型来源 |
| 模型清单 | 全部模型、能力标签、上下文/输出上限、单模型实测、按偏好隐藏 |
| 用量统计 | 累计 Token、每日趋势、按模型分页明细、首字延迟与生成速度 |
| **账号渠道** | 13 家渠道：浏览器登录、账号池、积分余额与一键领取、逐模型开关 |
| 路由链路 | 降级链与轮询链的增删改，成员排序，链路能力交集预览 |
| API 接入 | 两个 Base URL、Key 查看/复制/轮换、局域网地址与 LAN Key、六组客户端配方、协议矩阵 |
| 服务设置 | 推理开关、断流恢复、刷新间隔、局域网开关与端口 |

### 账号渠道怎么工作

每个渠道点「添加账号」会打开该渠道自己的浏览器登录页；授权完成后，渠道包在后台
把凭据写进本机 `channel-credentials.json`（`0600`），页面始终拿不到明文。凭据有
refresh token 的会自动续期，没有的在过期后需要重新登录。

关掉的模型不会出现在 `/v1/models` 里；未登录的渠道不贡献任何可路由模型，
所以清单里不会出现「选了必然报错」的条目。

### 降级链路串的是渠道模型

链路的每一环都是某个渠道的模型（`<渠道>/<模型>`）。一条链在**交出任何正文之前**
失败，就会整环丢弃并换下一环——调用方一个字节都看不到，换模型因此不可见。
思考增量不算递交，所以「想了一分钟才撞上配额墙」正是最值得降级的情形。

一旦正文或工具调用交了出去，链路就不再换环：两个模型的正文被接在一起，比一次
失败更糟。

> 这 13 个渠道依赖各家的客户端接口，不是官方开放 API，上游一改就可能失效。
> 渠道包本身来自上游项目的 vendor 目录，见 [NOTICE.md](NOTICE.md)。

---

## 数据与安全

- 默认数据目录 `~/.modelport`，权限 `0700`；`settings.json` 权限 `0600`。
- **不读取、不导入任何宿主应用的配置或凭据**，也不向任何服务器上传数据。
- API Key 是本机生成的 `mp-` + 24 字节 base64url，保存在 `settings.json` 的 `forwardKey` 字段。
- 管理接口只监听回环地址，写操作要求会话 Cookie 或 Bearer Key，并校验 `Host` / `Origin` 同源。
- 同一个数据目录只能起一个实例：Windows 用命名管道互斥，跨平台用 `service.lock` 归属校验，
  只有能证明旧进程已退出（`ESRCH`）时才回收陈旧锁。
- 磁盘写失败时**不会向页面谎报保存成功**：内存值回滚并返回 500。

### 局域网访问

默认关闭。开启后中继监听 `0.0.0.0`，**只转发 `/v1/*` 推理路径**，管理路径一律不转发。
局域网客户端必须使用**独立生成的 LAN Key**（`lanKey`），本机 `forwardKey` 在中继上不可用。
只在你信任的网络上开启——拿到 LAN Key 的设备能消耗这台机器上已登录渠道的额度。

---

## 开发

```bash
npm install --prefix app --ignore-scripts   # 只装控制台构建依赖
node scripts/build-ui.mjs                   # 从 app/ui 生成 app/web
node scripts/build-ui.mjs --check           # CI：确认产物与源码一致
node scripts/build-channels.mjs             # 从 vendor/channel-pack 生成 app/channels/business.mjs
node scripts/build-channels.mjs --check     # CI：确认渠道产物与输入一致
node scripts/test-all.mjs                   # 18 个离线套件
node scripts/e2e-check.mjs                  # 端到端验收（替身渠道，不花额度）
```

测试全部离线：每个套件驱动真实模块对着本机替身跑，不花渠道额度、不访问外网。

改了 `app/ui/` 之后必须重跑 `build-ui.mjs`，否则控制台显示的还是旧界面。

---

## 已知限制

- **模型只来自你登录的渠道**：装好之后要先登录，没有任何开箱即用的免费额度。
  这是移除免费车道与聚合渠道后的直接结果。
- **账号渠道走的是各家客户端接口，不是官方开放 API**：上游一改版就可能失效。
  其中 WorkBuddy / CodeBuddy 已被上游项目于 2026-10-21 移除，本仓库保留的是移除前的版本，
  不提供稳定性承诺。详见 [NOTICE.md](NOTICE.md)。
- **Gemini 渠道需要自带 OAuth 客户端**（环境变量见上），因为硬编码的那对凭据已被清空。
- 渠道的可达性只有一种来源：这次的目录刷新有没有把它列出来。没有可用性探测，
  所以控制台也不再显示「已探测可用 / 限流中」这类状态。
- 不提供桌面安装包、自更新与公告推送——这些都需要绑定一个发布仓库与签名私钥。

---

## 许可证

MIT。见 [LICENSE](LICENSE)。上游版权 `Copyright (c) 2026 Ebony-Vinyl` 保留。

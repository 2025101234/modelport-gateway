# ModelPort

**一个跑在自己机器上的模型口岸：独立 Web 控制台、本地 URL、API Key，任意 Agent 都能接。**

「口岸」是它实际在做的事：模型从各条渠道进来，统一在一处落地，再由一个本地地址发出去。
客户端只认一个 Base URL 和一把 Key，不必知道背后是哪家渠道、哪次登录。

它把模型来源合并成同一份清单，用同一个端口同时说 **OpenAI Chat Completions**、
**OpenAI Responses**、**Anthropic Messages** 三种协议：

| 模型来源 | 需要什么 | 说明 |
| --- | --- | --- |
| **账号渠道** | 每个渠道登录一次 | **13 家**：CodeArts、CodeBuddy、WorkBuddy、LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini |
| **Grok** | 粘贴一次 Cookie | xAI 的 grok.com 网页端。**唯一的例外**：不在渠道包里、不走登录回跳、也不是官方开放接口，见下方说明 |
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
git clone https://github.com/2025101234/modelport-gateway.git
cd modelport-gateway
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

其中 11 家是这个流程。三种例外：

- **WorkBuddy / CodeBuddy**（`workbuddy` 国际版、`buddy` 国内版）支持三种凭据来源：
  **网页/扫码登录**（点「添加账号」，与其余渠道一样的授权页流程）、**本机桌面 App
  登录态**（点「重新检测登录态」）、以及**服务器上搬运来的凭据文件**。详见
  「WorkBuddy / CodeBuddy：复用桌面端登录态」。
- **Gemini** 需要自带 OAuth 客户端，见下方「Gemini 需要自带 OAuth 客户端」。
- **Grok** 靠粘贴 Cookie，见「Grok：唯一需要粘贴 Cookie 的渠道」。

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

### Grok：唯一需要粘贴 Cookie 的渠道

Grok 和上面 13 家不一样，这一点值得先讲清楚，免得你以为它坏了：

| | 其余 13 家 | Grok |
| --- | --- | --- |
| 实现来源 | 上游渠道包（`vendor/channel-pack`） | **本仓库自己写**（`app/channels/grok.mjs`） |
| 登录方式 | 点「添加账号」弹官方登录页，自动回跳 | **手动粘贴 Cookie**，没有回跳 |
| 接口性质 | 各家客户端接口 | 网页端 WebSocket 反向代理 |

之所以要手动粘贴：Grok 不在渠道包里（整个包里搜 `grok`/`xai` 零命中），也没有
`account.create` 那套登录流程——对它会直接答 `unknown provider`。凭据靠你自己的
浏览器登录后复制一次，写进本机 `channel-credentials.json`（`0600`）。

**操作步骤**：

1. 控制台 → **账号渠道** → 选 **Grok**
2. 浏览器打开 [grok.com](https://grok.com) 并确认已登录
3. 按 **F12** → **应用 / Application** → **Cookie** → `https://grok.com`
4. 把整行复制成 `sso=…; x-userid=…` 这样的形式，粘进控制台的输入框，点**保存 Cookie**

保存前会先校验：缺 `sso`、或取不到用户 id，都会当场告诉你缺什么，而不是存进去等到
调用时才失败。

> ⚠️ **两条必须知道的风险**，它们写进了代码注释和控制台，不是吓唬你：
>
> 1. 这是**非官方**接口。上游改协议、改签名参数或收紧 Cloudflare 策略，它就可能失效，
>    而且不会有人通知你。
> 2. grok.com **免费账号的对话配额很紧**。接进降级链后，它更可能的表现是频繁 `429`，
>    而不是稳定兜底。需要稳定供应就用 xAI 官方 API Key——那是另一条完全不同的路径。

### WorkBuddy / CodeBuddy：网页登录 + 桌面登录态

这两家不走渠道包原来的「弹窗 OAuth + 模拟 UA」反代：上游已限制非官方客户端，
新版桌面端还把 auth 文件的 token 加密成 AES 信封，那条链路已失效。现在改为
照 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）的方式，
用桌面客户端的身份与 wire 头请求上游。实现放在 `app/channels/workbuddy-desktop/`，
来源与第三方署名见 [NOTICE.md](NOTICE.md)。

- `buddy` = 国内版 / CodeBuddy（`copilot.tencent.com`），`workbuddy` = 国际版
  WorkBuddy AI（`www.workbuddy.ai`）。按凭据里的 `domain` 自动分流，两个区域可同时在线。
- **网页/扫码登录**：控制台点「添加账号」→ 浏览器打开授权页 → 登录完成后自动轮询到
  凭据。走 `/v2/plugin/auth/state` → `auth/token` → `login/account` 三步端点，会话绑定
  区域与域名（国际版 `workbuddy.ai` / `codebuddy.ai` 两把钥匙不通用），10 分钟超时。
  凭据写入本仓库自己的 vault（`dataDir/workbuddy-vault/<region>/*.json`，0600），
  **一账号一文件**，可删除、可导出；桌面 App 的文件始终只读、永不改动。
- **桌面 App 登录态**：点「重新检测登录态」扫描本机登录态文件；加密信封由已安装 App
  的原生绑定在运行时取密钥解密，密钥只在内存中、不落盘。
- 四类凭据来源**合并成同一份清单**：`WORKBUDDY_AUTH_FILE` 显式文件 → 平台默认桌面
  auth 目录（含时间戳备份）→ 数据目录的 `workbuddy-auth.<region>.json`（刷新结果 /
  搬运种子）→ 网页登录的 vault。同区域多账号按到期更晚者优先，失败可换号。
- 用 App 身份 UA 读 `/v3/config` 拿模型目录（CLI 身份的答复是严格子集），
  聊天请求带会话三元组、渠道指纹改写与 11128 自愈重试；token 过期走
  `X-Refresh-Token` 续期，结果写回本仓库自己的数据目录。

> ⚠️ 这是**非官方**客户端接口的反代。上游随时可能改协议或收紧限制，不提供长期可用承诺。

#### 部署到无桌面端的服务器：电脑登录 → 导出 → 上传

服务器没有桌面 App；**最简单的一条路是网页登录 + 控制台导出**：

```sh
# 1) 在电脑（或任何能开浏览器的机器）上：控制台 → 账号渠道 →
#    选 WorkBuddy / CodeBuddy → 点「添加账号」→ 在授权页完成登录
#    （国内版与国际版各登一次即可，两个区域的账号互不干扰）

# 2) 同一页点「导出账号」：浏览器下载 workbuddy-auth.<region>.json
#    （global = 国际版，cn = 国内版）。这就是明文登录态，含 refresh token。

# 3) 经加密通道上传到服务器的数据目录（默认 ~/.modelport，或 MODELPORT_HOME）
scp ~/Downloads/workbuddy-auth.*.json user@server:~/.modelport/
ssh user@server 'mkdir -p ~/.modelport && chmod 600 ~/.modelport/workbuddy-auth.*.json'

# 4) 在服务器上启动（无需安装桌面 App，也无需 WORKBUDDY_AUTH_FILE）
node app/cli.mjs --lan
```

导出的文件带 refresh token，服务器会自动续期并写回自己的数据目录，不用反复重传。
也可以在服务器上直接点「添加账号」做网页登录 —— 那样连上传都省了，只要服务器
能打开授权页、浏览器能回连本机控制台即可。

> 🔐 **如果改用桌面 App 登录态，则不要直接打包 `*.info` 文件**：5.6.0 起 token 被
> AES-256-GCM 加密，密钥由 App 运行时现取、不落盘，无 App 的服务器解不开。
> 这条路径请用 `scripts/export-workbuddy-auth.mjs` 在**有 App 的电脑**上先把登录态
> 解密导出，再上传：
>
> ```sh
> node scripts/export-workbuddy-auth.mjs --out ./workbuddy-export
> # 若 App 装在非常规位置，先设 WORKBUDDY_APP_EXECUTABLE；只想导某一文件可设 WORKBUDDY_AUTH_FILE
> scp ./workbuddy-export/workbuddy-auth.*.json user@server:~/.modelport/
> ```
>
> 控制台会明确报「凭据已加密但取不到密钥」，而不是静默当作未登录。

凭据文件**等同于账号**：只经加密通道传输、`chmod 600`、别放进会被 git 提交/打包/
同步网盘的目录，用完后删掉中转的那份。手上若正好是一份**未加密**的旧版 auth 文件，
也可直接 `WORKBUDDY_AUTH_FILE=/path/to/workbuddy-desktop.info node app/cli.mjs`。

对外暴露沿用现有机制：`startService` 只绑回环地址，管理 API 也仅限回环 +
Host/Origin 同源校验；`--lan` 中继绑 `0.0.0.0` 但**只转发 `/v1/*`** 且用独立 `lanKey`。
因此服务器上对外提供推理时，前面挂反向代理或开 `--lan`，管理页走 SSH 隧道。

#### 前面挂反向代理时：可信反代开关

服务只监听回环，所以 nginx 必须把 `Host` 改写成回环地址才能转发；但浏览器的
`Origin` 仍是公网地址，两者对不上就会被同源校验拦成 403。此时给服务加：

```bash
MODELPORT_TRUST_PROXY=1 node app/cli.mjs
```

开启后，同源校验改用反代传回的 `X-Forwarded-Host` / `X-Forwarded-Proto` 还原浏览器
看到的源，nginx 侧需要一并转发：

```nginx
location / {
    proxy_pass http://127.0.0.1:18900;
    proxy_set_header Host 127.0.0.1:18900;            # 服务只接受回环 Host
    proxy_set_header X-Forwarded-Host $host;          # 浏览器实际访问的地址
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**默认关闭**，只在「绑定只经可信反代可达」时开启：
回环 Host 要求、跨站拒绝、API Key / 会话 Cookie 校验都不变，伪造的
`X-Forwarded-Host` 仍必须与浏览器自己的 `Origin` 一致才能通过。如果只对外提供
推理、不需要公网管理页，更安全的做法是不开这个开关，管理页走 SSH 隧道。

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

环境变量：

| 变量 | 作用 |
| --- | --- |
| `MODELPORT_HOME` | 数据目录（等价于 `--data-dir`）；服务器上把导出的 `workbuddy-auth.*.json` 放这里 |
| `MODELPORT_TRUST_PROXY` | 设为 `1` 时信任反向代理的 `X-Forwarded-Host`/`X-Forwarded-Proto`（见上文「可信反代开关」，默认关闭） |
| `WORKBUDDY_AUTH_FILE` | 显式指定一份 WorkBuddy auth 文件（未加密旧文件可直接在服务器用；导出脚本也可只导这一份） |
| `WORKBUDDY_APP_EXECUTABLE` | 加密凭据解密时，指定桌面 App 可执行文件（本机导出时用，服务器无需） |
| `CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET` | Gemini 渠道自带的 OAuth 客户端 |

服务器部署的凭据搬运另见 `scripts/export-workbuddy-auth.mjs`：在已登录桌面 App 的
电脑上把登录态解密导出成明文 store 文件，再上传到服务器的数据目录。

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
| **账号渠道** | 11 家浏览器登录、账号池、积分余额与一键领取、逐模型开关；WorkBuddy / CodeBuddy 支持网页登录 + 桌面登录态 + 账号导出；外加 Grok（粘贴 Cookie） |
| 路由链路 | 降级链与轮询链的增删改，成员排序，链路能力交集预览 |
| API 接入 | 两个 Base URL、Key 查看/复制/轮换、局域网地址与 LAN Key、六组客户端配方、协议矩阵 |
| 服务设置 | 推理开关、断流恢复、刷新间隔、局域网开关与端口 |

### 账号渠道怎么工作

常规渠道点「添加账号」会打开该渠道自己的浏览器登录页；授权完成后，渠道包在后台
把凭据写进本机 `channel-credentials.json`（`0600`），页面始终拿不到明文。凭据有
refresh token 的会自动续期，没有的在过期后需要重新登录。

**WorkBuddy / CodeBuddy 例外**：网页/扫码登录的凭据写入本仓库自己的 vault（可删除、
可导出）；本机桌面 App 的登录态文件只读、绝不回写；服务器上还可放搬运来的凭据
文件。三类来源合并成同一份清单。详见「WorkBuddy / CodeBuddy：网页登录 + 桌面登录态」。
Grok 则靠粘贴 Cookie。

关掉的模型不会出现在 `/v1/models` 里；未登录的渠道不贡献任何可路由模型，
所以清单里不会出现「选了必然报错」的条目。

### 降级链路串的是渠道模型

链路的每一环都是某个渠道的模型（`<渠道>/<模型>`）。一条链在**交出任何正文之前**
失败，就会整环丢弃并换下一环——调用方一个字节都看不到，换模型因此不可见。
思考增量不算递交，所以「想了一分钟才撞上配额墙」正是最值得降级的情形。

一旦正文或工具调用交了出去，链路就不再换环：两个模型的正文被接在一起，比一次
失败更糟。

> 这些渠道依赖各家的客户端接口，不是官方开放 API，上游一改就可能失效；Grok 尤其明显，它连官方接口都不是。
> 渠道包本身来自上游项目的 vendor 目录，见 [NOTICE.md](NOTICE.md)。

---

## 数据与安全

- 默认数据目录 `~/.modelport`，权限 `0700`；`settings.json` 权限 `0600`。
- 不读取、不导入任何 **DSH 宿主**应用的配置或凭据，也不向任何服务器上传数据。
  **唯一的例外是 WorkBuddy / CodeBuddy**：这两家按设计**只读**本机（或服务器上搬运来的）
  WorkBuddy 桌面端 auth 文件——只读、绝不回写桌面 App 的文件；加密凭据的密钥只在进程内存中
  派生，不落盘、不进日志。控制台与所有管理接口都拿不到任何 token 明文。
- API Key 是本机生成的 `mp-` + 24 字节 base64url，保存在 `settings.json` 的 `forwardKey` 字段。
- 刷新得到的 WorkBuddy token 写进数据目录的 `workbuddy-auth.<region>.json`（`0600`，原子写）。
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
  其中 WorkBuddy / CodeBuddy 已被上游项目于 2026-10-21 移除，本仓库保留的是移除前的
  渠道包注册；这两家现已由本仓库自有的桌面登录态适配器接管，见
  「WorkBuddy / CodeBuddy：复用桌面端登录态」与 [NOTICE.md](NOTICE.md)。
- **WorkBuddy / CodeBuddy 需要本机（或搬运来的）桌面端登录态**：桌面端未登录、
  或服务器上的凭据文件缺失/加密且取不到密钥时，这两家不贡献任何可路由模型。
  上游已开始限制非官方客户端请求，随时可能失效；服务器部署的加密凭据限制见上文。
- **Gemini 渠道需要自带 OAuth 客户端**（环境变量见上），因为硬编码的那对凭据已被清空。
- 渠道的可达性只有一种来源：这次的目录刷新有没有把它列出来。没有可用性探测，
  所以控制台也不再显示「已探测可用 / 限流中」这类状态。
- 不提供桌面安装包、自更新与公告推送——这些都需要绑定一个发布仓库与签名私钥。

---

## 许可证

MIT。见 [LICENSE](LICENSE)。上游版权 `Copyright (c) 2026 Ebony-Vinyl` 保留。

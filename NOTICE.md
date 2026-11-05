# NOTICE — 来源与改动说明

本项目的模型引擎、转发服务与控制台，源自开源项目
**[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)**
（MIT，`Copyright (c) 2026 Ebony-Vinyl`）。本仓库是它的一个**独立化复刻**：保留模型引擎与本地网关，
去掉所有与 DeepSeek Harness 宿主绑定的部分。

上游的 MIT 许可证全文见 [`LICENSE`](LICENSE)，版权行保持原样，并追加了本项目贡献者的版权行。
上游的每一处代码在本仓库中仍然是 MIT。

## 保留了什么

| 路径 | 内容 |
| --- | --- |
| `src/forward.js` | HTTP 监听器：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/models`、`/health`，以及局域网中继 |
| `src/core/runtime.js` | 模型运行时：把渠道目录与降级链合成一份清单，并把一个回合派给正确的地方 |
| `src/core/combo.js` | 降级链的执行与提交规则（哪些分块一旦交出就不能再换环） |
| `src/core/completion.js` | 把渠道交出的分块折叠成一个回合的结果 |
| `src/combos.js` | 链路定义、目录行与轮询游标 |
| `src/route/classify.js` | 失败分类与「该不该换下一环」的判定 |
| `src/messages.js`、`src/model-id.js` | 消息投影与模型 id / 工具名规整 |
| `src/token-saver/**` | RTK 工具输出压缩、提示词瘦身 |
| `src/local-optimize.js` | 五个不产生上游请求的本地应答 |
| `app/channels/**` | 账号渠道运行时：一实例一 Worker、独立凭据仓库、图片只在内存存活 |
| `vendor/channel-pack/pack.js` | 13 家账号渠道的实现（登录、账号池、积分、模型黑名单）。见下方「账号渠道的来历」 |
| `app/**` | 控制台：服务、管理 API、React 界面 |

早先版本还有 `src/adapter.js`（免费车道的分发器，兼降级链执行）与 `src/effort.js`
（免费车道的 token 预算阶梯）。它们的职责现在分别由 `src/core/combo.js` 与渠道包自己
承担，所以两文件都已删除；降级链的执行从 adapter 搬进了 `src/core/combo.js`，提交
规则逐条保留。

## 账号渠道的来历

`vendor/channel-pack/` 是从 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
的发布包中取得的渠道实现，经 `scripts/build-channels.mjs` 去掉宿主依赖
（`@deepseek-ai/*` → 本地 `contracts.mjs`）后生成 `app/channels/business.mjs`。

它覆盖 13 家：CodeArts（华为云）、CodeBuddy / WorkBuddy（腾讯）、LobsterAI（有道）、
Qoder / Qoder 中国版（阿里系）、TRAE（字节）、Cline、Loomy（讯飞）、Raccoon（商汤）、
MiniMax Code、ZCode（智谱）、Gemini（Google Code Assist）。

**需要注意的两点：**

1. 上游在 2026-10-21 的 `d187bf1` / `58d87c7` 两个提交里**移除了** WorkBuddy 与
   CodeBuddy 两条渠道（"移除插件及独立服务的渠道注册、认证、积分、探测与调用入口，
   保留历史账号和凭据"），未在公开文档里说明原因。本仓库保留的是移除前的版本。
2. 这些渠道走的是各家的**客户端接口，不是官方开放 API**。上游一改版就可能失效，
   届时需要等渠道包跟进。它们也不提供任何稳定性承诺。

MIT 许可证与版权行见 `vendor/channel-pack/LICENSE`（与上游一致）。

## 删除了什么，以及为什么

| 删除项 | 原因 |
| --- | --- |
| `index.js`、`client.js`、`cordis.patch.yml`、`adapter/kernel.js` | DSH 插件形态的入口。本项目的目标是不依赖任何宿主 |
| `src/eac.js`、`src/eac-user.js`、`src/eac-login.js`、`src/vault*.js` | EAC 协付车道。它在服务端校验「是否 star 了上游仓库」，身份上属于上游项目，不属于本仓库 |
| `src/updater.js`、`src/feed.js`、`src/reload.js`、`src/push.js` | 自更新、公告推送、热重载。三者都绑定上游仓库地址与上游的 Ed25519 签名私钥 |
| `src/picks.js`、`src/chan-relay.js`、`src/channel-visibility.js`、`src/sponsor.*` | 上游自身的运营组件（赞助商广告、账号渠道网关、渠道可见性开关） |
| `packages/standalone/channels/**`（上游那份） | 上游的独立端渠道产物只有 11 家。本仓库改用移除 WorkBuddy/CodeBuddy 之前的渠道包自行生成，见「账号渠道的来历」 |
| `packages/desktop/**` | Tauri 桌面壳。需要 Rust 工具链与代码签名证书，与「本地服务 + 浏览器控制台」的目标无关 |
| `worker/**` | EAC 的 Cloudflare Worker 网关，随 EAC 车道一起删除 |
| `feed/`、`catalog/` | 上游的发布清单与签名记录，只服务于它自己的升级链路 |
| `docs/`、`PACKAGING.md`、`README_EN.md`、`.trae-html-share-packages/` | 上游的运营文档与内部打包产物 |
| `.github/workflows/{release-sign,prepare-release,build-macos}.yml` | 依赖上游私钥（`RELEASE_MANIFEST_PRIVATE_KEY`、`OFM_RELEASE_PUSH_TOKEN`），在本仓库里必然失败 |
| `src/adapter.js`、`src/stream.js`、`src/http.js`、`src/channel.js`、`src/recovery.js`、`src/image-pricing.js` | 免费车道的分发器、wire 解析、SSE 读取、断流恢复与图片计价。降级链的执行搬进 `src/core/combo.js`（提交规则逐条保留），其余随车道删除 |
| `src/catalog.js`、`src/probe.js`、`src/model-test.js`、`src/effort.js`、`src/upstream.js` | 免费车道的模型清单、可用性探测、单模型实测、思考档位阶梯与 opencode.ai 请求指纹。没有免费车道，就没有需要探测或指纹的东西 |
| `src/kilo.js` | Kilo 免费池车道（`api.kilo.ai`） |
| `src/aggregate.js`、`src/providers/**` | 自带 Key 的聚合渠道（75 家提供商）及其注册表 |
| `src/egress.js` | 上游出口代理（订阅模式 / 直连 socks5）。它只服务于免费车道与聚合渠道的探测和调用，两条车道都没了，它就没有消费者 |
| `scripts/lib/stub-upstream.mjs` | 替身上游。集成套件改为注入替身渠道（`scripts/lib/fake-channels.mjs`），不再需要模拟一个上游 |

## 改动了什么

- **去宿主化**：删掉 `resolveDshHome()` / `DATA_DIR_NAME`，数据目录改为 `$MODELPORT_HOME` 或 `~/.modelport`；
  环境变量前缀 `OFM_*` / `OUR_FREE_MODEL_*` 改为 `MODELPORT_*`（旧名保留一版 fallback）。
- **改名与换标识**：产品名、API Key 前缀（`mp-`）、诊断头（`x-mp-*`）、会话 cookie 名、
  单实例管道名（`mp-service-lock-*`）、localStorage 键，全部换成 ModelPort 自己的；
  左上角图标也从上游的位图换成自绘的矢量标识（三条车道汇入一个端口）。
- **去身份化**：`our-free-model` 相关的路由名、User-Agent、日志前缀统一改为 `modelport`。
- **扩展管理面**：把上游插件端才有的一组设置接口（链路编辑、Token 压缩、本地应答、账号渠道 RPC）
  移植到独立服务的 `/api/management/*`，因此控制台不再需要 DSH 宿主。
- **重做控制台**：新增「账号渠道」与「路由链路」两页，重写「API 接入」页为可直接复制的客户端配方，
  删除「免费账号渠道」「EAC 协付渠道」「来自赞助商的广告」「聚合渠道」四页。
- **构建解耦**：上游构建控制台时要读 `client.js` 提取共享 UI；本仓库改为控制台自己持有页面代码，
  `client.js` 已不存在。

## 后来又移除了什么

按使用者的要求，这个复刻版**只保留 13 个账号渠道与降级链**，于是又做了一轮删除
（明细见上表最后六行）：匿名免费车道、Kilo 免费池与自带 Key 的聚合渠道全部删掉，
连同它们专用的模块。

随之一起消失的概念，记在这里以免日后困惑：

- **可用性探测**：渠道的可达性现在只有一种来源——这次的目录刷新有没有把它列出来。
  控制台因此不再显示「已探测可用 / 限流中」这类状态，`--probe` 开关也删了。
- **请求指纹**：`CLIENT_UA` 与 `FINGERPRINT_TOOLS` 是免费车道对 opencode.ai 的准入条件，
  那道门已经不存在，所以本文件里原有的「未改动的关键常量」一节也删掉了。
  同一节的第三方声明（`src/upstream.js` 的指纹实现参考 opencode2api 与 9router）
  随被引用的代码一起移除。

降级链保留了下来，但它的执行对象换了：每一环从「免费车道的模型」变成「渠道模型」。
执行代码从 `src/adapter.js` 搬进 `src/core/combo.js`，提交规则（正文与工具调用算递交、
思考不算、已递交就不再换环）逐条保留，并由 `scripts/combo-advance-test.mjs` 覆盖。

## 后来又改了什么：WorkBuddy / CodeBuddy 反代

上游渠道包里 `BuddyAuth` + `registerBuddyLlm` 走的是「自己在弹窗里 OAuth 登录 → 凭据写进
`channel-credentials.json` → 按模型族猜 UA 直连」。上游已限制非官方客户端，且新版桌面端
把 auth 文件的 token 加密成 AES-256-GCM 字段信封，这条链路失效。按使用者要求，这两家改为
**[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** 的方式：
只读本机（或服务器上搬运来的）WorkBuddy 桌面端登录态文件，用桌面客户端自己的身份与
wire 头请求上游。

新增 `app/channels/workbuddy-desktop/`（本仓库自写，MIT 兼容方式独立实现，未整文件复制）：

| 文件 | 内容 |
| --- | --- |
| `at-rest.mjs` | 加密字段信封的 AES-256-GCM 解密、AAD 转录、密钥派生与 App 可执行文件探测 |
| `auth.mjs` | 三级凭据发现、auth 文档解析、按 `domain` 分流区域、headless 诊断 |
| `store.mjs` | 刷新结果写回本仓库数据目录（0600 原子写），绝不回写桌面 App |
| `catalog.mjs` | `/v3/config` 模型解析与兜底目录（数据来自渠道包 `buddy.ts` 的兜底表） |
| `upstream.mjs` | 目录读取、聊天请求头/请求体加工、SSE→归一化 chunk、token 刷新、错误分类 |
| `adapter.mjs` | `LlmAdapter` 契约实现、多账号选择与续期、网页登录与账号管理 |
| `oauth.mjs` | 网页/扫码登录：`/v2/plugin/auth/state` → `auth/token` → `login/account`，字段双拼写容错、区域/域名绑定、10 分钟会话 |
| `vault.mjs` | 网页登录账号的凭据库（一账号一文件、0600）、删除、脱敏摘要与导出 |

凭据共四类来源，合并成同一份清单：`WORKBUDDY_AUTH_FILE` → 平台默认桌面 auth 目录
→ 数据目录 `workbuddy-auth.<region>.json` → 网页登录的 vault。桌面 App 的文件始终只读。

接线在 `app/channels/worker.mjs` 与 `app/ui/channels.tsx`：两个适配器在渠道包 `apply()`
之前注册（利用其 `registerAdapterIdempotent` 的「保留先注册者并跳过」语义），推理走受限
直通分支，管理面 RPC 对这两家先拦截。渠道包内两套旧 `BuddyAuth` 实例残留但空转，不改动
`vendor/channel-pack/pack.js` 与 `scripts/build-channels.mjs`。
`scripts/export-workbuddy-auth.mjs` 在已安装桌面 App 的机器上把加密登录态解密导出成
明文 store 文件，供无桌面端的服务器使用；控制台的「导出账号」则导出网页登录的 vault。

### 第三方来源与许可

- **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)**
  — MIT，`Copyright (c) 2026 LaoDing`。本仓库参照其 `src/at-rest.ts`、`src/auth.ts`、
  `src/upstream.ts` 的算法与 wire 行为独立实现连接内核所需子集。
- 该项目的 `src/upstream.ts` 声明其 wire behavior 参照
  **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**
  （MIT，`Copyright (c) 2026 Corrine Hu`）与
  **[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)**（MIT）；
  `src/at-rest.ts` 的 DSML 解析参照 **[hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api)**
  （MIT）。这些项目的版权归各自作者所有。
- 兜底模型表的数据来自 `vendor/channel-pack/pack.js`（MIT，版权见该目录 `NOTICE.md`）。

以上项目均为 MIT，其版权行在此如实保留。本仓库对这些第三方代码的使用是
「参照算法与协议、独立实现」，不是分发其源码副本。

### 明确未移植的部分（M2）

设备 turing token / machine id、积分倍率与活动徽标、逐模型图片核验表与默认推理档、
每日签到、生图与视频、CLI 路线、插件式 `workbuddy-global` 命名、插件自带的 loopback shim、
批量导入导出与逐账号测试。本项目自身已是 OpenAI / Anthropic 兼容网关，无需再套一层
随机端口 + secret 的 shim；网页登录与单账号导出已按上文实现。

## 上游第三方声明

内置渠道包的原始来源说明保留在 `vendor/channel-pack/NOTICE.md`。

# Changelog

本项目的所有显著变更都会记录在这个文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [1.4.1] - 2026-04-14

v1.4.0 经第三轮三方审查（Codex + Gemini），发现 **10 个新问题**（其中 1 个我自己引入的致命锁 bug），本次全部修复。

### 🔴 致命修复

**`makeLock` timeout 机制失效**（Gemini + Codex R3 一致发现）：
v1.4.0 的 `makeLock` 用 `chain = Promise.race(gated, timedOut).catch(...)`，30s 超时触发后 chain 立即 resolve，下一个任务获取锁——但原 `fn` 还在后台继续跑（JS Promise 无法取消），**两个任务并发操作 cookie/storage**，状态彻底损坏。v1.4.1 改为 `chain = gated.catch(...)`：锁的排队基于真实任务结束，timeout 只让调用方收到 rejection。

### 🔴 Codex R3 发现的深层问题

- **`maybeRecoverOnWakeup` 前置 await**：v1.4.0 是 fire-and-forget，新业务在脏 cookie 上开始。v1.4.1 敏感操作（save/switch/check*/delete/rename/import）必须 await 恢复完成。
- **`withAccountCookies` 消费 restoreCookies 返回值**：v1.4.0 仍然不看结果就继续 reload+fetch，把错号数据 merge 到当前账号。v1.4.1 restoreCookies 失败抛 `RestoreFailureError`，上游捕获不继续。
- **状态查询 userId 身份断言**：v1.4.0 merge 前不校验 `status.user.userId === account.userId`，cookie 串号时 A 的状态被写到 B。v1.4.1 `mergeAccountStatus` / `mergeMultipleAccountStatuses` 都加断言，不匹配则拒绝 merge 并标 sessionValid=false。
- **导入 JSON 的 `userId` 不可信任**：恶意 JSON 可伪造 userId 污染去重。v1.4.1 导入时 `userId = ''`（只保留 `importedUserId` 作备注），首次 check 成功后由 mergeAccountStatus 用 API 真实 userId 回填。
- **`pending attempts` 不跨业务继承**：v1.4.0 新业务复用 `existing.attempts`，被旧失败次数过早触发 MAX。v1.4.1 新业务从 0 计，且检测旧 pending 未清时警告。

### 🟡 Gemini R3 发现

- **`tryRecoverPendingRestore` 全路径进锁**：v1.4.0 的 committing / maxAttempts 路径直接调 `clearPendingRestore` 不加锁，和 `switchAccount` 并发时误删刚写入的 pending。v1.4.1 所有分支都在 `withCookieLock` 内。
- **`checkAllStatuses` I/O 从 O(N) → O(1)**：v1.4.0 每个账号 mergeAccountStatus 都做一次全量 load+save（50 账号 = 50 次全量读写）。v1.4.1 循环收集到内存 Map，循环结束后 `mergeMultipleAccountStatuses` 一次 load+merge+save。
- **`render` 同步权限态**：v1.4.0 render 用 innerHTML 重建账号卡时没检查 permissions 状态，导致 denied 后新按钮可点。v1.4.1 render 结尾调 `updatePermissionBanner` 贯彻禁用。
- **`importAccounts` 去重对齐 userId 优先**：v1.4.0 只用 sessionid（跨设备导入同账号会产生重复）。v1.4.1 改为 userId 优先 fallback sessionid。
- **`isAuthFailure` 处理 fetch 完全失败**：v1.4.0 只认 401/403 和 errno，status=0 且带 error（断网等）被误判为有效 session。v1.4.1 保守处理 `status===0` 或 `status>=500` 为失效。

### ✨ 新增

- **`optional_host_permissions`**：manifest 显式声明运行时可请求的 host 权限，符合 Firefox MV3 规范。
- **身份断言自动回填 userId**：旧版没 userId 的账号首次 check 成功会自动回填真实 userId，后续可走深度校验路径。

### 发布就绪度

| Round | Codex 评分 | Gemini 评分 |
|-------|-----------|------------|
| R1 (v1.2.2) | 4/10 | - |
| R2 (v1.3.0) | 6/10 beta | 6.5/10 |
| R3 (v1.4.0) | 6/10 | 3/10（发现致命锁 bug） |
| **R4 目标** | **预期 8+/10** | **预期 8+/10** |

## [1.4.0] - 2026-04-14

v1.3.0 经第二轮三方代码审查（Codex + Gemini）发现 **15+ 个 v1.3.0 引入或遗漏的严重问题**，本次全部修复。审查就绪度从 6/10 → 预期 8+/10。

### 🔴 修复 v1.3.0 引入的回归

- **Pending Restore 缺阶段标记的致命 bug**：v1.3.0 的 `_pendingRestore` 只记录 cookie 快照，如果崩在"切换成功但未清 pending"的窗口内，下次启动会**反向恢复**这次成功的切换。v1.4.0 引入三阶段状态机（`armed` → `business` → `committing`），只在 armed/business 状态恢复。
- **Pending Restore 只挂 onStartup/onInstalled**：MV3 SW 空闲挂起后被消息唤醒的场景这两个事件都不触发。v1.4.0 新增 `maybeRecoverOnWakeup`，每次消息路由入口懒触发检查（30s 节流）。
- **Pending Restore 不检查 restoreCookies 返回值**：恢复失败也清标记，用户永远失去恢复机会。v1.4.0 检查 `success/authFailed`，失败保留 pending + 最多 3 次重试。
- **tryRecoverPendingRestore 无锁**：`onStartup + onInstalled` 并发触发两份恢复任务。v1.4.0 用 `recoveryPromise` 单例 + `withCookieLock` 保护。
- **`sanitizeCookie` 正则可绕过**：`/\.?jianying\.com$/i` 缺 `^` 锚点，`eviljianying.com` 能过。v1.4.0 改为严格比较 `c.domain === 'jianying.com' || c.domain.endsWith('.jianying.com')`。
- **Storage TOCTOU**：v1.3.0 只有 cookieLock，没有 storage 锁，`checkAllStatuses` 等待网络时用户的 delete/rename/import 会被后台 save 覆盖（"僵尸账号复活"）。v1.4.0 新增 `withStorageLock`，所有改 accounts 的操作串行。
- **`mergeAccountStatus` TOCTOU**：load 和 save 之间 rename/import 仍可插入。v1.4.0 内部显式获取 storageLock。

### 🔴 修复 v1.0-v1.3 一直漏掉的问题

- **`verifySession` 太弱**：只检查 sessionid cookie 存在，cookie 在但失效会被判成功。v1.4.0 升级为真实 userId 校验——切换后调 userInfo API，返回的 userId 必须与目标账号匹配，否则触发回滚。
- **Host-only cookie 作用域被放宽**：`restoreCookies` 恢复时始终显式传 `domain`，host-only cookie 被转为 domain cookie。v1.4.0 检查 `cookie.hostOnly === true` 时不传 domain，让浏览器从 URL 推断。
- **`restoreCookies` 返回值大多被忽略**：`withAccountCookies` / check\* finally / 回滚路径都没消费 success/authFailed。v1.4.0 全链路消费，恢复失败保留 pending 不 committing。
- **Cookie 过期时间未前置校验**：导入老 JSON 或回滚旧快照时，过期 cookie 写入浏览器立即被丢，但上层判成功。v1.4.0 `sanitizeCookie` 过滤 `expirationDate < now`。
- **多窗口 reload 歧义**：`tab.active` 是每窗口一个 active，多窗口都会被 reload。v1.4.0 按 `windowId` 分组，每窗口只 reload 一个 active tab。
- **导入去重 bySid 过时**：JSON 文件内重复 sessionid 仍被重复插入。v1.4.0 新增条目也同步更新 bySid。

### 🟡 其他改进

- **锁 timeout 兜底**：`withCookieLock` / `withStorageLock` 加 30s 超时，避免某任务卡死导致全局饥饿。
- **Firefox 权限拒绝后禁用功能按钮**：旧版按钮仍可点但全部报错，UI 看起来能用实则不工作。v1.4.0 检测到无权限时 disable 所有操作按钮，只留"授权"按钮可点。
- **`checkHostPermission` 不吞异常**：旧版 catch 返回 true，真实故障被隐藏。v1.4.0 返回 `granted | denied | unsupported | error` 四种明确状态。
- **Popup render 正确处理通信失败**：旧版 sendMsg 失败会让 render 误判"无账号"，显示空状态。v1.4.0 检测 `__sendMsgError` 显示明确错误态 + 重试按钮。
- **Shadow DOM 隔离 toast**：切换账号时注入到非 active tab 的提示改用 Shadow DOM，避免被页面全局 CSS 污染。
- **导入对话框键盘支持**：Esc 取消、Enter 默认合并。

### 📝 文档

- README 删除"auth cookie 失败时降级 HTTP 重试"等过时描述
- README 修正权限表（`*://` → `https://`）
- 补充双锁机制、阶段化 Pending Restore、userId 深度校验的说明

### 第二轮三方审查贡献

| AI | 关键发现 |
|---|---|
| Codex | Pending Restore 阶段标记缺失（致命）、storage 并发未统一、verifySession 太弱、hostOnly 被放宽、restoreCookies 返回值不消费、tab.active 多窗口歧义、Firefox 权限拒绝 UI 降级不完整、checkHostPermission 吞异常、导入 bySid 过时、文档回归 |
| Gemini | sanitizeCookie 正则绕过、mergeAccountStatus TOCTOU、tryRecoverPendingRestore 无锁、Cookie 过期校验缺失 |
| Claude | withCookieLock timeout、Shadow DOM toast、Modal 键盘 |

## [1.3.0] - 2026-04-14

本次版本经过 Claude + Codex + Gemini 三方代码审查，共修复 **19 项** 问题（11 项 P0 阻塞级 + 8 项 P1 推荐级），显著提升安全性、正确性、用户体验。

### 🔴 Security (P0)

- **修复 Cookie HTTP 降级漏洞**：`restoreCookies` 在 auth cookie 写入失败时，旧版会自动降级为 `http://` + `secure:false` + 去除 `sameSite` 重试——这等价于把关键登录凭证写入非加密上下文，面临中间人劫持风险。v1.3.0 彻底移除此降级逻辑，失败即报错并进入回滚流程。
- **`host_permissions` 限制 HTTPS**：由 `*://*.jianying.com/*` 改为 `https://*.jianying.com/*`，拒绝明文 HTTP 访问。
- **导入数据字段白名单校验**：`importAccounts` 现在对每个 cookie 做严格的字段类型 + domain 白名单校验（仅允许 `.jianying.com` 域），头像 URL 只接受 HTTPS 协议，未知字段被丢弃。

### 🛠 Fixed (P0 正确性/并发)

- **`switchAccount` 失败时回滚原 cookie**：旧版失败后用户卡在"半切换"态（cookie 被清空一部分），v1.3.0 添加 `try/catch/finally` 包裹 + 原 cookie 快照 + 失败自动回滚 + `verifySession` 二次确认。
- **`saveCurrentAccount` 纳入 cookieLock**：此前在并发场景（用户手动保存时正好有批量查询在跑）会抓到中间态 cookie 保存成错账号。现已串行化。
- **`checkAllStatuses` 读-改-写覆盖 bug**：旧版先 load 整份 accounts，结束时 save 整份——期间用户的删除/重命名/导入会被覆盖。v1.3.0 改为 `mergeAccountStatus` 按 id 只回写单账号状态字段。
- **SW 挂起防护**：批量操作前把原始 cookie 快照持久化到 `storage.local._pendingRestore`；Service Worker 启动时检测残留 → 说明上次异常终止 → 自动恢复原 cookie，避免用户登录态永久丢失（仅保留 1 小时内的快照）。

### ✨ Added (P0/P1 体验)

- **扩展图标**：生成 16/32/48/128 四个尺寸 PNG，manifest 注册 `icons` + `action.default_icon`。工具栏不再显示默认拼图图标。
- **Firefox 权限授权引导**：Firefox MV3 的 `host_permissions` 默认不自动授权，popup 启动时用 `chrome.permissions.contains` 检测，缺失则显示黄色横幅 + 「授权」按钮触发 `chrome.permissions.request`。
- **新增 `PRIVACY_POLICY.md`**：完整隐私政策文档，明确数据收集范围、存储位置、权限用途、用户控制权。README 增加跳转链接。
- **账号去重优先 userId**：旧版仅按 sessionid 去重，同一账号重新登录 sessionid 变化就会产生重复记录。v1.3.0 改为 userId 优先（从 API 拉到），fallback sessionid，同时保留用户自定义的账号名。
- **切换账号只 reload active tab**：旧版无差别 reload 所有 jimeng tab，用户在其他 tab 未保存的工作会丢。v1.3.0 只 reload 当前激活的 tab，非 active tab 注入非阻塞提示"账号已切换，刷新后生效"（点击即 reload）。
- **过期横幅按钮检查切换结果**：旧版无视 `switchAccount` 返回值就更新 UI，会把失败显示成成功。现已检查 `res.success` 再更新。
- **导入模式三选一对话框**：旧版 `confirm("确定=合并 / 取消=覆盖")` 反直觉（用户取消=destructive）。v1.3.0 改为自定义 modal：合并（默认）/ 覆盖 / 取消，语义清晰。
- **`sendMsg` 显式处理 `chrome.runtime.lastError`**：避免 SW 崩溃或消息超时时 popup 静默显示空状态。

### 📝 Docs (P0/P1)

- **删除 README "禁商用" 条款**：与 MIT License 存在法律口径冲突，LICENSE 已明确允许商业使用，README 仅保留"使用风险提示"。
- **Firefox 文档口径调整**：明确区分"临时加载（开发用）"和"长期使用需走 Developer Edition / 自签名 XPI / AMO 审核"三条路径，删除已过时的"Profile 目录手动放文件夹"方法（Firefox 48 起已禁止）。

### 🧹 Changed (P1 代码质量)

- 抽出 `withAccountCookies` 和 `mergeAccountStatus` primitive，消除 `checkAccountStatus` / `checkAllStatuses` 间的代码重复。
- `withCookieLock` 的 `then(fn, fn)` 改为更规范的 `then(() => fn(), () => fn())`，并增加注释说明设计意图。
- 清理 `saveSettings` 等已无引用的残留 API。

### 三方审查贡献

| AI | 关键发现 |
|---|---|
| Codex | 并发锁缺失 ×3（saveCurrentAccount、读-改-写、switchAccount 失败）、MIT 与禁商用条款冲突、`confirm()` 反直觉 |
| Gemini | Cookie HTTP 降级漏洞、originalCookies 仅内存、Firefox host_permissions 需主动 request、隐私政策缺失 |
| Claude | 无图标、`host_permissions` 应 https-only、userId 去重、Git Release |

## [1.2.2] - 2026-04-14

### Added

- **完整的多浏览器安装指南 `INSTALL.md`**：覆盖 Chrome / Edge / Brave / Opera / Vivaldi / Arc / 360 极速 / QQ 浏览器 / 搜狗 / Yandex / Firefox 128+（3 种方式）/ Kiwi (Android) 全部主流浏览器的分步详细安装说明。
- 每个浏览器单独列出扩展页 URL、开发者模式开关位置、加载按钮中英文名、特殊注意事项。
- 附 2025-2026 浏览器扩展政策变更说明（MV2 停用、Chrome 137 CLI 标志移除等）。
- 常见问题 FAQ（Chrome 开发者模式警告、扩展图标失效、跨设备迁移账号等）。

### Changed

- README 的安装段落改为跳转到 `INSTALL.md`，提供速览信息，避免两处维护。

## [1.2.1] - 2026-04-14

### Added

- **Firefox 128+ 兼容**：manifest 增加 `browser_specific_settings.gecko` 字段，可直接通过 `about:debugging` 临时加载运行。
- README 增加多浏览器兼容表与分浏览器安装说明（Chrome / Edge / Brave / Opera / Vivaldi / Arc / 360 / QQ / Firefox）。

## [1.2.0] - 2026-04-14

### Changed

- **重大精简**：移除所有积分领取功能（即梦免费积分登录即自动领取，次日过期，无需囤积），扩展定位回归核心——快速账号切换器。
- 代码从 1066+400 行精简至 497+308 行。

### Removed

- 一键领取全部积分按钮、单账号领取按钮、`claimAll` / `claimOne` / `claimForAccountViaSession` 等所有 claim 相关函数。
- MD5 签名算法、`directApiRequest`、`claimCreditsDirect`、`getCreditsDirect` 等 service worker 直接 API 调用链。
- 定时自动领取（`chrome.alarms`）及相关 UI、权限声明。
- 切换账号后的自动领取逻辑。
- DOM 按钮点击兜底方案（`clickClaimButtons`）。
- Popup 打开时的 `autoRefresh` 触发（避免后台 cookie 轮换干扰用户正在浏览的即梦页面——这是 v1.1.x 频繁切换账号 bug 的根源）。

### Fixed

- **频繁切换账号 bug**：根因是 `checkAllStatuses` 在后台轮换 cookie 时每个账号都 flush storage，触发 popup 的 `storage.onChanged` → `render` → `detectCurrent` 读到中间状态的 cookie。修复：
  - `checkAllStatuses` 改为最后一次性保存，不再每账号 flush。
  - Popup 缓存 `cachedCurrentId`，被动 re-render（storage 监听）不重新探测 current，杜绝 UI 闪烁。
  - 「刷新状态」前弹确认框，明确提示用户过程中别操作即梦页面。

## [1.1.0] - 2026-04-12

### Changed

- **核心重构**：所有即梦 API 请求从 service worker 直连迁移到即梦页面上下文内执行。新增 `JimengTabSession`，利用 `chrome.scripting.executeScript` + `world: 'MAIN'` 在后台标签页里发起 `fetch`，让页面自己补全签名、指纹、referer、cookie——彻底解决 v1.0.0 一键领取失败（服务端返回"未登录"）的问题。
- 删除 ~340 行 MD5/签名代码（不再需要手工签名）。

### Added

- **Popup 打开自动后台刷新**：打开即见缓存数据，后台并行查询所有账号最新积分/VIP 状态（节流 5 分钟），通过 `storage.onChanged` 自动重渲染。
- **切换账号后自动刷新积分**：切到新账号 1.5 秒后后台自动查一次最新状态。
- **失败自动重试**：领取/状态查询失败时自动重试 1 次（未登录错误不重试）。
- **定时自动领取**（`chrome.alarms`）：设置面板里勾选开关和时间，到点后台静默执行 `claimAll`，结果写入设置可在下次打开 popup 时查看"上次自动领取：X/Y 成功"。
- **Session 过期告警横幅**：当有账号 session 失效时顶部显示黄色横幅提醒，点击"查看"自动切换到过期账号并提示重新登录。
- **账号导入/导出 JSON**：一键导出全量账号（cookie+元数据）到 json 文件；一键导入（合并或覆盖模式）。换机/备份无忧。
- **进度细节透明化**：批量操作进度条实时显示 "1/N 账号名 · 切换cookie/加载页面/领取中/查询积分/重试中" 等步骤，卡在哪一步一目了然。
- **Cookie 互斥锁**：所有会操作全局 cookie 的动作（切换、领取、查询）串行执行，杜绝并发竞争导致 session 错乱。

### Fixed

- `claimAllCredits` 现在每处理完一个账号就立刻 flush 存储，popup 可实时感知进度（之前要全部跑完才更新 UI）。
- 积分缓存字段名统一为 `{gift, purchase, vip, total}`，popup 领取结果显示的"余额"不再是 0。
- Cookie 写入生效等待时间从 300ms 延长到 600ms，规避 Windows 上偶发的 cookie store 延迟。

## [1.0.0] - 2026-04-12

### Added

- 一键保存当前即梦登录账号（自动获取昵称、头像、用户 ID）。
- 多账号一键切换，包含 Cookie 校验、自动重试、`localStorage` 缓存清理与标签页强制刷新。
- 一键批量领取所有账号的每日免费积分，自动备份并恢复原始登录状态。
- 单个账号独立领取积分。
- 账号列表展示：积分余额、VIP 等级与到期天数、Session 状态、今日是否已领取。
- 顶部摘要栏：账号总数、累计积分、今日已领取数量。
- 账号重命名与删除。
- 一键刷新所有账号的最新状态。

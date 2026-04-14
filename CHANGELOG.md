# Changelog

本项目的所有显著变更都会记录在这个文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

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

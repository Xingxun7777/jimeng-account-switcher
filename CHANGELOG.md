# Changelog

本项目的所有显著变更都会记录在这个文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

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

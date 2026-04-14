# 隐私政策 (Privacy Policy)

**生效日期**：2026-04-14
**适用版本**：即梦账号切换器 v1.3.0+

---

## TL;DR

- 本扩展**不向任何远程服务器发送**你的数据
- 所有账号 cookie 和元数据**仅保存在本地浏览器**（`chrome.storage.local`）
- 扩展只会与 **jimeng.jianying.com**（即梦官方域名）通信，且仅限读取账号状态
- 你**随时可以**在扩展里导出、导入、删除全部账号数据
- 无遥测、无埋点、无日志上报

---

## 1. 数据收集范围

本扩展会在**用户主动触发**下，收集并保存以下数据到你本地浏览器：

| 数据类型 | 来源 | 存储位置 | 用途 |
|---------|------|---------|------|
| `*.jianying.com` 域下的 Cookie | 浏览器 cookie store | `chrome.storage.local` | 多账号切换时恢复登录态 |
| 用户 ID / 昵称 / 头像 URL | 即梦 `/passport/account/info/v2` API | `chrome.storage.local` | 账号卡片展示、识别同账号 |
| 积分余额 / VIP 状态 | 即梦 `/commerce/v1/benefits/*` API | `chrome.storage.local` | 账号卡片展示 |
| 用户自定义名称 / Session 有效性 | 用户操作 / 查询结果 | `chrome.storage.local` | UI 展示 |

**不收集**：浏览历史、书签、密码、信用卡、地理位置、剪贴板、键盘输入、其他网站的数据。

---

## 2. 数据使用方式

- 保存的 cookie **仅用于** 在你主动点击"切换"时恢复到浏览器全局 cookie store
- 用户 ID / 昵称等元数据仅用于 popup UI 展示
- 所有操作均在**你的本地浏览器内**完成

---

## 3. 数据传输

### 会发送的网络请求

| 目标域名 | 场景 | 内容 |
|---------|------|------|
| `jimeng.jianying.com` | 保存账号 / 手动刷新状态 | 以当前 cookie 身份查询账号信息，返回积分/VIP 数据 |

### 不会发送的网络请求

- ❌ 不向作者、GitHub、第三方分析服务（Google Analytics、Sentry 等）发送任何数据
- ❌ 不使用任何远程 CDN 或外部脚本
- ❌ 无崩溃上报、无使用统计

扩展源码完全开源，你可以在 [GitHub 仓库](https://github.com/Xingxun7777/jimeng-account-switcher) 审计所有网络请求。

---

## 4. 数据存储

- 使用 Chrome 扩展 API `chrome.storage.local`，数据物理位置在浏览器 Profile 目录下（随浏览器的数据一起管理）
- **明文存储**——扩展不对 cookie 做任何加密（Chrome 扩展 API 本身有沙箱隔离，其他网站/扩展无法读取）
- 数据**永不离开你的设备**，除非你主动使用"导出账号"功能下载 JSON 文件

---

## 5. 你的权利与控制

你**随时**可以：

| 想做的事 | 如何做 |
|---------|-------|
| 查看有哪些数据 | 打开扩展 popup → 右上角齿轮 → "导出账号"查看完整 JSON |
| 删除单个账号 | popup 中点账号卡右上角 ✕ |
| 删除全部数据 | 在扩展管理页卸载扩展（自动清除所有 `storage.local`） |
| 备份所有数据 | "导出账号" → 保存 JSON 文件 |
| 迁移到新设备 | 目标设备装上扩展 → "导入账号" → 选 JSON |

---

## 6. 权限说明

扩展申请以下权限，对应用途如下：

| 权限 | 为什么需要 |
|-----|----------|
| `cookies` | 读取、写入、删除 `*.jianying.com` 的 cookie，这是账号切换的核心 |
| `storage` | 把账号列表保存到 `chrome.storage.local` |
| `tabs` | 账号切换后刷新你当前打开的即梦标签页 |
| `scripting` | 在即梦页面上下文发起 API 请求查询状态 / 切换后清理页面 localStorage 缓存 |
| `host_permissions: https://*.jianying.com/*` | 仅访问即梦 HTTPS 域名，不允许 HTTP |

扩展**不会**请求任何与上述用途无关的权限（例如读取历史记录、地理位置、书签等）。

---

## 7. 第三方服务

本扩展不集成、不嵌入任何第三方 SDK、分析服务、广告网络或远程配置。依赖的仅是：
- Chrome/Firefox WebExtension 标准 API
- 即梦官方 API（仅查询账号状态，与用户直接访问即梦网页时的请求一致）

---

## 8. 数据保留期

- 扩展本身**不设过期策略**，数据保留到你主动删除或卸载扩展
- 即梦官方 cookie 的过期时间由即梦服务端控制，过期后扩展会标记为"Session 过期"并建议你重新登录

---

## 9. 未成年人使用

本扩展无针对未成年人的特别设计。若你是未成年人，请在监护人指导下使用。

---

## 10. 许可证与安全

- 源码遵循 [MIT License](./LICENSE)，完全开源
- 任何人可以审计、Fork、自建
- 安全漏洞请通过 [GitHub Issues](https://github.com/Xingxun7777/jimeng-account-switcher/issues) 报告，标题带 `[security]` 前缀

---

## 11. 政策更新

本政策可能随扩展功能迭代更新，重大变更会在 CHANGELOG.md 和本文件顶部"生效日期"中标注。继续使用新版本扩展视为同意最新政策。

---

## 12. 联系方式

- GitHub：[@Xingxun7777](https://github.com/Xingxun7777)
- Issues：<https://github.com/Xingxun7777/jimeng-account-switcher/issues>

---

> 本扩展不是即梦官方产品，与字节跳动、即梦 (Jimeng) 团队无任何关联。使用即梦服务本身受其[官方用户协议](https://jimeng.jianying.com)约束。

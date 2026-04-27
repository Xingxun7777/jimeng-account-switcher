# 即梦账号切换器 (Jimeng Account Switcher)

[![Version](https://img.shields.io/github/v/release/Xingxun7777/jimeng-account-switcher?label=version&color=brightgreen)](https://github.com/Xingxun7777/jimeng-account-switcher/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

一款用于管理多个 [即梦](https://jimeng.jianying.com) 账号的浏览器扩展，主要功能是 **多账号快速切换** 与 **积分/VIP 状态展示**。

> 基于 **Manifest V3** 构建，无任何第三方依赖。兼容所有 Chromium 系浏览器（Chrome / Edge / Brave 等），以及 Firefox 128+。
>
> 📦 **最新稳定版 v1.5.0** — [查看 Release](https://github.com/Xingxun7777/jimeng-account-switcher/releases/latest)

---

## ✨ 功能特性

- **一键保存当前登录账号**：自动抓取 `*.jianying.com` 域下的 Cookie，并通过即梦官方 API 拉取昵称、头像、用户 ID、积分、VIP 信息。
- **多账号一键切换**：清空当前 Cookie → 写入目标账号 → 校验 `sessionid` → 清理页面 `localStorage` 缓存 → 强制刷新即梦标签页，切换干净彻底。
- **积分/VIP 状态展示**：每个账号卡片显示当前积分余额、VIP 等级与到期天数、Session 是否有效。
- **手动刷新状态**：一键遍历所有账号查询最新积分（过程中会临时切换 Cookie，会先弹窗提醒）。
- **Session 过期告警**：顶部黄条提醒失效账号，点击可跳转该账号即梦登录页补登。
- **账号导入/导出 JSON**：备份账号数据或跨设备迁移。
- **重命名 / 删除账号**：随手整理账号列表。

> 注：**不做积分领取**。即梦免费积分登录即自动领取，次日过期无法囤积，所以不需要手动触发。

---

## 📦 安装方式

**👉 完整安装指南见 [INSTALL.md](./INSTALL.md)**

覆盖所有主流浏览器（Chrome / Edge / Brave / Opera / Vivaldi / Arc / 360 / QQ / 搜狗 / Yandex / Firefox / Kiwi Android 等）的分步详细步骤、常见坑位、2025-2026 政策变更说明。

### 速览

**方式 1：下载 Release 包（推荐）**

到 [Releases 页面](https://github.com/Xingxun7777/jimeng-account-switcher/releases/latest) 下载 `jimeng-account-switcher-vX.X.X.zip`，解压到不会被清理的位置。

**方式 2：Clone 源码**

```bash
git clone https://github.com/Xingxun7777/jimeng-account-switcher.git
```

**加载步骤**

- **Chromium 系（Chrome/Edge/Brave 等）**：扩展管理页 → 开发者模式 → 加载已解压 → 选源码文件夹
- **Firefox 128+**：`about:debugging#/runtime/this-firefox` → 临时载入附加组件 → 选 `manifest.json`
- **Edge 用户注意**：开发者模式开关在**左下角**，不是右上角

⚠️ 源码文件夹**不要放在桌面**或会被清理的位置，扩展会持续引用这个路径。

---

## 🚀 使用流程

1. 在浏览器中正常登录任意一个即梦账号。
2. 点击扩展图标 → 「保存当前账号」，扩展会自动获取昵称、积分、VIP 状态。
3. 重复步骤 1–2 保存更多账号（每次先在浏览器里切换登录新账号）。
4. 之后随时：
   - 点击「切换」一键切到任意已保存账号。
   - 点击「刷新状态」批量更新所有账号的最新积分/VIP 信息（会先弹确认框）。
   - 点设置齿轮图标进入设置面板，可导出/导入账号。

---

## 🗂 项目结构

```
jimeng-account-switcher/
├── manifest.json        # Manifest V3 清单（含 Firefox 兼容配置）
├── background.js        # Service Worker：Cookie 管理 / 账号切换 / 状态查询
└── popup/
    ├── popup.html       # 弹窗 UI 结构
    ├── popup.css        # 弹窗样式
    └── popup.js         # 弹窗交互逻辑
```

---

## 🔧 技术说明

### 架构
- **Manifest V3** service worker + popup 结构
- 所有 API 调用通过 `chrome.scripting.executeScript` + `world: 'MAIN'` 在即梦页面上下文内执行，由页面自身补全签名、指纹、referer，避开服务端风控
- **双重互斥锁**：cookie store（`withCookieLock`）+ account storage（`withStorageLock`）独立串行，避免读-改-写竞争
- **崩溃恢复**：批量操作前把原 cookie 快照以阶段化状态（armed / business / committing）持久化到 `storage.local`；Service Worker 启动 + 消息唤醒时自动检测并恢复，避免意外终止丢失用户登录态

### 权限
| 权限 | 用途 |
|------|------|
| `cookies` | 读取/写入/删除 `.jianying.com` 域 Cookie |
| `storage` | 在 `chrome.storage.local` 中保存账号列表（明文仅在本地） |
| `tabs` | 查询并刷新即梦标签页 |
| `scripting` | 注入脚本清理页面 `localStorage` 缓存、在页面上下文发起 API 请求 |
| `host_permissions: https://*.jianying.com/*` | 访问即梦相关接口（仅 HTTPS，不允许明文 HTTP） |

### 切换账号的健壮性
- 同时查询 `.jianying.com` 与 `jimeng.jianying.com` 两个域，去重后统一删除，避免协议或域名差异造成残留
- 写入时按「普通 Cookie → 关键 auth Cookie（`sessionid` / `sid_tt` / `sid_guard` / ...）」的顺序；仅允许 HTTPS+secure 写入（**不降级** HTTP，防止凭证明文暴露）
- 切换完成后调用真实 userInfo API 校验，返回的 `userId` 必须与目标账号匹配——仅 cookie 存在但 session 失效的情况也会触发回滚
- 切换前注入脚本清理 `passport / token / user_status / __tea_cache_tokens` 等 `localStorage` 键，并清空 `sessionStorage`，避免页面缓存了上一个账号的状态
- **失败自动回滚**：任何阶段失败（cookie 写入/session 校验）都会回滚到原账号快照；回滚本身也失败时保留 pending，下次启动再试（最多 3 次）
- **Host-only cookie 正确处理**：host-only cookie 不传 `domain` 字段，由浏览器从 URL 推断，避免作用域被放宽为 domain cookie

---

## 🧪 自动化测试（Playwright）

本项目使用 **Playwright + 自带 Chromium** 做扩展回归测试。

> 原因：Playwright 官方已说明，**Google Chrome / Microsoft Edge 已移除稳定侧载扩展所需的命令行 flag**，因此扩展自动化测试应优先使用 Playwright 自带 Chromium，而不是依赖 `chrome://extensions/` 手工加载流程。

### 安装

```bash
npm install
npx playwright install chromium
```

### 运行

```bash
# 无头回归
npm test

# 有界面调试
npm run test:e2e:headed

# Playwright UI
npm run test:e2e:ui

# 真实凭证 smoke test（严格判定，失败返回非 0）
npm run smoke:live -- --authA .auth/account-a.json --authB .auth/account-b.json
```

### 当前覆盖的关键用例

- 扩展可成功加载
- popup 可直接通过 `chrome-extension://<id>/popup/popup.html` 打开
- “账号名称 / 备注”输入草稿会持久化并在重开 popup 后恢复
- 保存时会把自定义名称传给 background，并清空草稿
- popup 的切换 / 重命名 / 删除操作会派发到正确账号
- `JimengTabSession` 在已有即梦页时复用当前页，不再新开标签页
- `reloadJimengTabsForSwitch` 在已有即梦页时只刷新现有标签页，不创建新标签页
- 没有即梦页时，才回退到临时标签页
- 真实凭证 smoke：保存 A / 保存 B / 切 A / 切 B，且自动校验 userId 与“不新开页”

更完整的测试闭环与迭代规范见：[TESTING.md](./TESTING.md)

---

## 🌐 浏览器兼容性

| 浏览器 | 支持状态 | 备注 |
|--------|---------|------|
| Chrome | ✅ | 原生支持 MV3 |
| Microsoft Edge | ✅ | Windows 自带，Chromium 内核 |
| Brave | ✅ | |
| Opera / Vivaldi / Arc | ✅ | |
| 360 极速浏览器 / QQ 浏览器 / 搜狗浏览器 | ✅ | 需是 Chromium 内核版本 |
| Firefox 128+ | ✅ | 支持 `world: 'MAIN'` 的最低版本 |
| Firefox 109 - 127 | ⚠️ | 支持 MV3 但状态查询功能不可用 |
| Safari | ❌ | 未适配 |

---

## 🔒 隐私

本扩展不向任何远程服务器发送数据，所有账号 Cookie 仅保存在本地浏览器的 `storage.local` 中。完整说明见 [PRIVACY_POLICY.md](./PRIVACY_POLICY.md)。

## ⚠️ 使用风险提示

- 所有账号 Cookie 以明文形式保存在本地浏览器存储。请勿在不属于自己的设备上使用本扩展，也请谨慎管理导出的 JSON 文件（文件中的 cookie 可被任何人用来直接登录你的账号）。
- 即梦官方接口可能在任何时候变更，本扩展不保证持续可用。
- 使用本扩展产生的任何账号风险（限流、封禁等）由使用者自行承担。
- 使用者应遵守即梦官方的服务条款与相关法律法规。
- 如涉及侵权请通过 GitHub Issues 联系作者。

---

## 📄 License

[MIT](./LICENSE) © Xingxun

本项目在 MIT 许可证下发布，允许自由使用、修改、分发和商业使用，但不提供任何担保。

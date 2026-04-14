# 即梦账号切换器 (Jimeng Account Switcher)

一款用于管理多个 [即梦](https://jimeng.jianying.com) 账号的浏览器扩展，主要功能是 **多账号快速切换** 与 **积分/VIP 状态展示**。

> 基于 **Manifest V3** 构建，无任何第三方依赖。兼容所有 Chromium 系浏览器（Chrome / Edge / Brave 等），以及 Firefox 128+。

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

```bash
git clone https://github.com/Xingxun7777/jimeng-account-switcher.git
```

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
- 需要隔离的 Cookie 操作使用互斥锁（`withCookieLock`）串行执行

### 权限
| 权限 | 用途 |
|------|------|
| `cookies` | 读取/写入/删除 `*.jianying.com` 域 Cookie |
| `storage` | 在 `chrome.storage.local` 中保存账号列表（明文仅在本地） |
| `tabs` | 查询并刷新即梦标签页 |
| `scripting` | 注入脚本清理页面 `localStorage` 缓存、在页面上下文发起 API 请求 |
| `host_permissions: *://*.jianying.com/*` | 访问即梦相关接口 |

### 切换账号的健壮性
- 同时查询 `.jianying.com` 与 `jimeng.jianying.com` 两个域，去重后统一删除，避免协议或域名差异造成残留
- 写入时按「普通 Cookie → 关键 auth Cookie（`sessionid` / `sid_tt` / `sid_guard` / ...）」的顺序，关键 Cookie 写失败时降级为 HTTP 协议重试
- 切换完成后调用 `chrome.cookies.get` 校验 `sessionid` 是否成功落地，未成功则自动重试一次
- 切换前注入脚本清理 `passport / token / user_status / __tea_cache_tokens` 等 `localStorage` 键，并清空 `sessionStorage`，避免页面缓存了上一个账号的状态

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

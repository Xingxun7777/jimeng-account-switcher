# 即梦账号切换器 (Jimeng Account Switcher)

一款用于管理多个 [即梦](https://jimeng.jianying.com) 账号的 Chrome / Edge 浏览器扩展，支持一键切换账号、批量领取每日免费积分、查看积分与会员状态。

> 基于 **Manifest V3** 构建，无需任何第三方依赖。

---

## ✨ 功能特性

- **一键保存当前登录账号**：自动抓取 `*.jianying.com` 域下的 Cookie，并通过即梦官方 API 拉取昵称、头像、用户 ID。
- **多账号一键切换**：清空当前 Cookie → 写入目标账号 → 校验 `sessionid` → 清理页面 `localStorage` 缓存 → 强制刷新即梦标签页，确保切换干净彻底。
- **一键批量领取每日积分**：依次为所有保存的账号调用 `commerce/v1/benefits/credit_receive`，自动间隔 2 秒规避频控；领取完成后自动恢复原始登录状态。
- **单账号单独领取**：列表中每个账号都有独立的「领取」按钮。
- **账号状态总览**：积分余额、VIP 等级与到期天数、Session 是否有效、今日是否已领取。
- **重命名 / 删除账号**：随手整理账号列表。
- **顶部摘要栏**：账号总数、累计积分、今日已领取数量一眼可见。

---

## 📦 安装方式

> 本扩展未上架 Chrome 网上应用店，需要以「开发者模式」加载。

1. **下载源码**

   ```bash
   git clone https://github.com/Xingxun7777/jimeng-account-switcher.git
   ```

   或在仓库主页点击 **Code → Download ZIP** 下载并解压。

2. **打开扩展程序页面**

   - Chrome：地址栏访问 `chrome://extensions/`
   - Edge：地址栏访问 `edge://extensions/`

3. **启用「开发者模式」**（页面右上角开关）。

4. **点击「加载已解压的扩展程序」**，选择本仓库根目录（包含 `manifest.json` 的文件夹）。

5. 安装完成后，工具栏会出现「即梦账号管理」图标，建议固定到工具栏。

---

## 🚀 使用流程

1. 在浏览器中正常登录任意一个即梦账号。
2. 点击扩展图标 → 「保存当前账号」，扩展会自动获取昵称、积分、VIP 状态。
3. 重复步骤 1–2 保存更多账号（每次需先在浏览器里登录新的账号）。
4. 之后随时通过弹窗：
   - 点击「切换」一键切到任意已保存账号。
   - 点击「一键领取全部积分」自动遍历全部账号领取今日免费积分。
   - 点击「刷新」批量更新所有账号的最新状态。

---

## 🗂 项目结构

```
jimeng-account-switcher/
├── manifest.json        # Manifest V3 清单
├── background.js        # Service Worker：Cookie 管理 / API 签名 / 账号切换 / 积分领取
└── popup/
    ├── popup.html       # 弹窗 UI 结构
    ├── popup.css        # 弹窗样式
    └── popup.js         # 弹窗交互逻辑
```

---

## 🔧 技术说明

- **Manifest V3**：使用 `service_worker` 而非传统 background page。
- **权限**
  - `cookies` —— 读取 / 写入 / 删除 `*.jianying.com` 域 Cookie。
  - `storage` —— 在 `chrome.storage.local` 中保存账号列表。
  - `tabs` —— 查询并刷新即梦标签页。
  - `scripting` —— 注入脚本清理页面 `localStorage`、`sessionStorage` 缓存。
  - `host_permissions: *://*.jianying.com/*` —— 访问即梦相关接口。
- **API 签名**：即梦后端接口需要 `Sign` / `Device-Time` 等头部。`background.js` 内置纯 JS 版 MD5（基于 Joseph Myers 的 public domain 实现），按 `9e2c|<uri后7字符>|7|5.8.0|<timestamp>||11ac` 的格式生成签名。
- **Cookie 切换的健壮性处理**
  - 同时查询 `.jianying.com` 与 `jimeng.jianying.com` 两个域，去重后统一删除，避免协议或域名差异造成残留。
  - 写入时按「普通 Cookie → 关键 auth Cookie（`sessionid` / `sid_tt` / `sid_guard` / ...）」的顺序，关键 Cookie 写失败时降级为 HTTP 协议重试。
  - 切换完成后调用 `chrome.cookies.get` 校验 `sessionid` 是否成功落地，未成功则自动重试一次。
  - 切换前注入脚本清理 `passport / token / user_status / receive_credits / dialog_manager_daily / __tea_cache_tokens` 等 `localStorage` 键，并清空 `sessionStorage`，避免页面缓存了上一个账号的状态。
- **批量领取的安全性**
  - 操作前会先备份当前浏览器中的 Cookie，结束后自动恢复，不会破坏当前正在使用的登录状态。
  - 账号之间间隔 2 秒，规避后端频控。

---

## ⚠️ 免责声明

- 本扩展仅供个人 **学习和研究** 使用，请勿用于任何商业用途或违反即梦官方服务条款的行为。
- 所有账号 Cookie 仅以明文形式保存在 **本地浏览器** 的 `chrome.storage.local` 中，**不会** 上传到任何远程服务器。请勿在不属于自己的设备上使用本扩展。
- 即梦官方接口可能在任何时候变更，本扩展不保证持续可用。
- 使用本扩展产生的任何账号风险（限流、封禁等）由使用者自行承担。
- 如有侵权请联系作者删除。

---

## 📄 License

[MIT](./LICENSE) © Xingxun

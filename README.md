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

> 本扩展未上架任何应用商店，需要以「开发者模式」加载。

### 1. 下载源码

```bash
git clone https://github.com/Xingxun7777/jimeng-account-switcher.git
```

或在仓库主页点击 **Code → Download ZIP** 下载并解压。

### 2. 根据你的浏览器选择安装方式

#### Chrome / Edge / Brave / Opera / Vivaldi / Arc / 360 极速 / QQ 浏览器 等 Chromium 系

1. 打开扩展管理页：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
   - Brave：`brave://extensions/`
   - 其他 Chromium 系浏览器类似
2. 开启页面右上角的「开发者模式」开关
3. 点击「加载已解压的扩展程序」（Load unpacked）
4. 选择本仓库根目录（含 `manifest.json` 的文件夹）

#### Firefox 128+

1. 地址栏访问 `about:debugging#/runtime/this-firefox`
2. 点击「临时载入附加组件」（Load Temporary Add-on）
3. 选择仓库根目录下的 `manifest.json`

> ⚠️ Firefox 临时加载的扩展每次重启浏览器都会消失。如需长期使用，需自行对扩展打包签名或安装 Firefox Developer Edition。

### 3. 固定到工具栏

安装完成后，工具栏会出现「即梦账号管理」图标，建议点击拼图图标将其固定显示。

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

## ⚠️ 免责声明

- 本扩展仅供个人 **学习和研究** 使用，请勿用于任何商业用途或违反即梦官方服务条款的行为。
- 所有账号 Cookie 仅以明文形式保存在 **本地浏览器** 的 `storage.local` 中，**不会** 上传到任何远程服务器。请勿在不属于自己的设备上使用本扩展。
- 即梦官方接口可能在任何时候变更，本扩展不保证持续可用。
- 使用本扩展产生的任何账号风险（限流、封禁等）由使用者自行承担。
- 如有侵权请联系作者删除。

---

## 📄 License

[MIT](./LICENSE) © Xingxun

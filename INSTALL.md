# 📖 安装指南

> 本文档最后更新于 **2026-04-27**，覆盖主流桌面浏览器和部分 Chromium 衍生浏览器的安装步骤与兼容边界。

本扩展未上架任何浏览器商店，需要以“开发者模式”加载。支持目标是：现代 Chromium 系浏览器（Chrome / Edge / Brave 等，Chromium 102+，建议最新版）和 Firefox 140+ 桌面版。国产/移动浏览器必须看实际内核与是否允许加载已解压扩展，不能简单等同于 Chrome。

---

## 0. 前置准备：下载源码

### 方式一：git clone（推荐）

```bash
git clone https://github.com/Xingxun7777/jimeng-account-switcher.git
```

克隆后直接使用克隆出的文件夹作为扩展根目录。

### 方式二：下载 ZIP

1. 打开 [仓库主页](https://github.com/Xingxun7777/jimeng-account-switcher)
2. 点击绿色 **Code** 按钮 → **Download ZIP**
3. 解压到任意位置（路径不要有中文和空格，避免奇怪的问题）

**⚠️ 切记**：不要把扩展文件夹放在**桌面**或任何会**经常清理**的位置。扩展一旦加载后，浏览器会持续引用这个路径，**文件夹被移动或删除 = 扩展失效**，账号数据也会一起丢失（虽然数据本身在浏览器存储里，但扩展 ID 会变）。

推荐放在专门的目录，例如：
- Windows: `C:\Users\你的用户名\chrome-extensions\jimeng-account-switcher\` 或 `D:\ChromeExtensions\...`
- macOS: `~/chrome-extensions/jimeng-account-switcher/`
- Linux: `~/chrome-extensions/jimeng-account-switcher/`

---

## 1. Chromium 系浏览器（90% 的用户看这里）

支持目标是 **Chromium 102+**。加载流程本质相同，只是**扩展管理页 URL**和**开发者模式开关位置**略有差异。内核太旧的国产/定制浏览器即使能打开扩展页，也可能不支持 MV3 service worker 或 `scripting.ExecutionWorld`。

### 通用四步法

1. 在地址栏输入对应的**扩展管理页 URL**（见下表）并回车
2. 打开**「开发者模式」**开关（位置见下表）
3. 点击**「加载已解压的扩展程序」**（Load unpacked）
4. 选择下载后解压的**文件夹**（里面要含 `manifest.json`）

加载成功后，工具栏会出现「即梦账号管理」图标，建议点工具栏的拼图图标把它**固定**显示。

### 各浏览器速查表

| 浏览器 | 扩展页 URL | 开发者模式位置 | 按钮中文名 |
|--------|-----------|--------------|----------|
| **Google Chrome** | `chrome://extensions/` | 页面**右上角** | 加载已解压的扩展程序 |
| **Microsoft Edge** | `edge://extensions/` | 页面**左下角**⚠️ | 加载解压缩的扩展 |
| **Brave** | `brave://extensions/` | 右上角 | Load unpacked |
| **Opera** | `opera://extensions/` | 右上角 | Load unpacked |
| **Vivaldi** | `vivaldi://extensions/` | 右上角 | Load unpacked |
| **Arc**（macOS/Windows） | `chrome://extensions/` | 右上角 | Load unpacked |
| **360 极速浏览器** | `se://extensions/` | 右上角 | 加载已解压的扩展程序 |
| **QQ 浏览器** | `qqbrowser://extensions/manage` | 右上角 | 加载已解压的扩展程序 |
| **搜狗浏览器** | `chrome://extensions/` 或 `se://extensions/` | 右上角 | 加载已解压的扩展程序 |
| **Yandex Browser** | `browser://extensions/` | 页面内开关 | Load Unpacked |

### 🔴 Edge 用户特别注意

**Edge 的「开发者模式」开关在页面左下角**，和所有其他浏览器都不一样。很多人找不到，其实在左侧边栏最底部。

### 1.1 Chrome 详细步骤

1. 打开新标签页，地址栏输入 `chrome://extensions/` 回车
2. 页面右上角有一个蓝色开关「**开发者模式**」，打开它
3. 页面左上方会出现三个新按钮：「**加载已解压的扩展程序**」「**打包扩展程序**」「**更新**」
4. 点「**加载已解压的扩展程序**」
5. 在文件选择对话框中，选中本仓库根目录（`manifest.json` 所在的那个文件夹），点**选择**
6. 扩展出现在列表里，蓝色切换开关为开启状态即安装成功
7. 点地址栏右侧的**拼图图标** → 找到「即梦账号管理」→ 点**图钉**图标固定到工具栏

> **每次打开 Chrome 会弹"请停用以开发者模式运行的扩展程序"警告**——这是 Google 的设计，对于开发者加载的扩展无法完全屏蔽。点关闭即可，不影响使用。

### 1.2 Microsoft Edge 详细步骤

1. 地址栏输入 `edge://extensions/` 回车
2. **页面左下角**的「开发人员模式」开关，打开它
3. 页面左上角出现「**加载解压缩的扩展**」按钮
4. 点击 → 选择本仓库根目录 → 确定
5. 扩展出现在列表，打开其切换开关即生效
6. 工具栏右侧拼图图标 → 固定「即梦账号管理」

### 1.3 Brave / Opera / Vivaldi / Arc

流程与 Chrome 基本一致：
- **Brave**：`brave://extensions/` 或直接用 `chrome://extensions/`（两者等价）
- **Opera**：`opera://extensions/`
- **Vivaldi**：`vivaldi://extensions/`（也可用快捷键 `Ctrl+Shift+E`）
- **Arc**：地址栏输入 `chrome://extensions/`（Arc 仍使用 Chromium 扩展页）

### 1.4 国产浏览器

#### 360 极速浏览器 X

1. 地址栏输入 `se://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」→ 选文件夹

#### QQ 浏览器

1. 地址栏输入 `qqbrowser://extensions/manage`（或菜单 → 工具 → 扩展程序）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」→ 选文件夹

#### 搜狗浏览器

搜狗浏览器版本较杂，先试 `chrome://extensions/`，不行再试 `se://extensions/`，最后用菜单「工具 → 扩展程序」。开发者模式开关和加载按钮同 Chrome。

---

## 2. Firefox（140+）

本仓库将 Firefox 桌面版支持下限设为 **140.0**。原因不是单一 API，而是 Firefox 扩展签名、Manifest V3、`browser.*` Promise API、`scripting.ExecutionWorld` 与 AMO 2025+ 数据收集声明兼容要求的组合；低于 140 的版本不作为支持目标。

> **⚠️ 重要前置说明**：Firefox 的 Release / Beta 版本**强制要求扩展签名**。下面三种方式各有限制，请根据你的需求选择。**未签名扩展没有真正"简单永久"的安装方式**——这是 Firefox 的安全设计，不是本扩展的限制。

### 2.1 临时加载（开发 / 短期体验用）

1. 地址栏输入 `about:debugging#/runtime/this-firefox` 回车
2. 点击「**临时载入附加组件...**」（Load Temporary Add-on...）
3. **注意：这里要选扩展文件夹中的 `manifest.json` 文件，不是文件夹本身**
4. 扩展列表会显示"即梦账号管理（TEMPORARY）"

**⚠️ 限制**：临时加载的扩展**每次重启 Firefox 就会消失**，要重新加载。**不适合长期使用**。

### 2.2 长期使用方案 A：用 Firefox Developer Edition / Nightly / ESR

这些版本允许关闭签名强制要求。

1. 下载 [Firefox Developer Edition](https://www.mozilla.org/zh-CN/firefox/developer/)、[Nightly](https://www.mozilla.org/zh-CN/firefox/nightly/) 或 Firefox ESR
2. 地址栏输入 `about:config`，同意风险警告
3. 搜索 `xpinstall.signatures.required`，双击改为 `false`（**仅 Developer / Nightly / ESR / Unbranded 这类允许关闭签名检查的版本生效；普通 Release 版改了也没用**）
4. 把扩展文件夹用 **7-Zip / WinRAR** 打成 `.zip`（**不能包含顶层文件夹，根目录直接是 manifest.json**），再把扩展名改成 `.xpi`
5. 地址栏输入 `about:addons`，拖入 `.xpi` 文件安装
6. 每次更新扩展需要重新打包安装

### 2.3 长期使用方案 B：自签名 XPI（稍麻烦，Release 版可用）

Firefox 允许用户自签名 XPI 供自己使用：

1. 注册 [addons.mozilla.org (AMO)](https://addons.mozilla.org/developers/) 开发者账号（免费）
2. 用 [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) CLI 工具：
   ```bash
   npm install -g web-ext
   cd jimeng-account-switcher/
   web-ext sign --api-key=XXX --api-secret=YYY --channel=unlisted
   ```
3. 签名通过后会生成一个已签名的 `.xpi`，在任何版本的 Firefox 里都能永久安装

> **注**：`--channel=unlisted` 不会提交到 AMO 商店，只供私人使用，审核通常几分钟自动通过。

### 2.4 长期使用方案 C：正式发布到 AMO（推荐给正式分发）

如果你想让其他人也能装，正经路径是提交到 AMO 审核：

1. 把扩展打包成 `.zip`
2. 上传到 <https://addons.mozilla.org/developers/addon/submit/>
3. 选择"公开发布"（需要人工审核，1 天到几周不等）
4. 审核通过后用户可在 AMO 一键安装

**⚠️ 不要相信"修改 profile 目录手动放文件夹"这种方法**——这在老版 Firefox 上可行，但从 Firefox 48 起就被完全禁止了（除非走上面的签名流程）。某些网文/博客还在介绍这种方法，已过时。

---

## 3. Android 端：Kiwi Browser

[Kiwi Browser](https://kiwibrowser.com/) 是 Android 上常见的 Chrome 扩展加载方案之一，但不属于本项目的自动化回归目标；能否稳定运行取决于 Kiwi 当时的 MV3 实现。

1. 安装并打开 Kiwi Browser
2. 用 Android 文件管理器（推荐 **Total Commander** 或 **MT 管理器**）把扩展文件夹解压到手机存储，例如 `/sdcard/Download/jimeng-account-switcher/`
   - **文件夹名不能以下划线 `_` 开头**，否则 Kiwi 会拒绝加载
3. 在 Kiwi Browser 地址栏输入 `chrome://extensions` 回车
4. 右上角打开「Developer mode」
5. 点击「**+ (from .zip/.crx/.user.js)**」或「**Load unpacked**」
6. 用文件管理器导航到扩展目录，**选中 `manifest.json` 文件**（与桌面版选文件夹不同）
7. 刷新 `chrome://extensions` 就能看到扩展了

**⚠️ Kiwi 的限制**：MV3 service worker 的 alarm 最短周期是 30 秒（桌面版是 1 分钟），本扩展不依赖 alarms，不受影响。

---

## 4. Safari（macOS）——目前不支持

本扩展**暂不支持 Safari**。Safari 需要通过 Xcode 的 `xcrun safari-web-extension-converter` 工具把 MV3 扩展转换为 Safari Web Extension，流程复杂，且需要 Apple Developer 账号（99 美元/年）才能长期使用。

如果有 macOS 用户确有需求，可自行尝试转换，但不保证能跑通（Safari 对 MV3 的 API 兼容性与 Chromium 有差异）。

---

## 5. 验证安装

装好之后按以下步骤确认扩展工作正常：

1. 打开任意即梦页面并正常登录一个账号
2. 点击浏览器工具栏的扩展图标「**即梦账号管理**」
3. 点「**保存当前账号**」按钮
4. 如果弹出 toast「已保存: XXX」且账号卡片出现在列表里（带昵称、头像、积分数字），说明一切正常

如果报错「未检测到即梦登录状态」，说明当前浏览器里没登录过即梦，先登录一次再保存。

---

## 6. 更新扩展版本

### Chromium 系（Chrome / Edge 等）

1. `cd` 到仓库目录
2. `git pull`
3. 回到扩展管理页，找到「即梦账号管理」
4. 点扩展卡片上的**刷新/重新加载**图标（🔄）

或直接重启浏览器也行。

### Firefox 临时加载

每次更新后需要在 `about:debugging` 重新 Load Temporary Add-on。

### Firefox 已签名 XPI / Developer / Nightly / ESR

- 已签名 XPI：重新打包/签名后，在 `about:addons` 移除旧版再安装新版，或按 AMO 更新流程更新。
- Developer / Nightly / ESR 手动安装：替换 XPI 后重启 Firefox。
- 不支持“直接替换 Release 版 profile 目录里的未签名扩展文件夹”作为长期方案。

---

## 7. 卸载扩展

### Chromium 系

扩展管理页 → 找到「即梦账号管理」→ 点「移除」按钮。

### Firefox

`about:addons` → 找到扩展 → 点「...」→ 移除。

**注意**：卸载会同时删除所有已保存的账号数据。如有需要，先在扩展里点设置齿轮 → 「导出账号」备份成 JSON 文件。

---

## 8. 常见问题

### Q1: Chrome 启动时总弹「请停用以开发者模式运行的扩展程序」

Google 的硬性设计，无法用扩展本身屏蔽。点右上角 × 关闭即可。企业环境可通过组策略 `BlockExternalExtensions=false` + `ExtensionInstallWhitelist` 方式免除，个人用户只能忍着。

### Q2: 扩展图标显示但点击没反应

打开扩展管理页，点扩展卡片上的「检查视图 Service Worker」或「inspect views」链接，看 console 有没有报错。通常是扩展文件夹被移动导致的路径失效——移回原位置或重新加载即可。

### Q3: 「刷新状态」功能在 Firefox 里没反应

请先确认 Firefox 版本为 140+，并确认扩展不是普通 Release 版里的未签名临时/失效安装。若仍异常，优先用 Chromium 系验证，因为本项目的自动化回归门禁目前跑在 Playwright Chromium。

### Q4: 换了台电脑，账号数据怎么搬？

在旧电脑的扩展里点设置齿轮 → 「导出账号」→ 得到一个 JSON 文件。拷贝到新电脑，在新装的扩展里点「导入账号」→ 选这个 JSON。

### Q5: 切换账号后即梦网页还显示旧账号

- 确认你正在看的即梦标签页是否被正确刷新了（F5 强制刷新一次）
- 右键 → 检查 → Application → Cookies → `https://jimeng.jianying.com`，看 `sessionid` 是否真的变了
- 如果 sessionid 正确但页面没反应，可能是页面有本地缓存未清——关闭即梦标签页重新打开

### Q6: 扩展能上传我的账号密码到服务器吗？

**不能也不会**。本扩展只在本地浏览器读写 Cookie 和本地存储。源码开源可审，欢迎查 `background.js` 确认。如果担心，完全不联网使用也能完成所有功能（唯一的网络请求是调即梦自己的 API）。

---

## 9. 2025-2026 关键政策变更

浏览器扩展生态近期有几个重要变化，了解一下避免踩坑：

| 变更 | 影响本扩展吗？ |
|------|-------------|
| Chrome Manifest V2 已停用（2024-06 起） | ✅ 不影响，本扩展是 MV3 |
| Google Chrome / Microsoft Edge 在自动化场景移除了稳定侧载扩展所需的命令行 flag | ✅ 不影响手动 UI 加载；自动化测试使用 Playwright 自带 Chromium |
| Firefox Release/Beta 强制扩展签名 | ⚠️ 临时加载可测试；长期使用需签名 XPI 或使用允许关闭签名检查的版本 |
| Chromium 企业策略 `ExtensionManifestV2Availability=2` 延期至 2026-06 | ✅ 不影响 |

---

## 📮 反馈

安装过程遇到本文档未覆盖的问题？欢迎到 [GitHub Issues](https://github.com/Xingxun7777/jimeng-account-switcher/issues) 提问。

# 📖 安装指南

> 本文档最后更新于 **2026-04-14**，覆盖所有主流桌面/移动浏览器的详尽安装步骤。

本扩展未上架任何浏览器商店，需要以"开发者模式"加载。所有 Chromium 系浏览器（Chrome / Edge / Brave 等）零改动即可使用，Firefox 128+ 通过本仓库内置的 `browser_specific_settings.gecko` 配置也能直接加载。

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

所有 Chromium 内核浏览器的加载流程本质相同，只是**扩展管理页 URL**和**开发者模式开关位置**略有差异。

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

## 2. Firefox（128+）

Firefox 128 及以上版本完整支持 Manifest V3 + `world: 'MAIN'` 注入脚本（这是本扩展必需的特性）。低于 128 的 Firefox 无法使用「刷新状态」功能。

### 2.1 临时加载（最简单、开发用）

1. 地址栏输入 `about:debugging#/runtime/this-firefox` 回车
2. 点击「**临时载入附加组件...**」（Load Temporary Add-on...）
3. **注意：这里要选扩展文件夹中的 `manifest.json` 文件，不是文件夹本身**
4. 扩展列表会显示"即梦账号管理（TEMPORARY）"

**⚠️ 限制**：临时加载的扩展**每次重启 Firefox 就会消失**，要重新加载。适合偶尔用用或开发测试。

### 2.2 永久安装方案 A：用 Firefox Developer Edition

1. 下载 [Firefox Developer Edition](https://www.mozilla.org/zh-CN/firefox/developer/)（或 Firefox Nightly）
2. 地址栏输入 `about:config`，同意风险警告
3. 搜索 `xpinstall.signatures.required`，双击将值改为 `false`
4. 将扩展文件夹打包成 `.zip`，重命名为 `.xpi`
5. 地址栏输入 `about:addons`，拖入 `.xpi` 文件安装

### 2.3 永久安装方案 B：用 Profile 目录（正式版也能用）

1. 地址栏输入 `about:profiles`，找到当前使用的 profile 目录
2. 在 profile 目录中找到或创建 `extensions/` 子目录
3. 把扩展文件夹整个复制进去，**文件夹名必须改为** `jimeng-account-switcher@xingxun.local`（这是本扩展 manifest 里声明的 gecko.id）
4. 重启 Firefox
5. `about:addons` 中会看到扩展，打开即可

---

## 3. Android 端：Kiwi Browser

[Kiwi Browser](https://kiwibrowser.com/) 是 Android 上唯一支持桌面级 Chrome 扩展的浏览器。

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

### Firefox Profile 目录安装

替换目录内的文件后重启 Firefox。

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

你的 Firefox 版本低于 128。`world: 'MAIN'` 注入脚本是 Firefox 128 引入的，更低版本不支持。升级浏览器或用 Chromium 系。

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
| Chrome 137+ 移除 `--load-extension` 命令行参数 | ✅ 不影响，UI 加载按钮保留 |
| Firefox 128 支持 `world: 'MAIN'` 脚本注入 | ⚠️ 低版本 Firefox 无法使用状态查询 |
| Chromium 企业策略 `ExtensionManifestV2Availability=2` 延期至 2026-06 | ✅ 不影响 |

---

## 📮 反馈

安装过程遇到本文档未覆盖的问题？欢迎到 [GitHub Issues](https://github.com/Xingxun7777/jimeng-account-switcher/issues) 提问。

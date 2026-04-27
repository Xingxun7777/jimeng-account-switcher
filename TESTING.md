# 测试与优化迭代流程

## 1. 插件目标

这个插件的核心目的不是“显示一个列表”，而是帮助用户**稳定管理多个即梦账号**，并且在日常使用中做到：

1. **保存当前账号**
   - 从当前浏览器登录态提取账号 Cookie
   - 自动识别昵称 / 用户 ID / 积分 / VIP
   - 允许用户输入自定义备注或账号名称

2. **切换账号**
   - 优先复用当前已打开的即梦页面
   - 清理旧账号残留状态
   - 写入目标账号 Cookie
   - 刷新现有即梦页面，而不是无意义新开页面

3. **管理账号**
   - 查看已保存账号
   - 重命名
   - 删除
   - 导入 / 导出

4. **验证状态**
   - Session 是否有效
   - 积分 / VIP 是否可读
   - 切换失败时是否回滚

---

## 2. 验收标准

### A. 保存链路
- popup 中可输入“账号名称 / 备注”
- 草稿会自动持久化
- 重新打开 popup 后草稿仍在
- 点击“保存当前账号”时，自定义名称会传到 background
- 保存成功后草稿应清空

### B. 切换链路
- 有即梦页时，切换不会额外创建新标签页
- 同窗口的 active 即梦页会被刷新
- 非 active 即梦页只收到提示，不被强刷
- 没有即梦页时，才允许创建一个兜底页面

### C. 管理链路
- popup 列表可渲染保存账号
- 点击“切换”会派发到正确账号 ID
- 点击“重命名”会发送正确的新名称
- 点击“删除”会发送正确的账号 ID

### D. 工程链路
- background / popup 脚本语法合法
- Playwright 扩展测试可重复运行
- 有头 / 无头两种模式都能通过

---

## 3. 自动化测试策略

## 分层

### 第 1 层：静态语法验证
命令：

```bash
npm run lint:syntax
```

目标：
- `background.js`
- `popup/popup.js`

### 第 2 层：Playwright 扩展回归
命令：

```bash
npm test
```

当前覆盖：
- 扩展加载
- popup 打开
- 备注草稿持久化
- 保存时传递自定义名称
- popup 切换动作派发
- popup 重命名 / 删除动作派发
- `JimengTabSession` 复用已有即梦页
- `reloadJimengTabsForSwitch` 不新开页、按窗口刷新
- 无即梦页时回退临时页

### 第 3 层：有头回归
命令：

```bash
npm run test:e2e:headed
```

目标：
- 肉眼确认 popup / 页面行为与自动化断言一致
- 排查只在可视模式下出现的时序问题

### 第 4 层：人工真实账号 smoke test
> 这层依赖真实即梦登录凭证，但拿到凭证后已经可以由脚本全自动执行。

标准链路：

1. 从真实已登录 profile 导出账号 A / B 凭证
2. 用全新 Playwright 扩展上下文导入 A / B 凭证
3. 自动执行“保存 A → 保存 B → 切 A → 切 B”
4. 自动判定：
   - 保存阶段必须拿到有效 `userId`
   - 切换后返回的 `userId` 必须与目标账号一致
   - 切换过程中不得新开额外即梦标签页

#### 4A. Service Worker 级真实凭证 smoke

用于验证后台核心函数本身是否能保存/恢复真实 cookie。

命令：

```bash
npm run auth:export-current -- --label account-a --userDataDir <A-profile-dir>
npm run auth:export-current -- --label account-b --userDataDir <B-profile-dir>
npm run smoke:live -- --authA .auth/account-a.json --authB .auth/account-b.json
```

说明：
- `smoke:live` 现在是**严格判定脚本**：任一保存/切换失败都会返回非 0 退出码。
- 因此这层现在已经能作为“真实链路是否可交付”的自动门禁，而不只是打印日志。

#### 4B. Popup 级真实用户路径 smoke（交付前必须跑）

用于模拟用户真实操作：打开即梦页 → 打开扩展 popup → 通过 UI 导入账号 → 点击账号卡片「切换」。
这个脚本会在每次点击前后检查：

- 页面 `userId` 是否切到目标账号；
- 切换前后即梦 tab 数量是否保持不变；
- 点击「切换」期间是否发生过新的即梦 tab 创建事件；
- 自动保存设置保持默认开启，确保覆盖真实用户环境下的事件竞态。

命令：

```bash
npm run smoke:live:popup -- --authList .auth/account-a.json,.auth/account-b.json
npm run smoke:live:popup -- --authList .auth/account-a.json,.auth/account-b.json --headed
```

说明：
- `--headed` 会打开真实可视浏览器窗口，用于排查“点一下会不会肉眼看到新开网页”这类问题。
- 输出中的 `createdJimengTabsDuringSwitch` 必须为空，`beforeJimengTabCount` / `afterJimengTabCount` 必须相同。

---

## 4. 一键验证闭环

推荐使用：

```bash
npm run verify
```

它会执行：

1. 语法检查
2. Playwright 全量回归

如果失败，修复流程必须遵守：

1. **先补测试再改逻辑**（避免回归）
2. 修复代码
3. 重新执行 `npm run verify`
4. 必要时再执行 `npm run test:e2e:headed`

---

## 5. 优化迭代规则

每次新增需求或修 bug，都按以下步骤：

1. **定义需求**
   - 用户想达到什么目标？
   - 成功标准是什么？

2. **确定风险点**
   - 会不会影响账号切换？
   - 会不会影响 storage 持久化？
   - 会不会影响现有 popup 交互？

3. **先写或补测试**
   - 先把预期行为固化成 Playwright 用例

4. **实现修改**
   - 优先最小改动
   - 避免破坏既有消息协议

5. **执行验证**
   - `npm run verify`
   - 必要时 `npm run test:e2e:headed`

6. **输出结论**
   - 当前是否达到目标
   - 还有哪些剩余风险

---

## 6. 当前结论（截至 2026-04-22）

### 已确认可用
- 自定义备注录入与持久化链路
- popup 的切换 / 重命名 / 删除交互链路
- 已有即梦页时的“同页切换”核心逻辑
- 无即梦页时的兜底创建逻辑
- Playwright 扩展回归流程

### 仍需真实账号验证
- 即梦线上 Cookie 的真实写入 / 恢复效果
- 真实 userInfo / credit / VIP 接口返回兼容性
- 线上风控或登录态失效场景

目前系统已经能自动识别这类外部集成问题：
- 如果保存阶段拿不到有效 `userId`，脚本会直接失败，而不是把坏账号写进列表
- 如果切换后返回账号与目标账号不一致，脚本会直接失败

这不是工程缺失，而是**任何无真实账号凭证的本地自动化都无法替代的外部集成验证**。

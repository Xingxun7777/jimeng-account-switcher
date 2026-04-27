// ================================================================
// 即梦账号切换器 - Popup V3 (精简版：切换 + 积分显示)
// ================================================================

const $ = (sel) => document.querySelector(sel);
const $list = $('#account-list');
const $btnSave = $('#btn-save');
const $btnCheckAll = $('#btn-check-all');
const $summaryBar = $('#summary-bar');
const $summaryCount = $('#summary-count');
const $summaryCredits = $('#summary-credits');
const $progressArea = $('#progress-area');
const $progressFill = $('#progress-fill');
const $progressText = $('#progress-text');
const $toast = $('#toast');
const $btnToggleSettings = $('#btn-toggle-settings');
const $settingsPanel = $('#settings-panel');
const $btnExport = $('#btn-export');
const $btnImport = $('#btn-import');
const $fileImport = $('#file-import');
const $toggleAutoSave = $('#toggle-auto-save');
const $expiredBanner = $('#expired-banner');
const $expiredText = $('#expired-text');
const $btnExpiredAction = $('#btn-expired-action');
const $inputSaveName = $('#input-save-name');
const $buildVersion = $('#build-version');
const $unsavedCurrentBanner = $('#unsaved-current-banner');
const $unsavedCurrentText = $('#unsaved-current-text');

let cachedCurrentId = null;
let cachedAccounts = [];
let saveDraftTimer = null;

// Firefox 使用 browser.* Promise API；Chromium 使用 chrome.* Promise API。
const extensionApi = globalThis.browser || globalThis.chrome;

// ======================== 工具函数 ========================

async function sendMsg(msg) {
  try {
    // browser.*（Firefox）和 Chromium MV3 均支持 Promise；优先走 Promise，避免 Firefox chrome-callback 差异。
    const response = await extensionApi.runtime.sendMessage(msg);
    return response;
  } catch (e) {
    const message = extensionApi.runtime?.lastError?.message || e?.message || String(e);
    console.warn('[即梦] sendMessage 失败:', message);
    return { success: false, error: `通信失败: ${message}`, __sendMsgError: true };
  }
}

let toastTimer = null;
function showToast(text, type = 'info', duration = 2500) {
  clearTimeout(toastTimer);
  $toast.textContent = text;
  $toast.className = `toast ${type}`;
  toastTimer = setTimeout(() => $toast.classList.add('hidden'), duration);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatVipExpiry(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = Math.ceil((d - Date.now()) / 86400000);
  if (diff <= 0) return '已过期';
  return `${diff}天`;
}

function formatEpochSeconds(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatCreditNumber(value) {
  if (value == null || value === '') return '--';
  const number = Number(value);
  if (!Number.isFinite(number)) return escapeHtml(String(value));
  return number.toLocaleString('zh-CN');
}

function renderDetailRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="detail-row"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value)}</span></div>`;
}

function renderAccountDetailRows(credits, vip) {
  const rows = [];
  const total = credits?.detailTotal ?? credits?.panelTotal ?? credits?.total;
  if (total != null) rows.push(renderDetailRow('总积分', formatCreditNumber(total)));

  const memberText = [vip?.vipType || vip?.planName || '', vip?.billingCycle || ''].filter(Boolean).join(' · ');
  if (memberText) rows.push(renderDetailRow('会员', memberText));

  const expiry = vip?.expireText || formatEpochSeconds(vip?.expireTime);
  if (expiry) rows.push(renderDetailRow('会员到期', expiry));

  const quota = credits?.monthlyQuotaText || vip?.monthlyQuotaText || (credits?.monthlyQuota ? `${formatCreditNumber(credits.monthlyQuota)}积分/月` : '');
  if (quota) rows.push(renderDetailRow('套餐额度', quota));

  const refresh = [];
  if (credits?.nextSubscriptionCreditAt || vip?.nextSubscriptionCreditAt) {
    refresh.push(`订阅积分 ${formatEpochSeconds(credits.nextSubscriptionCreditAt || vip.nextSubscriptionCreditAt)}`);
  }
  if (credits?.nextDailyFreeAt) refresh.push(`每日积分 ${formatEpochSeconds(credits.nextDailyFreeAt)} 前后`);
  if (!refresh.length && vip?.expireTime) refresh.push(`续费/到期 ${formatEpochSeconds(vip.expireTime)}`);
  if (refresh.length) rows.push(renderDetailRow('额度刷新', refresh.join('；')));

  if (credits?.dailyFreeAmount || credits?.lastDailyFreeAt) {
    const latest = credits.lastDailyFreeAt ? `最近 ${formatEpochSeconds(credits.lastDailyFreeAt)}` : '';
    rows.push(renderDetailRow('每日积分', `${credits.dailyFreeAmount ? formatCreditNumber(credits.dailyFreeAmount) : '--'} ${latest}`.trim()));
  }
  if (credits?.lastCreditClearAt) rows.push(renderDetailRow('最近清零', formatEpochSeconds(credits.lastCreditClearAt)));

  return rows.filter(Boolean).join('');
}

async function renderBuildVersion() {
  if (!$buildVersion) return;
  try {
    const manifest = extensionApi.runtime.getManifest?.();
    const version = manifest?.version || '--';
    $buildVersion.textContent = `v${version}`;
    const diag = await sendMsg({ action: 'getRuntimeDiagnostics' });
    if (diag && !diag.__sendMsgError) {
      const swTime = diag.serviceWorkerStartedAt ? formatTime(diag.serviceWorkerStartedAt) : '--';
      const stale = diag.pendingRestore?.stale ? ' · 清理旧恢复' : (diag.pendingRestore ? ' · 恢复中' : '');
      $buildVersion.textContent = `v${version} · SW ${diag.version || '--'} · ${swTime}${stale}`;
      $buildVersion.title = `Manifest v${version}\nServiceWorker v${diag.version || '--'}\nSW启动: ${swTime}${diag.pendingRestore ? `\nPending: ${JSON.stringify(diag.pendingRestore)}` : ''}`;
    }
  } catch {
    $buildVersion.textContent = 'v--';
  }
}

async function loadPopupSettings() {
  const settings = await sendMsg({ action: 'getSettings' });
  if (settings?.__sendMsgError) return;
  $inputSaveName.value = settings?.saveDraftName || '';
  if ($toggleAutoSave) $toggleAutoSave.checked = settings?.autoSaveOnLogin !== false;
  // v1.6.14 起不再有“修复模式”。旧版本残留 repairAccountId 只做清理，不再影响保存链路。
  if (settings?.repairAccountId) {
    await sendMsg({ action: 'saveSettings', patch: { repairAccountId: null } });
  }
}

function persistSaveDraftName() {
  clearTimeout(saveDraftTimer);
  const name = $inputSaveName.value.trim();
  saveDraftTimer = setTimeout(() => {
    sendMsg({ action: 'saveSettings', patch: { saveDraftName: name } });
  }, 180);
}

function updateUnsavedCurrentBanner(accounts = cachedAccounts, currentId = cachedCurrentId) {
  if (!accounts.length || currentId) {
    $unsavedCurrentBanner.classList.add('hidden');
    return;
  }
  $unsavedCurrentBanner.classList.remove('hidden');
  $unsavedCurrentText.textContent = `当前网页登录的账号还没保存到插件。网页登录 ≠ 已保存；如果你刚切了新账号，请点击“保存当前账号”把它加入列表。当前插件内仅保存 ${accounts.length} 个账号。`;
}

// ======================== 渲染 ========================

async function render(detectCurrent = true) {
  const resp = await sendMsg({ action: 'getAccounts' });

  // 通信失败（background SW 挂了或其他异常）→ 显示错误态，不是"无账号"
  if (resp?.__sendMsgError) {
    $list.innerHTML = `
      <div class="empty-state">
        <p style="color:#c00">⚠ 与扩展后台通信失败</p>
        <p class="hint">${escapeHtml(resp.error || '')}</p>
        <p class="hint"><button id="btn-retry-connect" class="btn btn-sm btn-outline" style="margin-top:8px">重试</button></p>
      </div>`;
    document.getElementById('btn-retry-connect')?.addEventListener('click', () => render(true));
    $summaryBar.classList.add('hidden');
    $expiredBanner.classList.add('hidden');
    $unsavedCurrentBanner.classList.add('hidden');
    return;
  }

  const accounts = Array.isArray(resp) ? resp : [];
  cachedAccounts = accounts;
  if (detectCurrent || cachedCurrentId === null) {
    const detectResp = await sendMsg({ action: 'detectCurrent' });
    cachedCurrentId = detectResp?.__sendMsgError ? cachedCurrentId : detectResp;
  }
  const currentId = cachedCurrentId;

  if (!accounts.length) {
    $list.innerHTML = `
      <div class="empty-state">
        <p>还没有保存的账号</p>
        <p class="hint">请先在浏览器中登录即梦，然后点击「保存当前账号」</p>
      </div>`;
    $summaryBar.classList.add('hidden');
    $expiredBanner.classList.add('hidden');
    $unsavedCurrentBanner.classList.add('hidden');
    return;
  }

  $summaryBar.classList.remove('hidden');
  updateExpiredBanner(accounts);
  updateUnsavedCurrentBanner(accounts, currentId);

  // 摘要栏
  // 已过期账号的积分/会员只是最后一次缓存，不能当作当前可用额度汇总。
  const activeAccounts = accounts.filter(a => a.sessionValid !== false);
  const totalCredits = activeAccounts.reduce((sum, a) => sum + (a.cachedCredits?.total || 0), 0);
  const hasData = activeAccounts.some(a => a.cachedCredits);
  $summaryCount.textContent = accounts.length;
  $summaryCredits.textContent = hasData ? totalCredits : '--';

  // 账号列表
  $list.innerHTML = accounts.map(a => {
    const isCurrent = a.id === currentId;
    const initial = (a.name || '?')[0].toUpperCase();
    const sessionClass = a.sessionValid === true ? 'valid' : a.sessionValid === false ? 'expired' : 'unknown';
    const credits = a.cachedCredits;
    const vip = a.cachedVip;
    const isExpired = a.sessionValid === false;
    const switchDisabled = isCurrent || isExpired;
    const switchText = isExpired ? '已过期' : '切换';

    return `
    <div class="account-card ${isCurrent ? 'active' : ''}" data-id="${a.id}">
      <div class="card-top">
        <div class="account-info">
          <div class="account-avatar">
            ${a.avatar
              ? `<img src="${escapeHtml(a.avatar)}" alt="" />`
              : `<div class="avatar-placeholder">${escapeHtml(initial)}</div>`}
            <div class="status-dot ${sessionClass}" title="${sessionClass === 'valid' ? 'Session有效' : sessionClass === 'expired' ? 'Session已过期' : '未检测'}"></div>
          </div>
          <div class="account-details">
            <div class="account-name-row">
              <span class="account-name">${escapeHtml(a.name)}</span>
              <button class="btn btn-rename btn-sm" data-action="rename" data-id="${a.id}" title="改名">&#9998;</button>
            </div>
            <div class="account-meta">
              ${isCurrent ? '<span class="badge current">当前</span>' : ''}
              ${a.sessionValid === false ? '<span class="badge expired">登录失效</span>' : ''}
              ${vip?.isVip ? `<span class="badge vip">${a.sessionValid === false ? '缓存 ' : ''}${escapeHtml(vip.vipType || 'VIP')} ${formatVipExpiry(vip.expireTime)}</span>` : ''}
              <span class="save-time">${formatTime(a.lastChecked || a.savedAt)}</span>
            </div>
          </div>
        </div>
        <div class="account-actions">
          <button class="btn btn-switch btn-sm" data-action="switch" data-id="${a.id}"
            ${switchDisabled ? 'disabled' : ''}
            title="${isExpired ? '该账号登录态已过期。请先在即梦网页重新登录这个账号，再点“保存当前账号”。' : '切换到该账号'}">${switchText}</button>
          <button class="btn btn-delete btn-sm" data-action="delete" data-id="${a.id}" title="删除">&#10005;</button>
        </div>
      </div>
      ${(credits || vip) ? `
      <div class="card-bottom">
        <div class="credits-info">
          <div class="credits-main">${a.sessionValid === false ? '缓存积分' : '积分'}: <span class="credits-num">${formatCreditNumber(credits?.detailTotal ?? credits?.panelTotal ?? credits?.total)}</span></div>
          <div class="account-detail-grid">${renderAccountDetailRows(credits, vip)}</div>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  bindCardEvents();

  // render 结束时同步权限态：render 重建 DOM 会清掉之前 setFunctionalButtonsEnabled(false) 的效果，
  // 这里重新贯彻一次
  updatePermissionBanner().catch(() => {});
  return { accounts, currentId };
}

// ======================== 事件绑定 ========================

function bindCardEvents() {
  $list.querySelectorAll('.btn[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { action, id } = btn.dataset;

      if (action === 'switch') {
        btn.disabled = true;
        btn.textContent = '...';
        showToast('正在切换账号...', 'info');
        const res = await sendMsg({ action: 'switchAccount', accountId: id });
        if (res?.success) {
          cachedCurrentId = id;
          showToast(`已切换到 ${res.account.name}`, 'success');
        } else {
          showToast(res?.error || '切换失败', 'error');
        }
        await render(true);
      }

      if (action === 'delete') {
        const card = btn.closest('.account-card');
        const name = card.querySelector('.account-name')?.textContent || '';
        if (!confirm(`确定删除「${name}」吗？`)) return;
        await sendMsg({ action: 'deleteAccount', accountId: id });
        showToast('已删除', 'success');
        await render(true);
      }

      if (action === 'rename') {
        const nameEl = btn.closest('.account-name-row').querySelector('.account-name');
        const oldName = nameEl.textContent;
        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = oldName;
        nameEl.replaceWith(input);
        btn.style.display = 'none';
        input.focus();
        input.select();
        const commit = async () => {
          const newName = input.value.trim() || oldName;
          if (newName !== oldName) {
            await sendMsg({ action: 'renameAccount', accountId: id, name: newName });
            showToast(`已改名为「${newName}」`, 'success');
          }
          await render(false);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') input.blur();
          if (ev.key === 'Escape') { input.value = oldName; input.blur(); }
        });
      }
    });
  });
}

// ======================== 保存当前账号 ========================

$btnSave.addEventListener('click', async () => {
  $btnSave.disabled = true;
  $btnSave.textContent = '保存中...';
  showToast('正在保存当前登录状态...', 'info');
  const customName = $inputSaveName.value.trim();
  const res = await sendMsg({
    action: 'saveCurrentAccount',
    name: customName || undefined,
  });
  if (res?.success) {
    if (customName) {
      clearTimeout(saveDraftTimer);
      saveDraftTimer = null;
      $inputSaveName.value = '';
      await sendMsg({ action: 'saveSettings', patch: { saveDraftName: '' } });
    }
    const totalSaved = res.isUpdate
      ? cachedAccounts.length
      : (cachedAccounts.some(account => account.id === res.account?.id) ? cachedAccounts.length : cachedAccounts.length + 1);
    showToast(
      res.isUpdate
        ? `已更新: ${res.account.name}（当前共 ${totalSaved} 个账号）`
        : `已保存: ${res.account.name}（当前共 ${totalSaved} 个账号）`,
      'success'
    );
    if (Array.isArray(res.deviceIdentityCollisions) && res.deviceIdentityCollisions.length) {
      const names = res.deviceIdentityCollisions.map(item => item.name || '旧账号').slice(0, 2).join('、');
      showToast(`注意：即梦服务端可能已把「${names}」的旧登录态挤下线；我已把相关旧卡标为登录失效，避免继续切换失败。`, 'error', 9000);
    }
    await render(true);
  } else {
    showToast(res?.error || '保存失败', 'error');
  }
  $btnSave.disabled = false;
  $btnSave.textContent = '保存当前账号';
});

// ======================== 刷新所有状态 ========================

$btnCheckAll.addEventListener('click', async () => {
  if (!confirm('刷新期间会临时切换 Cookie 查询各账号状态，请勿操作即梦页面。继续？')) return;
  $btnCheckAll.disabled = true;
  $btnCheckAll.textContent = '查询中...';
  $progressArea.classList.remove('hidden');
  $progressFill.style.width = '0%';
  $progressText.textContent = '准备中...';

  const res = await sendMsg({ action: 'checkAllStatuses' });

  $progressArea.classList.add('hidden');
  if (res?.success) {
    showToast('状态已刷新', 'success');
  } else {
    showToast(res?.error || '查询失败', 'error');
  }
  $btnCheckAll.disabled = false;
  $btnCheckAll.textContent = '刷新状态';
  await render(true);
});

// ======================== 设置面板 ========================

$btnToggleSettings.addEventListener('click', () => {
  $settingsPanel.classList.toggle('hidden');
});

$toggleAutoSave?.addEventListener('change', async () => {
  await sendMsg({ action: 'saveSettings', patch: { autoSaveOnLogin: !!$toggleAutoSave.checked } });
  showToast($toggleAutoSave.checked ? '已开启自动保存新登录账号' : '已关闭自动保存新登录账号', 'success');
});

// ======================== 导入导出 ========================

$btnExport.addEventListener('click', async () => {
  const accounts = await sendMsg({ action: 'getAccounts' }) || [];
  if (!accounts.length) { showToast('没有可导出的账号', 'error'); return; }
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), accounts }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jimeng-accounts-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  showToast(`已导出 ${accounts.length} 个账号`, 'success');
});

$btnImport.addEventListener('click', () => $fileImport.click());

// 三选一自定义对话框：Promise<'merge'|'replace'|null>
// 键盘支持：Esc 取消、Enter 默认选合并
function showImportModeDialog(count) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-title">导入账号</div>
        <div class="modal-body">
          检测到 <b>${count}</b> 个账号。<br>
          请选择导入模式：<br>
          <span style="color:#999;font-size:11px">Enter=合并 · Esc=取消</span>
        </div>
        <div class="modal-actions">
          <button class="btn btn-sm btn-outline" data-mode="cancel">取消</button>
          <button class="btn btn-sm btn-outline" data-mode="replace">覆盖（清空现有）</button>
          <button class="btn btn-sm btn-primary" data-mode="merge" autofocus>合并（保留现有）</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    let resolved = false;
    const pick = (mode) => {
      if (resolved) return;
      resolved = true;
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(mode === 'cancel' ? null : mode);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); pick('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); pick('merge'); }
    };
    overlay.querySelectorAll('button[data-mode]').forEach(b => {
      b.addEventListener('click', () => pick(b.dataset.mode));
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) pick('cancel'); });
    document.addEventListener('keydown', onKeydown);
    // 默认聚焦合并按钮（autofocus 在某些 Chrome 不生效）
    setTimeout(() => overlay.querySelector('[data-mode=merge]')?.focus(), 0);
  });
}

const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024; // 10MB 上限（账号 JSON 不可能这么大，防御性保护）

$fileImport.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    showToast(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 10MB。请检查文件是否正确`, 'error', 5000);
    $fileImport.value = '';
    return;
  }
  try {
    const payload = JSON.parse(await file.text());
    if (!Array.isArray(payload?.accounts)) { showToast('格式错误：缺少 accounts 数组', 'error'); return; }
    const mode = await showImportModeDialog(payload.accounts.length);
    if (!mode) return; // 用户取消
    const res = await sendMsg({ action: 'importAccounts', accounts: payload.accounts, mode });
    if (res?.success) { showToast(`${res.added} 新增 / ${res.updated} 更新`, 'success'); await render(true); }
    else showToast(res?.error || '导入失败', 'error');
  } catch (err) { showToast(`导入失败: ${err.message}`, 'error'); }
  finally { $fileImport.value = ''; }
});

// ======================== 过期账号横幅 ========================

function updateExpiredBanner(accounts) {
  const expired = accounts.filter(a => a.sessionValid === false);
  if (!expired.length) { $expiredBanner.classList.add('hidden'); return; }
  $expiredBanner.classList.remove('hidden');
  $expiredText.textContent = `${expired.length} 个账号已过期，已禁止切换。重新登录同一个账号后点“保存当前账号”会自动更新；如果保存成新卡，说明网页登录的不是同一个账号。`;
  $btnExpiredAction.onclick = () => {
    showToast('过期卡不能切换。请重新登录同一账号后保存；如果不再需要，直接删除旧卡。', 'info', 6500);
  };
}

// ======================== 进度监听 ========================

extensionApi.runtime.onMessage.addListener((msg) => {
  if (!msg?.__progress) return;
  $progressArea.classList.remove('hidden');
  const pct = msg.total > 0 ? Math.floor((msg.current / msg.total) * 100) : 0;
  $progressFill.style.width = `${pct}%`;
  if (msg.phase === 'done') {
    $progressText.textContent = '完成';
    setTimeout(() => $progressArea.classList.add('hidden'), 1500);
  } else {
    $progressText.textContent = msg.message || `${msg.current}/${msg.total} ${msg.name || ''}`;
  }
});

// ======================== 权限检测（Firefox 特需）========================

const HOST_PATTERN = 'https://*.jianying.com/*';
const $permBanner = document.getElementById('permission-banner');
const $btnGrantPerm = document.getElementById('btn-grant-permission');

// 返回 'granted' | 'denied' | 'unsupported' | 'error'
async function checkHostPermission() {
  if (!extensionApi.permissions?.contains) return 'unsupported'; // 老浏览器兜底（Chromium 默认授权）
  try {
    const has = await extensionApi.permissions.contains({ origins: [HOST_PATTERN] });
    return has ? 'granted' : 'denied';
  } catch (e) {
    console.error('[即梦] permissions.contains 异常:', e);
    return 'error';
  }
}

async function promptHostPermission() {
  if (!extensionApi.permissions?.request) {
    showToast('当前浏览器不支持权限 API，请在扩展管理页手动启用', 'error');
    return false;
  }
  try {
    return await extensionApi.permissions.request({ origins: [HOST_PATTERN] });
  } catch (e) {
    showToast(`授权失败: ${e.message}`, 'error');
    return false;
  }
}

// 权限不足时禁用所有功能按钮，只留权限横幅的"授权"按钮
function setFunctionalButtonsEnabled(enabled) {
  const ids = ['btn-save', 'btn-check-all', 'btn-toggle-settings', 'btn-export', 'btn-import', 'input-save-name'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
  // 账号卡片里的切换/删除按钮 disabled 状态由 render 时的 isCurrent 控制，
  // 全局权限态也要覆盖：无权限时全部禁用
  document.querySelectorAll('#account-list button[data-action]').forEach(b => {
    if (!enabled) b.disabled = true;
  });
}

async function updatePermissionBanner() {
  const state = await checkHostPermission();
  if (state === 'granted' || state === 'unsupported') {
    $permBanner.classList.add('hidden');
    setFunctionalButtonsEnabled(true);
    return true;
  }
  // denied 或 error：显示横幅 + 禁用功能
  $permBanner.classList.remove('hidden');
  const textEl = $permBanner.querySelector('.banner-text');
  if (textEl) {
    textEl.textContent = state === 'error'
      ? '权限 API 异常，请重启浏览器或检查扩展是否完整安装'
      : '扩展需要访问 jianying.com 的权限才能工作';
  }
  setFunctionalButtonsEnabled(false);
  return false;
}

$btnGrantPerm?.addEventListener('click', async () => {
  const granted = await promptHostPermission();
  if (granted) {
    showToast('授权成功', 'success');
    await updatePermissionBanner();
    await render(true);
  } else {
    showToast('授权被拒绝，扩展无法工作', 'error');
  }
});

$inputSaveName?.addEventListener('input', persistSaveDraftName);
$inputSaveName?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $btnSave.click();
  }
});

// ======================== 初始化 ========================
(async () => {
  if (new URLSearchParams(location.search).get('localRepair') === '1') {
    await runLocalRepairImportFromBundledAuth();
    return;
  }
  await renderBuildVersion();
  await loadPopupSettings();
  await updatePermissionBanner();
  render();
})();

// 真实 Chrome 本地救援入口：
// 访问 chrome-extension://<id>/popup/popup.html?localRepair=1 时，从本机扩展目录里的
// .auth/REAL_CHROME_IMPORT_VALID_ACCOUNTS.json 覆盖写入 extensionApi.storage.local，
// 并把当前浏览器 Cookie 切到第一个已验证账号。此入口只用于本机调试/修复，不在 popup UI 暴露。
async function runLocalRepairImportFromBundledAuth() {
  const write = (line) => {
    let pre = document.getElementById('local-repair-log');
    if (!pre) {
      document.body.innerHTML = '<main style="font-family:system-ui;padding:24px;line-height:1.6"><h1>即梦本地修复导入</h1><pre id="local-repair-log" style="white-space:pre-wrap;background:#f3f5ff;border-radius:12px;padding:16px"></pre></main>';
      pre = document.getElementById('local-repair-log');
    }
    pre.textContent += `${line}\n`;
  };
  const sanitizeCookie = (cookie) => {
    if (!cookie || typeof cookie !== 'object') return null;
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return null;
    return {
      name: cookie.name,
      value: cookie.value,
      domain: (typeof cookie.domain === 'string' && cookie.domain) ? cookie.domain : '.jianying.com',
      path: (typeof cookie.path === 'string' && cookie.path) ? cookie.path : '/',
      secure: cookie.secure !== false,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite || 'unspecified',
      expirationDate: cookie.expirationDate,
      hostOnly: cookie.hostOnly === true,
    };
  };
  const sanitizeAccount = (account, index) => {
    const cookies = Array.isArray(account?.cookies) ? account.cookies.map(sanitizeCookie).filter(Boolean) : [];
    if (!cookies.find(cookie => cookie.name === 'sessionid' && cookie.value)) return null;
    const userId = typeof account.userId === 'string' ? account.userId : '';
    return {
      id: typeof account.id === 'string' && account.id ? account.id : crypto.randomUUID(),
      name: (typeof account.name === 'string' && account.name) ? account.name.slice(0, 50) : `本地修复账号 ${index + 1}`,
      userId,
      importedUserId: userId,
      nickname: typeof account.nickname === 'string' ? account.nickname.slice(0, 100) : '',
      avatar: typeof account.avatar === 'string' ? account.avatar : '',
      cookies,
      savedAt: typeof account.savedAt === 'number' ? account.savedAt : Date.now(),
      cachedCredits: account.cachedCredits && typeof account.cachedCredits === 'object' ? account.cachedCredits : null,
      cachedVip: account.cachedVip && typeof account.cachedVip === 'object' ? account.cachedVip : null,
      sessionValid: true,
      lastChecked: Date.now(),
    };
  };
  const getAllDomainCookies = async () => {
    const [a, b] = await Promise.all([
      extensionApi.cookies.getAll({ domain: 'jianying.com' }),
      extensionApi.cookies.getAll({ domain: 'jimeng.jianying.com' }),
    ]);
    const seen = new Set();
    const all = [];
    for (const cookie of [...a, ...b]) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(cookie);
      }
    }
    return all;
  };
  const clearDomainCookies = async () => {
    for (const cookie of await getAllDomainCookies()) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      try { await extensionApi.cookies.remove({ url: `https://${domain}${cookie.path}`, name: cookie.name }); } catch {}
      try { await extensionApi.cookies.remove({ url: `http://${domain}${cookie.path}`, name: cookie.name }); } catch {}
    }
  };
  const restoreCookies = async (cookies) => {
    const authNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss']);
    const failures = [];
    for (const cookie of [...cookies.filter(c => !authNames.has(c.name)), ...cookies.filter(c => authNames.has(c.name))]) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      const details = {
        url: `https://${domain}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: !!cookie.httpOnly,
      };
      if (cookie.hostOnly !== true) details.domain = cookie.domain;
      if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
        details.sameSite = cookie.sameSite;
        if (cookie.sameSite === 'no_restriction') details.secure = true;
      }
      if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
      try {
        const result = await extensionApi.cookies.set(details);
        if (!result) failures.push({ name: cookie.name, auth: authNames.has(cookie.name) });
      } catch (e) {
        failures.push({ name: cookie.name, auth: authNames.has(cookie.name), error: e.message });
      }
    }
    return failures;
  };
  const reloadExistingJimengTabs = async () => {
    const tabs = await extensionApi.tabs.query({ url: '*://*.jianying.com/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await extensionApi.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: async () => {
            try { localStorage.clear(); } catch {}
            try { sessionStorage.clear(); } catch {}
            try { if (typeof caches !== 'undefined') for (const key of await caches.keys()) await caches.delete(key); } catch {}
          },
        });
      } catch {}
      try { await extensionApi.tabs.reload(tab.id, { bypassCache: true }); } catch {}
    }
    return tabs.length;
  };

  try {
    write('开始本地修复导入…');
    const url = extensionApi.runtime.getURL('.auth/REAL_CHROME_IMPORT_VALID_ACCOUNTS.json');
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`读取导入文件失败 HTTP ${resp.status}`);
    const payload = await resp.json();
    const rawAccounts = Array.isArray(payload) ? payload : payload.accounts;
    if (!Array.isArray(rawAccounts)) throw new Error('导入文件里没有 accounts 数组');
    const accounts = rawAccounts.map(sanitizeAccount).filter(Boolean);
    if (!accounts.length) throw new Error('没有包含 sessionid 的有效账号');
    write(`准备覆盖账号数：${accounts.length}`);
    accounts.forEach((account, i) => write(`#${i + 1} ${account.name} userId=${account.userId} cookies=${account.cookies.length}`));
    await extensionApi.storage.local.set({
      jimeng_accounts: accounts,
      jimeng_accounts_backup: accounts,
      jimeng_accounts_journal: [{
        ts: Date.now(),
        reason: 'local-repair-import-from-popup',
        count: accounts.length,
        accounts: accounts.map(account => ({
          id: account.id,
          name: account.name,
          userId: account.userId,
          nickname: account.nickname,
          cookieCount: account.cookies.length,
        })),
      }],
    });
    await extensionApi.storage.local.remove('__pending_cookie_restore');
    const readBack = await extensionApi.storage.local.get(['jimeng_accounts', '__pending_cookie_restore']);
    const readBackAccounts = Array.isArray(readBack.jimeng_accounts) ? readBack.jimeng_accounts : [];
    const uniqueUserIds = new Set(readBackAccounts.map(account => account.userId).filter(Boolean)).size;
    const uniqueSessions = new Set(readBackAccounts.map(account =>
      (account.cookies || []).find(cookie => cookie.name === 'sessionid')?.value || ''
    ).filter(Boolean)).size;
    write(`已覆盖插件 storage，并清理 pending。读回：count=${readBackAccounts.length}, uniqueUserIds=${uniqueUserIds}, uniqueSessions=${uniqueSessions}, pending=${readBack.__pending_cookie_restore ? 'yes' : 'no'}`);
    await clearDomainCookies();
    const failures = await restoreCookies(accounts[0].cookies);
    const authFailures = failures.filter(f => f.auth);
    if (authFailures.length) throw new Error(`关键 Cookie 写入失败：${authFailures.map(f => f.name).join(', ')}`);
    write(`已把当前浏览器 Cookie 切到第一个账号：${accounts[0].name}`);
    if (failures.length) write(`非关键 Cookie 写入失败 ${failures.length} 个，已忽略。`);
    const reloaded = await reloadExistingJimengTabs();
    write(`已刷新现有即梦/剪映标签页：${reloaded} 个。`);
    write('完成。现在重新打开插件，应看到 3 个账号。');
    if (new URLSearchParams(location.search).get('reloadExtension') === '1') {
      write('正在重载扩展以应用最新 manifest/background…');
      setTimeout(() => extensionApi.runtime.reload(), 800);
    }
  } catch (e) {
    write(`失败：${e.message || e}`);
  }
}

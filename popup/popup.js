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
const $expiredBanner = $('#expired-banner');
const $expiredText = $('#expired-text');
const $btnExpiredAction = $('#btn-expired-action');

let cachedCurrentId = null;

// ======================== 工具函数 ========================

function sendMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        // 必须检查 lastError，否则 Chrome 会在 console 打印 "Unchecked runtime.lastError"
        if (chrome.runtime.lastError) {
          console.warn('[即梦] sendMessage 失败:', chrome.runtime.lastError.message);
          resolve({ success: false, error: `通信失败: ${chrome.runtime.lastError.message}`, __sendMsgError: true });
          return;
        }
        resolve(response);
      });
    } catch (e) {
      console.error('[即梦] sendMessage 异常:', e);
      resolve({ success: false, error: `通信异常: ${e.message}`, __sendMsgError: true });
    }
  });
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

// ======================== 渲染 ========================

async function render(detectCurrent = true) {
  const accounts = await sendMsg({ action: 'getAccounts' });
  if (detectCurrent || cachedCurrentId === null) {
    cachedCurrentId = await sendMsg({ action: 'detectCurrent' });
  }
  const currentId = cachedCurrentId;

  if (!accounts || !accounts.length) {
    $list.innerHTML = `
      <div class="empty-state">
        <p>还没有保存的账号</p>
        <p class="hint">请先在浏览器中登录即梦，然后点击「保存当前账号」</p>
      </div>`;
    $summaryBar.classList.add('hidden');
    $expiredBanner.classList.add('hidden');
    return;
  }

  $summaryBar.classList.remove('hidden');
  updateExpiredBanner(accounts);

  // 摘要栏
  const totalCredits = accounts.reduce((sum, a) => sum + (a.cachedCredits?.total || 0), 0);
  const hasData = accounts.some(a => a.cachedCredits);
  $summaryCount.textContent = accounts.length;
  $summaryCredits.textContent = hasData ? totalCredits : '--';

  // 账号列表
  $list.innerHTML = accounts.map(a => {
    const isCurrent = a.id === currentId;
    const initial = (a.name || '?')[0].toUpperCase();
    const sessionClass = a.sessionValid === true ? 'valid' : a.sessionValid === false ? 'expired' : 'unknown';
    const credits = a.cachedCredits;
    const vip = a.cachedVip;

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
              ${vip?.isVip ? `<span class="badge vip">${escapeHtml(vip.vipType || 'VIP')} ${formatVipExpiry(vip.expireTime)}</span>` : ''}
              <span class="save-time">${formatTime(a.lastChecked || a.savedAt)}</span>
            </div>
          </div>
        </div>
        <div class="account-actions">
          <button class="btn btn-switch btn-sm" data-action="switch" data-id="${a.id}"
            ${isCurrent ? 'disabled' : ''}>切换</button>
          <button class="btn btn-delete btn-sm" data-action="delete" data-id="${a.id}" title="删除">&#10005;</button>
        </div>
      </div>
      ${credits ? `
      <div class="card-bottom">
        <div class="credits-info">
          <span>积分: <span class="credits-num">${credits.total}</span></span>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  bindCardEvents();
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
  const res = await sendMsg({ action: 'saveCurrentAccount' });
  if (res?.success) {
    showToast(res.isUpdate ? `已更新: ${res.account.name}` : `已保存: ${res.account.name}`, 'success');
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
function showImportModeDialog(count) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-title">导入账号</div>
        <div class="modal-body">
          检测到 <b>${count}</b> 个账号。<br>
          请选择导入模式：
        </div>
        <div class="modal-actions">
          <button class="btn btn-sm btn-outline" data-mode="cancel">取消</button>
          <button class="btn btn-sm btn-outline" data-mode="replace">覆盖（清空现有）</button>
          <button class="btn btn-sm btn-primary" data-mode="merge">合并（保留现有）</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const pick = (mode) => { overlay.remove(); resolve(mode === 'cancel' ? null : mode); };
    overlay.querySelectorAll('button[data-mode]').forEach(b => {
      b.addEventListener('click', () => pick(b.dataset.mode));
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) pick('cancel'); });
  });
}

$fileImport.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
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
  $expiredText.textContent = `${expired.length} 个账号 session 过期`;
  $btnExpiredAction.onclick = async () => {
    const first = expired[0];
    showToast(`切换到「${first.name}」...`, 'info');
    const res = await sendMsg({ action: 'switchAccount', accountId: first.id });
    if (res?.success) {
      cachedCurrentId = first.id;
      showToast('请在即梦页面登录后点「保存当前账号」更新', 'info', 5000);
    } else {
      showToast(res?.error || '切换失败', 'error', 4000);
    }
    await render(true);
  };
}

// ======================== 进度监听 ========================

chrome.runtime.onMessage.addListener((msg) => {
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

async function checkHostPermission() {
  if (!chrome.permissions?.contains) return true; // 老浏览器兜底
  try {
    return await chrome.permissions.contains({ origins: [HOST_PATTERN] });
  } catch { return true; }
}

async function promptHostPermission() {
  if (!chrome.permissions?.request) {
    showToast('当前浏览器不支持权限 API，请在扩展管理页手动启用', 'error');
    return false;
  }
  try {
    return await chrome.permissions.request({ origins: [HOST_PATTERN] });
  } catch (e) {
    showToast(`授权失败: ${e.message}`, 'error');
    return false;
  }
}

async function updatePermissionBanner() {
  const ok = await checkHostPermission();
  if (ok) {
    $permBanner.classList.add('hidden');
  } else {
    $permBanner.classList.remove('hidden');
  }
  return ok;
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

// ======================== 初始化 ========================
(async () => {
  await updatePermissionBanner();
  render();
})();

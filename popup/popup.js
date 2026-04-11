// ================================================================
// 即梦账号切换器 - Popup 界面逻辑 V2
// ================================================================

const $ = (sel) => document.querySelector(sel);
const $list = $('#account-list');
const $btnSave = $('#btn-save');
const $btnClaimAll = $('#btn-claim-all');
const $btnCheckAll = $('#btn-check-all');
const $summaryBar = $('#summary-bar');
const $summaryCount = $('#summary-count');
const $summaryCredits = $('#summary-credits');
const $summaryClaimed = $('#summary-claimed');
const $progressArea = $('#progress-area');
const $progressFill = $('#progress-fill');
const $progressText = $('#progress-text');
const $claimResults = $('#claim-results');
const $toast = $('#toast');

// ======================== 工具函数 ========================

function sendMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
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

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatVipExpiry(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = Math.ceil((d - Date.now()) / 86400000);
  if (diff <= 0) return '已过期';
  return `${diff}天`;
}

// ======================== 渲染 ========================

async function render() {
  const [accounts, currentId] = await Promise.all([
    sendMsg({ action: 'getAccounts' }),
    sendMsg({ action: 'detectCurrent' }),
  ]);

  if (!accounts || !accounts.length) {
    $list.innerHTML = `
      <div class="empty-state">
        <p>还没有保存的账号</p>
        <p class="hint">请先在浏览器中登录即梦，然后点击「保存当前账号」</p>
      </div>`;
    $btnClaimAll.disabled = true;
    $summaryBar.classList.add('hidden');
    return;
  }

  $btnClaimAll.disabled = false;
  $summaryBar.classList.remove('hidden');
  const today = todayStr();

  // 摘要栏
  const claimedCount = accounts.filter(a => a.lastClaim === today).length;
  const totalCredits = accounts.reduce((sum, a) => sum + (a.cachedCredits?.total || 0), 0);
  const hasCreditsData = accounts.some(a => a.cachedCredits);
  $summaryCount.textContent = accounts.length;
  $summaryCredits.textContent = hasCreditsData ? totalCredits : '--';
  $summaryClaimed.textContent = `${claimedCount}/${accounts.length}`;

  // 账号列表
  $list.innerHTML = accounts.map((a) => {
    const isCurrent = a.id === currentId;
    const claimedToday = a.lastClaim === today;
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
              ${claimedToday ? '<span class="badge claimed">今日已领</span>' : ''}
              ${vip?.isVip ? `<span class="badge vip">${escapeHtml(vip.vipType || 'VIP')} ${formatVipExpiry(vip.expireTime)}</span>` : ''}
              <span class="save-time">${formatTime(a.savedAt)}</span>
            </div>
          </div>
        </div>
        <div class="account-actions">
          <button class="btn btn-switch btn-sm" data-action="switch" data-id="${a.id}"
            ${isCurrent ? 'disabled' : ''}>切换</button>
          <button class="btn btn-delete btn-sm" data-action="delete" data-id="${a.id}" title="删除">&#10005;</button>
        </div>
      </div>
      <div class="card-bottom">
        <div class="credits-info">
          ${credits
            ? `<span>积分: <span class="credits-num">${credits.total}</span></span>`
            : '<span style="color:#bbb">积分: --</span>'}
        </div>
        <div class="card-bottom-actions">
          <button class="btn btn-claim-one btn-sm" data-action="claimOne" data-id="${a.id}" data-name="${escapeHtml(a.name)}">领取</button>
        </div>
      </div>
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
          showToast(`已切换到 ${res.account.name}`, 'success');
        } else {
          showToast(res?.error || '切换失败', 'error');
        }
        await render();
      }

      if (action === 'delete') {
        const card = btn.closest('.account-card');
        const name = card.querySelector('.account-name')?.textContent || '';
        if (!confirm(`确定删除「${name}」吗？`)) return;
        const res = await sendMsg({ action: 'deleteAccount', accountId: id });
        if (res?.success) showToast('已删除', 'success');
        await render();
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
          await render();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') input.blur();
          if (ev.key === 'Escape') { input.value = oldName; input.blur(); }
        });
      }

      if (action === 'claimOne') {
        const name = btn.dataset.name;
        btn.disabled = true;
        btn.textContent = '...';
        showToast(`正在为「${name}」领取积分...`, 'info');
        const res = await sendMsg({ action: 'claimOne', accountId: id });
        if (res?.success) {
          showToast(`「${name}」领取成功`, 'success');
        } else {
          showToast(res?.error || '领取失败', 'error');
        }
        await render();
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
    showToast(
      res.isUpdate ? `已更新: ${res.account.name}` : `已保存: ${res.account.name}`,
      'success'
    );
    await render();
  } else {
    showToast(res?.error || '保存失败', 'error');
  }

  $btnSave.disabled = false;
  $btnSave.textContent = '保存当前账号';
});

// ======================== 一键领取全部 ========================

$btnClaimAll.addEventListener('click', async () => {
  const accounts = await sendMsg({ action: 'getAccounts' });
  if (!accounts?.length) {
    showToast('没有保存的账号', 'error');
    return;
  }

  if (!confirm(`将依次为 ${accounts.length} 个账号领取今日免费积分，过程中请勿操作浏览器。继续？`)) return;

  $btnClaimAll.disabled = true;
  $btnSave.disabled = true;
  $claimResults.classList.add('hidden');
  $claimResults.innerHTML = '';

  $progressArea.classList.remove('hidden');
  $progressFill.style.width = '0%';
  $progressText.textContent = `准备领取 ${accounts.length} 个账号...`;

  const res = await sendMsg({ action: 'claimAll' });

  if (res?.success && res.results) {
    $progressFill.style.width = '100%';
    const okCount = res.results.filter(r => r.success).length;
    $progressText.textContent = `完成! ${okCount}/${res.results.length} 个账号领取成功`;

    $claimResults.classList.remove('hidden');
    $claimResults.innerHTML = res.results.map(r => {
      const statusClass = r.success ? 'result-ok' : 'result-fail';
      const statusText = r.success ? '已领取' : (r.error || '失败');
      const c = r.credits?.credit || r.credits;
      const total = c ? (c.gift_credit || 0) + (c.purchase_credit || 0) + (c.vip_credit || 0) : null;
      return `
        <div class="result-item">
          <span class="name">${escapeHtml(r.accountName)}</span>
          <span class="${statusClass}">${statusText}${total !== null ? ` (余额: ${total})` : ''}</span>
        </div>`;
    }).join('');

    showToast(`${okCount} 个账号领取完成`, 'success', 4000);
  } else {
    $progressFill.style.width = '100%';
    $progressText.textContent = res?.error || '领取失败';
    showToast(res?.error || '领取失败', 'error');
  }

  $btnClaimAll.disabled = false;
  $btnSave.disabled = false;
  await render();
});

// ======================== 刷新所有状态 ========================

$btnCheckAll.addEventListener('click', async () => {
  $btnCheckAll.disabled = true;
  $btnCheckAll.textContent = '检查中...';
  showToast('正在查询所有账号状态...', 'info', 10000);

  const res = await sendMsg({ action: 'checkAllStatuses' });

  if (res?.success) {
    showToast('状态已刷新', 'success');
  } else {
    showToast(res?.error || '查询失败', 'error');
  }

  $btnCheckAll.disabled = false;
  $btnCheckAll.textContent = '刷新';
  await render();
});

// ======================== 初始化 ========================
render();

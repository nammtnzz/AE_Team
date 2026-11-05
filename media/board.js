(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statuses = [
    ['assigned', 'Được giao', '○'], ['running', 'Đang làm', '◌'], ['review', 'Chờ review', '◷'],
    ['approved', 'Đã duyệt', '✓'], ['blocked', 'Cần xử lý', '!']
  ];
  const labels = { idle: 'SẴN SÀNG', running: 'ĐANG CHẠY', waiting: 'CHỜ XỬ LÝ', paused: 'TẠM DỪNG', done: 'HOÀN TẤT' };
  let state = { config: { roles: [] }, sessions: [], selectedId: '', hasKey: false };
  let gatewayModels = [];
  const presets = { claude: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5.5'], codex: ['gpt-6.1-sol'], image: ['gpt-image-2.5-sunburst'] };
  const familyFor = protocol => protocol === 'iw-imagegen' ? 'image' : ['claude-cli', 'messages'].includes(protocol) ? 'claude' : 'codex';
  const modelMatches = (id, family) => family === 'claude' ? /^claude-/i.test(id) : family === 'image' ? /^gpt-image-/i.test(id) : /^(?:gpt-|o[134](?:-|$)|codex-)/i.test(id) && !/^gpt-image-/i.test(id);
  function updateModelChoices(row, selected) {
    const family = familyFor(row.querySelector('[data-field="protocol"]').value);
    const models = [...new Set([...(state.modelPresets || presets)[family], ...gatewayModels.filter(id => modelMatches(id, family)),
      ...state.config.roles.filter(r => familyFor(r.protocol) === family && modelMatches(r.model, family)).map(r => r.model), ...(selected ? [selected] : [])])];
    const select = row.querySelector('[data-field="model"]');
    select.innerHTML = models.map(id => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('') + (family === 'image' ? '' : '<option value="__custom__">Nhập ID model khác…</option>');
    select.value = selected || models[0];
    row.querySelector('[data-field="customModel"]').hidden = true;
  }
  function renderQa() {
    $('qaMessages').innerHTML = (state.qa?.messages || []).map(m => '<article class="qa-message"><strong>' + (m.role === 'user' ? 'Bạn' : 'QA · ' + esc(m.model || roleFor('qa').model)) + '</strong><pre>' + esc(m.text) + '</pre></article>').join('') || '<p class="muted">Gửi câu hỏi hoặc góp ý của bạn. QA sẽ trả lời dựa trên hội thoại và phiên đang chọn.</p>';
    $('qaSend').disabled = Boolean(state.qa?.busy);
    $('qaStop').disabled = !state.qa?.busy;
    $('qaStatus').textContent = state.qa?.busy ? 'QA đang trả lời…' : roleFor('qa').model;
  }
  function openQa() { openRole('qa'); }
  function openImage() { $('imageOverlay').hidden = false; $('imagePrompt').focus(); }
  const tabs = ['office', 'board', 'results', 'timeline', 'workflow', 'stats', 'ae'];
  const saved = api.getState?.() || {};
  let selectedTab = tabs.includes(saved.tab) ? saved.tab : 'board'; let detailId = ''; let detailRoleId = ''; let toastTimer;
  const chatDrafts = new Map();
  const chatPending = new Set();
  const chatKey = (sessionId, roleId) => JSON.stringify([sessionId || '', roleId]);
  function captureRoleChat() {
    const input = $('detail').querySelector('[data-role-chat-input]');
    if (!input) return;
    const key = chatKey(input.dataset.sessionId, input.dataset.roleId);
    const draft = { text: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
    chatDrafts.set(key, draft);
    const log = $('detail').querySelector('.role-chat-messages');
    return { key, focused: document.activeElement === input, scrollTop: log?.scrollTop || 0,
      atBottom: !log || log.scrollHeight - log.clientHeight - log.scrollTop < 20 };
  }
  function roleChat(role) {
    const sessionId = state.selectedId || '';
    const key = chatKey(sessionId, role.id);
    const messages = (state.roleChats || []).find(c => c.roleId === role.id && c.sessionId === sessionId)?.messages || [];
    const busy = (state.chatBusy || []).some(c => c.roleId === role.id && c.sessionId === sessionId) || chatPending.has(key);
    return '<section class="role-chat" aria-label="' + esc('Trò chuyện với ' + role.name) + '"><div class="role-chat-heading"><h3>Trao đổi với ' + esc(role.name) + '</h3><span class="model">' + esc(role.id === 'image' ? 'Ghi nhận góp ý · iw-imagegen' : role.model) + '</span></div>' +
      '<div class="role-chat-messages" role="log" aria-live="polite">' + (messages.length ? messages.map(m => {
        const delivery = { pending: 'Đang chờ trả lời', answered: 'Đã trả lời', stopped: 'Đã dừng', failed: 'Chưa nhận được trả lời', recorded: 'Đã ghi nhận', interrupted: 'Bị gián đoạn · chưa tự gửi lại' }[m.delivery];
        return '<article class="role-chat-message ' + (m.role === 'user' ? 'from-user' : 'from-agent') + '"><strong>' + esc(m.role === 'user' ? 'Bạn · CEO' : role.name) + (m.role === 'assistant' && m.model ? '<small>' + esc(m.model) + '</small>' : '') + '</strong><pre>' + esc(m.text) + '</pre>' + (m.role === 'user' && (delivery || m.error) ? '<p class="role-chat-delivery' + (m.error ? ' has-error' : '') + '">' + esc(delivery || '') + (m.error ? ' · ' + esc(m.error) : '') + '</p>' : '') + '</article>';
      }).join('') : '<p class="muted">Gửi câu hỏi hoặc góp ý trực tiếp cho ' + esc(role.name) + '.</p>') + '</div>' +
      '<form class="role-chat-form" data-role-chat-form data-role-id="' + esc(role.id) + '" data-session-id="' + esc(sessionId) + '"><label>Câu hỏi hoặc góp ý<textarea data-role-chat-input data-role-id="' + esc(role.id) + '" data-session-id="' + esc(sessionId) + '" rows="3" maxlength="10000" required placeholder="' + esc('Nhắn cho ' + role.name + '…') + '">' + esc(chatDrafts.get(key)?.text || '') + '</textarea></label>' +
      '<p class="role-chat-note">' + (role.id === 'image' ? 'Góp ý được lưu và dùng cho lần tạo ảnh tiếp theo. Bấm Tạo ảnh để tạo asset.' : 'Trả lời bằng model của thành viên. PO thấy góp ý trong phiên để điều phối các lượt sau; không tự chạy lại tác vụ.') + '</p><div class="role-chat-actions"><span role="status">' + (busy ? 'Đang tiếp nhận…' : sessionId ? 'Hội thoại trong phiên này' : 'Hội thoại chung · chưa chọn phiên') + '</span><button type="button" data-action="roleChatStop" data-id="' + esc(role.id) + '" data-session-id="' + esc(sessionId) + '"' + (busy ? '' : ' disabled') + '>Dừng trả lời</button><button type="submit" class="primary"' + (busy ? ' disabled' : '') + '>Gửi</button></div></form></section>';
  }
  function restoreRoleChat(previous, focus = false) {
    const input = $('detail').querySelector('[data-role-chat-input]');
    if (!input) return;
    const key = chatKey(input.dataset.sessionId, input.dataset.roleId);
    const draft = chatDrafts.get(key);
    if (draft) input.setSelectionRange(draft.start, draft.end, draft.direction);
    const log = $('detail').querySelector('.role-chat-messages');
    if (log) log.scrollTop = previous?.key === key && !previous.atBottom ? previous.scrollTop : log.scrollHeight;
    if (focus || (previous?.key === key && previous.focused)) input.focus({ preventScroll: true });
  }
  function openRole(id) { detailId = ''; detailRoleId = id; renderRoleTasks(id, true); }
  let resultFilter = { role: 'all', status: 'all', query: '', ...saved.resultFilter };
  let timelineFilter = { role: 'all', kind: 'all', query: '', order: 'newest', ...saved.timelineFilter };
  let office, officeFailed = false, officeRole = saved.officeRole || 'lead', officeCamera = ['iso', 'top', 'front'].includes(saved.camera) ? saved.camera : 'iso', panelVisible = true, officePreview = saved.officePreview !== false;
  if (saved.focus) document.body.classList.add('focus');
  const send = (type, extra = {}) => api.postMessage({ type, ...extra });
  const current = () => state.sessions.find(s => s.id === state.selectedId);
  // Tạo ảnh is merged into Mỹ thuật & Tạo ảnh: it stays an internal executor and is not shown as its own position.
  const teamRoles = () => state.config.roles.filter(r => r.id !== 'image');
  const roleFor = id => state.config.roles.find(r => r.id === id) || { name: id, shortName: id, model: '', id: 'lead' };
  const num = value => Number(value || 0).toLocaleString('vi-VN');
  const rawWorkFor = id => window.AETeamWork.roleWorkState(id, { sessionId: state.selectedId || '', sessionState: current()?.state, tasks: current()?.tasks || [],
    chatBusy: state.chatBusy || [], roleChats: state.roleChats || [], imageWork: state.imageWork || [] });
  // Mỹ thuật & Tạo ảnh shows the image skill's progress when that is the more active state.
  const workRank = { running: 4, blocked: 3, stopped: 2, done: 1, idle: 0 };
  const workFor = id => { const own = rawWorkFor(id); if (id !== 'art') return own; const image = rawWorkFor('image'); return (workRank[image.state] || 0) > (workRank[own.state] || 0) ? image : own; };
  function workIndicator(role, work = workFor(role.id), expanded = false) {
    return '<span class="work-indicator" data-work="' + esc(work.state) + '" title="' + esc(work.detail) + '"><span class="work-label">' + esc(work.label) + '</span>' +
      '<span class="work-track" role="progressbar" aria-label="' + esc(role.name + ' · ' + work.label) + '" aria-valuemin="0" aria-valuemax="100"' +
      (work.state === 'running' ? '' : ' aria-valuenow="' + (work.state === 'done' ? '100' : '0') + '"') + ' aria-valuetext="' + esc(work.label + ' · ' + work.detail) + '"><span class="work-fill"></span></span>' +
      (expanded ? '<span class="work-detail">' + esc(work.detail) + '</span>' : work.state === 'done' && work.detail.includes('Chờ duyệt') ? '<span class="work-detail">Chờ duyệt</span>' : '') + '</span>';
  }
  const workObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    entries.forEach(entry => entry.target.classList.toggle('work-in-view', entry.isIntersecting));
  }) : undefined;
  function syncWorkBars() {
    document.body.classList.toggle('work-paused', !panelVisible || document.hidden);
    workObserver?.disconnect();
    document.querySelectorAll('.work-indicator[data-work="running"]:not(.office-work-indicator)').forEach(bar => {
      if (workObserver) { bar.classList.remove('work-in-view'); workObserver.observe(bar); }
      else bar.classList.add('work-in-view');
    });
  }
  document.addEventListener('visibilitychange', syncWorkBars);
  function render() {
    renderQa();
    $('generateImage').disabled = Boolean(state.imageBusy);
    $('imageStop').disabled = !state.imageBusy;
    $('imageStatus').textContent = state.imageBusy ? 'Đang tạo ảnh…' : '';
    const session = current(); const tasks = session?.tasks || [];
    $('roleCount').textContent = teamRoles().length + ' vị trí';
    $('workspace').textContent = state.workspace || 'Workspace';
    $('teamName').firstChild.textContent = state.config.name || 'After Effects Production';
    const families = {};
    teamRoles().forEach(role => {
      const family = /opus/i.test(role.model) ? 'OPUS' : /sonnet/i.test(role.model) ? 'SONNET' : /haiku/i.test(role.model) ? 'HAIKU' : /^gpt-/i.test(role.model) ? 'GPT' : 'KHÁC';
      families[family] = (families[family] || 0) + 1;
    });
    $('modelSummary').textContent = Object.entries(families).map(([name, count]) => count + ' ' + name).join(' · ') + ' | IMAGE TOOL';
    const connected = state.hasKey && state.config.openaiBaseUrl && state.config.anthropicBaseUrl;
    $('connectionLabel').textContent = connected ? 'Đã cấu hình · chưa xác minh' : 'Chưa cấu hình gateway';
    $('connectionDot').classList.toggle('warning', !connected);
    $('roles').innerHTML = teamRoles().map((role, index) => {
      const owned = tasks.filter(t => t.roleId === role.id);
      const running = owned.find(t => t.status === 'running');
      const latest = running || owned.find(t => t.status === 'blocked') || owned.find(t => t.status === 'review') || owned.find(t => t.status === 'assigned');
      const work = workFor(role.id);
      return '<button class="role-card role role-' + esc(role.id) + '" data-action="role" data-id="' + esc(role.id) + '" aria-label="' + esc('Trò chuyện và xem tác vụ của ' + role.name) + '">' +
        '<div class="role-top"><span class="avatar">0' + (index + 1) + '</span><span class="role-state work-state-' + esc(work.state) + '">' + esc(work.label) + '</span></div>' +
        '<div class="role-name" title="' + esc(role.name) + '">' + esc(role.name) + '</div><div class="role-specialty">' + esc(role.shortName) + '</div><div class="model">' + esc(role.model) + '</div>' +
        workIndicator(role, work) + '<div class="role-activity">' + esc(latest?.title || role.shortName) + '</div></button>';
    }).join('');
    $('sessionSelect').innerHTML = state.sessions.length ? state.sessions.map(s =>
      '<option value="' + esc(s.id) + '"' + (s.id === state.selectedId ? ' selected' : '') + '>' +
      (s.demo ? '[DEMO] ' : '') + esc(s.name) + '</option>').join('') : '<option>Chưa có phiên</option>';
    $('sessionState').textContent = session?.demo ? 'DEMO' : labels[session?.state || 'idle'];
    $('sessionState').className = 'state-badge ' + (session?.demo ? 'demo' : session?.state || '');
    $('sessionTitle').textContent = session ? session.name : 'Tạo phiên mới để giao việc cho team';
    $('demoNotice').hidden = !session?.demo;
    $('runBtn').disabled = !session || session.demo || session.legacy || session.state === 'running' || session.state === 'done';
    $('runBtn').textContent = session?.state === 'idle' ? '▷ Bắt đầu' : '▷ Tiếp tục';
    $('pauseBtn').disabled = session?.state !== 'running';
    $('footerStatus').textContent = state.active ? state.active + ' tác vụ đang chạy' : 'Team đã sẵn sàng';
    $('aeStripStatus').textContent = aeStatusLabel() + (state.ae?.status ? ' · ' + state.ae.status.activeTools + ' công cụ' : '');
    $('boardView').innerHTML = statuses.map(([id, title]) => {
      const items = tasks.filter(t => t.status === id);
      return '<section class="column column-' + id + '"><div class="column-head"><span class="column-label"><i class="column-dot"></i>' +
        title + '</span><span class="count">' + items.length + '</span></div><div class="task-list">' +
        (items.length ? items.map(task => {
          const role = roleFor(task.roleId);
          return '<button class="task role role-' + esc(role.id) + '" data-action="task" data-id="' + esc(task.id) + '">' +
            '<div class="task-role">' + esc(role.name) + '</div><div class="task-title">' + esc(task.title) + '</div>' +
            '<div class="task-bottom"><span class="task-id">#' + esc(task.id) + '</span><span>' +
            (task.dependencies.length ? task.dependencies.length + ' phụ thuộc' : 'Không phụ thuộc') + '</span></div>' +
            (task.error ? '<div class="error-excerpt">' + esc(task.error) + '</div>' : '') + '</button>';
        }).join('') : '<div class="empty"><span class="empty-icon">' + (id === 'approved' ? '✓' : '⌑') + '</span>Chưa có việc</div>') +
        '</div></section>';
    }).join('');
    renderActive(); if (detailId) renderDetail(detailId); else if (detailRoleId) renderRoleTasks(detailRoleId);
    syncWorkBars();
  }
  const viewContext = () => ({ session: current(), roles: state.config.roles, plans: (state.ae?.plans || []).filter(p => p.sessionId === current()?.id), usage: state.usage });
  function renderActive() {
    const ctx = viewContext();
    if (selectedTab === 'results') $('resultsView').innerHTML = window.AETeamViews.results(ctx, resultFilter);
    if (selectedTab === 'timeline') $('timelineView').innerHTML = window.AETeamViews.timeline(ctx, timelineFilter);
    if (selectedTab === 'workflow') $('workflowView').innerHTML = window.AETeamViews.workflow(ctx);
    if (selectedTab === 'stats') $('statsView').innerHTML = window.AETeamViews.stats(ctx);
    if (selectedTab === 'office') renderOffice();
    if (selectedTab === 'ae') renderAe();
    office?.setActive(selectedTab === 'office' && panelVisible);
  }
  function saveUi() { api.setState?.({ tab: selectedTab, focus: document.body.classList.contains('focus'), officeRole, camera: officeCamera, officePreview, resultFilter, timelineFilter }); }
  function switchTab(tab, shouldRender = true) {
    if (!tabs.includes(tab)) return;
    selectedTab = tab;
    document.querySelectorAll('[data-tab]').forEach(el => { el.classList.toggle('selected', el.dataset.tab === tab); el.setAttribute('aria-selected', String(el.dataset.tab === tab)); });
    tabs.forEach(name => { $(name + 'View').hidden = name !== tab; });
    saveUi(); if (shouldRender) renderActive();
  }
  function selectOfficeRole(id) { officeRole = id; saveUi(); renderOffice(); openRole(id); }
  function renderOffice() {
    const roles = teamRoles(); const tasks = current()?.tasks || [];
    $('officeRoleCount').textContent = 'Team / ' + roles.length + ' vị trí';
    const demo = Boolean(current()?.demo);
    $('officeMotionBtn').hidden = !demo;
    $('officeMotionBtn').textContent = officePreview ? 'Ⅱ Dừng minh họa' : '▷ Xem chuyển động';
    $('officeMotionBtn').setAttribute('aria-pressed', String(officePreview));
    $('officeMotionHint').textContent = demo && officePreview ? 'DEMO · Minh họa gõ phím, không chạy model hoặc AE' : 'Đỏ: Đang xử lý · Xanh: Xong · Tiến độ trên bàn = task đã duyệt';
    document.querySelectorAll('[data-action="officeCamera"]').forEach(el => { el.classList.toggle('selected', el.dataset.id === officeCamera); el.setAttribute('aria-pressed', String(el.dataset.id === officeCamera)); });
    if (!roles.some(r => r.id === officeRole)) officeRole = roles[0]?.id || '';
    const latest = owned => owned.find(t => t.status === 'running') || owned.find(t => t.status === 'blocked') || owned.find(t => t.status === 'review') || owned.find(t => t.status === 'assigned');
    const roleStatus = owned => latest(owned)?.status || (owned.length && owned.every(t => t.status === 'approved') ? 'approved' : 'assigned');
    const workStatuses = Object.fromEntries(roles.map(role => [role.id, workFor(role.id)]));
    $('officeSummary').textContent = tasks.filter(t => t.status === 'running').length + ' đang làm · ' + tasks.filter(t => t.status === 'review').length + ' chờ review · ' + (state.ae?.busy ? 'AE đang thực thi' : 'AE không có lệnh từ team');
    $('officeRoster').innerHTML = roles.map(role => {
      const owned = tasks.filter(t => t.roleId === role.id); const value = roleStatus(owned);
      return '<button class="office-roster-seat role role-' + esc(role.id) + (officeRole === role.id ? ' selected' : '') + '" data-action="officeRole" data-id="' + esc(role.id) + '" aria-pressed="' + (officeRole === role.id) + '"><span class="office-person">' + esc(role.name.slice(0, 2)) + '</span><span><strong>' + esc(role.name) + '</strong><small>' + esc(role.model) + '</small>' + workIndicator(role, workStatuses[role.id]) + '</span><i class="seat-state work-state-' + esc(workStatuses[role.id].state) + '"></i></button>';
    }).join('');
    const role = roleFor(officeRole); const owned = tasks.filter(t => t.roleId === officeRole); const value = roleStatus(owned);
    $('officeRoleDetail').innerHTML = '<div class="office-profile role role-' + esc(role.id) + '"><div class="eyebrow">' + (role.id === 'lead' ? '★ ĐẦU PHÒNG / ĐIỀU PHỐI' : 'SELECTED AGENT') + '</div><h3>' + esc(role.name) + '</h3><p class="model">' + esc(role.model) + '</p>' + workIndicator(role, workStatuses[role.id], true) + '<span class="status-chip status-' + value + '">' + statuses.find(s => s[0] === value)[1] + '</span><div class="office-profile-counts"><span><strong>' + owned.length + '</strong> task</span><span><strong>' + owned.filter(t => t.status === 'approved').length + '</strong> đã duyệt</span></div><h4>Công việc của vai trò</h4>' + (role.id === 'image' ? '<button data-action="openImage">Tạo ảnh với iw-imagegen</button>' : '') + (owned.length ? owned.map(t => '<button class="office-task" data-action="task" data-id="' + esc(t.id) + '"><span>' + esc(t.title) + '</span><small>' + statuses.find(s => s[0] === t.status)[1] + '</small></button>').join('') : '<p class="stats-note">Chưa được giao việc trong phiên này.</p>') + '</div>';
    if (!office && !officeFailed) {
      try {
        if (!window.AETeamOffice) throw new Error('Chưa tải được bộ dựng 3D.');
        office = window.AETeamOffice($('officeCanvas'), selectOfficeRole); office.camera(officeCamera);
        $('officeGpuNotice').hidden = true;
      } catch (error) {
        officeFailed = true; $('officeGpuNotice').hidden = false;
        $('officeGpuNotice').textContent = 'Không khởi tạo được WebGL: ' + error.message + ' Danh sách vai trò bên cạnh vẫn hoạt động.';
      }
    }
    office?.update({ roles, tasks, selectedRole: officeRole, demo, previewMotion: demo && officePreview, workStatuses });
    syncWorkBars();
  }
  function renderDetail(id) {
    captureRoleChat();
    const session = current(); const task = session?.tasks.find(t => t.id === id);
    if (!task) { $('detail').hidden = true; detailId = ''; return; }
    const role = roleFor(task.roleId);
    const proposals = session.proposals.filter(p => p.taskId === id);
    $('detail').innerHTML = '<div class="detail-header"><div><div class="task-role role role-' + esc(role.id) + '">' +
      esc(role.name) + '</div><h2>' + esc(task.title) + '</h2><div class="detail-model">' + esc(task.model || role.model) +
      '</div></div><button class="icon-button" data-action="closeDetail" aria-label="Đóng">×</button></div>' +
      (detailRoleId === task.roleId ? '<button class="quiet" data-action="role" data-id="' + esc(task.roleId) + '">← Tác vụ của ' + esc(role.name) + '</button>' : '') +
      '<span class="state-badge">' + statuses.find(s => s[0] === task.status)[1] + '</span>' +
      (task.parentTaskId ? '<p class="stats-note">Subagent của: ' + esc(session.tasks.find(t => t.id === task.parentTaskId)?.title || task.parentTaskId) + '</p>' : '') +
      (session.tasks.some(t => t.parentTaskId === task.id) ? '<h3>Subagent được giao</h3>' + session.tasks.filter(t => t.parentTaskId === task.id).map(t => '<button data-action="task" data-id="' + esc(t.id) + '">' + esc(roleFor(t.roleId).name + ' · ' + t.title) + '</button>').join(' ') : '') +
      '<h3>Phụ thuộc</h3>' + (task.dependencies.length ? task.dependencies.map(dep => {
        const item = session.tasks.find(t => t.id === dep);
        return '<span class="dependency">' + (item?.status === 'approved' ? '✓ ' : '○ ') + esc(dep) + '</span>';
      }).join('') : '<p class="muted">Có thể bắt đầu ngay</p>') +
      (task.error ? '<div class="task-error">' + esc(task.error) + '</div>' : '') +
      (task.scope?.length ? '<h3>Phạm vi được giao</h3><p>' + task.scope.map(s => '<code>' + esc(s) + '</code>').join(' ') + '</p>' : '') +
      (task.acceptance?.length ? '<h3>Tiêu chí nghiệm thu</h3>' + checksList(task.acceptance.map(c => {
        const check = (task.checks || []).find(x => x.id === c.id);
        return { ...c, status: check?.status || 'missing', verified: Boolean((state.deliveries?.[task.parentTaskId]?.checks || []).find(x => x.taskId === task.id && x.id === c.id)?.verified) };
      })) : '') +
      deliveryHtml(state.deliveries?.[id]) +
      '<h3>Kết quả bàn giao</h3><pre>' + esc(task.result || 'Chưa có kết quả. Task chỉ chạy sau khi các phụ thuộc đã được duyệt.') + '</pre>' +
      ((state.ae?.plans || []).some(p => p.sessionId === session.id && p.taskId === id) ? '<p class="stats-note">Task có plan AE. Xem tab After Effects để duyệt, chạy và kiểm tra kết quả.</p>' : '') +
      ((state.mcp?.plans || []).some(p => p.sessionId === session.id && p.taskId === id && p.state === 'proposed') ? '<p class="stats-note">Task có lệnh MCP chờ duyệt. Xem Hàng chờ MCP trong tab After Effects.</p>' : '') +
      (proposals.length ? '<h3>Đề xuất thay đổi file</h3>' + proposals.map(p =>
        '<div class="proposal"><code>' + esc(p.path) + '</code><p>' + esc(p.reason) + '</p><button data-action="preview" data-id="' +
        esc(p.id) + '">Xem diff</button>' + (p.applied ? '<span class="muted">✓ Đã áp dụng</span>' :
          '<button class="primary" data-action="apply" data-id="' + esc(p.id) + '">Áp dụng</button>') + '</div>').join('') : '') +
      '<div class="detail-actions">' + (task.status === 'running' && !session.demo ? '<button data-action="stopTask" data-id="' + esc(id) + '">■ Dừng riêng việc này</button>' : '') + (task.status === 'review' ? '<button class="primary" data-action="approve" data-id="' +
      esc(id) + '">✓ Duyệt task</button>' : '') + (['review', 'blocked'].includes(task.status) ?
      '<button data-action="retry" data-id="' + esc(id) + '">↻ Giao lại</button>' : '') + '</div>' +
      '<p class="stats-note">' + task.requestCount + ' requests · ' + num(task.inputTokens + task.outputTokens) + ' tokens · Lần chạy: ' + task.attempts + '</p>';
    $('detail').hidden = false;
  }
  function renderRoleTasks(id, focusChat = false) {
    const previousChat = captureRoleChat();
    const role = state.config.roles.find(r => r.id === id);
    if (!role) { closeDetail(); return; }
    const session = current();
    const order = ['running', 'blocked', 'review', 'assigned', 'approved'];
    const tasks = (session?.tasks || []).filter(t => t.roleId === id).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    const approved = tasks.filter(t => t.status === 'approved').length;
    const active = tasks.filter(t => t.status === 'running');
    const toolBusy = (state.chatBusy || []).some(c => c.roleId === id && c.sessionId === (state.selectedId || '')) ||
      (id === 'image' && (state.imageWork || []).some(w => w.sessionId === (state.selectedId || '') && w.status === 'running'));
    $('detail').innerHTML = '<div class="detail-header"><div><div class="task-role">HỘI THOẠI & TÁC VỤ</div><h2>' + esc(role.name) + '</h2><p class="stats-note">' +
      esc(session ? 'Phiên: ' + session.name : 'Chưa chọn phiên làm việc') + '</p></div><button class="icon-button" data-action="closeDetail" aria-label="Đóng">×</button></div>' +
      workIndicator(role, workFor(id), true) + (id === 'image' ? '' : modelSwitch(role, active.length > 0 || toolBusy)) + roleChat(role) + '<h3>Công việc của ' + esc(role.name) + '</h3><div class="role-work-summary"><strong>' + (active.length + (toolBusy ? 1 : 0)) + ' đang làm</strong><span>' + tasks.filter(t => t.status === 'review').length + ' chờ review</span><span>' + approved + '/' + tasks.length + ' đã duyệt</span></div>' +
      (tasks.length ? '<progress class="role-work-progress" value="' + approved + '" max="' + tasks.length + '" aria-label="Tiến độ tác vụ đã duyệt"></progress>' : '') +
      (toolBusy ? '<p class="stats-note" role="status">' + (id === 'image' ? 'Đang tạo ảnh hoặc tiếp nhận góp ý.' : esc(role.name) + ' đang trả lời câu hỏi / góp ý của bạn.') + '</p>' : '') +
      (tasks.length ? order.map(status => {
        const owned = tasks.filter(t => t.status === status);
        if (!owned.length) return '';
        return '<section class="role-work-group"><h3>' + (status === 'running' ? 'Đang thực hiện' : statuses.find(s => s[0] === status)[1]) + '</h3>' + owned.map(task => {
          const parent = session.tasks.find(t => t.id === task.parentTaskId);
          const waiting = task.dependencies.filter(dep => !session.tasks.some(t => t.id === dep && t.status === 'approved')).length;
          return '<button class="role-work-task status-' + status + '" data-action="task" data-id="' + esc(task.id) + '"><strong>' + esc(task.title) + '</strong>' +
            (task.prompt && task.prompt !== task.title ? '<span class="role-work-excerpt">' + esc(task.prompt.slice(0, 240)) + '</span>' : '') +
            '<small>' + esc(parent ? 'PO giao: ' + parent.title : 'Tác vụ trong phiên') + (waiting ? ' · Chờ ' + waiting + ' phụ thuộc' : '') + '</small>' +
            (task.error ? '<span class="role-work-error">' + esc(task.error.slice(0, 240)) + '</span>' : '') +
            (task.result ? '<span class="role-work-excerpt">' + esc(task.result.slice(0, 240)) + '</span>' : '') + '<small>Xem chi tiết →</small></button>';
        }).join('') + '</section>';
      }).join('') : '<p class="stats-note">' + (session ? 'Chưa được giao tác vụ trong phiên này.' : 'CEO tạo phiên và giao yêu cầu cho PO trước để xem công việc của kỹ sư.') + '</p>') +
      (id === 'image' || id === 'art' ? '<div class="detail-actions"><button class="primary" data-action="openImage">Tạo ảnh với iw-imagegen</button></div>' : '');
    $('detail').hidden = false;
    restoreRoleChat(previousChat, focusChat);
    syncWorkBars();
  }
  function modelSwitch(role, busy) {
    const family = familyFor(role.protocol);
    const models = [...new Set([...(state.modelPresets || presets)[family], ...gatewayModels.filter(m => modelMatches(m, family)), role.model])];
    return '<form class="model-switch" data-model-switch data-role-id="' + esc(role.id) + '"><label>Model của vị trí<select name="model">' +
      models.map(m => '<option value="' + esc(m) + '"' + (m === role.model ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select></label>' +
      '<button type="submit"' + (busy ? ' disabled' : '') + '>Đổi model</button><small>' + (busy ? 'Đang làm việc · đổi được khi xong lượt hiện tại' : 'Áp dụng từ lượt tiếp theo, các vị trí khác vẫn chạy') + '</small></form>';
  }
  function showToast(text, kind) {
    $('toast').hidden = false; $('toast').className = 'toast ' + (kind || '');
    $('toast').textContent = text; clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, kind === 'error' ? 15000 : 6000);
  }
  const checkLabel = { pass: 'Đạt', fail: 'Không đạt', blocked: 'Bị chặn', missing: 'Chưa báo' };
  function checksList(checks) {
    return '<ul class="check-list">' + checks.map(c => '<li class="' + (c.verified ? 'verified' : 'unverified') + '">' + (c.verified ? '✓ ' : '○ ') +
      esc(c.description) + ' <small>' + esc(c.verification + ' · ' + checkLabel[c.status] + (c.status === 'pass' && !c.verified ? ' · thiếu bằng chứng khớp' : '')) + '</small></li>').join('') + '</ul>';
  }
  function deliveryHtml(report) {
    if (!report) return '';
    const fileState = { applied: 'đã áp dụng', proposed: 'đề xuất, chưa áp dụng' };
    return '<section class="delivery-report"><h3>Báo cáo bàn giao ' + (report.ready ? '<span class="state-badge done">Đủ điều kiện duyệt</span>' : '<span class="state-badge waiting">Còn ' + report.incomplete.length + ' mục</span>') + '</h3>' +
      '<p class="stats-note">' + report.engineers.length + ' kỹ sư · ' + report.files.length + ' file · ' + report.aePlans.length + ' plan AE · ' + report.checks.filter(c => c.verified).length + '/' + report.checks.length + ' tiêu chí có bằng chứng</p>' +
      (report.files.length ? '<ul>' + report.files.map(f => '<li><code>' + esc(f.path) + '</code> · ' + fileState[f.state] + '</li>').join('') + '</ul>' : '') +
      (report.checks.length ? checksList(report.checks) : '') +
      (report.incomplete.length ? '<h4>Chưa hoàn tất</h4><ul>' + report.incomplete.map(i => '<li>' + esc(i.title) + ': ' + esc(i.detail) + '</li>').join('') + '</ul>' : '') + '</section>';
  }
  function closeDetail() { captureRoleChat(); detailId = ''; detailRoleId = ''; $('detail').hidden = true; }
  function openConfig() {
    const c = state.config;
    $('openaiUrl').value = c.openaiBaseUrl || ''; $('anthropicUrl').value = c.anthropicBaseUrl || '';
    $('parallel').value = c.maxParallel || 3; $('maxTokens').value = c.maxOutputTokens || 4096;
    $('budgetCalls').value = c.budget?.maxCalls || 0; $('budgetTokens').value = c.budget?.maxTokens || 0;
    $('prices').value = Object.keys(c.prices || {}).length ? JSON.stringify(c.prices, null, 2) : '';
    $('keyState').textContent = state.hasKey ? '● Đã có API key · được giữ riêng' : '○ Chưa có API key';
    $('roleSettings').innerHTML = c.roles.map(role =>
      '<div class="role-setting role role-' + esc(role.id) + '" data-role-id="' + esc(role.id) + '"><div class="role-setting-grid">' +
      '<span class="setting-role">' + esc(role.name) + '</span><div class="model-picker"><select data-field="model" aria-label="Model ' + esc(role.name) + '"></select><input data-field="customModel" aria-label="ID model tùy chỉnh ' + esc(role.name) + '" placeholder="ID model từ gateway" hidden></div><select data-field="protocol" aria-label="Nhà cung cấp / giao thức ' + esc(role.name) + '">' +
      (role.id === 'image' ? [['iw-imagegen', 'Codex skill · iw-imagegen']] : [['claude-cli', 'Claude · Code CLI'], ['messages', 'Claude · Messages'], ['responses', 'Codex · Responses'], ['chat', 'Codex · Chat Completions']]).map(([id, text]) =>
        '<option value="' + id + '"' + (role.protocol === id ? ' selected' : '') + '>' + text + '</option>').join('') +
      '</select></div><details><summary>Prompt vai trò</summary><textarea data-field="systemPrompt" rows="3">' +
      esc(role.systemPrompt) + '</textarea></details></div>').join('');
    c.roles.forEach(role => updateModelChoices($('roleSettings').querySelector('[data-role-id="' + role.id + '"]'), role.model));
    renderToolbox();
    $('overlay').hidden = false;
  }
  function renderToolbox() {
    const snapshot = state.toolbox?.snapshot, enabled = state.toolbox?.enabled || [];
    $('toolboxSummary').textContent = snapshot ? snapshot.skills.length + ' skill · ' + snapshot.servers.length + ' server MCP · ' + enabled.length + ' đang bật · quét lúc ' + new Date(snapshot.scannedAt).toLocaleString('vi-VN') : 'Chưa quét';
    if (!snapshot) { $('toolboxList').innerHTML = ''; return; }
    const bySource = {};
    snapshot.skills.forEach(s => { bySource[s.source] = (bySource[s.source] || 0) + 1; });
    $('toolboxList').innerHTML = '<p class="stats-note">Skill: ' + (Object.entries(bySource).map(([source, n]) => esc(source) + ' (' + n + ')').join(' · ') || 'không có') + '</p>' +
      (snapshot.servers.length ? '<ul class="mcp-servers">' + snapshot.servers.map(s => '<li><label><input type="checkbox" data-mcp-toggle="' + esc(s.id) + '"' + (enabled.includes(s.id) ? ' checked' : '') +
        '><strong>' + esc(s.name) + '</strong> <small>' + esc(s.source + ' · ' + s.type + ' · ' + s.target) + '</small></label></li>').join('') + '</ul>' : '<p class="muted">Không tìm thấy server MCP.</p>') +
      (snapshot.excluded.length ? '<p class="stats-note">Bỏ qua: ' + esc(snapshot.excluded.join(', ')) + '</p>' : '');
  }
  function renderMcpQueue() {
    const mcp = state.mcp || {}, plans = mcp.plans || [];
    const names = { proposed: 'CHỜ DUYỆT', dispatching: 'ĐANG CHẠY', success: 'THÀNH CÔNG', uncertain: 'CẦN KIỂM TRA', dismissed: 'ĐÃ BỎ QUA' };
    $('mcpHold').hidden = !mcp.hold; $('mcpResolve').disabled = Boolean(mcp.busy);
    $('mcpPlans').innerHTML = plans.length ? [...plans].reverse().map(p => {
      const task = state.sessions.find(s => s.id === p.sessionId)?.tasks.find(t => t.id === p.taskId);
      const enabled = (state.toolbox?.enabled || []).includes(p.serverId);
      return '<article class="ae-plan-card"><div class="result-head"><div><h3>' + esc(p.serverName + ' · ' + p.tool) + '</h3><small>' + esc(task ? roleFor(task.roleId).name + ' · ' + task.title : 'Không gắn task') + '</small></div><span class="state-badge ' + esc(p.state) + '">' + names[p.state] + '</span></div>' +
        '<p>' + esc(p.reason) + '</p><details' + (p.state === 'proposed' ? ' open' : '') + '><summary>Đối số</summary><pre>' + esc(JSON.stringify(p.args, null, 2)) + '</pre></details>' +
        (p.result ? '<details open><summary>Kết quả thực tế</summary><pre>' + esc(JSON.stringify(p.result, null, 2)) + '</pre></details>' : '') +
        '<div class="ae-actions">' + (p.state === 'proposed' ? '<button class="primary" data-action="mcpExecute" data-id="' + esc(p.id) + '"' + (mcp.busy || mcp.hold || !enabled ? ' disabled' : '') + '>Duyệt & thực thi</button>' + (enabled ? '' : '<small>Bật server trong Proxy & model</small>') : '') +
        (p.state === 'proposed' || (p.state === 'uncertain' && !mcp.hold && !mcp.busy) ? '<button data-action="mcpDismiss" data-id="' + esc(p.id) + '">Bỏ qua</button>' : '') + '</div></article>';
    }).join('') : '<p class="ae-empty">Chưa có lệnh MCP nào cần duyệt.</p>';
  }
  function openAe() { switchTab('ae'); send('aeRefresh'); }
  let connectionExpiry;
  function aeConnected(status) {
    const c = status?.connection;
    return Boolean(c?.fresh && c.state === 'running' && c.revisionMatches &&
      (!c.checkedAtEpochMs || c.ageMs + Date.now() - c.checkedAtEpochMs < 15000));
  }
  function aeStatusLabel() {
    const ae = state.ae || {}; const status = ae.status;
    const connected = aeConnected(status);
    return ae.busy ? 'Đang chạy một lệnh AE…' : ae.hold ? 'Cần kiểm tra kết quả lệnh trước' : connected ? 'AE có heartbeat mới · có thể nhận lệnh' : status ? 'Engine sẵn sàng · chưa kết nối After Effects' : 'Chưa kiểm tra kết nối';
  }
  function renderAe() {
    const ae = state.ae || {}; const status = ae.status;
    const connected = aeConnected(status);
    const label = aeStatusLabel();
    clearTimeout(connectionExpiry);
    if (connected && status.connection.checkedAtEpochMs) connectionExpiry = setTimeout(renderAe, Math.max(1, 15001 - status.connection.ageMs - (Date.now() - status.connection.checkedAtEpochMs)));
    $('aeConnection').textContent = label;
    $('aeStripStatus').textContent = label + (status ? ' · ' + status.activeTools + ' công cụ' : '');
    $('aeEnginePath').textContent = ae.root || 'Tự tìm engine AE_Team tích hợp';
    $('aeHold').hidden = !ae.hold;
    $('aeProject').disabled = ae.busy || ae.hold || !connected;
    $('aePickEngine').disabled = ae.busy || ae.hold;
    $('aeResolve').disabled = ae.busy;
    if (status) $('aeCount').textContent = status.activeTools + ' công cụ AE · ' + (status.installation?.certificateMatches ? 'bundle hợp lệ' : 'chưa xác minh bundle') + ' · ' + (connected ? 'đã kết nối' : 'chưa kết nối');
    const stateName = { proposed: 'CHỜ DUYỆT', dispatching: 'ĐANG CHẠY', success: 'THÀNH CÔNG', uncertain: 'CẦN KIỂM TRA', dismissed: 'ĐÃ BỎ QUA' };
    $('aePlans').innerHTML = (ae.plans || []).length ? [...ae.plans].reverse().map(p => {
      const task = state.sessions.find(s => s.id === p.sessionId)?.tasks.find(t => t.id === p.taskId);
      const canRun = p.state === 'proposed' && !ae.busy && !ae.hold && connected;
      const canDismiss = p.state === 'proposed' || (p.state === 'uncertain' && !ae.busy);
      return '<article class="ae-plan-card"><div class="result-head"><div><h3>' + esc(p.title) + '</h3><small>' + esc(task?.title || 'Plan thủ công') + '</small></div><span class="state-badge ' + esc(p.state) + '">' + stateName[p.state] + '</span></div><p>' + esc(p.reason) + '</p><div class="ae-step-summary">' + p.plan.steps.map((s, i) => '<code>' + (i + 1) + ' · ' + esc(s.function) + '</code>').join('') + '</div><details' + (p.state === 'proposed' ? ' open' : '') + '><summary>Xem toàn bộ JSON · ' + p.plan.steps.length + ' bước</summary><pre>' + esc(JSON.stringify(p.plan, null, 2)) + '</pre></details>' +
        (p.result ? '<details open><summary>Kết quả thực tế</summary><pre>' + esc(JSON.stringify(p.result, null, 2)) + '</pre></details>' : '') +
        '<div class="ae-actions">' + (p.state === 'proposed' ? '<button class="primary" data-action="aeExecute" data-id="' + esc(p.id) + '"' + (canRun ? '' : ' disabled') + '>Duyệt & thực thi trong AE</button>' : '') +
        (canDismiss ? '<button data-action="aeDismiss" data-id="' + esc(p.id) + '">Bỏ qua plan</button>' : '') + '</div></article>';
    }).join('') : '<p class="ae-empty">Model đề xuất plan từ task, hoặc nhập JSON bên trên. Chưa có lệnh nào được gửi tới AE.</p>';
    if (ae.lastRead) $('aeLastRead').textContent = JSON.stringify(ae.lastRead, null, 2);
    renderMcpQueue();
  }
  $('aeOpenBtn').addEventListener('click', openAe);
  $('aeOpenProject').addEventListener('click', () => send('aeOpenProject'));
  $('aeSaveProject').addEventListener('click', () => send('aeSaveProject'));
  $('aeCachedProject').addEventListener('click', () => send('aeCachedProject'));
  $('officeMotionBtn').addEventListener('click', () => { officePreview = !officePreview; saveUi(); renderOffice(); });
  ['Refresh', 'Project', 'Inventory', 'PickEngine', 'OpenEngine', 'Resolve'].forEach(action => {
    $('ae' + action).addEventListener('click', () => send('ae' + action));
  });
  $('aeSfxForm').addEventListener('submit', event => { event.preventDefault(); send('aeInventory', { query: $('aeSfxQuery').value }); });
  $('aeSearchForm').addEventListener('submit', event => { event.preventDefault(); send('aeSearch', { query: $('aeQuery').value }); });
  $('aeStage').addEventListener('click', () => send('aeStage', { title: $('aePlanTitle').value.trim(), planJson: $('aePlanJson').value }));
  $('configBtn').addEventListener('click', openConfig);
  $('toolboxScan').addEventListener('click', () => send('toolboxScan'));
  $('mcpResolve').addEventListener('click', () => send('mcpResolve'));
  $('toolboxList').addEventListener('change', event => {
    const id = event.target.dataset?.mcpToggle; if (id) send('mcpToggle', { id, enabled: event.target.checked });
  });
  $('closeConfig').addEventListener('click', () => { $('overlay').hidden = true; });
  $('focusBtn').addEventListener('click', () => { document.body.classList.toggle('focus'); saveUi(); });
  $('newBtn').addEventListener('click', () => { document.body.classList.remove('focus'); $('brief').focus(); });
  $('createBtn').addEventListener('click', () => {
    if (!$('brief').value.trim()) { $('brief').focus(); return; }
    send('create', { brief: $('brief').value, autoStart: true });
  });
  $('demoBtn').addEventListener('click', () => send('demo'));
  $('runBtn').addEventListener('click', () => send('run'));
  $('pauseBtn').addEventListener('click', () => send('pause'));
  $('exportBtn').addEventListener('click', () => send('export'));
  $('deleteSessionBtn').addEventListener('click', () => send('deleteSession', { id: state.selectedId }));
  $('keyBtn').addEventListener('click', () => send('setKey'));
  $('localBtn').addEventListener('click', () => send('importLocal'));
  $('testBtn').addEventListener('click', () => send('testConnection'));
  $('sessionSelect').addEventListener('change', event => { closeDetail(); send('selectSession', { id: event.target.value }); });
  $('saveConfig').addEventListener('click', () => {
    let prices = {};
    try { prices = $('prices').value.trim() ? JSON.parse($('prices').value) : {}; }
    catch { showToast('Bảng giá phải là JSON hợp lệ, ví dụ { "model": { "input": 15, "output": 75 } }.', 'error'); return; }
    const config = { ...state.config, openaiBaseUrl: $('openaiUrl').value.trim(), anthropicBaseUrl: $('anthropicUrl').value.trim(),
      maxParallel: Number($('parallel').value), maxOutputTokens: Number($('maxTokens').value),
      budget: { maxCalls: Number($('budgetCalls').value || 0), maxTokens: Number($('budgetTokens').value || 0) }, prices,
      roles: state.config.roles.map(role => {
        const row = $('roleSettings').querySelector('[data-role-id="' + role.id + '"]');
        const model = row.querySelector('[data-field="model"]').value;
        return { ...role, model: (model === '__custom__' ? row.querySelector('[data-field="customModel"]').value : model).trim(),
          protocol: row.querySelector('[data-field="protocol"]').value, systemPrompt: row.querySelector('[data-field="systemPrompt"]').value };
      }) };
    send('saveConfig', { config }); $('overlay').hidden = true;
  });
  $('roleSettings').addEventListener('change', event => {
    const row = event.target.closest('[data-role-id]'); if (!row) return;
    if (event.target.dataset.field === 'protocol') {
      const select = row.querySelector('[data-field="model"]');
      const model = select.value === '__custom__' ? row.querySelector('[data-field="customModel"]').value : select.value;
      const family = familyFor(event.target.value);
      updateModelChoices(row, modelMatches(model, family) ? model : undefined);
    }
    if (event.target.dataset.field === 'model') {
      const input = row.querySelector('[data-field="customModel"]'); input.hidden = event.target.value !== '__custom__'; if (!input.hidden) input.focus();
    }
  });
  $('tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-tab]'); if (button) switchTab(button.dataset.tab);
  });
  document.addEventListener('submit', event => {
    if (event.target.matches('[data-model-switch]')) {
      event.preventDefault();
      const roleId = event.target.dataset.roleId, model = event.target.elements.model.value;
      if (model && model !== roleFor(roleId).model) send('setRoleModel', { roleId, model });
    }
    if (event.target.matches('[data-role-chat-form]')) {
      event.preventDefault(); const form = event.target;
      const roleId = form.dataset.roleId, sessionId = form.dataset.sessionId;
      const key = chatKey(sessionId, roleId), input = form.querySelector('[data-role-chat-input]'), text = input.value.trim();
      if (!text || chatPending.has(key) || (state.chatBusy || []).some(c => c.roleId === roleId && c.sessionId === sessionId)) return;
      chatPending.add(key); input.value = ''; captureRoleChat();
      send('roleChatSend', { roleId, sessionId, text }); renderRoleTasks(roleId);
    }
    if (event.target.id === 'resultFilters') {
      event.preventDefault(); const form = event.target;
      resultFilter = { role: form.elements.role.value, status: form.elements.status.value, query: form.elements.query.value.trim() }; saveUi(); renderActive();
    }
    if (event.target.id === 'timelineFilters') {
      event.preventDefault(); const form = event.target;
      timelineFilter = { role: form.elements.role.value, kind: form.elements.kind.value, order: form.elements.order.value, query: form.elements.query.value.trim() }; saveUi(); renderActive();
    }
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'task') { detailId = id; renderDetail(id); }
    if (action === 'closeDetail') closeDetail();
    if (action === 'role') openRole(id);
    if (action === 'roleChatStop') send('roleChatStop', { roleId: id, sessionId: button.dataset.sessionId });
    if (action === 'openImage') openImage();
    if (action === 'openQa') openQa();
    if (action === 'officeRole') selectOfficeRole(id);
    if (action === 'goAe') openAe();
    if (action === 'officeCamera') { officeCamera = id; office?.camera(id); saveUi(); renderOffice(); }
    if (action === 'officeReset') { office?.dispose(); office = undefined; officeFailed = false; renderOffice(); office?.setActive(panelVisible); }
    if (['approve', 'retry', 'stopTask'].includes(action)) send(action, { taskId: id });
    if (['preview', 'apply'].includes(action)) send(action, { proposalId: id });
    if (['aeExecute', 'aeDismiss', 'mcpExecute', 'mcpDismiss'].includes(action)) send(action, { id });
    if (action === 'aeInspect') send('aeInspect', { id });
  });
  $('imageBtn').addEventListener('click', openImage);
  $('qaBtn').addEventListener('click', openQa);
  $('closeQa').addEventListener('click', () => { $('qaOverlay').hidden = true; });
  $('qaForm').addEventListener('submit', event => { event.preventDefault(); const text = $('qaInput').value.trim(); if (!text || state.qa?.busy) return; send('qaSend', { text }); $('qaInput').value = ''; });
  $('qaStop').addEventListener('click', () => send('supportStop', { target: 'qa' }));
  $('imageStop').addEventListener('click', () => send('supportStop', { target: 'image' }));
  $('closeImage').addEventListener('click', () => { $('imageOverlay').hidden = true; });
  $('generateImage').addEventListener('click', () => {
    const prompt = $('imagePrompt').value.trim(); if (!prompt) return;
    send('image', { prompt }); $('imageOverlay').hidden = true;
  });
  window.addEventListener('pagehide', () => { workObserver?.disconnect(); office?.dispose(); }, { once: true });
  document.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key) && event.target.matches('.flow-node')) { event.preventDefault(); detailId = event.target.dataset.id; renderDetail(detailId); }
    if (event.key === 'Escape') { $('overlay').hidden = true; $('imageOverlay').hidden = true; $('qaOverlay').hidden = true; closeDetail(); }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') { if (state.selectedId !== message.selectedId) closeDetail(); chatPending.clear(); state = message; switchTab(selectedTab, false); render(); if (!$('overlay').hidden) { $('keyState').textContent = state.hasKey ? '● Đã có API key · được giữ riêng' : '○ Chưa có API key'; renderToolbox(); } }
    if (message.type === 'visibility') { panelVisible = message.visible; office?.setActive(selectedTab === 'office' && panelVisible); syncWorkBars(); }
    if (message.type === 'configure') openConfig();
    if (message.type === 'openAe') openAe();
    if (message.type === 'aeCatalog') {
      const results = message.value.results || [];
      $('aeToolsList').innerHTML = results.length ? results.map(f => '<button class="ae-tool" data-action="aeInspect" data-id="' + esc(f.id) + '"><strong>' + esc(f.name) + '</strong><small>' + (f.mutates ? 'CHỈNH AE' : 'CHỈ ĐỌC') + '</small><p>' + esc(f.description) + '</p></button>').join('') : '<p class="muted">Không tìm thấy. Thử từ khóa ngắn hơn.</p>';
    }
    if (message.type === 'aeSchema') { $('aeSchemaWrap').hidden = false; $('aeSchema').textContent = JSON.stringify(message.value, null, 2); }
    if (message.type === 'models') {
      gatewayModels = message.models.filter(id => typeof id === 'string').slice(0, 2000);
      $('roleSettings').querySelectorAll('[data-role-id]').forEach(row => { const selected = row.querySelector('[data-field="model"]').value; if (selected !== '__custom__') updateModelChoices(row, selected); });
      $('modelList').hidden = false;
      $('modelList').textContent = 'MODELS TỪ GATEWAY\n' + message.models.join('\n');
    }
    if (message.type === 'toast') {
      if (message.kind === 'error' && chatPending.size) { chatPending.clear(); if (detailRoleId && !detailId) renderRoleTasks(detailRoleId); }
      showToast(message.text, message.kind);
    }
  });
  send('ready');
})();


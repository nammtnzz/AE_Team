(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statusNames = { assigned: 'Được giao', running: 'Đang làm', review: 'Chờ review', approved: 'Đã duyệt', blocked: 'Cần xử lý' };
  const planNames = { proposed: 'Chờ duyệt', dispatching: 'Đang thực thi', success: 'Thành công', uncertain: 'Cần kiểm tra', dismissed: 'Đã bỏ qua' };
  const number = n => Number(n || 0).toLocaleString('vi-VN');
  const duration = ms => ms < 1000 ? '< 1 giây' : ms < 60000 ? Math.round(ms / 1000) + ' giây' : Math.floor(ms / 60000) + ' phút ' + Math.round(ms % 60000 / 1000) + ' giây';
  const status = id => '<span class="status-chip status-' + esc(id) + '">' + esc(statusNames[id] || id) + '</span>';
  const metric = (name, value, hint = '') => '<div class="stat"><small>' + esc(name) + '</small><strong>' + esc(value) + '</strong><span>' + esc(hint) + '</span></div>';
  const blank = (icon, text) => '<div class="empty"><span class="empty-icon">' + icon + '</span>' + esc(text) + '</div>';
  const roleOf = (ctx, id) => ctx.roles.find(r => r.id === id) || { id, name: id, color: '#aaa', model: '' };
  const roleOptions = (ctx, chosen) => '<option value="all">Tất cả vai trò</option>' + ctx.roles.map(r => '<option value="' + esc(r.id) + '"' + (chosen === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('');
  const matches = (text, query) => !query || text.toLocaleLowerCase('vi-VN').includes(query.toLocaleLowerCase('vi-VN'));
  function results(ctx, filter) {
    const tasks = ctx.session?.tasks || []; const all = tasks.filter(t => t.result || t.error || ctx.plans.some(p => p.taskId === t.id) || ctx.session?.proposals.some(p => p.taskId === t.id));
    const found = all.filter(t => (filter.role === 'all' || t.roleId === filter.role) && (filter.status === 'all' || t.status === filter.status) && matches(t.title + ' ' + t.result + ' ' + t.error, filter.query));
    const proposals = ctx.session?.proposals || [];
    return '<div class="view-heading"><div><div class="eyebrow">DELIVERABLES</div><h2>Kết quả & bàn giao</h2><p>Đầu ra của từng vai trò, đề xuất file và kết quả plan AE.</p></div><span class="view-count">' + found.length + ' / ' + all.length + ' task có đầu ra</span></div>' +
      '<div class="stats-summary">' + metric('Bàn giao', all.length, 'Task có kết quả hoặc đề xuất') + metric('Chờ review', tasks.filter(t => t.status === 'review').length, 'Cần người dùng kiểm tra') + metric('File đã áp dụng', proposals.filter(p => p.applied).length + ' / ' + proposals.length) + metric('Plan AE thành công', ctx.plans.filter(p => p.state === 'success').length + ' / ' + ctx.plans.length) + '</div>' +
      '<form id="resultFilters" class="view-filters"><select name="role" aria-label="Lọc kết quả theo vai trò">' + roleOptions(ctx, filter.role) + '</select><select name="status" aria-label="Lọc kết quả theo trạng thái"><option value="all">Tất cả trạng thái</option>' + Object.entries(statusNames).map(([id, name]) => '<option value="' + id + '"' + (filter.status === id ? ' selected' : '') + '>' + name + '</option>').join('') + '</select><input name="query" aria-label="Tìm kết quả" placeholder="Tìm trong tiêu đề, nội dung bàn giao…" value="' + esc(filter.query) + '"><button type="submit">Lọc kết quả</button></form>' +
      (found.length ? found.map(task => {
        const role = roleOf(ctx, task.roleId); const files = proposals.filter(p => p.taskId === task.id); const plans = ctx.plans.filter(p => p.taskId === task.id);
        return '<article class="result-card role role-' + esc(role.id) + '"><div class="result-head"><div><div class="task-role">' + esc(role.name) + ' · ' + esc(task.model || role.model) + '</div><h3>' + esc(task.title) + '</h3></div>' + status(task.status) + '</div>' +
          (task.result ? '<pre>' + esc(task.result.slice(0, 16000)) + '</pre>' + (task.result.length > 16000 ? '<p class="stats-note">Đang hiển thị 16.000 ký tự đầu. Mở task để đọc đầy đủ.</p>' : '') : '<p class="result-pending">Chưa có nội dung bàn giao.</p>') +
          (task.error ? '<div class="task-error">' + esc(task.error) + '</div>' : '') +
          (files.length ? '<div class="result-assets"><h4>Đề xuất file</h4>' + files.map(p => '<div class="asset-row"><div><code>' + esc(p.path) + '</code><small>' + esc(p.reason) + '</small></div><span class="status-chip">' + (p.applied ? '✓ Đã áp dụng' : 'Chờ áp dụng') + '</span><button data-action="preview" data-id="' + esc(p.id) + '">Xem diff</button></div>').join('') + '</div>' : '') +
          (plans.length ? '<div class="result-assets"><h4>Plan After Effects</h4>' + plans.map(p => '<div class="asset-row"><div><strong>' + esc(p.title) + '</strong><small>' + p.plan.steps.length + ' bước · ' + esc(planNames[p.state]) + '</small></div><button data-action="goAe">Xem plan ↗</button></div>').join('') + '</div>' : '') +
          '<div class="result-bottom"><span>' + number(task.requestCount) + ' request · ' + number(task.inputTokens + task.outputTokens) + ' token</span><button data-action="task" data-id="' + esc(task.id) + '">Xem task & review ↗</button></div></article>';
      }).join('') : blank('▤', all.length ? 'Không có kết quả khớp bộ lọc.' : 'Chạy team hoặc mở demo để xem kết quả bàn giao.')) +
      (ctx.session?.demo ? '<p class="stats-note">Dữ liệu DEMO. Các đầu ra minh họa không chứng minh đã chỉnh hoặc kiểm thử AE.</p>' : '');
  }
  function timeline(ctx, filter) {
    const events = ctx.session?.events || []; const tasks = ctx.session?.tasks || [];
    const kinds = { delegate: 'Giao subagent', start: 'Bắt đầu', tool: 'Công cụ', review: 'Chờ review', approved: 'Đã duyệt', error: 'Lỗi', pause: 'Tạm dừng', retry: 'Giao lại', file: 'File', image: 'Ảnh', ae: 'After Effects', demo: 'Demo', info: 'Thông tin' };
    const types = [...new Set(events.map(e => e.kind))];
    const found = events.map((event, index) => ({ ...event, index })).filter(e => {
      const task = tasks.find(t => t.id === e.taskId);
      return (filter.kind === 'all' || e.kind === filter.kind) && (filter.role === 'all' || task?.roleId === filter.role) && matches(e.text + ' ' + (task?.title || ''), filter.query);
    });
    const sorted = [...found].sort((a, b) => a.at - b.at || a.index - b.index);
    const ordered = filter.order === 'oldest' ? sorted : sorted.reverse(); let lastDay = '';
    return '<div class="view-heading"><div><div class="eyebrow">SESSION ACTIVITY</div><h2>Timeline</h2><p>Nhật ký đã ghi nhận của phiên, theo thời gian thực hiện.</p></div><span class="view-count">' + found.length + ' / ' + events.length + ' sự kiện</span></div>' +
      '<form id="timelineFilters" class="view-filters"><select name="kind" aria-label="Lọc loại sự kiện"><option value="all">Tất cả sự kiện</option>' + types.map(kind => '<option value="' + esc(kind) + '"' + (filter.kind === kind ? ' selected' : '') + '>' + esc(kinds[kind] || kind) + '</option>').join('') + '</select><select name="role" aria-label="Lọc timeline theo vai trò">' + roleOptions(ctx, filter.role) + '</select><select name="order" aria-label="Thứ tự timeline"><option value="newest">Mới nhất trước</option><option value="oldest"' + (filter.order === 'oldest' ? ' selected' : '') + '>Cũ nhất trước</option></select><input name="query" aria-label="Tìm trong timeline" placeholder="Tìm hoạt động…" value="' + esc(filter.query) + '"><button type="submit">Lọc timeline</button></form>' +
      '<div class="activity-legend"><span>● Bắt đầu</span><span>● Công cụ</span><span>● Review</span><span>● Lỗi / blocker</span><small>Tối đa 500 sự kiện gần nhất được lưu cho mỗi phiên.</small></div>' +
      (ordered.length ? '<div class="activity-list">' + ordered.map(event => {
        const day = new Date(event.at).toLocaleDateString('vi-VN'); const header = day !== lastDay ? '<h3 class="activity-day">' + day + '</h3>' : ''; lastDay = day;
        const task = tasks.find(t => t.id === event.taskId); const role = task ? roleOf(ctx, task.roleId) : undefined;
        return header + '<article class="activity-row event-' + esc(event.kind) + '"><time datetime="' + new Date(event.at).toISOString() + '">' + new Date(event.at).toLocaleTimeString('vi-VN', { hour12: false }) + '</time><i></i><div><div class="activity-meta"><span>' + esc(kinds[event.kind] || event.kind) + '</span><small>#' + (event.index + 1) + (role ? ' · ' + esc(role.name) : ' · Hệ thống') + '</small></div><p>' + esc(event.text) + '</p>' + (task ? '<button class="quiet" data-action="task" data-id="' + esc(task.id) + '">' + esc(task.title) + ' ↗</button>' : '') + '</div></article>';
      }).join('') + '</div>' : blank('◷', 'Chưa có hoạt động khớp bộ lọc.'));
  }
  function workflow(ctx) {
    const tasks = ctx.session?.tasks || [];
    if (!tasks.length) return '<div class="view-heading"><div><div class="eyebrow">TASK DEPENDENCIES</div><h2>Luồng việc</h2><p>Phụ thuộc và cửa duyệt của các task trong phiên đang chọn.</p></div></div>' + blank('⇢', 'Tạo phiên hoặc mở demo để xem sơ đồ task thực tế.');
    const ranks = new Map(); const visiting = new Set();
    function rank(task) {
      if (ranks.has(task.id)) return ranks.get(task.id);
      if (visiting.has(task.id)) return 0;
      visiting.add(task.id);
      const value = Math.min(tasks.length, Math.max(-1, ...task.dependencies.map(id => tasks.find(t => t.id === id)).filter(Boolean).map(rank)) + 1);
      visiting.delete(task.id); ranks.set(task.id, value); return value;
    }
    tasks.forEach(rank); const columns = [];
    tasks.forEach(task => { const n = ranks.get(task.id); (columns[n] ||= []).push(task); });
    const width = Math.max(1000, columns.length * 190 + 30); const height = Math.max(340, Math.max(...columns.filter(Boolean).map(c => c.length)) * 108 + 90);
    const positions = new Map();
    columns.forEach((column, x) => column?.forEach((task, y) => positions.set(task.id, { x: 25 + x * 190, y: 55 + (height - 90 - column.length * 108) / 2 + y * 108 })));
    const edges = tasks.flatMap(task => task.dependencies.map(id => {
      const from = positions.get(id), to = positions.get(task.id); if (!from || !to) return '';
      const x1 = from.x + 155, y1 = from.y + 37, x2 = to.x, y2 = to.y + 37, mid = (x1 + x2) / 2;
      const approved = tasks.find(t => t.id === id)?.status === 'approved';
      return '<path class="flow-edge' + (approved ? ' unlocked' : '') + '" d="M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2 + '" marker-end="url(#flowArrow)"><title>' + esc(id + ' → ' + task.id) + '</title></path>';
    })).join('');
    const nodes = tasks.map(task => {
      const pos = positions.get(task.id); const role = roleOf(ctx, task.roleId); const title = task.title;
      const lines = title.match(/.{1,24}(?:\s|$)|.{1,24}/g)?.map(s => s.trim()) || [title];
      return '<g class="flow-node node-' + esc(task.status) + '" role="button" tabindex="0" data-action="task" data-id="' + esc(task.id) + '" aria-label="' + esc(title + ' · ' + statusNames[task.status]) + '" transform="translate(' + pos.x + ',' + pos.y + ')"><title>' + esc(title + '\n' + role.name + '\n' + statusNames[task.status]) + '</title><rect width="155" height="82" rx="8"/><text class="node-role" x="12" y="18">' + esc(role.name) + '</text><text x="12" y="36">' + lines.slice(0, 2).map((line, i) => '<tspan x="12" dy="' + (i ? '14' : '0') + '">' + esc(line) + '</tspan>').join('') + '</text><text class="node-status" x="12" y="70">' + esc(statusNames[task.status]) + '</text></g>';
    }).join('');
    const ready = tasks.filter(t => t.status === 'assigned' && t.dependencies.every(id => tasks.some(d => d.id === id && d.status === 'approved')));
    return '<div class="view-heading"><div><div class="eyebrow">TASK DEPENDENCIES</div><h2>Luồng việc</h2><p>Sơ đồ được dựng từ phụ thuộc của phiên. Bấm một task để xem chi tiết.</p></div><span class="view-count">' + ready.length + ' task sẵn sàng</span></div>' +
      '<div class="flow-legend">' + Object.keys(statusNames).map(status).join('') + '<small>Đường xanh: phụ thuộc đã được duyệt</small></div>' +
      '<div class="dag-scroll"><svg class="dag" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '" role="group" aria-label="Sơ đồ phụ thuộc công việc"><defs><marker id="flowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8"/></marker></defs>' + columns.map((col, i) => '<text class="dag-stage" x="' + (25 + i * 190) + '" y="25">BƯỚC ' + (i + 1) + '</text>').join('') + edges + nodes + '</svg></div>' +
      '<div class="workflow-gates"><h3>Cửa duyệt & phụ thuộc</h3>' + tasks.map(task => {
        const missing = task.dependencies.filter(id => !tasks.some(dep => dep.id === id && dep.status === 'approved'));
        return '<button class="gate-row" data-action="task" data-id="' + esc(task.id) + '"><span>' + esc(task.title) + '</span>' + status(task.status) + '<small>' + esc(missing.length ? 'Chờ: ' + missing.join(', ') : task.dependencies.length ? '✓ Đã mở khóa phụ thuộc' : 'Không có phụ thuộc') + '</small></button>';
      }).join('') + '</div><p class="stats-note">Đề xuất file/plan chưa được xử lý sẽ chặn duyệt task. Model có thể làm song song; lệnh chỉnh AE chạy tuần tự.</p>';
  }
  function stats(ctx) {
    const tasks = ctx.session?.tasks || []; const sum = key => tasks.reduce((n, t) => n + (Number(t[key]) || 0), 0);
    const input = sum('inputTokens'), output = sum('outputTokens'); const maxTokens = Math.max(1, ...ctx.roles.map(r => tasks.filter(t => t.roleId === r.id).reduce((n, t) => n + t.inputTokens + t.outputTokens, 0)));
    const counts = Object.fromEntries(Object.keys(statusNames).map(id => [id, tasks.filter(t => t.status === id).length]));
    const measured = tasks.filter(t => t.startedAt && t.finishedAt && t.finishedAt >= t.startedAt);
    const totalDuration = measured.reduce((n, t) => n + t.finishedAt - t.startedAt, 0);
    const roleRows = ctx.roles.map(role => {
      const owned = tasks.filter(t => t.roleId === role.id); const total = key => owned.reduce((n, t) => n + (Number(t[key]) || 0), 0);
      return { role, owned, requests: total('requestCount'), input: total('inputTokens'), output: total('outputTokens') };
    });
    return '<div class="view-heading"><div><div class="eyebrow">SESSION ANALYTICS</div><h2>Thống kê</h2><p>Usage do API trả về và tiến độ được ghi nhận của phiên đang chọn.</p></div><span class="view-count">' + (ctx.session?.demo ? 'DEMO · Không phát sinh request' : ctx.session ? esc(ctx.session.name) : 'Chưa có phiên') + '</span></div>' +
      '<div class="stats-summary">' + metric('Requests', number(sum('requestCount')), 'Tổng request / lượt CLI được báo') + metric('Input tokens', number(input), 'Gồm cache khi provider báo') + metric('Output tokens', number(output)) + metric('Đã duyệt', counts.approved + ' / ' + tasks.length, tasks.length ? Math.round(counts.approved / tasks.length * 100) + '% task' : 'Chưa có task') + '</div>' +
      '<div class="analytics-grid"><section class="chart-panel"><h3>Token theo vai trò</h3><div class="chart-legend"><span>● Input</span><span>● Output</span></div><svg class="token-chart" viewBox="0 0 620 ' + (roleRows.length * 40 + 20) + '" role="img" aria-label="Biểu đồ input và output token theo vai trò">' + roleRows.map((row, i) => {
        const x = 170, y = 12 + i * 40; const inputWidth = row.input / maxTokens * 340, outputWidth = row.output / maxTokens * 340;
        return '<text x="0" y="' + (y + 17) + '">' + esc(row.role.name) + '</text><rect class="chart-track" x="' + x + '" y="' + y + '" width="340" height="24" rx="4"/><rect class="chart-input" x="' + x + '" y="' + y + '" width="' + inputWidth + '" height="24"/><rect class="chart-output" x="' + (x + inputWidth) + '" y="' + y + '" width="' + outputWidth + '" height="24"/><text class="chart-number" x="610" y="' + (y + 17) + '" text-anchor="end">' + number(row.input + row.output) + '</text>';
      }).join('') + '</svg></section><section class="chart-panel"><h3>Phân bố công việc</h3><div class="status-distribution">' + Object.entries(counts).map(([id, count]) => '<div><span>' + status(id) + '</span><strong>' + count + '</strong><svg preserveAspectRatio="none" viewBox="0 0 100 5" aria-hidden="true"><rect class="distribution-track" width="100" height="5" rx="2"/><rect class="distribution-' + id + '" width="' + (tasks.length ? count / tasks.length * 100 : 0) + '" height="5" rx="2"/></svg></div>').join('') + '</div></section></div>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>VAI TRÒ / MODEL</th><th class="number">REQUESTS</th><th class="number">INPUT</th><th class="number">OUTPUT</th><th class="number">ĐÃ DUYỆT / TASKS</th></tr></thead><tbody>' + roleRows.map(row => '<tr><td>' + esc(row.role.name) + '<div class="model">' + esc([...new Set(row.owned.filter(t => t.model).map(t => t.model))].join(', ') || row.role.model) + '</div></td><td class="number">' + number(row.requests) + '</td><td class="number">' + number(row.input) + '</td><td class="number">' + number(row.output) + '</td><td class="number">' + row.owned.filter(t => t.status === 'approved').length + ' / ' + row.owned.length + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="stats-summary secondary-metrics">' + metric('Thời gian task đã ghi', measured.length ? duration(totalDuration) : 'Chưa có', 'Cộng thời gian từng task; có thể chạy song song') + metric('Lần thử model', sum('attempts'), 'Không phải số lần chỉnh AE') + metric('Plan AE thành công', ctx.plans.filter(p => p.state === 'success').length + ' / ' + ctx.plans.length) + metric('Plan cần kiểm tra', ctx.plans.filter(p => p.state === 'uncertain').length) + '</div>' +
      budgetPanel(ctx.usage) +
      '<p class="stats-note">Không cộng ảnh vào token hội thoại. Không có usage được báo thì hiển thị 0; dữ liệu demo không tạo usage giả.</p>';
  }
  // Session budget and cost: calls/tokens include member/QA chats; cost only from prices the CEO entered.
  function budgetPanel(usage) {
    if (!usage) return '';
    const limit = (used, max) => max ? number(used) + ' / ' + number(max) : number(used);
    const share = (used, max) => max ? Math.min(100, Math.round(used / max * 100)) + '% ngân sách' : 'Không giới hạn';
    const cost = usage.priced ? '$' + usage.cost.toFixed(4) : 'Chưa có giá';
    return '<div class="stats-summary secondary-metrics">' + metric('Lượt gọi phiên', limit(usage.calls, usage.budget?.maxCalls), share(usage.calls, usage.budget?.maxCalls)) +
      metric('Token phiên', limit(usage.tokens, usage.budget?.maxTokens), share(usage.tokens, usage.budget?.maxTokens)) +
      metric('Chi phí ước tính', cost, usage.priced ? (usage.unpriced ? usage.unpriced + ' mục chưa có giá · chưa đầy đủ' : 'Theo bảng giá đã nhập') : 'Nhập bảng giá trong Proxy & model') + '</div>';
  }
  window.AETeamViews = { results, timeline, workflow, stats };
})();

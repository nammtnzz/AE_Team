import { createHash } from 'node:crypto';
import type { Check, Criterion, Proposal, Session, Task, TeamConfig } from './core';
import type { ToolDefinition } from './gateway';

// PO → engineer delegation rules, patch proposals, acceptance checks, budget and delivery report.
// Adapted from ai-studio-team (plan/patches/usage/delivery) to AE_CodexTeam's review-first rules:
// nothing here writes files, dispatches AE jobs or retries a request.

const CRITERION_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const VERIFICATIONS = ['analysis', 'file', 'ae'] as const;

export interface Delegation { roleId: string; title: string; prompt: string; scope: string[]; acceptance: Criterion[]; }

/** Scope entry: a workspace-relative file/folder, or `comp:<name>` for an AE composition. */
export function normalizeScope(item: unknown): string {
  if (typeof item !== 'string') throw new Error('Phạm vi phải là chuỗi.');
  const value = item.trim();
  if (/^comp:/i.test(value)) {
    const name = value.slice(5).trim();
    if (!name || name.length > 150) throw new Error('Phạm vi comp cần dạng comp:<tên comp> (1–150 ký tự).');
    return 'comp:' + name;
  }
  const clean = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!clean || clean === '.' || clean.length > 200 || clean.includes('\0') || /^[a-z]:|^\//i.test(clean) || clean.split('/').includes('..'))
    throw new Error('Phạm vi "' + value.slice(0, 80) + '" phải là đường dẫn tương đối trong workspace hoặc comp:<tên>.');
  return clean;
}

/** Validates PO's delegate_task arguments; errors are specific so PO can fix them in its next turn. */
export function validateDelegation(args: any): Delegation {
  if (!args || typeof args !== 'object') throw new Error('delegate_task cần object đối số.');
  if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 150 || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 10000)
    throw new Error('Subagent cần tiêu đề 1–150 ký tự và yêu cầu 1–10.000 ký tự.');
  const rawScope = args.scope ?? [];
  if (!Array.isArray(rawScope) || rawScope.length > 20) throw new Error('scope là mảng tối đa 20 đường dẫn/comp.');
  const scope = [...new Set(rawScope.map(normalizeScope))];
  const rawAcceptance = args.acceptance ?? [];
  if (!Array.isArray(rawAcceptance) || rawAcceptance.length > 12) throw new Error('acceptance là mảng tối đa 12 tiêu chí.');
  const ids = new Set<string>();
  const acceptance = rawAcceptance.map((item: any): Criterion => {
    if (!item || typeof item.id !== 'string' || !CRITERION_ID.test(item.id) || ids.has(item.id))
      throw new Error('Tiêu chí cần id dạng chữ thường/số/-/_ (tối đa 40 ký tự) và không trùng.');
    if (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 2000)
      throw new Error('Tiêu chí ' + item.id + ' cần description 1–2000 ký tự.');
    if (!VERIFICATIONS.includes(item.verification)) throw new Error('Tiêu chí ' + item.id + ': verification phải là analysis, file hoặc ae.');
    ids.add(item.id);
    return { id: item.id, description: item.description.trim(), verification: item.verification };
  });
  return { roleId: String(args.roleId), title: args.title.trim(), prompt: args.prompt.trim(), scope, acceptance };
}

const fileScope = (scope: string[]) => scope.filter(s => !s.startsWith('comp:'));
const within = (file: string, base: string) => file.toLowerCase() === base.toLowerCase() || file.toLowerCase().startsWith(base.toLowerCase() + '/');

/** Empty scope = unrestricted. A scope without file entries allows no file proposals. */
export function inScope(file: string, scope: string[] | undefined): boolean {
  if (!scope?.length) return true;
  return fileScope(scope).some(base => within(file, base));
}
/** Two delegations conflict when they share a comp or one file scope contains the other. */
export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some(left => b.some(right => left.startsWith('comp:') || right.startsWith('comp:') ?
    left.toLowerCase() === right.toLowerCase() : within(left, right) || within(right, left)));
}

/** Applies exact, unique oldText → newText edits; the model never resends a whole large file. */
export function applyEdits(content: string, edits: unknown): string {
  if (!Array.isArray(edits) || !edits.length || edits.length > 20) throw new Error('propose_patch cần 1–20 edits.');
  for (const edit of edits as any[]) {
    if (!edit || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string' || edit.oldText.length + edit.newText.length > 80000)
      throw new Error('Mỗi edit cần oldText (không rỗng) và newText, tổng tối đa 80.000 ký tự.');
    const index = content.indexOf(edit.oldText);
    if (index < 0) throw new Error('Không tìm thấy oldText trong file. Đọc lại file và chép đúng đoạn gốc.');
    if (content.indexOf(edit.oldText, index + 1) >= 0) throw new Error('oldText xuất hiện nhiều lần. Thêm ngữ cảnh để đoạn gốc là duy nhất.');
    content = content.slice(0, index) + edit.newText + content.slice(index + edit.oldText.length);
  }
  return content;
}

export interface VerifiedCheck extends Criterion { status: Check['status'] | 'missing'; evidence: string; verified: boolean; }
/** Self-reported checks only count as verified with matching evidence; a tick alone proves nothing. */
export function verifyChecks(task: Task, proposals: Proposal[]): VerifiedCheck[] {
  return (task.acceptance || []).map(criterion => {
    const check = task.checks?.find(c => c.id === criterion.id);
    let verified = false;
    if (check?.status === 'pass') {
      if (criterion.verification === 'analysis') verified = check.evidence.trim().length >= 10;
      if (criterion.verification === 'file') verified = Boolean(check.path && proposals.some(p => p.taskId === task.id && p.path.toLowerCase() === check.path!.replace(/\\/g, '/').toLowerCase()));
      if (criterion.verification === 'ae') verified = Boolean(check.callId && task.toolLog?.some(e => e.id === check.callId && e.name === 'aect_read' && e.ok));
    }
    return { ...criterion, status: check?.status || 'missing', evidence: (check?.evidence || '').slice(0, 500), verified };
  });
}
export function validateChecks(task: Task, value: unknown): Check[] {
  if (!task.acceptance?.length) throw new Error('Task này không có tiêu chí nghiệm thu.');
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error('checks là mảng 1–12 mục.');
  return value.map((item: any) => {
    if (!item || !task.acceptance!.some(c => c.id === item.id)) throw new Error('Không có tiêu chí id ' + String(item?.id) + '.');
    if (!['pass', 'fail', 'blocked'].includes(item.status)) throw new Error('status phải là pass, fail hoặc blocked.');
    if (typeof item.evidence !== 'string' || !item.evidence.trim() || item.evidence.length > 2000) throw new Error('evidence cần 1–2000 ký tự.');
    return { id: item.id, status: item.status, evidence: item.evidence.trim(),
      ...(typeof item.callId === 'string' ? { callId: item.callId.slice(0, 120) } : {}),
      ...(typeof item.path === 'string' ? { path: item.path.slice(0, 260) } : {}) };
  });
}

// ---- Budget & cost (usage reported by the API only; nothing is estimated when usage is missing) ----
export function sessionUsage(session: Session) {
  const calls = session.tasks.reduce((n, t) => n + t.requestCount, 0) + (session.chatUsage?.calls || 0);
  const input = session.tasks.reduce((n, t) => n + t.inputTokens, 0) + (session.chatUsage?.inputTokens || 0);
  const output = session.tasks.reduce((n, t) => n + t.outputTokens, 0) + (session.chatUsage?.outputTokens || 0);
  return { calls, input, output, tokens: input + output };
}
export function budgetExceeded(config: TeamConfig, session: Session): string | undefined {
  const usage = sessionUsage(session), budget = config.budget;
  if (budget?.maxCalls && usage.calls >= budget.maxCalls) return 'Đã chạm ngân sách ' + budget.maxCalls + ' lượt gọi của phiên. Tăng ngân sách trong Proxy & model rồi Tiếp tục.';
  if (budget?.maxTokens && usage.tokens >= budget.maxTokens) return 'Đã chạm ngân sách ' + budget.maxTokens + ' token của phiên. Tăng ngân sách trong Proxy & model rồi Tiếp tục.';
}
export class BudgetHold extends Error {}
/** Cost from configured prices per task model; chat usage has no per-model split so it stays unpriced. */
export function estimateCost(config: TeamConfig, session: Session) {
  let cost = 0, unpriced = 0;
  for (const task of session.tasks) {
    if (!task.inputTokens && !task.outputTokens) continue;
    const price = config.prices?.[task.model || ''];
    if (!price) { unpriced++; continue; }
    cost += (task.inputTokens * price.input + task.outputTokens * price.output) / 1e6;
  }
  if (session.chatUsage?.calls) unpriced++;
  return { cost, unpriced };
}

// ---- Delivery report for a PO task ----
export interface PlanState { id: string; title: string; taskId?: string; state: string; }
export function deliveryReport(session: Session, task: Task, plans: PlanState[]) {
  const children = session.tasks.filter(t => t.parentTaskId === task.id);
  const owned = new Set([task.id, ...children.map(t => t.id)]);
  const files = session.proposals.filter(p => owned.has(p.taskId)).map(p => ({ path: p.path, taskId: p.taskId, state: p.applied ? 'applied' : 'proposed' }));
  const aePlans = plans.filter(p => owned.has(p.taskId || '')).map(p => ({ title: p.title, taskId: p.taskId, state: p.state }));
  const checks = children.flatMap(child => verifyChecks(child, session.proposals).map(c => ({ ...c, taskId: child.id, title: child.title })));
  const incomplete = [
    ...children.filter(t => t.status !== 'approved').map(t => ({ title: t.title, detail: t.error || t.status })),
    ...checks.filter(c => !c.verified).map(c => ({ title: c.title, detail: c.description + ' · ' + (c.status === 'pass' ? 'pass nhưng thiếu bằng chứng khớp' : c.status) })),
    ...files.filter(f => f.state === 'proposed').map(f => ({ title: f.path, detail: 'đề xuất file chưa áp dụng' })),
    ...aePlans.filter(p => !['success', 'dismissed'].includes(p.state)).map(p => ({ title: p.title, detail: 'plan AE ' + p.state }))
  ];
  return { taskId: task.id, engineers: children.map(t => ({ taskId: t.id, roleId: t.roleId, title: t.title, status: t.status })),
    files, aePlans, checks, incomplete, ready: !incomplete.length };
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const TEAM_TOOLS: ToolDefinition[] = [
  { name: 'propose_patch', description: 'Đề xuất sửa file đã có bằng các đoạn thay thế chính xác (oldText duy nhất → newText). Rẻ hơn propose_file cho file lớn. Người dùng xem diff và áp dụng.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' },
      edits: { type: 'array', maxItems: 20, items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['oldText', 'newText'], additionalProperties: false } } },
    required: ['path', 'edits', 'reason'], additionalProperties: false } },
  { name: 'report_checks', description: 'Kỹ sư báo kết quả từng tiêu chí nghiệm thu trước khi bàn giao. ae: ghi callId của lần aect_read thành công; file: ghi path của file đã đề xuất; analysis: nêu bằng chứng cụ thể.',
    parameters: { type: 'object', properties: { checks: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
      id: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'blocked'] }, evidence: { type: 'string' }, callId: { type: 'string' }, path: { type: 'string' } },
      required: ['id', 'status', 'evidence'], additionalProperties: false } } }, required: ['checks'], additionalProperties: false } },
  { name: 'inspect_proposal', description: 'PO đọc nội dung một đề xuất file hoặc plan AE của kỹ sư khi cần kiểm tra (mặc định PO chỉ nhận tóm tắt, kích thước và SHA-256).',
    parameters: { type: 'object', properties: { proposalId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['proposalId'], additionalProperties: false } },
  { name: 'read_subagent_result', description: 'PO đọc tiếp phần kết quả đầy đủ của một kỹ sư khi bản tóm tắt chưa đủ.',
    parameters: { type: 'object', properties: { taskId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['taskId'], additionalProperties: false } }
];

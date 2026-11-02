import type { ImageWork, RoleChat, Task } from './core';

export interface WorkIndicator {
  state: 'running' | 'done' | 'idle' | 'blocked' | 'stopped';
  label: string;
  detail: string;
}
export interface WorkInput {
  sessionId?: string;
  sessionState?: string;
  tasks?: Task[];
  chatBusy?: { roleId: string; sessionId: string }[];
  roleChats?: RoleChat[];
  imageWork?: ImageWork[];
}

// Execution completion is distinct from approval. This selector never changes tasks.
export function roleWorkState(roleId: string, input: WorkInput): WorkIndicator {
  const sessionId = input.sessionId || '';
  const tasks = (input.tasks || []).filter(t => t.roleId === roleId);
  const chat = (input.roleChats || []).find(c => c.roleId === roleId && c.sessionId === sessionId);
  const user = chat?.messages.filter(m => m.role === 'user').at(-1);
  const image = roleId === 'image' ? (input.imageWork || []).find(w => w.sessionId === sessionId) : undefined;
  const busy = (input.chatBusy || []).some(c => c.roleId === roleId && c.sessionId === sessionId);
  if (tasks.some(t => t.status === 'running') || busy || image?.status === 'running') {
    return { state: 'running', label: 'Đang xử lý', detail: 'Đang thực hiện yêu cầu. Chưa có phần trăm tiến độ thực tế.' };
  }
  const failure = tasks.find(t => t.status === 'blocked');
  if (failure) return { state: 'blocked', label: 'Cần xử lý', detail: failure.error || 'Tác vụ đang gặp lỗi hoặc bị chặn.' };

  // A later failed/stopped request must never reuse an earlier successful result.
  const taskAt = Math.max(0, ...tasks.map(t => Math.max(t.finishedAt || 0, t.startedAt || 0)));
  if (image && image.at >= taskAt) {
    if (image.status === 'failed') return { state: 'blocked', label: 'Cần xử lý', detail: image.error || 'Tạo ảnh chưa thành công.' };
    if (image.status === 'stopped') return { state: 'stopped', label: 'Đã dừng', detail: image.error || 'Đã dừng tạo ảnh.' };
  }
  if (user && user.at >= taskAt && roleId !== 'image') {
    if (user.delivery === 'failed') return { state: 'blocked', label: 'Cần xử lý', detail: user.error || 'Chưa nhận được câu trả lời.' };
    if (['stopped', 'interrupted', 'pending'].includes(user.delivery || '')) {
      return { state: 'stopped', label: 'Đã dừng', detail: user.error || 'Yêu cầu chưa hoàn tất. Không tự gửi lại.' };
    }
  }
  if (tasks.length) {
    const completed = tasks.filter(t => t.status === 'review' || t.status === 'approved').length;
    if (completed === tasks.length) {
      const review = tasks.filter(t => t.status === 'review').length;
      return { state: 'done', label: 'Xong', detail: review ? `${review} tác vụ có kết quả · Chờ duyệt` : `${completed} tác vụ đã duyệt` };
    }
    if (input.sessionState === 'paused' && tasks.some(t => t.status === 'assigned' && t.startedAt)) {
      return { state: 'stopped', label: 'Đã dừng', detail: 'Tác vụ đã tạm dừng · Chưa hoàn tất' };
    }
    return { state: 'idle', label: 'Chờ việc', detail: `${completed}/${tasks.length} tác vụ có kết quả · Còn việc chưa chạy` };
  }
  if (image?.status === 'done') return { state: 'done', label: 'Xong', detail: 'Đã tạo và kiểm tra file ảnh.' };
  if (roleId !== 'image' && user?.delivery === 'answered') return { state: 'done', label: 'Xong', detail: 'Đã trả lời câu hỏi hoặc góp ý.' };
  return { state: 'idle', label: 'Chờ việc', detail: roleId === 'image' && user?.delivery === 'recorded' ? 'Đã lưu góp ý · Chưa tạo ảnh' : 'Chưa có tác vụ đang thực hiện.' };
}

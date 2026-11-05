import type { Role, Task } from './core';

// Seats belong to role IDs, not to the order of configurable model cards.
export const OFFICE_SEATS = [
  { roleId: 'lead', x: 0, z: -5.9, rotation: Math.PI, head: true },
  { roleId: 'architect', x: -4.6, z: -1.8, rotation: 0, head: false },
  { roleId: 'gameplay', x: 4.6, z: -1.8, rotation: 0, head: false },
  { roleId: 'camera_ui', x: -4.6, z: 2.35, rotation: 0, head: false },
  { roleId: 'sfx_vfx', x: 4.6, z: 2.35, rotation: 0, head: false },
  { roleId: 'art', x: -4.6, z: 6.5, rotation: 0, head: false },
  { roleId: 'reviewer', x: 4.6, z: 6.5, rotation: 0, head: false },
  { roleId: 'image', x: -4.6, z: -5.7, rotation: 0, head: false },
  { roleId: 'qa', x: 4.6, z: -5.7, rotation: 0, head: false },
  { roleId: 'learn', x: -4.6, z: 10.65, rotation: 0, head: false }
] as const;

export const OFFICE_STATUS = {
  idle: 'Sẵn sàng', assigned: 'Được giao', running: 'Đang làm',
  review: 'Chờ review', approved: 'Đã duyệt', blocked: 'Cần xử lý'
};

export function officeActivity(role: Role, allTasks: Task[], demo: boolean, previewMotion: boolean) {
  const tasks = allTasks.filter(t => t.roleId === role.id);
  const task = tasks.find(t => t.status === 'running') || tasks.find(t => t.status === 'blocked') ||
    tasks.find(t => t.status === 'review') || tasks.find(t => t.status === 'assigned') || tasks.at(-1);
  const status: Task['status'] | 'idle' = task?.status || 'idle';
  const completed = tasks.filter(t => t.status === 'approved').length;
  const waiting = status === 'assigned' && task?.dependencies.some(id => !allTasks.some(t => t.id === id && t.status === 'approved'));
  return {
    task, status, completed, total: tasks.length,
    progress: tasks.length ? completed / tasks.length : 0,
    label: waiting ? 'Chờ phụ thuộc' : OFFICE_STATUS[status],
    actualRunning: status === 'running',
    preview: demo && previewMotion && status !== 'blocked',
    moving: status === 'running' || (demo && previewMotion && status !== 'blocked')
  };
}

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ToolDefinition } from './gateway';

// AE production text: notes, data, subtitles and scripts. Unity asset formats from the old preset are no longer listed;
// .jsx/.jsxbin stay out because AE changes must go through installed functions, never generated JSX.
const ignored = new Set(['.git', 'node_modules', 'Logs', 'Build', 'Builds', '.ae-team', '.p0-team', '.ae-codex', '.codex', '.vs', 'dist', 'Adobe After Effects Auto-Save']);
const textExtensions = new Set(['.cs', '.json', '.md', '.txt', '.yaml', '.yml', '.csv', '.tsv', '.srt', '.vtt', '.ts', '.js', '.html', '.css', '.xml', '.gitignore']);
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function allowedFile(file: string): boolean {
  const base = path.basename(file);
  return !/(^\.env($|\.)|credential|secret|token|password|^id_rsa|\.pem$|\.key$|\.pfx$)/i.test(base) &&
    (textExtensions.has(path.extname(base).toLowerCase()) || ['AGENTS.md', 'CLAUDE.md', '.gitignore'].includes(base));
}
export async function safePath(root: string, relative: string): Promise<string> {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) ||
    /^[a-z]:|^[/\\]|(^|[/\\])\.\.([/\\]|$)/i.test(relative)) throw new Error('Đường dẫn phải nằm trong workspace.');
  const segments = relative.split(/[/\\]/);
  if (segments.some(p => ignored.has(p))) throw new Error('Thư mục này bị loại khỏi phạm vi công cụ.');
  const canonicalRoot = await fs.realpath(root);
  const target = path.resolve(canonicalRoot, relative);
  let current = target;
  while (true) {
    try {
      const actual = await fs.realpath(current);
      const diff = path.relative(canonicalRoot, actual);
      if (diff.startsWith('..') || path.isAbsolute(diff)) throw new Error('Symlink nằm ngoài workspace.');
      break;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  return target;
}
export async function readText(root: string, relative: string): Promise<string> {
  if (!allowedFile(relative)) throw new Error('Chỉ đọc file văn bản của dự án; loại trừ file bí mật.');
  const file = await safePath(root, relative);
  if ((await fs.stat(file)).size > 220000) throw new Error('File quá lớn. Chọn file nhỏ hơn 220 KB.');
  return fs.readFile(file, 'utf8');
}
export async function listFiles(root: string, relative = '.', limit = 200): Promise<string[]> {
  const directory = relative === '.' ? root : await safePath(root, relative);
  const result: string[] = [];
  let visited = 0;
  async function walk(dir: string): Promise<void> {
    if (result.length >= limit || visited++ > 1000) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length >= limit) break;
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (allowedFile(file)) result.push(path.relative(root, file).replace(/\\/g, '/'));
    }
  }
  await walk(directory); return result;
}
export const TOOLS: ToolDefinition[] = [
  { name: 'delegate_task', description: 'PO giao một việc riêng cho một kỹ sư (mỗi kỹ sư tối đa một việc trong task này); ứng dụng gọi model của kỹ sư, kỹ sư làm ngay và trả kết quả thẳng về PO, không chờ CEO duyệt. Nhiều lời gọi trong cùng một lượt chạy song song. Một cấp; không sửa file hay thực thi AE trực tiếp. Không gọi lại để retry việc lỗi.',
    parameters: { type: 'object', properties: { roleId: { type: 'string', enum: ['architect', 'gameplay', 'camera_ui', 'sfx_vfx', 'art', 'reviewer'] },
      title: { type: 'string', maxLength: 150 }, prompt: { type: 'string', maxLength: 10000 },
      scope: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'File/thư mục tương đối hoặc comp:<tên comp> kỹ sư được đề xuất thay đổi. Việc trùng phạm vi chạy lần lượt.' },
      acceptance: { type: 'array', maxItems: 12, description: 'Tiêu chí nghiệm thu. verification: ae = cần kết quả aect_read thành công, file = cần đề xuất file, analysis = phân tích có bằng chứng.',
        items: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' }, verification: { type: 'string', enum: ['analysis', 'file', 'ae'] } }, required: ['id', 'description', 'verification'], additionalProperties: false } } },
      required: ['roleId', 'title', 'prompt'], additionalProperties: false } },
  { name: 'list_files', description: 'Liệt kê tối đa 200 file văn bản trong workspace, bỏ thư mục build và bí mật.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Thư mục tương đối, mặc định .' } }, additionalProperties: false } },
  { name: 'read_file', description: 'Đọc một file văn bản trong workspace (tối đa 220 KB).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'search_text', description: 'Tìm chuỗi literal trong các file văn bản, tối đa 40 kết quả.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'propose_file', description: 'Đề xuất nội dung HOÀN CHỈNH của file để người dùng xem diff và áp dụng. Không trực tiếp sửa file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } },
      required: ['path', 'content', 'reason'], additionalProperties: false } }
];

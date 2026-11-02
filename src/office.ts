import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Role, Task } from './core';
import { OFFICE_SEATS, officeActivity } from './office-model';
import { roleWorkState, type WorkIndicator } from './work-status';

interface OfficeState { roles: Role[]; tasks: Task[]; selectedRole: string; demo?: boolean; previewMotion?: boolean; workStatuses?: Record<string, WorkIndicator>; }
interface OfficeController {
  update(state: OfficeState): void;
  setActive(value: boolean): void;
  camera(mode: 'iso' | 'top' | 'front'): void;
  dispose(): void;
}
declare global { interface Window { AETeamOffice: (host: HTMLElement, onPick: (id: string) => void) => OfficeController; } }

window.AETeamOffice = (host, onPick) => {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Studio AE Team 3D. Điều phối ở đầu phòng, sáu chuyên gia theo hai dãy. Kéo để xoay, cuộn để zoom.');
  canvas.setAttribute('role', 'img');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x111722);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Cache one static shadow pass; small typing/nodding motions do not rebuild it.
  renderer.shadowMap.autoUpdate = false;
  host.prepend(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 120);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false; controls.enablePan = false;
  controls.minDistance = 22; controls.maxDistance = 48;
  controls.minPolarAngle = 0.05; controls.maxPolarAngle = Math.PI * 0.45;
  scene.add(new THREE.HemisphereLight(0xdbe8ff, 0x3c3649, 2.1));
  const sun = new THREE.DirectionalLight(0xffecd3, 3.8); sun.position.set(-8, 18, 10);
  sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 48 });
  sun.shadow.normalBias = 0.04; scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa3c5ff, 1.5); fill.position.set(10, 7, -6); scene.add(fill);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
  const cone = new THREE.ConeGeometry(1, 1, 9);
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const textures: THREE.Texture[] = [];
  const material = (color: number) => {
    if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.78 }));
    return materials.get(color)!;
  };
  const mesh = (parent: THREE.Object3D, shape: THREE.BufferGeometry, color: number, p: number[], size: number[], shadow = true) => {
    const object = new THREE.Mesh(shape, material(color)); object.position.set(...p as [number, number, number]);
    object.scale.set(...size as [number, number, number]); object.castShadow = shadow; object.receiveShadow = true; parent.add(object); return object;
  };
  const box = (g: THREE.Object3D, c: number, p: number[], s: number[], shadow = true) => mesh(g, cube, c, p, s, shadow);
  const round = (g: THREE.Object3D, c: number, p: number[], s: number[]) => mesh(g, cylinder, c, p, s);
  const surface = (width = 512, height = 288) => {
    const el = document.createElement('canvas'); el.width = width; el.height = height;
    const ctx = el.getContext('2d'); if (!ctx) throw new Error('Canvas 2D không khả dụng.');
    const texture = new THREE.CanvasTexture(el); texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); textures.push(texture);
    return { ctx, texture };
  };
  const textScreen = (parent: THREE.Object3D, p: number[], size: number[]) => {
    const image = surface();
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ map: image.texture }));
    panel.position.set(...p as [number, number, number]); parent.add(panel); return image;
  };
  // Architectural frame, central aisle and a raised command position at the head.
  box(scene, 0x293344, [0, -0.3, 0], [20, 0.6, 19], false);
  box(scene, 0x737c8a, [0, 0.025, 0], [19.8, 0.06, 18.8], false);
  for (let x = -9; x <= 9; x++) box(scene, x % 2 ? 0x67717f : 0x86909b, [x, 0.063, 0], [0.014, 0.01, 18.7], false);
  box(scene, 0x434c60, [0, 1.9, -9.5], [20, 3.9, 0.2], false);
  box(scene, 0x343e51, [-10, 1.25, 0], [0.18, 2.7, 19], false);
  box(scene, 0x9184c0, [0, 0.27, -5.9], [5.2, 0.4, 3.9], false);
  box(scene, 0x374457, [0, 0.5, -5.9], [5.25, 0.1, 3.95], false);
  box(scene, 0xada1dc, [0, 0.22, -3.68], [3.6, 0.3, 0.5], false);
  box(scene, 0x4c5669, [0, 0.075, 3.2], [2.8, 0.035, 11.2], false);
  for (const x of [-1.48, 1.48]) box(scene, 0xa597c3, [x, 0.105, 3.2], [0.04, 0.02, 11.1], false);
  for (let z = -1.8; z < 8; z += 2) box(scene, 0x94a2b6, [0, 0.105, z], [0.09, 0.02, 0.55], false);
  for (const x of [-7, 7]) {
    box(scene, 0xb4c3d3, [x, 2.2, -9.34], [3.7, 2, 0.08], false);
    box(scene, 0x86a8bf, [x, 2.2, -9.28], [3.45, 1.78, 0.04], false);
    box(scene, 0x465469, [x, 2.2, -9.22], [0.08, 1.85, 0.06], false);
    box(scene, 0x465469, [x, 2.2, -9.22], [3.5, 0.08, 0.06], false);
  }
  box(scene, 0x192431, [0, 2.55, -9.27], [7.7, 2.15, 0.2], false);
  const commandScreen = textScreen(scene, [0, 2.55, -9.15], [7.4, 1.9]);
  box(scene, 0x333d4f, [-8.7, 0.85, 4.9], [1.15, 1.7, 3.8]);
  for (let y = 0.25; y < 1.8; y += 0.6) {
    box(scene, 0x99a8b4, [-8.65, y, 4.9], [1.25, 0.09, 3.8]);
    for (let z = 3.5; z < 6.4; z += 0.45) box(scene, [0xa697cd, 0xd8aa76, 0x76b4ac][Math.round(z * 10) % 3], [-8.5, y + 0.2, z], [0.6, 0.35, 0.22]);
  }
  box(scene, 0x323e4c, [8.55, 0.65, 6.8], [1.5, 1.2, 3]);
  box(scene, 0xb9a897, [8.55, 1.3, 6.8], [1.7, 0.16, 3.15]);
  box(scene, 0x222b37, [8.55, 1.72, 6.3], [0.65, 0.75, 0.65]);
  round(scene, 0xe3d6c3, [8.5, 1.5, 7.2], [0.14, 0.22, 0.14]);
  const plant = (x: number, z: number) => {
    round(scene, 0xb7ab9d, [x, 0.35, z], [0.38, 0.6, 0.38]);
    for (let i = 0; i < 5; i++) {
      const leaf = mesh(scene, cone, i % 2 ? 0x65a38c : 0x407a69, [x + Math.sin(i * 2) * 0.22, 1 + i % 2 * 0.2, z + Math.cos(i * 2) * 0.22], [0.32, 1.2, 0.32]);
      leaf.rotation.z = Math.sin(i) * 0.35;
    }
  };
  plant(-8.6, -7.8); plant(8.6, -7.8); plant(-8.3, 8.1); plant(8.7, 2.3);

  const stations = OFFICE_SEATS.map((seat, index) => {
    const group = new THREE.Group(); group.position.set(seat.x, seat.head ? 0.52 : 0, seat.z); group.rotation.y = seat.rotation; scene.add(group);
    const accent = new THREE.MeshStandardMaterial({ color: 0x9280b3, roughness: 0.75 });
    const rug = new THREE.Mesh(cube, accent); rug.position.set(0, 0.09, 0.2); rug.scale.set(seat.head ? 4.25 : 3.7, 0.025, 3.2); rug.receiveShadow = true; group.add(rug);
    const deskWidth = seat.head ? 3.8 : 3.05;
    box(group, 0xd1baa0, [0, 1.08, -0.25], [deskWidth, 0.18, 1.5]);
    box(group, 0x263440, [0, 0.95, -0.25], [deskWidth - 0.1, 0.08, 1.4]);
    for (const x of [-deskWidth / 2 + 0.25, deskWidth / 2 - 0.25]) for (const z of [-0.8, 0.3]) box(group, 0x3b4756, [x, 0.54, z], [0.11, 1.04, 0.11]);
    box(group, 0x7c8c9a, [0, 1.2, -0.65], [0.6, 0.07, 0.36]);
    box(group, 0x536473, [0, 1.43, -0.68], [0.09, 0.52, 0.09]);
    box(group, 0x14202d, [0, 1.87, -0.68], [seat.head ? 2.45 : 1.85, 1.08, 0.15]);
    const screen = textScreen(group, [0, 1.87, -0.596], [seat.head ? 2.28 : 1.69, 0.92]);
    if (seat.head) {
      box(group, 0x354453, [1.35, 1.43, -0.2], [0.55, 0.4, 0.08]);
      box(group, 0x98b8bf, [1.35, 1.44, -0.15], [0.48, 0.32, 0.015]);
    } else {
      box(group, 0x283441, [-1.12, 0.56, -0.2], [0.34, 0.9, 0.65]);
      box(group, 0xa0b6be, [-1.115, 0.7, 0.14], [0.12, 0.025, 0.015], false);
    }
    const cursor = box(group, 0xb3e9df, [-0.36, 1.87, -0.578], [0.018, 0.56, 0.012], false);
    cursor.visible = false;
    box(group, 0x263744, [0, 1.2, 0.18], [0.95, 0.055, 0.38]);
    for (let row = 0; row < 3; row++) box(group, 0x8f9faa, [0, 1.231, 0.08 + row * 0.1], [0.78, 0.008, 0.018], false);
    round(group, 0x526375, [0.83, 1.2, 0.21], [0.12, 0.07, 0.17]);
    round(group, 0xe8d6bd, [deskWidth / 2 - 0.28, 1.29, -0.45], [0.12, 0.26, 0.12]);
    box(group, 0xdee1db, [-deskWidth / 2 + 0.3, 1.19, -0.22], [0.33, 0.028, 0.5]);
    // Chair, an articulated upper body, forearms and hands resting at the keys.
    round(group, 0x263341, [0, 0.21, 1.2], [0.44, 0.07, 0.44]);
    for (let i = 0; i < 5; i++) {
      const spoke = box(group, 0x3c4b5d, [0, 0.28, 1.2], [0.75, 0.04, 0.07]); spoke.rotation.y = i * Math.PI / 5;
    }
    box(group, 0x647183, [0, 0.52, 1.2], [0.11, 0.5, 0.11]);
    box(group, 0x2c394b, [0, 0.82, 1.2], [0.86, 0.16, 0.85]);
    box(group, 0x314052, [0, 1.21, 1.6], [0.84, 0.8, 0.16]);
    const torso = new THREE.Group(); torso.position.set(0, 0.87, 1.12); group.add(torso);
    const body = new THREE.Mesh(cube, accent); body.position.set(0, 0.39, 0); body.scale.set(0.62, 0.72, 0.43); body.castShadow = true; torso.add(body);
    const skin = [0xe3b898, 0xba856a, 0xd7a17b][index % 3];
    const head = new THREE.Group(); head.position.set(0, 0.99, -0.05); torso.add(head);
    mesh(head, sphere, skin, [0, 0, 0], [0.28, 0.32, 0.27]);
    mesh(head, sphere, [0x302c34, 0x6b4a3f, 0x423f4a][index % 3], [0, 0.19, 0.04], [0.29, 0.17, 0.27]);
    // Face points toward the monitor; the leader's entire station faces the team.
    for (const x of [-0.1, 0.1]) mesh(head, sphere, 0x26313b, [x, 0.02, -0.244], [0.026, 0.025, 0.013], false);
    mesh(head, sphere, skin, [0, -0.035, -0.27], [0.045, 0.055, 0.055]);
    box(head, 0x2c394b, [0, 0.21, 0.025], [0.61, 0.055, 0.08]);
    for (const x of [-0.29, 0.29]) box(head, 0x344554, [x, 0, 0], [0.1, 0.2, 0.18]);
    const arms = [-1, 1].map(side => {
      box(torso, 0x46586b, [side * 0.4, 0.39, -0.1], [0.19, 0.35, 0.2]);
      const arm = new THREE.Group(); arm.position.set(side * 0.39, 1.2, 0.87); group.add(arm);
      const sleeve = box(arm, 0x526779, [0, 0, -0.22], [0.19, 0.18, 0.55]); sleeve.rotation.x = -0.08;
      mesh(arm, sphere, skin, [0, -0.006, -0.54], [0.12, 0.07, 0.14]);
      box(group, 0x2c3b4c, [side * 0.2, 0.54, 0.95], [0.23, 0.65, 0.26]);
      box(group, 0x172634, [side * 0.2, 0.25, 0.76], [0.25, 0.18, 0.47]);
      return arm;
    });
    const beaconMat = new THREE.MeshStandardMaterial({ color: 0x8091a1, emissive: 0x8091a1, emissiveIntensity: 0.3 });
    const beacon = new THREE.Mesh(sphere, beaconMat); beacon.position.set(deskWidth / 2 - 0.25, 1.7, -0.58); beacon.scale.setScalar(0.09); group.add(beacon);
    const progressMat = new THREE.MeshBasicMaterial({ color: 0x97cbbd });
    box(group, 0x273b48, [0, 1.04, 0.515], [deskWidth - 0.5, 0.06, 0.018], false);
    const progress = new THREE.Mesh(cube, progressMat); progress.position.set(0, 1.04, 0.528); progress.scale.set(0, 0.06, 0.018); group.add(progress);
    const outlineMat = new THREE.MeshBasicMaterial({ color: 0xc0a5ff, transparent: true, opacity: 0.8 });
    const selection = new THREE.Group(); selection.position.y = 0.12; group.add(selection);
    for (const z of [-1.4, 1.8]) { const edge = new THREE.Mesh(cube, outlineMat); edge.position.z = z; edge.scale.set(seat.head ? 4.4 : 3.85, 0.025, 0.035); selection.add(edge); }
    for (const x of [seat.head ? -2.18 : -1.91, seat.head ? 2.18 : 1.91]) { const edge = new THREE.Mesh(cube, outlineMat); edge.position.set(x, 0, 0.2); edge.scale.set(0.035, 0.025, 3.2); selection.add(edge); }
    const pickArea = new THREE.Mesh(cube, new THREE.MeshBasicMaterial({ visible: false }));
    pickArea.position.set(0, 1.3, 0.2); pickArea.scale.set(seat.head ? 4.3 : 3.8, 3, 3.2); pickArea.userData.index = index; group.add(pickArea);
    const label = document.createElement('button'); label.className = 'office-label' + (seat.head ? ' office-label-lead' : ''); label.type = 'button';
    const name = document.createElement('strong'), statusLabel = document.createElement('span'); label.append(name, statusLabel);
    const workBar = document.createElement('span'); workBar.className = 'work-indicator office-work-indicator';
    const workLabel = document.createElement('span'); workLabel.className = 'work-label';
    const workTrack = document.createElement('span'); workTrack.className = 'work-track'; workTrack.setAttribute('role', 'progressbar');
    workTrack.setAttribute('aria-valuemin', '0'); workTrack.setAttribute('aria-valuemax', '100');
    const workFill = document.createElement('span'); workFill.className = 'work-fill';
    workTrack.append(workFill); workBar.append(workLabel, workTrack); label.append(workBar);
    label.addEventListener('click', () => onPick(seat.roleId)); host.appendChild(label);
    return { group, seat, accent, screen, cursor, head, torso, arms, beaconMat, pickArea, label, name, statusLabel, workBar, workLabel, workTrack, progress, selection,
      moving: false, running: false, screenKey: '', visible: false, progressWidth: deskWidth - 0.5 };
  });

  const paintWorkScreen = (station: typeof stations[number], role: Role, activity: ReturnType<typeof officeActivity>) => {
    const c = station.screen.ctx; const accent = '#' + new THREE.Color(role.color).getHexString();
    c.fillStyle = '#101c2a'; c.fillRect(0, 0, 512, 288);
    c.fillStyle = '#263447'; c.fillRect(0, 0, 512, 30);
    c.fillStyle = accent; c.font = 'bold 15px Segoe UI'; c.fillText(station.seat.head ? 'TEAM / ĐIỀU PHỐI' : role.shortName.toUpperCase(), 13, 21, 480);
    c.fillStyle = '#1a293a'; c.fillRect(10, 41, 108, 140); c.fillRect(127, 41, 373, 140);
    c.fillStyle = '#8f9cae'; c.font = '12px Segoe UI'; c.fillText('AE • WORKSPACE', 18, 62);
    for (let i = 0; i < 5; i++) { c.fillStyle = i % 2 ? '#7d93a5' : '#56677f'; c.fillRect(20, 76 + i * 18, 63 + i % 3 * 10, 4); }
    if (station.seat.head) {
      for (let i = 0; i < 6; i++) { c.fillStyle = i === 3 ? '#a2657d' : i % 2 ? '#7968a9' : '#5a9b90'; c.fillRect(144 + i % 3 * 113, 58 + Math.floor(i / 3) * 56, 96, 40); }
    } else if (role.id === 'art') {
      ['#b49acb', '#e4c498', '#79b9b0', '#ebdfe9'].forEach((color, i) => { c.fillStyle = color; c.fillRect(153 + i * 81, 60, 65, 98); });
    } else {
      c.fillStyle = accent; c.globalAlpha = 0.85; c.fillRect(242, 57, 115, 101); c.globalAlpha = 1;
      c.strokeStyle = '#dbe6ee'; c.lineWidth = 2; c.strokeRect(228, 66, 142, 82);
      c.fillStyle = '#f2f1f9'; c.font = 'bold 27px Segoe UI'; c.fillText('Ae', 279, 120);
    }
    c.fillStyle = '#202e40'; c.fillRect(10, 192, 490, 64);
    for (let i = 0; i < 4; i++) { c.fillStyle = i % 2 ? '#5b97a1' : accent; c.fillRect(70 + i * 17, 200 + i * 12, 200 + i * 33, 7); }
    c.fillStyle = '#cbd6e2'; c.font = '12px Segoe UI'; c.fillText(activity.label + ' • ' + activity.completed + '/' + activity.total + ' đã duyệt', 14, 277, 480);
    station.screen.texture.needsUpdate = true;
  };
  let commandKey = '';
  const paintCommand = (value: OfficeState) => {
    const approved = value.tasks.filter(t => t.status === 'approved').length, running = value.tasks.filter(t => t.status === 'running').length, review = value.tasks.filter(t => t.status === 'review').length;
    const key = [approved, running, review, value.tasks.length, value.demo].join('|'); if (commandKey === key) return; commandKey = key;
    const c = commandScreen.ctx; c.fillStyle = '#101b2a'; c.fillRect(0, 0, 512, 288);
    c.fillStyle = '#d1c0fc'; c.font = 'bold 35px Segoe UI'; c.fillText('AE TEAM / CONTROL', 22, 53);
    c.fillStyle = '#8fa6bd'; c.font = '18px Segoe UI'; c.fillText(value.demo ? 'DEMO • PHIÊN MINH HỌA' : 'PHIÊN ĐANG CHỌN', 24, 87);
    [[running, 'ĐANG LÀM', '#7fd8ba'], [review, 'CHỜ REVIEW', '#edc37c'], [approved, 'ĐÃ DUYỆT', '#baa1ef']].forEach(([count, text, color], i) => {
      c.fillStyle = '#203044'; c.fillRect(23 + i * 163, 113, 143, 116); c.fillStyle = String(color);
      c.font = 'bold 46px Segoe UI'; c.fillText(String(count), 39 + i * 163, 172); c.font = '14px Segoe UI'; c.fillText(String(text), 39 + i * 163, 207);
    });
    c.fillStyle = '#92a8be'; c.font = '15px Segoe UI'; c.fillText('ĐIỀU PHỐI → CHUYÊN GIA → REVIEW → BÀN GIAO', 24, 265, 465);
    commandScreen.texture.needsUpdate = true;
  };
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), project = new THREE.Vector3();
  let active = false, disposed = false, contextLost = false, inViewport = true, frame = 0, lastFrame = 0;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let width = 0, height = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncWorkMotion = () => host.classList.toggle('work-motion', active && inViewport && !document.hidden && !disposed && !contextLost);
  const stop = () => { if (renderTimer) clearTimeout(renderTimer); renderTimer = undefined; cancelAnimationFrame(frame); frame = 0; };
  function schedule(): void { if (!frame && active && inViewport && !document.hidden && !disposed) frame = requestAnimationFrame(draw); }
  function draw(at: number): void {
    frame = 0; if (!active || !inViewport || document.hidden || disposed || contextLost) return;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    if (width !== w || height !== h) {
      width = w; height = h; renderer.setSize(w, h, false); canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      camera.aspect = w / h; camera.zoom = Math.min(1, camera.aspect / 1.05); camera.updateProjectionMatrix();
    }
    const animating = !reducedMotion.matches && stations.some(s => s.moving && s.visible);
    const delta = at - lastFrame;
    if (animating && delta < 1000 / 24) {
      if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; schedule(); }, Math.ceil(1000 / 24 - delta));
      return;
    }
    lastFrame = at;
    for (const [i, station] of stations.entries()) {
      const moving = station.moving && !reducedMotion.matches;
      const phase = at * 0.005 + i * 1.7;
      station.arms.forEach((arm, n) => { arm.rotation.x = moving ? Math.sin(phase * 2.3 + n * Math.PI) * 0.065 : 0; });
      station.head.rotation.x = moving ? -0.1 + Math.sin(phase * 0.45) * 0.035 : -0.08;
      station.head.rotation.y = moving && station.seat.head ? Math.sin(phase * 0.35) * 0.13 : 0;
      station.torso.rotation.x = moving ? -0.035 + Math.sin(phase * 0.3) * 0.012 : 0;
      station.beaconMat.emissiveIntensity = station.running && moving ? 0.6 + Math.sin(phase) * 0.3 : 0.2;
      station.cursor.visible = moving; station.cursor.position.x = -0.6 + (moving ? at * 0.00009 % 1.2 : 0);
    }
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    for (const station of stations) {
      project.set(station.seat.x, (station.seat.head ? 0.52 : 0) + 2.9, station.seat.z - 0.3); project.project(camera);
      station.label.style.transform = `translate(-50%, -100%) translate(${(project.x * 0.5 + 0.5) * w}px, ${(-project.y * 0.5 + 0.5) * h}px)`;
      station.label.hidden = !station.visible || project.z > 1 || project.z < -1;
    }
    renderer.render(scene, camera);
    if (animating && !renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; schedule(); }, 1000 / 24);
  }
  const resize = new ResizeObserver(schedule); resize.observe(host);
  const intersection = new IntersectionObserver(entries => {
    inViewport = entries.some(entry => entry.isIntersecting); syncWorkMotion(); if (!inViewport) stop(); else schedule();
  });
  intersection.observe(host);
  const visibility = () => { syncWorkMotion(); if (document.hidden) stop(); else schedule(); };
  const motionChanged = () => { stop(); schedule(); };
  document.addEventListener('visibilitychange', visibility); reducedMotion.addEventListener('change', motionChanged);
  controls.addEventListener('change', schedule);
  const start = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', event => { start.x = event.clientX; start.y = event.clientY; });
  canvas.addEventListener('pointerup', event => {
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const rect = canvas.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(stations.filter(s => s.visible).map(s => s.pickArea), false)[0];
    if (hit) onPick(stations[hit.object.userData.index].seat.roleId);
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); contextLost = true; active = false; host.classList.add('context-lost'); syncWorkMotion(); stop();
    const notice = host.querySelector<HTMLElement>('.office-message');
    if (notice) { notice.hidden = false; notice.textContent = 'Kết nối GPU đã bị ngắt. Bấm ↻ để dựng lại Office 3D. Danh sách vai trò vẫn hoạt động.'; }
  });
  const controller: OfficeController = {
    update(value) {
      let shadowDirty = false;
      const colors = { idle: 0x8091a1, running: 0xef6675, done: 0x57d69a, blocked: 0xe9ac68, stopped: 0xa2aaba };
      stations.forEach(station => {
        const role = value.roles.find(r => r.id === station.seat.roleId);
        if (station.visible !== Boolean(role)) shadowDirty = true;
        station.visible = Boolean(role); station.group.visible = Boolean(role);
        if (!role) { station.label.hidden = true; station.moving = false; return; }
        const activity = officeActivity(role, value.tasks, Boolean(value.demo), Boolean(value.previewMotion));
        const work = value.workStatuses?.[role.id] || roleWorkState(role.id, { tasks: value.tasks });
        station.running = work.state === 'running'; station.moving = station.running || activity.preview;
        station.accent.color.set(role.color); station.beaconMat.color.setHex(colors[work.state]); station.beaconMat.emissive.setHex(colors[work.state]);
        station.name.textContent = (station.seat.head ? '★ ' : '') + role.name;
        station.statusLabel.textContent = (activity.preview ? 'Minh họa · ' : '') + activity.label;
        station.label.title = `${role.name} · ${role.model}\n${activity.task?.title || 'Chưa có việc'}\n${work.label} · ${work.detail}\n${activity.completed}/${activity.total} task đã duyệt`;
        station.label.dataset.work = work.state; station.workBar.dataset.work = work.state; station.workBar.title = work.detail;
        station.workLabel.textContent = work.label;
        station.workTrack.setAttribute('aria-label', `${role.name} · ${work.label}`);
        station.workTrack.setAttribute('aria-valuetext', `${work.label} · ${work.detail}`);
        if (work.state === 'running') station.workTrack.removeAttribute('aria-valuenow');
        else station.workTrack.setAttribute('aria-valuenow', work.state === 'done' ? '100' : '0');
        station.label.classList.toggle('selected', value.selectedRole === role.id); station.label.dataset.status = activity.status;
        station.label.setAttribute('aria-pressed', String(value.selectedRole === role.id));
        station.selection.visible = value.selectedRole === role.id;
        station.progress.scale.x = station.progressWidth * activity.progress;
        station.progress.position.x = -(station.progressWidth - station.progress.scale.x) / 2;
        const screenKey = [role.id, role.color, role.shortName, activity.status, activity.label, activity.completed, activity.total].join('|');
        if (station.screenKey !== screenKey) { station.screenKey = screenKey; paintWorkScreen(station, role, activity); }
      });
      paintCommand(value); if (shadowDirty) renderer.shadowMap.needsUpdate = true; schedule();
    },
    setActive(value) { active = value && !contextLost && !disposed; controls.enabled = active; syncWorkMotion(); if (!active) stop(); else schedule(); },
    camera(mode) {
      camera.position.set(...(mode === 'top' ? [0, 38, 0.6] : mode === 'front' ? [0, 20, 32] : [23, 27, 31]) as [number, number, number]);
      controls.target.set(0, 0.5, 0); controls.update(); schedule();
    },
    dispose() {
      disposed = true; syncWorkMotion(); stop(); resize.disconnect(); intersection.disconnect(); controls.dispose(); document.removeEventListener('visibilitychange', visibility); reducedMotion.removeEventListener('change', motionChanged);
      const geometries = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
      scene.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => mats.add(m)); } });
      geometries.forEach(g => g.dispose()); mats.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); sun.shadow.dispose(); renderer.dispose();
      stations.forEach(s => s.label.remove()); canvas.remove(); host.classList.remove('context-lost');
    }
  };
  controller.camera('iso'); return controller;
};

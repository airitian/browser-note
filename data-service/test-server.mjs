// 本地数据服务自测：探活 / LWW 合并 / 并发写不丢数据 / 清空 / 原子落盘
// 用法：node data-service/test-server.mjs
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'server.mjs');
const DATA_DIR = join(HERE, 'data-test');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, BN_PORT: String(PORT), BN_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch (_) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

const h = await waitReady();
check('服务启动并可探活', !!h, JSON.stringify(serverLog));
if (!h) { console.log(serverLog); child.kill(); process.exit(1); }
console.log(`  服务自报：version=${h.version} pid=${h.pid} notes=${h.notes}`);

console.log('\n--- 空库初始状态 ---');
const g0 = await (await fetch(`${BASE}/notes`)).json();
check('初始 notes 为空', Object.keys(g0.notes).length === 0);

console.log('\n--- 推第一篇 ---');
const p1 = await post('/notes', { notes: { n1: { id: 'n1', title: '第一篇', content: 'A', updatedAt: 1000 } } });
check('推送成功 merged=1', p1.data.ok && p1.data.merged === 1, JSON.stringify(p1.data));
check('返回里含该笔记', !!p1.data.notes && !!p1.data.notes.n1);

console.log('\n--- LWW：新时间戳覆盖旧 ---');
const p2 = await post('/notes', { notes: { n1: { id: 'n1', title: '第一篇(改)', content: 'B', updatedAt: 2000 } } });
check('较新时间戳覆盖', p2.data.notes.n1.content === 'B');
check('覆盖计数=1', p2.data.merged === 1);

console.log('\n--- LWW：旧时间戳不覆盖新 ---');
const p3 = await post('/notes', { notes: { n1: { id: 'n1', title: '旧的', content: 'C', updatedAt: 500 } } });
check('较旧时间戳被忽略', p3.data.notes.n1.content === 'B', `实际=${p3.data.notes.n1.content}`);
check('旧推计数=0', p3.data.merged === 0);

console.log('\n--- 合并而非覆盖：客户端没带来的笔记要保留 ---');
const p4 = await post('/notes', { notes: { n2: { id: 'n2', title: '第二篇', content: 'D', updatedAt: 3000 } } });
check('服务端同时保留 n1 与 n2',
  !!p4.data.notes.n1 && !!p4.data.notes.n2 && Object.keys(p4.data.notes).length === 2,
  JSON.stringify(Object.keys(p4.data.notes)));

console.log('\n--- 墓碑（删除）传播 ---');
const p5 = await post('/notes', { notes: { n2: { id: 'n2', title: '', content: '', deleted: true, updatedAt: 4000 } } });
check('墓碑写入成功', p5.data.notes.n2.deleted === true);
check('墓碑正文被清空', !p5.data.notes.n2.content);

console.log('\n--- 并发写入不丢数据（20 路并发，各推一篇）---');
await Promise.all(Array.from({ length: 20 }, (_, i) =>
  post('/notes', { notes: { [`c${i}`]: { id: `c${i}`, title: `并发${i}`, content: `x${i}`, updatedAt: 10000 + i } } })
));
const after = await (await fetch(`${BASE}/notes`)).json();
const ids = Object.keys(after.notes);
check('并发后笔记总数 = 22（1+1+20）', ids.length === 22, `实际=${ids.length}`);
check('并发写入无一丢失', Array.from({ length: 20 }, (_, i) => ids.includes(`c${i}`)).every(Boolean));

console.log('\n--- 原子落盘：磁盘文件内容与服务内存一致 ---');
const diskFile = join(DATA_DIR, 'notes.json');
check('数据文件已落盘', existsSync(diskFile));
const disk = JSON.parse(readFileSync(diskFile, 'utf8'));
check('磁盘笔记数与内存一致', Object.keys(disk.notes).length === ids.length,
  `disk=${Object.keys(disk.notes).length} mem=${ids.length}`);
check('磁盘内容含并发写入', !!disk.notes.c19 && disk.notes.c19.title === '并发19');
check('无残留 .tmp 文件', !existsSync(diskFile + '.tmp'));

console.log('\n--- 非法请求不崩服务 ---');
const bad = await post('/notes', { nope: 1 });
check('缺 notes 字段返回 400', bad.status === 400);
const bad2 = await fetch(`${BASE}/nonexistent`);
check('未知端点返回 404', bad2.status === 404);
const still = await (await fetch(`${BASE}/health`)).json();
check('服务在非法请求后仍存活', still.ok === true);

console.log('\n--- 清空 ---');
const w = await post('/wipe', {});
check('清空返回 ok', w.data.ok === true);
const afterWipe = await (await fetch(`${BASE}/notes`)).json();
check('清空后 notes 为空', Object.keys(afterWipe.notes).length === 0);

console.log('\n--- 重启后数据从磁盘恢复 ---');
child.kill();
await new Promise((r) => setTimeout(r, 800));
// 重新推两篇再重启，验证持久化
const child2 = spawn(process.execPath, [SERVER], {
  env: { ...process.env, BN_PORT: String(PORT), BN_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await waitReady();
await post('/notes', { notes: { p1: { id: 'p1', title: '持久', content: 'P', updatedAt: 9999 } } });
child2.kill();
await new Promise((r) => setTimeout(r, 800));
const child3 = spawn(process.execPath, [SERVER], {
  env: { ...process.env, BN_PORT: String(PORT), BN_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const h3 = await waitReady();
check('重启后读回磁盘数据', !!h3 && h3.notes >= 1, `notes=${h3 && h3.notes}`);
child3.kill();

rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n===== SUMMARY: ${pass}/${pass + fail} checks passed =====`);
console.log(fail === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(fail === 0 ? 0 : 1);

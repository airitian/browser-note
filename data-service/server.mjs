// 本地数据服务：让同一台电脑上的多个浏览器（Chrome / Beta / Dev / Edge）
// 共用【唯一一份】笔记数据，而不是各存一份再靠云端同步。
//
// ===== 为什么需要它 =====
// chrome.storage.local 落在每个浏览器 profile 的
//   <user-data-dir>/Default/Local Extension Settings/<扩展ID>/
// 那是一个 LevelDB 目录，有单写者锁（LOCK 文件 + Windows LockFileEx）。
// 实测（probe-shared-store.mjs）：A 开着时，B 用 junction 指向同一目录
// 会直接失败——`IO error: .../LOCK: Access denied. (LockFile::5)`。
// ⇒ 多个浏览器【同时开着】共用同一份物理存储物理上不可行。
//
// 把存储搬出浏览器、收拢到本进程之后，锁的问题自然消失：
// 四个浏览器都只是 HTTP 客户端，真正的写入由本进程单点串行完成。
//
// ===== 语义（与七牛通道保持一致）=====
//   - 同步对象：只有 notes 字典（图片 img:<id> 本来就不参与云端同步，
//     这里同样不参与——保持两条通道语义一致）
//   - 合并方式：LWW，按 updatedAt 大者胜；墓碑（deleted）同样按时间戳裁决
//   - 删除传播：服务端【不删】客户端没带上的笔记（合并而非覆盖），
//     删除靠墓碑条目传播
//   - 与七牛的区别：七牛走「本地权威覆盖索引」（因为 CDN 缓存导致无法
//     可靠读取远端现状），本地服务能直接看到全量，所以用 LWW 合并更安全
//
// ===== 安全边界 =====
//   - 只监听 127.0.0.1，不对外暴露，局域网内其他机器访问不到
//   - 不做认证（同机单用户场景；任何本机进程本来就能读用户自己的文件）
//   - 单写者：端口被占用时直接退出并给出明确提示（不做多实例共享目录）
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BN_DATA_DIR || join(HERE, 'data');
const DATA_FILE = join(DATA_DIR, 'notes.json');
const PORT = Number(process.env.BN_PORT || 8787);
const HOST = '127.0.0.1';
const VERSION = '1.0.0';

// ===== 状态 =====
let state = { notes: {}, updatedAt: 0 };
let writeChain = Promise.resolve();   // 写入串行化：所有写请求排队，杜绝交错
let dirty = false;                    // 有未落盘的变更

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// 读取磁盘上的现状。服务启动时执行一次；运行中只认内存里的 state。
function load() {
  ensureDir();
  if (!existsSync(DATA_FILE)) {
    state = { notes: {}, updatedAt: 0 };
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    state = {
      notes: (raw && typeof raw.notes === 'object' && raw.notes) ? raw.notes : {},
      updatedAt: Number(raw && raw.updatedAt) || 0,
    };
  } catch (e) {
    // 文件损坏：宁可备份坏文件另起新档，也不要让服务起不来
    const bak = DATA_FILE + '.corrupt-' + Date.now();
    try { renameSync(DATA_FILE, bak); } catch (_) { /* 备份失败也继续 */ }
    console.error(`[local-service] 数据文件损坏，已另存为 ${bak}，以空档启动：${e.message}`);
    state = { notes: {}, updatedAt: 0 };
  }
}

// 原子写：先写 .tmp 再 rename（Windows 上 rename 会覆盖目标，POSIX 同样原子）。
// rename 失败时回退为直接覆盖写——宁可失去原子性也不要丢数据。
function persist() {
  ensureDir();
  const tmp = DATA_FILE + '.tmp';
  const body = JSON.stringify({ notes: state.notes, updatedAt: state.updatedAt });
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[local-service] 原子写失败，回退为直接覆盖写：', e.message);
    try {
      writeFileSync(DATA_FILE, body, 'utf8');
      if (existsSync(tmp)) { try { unlinkSync(tmp); } catch (_) { /* 无所谓 */ } }
    } catch (e2) {
      console.error('[local-service] 落盘失败：', e2.message);
      throw e2;
    }
  }
  dirty = false;
}

// 把写操作排进串行队列：四个浏览器可能同时 POST，Node 单线程虽不交错，
// 但 await persist() 会让出事件循环 → 必须显式排队，否则后写的可能先落盘。
//
// 链条本身【永不拒绝】：一次写失败不能把后续所有写都卡死（否则服务会僵住）。
// 但失败要上抛给本次调用者（HTTP 层据此返回 500），不能被悄悄吞掉。
function enqueueWrite(fn) {
  const p = writeChain.then(() => fn(), () => fn());
  writeChain = p.then(() => {}, () => {});   // 链条脱钩：失败不影响后续
  return p;
}

// ===== LWW 合并 =====
// 服务端合并客户端推来的全量：逐条按 updatedAt 大者胜。
// 墓碑参与同一套裁决（deleted 且 updatedAt 更大 → 覆盖正文为墓碑）。
// 客户端没带来的笔记一律保留（这是「合并」而非「覆盖」的关键）。
function mergeNotes(incoming) {
  let changed = 0;
  for (const [id, remote] of Object.entries(incoming || {})) {
    if (!remote || typeof remote !== 'object' || !id) continue;
    const rAt = Number(remote.updatedAt) || 0;
    const cur = state.notes[id];
    const cAt = Number(cur && cur.updatedAt) || 0;
    if (cur && !(rAt > cAt)) continue;          // 本地（服务端）更新 → 保留
    state.notes[id] = remote;
    changed++;
  }
  if (changed) state.updatedAt = Date.now();
  return changed;
}

// ===== HTTP 处理 =====
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',   // 本地数据绝不能被缓存（否则改动读不到）
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        rejectPromise(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectPromise);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // OPTIONS 预检：扩展页面可能发跨源请求（origin 是 chrome-extension://）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  try {
    // 探活：GET /health —— 不碰磁盘，只报内存状态。扩展每次同步前都探它
  if (req.method === 'GET' && path === '/health') {
      json(res, 200, {
        ok: true,
        service: 'browser-note-local',
        version: VERSION,
        pid: process.pid,
        notes: Object.keys(state.notes).length,
        updatedAt: state.updatedAt,
      });
      return;
    }

    // 取全量：GET /notes
    if (req.method === 'GET' && path === '/notes') {
      json(res, 200, { notes: state.notes, updatedAt: state.updatedAt });
      return;
    }

    // 推全量（服务端 LWW 合并）：POST /notes  body = { notes: {...} }
    if (req.method === 'POST' && path === '/notes') {
      const raw = await readBody(req);
      let payload = null;
      try { payload = JSON.parse(raw || '{}'); } catch (_) { /* 非法 JSON */ }
      if (!payload || typeof payload.notes !== 'object' || !payload.notes) {
        json(res, 400, { ok: false, error: '请求体必须是 { notes: {...} }' });
        return;
      }
      const changed = await enqueueWrite(async () => {
        const n = mergeNotes(payload.notes);
        if (n) persist();
        return n;
      });
      json(res, 200, {
        ok: true,
        merged: changed,
        notes: state.notes,
        updatedAt: state.updatedAt,
      });
      return;
    }

    // 清空：POST /wipe —— 与七牛的 wipeCloud 语义对齐（清空要能传播到其它浏览器，
    // 靠的是客户端推送墓碑；本端点只负责把服务端这份清掉）
    if (req.method === 'POST' && path === '/wipe') {
      await enqueueWrite(async () => {
        state = { notes: {}, updatedAt: Date.now() };
        persist();
      });
      json(res, 200, { ok: true, notes: 0, updatedAt: state.updatedAt });
      return;
    }

    json(res, 404, { ok: false, error: '未知端点: ' + path });
  } catch (e) {
    console.error('[local-service] 处理请求出错：', e);
    try { json(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    catch (_) { try { res.end(); } catch (__) { /* 已断 */ } }
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[local-service] 端口 ${PORT} 已被占用——本地数据服务已在运行？`);
    console.error('  （浏览器端会自动降级到七牛通道，不影响使用；如需本机唯一副本，'
      + '请先结束占用该端口的进程）');
  } else {
    console.error('[local-service] 服务错误：', e);
  }
  process.exit(1);
});

load();
server.listen(PORT, HOST, () => {
  const n = Object.keys(state.notes).length;
  console.log(`[local-service] 已启动 http://${HOST}:${PORT}  (v${VERSION}, pid=${process.pid})`);
  console.log(`[local-service] 数据文件：${DATA_FILE}  (现有 ${n} 篇笔记)`);
});

// 退出前把内存里未落盘的变更写下去（SIGINT / SIGTERM）
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[local-service] 收到 ${sig}，正在保存并退出…`);
  writeChain.then(() => {
    if (dirty) { try { persist(); } catch (e) { console.error('[local-service] 退出前落盘失败：', e); } }
    server.close(() => process.exit(0));
    // 兜底：close 回调迟迟不来时强制退出
    setTimeout(() => process.exit(0), 1500);
  }).catch(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

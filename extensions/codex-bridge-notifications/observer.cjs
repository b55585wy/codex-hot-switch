const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function eventKey(msg) {
  return msg.sessionId && msg.turnId ? `${msg.sessionId}:${msg.turnId}${msg.taskStatus === 'failed' ? ':failed' : ''}` : '';
}
function safeSummary(value, limit = 1200) {
  return Array.from(String(value || '').replace(/\bsk-[\w-]+/g, '[凭据已隐藏]')
    .replace(/\b(api[_ -]?key|app[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S+/gi, '$1=[凭据已隐藏]'))
    .slice(0, limit).join('');
}
function failureDetails(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error) || typeof error.message !== 'string') return undefined;
  const info = error.codex_error_info ?? error.codexErrorInfo;
  const tag = typeof info === 'string' ? info : Object.keys(info || {})[0] || 'other';
  const errorCode = tag.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  let failureKind = 'error';
  if (errorCode === 'server_overloaded' || /selected model is at capacity/i.test(error.message)) failureKind = 'capacity';
  else if (errorCode === 'response_too_many_failed_attempts' || /retr(?:y|ies).*exhaust|exhaust.*retr(?:y|ies)/i.test(error.message)) failureKind = 'retry_exhausted';
  else if (errorCode === 'usage_limit_exceeded') failureKind = 'usage_limit';
  else if (errorCode === 'unauthorized') failureKind = 'authentication';
  else if (errorCode === 'context_window_exceeded') failureKind = 'context_limit';
  const labels = {capacity:'模型容量不足', retry_exhausted:'重试已耗尽', usage_limit:'用量已达到限制',
    authentication:'认证失败', context_limit:'上下文已达到限制', error:'任务发生终止错误'};
  return {failureKind, errorCode, summary:safeSummary('任务受阻：' + labels[failureKind] + '\n' + error.message)};
}
function readNativeThreads(codexHome) {
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'), {readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=1000');
    const rows = db.prepare('SELECT id, rollout_path, source, cwd, title, name FROM threads WHERE archived=0').all();
    const goalPath = path.join(codexHome, 'goals_1.sqlite');
    if (!fs.existsSync(goalPath)) return rows;
    const goals = new DatabaseSync(goalPath, {readOnly:true});
    try {
      goals.exec('PRAGMA busy_timeout=1000');
      const statuses = new Map(goals.prepare('SELECT thread_id, status FROM thread_goals').all().map(r => [r.thread_id, r.status]));
      return rows.map(row => ({...row, goalStatus:statuses.get(row.id)}));
    } finally { goals.close(); }
  } finally { db.close(); }
}
function readGoalStatus(codexHome, sessionId) {
  const goalPath = path.join(codexHome, 'goals_1.sqlite');
  if (!fs.existsSync(goalPath)) return undefined;
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(goalPath, {readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=1000');
    return db.prepare('SELECT status FROM thread_goals WHERE thread_id=?').get(sessionId)?.status;
  } finally { db.close(); }
}
function mainThread(row) {
  if (!row.id || !row.rollout_path) return false;
  try { if (JSON.parse(row.source || '{}').subagent) return false; } catch {}
  return true;
}
function readRecords(file, cursor, maxBytes = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < cursor.offset) { cursor.offset = 0; cursor.skipPartial = false; }
    const bytes = Math.min(maxBytes, size - cursor.offset);
    cursor.caughtUp = bytes === 0;
    if (!bytes) return [];
    const buffer = Buffer.alloc(bytes);
    const count = fs.readSync(fd, buffer, 0, bytes, cursor.offset);
    let begin = 0;
    if (cursor.skipPartial) {
      begin = buffer.indexOf(10, 0);
      if (begin < 0) { cursor.offset += count; return []; }
      begin++;
      cursor.skipPartial = false;
    }
    const end = buffer.lastIndexOf(10, count - 1);
    if (end < begin) {
      if (count === maxBytes) { cursor.offset += count; cursor.skipPartial = true; }
      return [];
    }
    cursor.offset += end + 1;
    cursor.caughtUp = cursor.offset >= size;
    return buffer.subarray(begin, end).toString('utf8').split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } finally { fs.closeSync(fd); }
}
function createCodexObserver(opts) {
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const listThreads = opts.listThreads || (() => readNativeThreads(opts.codexHome));
  const enabled = opts.enabled || (() => true);
  const settleMs = opts.settleMs ?? 5000;
  const retryBackoffMs = Number.isFinite(opts.retryBackoffMs) && opts.retryBackoffMs > 0 ? opts.retryBackoffMs : 60000;
  let state = {version:1, startedAt:now(), cursors:{}, seen:{}, pending:{}, managed:{}, currentTurns:{}};
  let timer, scanPromise, busy = false, started = false, dirty = false, baselinePending = true;
  let scanFailures = 0, nextScanAt = 0;
  let currentRows = new Map();
  const readFailures = new Map();
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(opts.statePath, 'utf8'));
      if (data.version !== 1 || !data.cursors || !data.seen || !data.pending) throw new Error('Invalid observer state');
      state = data;
      state.managed ||= {};
      state.currentTurns ||= {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  function save() {
    if (!dirty) return;
    const seen = Object.entries(state.seen).sort((a,b) => b[1] - a[1]).slice(0, 2000);
    state.seen = Object.fromEntries(seen);
    state.managed = Object.fromEntries(Object.entries(state.managed).slice(-2000));
    fs.mkdirSync(path.dirname(opts.statePath), {recursive:true});
    const temp = opts.statePath + '.tmp-' + randomUUID();
    fs.writeFileSync(temp, JSON.stringify(state) + '\n', {mode:0o600});
    fs.renameSync(temp, opts.statePath);
    dirty = false;
  }
  function markDelivered(msg) {
    const key = eventKey(msg);
    if (!key) return;
    state.seen[key] = now();
    delete state.pending[key];
    delete state.managed[key];
    if (msg.taskStatus === 'failed') delete state.managed[eventKey({...msg, taskStatus:'completed'})];
    dirty = true;
    if (started) save();
  }
  function cancelPending(sessionId) {
    for (const [key, item] of Object.entries(state.pending)) {
      if (item.msg.sessionId === sessionId) delete state.pending[key];
    }
  }
  function consume(row, record) {
    if (record.type !== 'event_msg') return;
    const payload = record.payload || {};
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at) || at < state.startedAt) return;
    if (payload.type === 'task_started') {
      cancelPending(row.id);
      if (typeof payload.turn_id === 'string' && payload.turn_id) state.currentTurns[row.id] = payload.turn_id;
      else delete state.currentTurns[row.id];
      dirty = true;
      return;
    }
    if (payload.type === 'turn_aborted') {
      cancelPending(row.id);
      delete state.currentTurns[row.id];
      dirty = true;
      return;
    }
    if (payload.type === 'stream_error' || payload.type === 'error' && (payload.willRetry === true || payload.will_retry === true)) {
      cancelPending(row.id);
      return;
    }
    let turnId, failure;
    if (payload.type === 'task_complete') {
      turnId = payload.turn_id;
      if (typeof turnId !== 'string' || !turnId) return;
      if (state.currentTurns[row.id] && state.currentTurns[row.id] !== turnId) return;
      if (state.currentTurns[row.id] === turnId) delete state.currentTurns[row.id];
      failure = failureDetails(payload.error);
      if (payload.error != null && !failure) return;
      const failedKey = eventKey({sessionId:row.id, turnId, taskStatus:'failed'});
      if (!failure && !payload.last_agent_message && (state.pending[failedKey] || state.seen[failedKey])) return;
    } else if (payload.type === 'error') {
      if (payload.willRetry !== false && payload.will_retry !== false) return;
      turnId = state.currentTurns[row.id];
      if (!turnId || payload.turn_id != null && payload.turn_id !== turnId || payload.turnId != null && payload.turnId !== turnId) return;
      if (payload.thread_id != null && payload.thread_id !== row.id || payload.threadId != null && payload.threadId !== row.id) return;
      failure = failureDetails(payload.error ?? payload);
      if (!failure || ['thread_rollback_failed', 'active_turn_not_steerable'].includes(failure.errorCode)) return;
    } else return;
    const msg = {
      type:'task_complete', source:'codex', sessionId:row.id, turnId,
      cwd:row.cwd, summary:failure?.summary ?? safeSummary(payload.last_agent_message), name:safeSummary(row.name || row.title, 80),
      hookEventName:'DesktopObserver', notificationOnly:true, taskStatus:failure ? 'failed' : 'completed',
      ...(failure ? {failureKind:failure.failureKind, errorCode:failure.errorCode} : {})
    };
    const key = eventKey(msg);
    if (state.seen[key] || state.pending[key]) return;
    delete state.pending[eventKey({...msg, taskStatus:failure ? 'completed' : 'failed'})];
    if (!enabled()) { state.seen[key] = now(); return; }
    const managedKey = eventKey({...msg, taskStatus:'completed'});
    const delay = state.managed[managedKey] ? Math.max(settleMs, opts.managedGraceMs ?? 30000) : settleMs;
    state.pending[key] = {msg, dueAt:now() + delay, attempts:0};
  }
  async function inspect(row, baseline) {
    let cursor = state.cursors[row.id];
    const sameFile = cursor?.file === row.rollout_path;
    if (!sameFile) {
      const stat = fs.statSync(row.rollout_path);
      cursor = {file:row.rollout_path, offset:baseline ? stat.size : 0};
      state.cursors[row.id] = cursor;
      dirty = true;
    }
    if (baseline && !sameFile) return;
    const previous = cursor.offset;
    for (const record of readRecords(row.rollout_path, cursor)) consume(row, record);
    if (cursor.offset !== previous) dirty = true;
  }
  async function deliverPending() {
    for (const [key, item] of Object.entries(state.pending)) {
      if (!enabled() || state.seen[key]) { markDelivered(item.msg); continue; }
      if (item.dueAt > now()) continue;
      if (state.cursors[item.msg.sessionId]?.caughtUp === false) continue;
      const goalStatus = currentRows.get(item.msg.sessionId)?.goalStatus;
      if (goalStatus === 'active' && item.msg.taskStatus !== 'failed') continue;
      try {
        const result = await opts.deliver(item.msg);
        markDelivered(item.msg);
        const skipped = result?.decision === 'fallback_local' || result?.reason === 'already_notified';
        log(skipped ? 'notification-skipped' : 'notification-sent', {sessionId:item.msg.sessionId, turnId:item.msg.turnId, reason:result?.reason});
      } catch (error) {
        item.attempts++;
        const retryAfterMs = item.attempts === 1 ? opts.intervalMs ?? 5000
          : Math.min(300000, retryBackoffMs * 2 ** Math.min(item.attempts - 2, 16));
        item.dueAt = now() + retryAfterMs;
        dirty = true;
        log('notification-failed', {sessionId:item.msg.sessionId, attempt:item.attempts, retryAfterMs, error:String(error)});
      }
    }
  }
  async function scan(baseline) {
    const rows = (await listThreads()).filter(mainThread);
    currentRows = new Map(rows.map(row => [row.id, row]));
    for (const row of rows) {
      const previous = readFailures.get(row.id);
      if (previous?.file === row.rollout_path && previous.nextAt > now()) continue;
      try { await inspect(row, baseline); readFailures.delete(row.id); }
      catch (error) {
        if (state.cursors[row.id]) state.cursors[row.id].caughtUp = false;
        const attempt = (previous?.file === row.rollout_path ? previous.attempt : 0) + 1;
        readFailures.set(row.id, {file:row.rollout_path, attempt, nextAt:now() + (attempt === 1 ? 5000 : 60000)});
        if (attempt <= 2) log('read-failed', {sessionId:row.id, error:String(error), attempt});
      }
    }
    for (const id of readFailures.keys()) if (!currentRows.has(id)) readFailures.delete(id);
    await deliverPending();
    save();
    return rows.length;
  }
  function tick() {
    if (!started || busy || now() < nextScanAt) return;
    busy = true;
    scanPromise = (async () => {
      try {
        const count = await scan(baselinePending);
        if (baselinePending) log('started', {threads:count, pollMs:opts.intervalMs ?? 5000});
        baselinePending = false;
        scanFailures = 0;
      } catch (error) {
        scanFailures++;
        nextScanAt = now() + Math.min(60000, (opts.intervalMs ?? 5000) * 2 ** Math.min(scanFailures - 1, 4));
        log('scan-failed', {error:String(error), retryAfterMs:nextScanAt - now()});
      }
      finally { busy = false; }
    })();
    return scanPromise;
  }
  return {
    async start() {
      if (started) return;
      load();
      started = true;
      dirty = true;
      await tick();
      timer = setInterval(() => void tick(), opts.intervalMs ?? 5000);
      timer.unref?.();
    },
    tick,
    async stop() {
      clearInterval(timer);
      started = false;
      await scanPromise;
      save();
    },
    markDelivered,
    hasDelivered(msg) { return Boolean(state.seen[eventKey(msg)]); },
    hasManagedTurn(msg) { return Boolean(state.managed[eventKey({...msg, taskStatus:'completed'})]); },
    markBridgeTurn(sessionId, turnId) {
      const key = eventKey({sessionId, turnId});
      if (!key) return;
      state.managed[key] = now();
      dirty = true;
      if (started) save();
    }
  };
}
module.exports = {createCodexObserver, readNativeThreads, readGoalStatus, readRecords, safeSummary};

/**
 * Host half of the agent-chat bundle.
 *
 * The panel runs in the Harness Web UI, while the business login and agent
 * services live on the customer's own origins. A browser cannot call them
 * cross-origin, so every request goes through these same-origin routes handled
 * by the Host process:
 *
 *   POST /agent-chat/api/login    {username,password,settings} -> session + user
 *   POST /agent-chat/api/resume   {sid}                       -> session still valid?
 *   POST /agent-chat/api/logout   {sid}                       -> drop the session
 *   POST /agent-chat/api/chat     {sid,conversationId,message} -> one agent answer
 *   POST /agent-chat/api/history  {sid,action,id}             -> list / messages / delete
 *   POST /agent-chat/api/debug    {op,events}                 -> panel diagnostics ring buffer
 *
 * The access token returned by the business login never reaches the browser: it
 * is kept in this process, attached to every chat request, and dropped on logout.
 */
export const inject = ['webServer'];

const LOGIN_PATH = '/agent-chat/api/login';
const RESUME_PATH = '/agent-chat/api/resume';
const LOGOUT_PATH = '/agent-chat/api/logout';
const CHAT_PATH = '/agent-chat/api/chat';
const CHAT_STREAM_PATH = '/agent-chat/api/chat-stream';
const HISTORY_PATH = '/agent-chat/api/history';
const FORM_OPTIONS_PATH = '/agent-chat/api/form-options';
const FORM_REFRESH_PATH = '/agent-chat/api/form-refresh';
const ACTION_PATH = '/agent-chat/api/action';
const ARTIFACT_PATH = '/agent-chat/api/artifact';
const DEBUG_PATH = '/agent-chat/api/debug';

const DEFAULT_LOGIN_URL = 'https://taxapi.ebmtax.com:4434/api/login/';
const DEFAULT_AGENT_URL = 'http://www.ebmtax.com/agent-api';
const DEFAULT_AGENT_CODE = 'business-agent';
/** The Python assistant speaks its own protocol and lives on another origin. */
const DEFAULT_ENTERPRISE_URL = 'http://127.0.0.1:2091';
const DEFAULT_ENTERPRISE_ENTRY = 'general';
const ENTERPRISE_AGENT = 'enterprise-agent';
/** The four assistants the web app offers, in its display order. */
const AGENT_CODES = ['analysis-agent', 'business-agent', 'tax-qa-agent', 'enterprise-agent'];
const ENTERPRISE_TIMEOUT_MS = 300 * 1000;

const ENTERPRISE_ERRORS = {
  ENTERPRISE_AGENT_DISABLED: '通用业务助手暂未启用，请联系管理员开通',
  SESSION_NOT_FOUND: '会话已失效，请新建会话',
  SESSION_BUSY: '助手正在处理上一条消息，请稍后再试',
  AUTH_EXPIRED: '登录已失效，请重新登录',
  RUN_TIMEOUT: '助手处理超时，请稍后重试',
  STORAGE_UNAVAILABLE: '服务端收尾保存出错，本轮回答可能没有进入历史；可以重试一次',
};

const MAX_BODY_BYTES = 256 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 40;
const LOGIN_TIMEOUT_MS = 30 * 1000;
const CHAT_TIMEOUT_MS = 180 * 1000;
const MAX_MESSAGE_CHARS = 8000;
const MAX_ID_CHARS = 80;

/**
 * In-memory ring buffer shared with the panel's diagnostics route: the panel
 * reports client-side failures, the Host half records upstream responses.
 */
const diagnostics = [];

function note(kind, detail) {
  try {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const trimmed = String(text);
    const entry =
      trimmed.length > 4000
        ? { truncated: true, text: trimmed.slice(0, 4000) }
        : (() => {
            try {
              return JSON.parse(trimmed);
            } catch {
              return trimmed;
            }
          })();
    diagnostics.push({ at: new Date().toISOString(), kind, detail: entry });
    if (diagnostics.length > 300) diagnostics.splice(0, diagnostics.length - 300);
  } catch {
    /* diagnostics must never break a request */
  }
}

export function apply(ctx) {
  const sessions = new Map();
  diagnostics.length = 0;

  ctx.effect(() => {
    const disposers = [
      [LOGIN_PATH, (req, res) => handleLogin(req, res, sessions)],
      [RESUME_PATH, (req, res) => handleResume(req, res, sessions)],
      [LOGOUT_PATH, (req, res) => handleLogout(req, res, sessions)],
      [CHAT_PATH, (req, res) => handleChat(req, res, sessions)],
      [CHAT_STREAM_PATH, (req, res) => handleChatStream(req, res, sessions)],
      [HISTORY_PATH, (req, res) => handleHistory(req, res, sessions)],
      [FORM_OPTIONS_PATH, (req, res) => handleFormOptions(req, res, sessions)],
      [FORM_REFRESH_PATH, (req, res) => handleFormRefresh(req, res, sessions)],
      [ACTION_PATH, (req, res) => handleAction(req, res, sessions)],
      [ARTIFACT_PATH, (req, res) => handleArtifact(req, res, sessions)],
      [DEBUG_PATH, (req, res) => handleDebug(req, res, diagnostics)],
    ].map(([path, handler]) => ctx.webServer.register({ kind: 'exact', path, handler }));

    const timer = setInterval(() => pruneSessions(sessions), 10 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();

    return () => {
      clearInterval(timer);
      for (const dispose of disposers) dispose();
      sessions.clear();
    };
  });
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Same-origin only: a cross-origin page cannot send the custom header unrepelled. */
function admit(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST' });
    return false;
  }
  if (req.headers['x-requested-with'] !== 'agent-chat') {
    sendJson(res, 403, { error: 'Missing panel request header' });
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== req.headers.host) {
      sendJson(res, 403, { error: 'Cross-origin request refused' });
      return false;
    }
  }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    sendJson(res, 415, { error: 'Expected application/json' });
    return false;
  }
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, res) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    sendJson(res, 413, { error: error.message });
    return null;
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    sendJson(res, 400, { error: '请求内容不是合法 JSON' });
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function safeJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function absoluteUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function readSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    loginUrl: absoluteUrl(source.loginUrl) || DEFAULT_LOGIN_URL,
    agentUrl: absoluteUrl(source.agentUrl) || DEFAULT_AGENT_URL,
    agentCode: text(source.agentCode).replace(/[^\w.-]/g, '').slice(0, 60) || DEFAULT_AGENT_CODE,
    enterpriseUrl: absoluteUrl(source.enterpriseUrl) || DEFAULT_ENTERPRISE_URL,
    enterpriseEntry:
      text(source.enterpriseEntry).replace(/[^\w.-]/g, '').slice(0, 40) || DEFAULT_ENTERPRISE_ENTRY,
  };
}

/** Which assistant this turn talks to; an unknown code falls back to the configured one. */
function resolveAgent(body, session) {
  const requested = text(body.agent).replace(/[^\w.-]/g, '').slice(0, 60);
  if (AGENT_CODES.includes(requested)) return requested;
  const configured = session.settings.agentCode;
  return AGENT_CODES.includes(configured) ? configured : DEFAULT_AGENT_CODE;
}

function agentBase(settings) {
  return settings.agentUrl.replace(/\/+$/, '');
}

function agentUrlFor(settings, suffix, code) {
  const agent = code || settings.agentCode;
  return `${agentBase(settings)}/api/agents/${encodeURIComponent(agent)}${suffix}`;
}

function enterpriseBase(settings) {
  return (settings.enterpriseUrl || DEFAULT_ENTERPRISE_URL).replace(/\/+$/, '');
}

function enterpriseHeaders(session) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${session.token}`,
  };
  if (session.userId) headers['x-business-user-id'] = session.userId;
  return headers;
}

function agentHeaders(session, capabilityId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${session.token}`,
    'idempotency-key': randomId(),
  };
  if (session.userId) headers['x-business-user-id'] = session.userId;
  // The write tools (confirm / cancel) identify the capability session through
  // this header, exactly like the web client does.
  const capability = capabilityId || session.capabilitySessionId;
  if (capability) headers['x-agent-capability-session'] = capability;
  return headers;
}

function randomId() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = (Math.random() * 16) | 0;
    const digit = char === 'x' ? value : (value & 0x3) | 0x8;
    return digit.toString(16);
  });
}

async function backendFetch(url, options) {
  const { method = 'GET', headers = {}, body, timeout = CHAT_TIMEOUT_MS } = options ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeNetworkError(error, url) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (error && error.name === 'AbortError') return `请求超时：${host} 在规定时间内没有响应`;
  const code = error && error.cause && error.cause.code;
  if (code === 'ENOTFOUND') return `无法解析业务服务地址：${host}`;
  if (code === 'ECONNREFUSED') return `业务服务拒绝连接：${host}`;
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return `业务服务证书校验失败：${host}`;
  }
  if (code) return `无法连接业务服务：${host}（${code}）`;
  const message = error && error.message ? error.message : String(error);
  return `无法连接业务服务：${host}（${message}）`;
}

function flattenMenus(menus) {
  const result = [];
  const visit = (item, ancestors) => {
    if (!item || typeof item !== 'object') return;
    const name = text(item.name);
    const hierarchy = name ? [...ancestors, name] : ancestors;
    result.push({
      id: item.id == null ? '' : String(item.id),
      name,
      webPath: text(item.web_path),
      breadcrumb: hierarchy.join(' > '),
      checked: item.ischeck === true,
    });
    if (Array.isArray(item.children)) for (const child of item.children) visit(child, hierarchy);
  };
  if (Array.isArray(menus)) for (const menu of menus) visit(menu, []);
  return result.slice(0, 500);
}

function mapPermissions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    return {
      sign: text(source.sign),
      name: text(source.name),
      menuId: text(source.menu),
      checked: source.ischeck === true,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Capabilities, per assistant
 * ------------------------------------------------------------------ */

/**
 * Each Java-side assistant registers its own tool capabilities for this login.
 * The Python assistant validates itself instead, so it is skipped here.
 */
async function initializeCapability(session, code, menus, permissions) {
  session.menus = menus;
  session.permissions = permissions;
  if (code === ENTERPRISE_AGENT) return { ok: true, warning: '' };

  try {
    const response = await backendFetch(agentUrlFor(session.settings, '/capabilities/initialize', code), {
      method: 'POST',
      headers: agentHeaders(session),
      body: JSON.stringify({ menus, permissions }),
      timeout: LOGIN_TIMEOUT_MS,
    });
    const data = safeJson(await response.text());
    if (response.ok && data && data.capabilitySessionId) {
      const capability = {
        capabilitySessionId: String(data.capabilitySessionId),
        toolCount: Number(data.toolCount) || 0,
        toolNames: Array.isArray(data.toolNames) ? data.toolNames.slice(0, 40) : [],
      };
      session.capabilities[code] = capability;
      if (code === session.settings.agentCode) {
        session.capabilitySessionId = capability.capabilitySessionId;
        session.capability = capability;
      }
      return { ok: true, warning: '' };
    }
    return {
      ok: false,
      warning:
        (data && (text(data.message) || text(data.detail))) ||
        `能力初始化失败（HTTP ${response.status}），将以基础模式对话`,
    };
  } catch (error) {
    return { ok: false, warning: `${describeNetworkError(error, session.settings.agentUrl)}，将以基础模式对话` };
  }
}

/** Capabilities are registered lazily the first time an assistant is used. */
async function ensureCapability(session, code) {
  if (code === ENTERPRISE_AGENT) return null;
  const known = session.capabilities && session.capabilities[code];
  if (known) return known;
  if (!session.menus || !session.menus.length) return null;
  const result = await initializeCapability(session, code, session.menus, session.permissions || []);
  if (!result.ok && result.warning && !session.warning) session.warning = result.warning;
  return (session.capabilities && session.capabilities[code]) || null;
}

/* ------------------------------------------------------------------ *
 * Python assistant channel
 * ------------------------------------------------------------------ */

async function ensureEnterpriseSession(session, preferredId) {
  if (preferredId) session.enterpriseSessionId = preferredId;
  if (session.enterpriseSessionId) return session.enterpriseSessionId;

  const response = await backendFetch(`${enterpriseBase(session.settings)}/api/sessions`, {
    method: 'POST',
    headers: enterpriseHeaders(session),
    body: JSON.stringify({ entry: session.settings.enterpriseEntry }),
    timeout: LOGIN_TIMEOUT_MS,
  });
  const data = safeJson(await response.text());
  note('enterprise-session', { status: response.status, body: data });
  const id = data && (text(data.session_id) || text(data.sessionId));
  if (!response.ok || !id) {
    throw Object.assign(new Error(enterpriseMessage(data, response.status)), { status: response.status });
  }
  session.enterpriseSessionId = id;
  return id;
}

function enterpriseMessage(data, status) {
  const code = data && (text(data.code) || text(data.detail) || text(data.error));
  if (code && ENTERPRISE_ERRORS[code]) return ENTERPRISE_ERRORS[code];
  const message = data && (text(data.message) || text(data.detail));
  if (message && message !== code) return message;
  if (code) return `助手服务处理失败（${code}）`;
  return `助手服务返回 ${status}`;
}

/** The Python service streams frames; only the final result carries the answer. */
function readSseFrames(raw) {
  const events = [];
  for (const block of String(raw ?? '').split(/\n\n+/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = safeJson(dataLines.join('\n'));
    if (payload && typeof payload === 'object') events.push(payload);
  }
  return events;
}

/** Frame-type histogram, small enough to keep in a diagnostic entry. */
function countFrames(frames) {
  const summary = { total: frames.length, types: {} };
  for (const frame of frames) {
    const type = text(frame && frame.type) || 'unknown';
    summary.types[type] = (summary.types[type] || 0) + 1;
  }
  return summary;
}

/* ------------------------------------------------------------------ *
 * Session helpers
 * ------------------------------------------------------------------ */

function sessionFrom(sessions, res, body) {
  const sid = text(body.sid);
  if (!sid) {
    sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
    return null;
  }
  const session = sessions.get(sid);
  if (!session) {
    sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
    return null;
  }
  session.lastUsed = Date.now();
  return session;
}

function pruneSessions(sessions) {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.lastUsed > SESSION_TTL_MS) sessions.delete(sid);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  const ordered = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [sid] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(sid);
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function handleLogin(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;

    const username = text(body.username).slice(0, 120);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      sendJson(res, 400, { ok: false, message: '请输入账号和密码' });
      return;
    }

    const settings = readSettings(body.settings);

    let loginResponse;
    try {
      loginResponse = await backendFetch(settings.loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ username, password }),
        timeout: LOGIN_TIMEOUT_MS,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, settings.loginUrl) });
      return;
    }

    const loginText = await loginResponse.text();
    const loginData = safeJson(loginText);
    const code = loginData && loginData.code != null ? Number(loginData.code) : null;
    if (!loginData || code !== 2000) {
      const message =
        (loginData && (text(loginData.msg) || text(loginData.message))) ||
        `登录失败（HTTP ${loginResponse.status}）`;
      sendJson(res, 200, { ok: false, code, message });
      return;
    }

    const payload = loginData.data && typeof loginData.data === 'object' ? loginData.data : {};
    const token = text(payload.access) || text(payload.token);
    if (!token) {
      sendJson(res, 200, { ok: false, message: '登录响应中没有 token，请确认账号是否已开通 PC 端' });
      return;
    }

    const session = {
      token,
      userId: payload.userId == null ? '' : String(payload.userId),
      userName: text(payload.name) || username,
      settings,
      capabilities: {},
      capabilitySessionId: '',
      capability: null,
      menus: [],
      permissions: [],
      enterpriseSessionId: '',
      warning: '',
      lastUsed: Date.now(),
    };

    const permission = payload.permission && typeof payload.permission === 'object' ? payload.permission : {};
    const init = await initializeCapability(
      session,
      settings.agentCode,
      flattenMenus(permission.menu_list),
      mapPermissions(permission.permission_list),
    );
    session.warning = init.warning;

    pruneSessions(sessions);
    const sid = randomId();
    sessions.set(sid, session);

    sendJson(res, 200, {
      ok: true,
      sid,
      user: { name: session.userName, userId: session.userId },
      capability: session.capability,
      warning: session.warning,
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `登录处理失败：${error && error.message ? error.message : error}` });
  }
}

async function handleResume(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const session = sessionFrom(sessions, res, body);
    if (!session) return;
    sendJson(res, 200, {
      ok: true,
      user: { name: session.userName, userId: session.userId },
      capability: session.capability,
      warning: session.warning,
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `会话恢复失败：${error && error.message ? error.message : error}` });
  }
}

async function handleLogout(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const sid = text(body.sid);
    if (sid) sessions.delete(sid);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `退出登录失败：${error && error.message ? error.message : error}` });
  }
}

async function handleChat(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const session = sessionFrom(sessions, res, body);
    if (!session) return;

    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) {
      sendJson(res, 400, { ok: false, message: '消息不能为空' });
      return;
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      sendJson(res, 400, { ok: false, message: `单条消息不能超过 ${MAX_MESSAGE_CHARS} 字` });
      return;
    }

    const conversationId = text(body.conversationId).slice(0, MAX_ID_CHARS) || null;
    const agent = resolveAgent(body, session);

    if (agent === ENTERPRISE_AGENT) {
      await handleEnterpriseChat(res, session, message, conversationId, () => {
        const sid = text(body.sid);
        if (sid) sessions.delete(sid);
      });
      return;
    }

    const capability = await ensureCapability(session, agent);
    const capabilityId = capability ? capability.capabilitySessionId : '';

    const payload = {
      conversationId,
      message,
      imageIds: [],
      audioIds: [],
      attachmentIds: [],
    };
    if (capabilityId) payload.capabilitySessionId = capabilityId;
    const submission = readFormSubmission(body.form);
    if (submission) Object.assign(payload, submission);

    let response;
    try {
      response = await backendFetch(agentUrlFor(session.settings, '/chat', agent), {
        method: 'POST',
        headers: agentHeaders(session, capabilityId),
        body: JSON.stringify(payload),
        timeout: CHAT_TIMEOUT_MS,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, session.settings.agentUrl) });
      return;
    }

    const responseText = await response.text();
    const data = safeJson(responseText);

    if (response.status === 401 || response.status === 403) {
      for (const [sid, item] of sessions) {
        if (item === session) sessions.delete(sid);
      }
      sendJson(res, 200, {
        ok: false,
        reason: 'expired',
        message:
          (data && (text(data.message) || text(data.msg))) || '登录已失效，请重新登录',
      });
      return;
    }

    if (!response.ok || !data) {
      const message =
        (data && (text(data.message) || text(data.msg) || text(data.detail) || text(data.error))) ||
        `智能体服务返回 ${response.status}`;
      sendJson(res, 200, { ok: false, message });
      return;
    }

    sendJson(res, 200, { ok: true, result: data });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `对话失败：${error && error.message ? error.message : error}` });
  }
}

/**
 * The Python assistant owns its sessions, streams SSE frames and answers with a
 * single final `result` event, so the panel still receives one JSON answer.
 */
async function handleEnterpriseChat(res, session, message, conversationId, expire) {
  const base = enterpriseBase(session.settings);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let sessionId;
    try {
      sessionId = await ensureEnterpriseSession(session, attempt === 1 ? conversationId : '');
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        message: error && error.status ? error.message : describeNetworkError(error, base),
      });
      return;
    }

    let response;
    try {
      response = await backendFetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: enterpriseHeaders(session),
        body: JSON.stringify({ message, stream: true }),
        timeout: ENTERPRISE_TIMEOUT_MS,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, base) });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      expire();
      sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
      return;
    }

    const raw = await response.text();
    const frames = readSseFrames(raw);
    note('enterprise-response', {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      bytes: raw.length,
      frames: countFrames(frames),
      head: raw.slice(0, 600),
    });

    // A forgotten session id on the service side: start a fresh one and retry.
    if (response.status === 404 && attempt === 1) {
      session.enterpriseSessionId = '';
      continue;
    }

    const events = frames;
    const result = events.find((event) => event.type === 'result');
    const failure = events.find((event) => event.type === 'error');
    // A failure that arrives after the result only means the service could not
    // finish its own bookkeeping; the answer and the generated files stand.
    if (failure && !result) {
      if (failure.code === 'AUTH_EXPIRED') {
        expire();
        sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
        return;
      }
      if (failure.code === 'SESSION_NOT_FOUND' && attempt === 1) {
        session.enterpriseSessionId = '';
        continue;
      }
      sendJson(res, 200, { ok: false, message: enterpriseMessage(failure, response.status) });
      return;
    }
    if (failure) {
      note('enterprise-late-error', { code: text(failure.code), status: response.status });
    }

    const partial = events
      .filter((event) => event.type === 'text_delta' || event.type === 'delta')
      .map((event) => text(event.text))
      .join('');
    const answer = result ? text(result.text) : partial;
    const artifacts = result && Array.isArray(result.artifacts)
      ? result.artifacts.map((item) => (typeof item === 'string' ? item : text(item && item.name))).filter(Boolean)
      : [];
    if (!response.ok || (!answer && !artifacts.length)) {
      const data = safeJson(raw);
      const nothing = !events.length && !String(raw || '').trim();
      sendJson(res, 200, {
        ok: false,
        message: nothing ? '助手服务没有返回内容，可能是服务端处理中断，请重试' : enterpriseMessage(data, response.status),
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      result: {
        conversationId: sessionId,
        answer: answer || '已完成，成果文件见下方下载。',
        knowledgeUsed: false,
        availableTools: [],
        pendingActions: [],
        artifacts,
      },
    });
    return;
  }

  sendJson(res, 200, { ok: false, message: '助手会话已失效，请新建会话' });
}

/**
 * Same turn as handleEnterpriseChat, but the frames are relayed to the panel as
 * they arrive: the user watches the answer being written instead of a clock.
 */
async function handleChatStream(req, res, sessions) {
  if (!admit(req, res)) return;
  const body = await readJson(req, res);
  if (!body) return;
  const session = sessionFrom(sessions, res, body);
  if (!session) return;

  const message = typeof body.message === 'string' ? body.message : '';
  if (!message.trim()) {
    sendJson(res, 400, { ok: false, message: '消息不能为空' });
    return;
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    sendJson(res, 400, { ok: false, message: `单条消息不能超过 ${MAX_MESSAGE_CHARS} 字` });
    return;
  }

  const base = enterpriseBase(session.settings);
  const dropSession = () => {
    for (const [sid, item] of sessions) {
      if (item === session) sessions.delete(sid);
    }
  };

  let sessionId;
  try {
    sessionId = await ensureEnterpriseSession(session, text(body.conversationId).slice(0, MAX_ID_CHARS));
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      message: error && error.status ? error.message : describeNetworkError(error, base),
    });
    return;
  }

  let response;
  try {
    response = await backendFetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: enterpriseHeaders(session),
      body: JSON.stringify({ message, stream: true }),
      timeout: ENTERPRISE_TIMEOUT_MS,
    });
  } catch (error) {
    sendJson(res, 200, { ok: false, message: describeNetworkError(error, base) });
    return;
  }

  if (response.status === 401 || response.status === 403) {
    dropSession();
    sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
    return;
  }
  if (response.status === 404) {
    session.enterpriseSessionId = '';
    sendJson(res, 200, { ok: false, message: '助手会话已失效，已为你重建，请再发送一次' });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const emit = (payload) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      closed = true;
    }
  };

  emit({ type: 'meta', conversationId: sessionId });

  let answer = '';
  let artifacts = [];
  let failure = null;
  let sawResult = false;
  const counts = {};

  const takeFrame = (frame) => {
    const type = text(frame.type) || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
    if (type === 'text_delta' || type === 'delta') {
      const piece = text(frame.text);
      if (piece) {
        answer += piece;
        emit({ type: 'delta', text: piece });
      }
      return;
    }
    if (type === 'result') {
      sawResult = true;
      const finalText = text(frame.text);
      if (finalText) answer = finalText;
      if (Array.isArray(frame.artifacts)) {
        artifacts = frame.artifacts
          .map((item) => (typeof item === 'string' ? item : text(item && item.name)))
          .filter(Boolean);
      }
      return;
    }
    if (type === 'error') {
      failure = frame;
      return;
    }
    if (type === 'progress') {
      emit({ type: 'progress', title: text(frame.title), status: text(frame.status), stepId: text(frame.step_id) });
      return;
    }
    if (type === 'tool') {
      emit({ type: 'tool', name: text(frame.name) });
      return;
    }
    if (type === 'skill_selected') {
      emit({ type: 'skill', skillId: text(frame.skill_id) });
      return;
    }
    if (type === 'company_scope_required') {
      emit({ type: 'company', skillId: text(frame.skill_id) });
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done || closed) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const frame of readSseFrames(block)) takeFrame(frame);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } else {
      for (const frame of readSseFrames(await response.text())) takeFrame(frame);
    }
  } catch (error) {
    emit({ type: 'error', message: describeNetworkError(error, base) });
    res.end();
    return;
  }

  note('enterprise-stream', { status: response.status, frames: counts, answered: answer.length, artifacts });
  if (failure) note('enterprise-late-error', { code: text(failure.code), status: response.status, sawResult });

  // A late error frame (session bookkeeping, event-stream teardown) must not
  // erase an answer the service already produced: assets stay downloadable.
  if (failure && !sawResult) {
    if (failure.code === 'AUTH_EXPIRED') {
      dropSession();
      emit({ type: 'expired' });
    } else {
      emit({ type: 'error', message: enterpriseMessage(failure, response.status) });
    }
  } else if (!answer && !artifacts.length) {
    emit({
      type: 'error',
      message: sawResult ? '助手没有给出内容，请再试一次' : '助手服务没有返回内容，可能是服务端处理中断，请重试',
    });
  } else {
    emit({ type: 'done', answer, artifacts, conversationId: sessionId });
  }
  res.end();
}

async function handleEnterpriseHistory(res, session, action, id) {
  const base = enterpriseBase(session.settings);
  const entry = session.settings.enterpriseEntry;

  if (action === 'delete') {
    sendJson(res, 200, { ok: false, message: '该助手暂不支持删除会话' });
    return;
  }

  let url;
  if (action === 'messages') {
    if (!id) {
      sendJson(res, 400, { ok: false, message: '缺少会话标识' });
      return;
    }
    url = `${base}/api/sessions/${encodeURIComponent(id)}/history`;
  } else if (action === 'list') {
    url = `${base}/api/sessions?entry=${encodeURIComponent(entry)}&offset=0&limit=20`;
  } else {
    sendJson(res, 400, { ok: false, message: `未知操作：${action}` });
    return;
  }

  let response;
  try {
    response = await backendFetch(url, {
      method: 'GET',
      headers: enterpriseHeaders(session),
      timeout: LOGIN_TIMEOUT_MS,
    });
  } catch (error) {
    sendJson(res, 200, { ok: false, message: describeNetworkError(error, base) });
    return;
  }

  if (response.status === 401 || response.status === 403) {
    sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
    return;
  }

  const data = safeJson(await response.text());
  if (!response.ok || !data) {
    sendJson(res, 200, { ok: false, message: enterpriseMessage(data, response.status) });
    return;
  }

  if (action === 'list') {
    const items = Array.isArray(data.items) ? data.items : [];
    sendJson(res, 200, {
      ok: true,
      result: items.slice(0, 50).map((item) => ({
        id: text(item.session_id) || text(item.sessionId),
        title: text(item.name) || text(item.title) || '新会话',
        createdAt: text(item.created_at) || text(item.createdAt),
        updatedAt: text(item.updated_at) || text(item.created_at) || text(item.updatedAt),
      })),
    });
    return;
  }

  const messages = Array.isArray(data.messages) ? data.messages : [];
  sendJson(res, 200, {
    ok: true,
    result: messages.slice(0, 200).map((item) => ({
      id: item.id == null ? '' : String(item.id),
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: text(item.text) || text(item.content),
      createdAt: text(item.created_at) || text(item.createdAt),
      artifacts: Array.isArray(item.artifacts)
        ? item.artifacts.map((name) => (typeof name === 'string' ? name : text(name && name.name))).filter(Boolean)
        : [],
    })),
  });
}

async function handleHistory(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const session = sessionFrom(sessions, res, body);
    if (!session) return;

    const action = text(body.action) || 'list';
    const id = text(body.id).slice(0, MAX_ID_CHARS);
    const agent = resolveAgent(body, session);

    if (agent === ENTERPRISE_AGENT) {
      await handleEnterpriseHistory(res, session, action, id);
      return;
    }

    const capability = await ensureCapability(session, agent);
    const capabilityId = capability ? capability.capabilitySessionId : '';

    let suffix = '/conversations';
    let method = 'GET';
    if (action === 'messages') {
      if (!id) {
        sendJson(res, 400, { ok: false, message: '缺少会话标识' });
        return;
      }
      suffix = `/conversations/${encodeURIComponent(id)}/messages`;
    } else if (action === 'delete') {
      if (!id) {
        sendJson(res, 400, { ok: false, message: '缺少会话标识' });
        return;
      }
      suffix = `/conversations/${encodeURIComponent(id)}`;
      method = 'DELETE';
    } else if (action !== 'list') {
      sendJson(res, 400, { ok: false, message: `未知操作：${action}` });
      return;
    }

    let response;
    try {
      response = await backendFetch(agentUrlFor(session.settings, suffix, agent), {
        method,
        headers: agentHeaders(session, capabilityId),
        timeout: LOGIN_TIMEOUT_MS,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, session.settings.agentUrl) });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
      return;
    }

    const responseText = await response.text();
    const data = safeJson(responseText);
    if (!response.ok) {
      const message =
        (data && (text(data.message) || text(data.msg))) || `历史记录请求返回 ${response.status}`;
      sendJson(res, 200, { ok: false, message });
      return;
    }
    sendJson(res, 200, { ok: true, result: data });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `历史记录失败：${error && error.message ? error.message : error}` });
  }
}

/**
 * A business form submission travels as formId/formVersion/skillCode/formValues
 * plus an optional action code, exactly as the web app sends it.
 */
function readFormSubmission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const formId = text(raw.formId).slice(0, MAX_ID_CHARS);
  const skillCode = text(raw.skillCode).slice(0, MAX_ID_CHARS);
  const formVersion = Number(raw.formVersion);
  if (!formId || !skillCode || !Number.isInteger(formVersion) || formVersion < 1) return null;

  const formValues = {};
  if (raw.formValues && typeof raw.formValues === 'object' && !Array.isArray(raw.formValues)) {
    for (const [key, value] of Object.entries(raw.formValues)) {
      const code = String(key).trim().slice(0, MAX_ID_CHARS);
      if (!code || typeof value !== 'string') continue;
      if (Object.keys(formValues).length >= 200) break;
      formValues[code] = value.slice(0, 4000);
    }
  }

  const submission = { formId, formVersion, skillCode, formValues };
  const action = text(raw.action).slice(0, 60);
  if (action) submission.action = action;
  return submission;
}

async function handleFormOptions(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const session = sessionFrom(sessions, res, body);
    if (!session) return;

    const formId = text(body.formId).slice(0, MAX_ID_CHARS);
    const skillCode = text(body.skillCode).slice(0, MAX_ID_CHARS);
    const fieldCode = text(body.fieldCode).slice(0, MAX_ID_CHARS);
    const formVersion = Number(body.formVersion);
    if (!formId || !skillCode || !fieldCode || !Number.isInteger(formVersion)) {
      sendJson(res, 400, { ok: false, message: '表单参数不完整' });
      return;
    }

    const agent = resolveAgent(body, session);
    if (agent === ENTERPRISE_AGENT) {
      sendJson(res, 200, { ok: false, message: '该助手不支持业务表单' });
      return;
    }
    const capability = await ensureCapability(session, agent);
    const capabilityId = capability ? capability.capabilitySessionId : '';

    const payload = {
      conversationId: text(body.conversationId).slice(0, MAX_ID_CHARS),
      formId,
      formVersion,
      skillCode,
      fieldCode,
      capabilitySessionId: capabilityId,
    };
    const dependsOnValue = text(body.dependsOnValue).slice(0, 400);
    if (dependsOnValue) payload.dependsOnValue = dependsOnValue;

    let response;
    try {
      response = await backendFetch(agentUrlFor(session.settings, '/form-options', agent), {
        method: 'POST',
        headers: agentHeaders(session, capabilityId),
        body: JSON.stringify(payload),
        timeout: LOGIN_TIMEOUT_MS,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, session.settings.agentUrl) });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
      return;
    }

    const raw = await response.text();
    const data = safeJson(raw);
    if (!response.ok || !data) {
      const message =
        (data && (text(data.message) || text(data.msg) || text(data.detail))) ||
        `智能体服务返回 ${response.status}`;
      sendJson(res, 200, { ok: false, message });
      return;
    }
    sendJson(res, 200, { ok: true, result: data });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `加载选项失败：${error && error.message ? error.message : error}` });
  }
}

/**
 * Re-evaluates a business form after one of its fields changed (dependent
 * options, hidden sections, defaults). The agent answers with a fresh form.
 */
async function handleFormRefresh(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const session = sessionFrom(sessions, res, body);
    if (!session) return;

    const formId = text(body.formId).slice(0, MAX_ID_CHARS);
    const skillCode = text(body.skillCode).slice(0, MAX_ID_CHARS);
    const changedFieldCode = text(body.changedFieldCode).slice(0, MAX_ID_CHARS);
    const formVersion = Number(body.formVersion);
    if (!formId || !skillCode || !changedFieldCode || !Number.isInteger(formVersion)) {
      sendJson(res, 400, { ok: false, message: '表单参数不完整' });
      return;
    }

    const agent = resolveAgent(body, session);
    if (agent === ENTERPRISE_AGENT) {
      sendJson(res, 200, { ok: false, message: '该助手不支持业务表单' });
      return;
    }
    const capability = await ensureCapability(session, agent);
    const capabilityId = capability ? capability.capabilitySessionId : '';

    const formValues = {};
    const rawValues = body.formValues && typeof body.formValues === 'object' ? body.formValues : {};
    Object.keys(rawValues)
      .slice(0, 200)
      .forEach((key) => {
        const value = rawValues[key];
        if (value === null || value === undefined) return;
        formValues[String(key).slice(0, MAX_ID_CHARS)] = String(value).slice(0, 4000);
      });

    const payload = {
      conversationId: text(body.conversationId).slice(0, MAX_ID_CHARS),
      formId,
      formVersion,
      skillCode,
      changedFieldCode,
      formValues,
      capabilitySessionId: capabilityId,
    };

    let response;
    try {
      response = await backendFetch(agentUrlFor(session.settings, '/form-refresh', agent), {
        method: 'POST',
        headers: agentHeaders(session, capabilityId),
        body: JSON.stringify(payload),
        timeout: CHAT_TIMEOUT_MS,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, session.settings.agentUrl) });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
      return;
    }

    const raw = await response.text();
    const data = safeJson(raw);
    if (!response.ok || !data) {
      const message =
        (data && (text(data.message) || text(data.msg) || text(data.detail))) ||
        `智能体服务返回 ${response.status}`;
      sendJson(res, 200, { ok: false, message });
      return;
    }
    sendJson(res, 200, { ok: true, result: data });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `刷新表单失败：${error && error.message ? error.message : error}` });
  }
}

/**
 * Confirms or cancels the pending write action the agent is waiting on
 * ("确认并继续" / "暂不办理"). The agent answers with the next turn of the
 * conversation, so the caller can render it like any other answer.
 */
async function handleAction(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const session = sessionFrom(sessions, res, body);
    if (!session) return;

    const id = text(body.id).slice(0, MAX_ID_CHARS);
    const op = text(body.op) === 'cancel' ? 'cancel' : 'confirm';
    if (!id) {
      sendJson(res, 400, { ok: false, message: '缺少待确认动作编号' });
      return;
    }

    const agent = resolveAgent(body, session);
    if (agent === ENTERPRISE_AGENT) {
      sendJson(res, 200, { ok: false, message: '该助手不支持待确认动作' });
      return;
    }
    const capability = await ensureCapability(session, agent);
    const capabilityId = capability ? capability.capabilitySessionId : '';

    let response;
    try {
      response = await backendFetch(
        agentUrlFor(session.settings, `/actions/${encodeURIComponent(id)}/${op}`, agent),
        {
          method: 'POST',
          headers: agentHeaders(session, capabilityId),
          body: '{}',
          timeout: CHAT_TIMEOUT_MS,
        },
      );
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, session.settings.agentUrl) });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
      return;
    }

    const raw = await response.text();
    const data = safeJson(raw);
    if (!response.ok || !data) {
      const message =
        (data && (text(data.message) || text(data.msg) || text(data.detail))) ||
        `智能体服务返回 ${response.status}`;
      sendJson(res, 200, { ok: false, message });
      return;
    }
    sendJson(res, 200, { ok: true, result: data });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `办理失败：${error && error.message ? error.message : error}` });
  }
}

/**
 * Streams one generated artifact (docx/xlsx/md) back through the panel origin,
 * because a download link cannot carry the Authorization header the Python
 * service requires. The browser asks with a POST and turns the bytes into a
 * blob, so the login token never leaves the Host.
 */
async function handleArtifact(req, res, sessions) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;
    const session = sessionFrom(sessions, res, body);
    if (!session) return;

    const name = text(body.name);
    const conversationId = text(body.conversationId);
    if (!name || !conversationId) {
      sendJson(res, 200, { ok: false, message: '缺少下载文件信息' });
      return;
    }

    const url = `${enterpriseBase(session.settings)}/api/sessions/${encodeURIComponent(
      conversationId,
    )}/artifacts/${encodeURIComponent(name)}`;
    let response;
    try {
      response = await backendFetch(url, {
        method: 'GET',
        headers: enterpriseHeaders(session),
        timeout: CHAT_TIMEOUT_MS,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: describeNetworkError(error, url) });
      return;
    }

    if (response.status === 401 || response.status === 403) {
      sendJson(res, 200, { ok: false, reason: 'expired', message: '登录已失效，请重新登录' });
      return;
    }
    if (!response.ok) {
      const raw = await response.text();
      sendJson(res, 200, { ok: false, message: enterpriseMessage(safeJson(raw), response.status) });
      return;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      'content-type': response.headers.get('content-type') || 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    });
    res.end(bytes);
  } catch (error) {
    note('artifact-failed', { message: String(error && error.message ? error.message : error) });
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, message: '文件下载失败，请重试' });
    } else {
      try {
        res.end();
      } catch {
        /* the browser already dropped the connection */
      }
    }
  }
}

/**
 * Browser-side diagnostics for the panel: render failures, boot progress, and
 * request errors the user cannot report otherwise. The panel appends events and
 * reads the ring buffer back, so a blank panel still leaves a trace.
 */
async function handleDebug(req, res, log) {
  try {
    if (!admit(req, res)) return;
    const body = await readJson(req, res);
    if (!body) return;

    const op = text(body.op) || 'read';
    if (op === 'clear') {
      log.length = 0;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (op === 'append') {
      const events = Array.isArray(body.events) ? body.events : [body.event];
      for (const item of events) {
        if (!item || typeof item !== 'object') continue;
        log.push({
          at: new Date().toISOString(),
          kind: String(item.kind || 'log').slice(0, 40),
          detail: typeof item.detail === 'string' ? item.detail.slice(0, 4000) : JSON.stringify(item.detail ?? null).slice(0, 4000),
        });
      }
      while (log.length > 300) log.shift();
      sendJson(res, 200, { ok: true, size: log.length });
      return;
    }
    sendJson(res, 200, { ok: true, events: log.slice(-200) });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: `诊断失败：${error && error.message ? error.message : error}` });
  }
}

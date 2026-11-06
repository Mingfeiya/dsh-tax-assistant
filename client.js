window.__ModuleLoader__.load({
  id: 'dsh-tax-assistant',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    const NS = 'agent-chat';
    const API = '/agent-chat/api';
    const PROXY_HEADERS = { 'content-type': 'application/json', 'x-requested-with': 'agent-chat' };

    const STORE_SID = 'agent-chat.sid.v2';
    const STORE_SETTINGS = 'agent-chat.settings.v2';
    const STORE_CONVERSATIONS = 'agent-chat.conversations.v3';
    const STORE_AGENT = 'agent-chat.agent.v1';
    const STORE_USERNAME = 'agent-chat.username.v2';

    const DEFAULT_SETTINGS = {
      loginUrl: 'https://taxapi.ebmtax.com:4434/api/login/',
      agentUrl: 'http://www.ebmtax.com/agent-api',
      agentCode: 'business-agent',
      enterpriseUrl: 'http://127.0.0.1:2091',
      enterpriseEntry: 'general',
    };

    /** The four assistants the business system offers, in its display order. */
    const AGENTS = [
      { code: 'analysis-agent', nameKey: 'agentAnalysis', hintKey: 'agentHintAnalysis' },
      { code: 'business-agent', nameKey: 'agentBusiness', hintKey: 'agentHintBusiness' },
      { code: 'tax-qa-agent', nameKey: 'agentTax', hintKey: 'agentHintTax' },
      { code: 'enterprise-agent', nameKey: 'agentEnterprise', hintKey: 'agentHintEnterprise' },
    ];
    const DEFAULT_AGENT = 'business-agent';
    /** The Python assistant answers through the streaming route. */
    const ENTERPRISE_AGENT = 'enterprise-agent';

    function readAgent() {
      const stored = readText(STORE_AGENT);
      return AGENTS.some((item) => item.code === stored) ? stored : DEFAULT_AGENT;
    }

    function readConversations() {
      const stored = readJson(STORE_CONVERSATIONS, {});
      const map = {};
      for (const agent of AGENTS) {
        const value = stored[agent.code];
        if (typeof value === 'string' && value) map[agent.code] = value;
      }
      return map;
    }

    /* ------------------------------------------------------------------ *
     * Local storage helpers
     * ------------------------------------------------------------------ */

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage may be unavailable */
      }
    }

    function readText(key) {
      try {
        return window.localStorage.getItem(key) || '';
      } catch {
        return '';
      }
    }

    function writeText(key, value) {
      try {
        if (value) window.localStorage.setItem(key, value);
        else window.localStorage.removeItem(key);
      } catch {
        /* storage may be unavailable */
      }
    }

    function readSettings() {
      const stored = readJson(STORE_SETTINGS, {});
      return {
        loginUrl: typeof stored.loginUrl === 'string' && stored.loginUrl ? stored.loginUrl : DEFAULT_SETTINGS.loginUrl,
        agentUrl: typeof stored.agentUrl === 'string' && stored.agentUrl ? stored.agentUrl : DEFAULT_SETTINGS.agentUrl,
        agentCode:
          typeof stored.agentCode === 'string' && stored.agentCode ? stored.agentCode : DEFAULT_SETTINGS.agentCode,
        enterpriseUrl:
          typeof stored.enterpriseUrl === 'string' && stored.enterpriseUrl
            ? stored.enterpriseUrl
            : DEFAULT_SETTINGS.enterpriseUrl,
        enterpriseEntry:
          typeof stored.enterpriseEntry === 'string' && stored.enterpriseEntry
            ? stored.enterpriseEntry
            : DEFAULT_SETTINGS.enterpriseEntry,
      };
    }

    /* ------------------------------------------------------------------ *
     * Diagnostics
     * ------------------------------------------------------------------ */

    /** Fire-and-forget breadcrumb so a blank panel still leaves a Host trace. */
    function reportToHost(kind, detail) {
      try {
        void fetch(API + '/debug', {
          method: 'POST',
          headers: PROXY_HEADERS,
          body: JSON.stringify({ op: 'append', events: [{ kind, detail }] }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* diagnostics never break the panel */
      }
    }

    function describeError(error) {
      if (!error) return 'unknown';
      return {
        name: String(error.name || 'Error'),
        message: String(error.message || error),
        stack: String(error.stack || ''),
      };
    }

    /* ------------------------------------------------------------------ *
     * Proxy client
     * ------------------------------------------------------------------ */

    async function post(path, body, signal) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: PROXY_HEADERS,
        body: JSON.stringify(body || {}),
        signal: signal || undefined,
      });
      const raw = await response.text();
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }
      if (!data || typeof data !== 'object') {
        throw new Error(raw && raw.trim() ? raw.trim().slice(0, 200) : 'HTTP ' + response.status);
      }
      return data;
    }

    /**
     * POSTs a proxy route that answers either JSON (an error envelope) or raw
     * bytes (a produced file). Returns `{blob, filename}` on success and throws
     * a readable message otherwise.
     */
    async function postForFile(path, body, fallbackName) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: PROXY_HEADERS,
        body: JSON.stringify(body || {}),
      });
      const type = String(response.headers.get('content-type') || '');
      if (type.indexOf('application/json') !== -1) {
        const raw = await response.text();
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }
        const failure = new Error((data && data.message) || 'HTTP ' + response.status);
        failure.reason = data && data.reason ? data.reason : '';
        throw failure;
      }
      const disposition = String(response.headers.get('content-disposition') || '');
      const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition) || /filename="?([^";]+)"?/i.exec(disposition);
      let filename = fallbackName;
      if (match && match[1]) {
        try {
          filename = decodeURIComponent(match[1]);
        } catch {
          filename = match[1];
        }
      }
      return { blob: await response.blob(), filename };
    }

    /**
     * Streams one assistant turn. `onEvent` receives `{type: 'delta'|'progress'
     * |'tool'|'skill'|'company'|'meta'|'done'|'error'|'expired'}` frames; the
     * promise resolves with the final frame (`done` or `error`).
     */
    async function streamChat(body, onEvent, signal) {
      const response = await fetch(API + '/chat-stream', {
        method: 'POST',
        headers: PROXY_HEADERS,
        body: JSON.stringify(body || {}),
        signal: signal || undefined,
      });
      const type = String(response.headers.get('content-type') || '');
      if (type.indexOf('application/json') !== -1) {
        const raw = await response.text();
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }
        return data && typeof data === 'object' ? data : { ok: false, message: 'HTTP ' + response.status };
      }
      const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
      if (!reader) {
        const raw = await response.text();
        const frames = parseSseText(raw);
        frames.forEach((frame) => onEvent(frame));
        return frames.length ? frames[frames.length - 1] : { ok: false, message: '助手服务没有返回内容' };
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let last = null;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const frame of parseSseText(block)) {
            last = frame;
            onEvent(frame);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      return last || { ok: false, message: '助手服务没有返回内容' };
    }

    function parseSseText(raw) {
      const frames = [];
      for (const block of String(raw == null ? '' : raw).split(/\n\n+/)) {
        const payload = block
          .split(/\r?\n/)
          .filter((line) => line.indexOf('data:') === 0)
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed === 'object') frames.push(parsed);
        } catch {
          /* skip a half frame */
        }
      }
      return frames;
    }

    /** Hands a blob to the browser without leaving the panel. */
    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    /* ------------------------------------------------------------------ *
     * Markdown (escaped first, then a deliberately small subset)
     * ------------------------------------------------------------------ */

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function inlineMarkup(value) {
      return value
        .replace(/`([^`\n]+)`/g, (match, code) => '<code>' + code + '</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
          return '<a href="' + url + '" target="_blank" rel="noreferrer noopener">' + label + '</a>';
        })
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    }

    function splitRow(line) {
      let value = line.trim();
      if (value.startsWith('|')) value = value.slice(1);
      if (value.endsWith('|')) value = value.slice(0, -1);
      return value.split('|').map((cell) => cell.trim());
    }

    function isTableSeparator(line) {
      if (!line || line.indexOf('-') < 0) return false;
      const cells = splitRow(line);
      return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
    }

    function renderMarkdown(source) {
      const escaped = escapeHtml(source == null ? '' : String(source)).replace(/\r\n?/g, '\n');
      const lines = escaped.split('\n');
      const out = [];
      let paragraph = [];
      let index = 0;

      const flush = () => {
        if (!paragraph.length) return;
        out.push('<p>' + inlineMarkup(paragraph.join('\n')).replace(/\n/g, '<br />') + '</p>');
        paragraph = [];
      };

      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!trimmed) {
          flush();
          index += 1;
          continue;
        }

        if (/^```/.test(trimmed)) {
          flush();
          const fence = trimmed.replace(/^```/, '').trim();
          const buffer = [];
          index += 1;
          while (index < lines.length && !/^```/.test(lines[index].trim())) {
            buffer.push(lines[index]);
            index += 1;
          }
          index += 1;
          out.push('<pre><code>' + buffer.join('\n') + '</code></pre>');
          continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (heading) {
          flush();
          const level = heading[1].length <= 2 ? 3 : 4;
          out.push('<h' + level + '>' + inlineMarkup(heading[2]) + '</h' + level + '>');
          index += 1;
          continue;
        }

        if (trimmed.indexOf('|') >= 0 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
          flush();
          const head = splitRow(trimmed)
            .map((cell) => '<th>' + inlineMarkup(cell) + '</th>')
            .join('');
          const rows = [];
          index += 2;
          while (index < lines.length && lines[index].trim() && lines[index].indexOf('|') >= 0) {
            rows.push(
              '<tr>' +
                splitRow(lines[index])
                  .map((cell) => '<td>' + inlineMarkup(cell) + '</td>')
                  .join('') +
                '</tr>',
            );
            index += 1;
          }
          out.push(
            '<div class="ac-table"><table><thead><tr>' +
              head +
              '</tr></thead><tbody>' +
              rows.join('') +
              '</tbody></table></div>',
          );
          continue;
        }

        const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
        const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
        if (bullet || ordered) {
          flush();
          const tag = bullet ? 'ul' : 'ol';
          const pattern = bullet ? /^[-*+]\s+(.*)$/ : /^\d+[.)]\s+(.*)$/;
          const items = [];
          while (index < lines.length) {
            const match = pattern.exec(lines[index].trim());
            if (!match) break;
            items.push('<li>' + inlineMarkup(match[1]) + '</li>');
            index += 1;
          }
          out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
          continue;
        }

        if (/^&gt;\s?/.test(trimmed)) {
          flush();
          out.push('<blockquote>' + inlineMarkup(trimmed.replace(/^&gt;\s?/, '')) + '</blockquote>');
          index += 1;
          continue;
        }

        paragraph.push(trimmed);
        index += 1;
      }

      flush();
      return out.join('');
    }

    /* ------------------------------------------------------------------ *
     * Dictionaries
     * ------------------------------------------------------------------ */

    const DICTS = {
      zh: {
        panelTitle: '智税助手',
        agentAnalysis: '客服智能体',
        agentBusiness: '业务处理 AI',
        agentTax: '税务问答 AI',
        agentEnterprise: '通用业务助手',
        agentHintAnalysis: '系统操作指引、常见问题与知识解答',
        agentHintBusiness: '智能创建任务、跟进并辅助业务办理',
        agentHintTax: '税收政策查询、专业口径与知识解答',
        agentHintEnterprise: '理解业务需求，自动匹配可用能力',
        agentSwitch: '切换助手',
        enterpriseUrl: '通用助手接口',
        enterpriseEntry: '通用助手场景',
        loginTitle: '登录业务系统',
        loginHint: '使用税务师事务所经营管理系统的账号登录，登录后即可与业务智能体对话。',
        username: '账号',
        password: '密码',
        signIn: '登录',
        signingIn: '登录中…',
        loginFailed: '登录失败，请稍后重试',
        remember: '记住账号',
        advanced: '接口设置',
        advancedHint: '默认指向税务业务测试环境，切换环境时再修改。',
        loginUrl: '登录接口',
        agentUrl: '智能体接口',
        agentCode: '智能体编码',
        save: '保存',
        cancel: '取消',
        settings: '设置',
        settingsHint: '修改后需重新登录生效。',
        newChat: '新会话',
        history: '会话',
        logout: '退出',
        send: '发送',
        thinking: '思考中',
        stopWaiting: '停止等待',
        emptyTitle: '有什么可以帮你的吗？',
        emptyHint: '例如：帮我梳理一下本期涉税鉴证需要重点核查的事项。',
        placeholder: '给智税助手发送消息…',
        foot: 'Enter 发送 · Shift+Enter 换行',
        requestFailed: '本次请求没有完成，请重试',
        networkFailed: '无法连接 Harness 代理，请确认应用仍在运行',
        sessionExpired: '登录已失效，请重新登录',
        capabilityWarning: '助手能力初始化未完成',
        capabilityReady: '助手能力已就绪',
        historyTitle: '历史会话',
        historySub: '选择一个会话继续之前的对话',
        historyEmpty: '还没有历史会话',
        historyLoading: '加载中…',
        loadFailed: '历史记录加载失败',
        deleteConv: '删除',
        deleteConfirm: '删除这个会话？删除后不可恢复。',
        back: '返回',
        you: '我',
        assistant: '助手',
        toolsUsed: '本轮调用工具',
        knowledgeUsed: '已使用知识库',
        formRequired: '本轮需要补充业务表单，请到业务系统继续填写',
        formTitle: '补充业务信息',
        formDesc: '已收集的信息会自动填写，请补充必填内容。',
        formSubmit: '继续办理',
        submitting: '正在提交…',
        submitted: '已提交',
        formIncomplete: '请先补全表单中的必填内容',
        confirmTitle: '信息确认',
        confirmDesc: '请核对以下信息，确认后继续办理。',
        confirmContinue: '确认并继续',
        confirmCancel: '暂不办理',
        confirmBusy: '正在提交…',
        artifactsTitle: '成果文件',
        download: '下载',
        downloadBusy: '下载中…',
        downloadFailed: '文件下载失败，请稍后重试。',
        stepRunning: '正在{step}…',
        stepTool: '正在处理你的请求…',
        stepCompany: '需要先确认企业信息…',
        copy: '复制',
        copied: '已复制',
        noAnswer: '（本轮没有返回文字内容）',
        expiredTitle: '登录已失效',
        retry: '重新登录',
        convUntitled: '未命名会话',
        chars: '字',
      },
      en: {
        panelTitle: 'Smart tax assistant',
        agentAnalysis: 'Support agent',
        agentBusiness: 'Business AI',
        agentTax: 'Tax Q&A AI',
        agentEnterprise: 'General assistant',
        agentHintAnalysis: 'Product guidance, FAQs and knowledge answers',
        agentHintBusiness: 'Creates tasks and drives business handling',
        agentHintTax: 'Tax policy search and professional answers',
        agentHintEnterprise: 'Understands requests and matches capabilities',
        agentSwitch: 'Switch assistant',
        enterpriseUrl: 'General assistant endpoint',
        enterpriseEntry: 'General assistant entry',
        loginTitle: 'Sign in',
        loginHint: 'Sign in with your business account to chat with the agent.',
        username: 'Account',
        password: 'Password',
        signIn: 'Sign in',
        signingIn: 'Signing in…',
        loginFailed: 'Sign-in failed, please try again',
        remember: 'Remember account',
        advanced: 'Endpoints',
        advancedHint: 'Defaults point at the tax test environment.',
        loginUrl: 'Login endpoint',
        agentUrl: 'Agent endpoint',
        agentCode: 'Agent code',
        save: 'Save',
        cancel: 'Cancel',
        settings: 'Settings',
        settingsHint: 'Takes effect after the next sign-in.',
        newChat: 'New chat',
        history: 'Chats',
        logout: 'Sign out',
        send: 'Send',
        thinking: 'Thinking',
        stopWaiting: 'Stop waiting',
        emptyTitle: 'How can I help you today?',
        emptyHint: 'For example: what should I check first in this attestation task?',
        placeholder: 'Message the smart tax assistant…',
        foot: 'Enter to send · Shift+Enter for a new line',
        requestFailed: 'The request did not complete, please retry',
        networkFailed: 'Cannot reach the Harness proxy, is the app still running?',
        sessionExpired: 'Session expired, please sign in again',
        capabilityWarning: 'Assistant capabilities were not initialised',
        capabilityReady: 'capabilities ready',
        historyTitle: 'Previous chats',
        historySub: 'Pick a conversation to continue',
        historyEmpty: 'No previous chats yet',
        historyLoading: 'Loading…',
        loadFailed: 'Could not load the history',
        deleteConv: 'Delete',
        deleteConfirm: 'Delete this chat? This cannot be undone.',
        back: 'Back',
        you: 'You',
        assistant: 'Assistant',
        toolsUsed: 'Tools used',
        knowledgeUsed: 'Knowledge base used',
        formRequired: 'This turn needs a business form, please continue in the business system',
        formTitle: 'Additional details',
        formDesc: 'Collected values are filled in already — complete what is missing.',
        formSubmit: 'Continue',
        submitting: 'Submitting…',
        submitted: 'Submitted',
        formIncomplete: 'Please complete the required fields first',
        confirmTitle: 'Confirm details',
        confirmDesc: 'Check the details below, then continue.',
        confirmContinue: 'Confirm and continue',
        confirmCancel: 'Not now',
        confirmBusy: 'Submitting…',
        artifactsTitle: 'Generated files',
        download: 'Download',
        downloadBusy: 'Downloading…',
        downloadFailed: 'The file could not be downloaded. Please try again.',
        stepRunning: 'Working: {step}…',
        stepTool: 'Working on your request…',
        stepCompany: 'Company details are needed first…',
        copy: 'Copy',
        copied: 'Copied',
        noAnswer: '(no text in this turn)',
        expiredTitle: 'Session expired',
        retry: 'Sign in again',
        convUntitled: 'Untitled chat',
        chars: 'chars',
      },
    };

    function readActiveLocale(ctx) {
      try {
        const active = ctx.locale.getLocale ? ctx.locale.getLocale() : '';
        const id = active && typeof active === 'object' ? active.active || active.id || active.locale : active;
        return typeof id === 'string' ? id : '';
      } catch {
        return '';
      }
    }

    function registerDictionaries(ctx) {
      Object.keys(DICTS).forEach((locale) => {
        try {
          ctx.locale.register(NS, locale, DICTS[locale]);
        } catch {
          /* already registered */
        }
      });
      ['en-US', 'zh-CN', 'zh-Hans', 'zh-Hant'].forEach((locale) => {
        const base = locale.slice(0, 2);
        if (!DICTS[base]) return;
        try {
          ctx.locale.register(NS, locale, DICTS[base]);
        } catch {
          /* already registered */
        }
      });
      const activeId = readActiveLocale(ctx);
      if (activeId && !DICTS[activeId]) {
        const base = activeId.slice(0, 2);
        if (DICTS[base]) {
          try {
            ctx.locale.register(NS, activeId, DICTS[base]);
          } catch {
            /* locale service differences are not fatal */
          }
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    let messageSeed = 0;
    function nextMessageId(prefix) {
      messageSeed += 1;
      return (prefix || 'm') + '-' + Date.now().toString(36) + '-' + messageSeed;
    }

    function formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (input) => String(input).padStart(2, '0');
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function conversationTitle(item, t) {
      const title = item && typeof item.title === 'string' ? item.title.trim() : '';
      return title || t('convUntitled');
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function SidebarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = Boolean(props && props.active);
      const color = active ? 'var(--dsw-alias-brand-primary, #4f6bed)' : 'currentColor';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M20.5 11.6a6.4 6.4 0 0 1-6.4 6.4H9.2L4.8 21v-3.6a6.4 6.4 0 0 1-1.3-3.9V10.4A6.4 6.4 0 0 1 9.9 4h4.2a6.4 6.4 0 0 1 6.4 6.4z' }),
        h('path', { d: 'M9 11h.01M12 11h.01M15 11h.01' }),
      );
    }

    /** Upward arrow matching the chat send affordance, drawn rather than typed. */
    function SendIcon() {
      return h(
        'svg',
        {
          className: 'ac-icon-send',
          viewBox: '0 0 24 24',
          width: 18,
          height: 18,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M12 19.2V6.4M12 6.4 6.6 11.8M12 6.4l5.4 5.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** The stop glyph: a rounded square, like the chat app's interrupt control. */
    function StopIcon() {
      return h(
        'svg',
        {
          className: 'ac-icon-stop',
          viewBox: '0 0 24 24',
          width: 14,
          height: 14,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2.4, fill: 'currentColor' }),
      );
    }

    /** Back affordance for the history list: drawn, never a typed arrow. */
    function BackIcon() {
      return h(
        'svg',
        {
          className: 'ac-icon-back',
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M19.4 12H5.2M5.2 12l5.6-5.6M5.2 12l5.6 5.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function ThinkingRow({ t, seconds }) {
      return h(
        'div',
        { className: 'ac-msg ac-msg-assistant' },
        h(
          'div',
          { className: 'ac-bubble ac-bubble-thinking' },
          h('span', { className: 'ac-dots' }, h('i', null), h('i', null), h('i', null)),
          h('span', { className: 'ac-thinking-text' }, t('thinking') + (seconds >= 1 ? ' ' + seconds + 's' : '')),
        ),
      );
    }

    /** The write action the agent is waiting on: a confirm card, not a form. */
    function actionSummary(item) {
      const list = Array.isArray(item && item.confirmationSummary) ? item.confirmationSummary : [];
      return list
        .filter((row) => row && (row.label || row.value))
        .map((row) => ({
          label: String(row.label == null ? '' : row.label),
          value: String(row.value == null ? '' : row.value),
        }));
    }

    function ConfirmationCard({ t, item, busy, onDecide }) {
      const title = item.confirmationTitle || item.actionTitle || t('confirmTitle');
      const description = item.confirmationDescription || t('confirmDesc');
      const summary = actionSummary(item);
      return h(
        'div',
        { className: 'ac-action-card' },
        h(
          'div',
          { className: 'ac-action-head' },
          h('span', { className: 'ac-action-mark' }, '✓'),
          h(
            'div',
            { className: 'ac-action-text' },
            h('small', { className: 'ac-action-kicker' }, t('confirmTitle')),
            h('strong', { className: 'ac-action-title' }, title),
            h('p', { className: 'ac-action-desc' }, description),
          ),
        ),
        summary.length > 0
          ? h(
              'div',
              { className: 'ac-action-facts' },
              summary.map((row, index) =>
                h(
                  'div',
                  { key: 'fact-' + index, className: 'ac-action-fact' },
                  h('span', { className: 'ac-action-fact-label' }, row.label),
                  h('span', { className: 'ac-action-fact-value' }, row.value || '—'),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'ac-action-buttons' },
          h(
            'button',
            {
              type: 'button',
              className: 'ac-btn ac-btn-ghost',
              disabled: busy,
              onClick: () => onDecide(item, false),
            },
            t('confirmCancel'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ac-btn ac-btn-primary',
              disabled: busy,
              onClick: () => onDecide(item, true),
            },
            busy ? t('confirmBusy') : t('confirmContinue'),
          ),
        ),
      );
    }

    function ArtifactList({ t, items, busyName, onDownload }) {
      if (!items || !items.length) return null;
      return h(
        'div',
        { className: 'ac-artifacts' },
        h('div', { className: 'ac-artifacts-head' }, t('artifactsTitle')),
        items.map((name) =>
          h(
            'button',
            {
              key: name,
              type: 'button',
              className: 'ac-artifact',
              disabled: busyName === name,
              onClick: () => onDownload(name),
              title: name,
            },
            h('span', { className: 'ac-artifact-icon' }, artifactGlyph(name)),
            h('span', { className: 'ac-artifact-name' }, name),
            h('span', { className: 'ac-artifact-action' }, busyName === name ? t('downloadBusy') : t('download')),
          ),
        ),
      );
    }

    function artifactGlyph(name) {
      const extension = String(name || '').toLowerCase().split('.').pop();
      if (extension === 'docx' || extension === 'doc') return 'W';
      if (extension === 'xlsx' || extension === 'xls') return 'X';
      if (extension === 'pdf') return 'P';
      return 'M';
    }

    function MessageRow({ t, message, busy, busyAction, busyArtifact, onFormValue, onFormSubmit, onAction, onDownload }) {
      const isUser = message.role === 'user';
      const [copied, setCopied] = useState(false);
      const meta = message.meta || {};
      const footnotes = [];
      if (!isUser) {
        if (meta.tools > 0) footnotes.push(t('toolsUsed') + ' ' + meta.tools);
        if (meta.knowledgeUsed) footnotes.push(t('knowledgeUsed'));
      }
      const copy = () => {
        const content = String(message.content || '');
        if (!content) return;
        const done = () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        };
        try {
          const clipboard = navigator.clipboard;
          if (clipboard && typeof clipboard.writeText === 'function') {
            clipboard.writeText(content).then(done).catch(() => {});
          }
        } catch {
          /* clipboard is unavailable outside a secure context */
        }
      };
      return h(
        'div',
        { className: 'ac-msg ' + (isUser ? 'ac-msg-user' : 'ac-msg-assistant') },
        h(
          'div',
          { className: 'ac-msg-body' },
          h(
            'div',
            { className: isUser ? 'ac-bubble ac-bubble-user' : 'ac-bubble ac-bubble-assistant' },
            isUser
              ? h('div', { className: 'ac-plain' }, message.content)
              : message.streaming && !message.content
                ? h(
                    'div',
                    { className: 'ac-stream' },
                    h('span', { className: 'ac-dots' }, h('i', null), h('i', null), h('i', null)),
                    h('span', { className: 'ac-thinking-text' }, message.progress || t('thinking')),
                  )
                : h('div', { className: 'ac-md', dangerouslySetInnerHTML: { __html: renderMarkdown(message.content || '') } }),
            message.streaming && message.content && message.progress
              ? h('div', { className: 'ac-stream-note' }, message.progress)
              : null,
            footnotes.length > 0 ? h('div', { className: 'ac-msg-foot' }, footnotes.join(' · ')) : null,
            !isUser && !message.streaming && message.content
              ? h(
                  'div',
                  { className: 'ac-msg-tools' },
                  h(
                    'button',
                    { type: 'button', className: 'ac-tool-btn', onClick: copy },
                    copied ? t('copied') : t('copy'),
                  ),
                )
              : null,
          ),
          message.form && !isUser
            ? h(BusinessFormCard, {
                t,
                form: message.form,
                busy,
                onValue: (code, value) => onFormValue(message.id, code, value),
                onSubmit: (action) => onFormSubmit(message, action),
              })
            : null,
          message.artifacts && message.artifacts.length && !isUser
            ? h(ArtifactList, {
                t,
                items: message.artifacts,
                busyName: busyArtifact,
                onDownload: (name) => onDownload(message, name),
              })
            : null,
          message.actions && message.actions.length && !isUser
            ? h(
                'div',
                { className: 'ac-actions' },
                message.actions.map((item) =>
                  h(ConfirmationCard, {
                    key: item.id,
                    t,
                    item,
                    busy: busyAction === item.id,
                    onDecide: (target, accepted) => onAction(message, target, accepted),
                  }),
                ),
              )
            : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Business form (补参表单)
     * ------------------------------------------------------------------ */

    const INPUT_TYPE_BY_FIELD = {
      number: 'number',
      money: 'number',
      email: 'email',
      phone: 'tel',
      url: 'url',
      date: 'date',
      datetime: 'datetime-local',
    };

    const SELECT_LIKE = { select: true, 'tree-select': true, multiselect: true };

    function flattenOptionList(options, depth, out) {
      const list = Array.isArray(options) ? options : [];
      for (const option of list) {
        if (!option || option.value === undefined) continue;
        out.push({ value: String(option.value), label: String(option.label || option.value), depth });
        if (Array.isArray(option.children) && option.children.length) {
          flattenOptionList(option.children, depth + 1, out);
        }
      }
      return out;
    }

    function formFieldValue(field) {
      const value = field ? field.value : null;
      if (field && field.type === 'multiselect') {
        if (Array.isArray(value)) return value.map(String);
        if (typeof value === 'string' && value.trim()) return value.split(',').map((part) => part.trim()).filter(Boolean);
        return [];
      }
      if (field && field.type === 'checkbox') return value === true || value === 'true';
      if (value === null || value === undefined) return '';
      return String(value);
    }

    /** Wraps an API businessForm into the panel's editable form state. */
    function createFormState(raw, submitted) {
      if (!raw || typeof raw !== 'object') return null;
      const fields = Array.isArray(raw.fields) ? raw.fields : [];
      const values = {};
      fields.forEach((field) => {
        if (!field || !field.code) return;
        values[field.code] = formFieldValue(field);
      });
      return {
        data: raw,
        values,
        errors: {},
        submitting: false,
        submitted: Boolean(submitted),
        action: '',
      };
    }

    /** Option lists that the backend still has to resolve for a field. */
    function needsRemoteOptions(field) {
      if (!field || !field.code || !SELECT_LIKE[field.type]) return false;
      if (Array.isArray(field.options) && field.options.length > 0) return false;
      // Ask for the list even when the agent omitted optionSource: a select with
      // no option can never be completed, and the endpoint is keyed by fieldCode.
      return true;
    }

    /** Backends sometimes pre-fill a select with the label instead of the value. */
    function normalizeSelectValue(field, value) {
      if (!field || !SELECT_LIKE[field.type] || field.type === 'multiselect') return value;
      const text = String(value == null ? '' : value);
      if (!text) return value;
      const options = flattenOptionList(field.options, 0, []);
      if (options.length === 0) return value;
      if (options.some((option) => option.value === text)) return value;
      const byLabel = options.find((option) => option.label === text);
      return byLabel ? byLabel.value : value;
    }

    function formDisplayValue(field, value) {      if (field.type === 'checkbox') return value ? '是' : '';
      if (Array.isArray(value)) {
        const flat = flattenOptionList(field.options, 0, []);
        return value
          .map((item) => {
            const hit = flat.find((option) => option.value === item);
            return hit ? hit.label : item;
          })
          .join('、');
      }
      if (SELECT_LIKE[field.type] && value) {
        const hit = flattenOptionList(field.options, 0, []).find((option) => option.value === value);
        return hit ? hit.label : value;
      }
      return value;
    }

    function validateFormField(field, value) {
      const text = Array.isArray(value) ? value.join(',') : String(value == null ? '' : value);
      const empty = field.type === 'checkbox' ? value !== true : !text.trim();
      if (field.required && empty) {
        return (SELECT_LIKE[field.type] || field.type === 'radio' ? '请选择' : '请填写') + field.label;
      }
      if (empty) return '';
      const min = field.validation && field.validation.minLength != null ? field.validation.minLength : field.minLength;
      const max = field.validation && field.validation.maxLength != null ? field.validation.maxLength : field.maxLength;
      if (min != null && text.length < min) return field.label + '不能少于' + min + '个字符';
      if (max != null && text.length > max) return field.label + '不能超过' + max + '个字符';
      const pattern = (field.validation && field.validation.pattern) || field.pattern;
      if (pattern) {
        try {
          if (!new RegExp(pattern, 'u').test(text)) {
            return (field.validation && field.validation.message) || '请按格式填写' + field.label;
          }
        } catch {
          /* an invalid pattern coming from the backend must not block the user */
        }
      }
      if (SELECT_LIKE[field.type] && !field.type.includes('multi')) {
        const options = flattenOptionList(field.options, 0, []);
        // Only enforce membership when we actually have a list: a select whose
        // options are still loading must not block the submit.
        if (options.length && !options.some((option) => option.value === text)) {
          const byLabel = options.find((option) => option.label === text);
          if (!byLabel) return '请从' + field.label + '选项中选择';
        }
      }
      if ((field.type === 'number' || field.type === 'money') && !Number.isFinite(Number(text))) return '请输入有效的' + field.label;
      if (field.type === 'number' && !Number.isInteger(Number(text))) return field.label + '请输入整数';
      if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/u.test(text)) return '请选择有效的' + field.label;
      if (field.type === 'datetime' && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/u.test(text)) return '请选择有效的' + field.label;
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return '请输入有效的' + field.label;
      if (field.type === 'phone' && (!/^\+?[0-9()\-\s]{6,30}$/u.test(text) || (text.match(/\d/g) || []).length < 6)) return '请输入有效的' + field.label;
      if (field.type === 'url') {
        try {
          const url = new URL(text);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return '请输入有效的' + field.label;
        } catch {
          return '请输入有效的' + field.label;
        }
      }
      return '';
    }

    function FormControl({ field, value, disabled, onChange }) {
      const common = { disabled, className: 'ac-input' };
      if (field.type === 'textarea') {
        return h('textarea', {
          ...common,
          rows: 3,
          value,
          placeholder: field.placeholder || '请填写' + field.label,
          onChange: (event) => onChange(event.target.value),
        });
      }
      if (field.type === 'select' || field.type === 'tree-select') {
        const options = flattenOptionList(field.options, 0, []);
        // No option list (the agent could not resolve it): let the user type the
        // value instead of stranding them on an empty dropdown.
        if (options.length === 0) {
          return h('input', {
            ...common,
            type: 'text',
            value,
            placeholder: field.placeholder || '请填写' + field.label,
            onChange: (event) => onChange(event.target.value),
          });
        }
        return h(
          'select',
          { ...common, value, onChange: (event) => onChange(event.target.value) },
          h('option', { value: '' }, '请选择'),
          options.map((option) =>
            h('option', { key: option.value, value: option.value }, (option.depth ? '　'.repeat(option.depth) : '') + option.label),
          ),
        );
      }
      if (field.type === 'multiselect') {
        const options = flattenOptionList(field.options, 0, []);
        const selected = Array.isArray(value) ? value : [];
        return h(
          'div',
          { className: 'ac-checkgroup' },
          options.map((option) =>
            h(
              'label',
              { key: option.value, className: 'ac-check' },
              h('input', {
                type: 'checkbox',
                checked: selected.includes(option.value),
                disabled,
                onChange: (event) =>
                  onChange(
                    event.target.checked ? selected.concat([option.value]) : selected.filter((item) => item !== option.value),
                  ),
              }),
              h('span', null, option.label),
            ),
          ),
        );
      }
      if (field.type === 'radio') {
        const options = flattenOptionList(field.options, 0, []);
        return h(
          'div',
          { className: 'ac-checkgroup' },
          options.map((option) =>
            h(
              'label',
              { key: option.value, className: 'ac-check' },
              h('input', {
                type: 'radio',
                name: 'field-' + field.code,
                checked: value === option.value,
                disabled,
                onChange: () => onChange(option.value),
              }),
              h('span', null, option.label),
            ),
          ),
        );
      }
      if (field.type === 'checkbox') {
        return h(
          'label',
          { className: 'ac-check' },
          h('input', {
            type: 'checkbox',
            checked: value === true,
            disabled,
            onChange: (event) => onChange(event.target.checked),
          }),
          h('span', null, field.placeholder || '是'),
        );
      }
      if (field.type === 'file') {
        return h('div', { className: 'ac-hint' }, '附件请在业务系统中上传');
      }
      return h('input', {
        ...common,
        type: INPUT_TYPE_BY_FIELD[field.type] || 'text',
        step: field.type === 'money' ? '0.01' : field.type === 'number' ? '1' : undefined,
        value,
        placeholder: field.placeholder || '请填写' + field.label,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function BusinessFormCard({ t, form, busy, onValue, onSubmit }) {
      const data = form.data || {};
      const fields = Array.isArray(data.fields) ? data.fields : [];
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const disabled = form.submitting || form.submitted || busy;
      // A submitted form is history: show its values as text so it never looks
      // like an input the user could still edit.
      const readOnly = Boolean(form.submitted) && !form.submitting;
      const recognized = Array.isArray(data.recognizedValues) ? data.recognizedValues : [];

      return h(
        'form',
        {
          className: 'ac-form',
          onSubmit: (event) => {
            event.preventDefault();
            if (!disabled) onSubmit(actions.length ? (actions.find((item) => item.primary) || actions[0]).code : '');
          },
        },
        h(
          'div',
          { className: 'ac-form-head' },
          h('strong', null, data.title || t('formTitle')),
          h('p', null, data.description || t('formDesc')),
        ),
        recognized.length
          ? h(
              'div',
              { className: 'ac-form-facts' },
              recognized.map((item) =>
                h('span', { key: item.code }, h('em', null, item.label), ' ', String(item.value == null ? '' : item.value)),
              ),
            )
          : null,
        h(
          'div',
          { className: 'ac-form-fields' },
          readOnly
            ? fields
                .filter((field) => !field.sectionCode)
                .map((field) =>
                  h(
                    'div',
                    { key: field.code, className: 'ac-value-row' },
                    h('span', { className: 'ac-value-label' }, field.label),
                    h('span', { className: 'ac-value' }, formDisplayValue(field, form.values[field.code]) || '—'),
                  ),
                )
            : fields
                .filter((field) => !field.sectionCode)
                .map((field) => {
                  const error = form.errors[field.code];
                  const hint = !error && field.error ? String(field.error) : null;
                  return h(
                    'div',
                    { key: field.code, className: 'ac-field' + (error ? ' ac-field-error' : '') },
                    h(
                      'label',
                      { className: 'ac-field-label' },
                      field.label,
                      field.required ? h('span', { className: 'ac-required' }, '*') : null,
                    ),
                    h(FormControl, {
                      field,
                      value: form.values[field.code],
                      disabled,
                      onChange: (next) => onValue(field.code, next),
                    }),
                    error ? h('small', { className: 'ac-field-msg' }, error) : null,
                    hint ? h('small', { className: 'ac-field-hint' }, hint) : null,
                  );
                }),
        ),
        h(
          'div',
          { className: 'ac-form-actions' },
          readOnly
            ? h('span', { className: 'ac-badge' }, t('submitted'))
            : actions.length
              ? actions.map((action) =>
                  h(
                    'button',
                    {
                      key: action.code,
                      type: 'button',
                      className: action.primary ? 'ac-btn ac-btn-primary' : 'ac-btn',
                      disabled,
                      onClick: () => onSubmit(action.code),
                    },
                    action.label,
                  ),
                )
              : h(
                  'button',
                  { type: 'submit', className: 'ac-btn ac-btn-primary', disabled },
                  form.submitting ? t('submitting') : data.submitLabel || t('formSubmit'),
                ),
        ),
      );
    }

    /** Assistant picker: the web app's four agents, trimmed to a name + hint. */
    function AgentMenu({ t, agent, onSelect, disabled }) {
      const [open, setOpen] = useState(false);
      const boxRef = useRef(null);

      useEffect(() => {
        if (!open) return;
        const onDown = (event) => {
          const node = boxRef.current;
          if (node && event && node.contains && node.contains(event.target)) return;
          setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [open]);

      const current = AGENTS.find((item) => item.code === agent) || AGENTS[1];

      return h(
        'div',
        { className: 'ac-agent', ref: boxRef },
        h(
          'button',
          {
            type: 'button',
            className: 'ac-agent-btn',
            title: t('agentSwitch'),
            onClick: () => setOpen((value) => !value),
            disabled,
          },
          h('span', { className: 'ac-agent-name' }, t(current.nameKey)),
        ),
        open
          ? h(
              'div',
              { className: 'ac-agent-menu' },
              AGENTS.map((item) =>
                h(
                  'button',
                  {
                    key: item.code,
                    type: 'button',
                    className: 'ac-agent-item' + (item.code === agent ? ' ac-agent-item-active' : ''),
                    onClick: () => {
                      setOpen(false);
                      onSelect(item.code);
                    },
                  },
                  h('span', { className: 'ac-agent-item-name' }, t(item.nameKey)),
                  h('span', { className: 'ac-agent-item-hint' }, t(item.hintKey)),
                ),
              ),
            )
          : null,
      );
    }

    function Composer({ t, value, onChange, onSubmit, onStop, sending, notice }) {
      const areaRef = useRef(null);

      useEffect(() => {
        const area = areaRef.current;
        if (!area) return;
        area.style.height = 'auto';
        area.style.height = Math.min(160, Math.max(26, area.scrollHeight)) + 'px';
      }, [value]);

      return h(
        'div',
        { className: 'ac-composer' },
        notice ? h('div', { className: 'ac-notice' }, notice) : null,
        h(
          'div',
          { className: 'ac-composer-inner' },
          h('textarea', {
            ref: areaRef,
            className: 'ac-textarea',
            value,
            rows: 1,
            placeholder: t('placeholder'),
            onChange: (event) => onChange(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSubmit();
              }
            },
          }),
          sending
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ac-btn ac-btn-stop',
                  title: t('stopWaiting'),
                  'aria-label': t('stopWaiting'),
                  onClick: onStop,
                },
                h(StopIcon),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'ac-btn ac-btn-send',
                  title: t('send'),
                  'aria-label': t('send'),
                  onClick: onSubmit,
                  disabled: !value.trim(),
                },
                h(SendIcon),
              ),
        ),
        h('p', { className: 'ac-foot' }, t('foot')),
      );
    }

    function Field({ label, value, onChange, type, placeholder, onEnter }) {
      return h(
        'label',
        { className: 'ac-field' },
        h('span', { className: 'ac-label' }, label),
        h('input', {
          className: 'ac-input',
          type: type || 'text',
          value,
          placeholder: placeholder || '',
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && onEnter) {
              event.preventDefault();
              onEnter();
            }
          },
        }),
      );
    }

    function SettingsFields({ t, settings, onChange }) {
      return h(
        'div',
        { className: 'ac-fields' },
        h(Field, {
          label: t('loginUrl'),
          value: settings.loginUrl,
          onChange: (value) => onChange(Object.assign({}, settings, { loginUrl: value })),
        }),
        h(Field, {
          label: t('agentUrl'),
          value: settings.agentUrl,
          onChange: (value) => onChange(Object.assign({}, settings, { agentUrl: value })),
        }),
        h(Field, {
          label: t('agentCode'),
          value: settings.agentCode,
          onChange: (value) => onChange(Object.assign({}, settings, { agentCode: value })),
        }),
        h(Field, {
          label: t('enterpriseUrl'),
          value: settings.enterpriseUrl,
          onChange: (value) => onChange(Object.assign({}, settings, { enterpriseUrl: value })),
        }),
        h(Field, {
          label: t('enterpriseEntry'),
          value: settings.enterpriseEntry,
          onChange: (value) => onChange(Object.assign({}, settings, { enterpriseEntry: value })),
        }),
        h('p', { className: 'ac-hint' }, t('advancedHint')),
      );
    }

    function LoginView({ t, settings, onSettingsChange, onLogin, submitting, error, notice }) {
      const [username, setUsername] = useState(() => readText(STORE_USERNAME));
      const [password, setPassword] = useState('');
      const [showAdvanced, setShowAdvanced] = useState(false);
      const submit = () => {
        if (submitting) return;
        if (!username.trim() || !password) return;
        onLogin(username.trim(), password);
      };
      return h(
        'div',
        { className: 'ac-login' },
        h(
          'div',
          { className: 'ac-card' },
          h(
            'div',
            { className: 'ac-card-head' },
            h('div', { className: 'ac-card-icon' }, h(SidebarIcon, { size: 18 })),
            h('h2', { className: 'ac-card-title' }, t('loginTitle')),
          ),
          h('p', { className: 'ac-card-hint' }, t('loginHint')),
          notice ? h('p', { className: 'ac-hint' }, notice) : null,
          h(Field, { label: t('username'), value: username, onChange: setUsername, onEnter: submit }),
          h(Field, {
            label: t('password'),
            type: 'password',
            value: password,
            onChange: setPassword,
            onEnter: submit,
          }),
          error ? h('p', { className: 'ac-error' }, error) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'ac-btn ac-btn-primary ac-btn-block',
              onClick: submit,
              disabled: submitting || !username.trim() || !password,
            },
            submitting ? t('signingIn') : t('signIn'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ac-link',
              onClick: () => setShowAdvanced(!showAdvanced),
            },
            (showAdvanced ? '▾ ' : '▸ ') + t('advanced'),
          ),
          showAdvanced ? h(SettingsFields, { t, settings, onChange: onSettingsChange }) : null,
        ),
      );
    }

    function HistoryView({ t, items, loading, error, onBack, onOpen, onDelete }) {
      return h(
        'div',
        { className: 'ac-history' },
        h(
          'div',
          { className: 'ac-history-head' },
          h(
            'button',
            { type: 'button', className: 'ac-ghost ac-back', onClick: onBack, title: t('back'), 'aria-label': t('back') },
            h(BackIcon, null),
            h('span', null, t('back')),
          ),
        ),
        h(
          'div',
          { className: 'ac-history-body' },
          loading
            ? h('p', { className: 'ac-hint' }, t('historyLoading'))
            : error
              ? h('p', { className: 'ac-error' }, error)
              : items.length === 0
                ? h('p', { className: 'ac-hint' }, t('historyEmpty'))
                : items.map((item, index) =>
                    h(
                      'div',
                      { key: item.id || index, className: 'ac-conv' },
                      h(
                        'button',
                        { type: 'button', className: 'ac-conv-main', onClick: () => onOpen(item) },
                        h('span', { className: 'ac-conv-title' }, conversationTitle(item, t)),
                        h('span', { className: 'ac-conv-time' }, formatTime(item.updatedAt || item.createdAt)),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'ac-conv-del',
                          onClick: (event) => {
                            event.stopPropagation();
                            onDelete(item);
                          },
                        },
                        t('deleteConv'),
                      ),
                    ),
                  ),
        ),
      );
    }

    function ChatPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [settings, setSettings] = useState(readSettings);
      const [draftSettings, setDraftSettings] = useState(readSettings);
      const [phase, setPhase] = useState('boot');
      const [user, setUser] = useState(null);
      const [capability, setCapability] = useState(null);
      const [warning, setWarning] = useState('');
      const [view, setView] = useState('chat');
      const [messages, setMessages] = useState([]);
      const [agent, setAgent] = useState(readAgent);
      const [conversationId, setConversationId] = useState(() => readConversations()[readAgent()] || '');
      const [draft, setDraft] = useState('');
      const [sending, setSending] = useState(false);
      const [busyAction, setBusyAction] = useState('');
      const [busyArtifact, setBusyArtifact] = useState('');
      const [elapsed, setElapsed] = useState(0);
      const [notice, setNotice] = useState('');
      const [loginError, setLoginError] = useState('');
      const [loggingIn, setLoggingIn] = useState(false);
      const [historyItems, setHistoryItems] = useState([]);
      const [historyLoading, setHistoryLoading] = useState(false);
      const [historyError, setHistoryError] = useState('');

      const sidRef = useRef(readText(STORE_SID));
      const threadRef = useRef(null);
      const conversationRef = useRef(conversationId);
      const conversationsRef = useRef(readConversations());
      const agentRef = useRef(agent);
      const abortRef = useRef(null);
      const loadConversationRef = useRef(null);
      const messagesRef = useRef([]);

      useEffect(() => {
        reportToHost('panel-mounted', { phase: 'boot' });
      }, []);

      useEffect(() => {
        messagesRef.current = messages;
      }, [messages]);

      const cancelTurn = useCallback(() => {
        const controller = abortRef.current;
        abortRef.current = null;
        if (controller) {
          try {
            controller.abort();
          } catch {
            /* already finished */
          }
        }
        setSending(false);
      }, []);

      useEffect(() => {
        conversationRef.current = conversationId;
      }, [conversationId]);

      const applyConversation = useCallback((id) => {
        const next = id || '';
        conversationRef.current = next;
        setConversationId(next);
        const map = { ...conversationsRef.current };
        if (next) map[agentRef.current] = next;
        else delete map[agentRef.current];
        conversationsRef.current = map;
        writeJson(STORE_CONVERSATIONS, map);
      }, []);

      const switchAgent = useCallback(
        (code) => {
          if (!AGENTS.some((item) => item.code === code) || code === agentRef.current) {
            setView('chat');
            return;
          }
          agentRef.current = code;
          setAgent(code);
          writeText(STORE_AGENT, code);
          cancelTurn();
          setMessages([]);
          setNotice('');
          setCapability(null);
          setView('chat');
          const saved = conversationsRef.current[code] || '';
          conversationRef.current = saved;
          setConversationId(saved);
          if (saved && sidRef.current) void loadConversationRef.current(saved);
        },
        [cancelTurn],
      );

      const expire = useCallback(() => {
        sidRef.current = '';
        writeText(STORE_SID, '');
        setUser(null);
        setCapability(null);
        setWarning('');
        setPhase('login');
        setView('chat');
        setMessages([]);
        applyConversation('');
        setLoginError('');
        setNotice(t('sessionExpired'));
      }, [applyConversation, t]);

      /** Resolves remote option lists (optionSource) for the fields of a form. */
      const hydrateFormOptions = useCallback(
        async (messageId, formState) => {
          const sid = sidRef.current;
          if (!sid || !formState || !formState.data) return;
          const pending = (Array.isArray(formState.data.fields) ? formState.data.fields : []).filter(needsRemoteOptions);
          if (pending.length === 0) return;
          const resolved = {};
          for (const field of pending) {
            try {
              const data = await post('/form-options', {
                sid,
                agent: agentRef.current,
                conversationId: conversationRef.current || null,
                formId: formState.data.formId,
                formVersion: formState.data.formVersion,
                skillCode: formState.data.skillCode,
                fieldCode: field.code,
                dependsOnValue: field.activationField ? formState.values[field.activationField] : undefined,
              });
              if (data && data.ok !== false && data.result && Array.isArray(data.result.options) && data.result.options.length > 0) {
                resolved[field.code] = data.result.options;
              } else if (data && data.ok === false && data.reason === 'expired') {
                expire();
                return;
              } else if (data && data.ok === false) {
                reportToHost('form-options-rejected', { fieldCode: field.code, message: data.message || '' });
              }
            } catch (error) {
              /* the form still renders with an empty list */
              reportToHost('form-options-failed', { fieldCode: field.code, error: describeError(error) });
            }
          }
          if (Object.keys(resolved).length === 0) return;
          setMessages((previous) =>
            previous.map((message) => {
              if (message.id !== messageId || !message.form) return message;
              const fields = (Array.isArray(message.form.data.fields) ? message.form.data.fields : []).map((field) =>
                field && resolved[field.code] ? { ...field, options: resolved[field.code] } : field,
              );
              // Options just arrived: a value pre-filled as a label becomes its code.
              const values = { ...message.form.values };
              fields.forEach((field) => {
                if (field && resolved[field.code]) values[field.code] = normalizeSelectValue(field, values[field.code]);
              });
              return { ...message, form: { ...message.form, values, data: { ...message.form.data, fields } } };
            }),
          );
        },
        [],
      );

      const loadConversation = useCallback(
        async (id) => {
          if (!id || !sidRef.current) return;
          try {
            const data = await post('/history', {
              sid: sidRef.current,
              action: 'messages',
              id,
              agent: agentRef.current,
            });
            if (!data.ok) {
              if (data.reason === 'expired') {
                expire();
                return;
              }
              setNotice(data.message || t('loadFailed'));
              return;
            }
            const list = (Array.isArray(data.result) ? data.result : []).filter(
              (item) => item && (item.role === 'user' || item.role === 'assistant'),
            );
            // A stored form is only "done" when a later user turn submits it
            // ("补充业务信息：…"); otherwise it is still the pending step and must
            // stay editable after a reload.
            const isSubmissionTurn = (item) =>
              item.role === 'user' && typeof item.content === 'string' && item.content.indexOf('补充业务信息') === 0;
            const mapped = list.map((item, index) => {
              let form = null;
              if (item.role === 'assistant' && typeof item.businessFormJson === 'string' && item.businessFormJson) {
                let submitted = false;
                for (let next = index + 1; next < list.length; next += 1) {
                  if (list[next].role === 'assistant') break;
                  if (isSubmissionTurn(list[next])) {
                    submitted = true;
                    break;
                  }
                }
                try {
                  form = createFormState(JSON.parse(item.businessFormJson), submitted);
                } catch {
                  form = null;
                }
              }
              return {
                id: nextMessageId('h'),
                role: item.role,
                content: typeof item.content === 'string' ? item.content : '',
                at: Date.parse(item.createdAt) || Date.now(),
                meta: {},
                form,
                artifacts: Array.isArray(item.artifacts)
                  ? item.artifacts.filter((name) => typeof name === 'string' && name)
                  : [],
              };
            });
            setMessages(mapped);
            applyConversation(id);
            setNotice('');
            mapped.forEach((message) => {
              if (message.form) void hydrateFormOptions(message.id, message.form);
            });
          } catch (error) {
            setNotice(t('loadFailed'));
          }
        },
        [applyConversation, expire, hydrateFormOptions, t],
      );

      loadConversationRef.current = loadConversation;

      useEffect(() => {
        let cancelled = false;
        (async () => {
          const sid = sidRef.current;
          if (!sid) {
            setPhase('login');
            return;
          }
          try {
            const data = await post('/resume', { sid });
            if (cancelled) return;
            if (!data.ok) {
              sidRef.current = '';
              writeText(STORE_SID, '');
              setPhase('login');
              if (data.reason === 'expired') setNotice(t('sessionExpired'));
              return;
            }
            setUser(data.user || null);
            setCapability(data.capability || null);
            setWarning(data.warning || '');
            setPhase('chat');
            const savedConversation = conversationsRef.current[agentRef.current] || '';
            if (savedConversation) void loadConversation(savedConversation);
          } catch (error) {
            if (!cancelled) setPhase('login');
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [loadConversation, t]);

      useEffect(() => {
        if (!sending) {
          setElapsed(0);
          return;
        }
        const started = Date.now();
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(timer);
      }, [sending]);

      useEffect(() => {
        const node = threadRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
      }, [messages, sending, view]);

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && view !== 'chat') setView('chat');
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [view]);

      const login = useCallback(
        async (username, password) => {
          setLoggingIn(true);
          setLoginError('');
          setNotice('');
          try {
            const data = await post('/login', { username, password, settings });
            if (!data.ok) {
              setLoginError(data.message || t('loginFailed'));
              return;
            }
            sidRef.current = data.sid;
            writeText(STORE_SID, data.sid);
            writeText(STORE_USERNAME, username);
            setUser(data.user || null);
            setCapability(data.capability || null);
            setWarning(data.warning || '');
            setPhase('chat');
            setView('chat');
            const savedConversation = conversationRef.current;
            if (savedConversation) void loadConversation(savedConversation);
          } catch (error) {
            setLoginError(error && error.message ? error.message : t('networkFailed'));
          } finally {
            setLoggingIn(false);
          }
        },
        [loadConversation, settings, t],
      );

      const logout = useCallback(async () => {
        const sid = sidRef.current;
        cancelTurn();
        sidRef.current = '';
        writeText(STORE_SID, '');
        setUser(null);
        setCapability(null);
        setWarning('');
        setMessages([]);
        applyConversation('');
        setPhase('login');
        setView('chat');
        setNotice('');
        setLoginError('');
        if (sid) {
          try {
            await post('/logout', { sid });
          } catch {
            /* the local session is already gone */
          }
        }
      }, [applyConversation, cancelTurn]);

      /** Turns one agent answer into an assistant message, form included. */
      const appendResult = useCallback(
        (result) => {
          const answer = typeof result.answer === 'string' ? result.answer : '';
          const form = result.businessForm ? createFormState(result.businessForm, false) : null;
          // Write tools wait for a human: these become confirm cards under the answer.
          const actions = Array.isArray(result.pendingActions)
            ? result.pendingActions.filter((item) => item && item.status === 'PENDING' && item.confirmationRequired)
            : [];
          const message = {
            id: nextMessageId('a'),
            role: 'assistant',
            content: answer || t('noAnswer'),
            at: Date.now(),
            meta: {
              tools: Array.isArray(result.availableTools) ? result.availableTools.length : 0,
              knowledgeUsed: result.knowledgeUsed === true,
            },
            form,
            actions,
            artifacts: Array.isArray(result.artifacts)
              ? result.artifacts.filter((name) => typeof name === 'string' && name)
              : [],
          };
          setMessages((previous) => previous.concat([message]));
          if (result.conversationId) applyConversation(String(result.conversationId));
          if (form) void hydrateFormOptions(message.id, form);
        },
        [applyConversation, hydrateFormOptions, t],
      );

      /**
       * Confirms (or cancels) the pending write action. The agent answers with the
       * next turn of the conversation, so the result is appended like any answer
       * and the finished card is removed from its message.
       */
      const decideAction = useCallback(
        async (message, item, accepted) => {
          const sid = sidRef.current;
          if (!sid || !item || !item.id) {
            expire();
            return;
          }
          if (busyAction) return;
          setNotice('');
          setBusyAction(item.id);
          try {
            const data = await post('/action', {
              sid,
              agent: agentRef.current,
              op: accepted ? 'confirm' : 'cancel',
              id: item.id,
            });
            if (!data.ok) {
              if (data.reason === 'expired') {
                expire();
                return;
              }
              setNotice(data.message || t('requestFailed'));
              return;
            }
            setMessages((previous) =>
              previous.map((row) =>
                row.id === message.id && row.actions
                  ? { ...row, actions: row.actions.filter((entry) => entry.id !== item.id) }
                  : row,
              ),
            );
            appendResult(data.result && typeof data.result === 'object' ? data.result : {});
          } catch (error) {
            if (error && error.name === 'AbortError') return;
            setNotice(describeError(error).message || t('requestFailed'));
          } finally {
            setBusyAction('');
          }
        },
        [appendResult, busyAction, expire, t],
      );

      /**
       * Fetches one produced file through the Host and saves it with the name the
       * service assigned, so the user does not have to leave the panel.
       */
      const downloadArtifact = useCallback(
        async (message, name) => {
          const sid = sidRef.current;
          if (!sid) {
            expire();
            return;
          }
          if (!name || busyArtifact) return;
          setNotice('');
          setBusyArtifact(name);
          try {
            const file = await postForFile(
              '/artifact',
              {
                sid,
                agent: agentRef.current,
                conversationId: conversationRef.current || '',
                name,
              },
              name,
            );
            saveBlob(file.blob, file.filename || name);
          } catch (error) {
            if (error && error.reason === 'expired') {
              expire();
              return;
            }
            setNotice((error && error.message) || t('downloadFailed'));
          } finally {
            setBusyArtifact('');
          }
        },
        [busyArtifact, expire, t],
      );

      const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || sending) return;
        const sid = sidRef.current;
        if (!sid) {
          expire();
          return;
        }
        const agent = agentRef.current;
        setDraft('');
        setNotice('');
        setMessages((previous) => previous.concat([{ id: nextMessageId('u'), role: 'user', content: text, at: Date.now() }]));
        setSending(true);
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current = controller;
        const signal = controller ? controller.signal : undefined;
        try {
          // The generic assistant answers once; the Python one streams its answer,
          // so its turn is rendered while it is being written.
          if (agent === ENTERPRISE_AGENT) {
            const replyId = nextMessageId('a');
            setMessages((previous) =>
              previous.concat([
                { id: replyId, role: 'assistant', content: '', at: Date.now(), meta: {}, streaming: true, progress: '' },
              ]),
            );
            const patch = (changes) =>
              setMessages((previous) =>
                previous.map((message) => (message.id === replyId ? { ...message, ...changes } : message)),
              );
            const final = await streamChat(
              { sid, agent, conversationId: conversationRef.current || null, message: text },
              (event) => {
                if (event.type === 'delta') {
                  setMessages((previous) =>
                    previous.map((message) =>
                      message.id === replyId
                        ? { ...message, content: (message.content || '') + event.text, progress: '' }
                        : message,
                    ),
                  );
                  return;
                }
                if (event.type === 'progress') {
                  const label = event.title ? t('stepRunning').replace('{step}', event.title) : '';
                  if (label) patch({ progress: label });
                  return;
                }
                if (event.type === 'tool') patch({ progress: t('stepTool') });
                if (event.type === 'company') patch({ progress: t('stepCompany') });
                if (event.type === 'meta' && event.conversationId) applyConversation(String(event.conversationId));
              },
              signal,
            );
            if (final && final.type === 'expired') {
              expire();
              return;
            }
            if (final && final.type === 'error') {
              patch({ streaming: false, progress: '' });
              setNotice(final.message || t('requestFailed'));
              return;
            }
            patch({
              streaming: false,
              progress: '',
              content: (final && final.answer) || t('noAnswer'),
              artifacts: final && Array.isArray(final.artifacts) ? final.artifacts : [],
            });
            return;
          }
          const data = await post(
            '/chat',
            { sid, agent, conversationId: conversationRef.current || null, message: text },
            signal,
          );
          if (!data.ok) {
            if (data.reason === 'expired') {
              expire();
              return;
            }
            setNotice(data.message || t('requestFailed'));
            return;
          }
          appendResult(data.result && typeof data.result === 'object' ? data.result : {});
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          setNotice(t('requestFailed'));
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          setSending(false);
        }
      }, [appendResult, applyConversation, draft, expire, sending, t]);

      /** Field edit inside a business form. */
      /** Re-evaluates a form after a field marked refreshFormOnChange changes. */
      const refreshForm = useCallback(async (messageId, formState, changedFieldCode, values) => {
        const sid = sidRef.current;
        if (!sid || !formState || !formState.data) return;
        const formValues = {};
        Object.keys(values || {}).forEach((code) => {
          const value = values[code];
          const flat = Array.isArray(value) ? value.join(',') : typeof value === 'boolean' ? (value ? 'true' : '') : String(value == null ? '' : value);
          if (flat) formValues[code] = flat;
        });
        try {
          const data = await post('/form-refresh', {
            sid,
            agent: agentRef.current,
            conversationId: conversationRef.current || null,
            formId: formState.data.formId,
            formVersion: formState.data.formVersion,
            skillCode: formState.data.skillCode,
            changedFieldCode,
            formValues,
          });
          if (!data || data.ok === false) return;
          const next = createFormState(data.result && data.result.fields ? data.result : data.result && data.result.businessForm, false);
          if (!next) return;
          setMessages((previous) =>
            previous.map((message) => {
              if (message.id !== messageId || !message.form) return message;
              const merged = { ...next.values };
              // Keep what the user already typed when the refresh leaves a field blank.
              Object.keys(merged).forEach((code) => {
                if ((merged[code] === '' || (Array.isArray(merged[code]) && merged[code].length === 0)) && formState.values[code] !== undefined) {
                  merged[code] = formState.values[code];
                }
              });
              return { ...message, form: { ...next, values: merged, submitted: false } };
            }),
          );
          void hydrateFormOptions(messageId, next);
        } catch {
          /* keep the current form when the refresh fails */
        }
      }, [hydrateFormOptions]);

      const updateFormValue = useCallback(
        (messageId, code, value) => {
          const current = messagesRef.current.find((message) => message.id === messageId);
          const formState = current && current.form;
          const field =
            formState && Array.isArray(formState.data.fields)
              ? formState.data.fields.find((item) => item && item.code === code)
              : null;
          const nextValues = formState ? { ...formState.values, [code]: value } : {};
          setMessages((previous) =>
            previous.map((message) => {
              if (message.id !== messageId || !message.form) return message;
              const errors = { ...message.form.errors };
              delete errors[code];
              return {
                ...message,
                form: { ...message.form, values: { ...message.form.values, [code]: value }, errors },
              };
            }),
          );
          if (field && field.refreshFormOnChange && formState) {
            void refreshForm(messageId, formState, code, nextValues);
          }
        },
        [refreshForm],
      );

      /** Submits a business form back into the same conversation. */
      const submitForm = useCallback(
        async (message, action) => {
          const form = message && message.form;
          if (!form || form.submitted || form.submitting || sending) return;
          const sid = sidRef.current;
          if (!sid) {
            expire();
            return;
          }
          const fields = (Array.isArray(form.data.fields) ? form.data.fields : []).filter(
            (field) => field && field.code && !field.sectionCode,
          );
          const errors = {};
          fields.forEach((field) => {
            if (field.type === 'file') return;
            const error = validateFormField(field, form.values[field.code]);
            if (error) errors[field.code] = error;
          });
          if (Object.keys(errors).length > 0) {
            setMessages((previous) =>
              previous.map((item) => (item.id === message.id ? { ...item, form: { ...item.form, errors } } : item)),
            );
            setNotice(t('formIncomplete'));
            return;
          }

          const formValues = {};
          const lines = [];
          fields.forEach((field) => {
            if (field.type === 'file') return;
            const value = form.values[field.code];
            const flat = Array.isArray(value) ? value.join(',') : field.type === 'checkbox' ? (value ? 'true' : '') : String(value == null ? '' : value);
            if (!flat) return;
            formValues[field.code] = flat;
            const shown = formDisplayValue(field, value);
            if (shown) lines.push(field.label + '：' + shown);
          });
          if (Object.keys(formValues).length === 0) {
            setNotice(t('formIncomplete'));
            return;
          }

          const sentText = '补充业务信息：\n' + lines.join('\n');
          setMessages((previous) =>
            previous.concat([{ id: nextMessageId('u'), role: 'user', content: sentText, at: Date.now(), meta: {} }]).map((item) =>
              item.id === message.id ? { ...item, form: { ...item.form, submitting: true, errors: {} } } : item,
            ),
          );
          setNotice('');
          setSending(true);
          try {
            const data = await post('/chat', {
              sid,
              agent: agentRef.current,
              conversationId: conversationRef.current || null,
              message: sentText,
              form: {
                formId: form.data.formId,
                formVersion: form.data.formVersion,
                skillCode: form.data.skillCode,
                formValues,
                action: action || undefined,
              },
            });
            setMessages((previous) =>
              previous.map((item) =>
                item.id === message.id && item.form
                  ? { ...item, form: { ...item.form, submitting: false, submitted: Boolean(data.ok) } }
                  : item,
              ),
            );
            if (!data.ok) {
              if (data.reason === 'expired') {
                expire();
                return;
              }
              setNotice(data.message || t('requestFailed'));
              return;
            }
            appendResult(data.result && typeof data.result === 'object' ? data.result : {});
          } catch (error) {
            setMessages((previous) =>
              previous.map((item) =>
                item.id === message.id && item.form ? { ...item, form: { ...item.form, submitting: false } } : item,
              ),
            );
            setNotice(t('requestFailed'));
          } finally {
            setSending(false);
          }
        },
        [appendResult, expire, sending, t],
      );

      const newChat = useCallback(() => {
        cancelTurn();
        setMessages([]);
        setNotice('');
        applyConversation('');
        setView('chat');
      }, [applyConversation, cancelTurn]);

      const openHistory = useCallback(async () => {
        setView('history');
        setHistoryLoading(true);
        setHistoryError('');
        try {
          const data = await post('/history', { sid: sidRef.current, action: 'list', agent: agentRef.current });
          if (!data.ok) {
            if (data.reason === 'expired') {
              expire();
              return;
            }
            setHistoryError(data.message || t('loadFailed'));
            return;
          }
          setHistoryItems(Array.isArray(data.result) ? data.result : []);
        } catch (error) {
          setHistoryError(t('loadFailed'));
        } finally {
          setHistoryLoading(false);
        }
      }, [expire, t]);

      const deleteConversation = useCallback(
        async (item) => {
          if (!item || !item.id) return;
          const confirmed = typeof window.confirm === 'function' ? window.confirm(t('deleteConfirm')) : true;
          if (!confirmed) return;
          try {
            const data = await post('/history', {
              sid: sidRef.current,
              action: 'delete',
              id: item.id,
              agent: agentRef.current,
            });
            if (!data.ok) {
              if (data.reason === 'expired') {
                expire();
                return;
              }
              setHistoryError(data.message || t('loadFailed'));
              return;
            }
            setHistoryItems((previous) => previous.filter((entry) => entry.id !== item.id));
            if (conversationRef.current === item.id) {
              setMessages([]);
              applyConversation('');
            }
          } catch (error) {
            setHistoryError(t('loadFailed'));
          }
        },
        [applyConversation, expire, t],
      );

      const commitSettings = useCallback(
        (next) => {
          const cleaned = {
            loginUrl: (next.loginUrl || '').trim() || DEFAULT_SETTINGS.loginUrl,
            agentUrl: (next.agentUrl || '').trim() || DEFAULT_SETTINGS.agentUrl,
            agentCode: (next.agentCode || '').trim() || DEFAULT_SETTINGS.agentCode,
            enterpriseUrl: (next.enterpriseUrl || '').trim() || DEFAULT_SETTINGS.enterpriseUrl,
            enterpriseEntry: (next.enterpriseEntry || '').trim() || DEFAULT_SETTINGS.enterpriseEntry,
          };
          setSettings(cleaned);
          setDraftSettings(cleaned);
          writeJson(STORE_SETTINGS, cleaned);
          setView('chat');
        },
        [],
      );

      const header = (title, subtitle) =>
        h(
          'header',
          { className: 'ac-head' },
          h(
            'div',
            { className: 'ac-head-text' },
            h('h1', { className: 'ac-title' }, title),
            subtitle ? h('p', { className: 'ac-sub' }, subtitle) : null,
          ),
          phase === 'chat'
            ? h('div', { className: 'ac-head-center' }, h(AgentMenu, { t, agent, onSelect: switchAgent, disabled: sending }))
            : null,
          phase === 'chat'
            ? h(
                'div',
                { className: 'ac-head-actions' },
                h('button', { type: 'button', className: 'ac-ghost', onClick: newChat, disabled: sending }, t('newChat')),
                h('button', { type: 'button', className: 'ac-ghost', onClick: openHistory, disabled: sending }, t('history')),
                h('button', { type: 'button', className: 'ac-ghost', onClick: () => setView('settings') }, t('settings')),
                h('button', { type: 'button', className: 'ac-ghost', onClick: logout }, t('logout')),
              )
            : null,
        );

      if (phase === 'boot') {
        return h(
          'div',
          { className: 'ac-root' },
          h('style', null, CSS),
          h('div', { className: 'ac-login' }, h('p', { className: 'ac-hint' }, t('historyLoading'))),
        );
      }

      if (phase === 'login') {
        return h(
          'div',
          { className: 'ac-root' },
          h('style', null, CSS),
          h(LoginView, {
            t,
            settings: draftSettings,
            onSettingsChange: setDraftSettings,
            submitting: loggingIn,
            error: loginError,
            notice,
            onLogin: (username, password) => {
              if (
                settings.loginUrl !== draftSettings.loginUrl ||
                settings.agentUrl !== draftSettings.agentUrl ||
                settings.agentCode !== draftSettings.agentCode ||
                settings.enterpriseUrl !== draftSettings.enterpriseUrl ||
                settings.enterpriseEntry !== draftSettings.enterpriseEntry
              ) {
                const cleaned = {
                  loginUrl: draftSettings.loginUrl.trim() || DEFAULT_SETTINGS.loginUrl,
                  agentUrl: draftSettings.agentUrl.trim() || DEFAULT_SETTINGS.agentUrl,
                  agentCode: draftSettings.agentCode.trim() || DEFAULT_SETTINGS.agentCode,
                  enterpriseUrl: draftSettings.enterpriseUrl.trim() || DEFAULT_SETTINGS.enterpriseUrl,
                  enterpriseEntry: draftSettings.enterpriseEntry.trim() || DEFAULT_SETTINGS.enterpriseEntry,
                };
                setSettings(cleaned);
                writeJson(STORE_SETTINGS, cleaned);
              }
              void login(username, password);
            },
          }),
        );
      }

      if (view === 'settings') {
        return h(
          'div',
          { className: 'ac-root' },
          h('style', null, CSS),
          header(t('settings'), t('settingsHint')),
          h(
            'div',
            { className: 'ac-settings' },
            h(SettingsFields, { t, settings: draftSettings, onChange: setDraftSettings }),
            h(
              'div',
              { className: 'ac-settings-actions' },
              h('button', { type: 'button', className: 'ac-btn ac-btn-primary', onClick: () => commitSettings(draftSettings) }, t('save')),
              h('button', { type: 'button', className: 'ac-ghost', onClick: () => setView('chat') }, t('cancel')),
            ),
          ),
        );
      }

      if (view === 'history') {
        return h(
          'div',
          { className: 'ac-root' },
          h('style', null, CSS),
          header(t('historyTitle'), t('historySub')),
          h(HistoryView, {
            t,
            items: historyItems,
            loading: historyLoading,
            error: historyError,
            onBack: () => setView('chat'),
            onOpen: (item) => {
              setView('chat');
              void loadConversation(item.id);
            },
            onDelete: deleteConversation,
          }),
        );
      }

      const subtitle = [user && user.name ? user.name : '', capability && capability.toolCount > 0 ? t('capabilityReady') : '']
        .filter(Boolean)
        .join(' · ');

      return h(
        'div',
        { className: 'ac-root' },
        h('style', null, CSS),
        header(t('panelTitle'), subtitle),
        warning ? h('div', { className: 'ac-warn' }, warning) : null,
        h(
          'div',
          { className: 'ac-thread', ref: threadRef },
          messages.length === 0 && !sending
            ? h(
                'div',
                { className: 'ac-empty' },
                h('div', { className: 'ac-empty-icon' }, h(SidebarIcon, { size: 22 })),
                h('p', { className: 'ac-empty-title' }, t('emptyTitle')),
                h('p', { className: 'ac-empty-hint' }, t('emptyHint')),
              )
            : h(
                'div',
                { className: 'ac-thread-inner' },
                messages.map((message) =>
                  h(MessageRow, {
                    key: message.id,
                    t,
                    message,
                    busy: Boolean(message.form && message.form.submitting),
                    busyAction,
                    busyArtifact,
                    onFormValue: updateFormValue,
                    onFormSubmit: submitForm,
                    onAction: decideAction,
                    onDownload: downloadArtifact,
                  }),
                ),
                sending && !messages.some((message) => message.streaming)
                  ? h(ThinkingRow, { t, seconds: elapsed })
                  : null,
              ),
        ),
        h(Composer, {
          t,
          value: draft,
          onChange: (value) => {
            setDraft(value);
            if (notice) setNotice('');
          },
          onSubmit: () => {
            void send();
          },
          onStop: cancelTurn,
          sending,
          notice,
        }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
      .ac-root {
        --ac-radius: 12px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--dsw-alias-bg-base, #ffffff);
        color: var(--dsw-alias-label-primary, #1f2329);
        font-size: 13.5px;
        line-height: 1.6;
      }
      .ac-root *, .ac-root *::before, .ac-root *::after { box-sizing: border-box; }
      .ac-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 13px 18px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        flex: 0 0 auto;
        position: relative;
        z-index: 6;
      }
      .ac-head-text { min-width: 0; }
      .ac-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
      .ac-sub {
        margin: 2px 0 0;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #646a73);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ac-head-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
      .ac-head-center {
        flex: 1 1 auto;
        display: flex;
        justify-content: center;
        min-width: 0;
        position: relative;
      }
      .ac-agent { position: relative; max-width: 100%; }
      .ac-agent-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        border: 1px solid var(--dsw-alias-border-l2, #d5d8dd);
        background: var(--dsw-alias-bg-layer-1, #f7f8fa);
        color: var(--dsw-alias-label-primary, #1f2329);
        font: inherit;
        font-size: 12.5px;
        padding: 5px 11px;
        border-radius: 999px;
        cursor: pointer;
      }
      .ac-agent-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4b6ef5); }
      .ac-agent-btn:disabled { opacity: 0.6; cursor: default; }
      .ac-agent-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-agent-menu {
        position: absolute;
        top: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 60;
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 282px;
        padding: 8px;
        border-radius: 14px;
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        background: var(--dsw-alias-bg-overlay, #ffffff);
        box-shadow: 0 16px 38px rgba(15, 23, 42, 0.16);
      }
      .ac-agent-item {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 3px;
        width: 100%;
        text-align: left;
        font: inherit;
        line-height: 1.35;
        padding: 10px 12px;
        border: 1px solid transparent;
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1, #fafbfc);
        cursor: pointer;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      .ac-agent-item:hover {
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        border-color: var(--dsw-alias-border-l2, #dcdfe3);
      }
      .ac-agent-item-active {
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        border-color: var(--dsw-alias-brand-primary, #4b6ef5);
      }
      .ac-agent-item-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #1f2329);
      }
      .ac-agent-item-hint {
        margin-top: 1px;
        font-size: 11.5px;
        color: var(--dsw-alias-label-secondary, #646a73);
        line-height: 1.5;
      }
      .ac-ghost {
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #646a73);
        font: inherit;
        font-size: 12.5px;
        padding: 5px 9px;
        border-radius: 7px;
        cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease;
      }
      .ac-ghost:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2329);
      }
      .ac-ghost:disabled { opacity: 0.45; cursor: default; }
      .ac-warn {
        margin: 8px 18px 0;
        padding: 8px 11px;
        border-radius: 9px;
        font-size: 12px;
        color: var(--dsw-alias-state-warn-primary, #ad6800);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #faad14) 12%, transparent);
      }
      .ac-thread { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 18px 18px 6px; }
      .ac-thread-inner { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
      .ac-msg { display: flex; gap: 10px; align-items: flex-start; }
      .ac-msg-user { flex-direction: row-reverse; }
      .ac-msg-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
        flex: 1 1 auto;
        align-items: flex-start;
      }
      .ac-msg-user .ac-msg-body { align-items: flex-end; }
      .ac-form {
        width: 100%;
        max-width: min(100%, 640px);
        box-sizing: border-box;
        padding: 12px 14px;
        border-radius: var(--ac-radius);
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        background: var(--dsw-alias-bg-layer-1, #f7f8fa);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .ac-form-head strong { font-size: 13px; }
      .ac-form-head p {
        margin: 4px 0 0;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #646a73);
      }
      .ac-form-facts { display: flex; flex-wrap: wrap; gap: 6px; }
      .ac-form-facts span {
        font-size: 11.5px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        background: var(--dsw-alias-bg-base, #ffffff);
        color: var(--dsw-alias-label-secondary, #646a73);
      }
      .ac-form-facts em { font-style: normal; opacity: 0.7; margin-right: 3px; }
      .ac-form-fields { display: flex; flex-direction: column; gap: 9px; }
      .ac-field { display: flex; flex-direction: column; gap: 4px; }
      .ac-field-label {
        font-size: 12px;
        color: var(--dsw-alias-label-primary, #1f2329);
        display: flex;
        gap: 3px;
        align-items: center;
      }
      .ac-required { color: var(--dsw-alias-state-error-primary, #d83931); }
      .ac-input {
        box-sizing: border-box;
        width: 100%;
        padding: 6px 9px;
        font: inherit;
        font-size: 12.5px;
        color: var(--dsw-alias-label-primary, #1f2329);
        background: var(--dsw-alias-bg-base, #ffffff);
        border: 1px solid var(--dsw-alias-border-l2, #dcdfe3);
        border-radius: 8px;
        outline: none;
      }
      .ac-input:focus { border-color: var(--dsw-alias-brand-primary, #4f6bed); }
      .ac-input:disabled { opacity: 0.7; }
      .ac-field-error .ac-input { border-color: var(--dsw-alias-state-error-primary, #d83931); }
      .ac-field-msg { color: var(--dsw-alias-state-error-primary, #d83931); font-size: 11.5px; }
      .ac-field-hint { color: var(--dsw-alias-state-warn-primary, #b7791f); font-size: 11.5px; }
      .ac-checkgroup { display: flex; flex-wrap: wrap; gap: 10px; }
      .ac-check {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 12.5px;
        cursor: pointer;
      }
      .ac-check input { margin: 0; }
      .ac-form-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        padding-top: 2px;
      }
      .ac-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-value-row {
        display: flex;
        gap: 10px;
        font-size: 12.5px;
        padding: 2px 0;
      }
      .ac-value-label {
        flex: 0 0 96px;
        color: var(--dsw-alias-label-secondary, #646a73);
      }
      .ac-value {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--dsw-alias-label-primary, #1f2329);
        overflow-wrap: anywhere;
      }
      .ac-badge {
        font-size: 11.5px;
        padding: 3px 10px;
        border-radius: 999px;
        color: var(--dsw-alias-state-success-primary, #2ba471);
        border: 1px solid var(--dsw-alias-state-success-primary, #2ba471);
      }
      .ac-avatar {
        flex: 0 0 auto;
        width: 26px; height: 26px;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 10px; font-weight: 600; letter-spacing: 0.02em;
        color: var(--dsw-alias-label-secondary, #646a73);
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        margin-top: 2px;
      }
      .ac-msg-user .ac-avatar {
        color: #fff;
        background: var(--dsw-alias-brand-primary, #4f6bed);
        border-color: transparent;
      }
      .ac-bubble {
        max-width: min(78%, 640px);
        padding: 9px 13px;
        border-radius: var(--ac-radius);
        background: var(--dsw-alias-bg-layer-1, #f7f8fa);
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .ac-bubble-user {
        background: var(--dsw-alias-bg-layer-2, #eef0f3);
        border-color: var(--dsw-alias-border-l2, #dcdfe3);
      }
      .ac-bubble-thinking { display: flex; align-items: center; gap: 9px; }
      .ac-plain { white-space: pre-wrap; }
      .ac-msg-foot {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--dsw-alias-border-l1, #e6e8eb);
        font-size: 11px;
        color: var(--dsw-alias-label-secondary, #646a73);
      }
      .ac-dots { display: inline-flex; gap: 3px; }
      .ac-dots i {
        width: 5px; height: 5px; border-radius: 50%;
        background: var(--dsw-alias-brand-primary, #4f6bed);
        animation: ac-blink 1.1s infinite ease-in-out;
      }
      .ac-dots i:nth-child(2) { animation-delay: 0.16s; }
      .ac-dots i:nth-child(3) { animation-delay: 0.32s; }
      @keyframes ac-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
      .ac-thinking-text { font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-stream { display: flex; align-items: center; gap: 9px; }
      .ac-stream-note {
        margin-top: 7px;
        font-size: 11.5px;
        color: var(--dsw-alias-label-secondary, #9aa0a6);
      }
      .ac-md > *:first-child { margin-top: 0; }
      .ac-md > *:last-child { margin-bottom: 0; }
      .ac-md p { margin: 0 0 8px; }
      .ac-md h3, .ac-md h4 { margin: 12px 0 6px; font-size: 13.5px; font-weight: 600; }
      .ac-md ul, .ac-md ol { margin: 4px 0 8px; padding-left: 20px; }
      .ac-md li { margin: 2px 0; }
      .ac-md code {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
        padding: 1px 5px;
        border-radius: 5px;
        background: var(--dsw-alias-bg-layer-2, #eef0f3);
      }
      .ac-md pre {
        margin: 8px 0;
        padding: 10px 12px;
        border-radius: 9px;
        overflow-x: auto;
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
      }
      .ac-md pre code { background: transparent; padding: 0; font-size: 12px; line-height: 1.5; }
      .ac-md blockquote {
        margin: 8px 0;
        padding: 4px 0 4px 10px;
        border-left: 3px solid var(--dsw-alias-border-l2, #dcdfe3);
        color: var(--dsw-alias-label-secondary, #646a73);
      }
      .ac-md a { color: var(--dsw-alias-brand-primary, #4f6bed); text-decoration: none; }
      .ac-md a:hover { text-decoration: underline; }
      .ac-table { overflow-x: auto; margin: 8px 0; }
      .ac-md table { border-collapse: collapse; font-size: 12.5px; min-width: 100%; }
      .ac-md th, .ac-md td {
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        padding: 6px 9px;
        text-align: left;
        vertical-align: top;
      }
      .ac-md th { background: var(--dsw-alias-bg-layer-2, #f2f3f5); font-weight: 600; }
      .ac-empty {
        max-width: 460px;
        margin: 8vh auto 0;
        padding: 0 12px;
        text-align: center;
      }
      .ac-empty-icon {
        width: 46px; height: 46px;
        margin: 0 auto 12px;
        border-radius: 14px;
        display: flex; align-items: center; justify-content: center;
        color: var(--dsw-alias-brand-primary, #4f6bed);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bed) 10%, transparent);
      }
      .ac-empty-title { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
      .ac-empty-hint { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-composer { flex: 0 0 auto; padding: 8px 18px 12px; border-top: 1px solid var(--dsw-alias-border-l1, #e6e8eb); }
      .ac-notice {
        max-width: 820px;
        margin: 0 auto 8px;
        padding: 7px 11px;
        border-radius: 8px;
        font-size: 12px;
        color: var(--dsw-alias-state-error-primary, #d92d20);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 8%, transparent);
      }
      .ac-composer-inner {
        max-width: 820px;
        margin: 0 auto;
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 7px 7px 7px 12px;
        border-radius: 13px;
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        background: var(--dsw-alias-bg-layer-1, #f7f8fa);
        transition: border-color 0.14s ease;
      }
      .ac-composer-inner:focus-within { border-color: var(--dsw-alias-brand-primary, #4f6bed); }
      .ac-textarea {
        flex: 1 1 auto;
        min-height: 26px;
        max-height: 160px;
        padding: 3px 0;
        border: none;
        outline: none;
        resize: none;
        background: transparent;
        color: inherit;
        font: inherit;
        line-height: 1.55;
      }
      .ac-textarea::placeholder { color: var(--dsw-alias-label-secondary, #9aa0a6); }
      .ac-btn {
        border: none;
        border-radius: 9px;
        padding: 7px 14px;
        font: inherit;
        font-size: 12.5px;
        cursor: pointer;
        white-space: nowrap;
        color: #fff;
        background: var(--dsw-alias-brand-primary, #4f6bed);
        transition: opacity 0.12s ease;
      }
      .ac-btn:hover:not(:disabled) { opacity: 0.88; }
      .ac-btn:disabled { opacity: 0.42; cursor: default; }
      .ac-btn-stop { background: var(--dsw-alias-state-error-primary, #d92d20); }
      .ac-btn-ghost {
        color: var(--dsw-alias-label-primary, #1f2329);
        background: var(--dsw-alias-bg-layer-2, #f4f5f7);
        border: 1px solid var(--dsw-alias-border-l1, #e4e6eb);
      }
      .ac-btn-block { width: 100%; padding: 9px 14px; font-size: 13px; }
      .ac-actions { display: flex; flex-direction: column; gap: 9px; margin-top: 9px; }
      .ac-action-card {
        border: 1px solid var(--dsw-alias-border-l1, #e4e6eb);
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1, #fafafb);
        padding: 13px 15px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .ac-action-head { display: flex; gap: 10px; align-items: flex-start; }
      .ac-action-mark {
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        color: #fff;
        background: var(--dsw-alias-brand-primary, #4f6bed);
      }
      .ac-action-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .ac-action-kicker { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa0a6); }
      .ac-action-title { font-size: 13.5px; }
      .ac-action-desc { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-action-facts { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 9px 11px; border-radius: 9px; background: var(--dsw-alias-bg-base, #fff); }
      .ac-action-fact { display: flex; gap: 10px; font-size: 12.5px; }
      .ac-action-fact-label { flex: 0 0 38%; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-action-fact-value { flex: 1 1 auto; min-width: 0; word-break: break-word; }
      .ac-action-buttons { display: flex; gap: 8px; justify-content: flex-end; }
      .ac-artifacts { display: flex; flex-direction: column; gap: 6px; margin-top: 9px; }
      .ac-artifacts-head { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa0a6); }
      .ac-artifact {
        display: flex;
        align-items: center;
        gap: 9px;
        width: 100%;
        padding: 8px 11px;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l1, #e4e6eb);
        background: var(--dsw-alias-bg-layer-1, #fafafb);
        color: var(--dsw-alias-label-primary, #1f2329);
        font-size: 12.5px;
        text-align: left;
        cursor: pointer;
      }
      .ac-artifact:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4f6bed); }
      .ac-artifact:disabled { opacity: 0.6; cursor: default; }
      .ac-artifact-icon {
        flex: 0 0 auto;
        width: 22px; height: 22px; border-radius: 6px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 600;
        color: var(--dsw-alias-brand-primary, #4f6bed);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bed) 12%, transparent);
      }
      .ac-artifact-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-artifact-action { flex: 0 0 auto; font-size: 12px; color: var(--dsw-alias-brand-primary, #4f6bed); }
      .ac-foot { margin: 7px 0 0; text-align: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa0a6); }
      .ac-login { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; align-items: center; justify-content: center; padding: 28px 18px; }
      .ac-card {
        width: 100%;
        max-width: 392px;
        display: flex;
        flex-direction: column;
        gap: 11px;
        padding: 22px;
        border-radius: 16px;
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        box-shadow: 0 8px 28px rgba(15, 23, 42, 0.06);
      }
      .ac-card-head { display: flex; align-items: center; gap: 9px; }
      .ac-card-icon {
        width: 32px; height: 32px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        color: var(--dsw-alias-brand-primary, #4f6bed);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bed) 12%, transparent);
      }
      .ac-card-title { margin: 0; font-size: 15px; font-weight: 600; }
      .ac-card-hint { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-field { display: flex; flex-direction: column; gap: 5px; }
      .ac-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-input {
        width: 100%;
        padding: 8px 10px;
        border-radius: 9px;
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        background: var(--dsw-alias-bg-base, #ffffff);
        color: inherit;
        font: inherit;
        font-size: 13px;
        outline: none;
        transition: border-color 0.14s ease;
      }
      .ac-input:focus { border-color: var(--dsw-alias-brand-primary, #4f6bed); }
      .ac-error { margin: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #d92d20); }
      .ac-hint { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #9aa0a6); }
      .ac-link {
        align-self: flex-start;
        border: none;
        background: transparent;
        padding: 0;
        font: inherit;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #646a73);
        cursor: pointer;
      }
      .ac-link:hover { color: var(--dsw-alias-brand-primary, #4f6bed); }
      .ac-fields { display: flex; flex-direction: column; gap: 10px; padding-top: 10px; border-top: 1px dashed var(--dsw-alias-border-l1, #e6e8eb); }
      .ac-settings { flex: 1 1 auto; overflow-y: auto; padding: 18px; }
      .ac-settings > * { max-width: 640px; margin-left: auto; margin-right: auto; }
      .ac-settings-actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
      .ac-history { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .ac-history-head { display: flex; align-items: center; gap: 10px; padding: 10px 18px 0; }
      .ac-history-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary, #646a73); }
      .ac-history-body { flex: 1 1 auto; overflow-y: auto; padding: 10px 18px 18px; display: flex; flex-direction: column; gap: 7px; }
      .ac-conv {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px 4px 4px;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l1, #e6e8eb);
        background: var(--dsw-alias-bg-layer-1, #f7f8fa);
      }
      .ac-conv:hover { border-color: var(--dsw-alias-border-l2, #dcdfe3); }
      .ac-conv-main {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 7px 8px;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .ac-conv-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-conv-time { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa0a6); }
      .ac-conv-del {
        flex: 0 0 auto;
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #9aa0a6);
        font: inherit;
        font-size: 11.5px;
        padding: 4px 6px;
        border-radius: 6px;
        cursor: pointer;
      }
      .ac-conv-del:hover { color: var(--dsw-alias-state-error-primary, #d92d20); background: var(--dsw-alias-bg-layer-2, #f2f3f5); }

      /* ---------------------------------------------------------------- *
       * DeepSeek chat alignment: one centered column, gray user bubbles,
       * plain assistant text, pill composer, circular send button.
       * ---------------------------------------------------------------- */
      .ac-root {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        font-size: 15px;
        line-height: 1.75;
      }
      .ac-head { padding: 11px 22px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e9eaec); }
      /* Keep the assistant picker at the exact centre of the header, whatever
         the title block or the action list is wide. */
      .ac-head-center {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        max-width: 46%;
        pointer-events: none;
      }
      .ac-head-center > * { pointer-events: auto; }
      .ac-head-text { max-width: 42%; }
      .ac-title { font-size: 15px; font-weight: 600; }
      .ac-sub { margin-top: 1px; font-size: 12px; }
      .ac-head-actions { gap: 0; }
      .ac-ghost { font-size: 13px; padding: 6px 10px; border-radius: 8px; }
      .ac-ghost:hover { background: var(--dsw-alias-bg-layer-2, #f2f3f5); color: var(--dsw-alias-label-primary, #1f2329); }
      .ac-agent-btn { padding: 5px 12px; font-size: 13px; background: transparent; }

      .ac-thread { padding: 26px 22px 10px; }
      .ac-thread-inner { max-width: 748px; gap: 26px; }
      .ac-msg { gap: 0; }
      .ac-msg-user { justify-content: flex-end; }
      .ac-msg-body { gap: 4px; }
      .ac-msg-user .ac-msg-body { max-width: 100%; align-items: flex-end; }
      .ac-msg-assistant .ac-msg-body { align-items: stretch; }
      .ac-msg-assistant .ac-bubble { width: 100%; }
      .ac-thread::-webkit-scrollbar { width: 8px; }
      .ac-thread::-webkit-scrollbar-thumb { background: rgba(15, 23, 42, 0.14); border-radius: 4px; }
      .ac-thread::-webkit-scrollbar-track { background: transparent; }

      .ac-bubble {
        max-width: 100%;
        padding: 0;
        border: none;
        border-radius: 0;
        background: transparent;
        font-size: 15px;
        line-height: 1.78;
      }
      .ac-bubble-user {
        max-width: min(78%, 560px);
        padding: 10px 16px;
        border-radius: 18px;
        background: var(--dsw-alias-bg-layer-2, #f3f4f6);
        font-size: 14.5px;
        line-height: 1.7;
      }
      .ac-bubble-thinking { padding: 2px 0; }
      .ac-msg-foot {
        margin-top: 10px;
        padding-top: 0;
        border-top: none;
        font-size: 11.5px;
        color: var(--dsw-alias-label-secondary, #9aa0a6);
      }
      .ac-stream-note { margin-top: 6px; font-size: 12px; }

      .ac-md p { margin: 0 0 14px; }
      .ac-md h3 { margin: 22px 0 10px; font-size: 17px; }
      .ac-md h4 { margin: 18px 0 8px; font-size: 15px; }
      .ac-md h3:first-child, .ac-md h4:first-child { margin-top: 0; }
      .ac-md ul, .ac-md ol { margin: 8px 0 14px; padding-left: 24px; }
      .ac-md li { margin: 5px 0; }
      .ac-md code { font-size: 13px; border-radius: 6px; }
      .ac-md pre { margin: 12px 0; padding: 14px 16px; border-radius: 12px; border: none; }
      .ac-md pre code { font-size: 13px; line-height: 1.6; }
      .ac-md blockquote { margin: 12px 0; padding-left: 12px; border-left-width: 2px; }
      .ac-md table { font-size: 13.5px; }
      .ac-md th, .ac-md td { padding: 8px 12px; }
      .ac-table { margin: 12px 0; }

      .ac-empty { max-width: 520px; margin: 14vh auto 0; }
      .ac-empty-title { margin-bottom: 8px; font-size: 21px; font-weight: 600; }
      .ac-empty-hint { font-size: 13.5px; line-height: 1.7; }

      .ac-composer { padding: 6px 22px 14px; border-top: none; }
      .ac-composer-inner {
        max-width: 748px;
        gap: 10px;
        padding: 9px 9px 9px 18px;
        border-radius: 26px;
        border: 1px solid var(--dsw-alias-border-l2, #d5d8dd);
        background: var(--dsw-alias-bg-base, #ffffff);
        box-shadow: 0 2px 12px rgba(15, 23, 42, 0.05);
      }
      .ac-composer-inner:focus-within {
        border-color: var(--dsw-alias-brand-primary, #4f6bed);
        box-shadow: 0 3px 16px rgba(79, 107, 237, 0.14);
      }
      .ac-textarea { padding: 6px 0; font-size: 15px; line-height: 1.6; }
      .ac-foot { margin-top: 9px; font-size: 11.5px; }

      .ac-btn-send,
      .ac-btn-stop {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        padding: 0;
        border-radius: 50%;
      }
      .ac-btn-send { background: var(--dsw-alias-brand-primary, #4f6bed); }
      .ac-btn-send:disabled {
        background: var(--dsw-alias-bg-layer-2, #eceef1);
        color: var(--dsw-alias-label-secondary, #b0b4ba);
        opacity: 1;
      }
      .ac-icon-send { display: block; }
      .ac-icon-stop { display: block; }
      .ac-icon-back { display: block; flex: 0 0 auto; }
      .ac-back { display: inline-flex; align-items: center; gap: 6px; }

      .ac-notice { max-width: 748px; margin-bottom: 10px; padding: 9px 14px; border-radius: 12px; font-size: 12.5px; }
      .ac-msg-tools { display: flex; gap: 4px; margin-top: 8px; }
      .ac-tool-btn {
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #9aa0a6);
        font: inherit;
        font-size: 11.5px;
        padding: 3px 7px;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease;
      }
      .ac-tool-btn:hover { background: var(--dsw-alias-bg-layer-2, #f2f3f5); color: var(--dsw-alias-label-primary, #1f2329); }
      .ac-action-card { border-radius: 16px; }
      .ac-artifact { border-radius: 12px; }
      .ac-card { border-radius: 20px; }
    `;

    /* ------------------------------------------------------------------ *
     * Shell
     * ------------------------------------------------------------------ */

    /** Keep a crashing panel visible (and reported) instead of blanking the column. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        reportToHost('panel-error', {
          error: describeError(error),
          componentStack: String((info && info.componentStack) || ''),
        });
      }

      render() {
        if (this.state.error) {
          const message = String((this.state.error && this.state.error.message) || this.state.error);
          return h(
            'div',
            {
              style: {
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '24px',
                color: 'var(--dsw-alias-label-primary, #1f2329)',
                background: 'var(--dsw-alias-bg-base, #ffffff)',
              },
            },
            h(
              'div',
              { style: { maxWidth: '520px', textAlign: 'center' } },
              h('p', { style: { margin: '0 0 8px', fontWeight: 600 } }, '业务助手加载失败'),
              h(
                'p',
                { style: { margin: '0 0 14px', fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary, #646a73)', wordBreak: 'break-word' } },
                message,
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => this.setState({ error: null }),
                  style: {
                    padding: '7px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--dsw-alias-border-l2, #dcdfe4)',
                    background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
                    color: 'inherit',
                    cursor: 'pointer',
                    font: 'inherit',
                  },
                },
                '重试',
              ),
            ),
          );
        }
        return this.props.children;
      }
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        registerDictionaries(ctx);
        const bound = ctx.locale.bind(NS);
        // The bundle's own dictionary wins over a previously registered one: a
        // stale registration (same ns + locale) would otherwise keep showing old
        // strings until the whole page is reloaded.
        const t = (key, vars) => {
          const zh = readActiveLocale(ctx).toLowerCase().startsWith('zh');
          const dictionary = zh ? DICTS.zh : DICTS.en;
          const text = dictionary && typeof dictionary[key] === 'string' ? dictionary[key] : '';
          if (text) return text;
          let value;
          try {
            value = bound(key, vars);
          } catch {
            value = key;
          }
          if (typeof value === 'string' && value !== key) return value;
          return key;
        };

        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'agent-chat',
                order: 20,
                label: () => t('panelTitle'),
              },
              SidebarIcon,
            ),
          ),
        );

        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: 'agent-chat',
              },
              /**
               * The slot hands panels generic props only (usePanelInfo, …), so the
               * translator is bound here instead of expected as a prop.
               */
              function AgentChatPanel() {
                return h(PanelBoundary, null, h(ChatPanel, { t }));
              },
            ),
          ),
        );

        ctx.effect(() => {
          reportToHost('apply', {
            locale: readActiveLocale(ctx) || 'unknown',
            title: t('panelTitle'),
          });
          const onError = (event) => {
            reportToHost('window-error', {
              message: String((event && event.message) || ''),
              source: String((event && event.filename) || ''),
              line: (event && event.lineno) || 0,
            });
          };
          const onRejection = (event) => {
            reportToHost('unhandled-rejection', describeError(event && event.reason));
          };
          window.addEventListener('error', onError);
          window.addEventListener('unhandledrejection', onRejection);
          return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
          };
        });
      },
    };
  },
});

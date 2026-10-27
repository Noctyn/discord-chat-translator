// ==UserScript==
// @name         Discord 聊天翻译 (悬停 / 批量 / 自动)
// @namespace    https://github.com/Noctyn/discord-chat-translator
// @homepageURL  https://github.com/Noctyn/discord-chat-translator
// @supportURL   https://github.com/Noctyn/discord-chat-translator/issues
// @updateURL    https://raw.githubusercontent.com/Noctyn/discord-chat-translator/main/discord-chat-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/Noctyn/discord-chat-translator/main/discord-chat-translator.user.js
// @version      1.1.0
// @description  悬停 Discord 消息即刻翻译，支持批量翻译屏幕内消息与滚动自动翻译；Google / 微软 / MyMemory 多通道自动降级；界面直接沿用 Discord 原生主题变量，译文·对照·原文一键切换
// @author       Noctyn
// @license      MIT
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @icon         https://discord.com/assets/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @connect      translate.googleapis.com
// @connect      clients5.google.com
// @connect      edge.microsoft.com
// @connect      api-edge.cognitive.microsofttranslator.com
// @connect      api.mymemory.translated.net
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.1.0';
    const rootEl = document.documentElement;
    if (rootEl.hasAttribute('data-dt-loaded')) return;
    rootEl.setAttribute('data-dt-loaded', VERSION);

    /* =====================================================================
     * 1. 选择器
     * ===================================================================== */
    const MSG_CONTENT_SEL = 'div[id^="message-content-"], [data-testid="message-content"]';
    const MSG_ROW_SEL = 'li[id^="chat-messages-"], [data-list-item-id^="chat-messages___"]';
    const OWN_SEL = '.dt-box, .dt-overlay, .dt-toast-host, .dt-float-pill, .dt-expand-btn';
    const EASE = 'cubic-bezier(.22, 1, .36, 1)';

    /* =====================================================================
     * 2. 配置与持久化
     * ===================================================================== */
    const CFG_KEY = 'dt_config_v1';
    const CACHE_KEY = 'dt_cache_v1';
    const PILL_KEY = 'dt_pill_v1';

    const MODES = ['replace', 'bilingual', 'original'];
    const MODE_TO_VIEW = { replace: 'translation', bilingual: 'bilingual', original: 'original' };

    const DEFAULTS = Object.freeze({
        style: 'quote',
        mode: 'bilingual',
        delay: 300,
        targetLang: 'None',
        provider: 'auto',
        triggerKey: 'none',
        skipSame: true,
        autoTranslate: false,
        persistCache: true,
        motion: true,
        showPill: true,
    });
    const BOOL_KEYS = ['skipSame', 'autoTranslate', 'persistCache', 'motion', 'showPill'];

    const STYLE_OPTIONS = [['quote', '引用'], ['card', '嵌入卡片'], ['minimal', '极简']];
    const MODE_OPTIONS = [['replace', '译文'], ['bilingual', '对照'], ['original', '原文']];
    const LANG_OPTIONS = [
        ['None', '跟随浏览器语言'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'],
        ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'],
        ['pt', 'Português'], ['it', 'Italiano'], ['ru', 'Русский'], ['nl', 'Nederlands'], ['pl', 'Polski'],
        ['tr', 'Türkçe'], ['vi', 'Tiếng Việt'], ['th', 'ไทย'], ['id', 'Bahasa Indonesia'],
        ['ar', 'العربية'], ['hi', 'हिन्दी'], ['uk', 'Українська'],
    ];
    const PROVIDER_OPTIONS = [
        ['auto', '自动 (Google → 微软 → MyMemory)'], ['google', 'Google 翻译'],
        ['microsoft', '微软翻译 (Edge)'], ['mymemory', 'MyMemory'],
    ];
    const TRIGGER_OPTIONS = [
        ['none', '鼠标直接悬停'], ['alt', '按住 Alt + 悬停'], ['ctrl', '按住 Ctrl + 悬停'], ['shift', '按住 Shift + 悬停'],
    ];

    function readStore(key, fallback) {
        try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch (_) { /* ignore */ }
        try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
    }
    function writeStore(key, value) {
        try { if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; } } catch (_) { /* ignore */ }
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
    }

    const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

    function sanitize(input) {
        const raw = {};
        if (input && typeof input === 'object') {
            for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) raw[k] = v;
        }
        const c = { ...DEFAULTS, ...raw };
        c.style = oneOf(c.style, STYLE_OPTIONS.map((o) => o[0]), DEFAULTS.style);
        c.mode = oneOf(c.mode, MODES, DEFAULTS.mode);
        const d = Number(c.delay);
        c.delay = Number.isFinite(d) ? clamp(Math.round(d), 0, 1000) : DEFAULTS.delay;
        c.targetLang = oneOf(c.targetLang, LANG_OPTIONS.map((o) => o[0]), 'None');
        c.provider = oneOf(c.provider, PROVIDER_OPTIONS.map((o) => o[0]), 'auto');
        c.triggerKey = oneOf(c.triggerKey, TRIGGER_OPTIONS.map((o) => o[0]), 'none');
        for (const k of BOOL_KEYS) c[k] = !!c[k];
        return c;
    }

    const config = sanitize(readStore(CFG_KEY, null));
    const saveConfig = () => writeStore(CFG_KEY, config);

    /* =====================================================================
     * 3. DOM / 图标工具 (不使用 innerHTML，兼容 Trusted Types)
     * ===================================================================== */
    const stopEvt = (e) => e.stopPropagation();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const debounce = (fn, ms) => {
        let t = 0;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    };
    const isEditable = (t) => !!t && (t.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

    function h(tag, props, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v == null || v === false) continue;
            if (/^on[A-Z]/.test(k)) el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat(Infinity)) {
            if (c == null || c === false) continue;
            el.append(typeof c === 'object' && c.nodeType ? c : String(c));
        }
        return el;
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        translate: { nodes: [['path', { d: 'm5 8 6 6' }], ['path', { d: 'm4 14 6-6 2-3' }], ['path', { d: 'M2 5h12' }], ['path', { d: 'M7 2h1' }], ['path', { d: 'm22 22-5-10-5 10' }], ['path', { d: 'M14 18h6' }]] },
        copy: { nodes: [['rect', { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]] },
        check: { nodes: [['path', { d: 'M20 6 9 17l-5-5' }]] },
        refresh: { nodes: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]] },
        settings: { nodes: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z' }]] },
        close: { nodes: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]] },
        alert: { nodes: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, x2: 12, y1: 8, y2: 12 }], ['line', { x1: 12, x2: 12.01, y1: 16, y2: 16 }]] },
        zap: { nodes: [['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }]] },
        pause: { nodes: [['rect', { x: 6, y: 4, width: 4, height: 16, rx: 1 }], ['rect', { x: 14, y: 4, width: 4, height: 16, rx: 1 }]] },
        grip: { filled: true, nodes: [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]].map(([cx, cy]) => ['circle', { cx, cy, r: 1.6 }]) },
    };

    function icon(name, size = 14) {
        const def = ICONS[name] || ICONS.translate;
        const svg = document.createElementNS(SVG_NS, 'svg');
        const attrs = def.filled
            ? { viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', 'aria-hidden': 'true', class: 'dt-icon' }
            : {
                viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'dt-icon',
            };
        for (const k in attrs) svg.setAttribute(k, attrs[k]);
        for (const [tag, a] of def.nodes) {
            const n = document.createElementNS(SVG_NS, tag);
            for (const k in a) n.setAttribute(k, a[k]);
            svg.appendChild(n);
        }
        return svg;
    }

    // 仅用于缓存键 (非安全用途)
    function hashStr(s) {
        let h1 = 0x811c9dc5;
        let h2 = 0x1b873593;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
        }
        return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    }

    /* =====================================================================
     * 4. 主题 / 动效开关
     *    颜色全部来自 Discord 自带 CSS 变量；JS 只负责给出明暗兜底
     * ===================================================================== */
    const reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const motionOn = () => config.motion && !reducedMQ.matches;

    function parseRGB(str) {
        const m = (str || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?/);
        if (!m) return null;
        let a = 1;
        if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return { r: +m[1], g: +m[2], b: +m[3], a };
    }

    function detectTheme() {
        const cl = rootEl.classList;
        if (cl.contains('theme-light')) return 'light';
        for (const c of cl) if (c.startsWith('theme-')) return 'dark'; // dark / darker / midnight / onyx ...
        const bg = parseRGB(getComputedStyle(document.getElementById('app-mount') || document.body).backgroundColor);
        if (bg && bg.a > 0) return (bg.r + bg.g + bg.b) > 380 ? 'light' : 'dark';
        return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function syncRootAttrs() {
        const set = (k, v) => { if (rootEl.dataset[k] !== v) rootEl.dataset[k] = v; };
        set('dtStyle', config.style);
        set('dtMotion', motionOn() ? 'on' : 'off');
    }

    function refreshTheme() {
        if (!document.body) return;
        const theme = detectTheme();
        if (rootEl.dataset.dtTheme !== theme) rootEl.dataset.dtTheme = theme;
        syncRootAttrs();
    }

    function observeTheme() {
        const run = debounce(() => requestAnimationFrame(refreshTheme), 120);
        new MutationObserver(run).observe(rootEl, { attributes: true, attributeFilter: ['class'] });
        try { reducedMQ.addEventListener?.('change', refreshTheme); } catch (_) { /* ignore */ }
    }

    /* =====================================================================
     * 5. 样式 (沿用 Discord 原生变量，缺失时回退到内置色值)
     * ===================================================================== */
    const STYLE_ID = 'discord-chat-translator-style';
    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
:root {
    --dt-fb-fg: #313338; --dt-fb-muted: #5c5e66; --dt-fb-bg: #ffffff; --dt-fb-bg2: #f2f3f5;
    --dt-fb-bg3: #e3e5e8; --dt-fb-float: #ffffff; --dt-fb-accent: #5865f2;
    --dt-ease: cubic-bezier(.22, 1, .36, 1);
    --dt-spring: cubic-bezier(.34, 1.4, .64, 1);
}
:root[data-dt-theme="dark"] {
    --dt-fb-fg: #dbdee1; --dt-fb-muted: #949ba4; --dt-fb-bg: #313338; --dt-fb-bg2: #2b2d31;
    --dt-fb-bg3: #1e1f22; --dt-fb-float: #111214;
}
:is(.dt-box, .dt-overlay, .dt-toast-host, .dt-float-pill) {
    --dt-fg: var(--text-default, var(--text-normal, var(--dt-fb-fg)));
    --dt-head: var(--header-primary, var(--text-strong, var(--dt-fg)));
    --dt-muted: var(--text-muted, var(--text-subtle, var(--dt-fb-muted)));
    --dt-accent: var(--brand-500, var(--brand-experiment, var(--background-brand, var(--dt-fb-accent))));
    --dt-bg: var(--modal-background, var(--background-surface-high, var(--background-primary, var(--dt-fb-bg))));
    --dt-bg2: var(--background-secondary, var(--background-base-lower, var(--dt-fb-bg2)));
    --dt-bg3: var(--background-tertiary, var(--background-base-lowest, var(--dt-fb-bg3)));
    --dt-input: var(--input-background-default, var(--input-background, var(--dt-bg3)));
    --dt-float: var(--background-floating, var(--background-surface-highest, var(--dt-fb-float)));
    --dt-danger: var(--status-danger, var(--red-400, #da373c));
    --dt-positive: var(--status-positive, var(--green-360, #23a55a));
    --dt-link: var(--text-link, var(--dt-accent));
    --dt-line: color-mix(in srgb, var(--dt-fg) 14%, transparent);
    --dt-hover: color-mix(in srgb, var(--dt-fg) 8%, transparent);
    --dt-active: color-mix(in srgb, var(--dt-fg) 14%, transparent);
    --dt-r-sm: var(--radius-sm, 3px);
    --dt-r-md: var(--radius-md, 4px);
    --dt-r-lg: var(--radius-lg, 8px);
}
:is(.dt-overlay, .dt-toast-host, .dt-float-pill) {
    font-family: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif);
}

[data-dt-view="translation"] { display: none !important; }
.dt-box-indented {
    margin-left: var(--dt-indent, 0px) !important;
    width: calc(100% - var(--dt-indent, 0px)) !important;
    box-sizing: border-box;
}
.dt-clamped {
    max-height: 200px !important;
    overflow: hidden !important;
    -webkit-mask-image: linear-gradient(180deg, #000 65%, transparent 100%) !important;
    mask-image: linear-gradient(180deg, #000 65%, transparent 100%) !important;
}
.dt-expand-btn {
    all: unset; box-sizing: border-box; display: inline-flex; align-items: center; cursor: pointer;
    text-indent: 0; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dt-link);
    padding: 2px 0; margin: 2px 0; user-select: none;
}
.dt-expand-btn:hover { text-decoration: underline; }
.dt-box[data-view="original"] .dt-trans-expand-btn { display: none; }

/* ---------- 译文容器 ---------- */
.dt-box {
    --dt-bar: var(--dt-accent);
    position: relative; box-sizing: border-box; align-self: stretch; max-width: 100%;
    margin: 4px 0 2px; padding: 2px 8px 4px 14px;
    border-radius: var(--dt-r-sm);
    color: var(--dt-text-color, var(--dt-fg));
    font-family: inherit; text-align: left; text-indent: 0; white-space: normal; cursor: default;
    transition: background-color .2s ease, margin .3s var(--dt-ease), padding .3s var(--dt-ease);
}
.dt-box[data-view="translation"] { margin-top: 2px; }
.dt-box[data-view="original"] { padding-top: 0; padding-bottom: 0; }
.dt-box::before {
    content: ""; position: absolute; left: 0; top: 2px; bottom: 2px; width: 4px;
    border-radius: 4px; background: var(--dt-bar); transform-origin: top center; pointer-events: none;
    transition: background-color .2s ease, opacity .2s ease;
}
.dt-box:hover { background-color: color-mix(in srgb, var(--dt-bar) 6%, transparent); }

:root[data-dt-style="card"] .dt-box {
    padding: 8px 12px 10px 16px; background: var(--dt-bg2); border: 1px solid var(--dt-line);
}
:root[data-dt-style="card"] .dt-box:hover { background: var(--dt-bg2); }
:root[data-dt-style="card"] .dt-box::before {
    left: -1px; top: -1px; bottom: -1px; border-radius: var(--dt-r-sm) 0 0 var(--dt-r-sm);
}
:root[data-dt-style="minimal"] .dt-box { padding: 0 0 0 10px; }
:root[data-dt-style="minimal"] .dt-box::before { width: 2px; top: 1px; bottom: 1px; opacity: .6; }

.dt-box[data-state="error"] { --dt-bar: var(--dt-danger); animation: dt-shake .4s ease; }
.dt-box[data-state="same"] { --dt-bar: var(--dt-positive); }
.dt-box[data-state="loading"]::before { animation: dt-pulse 1.3s ease-in-out infinite; }

/* ---------- 顶栏 ---------- */
.dt-head {
    display: flex; align-items: center; gap: 6px; min-height: 22px;
    font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dt-muted); user-select: none;
}
.dt-brand { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto; }
.dt-brand .dt-icon { flex: none; color: var(--dt-bar); }
.dt-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-box[data-state="error"] .dt-brand { color: var(--dt-danger); }
.dt-box[data-state="loading"] .dt-brand .dt-icon { animation: dt-pulse 1.1s ease-in-out infinite; }
.dt-dots { display: inline-flex; gap: 3px; }
.dt-dots i { width: 3.5px; height: 3.5px; border-radius: 50%; background: var(--dt-bar); animation: dt-dot 1.1s ease-in-out infinite; }
.dt-dots i:nth-child(2) { animation-delay: .15s; }
.dt-dots i:nth-child(3) { animation-delay: .3s; }

.dt-skel { display: grid; gap: 7px; margin: 6px 0 4px; }
.dt-skel i {
    display: block; height: 10px; width: 100%; border-radius: 5px;
    background: linear-gradient(90deg, var(--dt-hover) 25%, var(--dt-active) 37%, var(--dt-hover) 63%);
    background-size: 400% 100%; animation: dt-shimmer 1.5s ease infinite;
}
.dt-skel i:nth-child(2n):not(:last-child) { width: 90%; }
.dt-skel i:last-child:not(:first-child) { width: 56%; }

/* 悬停时显现的操作区 */
.dt-actions {
    margin-left: auto; display: inline-flex; align-items: center; gap: 4px; flex: none;
    opacity: 0; pointer-events: none; transition: opacity .15s ease;
}
.dt-box:hover .dt-actions, .dt-box:focus-within .dt-actions, .dt-box[data-preview] .dt-actions { opacity: 1; pointer-events: auto; }
@media (hover: none) { .dt-actions { opacity: 1; pointer-events: auto; } }
.dt-tools { display: inline-flex; align-items: center; }

.dt-ibtn {
    all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: var(--dt-r-md); cursor: pointer; color: var(--dt-muted);
    transition: background-color .12s ease, color .12s ease;
}
.dt-ibtn:hover { background: var(--dt-hover); color: var(--dt-head); }
.dt-ibtn:active { background: var(--dt-active); }
.dt-ibtn .dt-icon { transition: transform .4s var(--dt-spring); }
.dt-ibtn[data-act="refresh"]:hover .dt-icon { transform: rotate(180deg); }
.dt-ibtn[data-act="cfg"]:hover .dt-icon { transform: rotate(60deg); }
.dt-ibtn.dt-ok { color: var(--dt-positive) !important; }

.dt-tabs {
    position: relative; display: inline-grid; grid-template-columns: repeat(3, 34px); padding: 2px;
    border-radius: var(--dt-r-md); background: var(--dt-hover); flex: 0 0 auto;
}
.dt-tab-ind {
    position: absolute; top: 2px; bottom: 2px; left: 2px; width: 34px; border-radius: var(--dt-r-sm);
    background: var(--dt-active); transform: translateX(calc(var(--dt-i, 0) * 34px));
    transition: transform .35s var(--dt-spring);
}
.dt-tab {
    all: unset; position: relative; z-index: 1; box-sizing: border-box; cursor: pointer; text-align: center;
    padding: 2px 0; border-radius: var(--dt-r-sm); font-size: 12px; line-height: 16px; font-weight: 500;
    color: var(--dt-muted); transition: color .15s ease;
}
.dt-tab:hover { color: var(--dt-head); }
.dt-tab[aria-pressed="true"] { color: var(--dt-head); font-weight: 600; }

.dt-retry-link {
    all: unset; cursor: pointer; margin-left: auto; font-size: 12px; font-weight: 500; padding: 1px 10px;
    border-radius: var(--dt-r-sm); color: var(--dt-link); transition: background-color .12s ease;
}
.dt-retry-link:hover { background: var(--dt-hover); text-decoration: underline; }

/* ---------- 正文 ---------- */
.dt-body-wrap {
    display: grid; grid-template-rows: 1fr; margin-top: 2px;
    transition: grid-template-rows .35s var(--dt-ease), opacity .25s ease, margin .35s var(--dt-ease);
}
.dt-body-clip { min-height: 0; overflow: hidden; }
.dt-box[data-view="original"] .dt-body-wrap { grid-template-rows: 0fr; opacity: 0; margin-top: 0; }
.dt-box[data-view="original"] .dt-body-clip { visibility: hidden; transition: visibility 0s .35s; }
.dt-body {
    font-size: var(--dt-fs, 16px); line-height: 1.375; font-weight: var(--dt-fw, 400);
    color: var(--dt-text-color, var(--dt-fg)); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    user-select: text; -webkit-user-select: text; cursor: text; animation: dt-text-in .35s var(--dt-ease) both;
}
.dt-link { color: var(--dt-link); text-decoration: none; }
.dt-link:hover { text-decoration: underline; }
.dt-mention {
    padding: 0 2px; border-radius: 3px; font-weight: 500; color: var(--dt-accent);
    background: color-mix(in srgb, var(--dt-accent) 14%, transparent);
}

/* ---------- Toast ---------- */
.dt-toast-host {
    position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 2147483001;
    display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
}
.dt-toast {
    display: inline-flex; align-items: center; gap: 8px; max-width: min(92vw, 520px); padding: 10px 16px;
    border-radius: var(--dt-r-lg); background: var(--dt-float); color: var(--dt-head); border: 1px solid var(--dt-line);
    font-size: 14px; line-height: 20px; font-weight: 500;
    box-shadow: var(--elevation-high, 0 8px 16px rgba(0, 0, 0, .24));
    animation: dt-toast-in .35s var(--dt-spring);
}
.dt-toast .dt-icon { flex: none; color: var(--dt-accent); }
.dt-toast[data-kind="off"] .dt-icon { color: var(--dt-muted); }
.dt-toast[data-kind="warn"] .dt-icon { color: var(--dt-danger); }
.dt-toast.dt-out { animation: dt-toast-out .22s ease-in forwards; }

/* ---------- 悬浮操作条 (可拖动) ---------- */
.dt-float-pill {
    position: fixed; right: 18px; bottom: 96px; z-index: 1000; display: inline-flex; align-items: center; gap: 2px;
    padding: 3px; border-radius: var(--dt-r-lg); background: var(--dt-float); border: 1px solid var(--dt-line);
    box-shadow: var(--elevation-low, 0 2px 6px rgba(0, 0, 0, .24)); opacity: .55; transition: opacity .2s ease;
}
.dt-float-pill:hover, .dt-float-pill[data-drag] { opacity: 1; }
.dt-float-pill[hidden] { display: none; }
.dt-float-pill .dt-ibtn { width: 28px; height: 28px; }
.dt-grip { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 28px; cursor: grab; color: var(--dt-muted); touch-action: none; }
.dt-float-pill[data-drag] .dt-grip { cursor: grabbing; }
.dt-pill-dot {
    position: absolute; top: -3px; right: -3px; width: 10px; height: 10px; border-radius: 50%;
    background: var(--dt-positive); border: 2px solid var(--dt-float); opacity: 0; transform: scale(.5);
    transition: opacity .2s ease, transform .25s var(--dt-spring);
}
.dt-float-pill[data-auto="on"] .dt-pill-dot { opacity: 1; transform: none; }

/* ---------- 设置弹窗 ---------- */
.dt-overlay {
    position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(0, 0, 0, .7); animation: dt-fade .18s ease-out;
}
:root[data-dt-theme="dark"] .dt-overlay { color-scheme: dark; }
:root[data-dt-theme="light"] .dt-overlay { color-scheme: light; }
.dt-overlay.dt-closing { animation: dt-fade-out .15s ease-in forwards; }
.dt-panel {
    box-sizing: border-box; width: min(520px, 100%); height: min(82vh, 660px); display: flex; flex-direction: column;
    overflow: hidden; border-radius: var(--dt-r-lg); background: var(--dt-bg); color: var(--dt-fg);
    font-size: 14px; line-height: 20px; box-shadow: var(--elevation-high, 0 8px 24px rgba(0, 0, 0, .4));
    animation: dt-panel-in .3s var(--dt-spring);
}
.dt-overlay.dt-closing .dt-panel { animation: dt-panel-out .15s ease-in forwards; }
.dt-panel *, .dt-panel *::before, .dt-panel *::after { box-sizing: border-box; }
.dt-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 12px 20px; flex: none; }
.dt-panel-title { font-size: 20px; line-height: 24px; font-weight: 700; color: var(--dt-head); }
.dt-close-btn {
    all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: var(--dt-r-md); cursor: pointer; color: var(--dt-muted);
    transition: background-color .12s ease, color .12s ease;
}
.dt-close-btn:hover { background: var(--dt-hover); color: var(--dt-head); }

.dt-ptabs { position: relative; z-index: 2; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; flex: none; border-bottom: 1px solid var(--dt-line); }
.dt-ptabs.dt-scrolled { box-shadow: 0 6px 10px -8px rgba(0, 0, 0, .5); }
.dt-ptab {
    all: unset; box-sizing: border-box; cursor: pointer; text-align: center; padding: 10px 0 12px;
    font-size: 14px; line-height: 20px; font-weight: 500; color: var(--dt-muted); transition: background-color .12s ease, color .15s ease;
}
.dt-ptab:hover { background: var(--dt-hover); color: var(--dt-head); }
.dt-ptab[aria-selected="true"] { color: var(--dt-head); font-weight: 600; }
.dt-ptab-ind {
    position: absolute; left: 0; bottom: -1px; width: calc(100% / var(--n, 3)); height: 2px; background: var(--dt-accent);
    transform: translateX(calc(var(--i, 0) * 100%)); transition: transform .35s var(--dt-spring); pointer-events: none;
}
.dt-panel-body {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 8px;
    scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--dt-fg) 30%, transparent) transparent;
}
.dt-page[hidden] { display: none; }
.dt-page > * { animation: dt-row-in .35s var(--dt-ease) both; animation-delay: calc(var(--dt-d, 0) * 20ms); }
.dt-sec { padding: 18px 20px 4px; font-size: 12px; line-height: 16px; font-weight: 700; color: var(--dt-muted); }

.dt-preview {
    display: flex; gap: 12px; margin: 16px 20px 4px; padding: 12px; border-radius: var(--dt-r-lg);
    background: var(--dt-bg2); border: 1px solid var(--dt-line);
}
.dt-pv-avatar {
    flex: none; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 600; background: var(--dt-accent);
}
.dt-pv-main { min-width: 0; flex: 1; font-size: 15px; line-height: 1.375; }
.dt-pv-name { font-weight: 500; color: var(--dt-head); }
.dt-pv-time { margin-left: 8px; font-size: 12px; font-weight: 400; color: var(--dt-muted); }
.dt-pv-main .dt-box { --dt-fs: 15px; }

.dt-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 20px; transition: opacity .2s ease, filter .2s ease; }
.dt-row[data-disabled="true"] { opacity: .4; filter: grayscale(.6); pointer-events: none; }
.dt-divider { height: 1px; background: var(--dt-line); margin: 10px 20px 0; }
.dt-row-info { min-width: 0; flex: 1 1 auto; }
.dt-row-title { font-size: 15px; line-height: 20px; font-weight: 500; color: var(--dt-head); }
.dt-row-desc { font-size: 13px; line-height: 18px; color: var(--dt-muted); margin-top: 2px; }

.dt-keys { display: grid; gap: 6px; padding: 6px 20px 10px; }
.dt-keys > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--dt-fg); }
.dt-kbd {
    display: inline-block; min-width: 22px; padding: 0 6px; margin-left: 4px; border-radius: var(--dt-r-md);
    background: var(--dt-bg3); border: 1px solid var(--dt-line); border-bottom-width: 2px; color: var(--dt-head);
    font: 600 12px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-align: center;
}

.dt-panel-foot {
    display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px;
    padding: 14px 20px; background: var(--dt-bg2); font-size: 12px; color: var(--dt-muted);
}
.dt-foot-actions, .dt-foot-end { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; }

.dt-btn {
    all: unset; box-sizing: border-box; cursor: pointer; height: 32px; padding: 0 16px; display: inline-flex; align-items: center;
    border-radius: var(--dt-r-md); font-size: 14px; font-weight: 500; white-space: nowrap;
    background: var(--button-secondary-background, var(--dt-active)); color: var(--dt-head);
    transition: background-color .12s ease, color .12s ease, filter .12s ease;
}
.dt-btn:hover { filter: brightness(1.12); }
.dt-btn[data-kind="primary"] { background: var(--dt-accent); color: #fff; }
.dt-btn[data-kind="primary"]:hover { filter: brightness(.9); }
.dt-btn[data-kind="danger"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dt-danger); color: var(--dt-danger); }
.dt-btn[data-kind="danger"]:hover { background: var(--dt-danger); color: #fff; filter: none; }

/* 分段控件 */
.dt-seg { position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; flex: none; padding: 2px; border-radius: var(--dt-r-md); background: var(--dt-bg3); }
.dt-seg-thumb {
    position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc((100% - 4px) / var(--n, 2)); border-radius: var(--dt-r-sm);
    background: var(--dt-accent); transform: translateX(calc(var(--i, 0) * 100%)); transition: transform .35s var(--dt-spring);
}
.dt-seg button {
    all: unset; position: relative; z-index: 1; cursor: pointer; text-align: center; padding: 4px 12px; border-radius: var(--dt-r-sm);
    font-size: 13px; line-height: 18px; font-weight: 500; white-space: nowrap; color: var(--dt-muted); transition: color .2s ease;
}
.dt-seg button:hover { color: var(--dt-head); }
.dt-seg button[aria-pressed="true"] { color: #fff; }

.dt-select {
    appearance: none; -webkit-appearance: none; cursor: pointer; height: 34px; min-width: 160px; max-width: 240px;
    padding: 0 32px 0 12px; border: 1px solid var(--dt-line); border-radius: var(--dt-r-md); background-color: var(--dt-input);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2380848e' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; color: var(--dt-fg); font: inherit; font-size: 14px;
    transition: border-color .12s ease;
}
.dt-select:hover { border-color: color-mix(in srgb, var(--dt-fg) 35%, transparent); }
.dt-select:focus-visible { outline: none; border-color: var(--dt-accent); }
.dt-select option { background: var(--dt-bg); color: var(--dt-fg); }

.dt-range-wrap { display: flex; align-items: center; gap: 10px; }
.dt-range { -webkit-appearance: none; appearance: none; width: 130px; height: 24px; margin: 0; background: transparent; cursor: pointer; --p: 30%; }
.dt-range::-webkit-slider-runnable-track { height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--dt-accent) var(--p), color-mix(in srgb, var(--dt-fg) 22%, transparent) var(--p)); }
.dt-range::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 24px; margin-top: -8px; border-radius: 3px; background: #fff; border: 1px solid rgba(0, 0, 0, .25); box-shadow: 0 1px 3px rgba(0, 0, 0, .3); }
.dt-range::-moz-range-track { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--dt-fg) 22%, transparent); }
.dt-range::-moz-range-progress { height: 8px; border-radius: 4px; background: var(--dt-accent); }
.dt-range::-moz-range-thumb { width: 8px; height: 22px; border-radius: 3px; background: #fff; border: 1px solid rgba(0, 0, 0, .25); }
.dt-range:focus-visible { outline: 2px solid var(--dt-accent); outline-offset: 2px; border-radius: 4px; }
.dt-range-val { min-width: 48px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--dt-muted); }

.dt-switch {
    all: unset; box-sizing: border-box; position: relative; flex: none; width: 40px; height: 24px; border-radius: 14px;
    cursor: pointer; background: #80848e; transition: background-color .2s ease;
}
.dt-switch::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .3); transition: transform .25s var(--dt-spring), width .15s ease;
}
.dt-switch:active::after { width: 22px; }
.dt-switch[aria-checked="true"] { background: var(--dt-positive); }
.dt-switch[aria-checked="true"]::after { transform: translateX(16px); }
.dt-switch[aria-checked="true"]:active::after { transform: translateX(12px); }

.dt-tab:focus-visible, .dt-ibtn:focus-visible, .dt-close-btn:focus-visible, .dt-retry-link:focus-visible, .dt-switch:focus-visible,
.dt-btn:focus-visible, .dt-seg button:focus-visible, .dt-expand-btn:focus-visible { outline: 2px solid var(--dt-accent); outline-offset: 2px; }
.dt-ptab:focus-visible { outline: 2px solid var(--dt-accent); outline-offset: -2px; }
@media (max-width: 480px) { .dt-row { flex-wrap: wrap; } }
@media (max-width: 520px) {
    .dt-overlay { align-items: flex-end; padding: 0; }
    .dt-panel { width: 100%; height: min(88vh, 720px); border-radius: 16px 16px 0 0; animation-name: dt-sheet-in; animation-timing-function: var(--dt-ease); }
    .dt-overlay.dt-closing .dt-panel { animation-name: dt-sheet-out; }
    .dt-panel-foot { padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }
    .dt-toast-host { bottom: calc(76px + env(safe-area-inset-bottom, 0px)); }
}

@keyframes dt-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes dt-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
@keyframes dt-dot { 0%, 80%, 100% { transform: translateY(0); opacity: .35; } 40% { transform: translateY(-3px); opacity: 1; } }
@keyframes dt-text-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes dt-shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 50% { transform: translateX(4px); } 75% { transform: translateX(-2px); } }
@keyframes dt-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dt-fade-out { to { opacity: 0; } }
@keyframes dt-panel-in { from { opacity: 0; transform: translateY(12px) scale(.95); } to { opacity: 1; transform: none; } }
@keyframes dt-panel-out { to { opacity: 0; transform: scale(.97); } }
@keyframes dt-sheet-in { from { transform: translateY(100%); } to { transform: none; } }
@keyframes dt-sheet-out { to { transform: translateY(100%); } }
@keyframes dt-row-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes dt-toast-in { from { opacity: 0; transform: translateY(14px) scale(.92); } to { opacity: 1; transform: none; } }
@keyframes dt-toast-out { to { opacity: 0; transform: translateY(8px) scale(.96); } }

:root[data-dt-motion="off"] :is(.dt-box, .dt-overlay, .dt-toast-host, .dt-float-pill),
:root[data-dt-motion="off"] :is(.dt-box, .dt-overlay, .dt-toast-host, .dt-float-pill) *,
:root[data-dt-motion="off"] :is(.dt-box, .dt-overlay, .dt-toast-host, .dt-float-pill)::before,
:root[data-dt-motion="off"] :is(.dt-box, .dt-overlay, .dt-toast-host, .dt-float-pill) *::before,
:root[data-dt-motion="off"] :is(.dt-box, .dt-overlay, .dt-toast-host, .dt-float-pill) *::after {
    animation: none !important;
    transition: none !important;
}
`;
        (document.head || document.documentElement).appendChild(style);
    }

    /* =====================================================================
     * 6. 动效辅助 / Toast
     * ===================================================================== */
    const canAnimate = (box) => motionOn() && box.isConnected && typeof box.animate === 'function';

    function runBoxAnim(box, keyframes, opts) {
        box._anim?.cancel();
        box.style.overflow = 'hidden';
        const anim = box.animate(keyframes, opts);
        box._anim = anim;
        const done = () => { if (box._anim === anim) { box._anim = null; box.style.overflow = ''; } };
        anim.onfinish = done;
        anim.oncancel = done;
        return anim;
    }

    const boxMetrics = (box) => {
        const cs = getComputedStyle(box);
        return {
            height: `${box.offsetHeight}px`, opacity: 1, marginTop: cs.marginTop, marginBottom: cs.marginBottom,
            paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
        };
    };
    const COLLAPSED = { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' };

    function animateIn(box) {
        if (!canAnimate(box)) return;
        runBoxAnim(box, [COLLAPSED, boxMetrics(box)], { duration: 340, easing: EASE });
    }

    function morph(box, mutate) {
        if (!canAnimate(box)) { mutate(); return; }
        const from = box.offsetHeight;
        box._anim?.cancel();
        mutate();
        const to = box.offsetHeight;
        if (Math.abs(from - to) < 2) return;
        runBoxAnim(box, [{ height: `${from}px` }, { height: `${to}px` }], { duration: 280, easing: EASE });
    }

    function collapseAndRemove(box) {
        if (!box.isConnected) return;
        if (!canAnimate(box)) { box.remove(); return; }
        const anim = runBoxAnim(box, [boxMetrics(box), COLLAPSED], { duration: 260, easing: EASE, fill: 'forwards' });
        anim.onfinish = () => box.remove();
        anim.oncancel = () => box.remove();
    }

    let toastHost = null;
    let toastTimer = 0;
    function showToast(text, kind = 'ok') {
        if (!document.body) return;
        if (!toastHost || !toastHost.isConnected) {
            toastHost = h('div', { class: 'dt-toast-host', role: 'status', 'aria-live': 'polite' });
            document.body.appendChild(toastHost);
        }
        clearTimeout(toastTimer);
        toastHost.replaceChildren();
        const ico = kind === 'warn' ? 'alert' : (kind === 'off' ? 'pause' : 'zap');
        const toast = h('div', { class: 'dt-toast', 'data-kind': kind }, icon(ico, 16), text);
        toastHost.appendChild(toast);
        toastTimer = setTimeout(() => {
            toast.classList.add('dt-out');
            setTimeout(() => toast.remove(), motionOn() ? 240 : 0);
        }, kind === 'warn' ? 3200 : 2200);
    }

    /* =====================================================================
     * 7. HTTP 层
     * ===================================================================== */
    const REQUEST_TIMEOUT = 15000;

    function httpError(message, status, retryMs) {
        const e = new Error(message);
        e.status = status;
        if (retryMs) e.retryMs = retryMs;
        return e;
    }

    function hdrGet(headers, name) {
        if (!headers) return '';
        if (typeof headers.get === 'function') return headers.get(name) || '';
        if (typeof headers === 'string') {
            const m = headers.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
            return m ? m[1].trim() : '';
        }
        for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name.toLowerCase()) return String(v);
        return '';
    }

    function gmRequest(details) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                let settled = false;
                const done = (fn) => (res) => { if (!settled) { settled = true; fn(res); } };
                try {
                    GM_xmlhttpRequest({
                        anonymous: true, // 不携带 Cookie，翻译请求与账号无关
                        ...details,
                        onload: done(resolve),
                        onerror: done(() => reject(new TypeError('网络异常'))),
                        onabort: done(() => reject(new TypeError('请求已中止'))),
                        ontimeout: done(() => reject(httpError('请求超时', 0))),
                    });
                    return;
                } catch (_) { /* 走 fetch 兜底 */ }
            }
            const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = setTimeout(() => ctrl?.abort(), details.timeout || REQUEST_TIMEOUT);
            fetch(details.url, { method: details.method || 'GET', headers: details.headers, body: details.data, signal: ctrl?.signal, credentials: 'omit' })
                .then(async (r) => {
                    clearTimeout(timer);
                    resolve({ status: r.status, headers: r.headers, responseText: await r.text(), finalUrl: r.url });
                })
                .catch((e) => {
                    clearTimeout(timer);
                    reject(e instanceof Error && e.name === 'AbortError' ? httpError('请求超时', 0) : new TypeError('网络异常'));
                });
        });
    }

    function retryMsFrom(resp) {
        try {
            const ra = Number(hdrGet(resp.headers || resp.responseHeaders, 'retry-after'));
            if (ra > 0) return Math.min(ra * 1000, 5 * 60 * 1000);
        } catch (_) { /* ignore */ }
        return 0;
    }

    async function withRetry(fn, retries = 1) {
        for (let i = 0; ; i++) {
            try { return await fn(); } catch (err) {
                const transient = (err instanceof TypeError) || (err?.status >= 500 && err.status < 600);
                if (i >= retries || !transient) throw err;
                await sleep(700 * (i + 1));
            }
        }
    }

    /* =====================================================================
     * 8. 译文缓存 (LRU / 并发去重)
     * ===================================================================== */
    const CACHE_LIMIT = 800;
    const CACHE_TTL = 3 * 24 * 3600 * 1000;
    const PERSIST_MAX_LEN = 1500; // 过长译文只留内存，避免存储膨胀

    const cache = new Map();
    const inflight = new Map();
    const validCacheItem = (item, now) => item && typeof item.translation === 'string' && now - (item.t || 0) < CACHE_TTL;

    function loadPersistedCache() {
        if (!config.persistCache) return;
        const arr = readStore(CACHE_KEY, null);
        if (!Array.isArray(arr)) return;
        const now = Date.now();
        for (const [k, v] of arr) if (validCacheItem(v, now)) cache.set(k, v);
    }

    // 落盘前合并已有内容 (多标签页互不覆盖)
    const flushCache = () => {
        if (!config.persistCache) return;
        const now = Date.now();
        const merged = new Map();
        const stored = readStore(CACHE_KEY, null);
        if (Array.isArray(stored)) for (const [k, v] of stored) if (validCacheItem(v, now)) merged.set(k, v);
        for (const [k, v] of cache) {
            if (v.translation.length > PERSIST_MAX_LEN) continue;
            const prev = merged.get(k);
            merged.delete(k);
            merged.set(k, !prev || (v.t || 0) >= (prev.t || 0) ? v : prev);
        }
        writeStore(CACHE_KEY, Array.from(merged.entries()).slice(-CACHE_LIMIT));
    };
    const persistCacheSoon = debounce(flushCache, 10000);

    function cacheGet(key) {
        const v = cache.get(key);
        if (!v) return null;
        cache.delete(key);
        cache.set(key, v);
        return v;
    }
    function cacheSet(key, value) {
        value.t = Date.now();
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        persistCacheSoon();
    }
    function clearCaches() {
        cache.clear();
        providerFail.clear();
        deadUntil.clear();
        writeStore(CACHE_KEY, []);
    }
    function dedupe(key, factory) {
        if (inflight.has(key)) return inflight.get(key);
        const p = Promise.resolve().then(factory).finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }

    /* =====================================================================
     * 9. 语种判断
     * ===================================================================== */
    const baseLang = (l) => (l || '').toLowerCase().split('-')[0];
    const NO_LANG = new Set(['', 'und', 'zxx', 'auto']);

    const STOPWORDS = {
        en: 'the and is are was were you your that this with for have has not but they what just can will there their from about like all we it of to my if at be'.split(' '),
        de: 'der die das und ist nicht ich du wir auch mit für eine ein von zu den dem ja nein aber noch wie wird sind hat dass sie er'.split(' '),
        fr: 'le les des une est et pas pour dans que qui avec je tu nous vous mais sur ce cette au du'.split(' '),
        es: 'el los las una es y no que de en por con para pero como muy yo tu un se lo del al más'.split(' '),
        it: 'il lo gli una è e non che di per con ma come sono io tu un le della'.split(' '),
        pt: 'o os as uma um é e não que de em por com para mas como eu você do da'.split(' '),
        nl: 'de het een en is niet ik je we dat van op met voor maar ook zijn dit er'.split(' '),
    };
    const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));

    // 拉丁字母语种：用高频功能词占比判断；不确定时返回空串
    function detectLatinLang(text) {
        const words = text.toLowerCase().match(/\p{L}+/gu) || [];
        if (words.length < 3) return '';
        const score = {};
        for (const w of words) for (const k in STOP_SETS) if (STOP_SETS[k].has(w)) score[k] = (score[k] || 0) + 1;
        const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
        if (!ranked.length) return '';
        const [lang, hits] = ranked[0];
        const second = ranked[1]?.[1] || 0;
        return hits >= 2 && hits / words.length >= 0.25 && hits > second ? lang : '';
    }

    function detectLang(text) {
        const letters = text.match(/\p{L}/gu) || [];
        if (!letters.length) return '';
        const ratio = (re) => (text.match(re) || []).length / letters.length;
        if (/[\u3040-\u30ff]/.test(text) && ratio(/[\u3040-\u30ff\p{Script=Han}]/gu) > 0.5) return 'ja';
        if (ratio(/\p{Script=Hangul}/gu) > 0.5) return 'ko';
        if (ratio(/\p{Script=Cyrillic}/gu) > 0.6) return 'ru';
        if (!/[\u3040-\u30ff\uac00-\ud7af]/.test(text) && ratio(/\p{Script=Han}/gu) > 0.3) return 'zh';
        if (ratio(/[\u0600-\u06ff]/g) > 0.5) return 'ar';
        if (ratio(/[\u0900-\u097f]/g) > 0.5) return 'hi';
        if (ratio(/[\u0e00-\u0e7f]/g) > 0.5) return 'th';
        return detectLatinLang(text);
    }

    const cleanText = (t) => (t || '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/<a?:[\w~]+:\d+>/g, '')
        .replace(/(?<![\w])[:：][A-Za-z0-9_~]{2,32}[:：]/g, '')
        .replace(/[@＠][\w.\-]+/g, '')
        .replace(/[#＃][\p{L}\p{N}_-]+/gu, '')
        .trim();

    function resolveTargetLang() {
        if (config.targetLang && config.targetLang !== 'None') return config.targetLang;
        const raw = (navigator.language || rootEl.lang || 'zh').toLowerCase();
        if (raw.startsWith('zh')) return /tw|hk|hant/.test(raw) ? 'zh-TW' : 'zh-CN';
        return raw.split('-')[0] || 'zh-CN';
    }

    function isAlreadyTarget(text, targetLang) {
        return detectLang(text) === baseLang(targetLang);
    }

    function shouldSkip(text) {
        const cleaned = cleanText(text);
        if (!/\p{L}/u.test(cleaned)) return true;
        return config.skipSame && isAlreadyTarget(cleaned, resolveTargetLang());
    }

    const normText = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
    function isSameLanguageResult(result, original) {
        const s = baseLang(result.srcLang);
        if (s && s !== 'auto' && s === baseLang(resolveTargetLang())) return true;
        const o = normText(original);
        return !!o && o === normText(result.translation);
    }

    let displayNames = null;
    const langNameCache = new Map();
    function langName(code) {
        if (!code || NO_LANG.has(baseLang(code))) return '';
        if (langNameCache.has(code)) return langNameCache.get(code);
        let name = code;
        const zhNames = { 'zh-cn': '简体中文', 'zh-hans': '简体中文', 'zh-tw': '繁体中文', 'zh-hant': '繁体中文', 'zh-hk': '繁体中文' };
        if (zhNames[code.toLowerCase()]) { langNameCache.set(code, zhNames[code.toLowerCase()]); return zhNames[code.toLowerCase()]; }
        try {
            displayNames = displayNames || new Intl.DisplayNames(['zh-CN'], { type: 'language' });
            name = displayNames.of(code) || code;
        } catch (_) { /* ignore */ }
        langNameCache.set(code, name);
        return name;
    }

    /* =====================================================================
     * 10. 翻译通道 (Google → 微软 → MyMemory)，失败通道短时间拉黑
     * ===================================================================== */
    const DEAD_SHORT = 60 * 1000;
    const DEAD_LONG = 30 * 60 * 1000;
    const DEAD_RATE = 90 * 1000;
    const DEAD_AUTH = 5 * 60 * 1000;

    const GOOGLE_HOSTS = ['translate.googleapis.com', 'clients5.google.com'];
    const PROVIDER_CHAIN = ['google', 'microsoft', 'mymemory'];
    const PROVIDER_NAMES = { google: 'Google 翻译', microsoft: '微软翻译', mymemory: 'MyMemory' };

    const deadUntil = new Map();   // 'provider' 或 'google|host' → 截止时间
    const providerFail = new Map();
    const isDead = (key) => (deadUntil.get(key) || 0) > Date.now();
    const deadLeft = (key) => Math.max(0, (deadUntil.get(key) || 0) - Date.now());
    const markDead = (key, ms) => deadUntil.set(key, Date.now() + ms);
    const providerDead = (p) => isDead(p) || (p === 'google' && GOOGLE_HOSTS.every((x) => isDead(`google|${x}`)));
    const providerWait = (p) => (p === 'google' ? Math.min(deadLeft('google'), ...GOOGLE_HOSTS.map((x) => deadLeft(`google|${x}`))) : deadLeft(p));

    const edgeLang = (lang) => (lang === 'zh-CN' ? 'zh-Hans' : lang === 'zh-TW' ? 'zh-Hant' : lang);

    // 按行 → 句子 → 硬切 拆分长文本，保留拼接时的分隔符
    function splitText(text, limit) {
        if (text.length <= limit) return [{ text, sep: '' }];
        const pieces = [];
        const lines = text.split('\n');
        lines.forEach((line, li) => {
            const lead = li === 0 ? '' : '\n';
            if (line.length <= limit) { pieces.push({ text: line, sep: lead }); return; }
            const sents = line.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [line];
            let first = true;
            for (const s of sents) {
                for (let i = 0; i < s.length; i += limit) {
                    pieces.push({ text: s.slice(i, i + limit), sep: first ? lead : '' });
                    first = false;
                }
            }
        });
        const chunks = [];
        let cur = null;
        for (const p of pieces) {
            if (cur && cur.text.length + p.sep.length + p.text.length <= limit) cur.text += p.sep + p.text;
            else { cur = { text: p.text, sep: p.sep }; chunks.push(cur); }
        }
        return chunks;
    }
    const joinParts = (chunks, parts) => parts.map((t, i) => (i ? chunks[i].sep : '') + t).join('');

    /* ---------- Google ---------- */
    function googleParse(body) {
        const d = JSON.parse(body);
        if (d && Array.isArray(d.sentences)) {
            const text = d.sentences.map((s) => s.trans || '').join('');
            if (text) return { translation: text, srcLang: d.src || '' };
        }
        if (Array.isArray(d) && Array.isArray(d[0])) {
            const text = d[0].map((seg) => (Array.isArray(seg) ? seg[0] : '')).join('');
            if (text) return { translation: text, srcLang: d[2] || '' };
        }
        return null;
    }

    async function googleTranslate(text, lang) {
        let lastErr = null;
        for (const host of GOOGLE_HOSTS) {
            const deadKey = `google|${host}`;
            if (isDead(deadKey)) continue;
            const params = new URLSearchParams({ client: 'gtx', dj: '1', sl: 'auto', tl: lang, dt: 't', q: text });
            const init = text.length > 600
                ? { url: `https://${host}/translate_a/single`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: params.toString() }
                : { url: `https://${host}/translate_a/single?${params.toString()}`, method: 'GET' };
            try {
                const resp = await gmRequest({ timeout: REQUEST_TIMEOUT, ...init });
                if (resp.status === 200) {
                    const parsed = googleParse(resp.responseText);
                    if (parsed) return { ...parsed, provider: 'google' };
                    markDead(deadKey, DEAD_SHORT);
                    lastErr = httpError('译文解析失败', 502);
                } else if (resp.status === 429) {
                    const ra = retryMsFrom(resp);
                    markDead(deadKey, Math.max(DEAD_RATE, ra));
                    lastErr = httpError('请求过于频繁 (429)', 429, ra);
                } else {
                    if (resp.status === 404 || resp.status === 405) markDead(deadKey, DEAD_LONG);
                    lastErr = httpError(`HTTP ${resp.status}`, resp.status);
                }
            } catch (err) {
                markDead(deadKey, DEAD_SHORT);
                lastErr = err;
            }
        }
        throw lastErr || httpError('Google 翻译暂不可用', 503);
    }

    /* ---------- 微软 (Edge) ---------- */
    let edgeToken = null;
    function jwtExp(token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return Number(payload.exp) * 1000 || 0;
        } catch (_) { return 0; }
    }
    async function getEdgeToken(force = false) {
        if (!force && edgeToken && edgeToken.exp - 120000 > Date.now()) return edgeToken.token;
        const resp = await gmRequest({ url: 'https://edge.microsoft.com/translate/auth', method: 'GET', timeout: REQUEST_TIMEOUT });
        const token = (resp.responseText || '').trim();
        if (resp.status !== 200 || !token.startsWith('eyJ')) {
            markDead('microsoft', resp.status === 404 || resp.status === 405 ? DEAD_LONG : DEAD_SHORT);
            throw httpError(`微软翻译鉴权失败 (HTTP ${resp.status})`, resp.status);
        }
        edgeToken = { token, exp: jwtExp(token) || Date.now() + 8 * 60 * 1000 };
        return token;
    }

    async function microsoftTranslate(text, lang) {
        const chunks = splitText(text, 4000);
        for (let attempt = 0; ; attempt++) {
            const token = await getEdgeToken(attempt > 0);
            const resp = await gmRequest({
                url: `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(edgeLang(lang))}`,
                method: 'POST',
                timeout: REQUEST_TIMEOUT,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                data: JSON.stringify(chunks.map((c) => ({ Text: c.text }))),
            });
            if (resp.status === 401) {
                edgeToken = null;
                if (attempt === 0) continue; // 令牌过期：刷新后重试一次
                throw httpError('微软翻译鉴权过期', 401);
            }
            if (resp.status === 429) throw httpError('请求过于频繁 (429)', 429, retryMsFrom(resp));
            if (resp.status !== 200) {
                if (resp.status === 404 || resp.status === 405) markDead('microsoft', DEAD_LONG);
                throw httpError(`HTTP ${resp.status}`, resp.status);
            }
            const d = JSON.parse(resp.responseText);
            if (!Array.isArray(d) || d.length !== chunks.length) throw httpError('译文解析失败', 502);
            const parts = [];
            let srcLang = '';
            for (const item of d) {
                const t = item?.translations?.[0]?.text;
                if (typeof t !== 'string') throw httpError('译文解析失败', 502);
                srcLang = srcLang || item?.detectedLanguage?.language || '';
                parts.push(t);
            }
            return { translation: joinParts(chunks, parts), srcLang, provider: 'microsoft' };
        }
    }

    /* ---------- MyMemory ---------- */
    async function mymemoryTranslate(text, lang) {
        let src = detectLang(text) || 'en';
        if (src === 'zh') src = 'zh-CN';
        if (baseLang(src) === baseLang(lang)) return { translation: text, srcLang: src, provider: 'mymemory' };
        const chunks = splitText(text, 480);
        const parts = [];
        for (const chunk of chunks) {
            const url = `https://api.mymemory.translated.net/get?langpair=${encodeURIComponent(`${src}|${lang}`)}&q=${encodeURIComponent(chunk.text)}`;
            let resp = null;
            for (let attempt = 0; ; attempt++) {
                resp = await gmRequest({ url, method: 'GET', timeout: REQUEST_TIMEOUT });
                if (resp.status !== 429 || attempt >= 1) break;
                await sleep(1400);
            }
            if (resp.status === 429) throw httpError('请求过于频繁 (429)', 429, retryMsFrom(resp));
            if (resp.status !== 200) throw httpError(`HTTP ${resp.status}`, resp.status);
            let d;
            try { d = JSON.parse(resp.responseText); } catch (_) { throw httpError('译文解析失败', 502); }
            const status = Number(d?.responseStatus);
            if (status === 403 || status === 429) { markDead('mymemory', DEAD_LONG); throw httpError('MyMemory 配额已用尽', status); }
            const t = d?.responseData?.translatedText;
            if (!t || /^MYMEMORY WARNING/i.test(t)) throw httpError('MyMemory 无可用译文', 502);
            parts.push(t);
        }
        return { translation: joinParts(chunks, parts), srcLang: src, provider: 'mymemory' };
    }

    const callProvider = (p, text, lang) =>
        (p === 'google' ? googleTranslate(text, lang) : p === 'microsoft' ? microsoftTranslate(text, lang) : mymemoryTranslate(text, lang));

    async function requestTranslation(text, lang) {
        const explicit = config.provider !== 'auto';
        const order = explicit ? [config.provider] : PROVIDER_CHAIN;
        let rateLimited = false;
        let retryMs = 0;
        let lastErr = null;
        let tried = 0;

        for (const provider of order) {
            if (!explicit && providerDead(provider)) continue; // 手动指定通道时不跳过，由用户负责
            tried++;
            try {
                const result = await withRetry(() => callProvider(provider, text, lang), provider === 'google' ? 0 : 1);
                if (result?.translation) { providerFail.delete(provider); return result; }
                lastErr = lastErr || new Error('暂无可用译文');
            } catch (err) {
                console.warn('[Discord翻译] 通道不可用:', PROVIDER_NAMES[provider] || provider, err?.message || err);
                lastErr = err;
                if (err?.status === 429) {
                    rateLimited = true;
                    retryMs = Math.max(retryMs, err.retryMs || 0);
                    markDead(provider, Math.max(DEAD_RATE, err.retryMs || 0));
                } else if (err?.status === 401 || err?.status === 403) {
                    const n = (providerFail.get(provider) || 0) + 1;
                    if (n >= 2) { providerFail.delete(provider); markDead(provider, DEAD_AUTH); } else providerFail.set(provider, n);
                } else if (err instanceof TypeError) {
                    markDead(provider, DEAD_SHORT);
                } else if (err?.status === 404 || err?.status === 405) {
                    markDead(provider, DEAD_LONG);
                }
            }
        }
        if (rateLimited) throw httpError('请求过于频繁 (429)', 429, retryMs);
        if (!tried) {
            const wait = Math.min(...PROVIDER_CHAIN.map(providerWait));
            throw httpError(`翻译通道暂时不可用，约 ${Math.max(1, Math.ceil(wait / 1000))} 秒后自动恢复`, 503);
        }
        throw lastErr || new Error('所有翻译通道均不可用');
    }

    function friendlyError(err) {
        if (err?.name === 'AbortError') return '请求超时，请稍后重试';
        if (err instanceof TypeError) return '网络异常，请检查连接';
        if (err?.status === 429) return '请求过于频繁 (429)，请稍后重试';
        if (err?.status === 401 || err?.status === 403) return '翻译服务鉴权失败';
        return err?.message || String(err);
    }

    function getTranslation(text, lang, force) {
        const key = `t|${hashStr(text)}|${lang}`;
        if (force) cache.delete(key);
        const hit = cacheGet(key);
        if (hit) return Promise.resolve(hit);
        return dedupe(key, async () => {
            const r = await requestTranslation(text, lang);
            cacheSet(key, r);
            return r;
        });
    }

    /* =====================================================================
     * 11. 目标元素 / 文本提取
     * ===================================================================== */
    // 同一条消息有时被拆成多个 message-content 节点，按「消息行 + 消息 id」归为一组
    function contentKey(el) {
        const id = el?.id || '';
        return id.startsWith('message-content-') ? id.slice('message-content-'.length).replace(/-\d+$/, '') : '';
    }

    function groupFor(el) {
        if (!el || el.nodeType !== 1) return [];
        const scope = el.closest(MSG_ROW_SEL) || el.parentElement;
        if (!scope) return [el];
        let list = Array.from(scope.querySelectorAll(MSG_CONTENT_SEL));
        if (!list.includes(el)) list.push(el);
        const key = contentKey(el);
        if (key && list.some((n) => { const k = contentKey(n); return k && k !== key; })) {
            list = list.filter((n) => contentKey(n) === key);
        }
        list = list.filter((n) => !list.some((m) => m !== n && m.contains(n)));
        return list.sort((a, b) => (a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)));
    }
    const leaderOf = (el) => groupFor(el)[0] || el;

    function getAllTargets() {
        const out = [];
        const seen = new Set();
        for (const el of document.querySelectorAll(MSG_CONTENT_SEL)) {
            const leader = leaderOf(el);
            if (!seen.has(leader)) { seen.add(leader); out.push(leader); }
        }
        return out;
    }

    const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const SKIP_TAGS = new Set(['PRE', 'TIME', 'SCRIPT', 'STYLE', 'SVG']);

    // 自己遍历 DOM：保留 Unicode 表情，跳过代码块 / (已编辑) 时间戳，并屏蔽剧透内容 (避免译文泄露)
    function nodeText(root) {
        const out = [];
        const walk = (node) => {
            for (const c of node.childNodes) {
                if (c.nodeType === 3) { out.push(c.nodeValue); continue; }
                if (c.nodeType !== 1) continue;
                const tag = c.tagName.toUpperCase();
                if (tag === 'IMG') {
                    const alt = c.getAttribute('alt') || '';
                    if (alt && !/^:[^:\s]+:$/.test(alt)) out.push(alt); // 自定义表情 :name: 丢弃
                    continue;
                }
                if (tag === 'BR') { out.push('\n'); continue; }
                if (SKIP_TAGS.has(tag)) continue;
                if (typeof c.className === 'string' && /spoiler/i.test(c.className)) { out.push('▒▒'); continue; }
                const block = BLOCK_TAGS.has(tag);
                if (block) out.push('\n');
                walk(c);
                if (block) out.push('\n');
            }
        };
        walk(root);
        return out.join('').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function extractText(el) {
        return groupFor(el).map(nodeText).filter(Boolean).join('\n').trim();
    }

    /* =====================================================================
     * 12. 译文容器渲染
     * ===================================================================== */
    const TAB_VIEWS = ['translation', 'bilingual', 'original'];
    const TAB_LABELS = { translation: '译文', bilingual: '对照', original: '原文' };
    const defaultView = () => MODE_TO_VIEW[config.mode] || 'bilingual';

    const ENTITY_RE = /https?:\/\/[^\s<>"']+|(?<![\w#＃])[#＃][\p{L}\p{N}_-]{2,100}|(?<![\w@＠])[@＠][\w.\-]{2,32}/gu;
    const TRAIL_PUNCT_RE = /[.,;:!?)\]}>，。；：！？）》】]+$/;

    function renderFormattedText(text) {
        const nodes = [];
        let last = 0;
        for (const m of text.matchAll(ENTITY_RE)) {
            if (m.index > last) nodes.push(text.slice(last, m.index));
            let token = m[0];
            let suffix = '';
            if (token.startsWith('http')) {
                const pm = token.match(TRAIL_PUNCT_RE);
                if (pm) { suffix = pm[0]; token = token.slice(0, -suffix.length); }
                nodes.push(h('a', { class: 'dt-link', href: token, target: '_blank', rel: 'noopener noreferrer', onClick: stopEvt }, token));
            } else {
                nodes.push(h('span', { class: 'dt-mention' }, token));
            }
            if (suffix) nodes.push(suffix);
            last = m.index + m[0].length;
        }
        if (last < text.length) nodes.push(text.slice(last));
        return nodes;
    }

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
        try {
            const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (_) { return false; }
    }

    function applyView(box, el, view) {
        const members = groupFor(el);
        if (view) {
            box.dataset.view = view;
            members.forEach((n) => { n.dataset.dtView = view; });
        } else {
            delete box.dataset.view;
            members.forEach((n) => { delete n.dataset.dtView; });
        }
    }

    function setState(box, state) {
        box.dataset.state = state;
        if (state === 'loading') box.setAttribute('aria-busy', 'true'); else box.removeAttribute('aria-busy');
    }

    const boxOf = (el) => {
        const box = leaderOf(el)?._dtBox;
        return box && box.isConnected ? box : null;
    };
    const textElOfBox = (box) => box?._dtTarget || null;

    function syncActiveBoxesMode() {
        document.querySelectorAll('.dt-box[data-state="done"]').forEach((b) => b._setView?.(defaultView()));
    }

    // 正文若位于 flex / grid 容器内，译文改插到容器之后并按正文左边界缩进
    function insertionPoint(el) {
        const parent = el.parentElement;
        if (parent?.parentElement && /\b(flex|grid)\b/.test(getComputedStyle(parent).display || '')) return parent;
        return el;
    }

    const removeExpandBtns = (host) => host?.querySelectorAll(':scope > .dt-orig-expand-btn').forEach((c) => c.remove());

    function mountBox(el) {
        el = leaderOf(el);
        const prev = el._dtBox;
        if (prev?.isConnected) return prev; // 重试 / 重译复用同一容器，避免闪烁
        prev?.remove();

        const members = groupFor(el);
        const first = members[0] || el;
        const last = members[members.length - 1] || el;
        members.forEach((m) => removeExpandBtns(m.parentElement));

        const cs = getComputedStyle(first);
        const box = h('div', { class: 'dt-box', role: 'region', 'aria-label': '翻译' });
        setState(box, 'loading');
        if (cs.fontSize) box.style.setProperty('--dt-fs', cs.fontSize);
        if (cs.fontWeight) box.style.setProperty('--dt-fw', cs.fontWeight);
        if (cs.color) box.style.setProperty('--dt-text-color', cs.color);
        box._dtTarget = el;
        el._dtBox = box;

        const anchor = insertionPoint(last);
        anchor.after(box);

        if (anchor !== last && box.parentElement) {
            const prevViews = members.map((m) => m.dataset.dtView);
            members.forEach((m) => { delete m.dataset.dtView; });
            const cr = first.getBoundingClientRect();
            const hr = box.parentElement.getBoundingClientRect();
            members.forEach((m, i) => { if (prevViews[i]) m.dataset.dtView = prevViews[i]; });
            const indent = clamp(Math.round(cr.left - hr.left), 0, Math.max(0, Math.round(hr.width - 120)));
            if (indent > 0) {
                box.style.setProperty('--dt-indent', `${indent}px`);
                box.classList.add('dt-box-indented');
            }
        }
        return box;
    }

    function resetEl(el) {
        el = leaderOf(el);
        const members = groupFor(el);
        const box = el._dtBox;
        removeExpandBtns(box?.parentElement);
        box?.remove();
        el._dtBox = null;
        el._dtJob = 0;
        el._dtRetry = 0;
        members.forEach((m) => {
            m.classList.remove('dt-clamped');
            removeExpandBtns(m.parentElement);
            for (const k of ['dtStatus', 'dtView', 'dtKey', 'dtErrAt', 'dtQueued']) delete m.dataset[k];
        });
    }

    // 节点被复用给别的内容 / 译文容器被 Discord 重绘掉时，清掉旧状态
    function refreshReused(el) {
        el = leaderOf(el);
        const status = el.dataset.dtStatus;
        if (!status) return;
        if (status === 'translated' && !boxOf(el)) { resetEl(el); return; }
        if (el.dataset.dtKey && el.dataset.dtKey !== hashStr(extractText(el))) resetEl(el);
    }

    function markSkipped(el, text) {
        el.dataset.dtStatus = 'skipped';
        el.dataset.dtKey = hashStr(text);
    }

    function renderLoading(box, el, keepHidden) {
        setState(box, 'loading');
        applyView(box, el, keepHidden ? 'translation' : null);
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
        const lines = clamp(Math.round(el.offsetHeight / lh) || 2, 1, 4);
        box.replaceChildren(
            h('div', { class: 'dt-head', onClick: stopEvt },
                h('span', { class: 'dt-brand' }, icon('translate', 14), h('span', { class: 'dt-meta' }, '正在翻译'),
                    h('span', { class: 'dt-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')))),
            h('div', { class: 'dt-skel', 'aria-hidden': 'true' }, Array.from({ length: lines }, () => h('i'))),
        );
    }

    function renderError(box, el, message, retry) {
        setState(box, 'error');
        applyView(box, el, null);
        box.replaceChildren(
            h('div', { class: 'dt-head', role: 'alert', onClick: stopEvt },
                h('span', { class: 'dt-brand' }, icon('alert', 14), h('span', { class: 'dt-meta' }, `翻译失败：${message}`)),
                h('button', { class: 'dt-retry-link', type: 'button', onClick: (e) => { e.preventDefault(); e.stopPropagation(); retry(); } }, '重试')),
        );
    }

    function renderSame(box, el) {
        setState(box, 'same');
        applyView(box, el, null);
        box.replaceChildren(
            h('div', { class: 'dt-head', onClick: stopEvt },
                h('span', { class: 'dt-brand' }, icon('check', 14), h('span', { class: 'dt-meta' }, '原文已是目标语言'))),
        );
        setTimeout(() => collapseAndRemove(box), 1500);
    }

    const CLAMP_HEIGHT = 200;

    function setupOriginalClamping(el, box) {
        if (!el || !box?.isConnected || el.dataset.dtView === 'translation') return;
        if (groupFor(el).length > 1) return;
        const host = box.parentElement;
        if (!host || host.querySelector(':scope > .dt-orig-expand-btn')) return;
        requestAnimationFrame(() => {
            if (!el.isConnected || !box.isConnected || el.dataset.dtView === 'translation') return;
            removeExpandBtns(host);
            if (el.scrollHeight > CLAMP_HEIGHT + 30) {
                el.classList.add('dt-clamped');
                const btn = h('button', {
                    class: 'dt-expand-btn dt-orig-expand-btn', type: 'button', 'aria-expanded': 'false',
                    onClick: (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const wasClamped = el.classList.toggle('dt-clamped');
                        btn.textContent = wasClamped ? '展开原文 ▼' : '收起原文 ▲';
                        btn.setAttribute('aria-expanded', String(!wasClamped));
                    },
                }, '展开原文 ▼');
                host.insertBefore(btn, box);
            } else {
                el.classList.remove('dt-clamped');
            }
        });
    }

    function setupTranslationClamping(body, box) {
        if (!body || !box || box.querySelector('.dt-trans-expand-btn')) return;
        requestAnimationFrame(() => {
            if (!box.isConnected || box.dataset.view === 'original') return;
            box.querySelectorAll('.dt-trans-expand-btn').forEach((c) => c.remove());
            if (body.scrollHeight > CLAMP_HEIGHT + 30) {
                body.classList.add('dt-clamped');
                const btn = h('button', {
                    class: 'dt-expand-btn dt-trans-expand-btn', type: 'button', 'aria-expanded': 'false',
                    onClick: (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const wasClamped = body.classList.toggle('dt-clamped');
                        btn.textContent = wasClamped ? '展开译文 ▼' : '收起译文 ▲';
                        btn.setAttribute('aria-expanded', String(!wasClamped));
                    },
                }, '展开译文 ▼');
                box.appendChild(btn);
            } else {
                body.classList.remove('dt-clamped');
            }
        });
    }

    function renderResult(box, el, result, retry, opts = {}) {
        const preview = !!opts.preview;
        setState(box, 'done');
        const src = langName(result.srcLang);
        const dstCode = resolveTargetLang();
        const dst = langName(dstCode);
        const meta = [src ? (dst ? `${src} → ${dst}` : src) : dst, PROVIDER_NAMES[result.provider] || result.provider]
            .filter(Boolean).join(' · ');

        let tools = null;
        if (!preview) {
            const copyBtn = h('button', { class: 'dt-ibtn', type: 'button', title: '复制译文（Shift+点击：连同原文）', 'aria-label': '复制译文', 'data-act': 'copy' }, icon('copy', 14));
            copyBtn.addEventListener('click', async (e) => {
                e.preventDefault(); e.stopPropagation();
                const text = e.shiftKey ? `${extractText(el)}\n\n${result.translation}` : result.translation;
                if (!(await copyText(text))) { showToast('复制失败，请检查浏览器剪贴板权限', 'warn'); return; }
                copyBtn.classList.add('dt-ok');
                copyBtn.replaceChildren(icon('check', 14));
                setTimeout(() => { copyBtn.classList.remove('dt-ok'); copyBtn.replaceChildren(icon('copy', 14)); }, 1400);
            });
            const retryBtn = h('button', {
                class: 'dt-ibtn', type: 'button', title: '重新翻译', 'aria-label': '重新翻译', 'data-act': 'refresh',
                onClick: (e) => { e.preventDefault(); e.stopPropagation(); retry(); },
            }, icon('refresh', 14));
            const cfgBtn = h('button', {
                class: 'dt-ibtn', type: 'button', title: '翻译设置 (Alt+Shift+T)', 'aria-label': '翻译设置', 'data-act': 'cfg',
                onClick: (e) => { e.preventDefault(); e.stopPropagation(); openSettings(); },
            }, icon('settings', 14));
            tools = h('span', { class: 'dt-tools' }, copyBtn, retryBtn, cfgBtn);
        }

        const ind = h('span', { class: 'dt-tab-ind', 'aria-hidden': 'true' });
        const tabBtns = TAB_VIEWS.map((val) => h('button', {
            class: 'dt-tab', type: 'button', 'data-value': val, 'aria-pressed': 'false',
            onClick: (e) => { e.preventDefault(); e.stopPropagation(); setView(val); },
        }, TAB_LABELS[val]));
        const tabs = h('span', { class: 'dt-tabs', role: 'group', 'aria-label': '显示方式' }, ind, ...tabBtns);

        const head = h('div', { class: 'dt-head', onClick: stopEvt },
            h('span', { class: 'dt-brand' }, icon('translate', 14), h('span', { class: 'dt-meta', title: meta }, meta)),
            h('span', { class: 'dt-actions' }, tools, tabs));

        const body = h('div', { class: 'dt-body-wrap' },
            h('div', { class: 'dt-body-clip' },
                h('div', {
                    class: 'dt-body', dir: 'auto', lang: dstCode && dstCode !== 'None' ? dstCode : null,
                    onClick: (e) => { if (window.getSelection?.()?.toString()) e.stopPropagation(); },
                }, ...renderFormattedText(result.translation))));

        function setView(view, { animate = true } = {}) {
            const prev = box.dataset.view;
            applyView(box, el, view);
            tabs.style.setProperty('--dt-i', Math.max(0, TAB_VIEWS.indexOf(view)));
            tabBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === view)));
            if (animate && prev === 'translation' && view !== 'translation' && motionOn() && typeof el.animate === 'function') {
                el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE });
            }
            if (!preview) {
                if (view !== 'translation') setupOriginalClamping(el, box);
                if (view !== 'original') setupTranslationClamping(body, box);
            }
        }

        box._setView = setView;
        box.replaceChildren(head, body);
        setView(box._wantView || defaultView(), { animate: false });
    }

    /* =====================================================================
     * 13. 翻译主流程
     * ===================================================================== */
    function markError(el) {
        el.dataset.dtStatus = 'error';
        el.dataset.dtErrAt = String(Date.now());
    }
    const inErrorCooldown = (el, ms) => el.dataset.dtStatus === 'error' && Date.now() - (Number(el.dataset.dtErrAt) || 0) < ms;

    async function runJob(el, job, force) {
        const token = (el._dtJob = (el._dtJob || 0) + 1);
        const stale = () => el._dtJob !== token || !el.isConnected;

        refreshTheme();
        const cached = force ? null : cacheGet(job.cacheKey);
        const prevView = el.dataset.dtView;
        const reused = !!boxOf(el);
        let box = mountBox(el);
        if (prevView) box._wantView = prevView;
        const show = (fn) => {
            if (cached && !reused) { fn(); animateIn(box); } else morph(box, fn);
        };
        if (!cached) {
            renderLoading(box, el, prevView === 'translation');
            if (!reused) animateIn(box);
        }

        try {
            const result = cached || await job.fetch(force);
            if (stale()) return;
            if (!box.isConnected) box = mountBox(el); // Discord 重绘掉了容器：重新挂载

            if (!result || !result.translation) {
                markError(el);
                show(() => renderError(box, el, '暂无可用译文', job.retry));
                return;
            }
            if (isSameLanguageResult(result, job.text)) {
                el.dataset.dtStatus = 'translated';
                if (job.silentSame) { applyView(box, el, null); collapseAndRemove(box); } else show(() => renderSame(box, el));
                return;
            }
            show(() => renderResult(box, el, result, job.retry));
            el.dataset.dtStatus = 'translated';
        } catch (err) {
            if (stale()) return;
            if (job.onError?.(err) === 'defer') {
                applyView(box, el, null);
                collapseAndRemove(box);
                delete el.dataset.dtStatus;
                delete el.dataset.dtQueued;
                setTimeout(() => enqueue(el, true), 0);
                return;
            }
            markError(el);
            show(() => renderError(box, el, friendlyError(err), job.retry));
        }
    }

    async function translateEl(el, { force = false, auto = false } = {}) {
        const status = el.dataset.dtStatus;
        if (status === 'translating') return;
        if (!force && (status === 'translated' || status === 'skipped')) return;
        if (!force && inErrorCooldown(el, 5000)) return;

        const text = extractText(el);
        if (!text) return;
        if (!force && shouldSkip(text)) { markSkipped(el, text); return; }

        const key = hashStr(text);
        if (el.dataset.dtKey && el.dataset.dtKey !== key) resetEl(el);

        const lang = resolveTargetLang();
        el.dataset.dtStatus = 'translating';
        el.dataset.dtKey = key;

        return runJob(el, {
            cacheKey: `t|${key}|${lang}`,
            text,
            fetch: (f) => getTranslation(text, lang, f),
            retry: () => translateEl(el, { force: true }),
            silentSame: auto,
            onError: (err) => {
                if (err?.status !== 429) return undefined;
                pauseQueue(err.retryMs);
                if (auto && (el._dtRetry = (el._dtRetry || 0) + 1) <= 3) return 'defer';
                return undefined;
            },
        }, force);
    }

    /* =====================================================================
     * 14. 批量队列 / 自动翻译
     * ===================================================================== */
    const AUTO_DWELL = 400;
    const QUEUE_CONCURRENCY = 2;
    const QUEUE_GAP = 300;
    const PAUSE_MS = 45000;

    let autoIO = null;
    let pumpTimer = 0;
    let autoObserved = new WeakSet();
    const autoTimers = new Map();
    let queue = [];
    let activeJobs = 0;
    let pausedUntil = 0;
    let lastPauseNote = 0;

    function inViewport(el) {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    }

    // 优先翻译离视野中线最近的内容
    function takeNext() {
        if (queue.length < 2) return queue.shift();
        const mid = window.innerHeight / 2;
        let best = 0;
        let bestDist = Infinity;
        queue.forEach((job, i) => {
            const r = job.el.getBoundingClientRect();
            const d = Math.abs((r.top + r.bottom) / 2 - mid);
            if (d < bestDist) { bestDist = d; best = i; }
        });
        return queue.splice(best, 1)[0];
    }

    function pauseQueue(ms) {
        const wait = Math.max(PAUSE_MS, ms || 0);
        const until = Date.now() + wait;
        const already = pausedUntil > Date.now();
        if (until > pausedUntil) pausedUntil = until;
        if (!already && (config.autoTranslate || queue.length)) showToast(`请求过于频繁，批量翻译暂停 ${Math.round(wait / 1000)} 秒`, 'warn');
    }

    function notePaused(ms) {
        const now = Date.now();
        if (now - lastPauseNote < 4000) return;
        lastPauseNote = now;
        showToast(`触发限流，约 ${Math.ceil(ms / 1000)} 秒后再试`, 'warn');
    }

    function pump() {
        clearTimeout(pumpTimer);
        const wait = pausedUntil - Date.now();
        if (wait > 0) { pumpTimer = setTimeout(pump, wait + 50); return; }
        if (document.hidden) return;
        while (activeJobs < QUEUE_CONCURRENCY && queue.length) {
            const { el, auto } = takeNext();
            delete el.dataset.dtQueued;
            if (!el.isConnected) continue;
            refreshReused(el);
            if (el.dataset.dtStatus || !inViewport(el)) continue;
            activeJobs++;
            translateEl(el, { auto })
                .catch(() => { /* 错误已在界面内展示 */ })
                .finally(() => { activeJobs--; setTimeout(pump, QUEUE_GAP); });
        }
    }

    function enqueue(el, auto) {
        if (!el.isConnected || el.dataset.dtStatus || el.dataset.dtQueued) return;
        el.dataset.dtQueued = '1';
        queue.push({ el, auto });
        pump();
    }

    function onAutoIntersect(entries) {
        for (const entry of entries) {
            const el = entry.target;
            if (!el.isConnected) {
                autoIO?.unobserve(el);
                clearTimeout(autoTimers.get(el));
                autoTimers.delete(el);
                continue;
            }
            const visible = entry.isIntersecting &&
                (entry.intersectionRatio >= 0.3 || entry.intersectionRect.height >= window.innerHeight * 0.35);
            if (visible) {
                refreshReused(el);
                if (autoTimers.has(el) || el.dataset.dtStatus) continue;
                autoTimers.set(el, setTimeout(() => {
                    autoTimers.delete(el);
                    if (config.autoTranslate) enqueue(el, true);
                }, AUTO_DWELL));
            } else if (autoTimers.has(el)) {
                clearTimeout(autoTimers.get(el));
                autoTimers.delete(el);
            }
        }
    }

    function autoWatch(el) {
        if (!autoIO || autoObserved.has(el)) return;
        autoObserved.add(el);
        autoIO.observe(el);
    }

    function startAuto() {
        if (autoIO || !document.body || typeof IntersectionObserver !== 'function') return;
        autoIO = new IntersectionObserver(onAutoIntersect, { rootMargin: '-8% 0px -6% 0px', threshold: [0, 0.3, 0.6] });
        getAllTargets().forEach(autoWatch);
    }

    function stopAuto() {
        autoIO?.disconnect();
        autoIO = null;
        autoTimers.forEach((t) => clearTimeout(t));
        autoTimers.clear();
        queue.filter((j) => j.auto).forEach((j) => { delete j.el.dataset.dtQueued; });
        queue = queue.filter((j) => !j.auto);
        autoObserved = new WeakSet();
    }

    function setAuto(on, { toast = true } = {}) {
        config.autoTranslate = !!on;
        saveConfig();
        if (config.autoTranslate) startAuto(); else stopAuto();
        if (toast) showToast(on ? '自动翻译已开启' : '自动翻译已关闭', on ? 'ok' : 'off');
        floatPill?.setAttribute('data-auto', config.autoTranslate ? 'on' : 'off');
        panel?.syncDeps?.();
    }

    function translateVisibleNow() {
        const els = getAllTargets().filter((el) => !el.dataset.dtStatus && inViewport(el) && !shouldSkip(extractText(el)));
        if (!els.length) { showToast('当前屏幕没有需要翻译的消息', 'off'); return; }
        els.forEach((el) => enqueue(el, false));
        showToast(`正在翻译当前屏幕的 ${els.length} 条消息`);
    }

    function dropQueue() {
        queue.forEach((j) => { delete j.el.dataset.dtQueued; });
        queue = [];
    }

    function retranslateAll() {
        dropQueue();
        const els = Array.from(document.querySelectorAll('[data-dt-status]')).filter((el) => !el.closest('.dt-overlay'));
        if (!els.length) return;
        els.forEach((el) => { resetEl(el); if (inViewport(el)) enqueue(el, false); });
        showToast('目标语言已更新，正在重新翻译');
    }

    function clearAllTranslations() {
        dropQueue();
        let n = 0;
        document.querySelectorAll('[data-dt-status]').forEach((el) => {
            if (el.closest('.dt-overlay')) return;
            const had = el.dataset.dtStatus === 'translated' || !!boxOf(el);
            const text = extractText(el);
            resetEl(el);
            markSkipped(el, text);
            if (had) n++;
        });
        showToast(n ? `已还原 ${n} 处译文` : '本页没有需要还原的译文', n ? 'ok' : 'off');
    }

    /* =====================================================================
     * 15. 设置面板
     * ===================================================================== */
    let panel = null;
    let floatPill = null;
    let lastTab = 0;

    function buildSeg(items, current, onPick) {
        const idx = Math.max(0, items.findIndex(([v]) => v === current));
        const seg = h('div', { class: 'dt-seg', role: 'group' }, h('span', { class: 'dt-seg-thumb', 'aria-hidden': 'true' }));
        seg.style.setProperty('--n', items.length);
        seg.style.setProperty('--i', idx);
        const btns = items.map(([value, label], i) => h('button', {
            type: 'button', 'data-value': value, 'aria-pressed': String(value === current),
            onClick: (e) => {
                e.preventDefault(); e.stopPropagation();
                seg.style.setProperty('--i', i);
                btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
                onPick(value);
            },
        }, label));
        seg.append(...btns);
        return seg;
    }

    function buildSwitch(label, get, set) {
        const sw = h('button', { class: 'dt-switch', type: 'button', role: 'switch', 'aria-checked': String(!!get()), 'aria-label': label });
        sw.addEventListener('click', () => { set(!get()); sw.setAttribute('aria-checked', String(!!get())); });
        return sw;
    }

    function buildPreview() {
        const orig = h('div', { class: 'dt-pv-text', lang: 'en' }, 'Anyone up for a quick game tonight? I will be in the voice channel after 9.');
        const box = h('div', { class: 'dt-box', 'data-preview': '' });
        box._dtTarget = orig;
        renderResult(box, orig, { translation: '今晚有人想快速来一局吗？九点后我会在语音频道。', srcLang: 'en', provider: 'google' }, () => { }, { preview: true });
        return h('div', { class: 'dt-preview' },
            h('div', { class: 'dt-pv-avatar', 'aria-hidden': 'true' }, 'A'),
            h('div', { class: 'dt-pv-main' },
                h('div', { class: 'dt-pv-name' }, 'Alex', h('span', { class: 'dt-pv-time' }, '今天 21:03')),
                orig, box));
    }

    function closeSettings() {
        if (!panel) return;
        const { overlay, prevFocus } = panel;
        panel = null;
        overlay.classList.add('dt-closing');
        setTimeout(() => overlay.remove(), motionOn() ? 160 : 0);
        try { prevFocus?.focus?.({ preventScroll: true }); } catch (_) { /* ignore */ }
    }

    function resetSettings() {
        Object.assign(config, DEFAULTS);
        saveConfig();
        syncRootAttrs();
        if (config.autoTranslate) startAuto(); else stopAuto();
        updatePill();
        syncActiveBoxesMode();
    }

    function openSettings() {
        if (panel) { closeSettings(); return; }
        refreshTheme();
        const prevFocus = document.activeElement;

        const rows = {};
        const row = (title, desc, control, key) => {
            const r = h('div', { class: 'dt-row' },
                h('div', { class: 'dt-row-info' }, h('div', { class: 'dt-row-title' }, title), h('div', { class: 'dt-row-desc' }, desc)),
                control);
            if (key) rows[key] = r;
            return r;
        };
        const sec = (text) => h('div', { class: 'dt-sec' }, text);
        const divider = () => h('div', { class: 'dt-divider' });
        const kbd = (...keys) => h('span', null, keys.map((k) => h('kbd', { class: 'dt-kbd' }, k)));

        let autoSwitch = null;
        const syncDeps = () => {
            const r = rows.delay;
            if (r) { r.dataset.disabled = String(config.triggerKey !== 'none'); r.inert = config.triggerKey !== 'none'; }
            autoSwitch?.setAttribute('aria-checked', String(config.autoTranslate));
        };

        const sw = (key, label, after) => buildSwitch(label, () => config[key], (v) => {
            config[key] = v;
            saveConfig();
            after?.(v);
            syncDeps();
        });
        const makeSelect = (options, current, label, onChange) => {
            const sel = h('select', { class: 'dt-select', 'aria-label': label }, options.map(([v, text]) => h('option', { value: v }, text)));
            sel.value = current;
            sel.addEventListener('change', () => onChange(sel.value));
            return sel;
        };

        const styleSeg = buildSeg(STYLE_OPTIONS, config.style, (v) => { config.style = v; saveConfig(); syncRootAttrs(); });
        const motionSwitch = sw('motion', '界面动效', () => syncRootAttrs());

        const langSelect = makeSelect(LANG_OPTIONS, config.targetLang, '目标语言', (v) => {
            if (v === config.targetLang) return;
            config.targetLang = v;
            saveConfig();
            retranslateAll();
        });
        const providerSelect = makeSelect(PROVIDER_OPTIONS, config.provider, '翻译通道', (v) => { config.provider = v; saveConfig(); });
        const trigSelect = makeSelect(TRIGGER_OPTIONS, config.triggerKey, '触发方式', (v) => { config.triggerKey = v; saveConfig(); syncDeps(); });

        const rangeLabel = () => (config.delay === 0 ? '立即' : `${config.delay}ms`);
        const rangeVal = h('span', { class: 'dt-range-val' }, rangeLabel());
        const range = h('input', { class: 'dt-range', type: 'range', min: 0, max: 1000, step: 50, value: config.delay, 'aria-label': '悬停延迟' });
        const paintRange = () => range.style.setProperty('--p', `${(Number(range.value) / 10).toFixed(1)}%`);
        paintRange();
        range.addEventListener('input', () => { config.delay = Number(range.value); rangeVal.textContent = rangeLabel(); paintRange(); });
        range.addEventListener('change', saveConfig);

        autoSwitch = buildSwitch('自动翻译', () => config.autoTranslate, (v) => { setAuto(v, { toast: false }); syncDeps(); });

        const pLook = [
            buildPreview(),
            sec('外观'),
            row('译文样式', '引用：左侧色条；嵌入卡片：与 Discord 嵌入一致；极简：仅细竖线', styleSeg),
            row('界面动效', '过渡与弹出动画；系统开启「减少动态效果」时自动关闭', motionSwitch),
            divider(),
            sec('默认显示方式'),
            row('消息译文', '新译文的默认呈现形态（卡片上的切换只影响该条）', buildSeg(MODE_OPTIONS, config.mode, (v) => {
                config.mode = v;
                saveConfig();
                syncActiveBoxesMode();
            })),
        ];

        const pTrigger = [
            sec('翻译服务'),
            row('目标语言', '默认跟随浏览器语言；更改后视野内的译文会立即重译', langSelect),
            row('翻译通道', '自动模式下通道失败会切到下一个；单独指定时不会自动切换', providerSelect),
            divider(),
            sec('手动翻译'),
            row('触发方式', '直接悬停，或按下修饰键的那一刻触发（Ctrl+C 之类的组合键不会误触）', trigSelect),
            row('悬停响应延迟', '仅「鼠标直接悬停」时生效；使用修饰键时立即翻译', h('div', { class: 'dt-range-wrap' }, range, rangeVal), 'delay'),
            divider(),
            sec('自动翻译'),
            row('自动翻译视野内的消息', '滚动时，停留在视野内的外语消息会自动翻译；遇到限流会暂停并稍后重试', autoSwitch),
        ];

        const clearBtn = h('button', { class: 'dt-btn', type: 'button' }, `清除缓存 (${cache.size})`);
        clearBtn.addEventListener('click', () => {
            clearCaches();
            clearBtn.textContent = '已清除';
            setTimeout(() => { clearBtn.textContent = `清除缓存 (${cache.size})`; }, 1300);
        });

        const pBehave = [
            sec('翻译行为'),
            row('跳过已是目标语言的消息', '识别中日韩俄及常见拉丁语种，避免无意义的请求', sw('skipSame', '跳过已是目标语言的消息')),
            divider(),
            sec('悬浮按钮'),
            row('显示悬浮操作条', '可拖动；隐藏后仍可用快捷键与脚本菜单操作', sw('showPill', '显示悬浮操作条', () => updatePill())),
            divider(),
            sec('缓存'),
            row('持久化译文缓存', '刷新页面后沿用已翻译内容（保留 3 天）',
                sw('persistCache', '持久化译文缓存', (v) => { if (v) persistCacheSoon(); else writeStore(CACHE_KEY, []); })),
            divider(),
            sec('快捷键'),
            h('div', { class: 'dt-keys' },
                h('div', null, h('span', null, '打开 / 关闭设置'), kbd('Alt', 'Shift', 'T')),
                h('div', null, h('span', null, '开关自动翻译'), kbd('Alt', 'Shift', 'A')),
                h('div', null, h('span', null, '翻译当前屏幕所有消息'), kbd('Alt', 'Shift', 'G')),
                h('div', null, h('span', null, '强制翻译鼠标所在的消息'), kbd('Alt', 'Shift', 'F')),
                h('div', null, h('span', null, '还原本页全部译文'), kbd('Alt', 'Shift', 'R'))),
        ];

        const TABS = [['外观', pLook], ['翻译', pTrigger], ['行为', pBehave]];
        const pages = TABS.map(([, items], i) => {
            const p = h('div', { class: 'dt-page', role: 'tabpanel', id: `dt-page-${i}`, 'aria-labelledby': `dt-ptab-${i}` }, items);
            Array.from(p.children).forEach((c, j) => c.style.setProperty('--dt-d', Math.min(j, 12)));
            return p;
        });
        const body = h('div', { class: 'dt-panel-body' }, pages);

        const tabsEl = h('div', { class: 'dt-ptabs', role: 'tablist', 'aria-label': '设置分类' });
        tabsEl.style.setProperty('--n', TABS.length);
        const tabBtns = TABS.map(([label], i) => h('button', {
            class: 'dt-ptab', type: 'button', role: 'tab', id: `dt-ptab-${i}`, 'aria-controls': `dt-page-${i}`,
            onClick: () => selectTab(i),
            onKeydown: (e) => {
                const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
                if (next === undefined) return;
                e.preventDefault();
                selectTab((next + TABS.length) % TABS.length, true);
            },
        }, label));
        tabsEl.append(h('span', { class: 'dt-ptab-ind', 'aria-hidden': 'true' }), ...tabBtns);
        body.addEventListener('scroll', () => tabsEl.classList.toggle('dt-scrolled', body.scrollTop > 4), { passive: true });

        function selectTab(i, focus = false) {
            lastTab = i;
            tabsEl.style.setProperty('--i', i);
            tabBtns.forEach((b, j) => { b.setAttribute('aria-selected', String(j === i)); b.tabIndex = j === i ? 0 : -1; });
            pages.forEach((p, j) => { p.hidden = j !== i; });
            body.scrollTop = 0;
            tabsEl.classList.remove('dt-scrolled');
            if (focus) tabBtns[i].focus({ preventScroll: true });
        }

        const resetBtn = h('button', { class: 'dt-btn', type: 'button', 'data-kind': 'danger' }, '重置设置');
        let resetTimer = 0;
        resetBtn.addEventListener('click', () => {
            if (!resetTimer) {
                resetBtn.textContent = '再点一次确认';
                resetTimer = setTimeout(() => { resetTimer = 0; resetBtn.textContent = '重置设置'; }, 2500);
                return;
            }
            clearTimeout(resetTimer);
            resetSettings();
            closeSettings();
            showToast('已恢复默认设置');
            setTimeout(openSettings, motionOn() ? 260 : 0);
        });

        const closeBtn = h('button', { class: 'dt-close-btn', type: 'button', title: '关闭 (Esc)', 'aria-label': '关闭', onClick: closeSettings }, icon('close', 20));
        const doneBtn = h('button', { class: 'dt-btn', type: 'button', 'data-kind': 'primary', onClick: closeSettings }, '完成');

        const overlay = h('div', { class: 'dt-overlay' },
            h('div', { class: 'dt-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dt-panel-title' },
                h('div', { class: 'dt-panel-head' }, h('div', { class: 'dt-panel-title', id: 'dt-panel-title' }, '翻译设置'), closeBtn),
                tabsEl,
                body,
                h('div', { class: 'dt-panel-foot' },
                    h('span', { class: 'dt-foot-actions' }, clearBtn, resetBtn),
                    h('span', { class: 'dt-foot-end' }, `v${VERSION}`, doneBtn))));

        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeSettings(); });
        overlay.addEventListener('keydown', (e) => {
            if (!(e.altKey && e.shiftKey)) e.stopPropagation();
            if (e.key === 'Escape') { closeSettings(); return; }
            if (e.key === 'Tab') {
                const f = Array.from(overlay.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled])'))
                    .filter((n) => n.tabIndex >= 0 && n.getClientRects().length > 0 && !n.closest('[inert]'));
                if (!f.length) return;
                if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
                else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
            }
        });
        overlay.addEventListener('click', stopEvt);

        syncDeps();
        selectTab(lastTab);
        document.body.appendChild(overlay);
        panel = { overlay, prevFocus, syncDeps };
        doneBtn.focus({ preventScroll: true });
    }

    if (typeof GM_registerMenuCommand === 'function') {
        const reg = (name, fn) => { try { GM_registerMenuCommand(name, fn); } catch (_) { /* ignore */ } };
        reg('⚙️ 翻译设置', openSettings);
        reg('⚡ 开关自动翻译', () => setAuto(!config.autoTranslate));
        reg('🌐 翻译当前屏幕所有内容', translateVisibleNow);
        reg('↩️ 还原本页全部译文', clearAllTranslations);
        reg('🧹 清除译文缓存', () => { clearCaches(); showToast('译文缓存已清除'); });
    }

    /* =====================================================================
     * 16. 悬浮操作条 (可拖动，位置记忆) / 悬停触发 / 快捷键
     * ===================================================================== */
    let pillPos = readStore(PILL_KEY, null); // { r, b }：距右 / 距下的像素

    function applyPillPos() {
        if (!floatPill) return;
        if (!pillPos || typeof pillPos.r !== 'number' || typeof pillPos.b !== 'number') {
            floatPill.style.removeProperty('right');
            floatPill.style.removeProperty('bottom');
            return;
        }
        const w = floatPill.offsetWidth || 90;
        const hh = floatPill.offsetHeight || 36;
        floatPill.style.right = `${clamp(pillPos.r, 4, Math.max(4, window.innerWidth - w - 4))}px`;
        floatPill.style.bottom = `${clamp(pillPos.b, 4, Math.max(4, window.innerHeight - hh - 4))}px`;
    }

    function updatePill() {
        if (!floatPill) return;
        floatPill.hidden = !config.showPill;
        floatPill.setAttribute('data-auto', config.autoTranslate ? 'on' : 'off');
        applyPillPos();
    }

    function createFloatPill() {
        if (floatPill || !document.body) return;
        const grip = h('span', { class: 'dt-grip', title: '拖动移动位置（双击恢复默认）' }, icon('grip', 12));
        floatPill = h('div', { class: 'dt-float-pill' },
            grip,
            h('button', {
                class: 'dt-ibtn', type: 'button', title: '翻译当前屏幕所有内容 (Alt+Shift+G)', 'aria-label': '翻译当前屏幕所有内容',
                onClick: (e) => { e.preventDefault(); e.stopPropagation(); translateVisibleNow(); },
            }, icon('zap', 15)),
            h('button', {
                class: 'dt-ibtn', type: 'button', title: '翻译设置 (Alt+Shift+T)', 'aria-label': '翻译设置',
                onClick: (e) => { e.preventDefault(); e.stopPropagation(); openSettings(); },
            }, icon('settings', 15)),
            h('span', { class: 'dt-pill-dot', 'aria-hidden': 'true' }));

        let drag = null;
        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const rect = floatPill.getBoundingClientRect();
            drag = { x: e.clientX, y: e.clientY, r: window.innerWidth - rect.right, b: window.innerHeight - rect.bottom };
            floatPill.setAttribute('data-drag', '');
            try { grip.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            e.preventDefault();
        });
        grip.addEventListener('pointermove', (e) => {
            if (!drag) return;
            pillPos = { r: Math.round(drag.r - (e.clientX - drag.x)), b: Math.round(drag.b - (e.clientY - drag.y)) };
            applyPillPos();
        });
        const endDrag = () => {
            if (!drag) return;
            drag = null;
            floatPill.removeAttribute('data-drag');
            if (pillPos) writeStore(PILL_KEY, pillPos);
        };
        grip.addEventListener('pointerup', endDrag);
        grip.addEventListener('pointercancel', endDrag);
        grip.addEventListener('dblclick', () => { pillPos = null; writeStore(PILL_KEY, null); applyPillPos(); });

        floatPill.addEventListener('mousedown', stopEvt);
        floatPill.addEventListener('click', stopEvt);
        window.addEventListener('resize', debounce(applyPillPos, 150));
        document.body.appendChild(floatPill);
        updatePill();
    }

    let hoverTimer = null;
    let currentEl = null;
    let hoverBox = null;
    let lastX = -1;
    let lastY = -1;
    let movedSinceScroll = true; // 滚动会补发 mouseover：鼠标真正移动后才算「想翻译这一条」

    const MOD_KEYS = { alt: ['Alt'], ctrl: ['Control', 'Meta'], shift: ['Shift'] };
    function modifierMatched(e) {
        if (config.triggerKey === 'alt') return e.altKey;
        if (config.triggerKey === 'ctrl') return e.ctrlKey || e.metaKey;
        if (config.triggerKey === 'shift') return e.shiftKey;
        return true;
    }

    function armTranslation(el, immediate = false) {
        clearTimeout(hoverTimer);
        refreshReused(el);
        const st = el.dataset.dtStatus;
        if (st === 'translating' || st === 'translated' || st === 'skipped') return;

        const text = extractText(el);
        if (shouldSkip(text)) { markSkipped(el, text); return; }

        const left = pausedUntil - Date.now();
        if (left > 0) { notePaused(left); return; }

        if (immediate || config.delay <= 0) translateEl(el);
        else hoverTimer = setTimeout(() => { if (currentEl === el) translateEl(el); }, config.delay);
    }

    function onMouseOver(e) {
        const target = e.target && e.target.closest ? e.target : null;
        if (!target) return;
        hoverBox = target.closest('.dt-box');
        let el = target.closest(MSG_CONTENT_SEL);
        if (!el) return;
        el = leaderOf(el);
        if (el === currentEl || el.closest(OWN_SEL)) return;
        currentEl = el;
        if (!modifierMatched(e) || !movedSinceScroll) return;
        armTranslation(el, config.triggerKey !== 'none');
    }

    function onMouseMove(e) {
        if (e.clientX === lastX && e.clientY === lastY) return;
        lastX = e.clientX;
        lastY = e.clientY;
        if (movedSinceScroll) return;
        movedSinceScroll = true;
        if (currentEl?.isConnected && modifierMatched(e)) armTranslation(currentEl, config.triggerKey !== 'none');
    }

    function onScroll() {
        movedSinceScroll = false;
        clearTimeout(hoverTimer);
        hoverTimer = null;
    }

    function onMouseOut(e) {
        const related = e.relatedTarget;
        if (hoverBox && (!related || !hoverBox.contains(related))) hoverBox = null;
        if (!currentEl) return;
        if (!related || !currentEl.contains(related)) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
            currentEl = null;
        }
    }

    function forceTranslateHovered() {
        let el = currentEl?.isConnected ? currentEl : null;
        if (!el && hoverBox?.isConnected) el = textElOfBox(hoverBox);
        if (!el || el.closest('.dt-overlay')) { showToast('请先把鼠标悬停在要翻译的消息上', 'off'); return; }
        if (el.dataset.dtStatus === 'translating') return;
        const hasResult = el.dataset.dtStatus === 'translated' && !!boxOf(el);
        translateEl(el, { force: !hasResult });
    }

    function onKeyDown(e) {
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
            const act = { KeyT: openSettings, KeyA: () => setAuto(!config.autoTranslate), KeyG: translateVisibleNow, KeyF: forceTranslateHovered, KeyR: clearAllTranslations }[e.code];
            if (act) { e.preventDefault(); act(); return; }
        }
        if (panel || isEditable(e.target)) return;
        if (currentEl && !e.repeat && config.triggerKey !== 'none' && MOD_KEYS[config.triggerKey]?.includes(e.key) && modifierMatched(e)) {
            armTranslation(currentEl, true);
        }
    }

    /* =====================================================================
     * 17. DOM 变更监听 (自动翻译登记 + 已翻译消息被编辑时刷新)
     * ===================================================================== */
    const pendingNodes = new Set();
    const dirtyContents = new Set();
    let flushTimer = 0;

    function onMutations(mutations) {
        let any = false;
        for (const m of mutations) {
            const tgt = m.target.nodeType === 1 ? m.target : m.target.parentElement;
            if (!tgt || tgt.closest(OWN_SEL)) continue;
            const host = tgt.closest(MSG_CONTENT_SEL);
            if (host) { dirtyContents.add(host); any = true; }
            if (!autoIO) continue;
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1 || n.closest(OWN_SEL)) continue;
                pendingNodes.add(n);
                any = true;
            }
        }
        if (any && !flushTimer) flushTimer = setTimeout(flushMutations, 90);
    }

    function flushMutations() {
        flushTimer = 0;
        const nodes = Array.from(pendingNodes);
        const dirty = Array.from(dirtyContents);
        pendingNodes.clear();
        dirtyContents.clear();

        // 已翻译 / 已跳过的消息被编辑：文本变了就清掉旧译文，自动翻译开启时重新入队
        for (const host of dirty) {
            if (!host.isConnected) continue;
            const lead = leaderOf(host);
            if (!lead.dataset.dtKey || lead.dataset.dtStatus === 'translating') continue;
            if (hashStr(extractText(lead)) === lead.dataset.dtKey) continue;
            resetEl(lead);
            if (config.autoTranslate && inViewport(lead)) enqueue(lead, true);
        }

        if (!autoIO) return;
        for (const n of nodes) {
            if (!n.isConnected) continue;
            const targets = n.matches(MSG_CONTENT_SEL) ? [n] : [];
            n.querySelectorAll(MSG_CONTENT_SEL).forEach((t) => targets.push(t));
            for (const t of targets) autoWatch(leaderOf(t));
        }
    }

    /* =====================================================================
     * 18. 初始化
     * ===================================================================== */
    function listenRemoteConfig() {
        if (typeof GM_addValueChangeListener !== 'function') return;
        try {
            GM_addValueChangeListener(CFG_KEY, (_name, _old, val, remote) => {
                if (!remote || !val || typeof val !== 'object') return;
                const prevLang = config.targetLang;
                Object.assign(config, sanitize(val));
                syncRootAttrs();
                if (config.autoTranslate) startAuto(); else stopAuto();
                updatePill();
                syncActiveBoxesMode();
                if (panel) closeSettings();
                if (config.targetLang !== prevLang) retranslateAll();
            });
        } catch (_) { /* ignore */ }
    }

    let initialized = false;
    function init() {
        if (initialized || !document.body) return;
        initialized = true;
        injectStyles();
        refreshTheme();
        observeTheme();
        loadPersistedCache();

        document.addEventListener('mouseover', onMouseOver, { capture: true, passive: true });
        document.addEventListener('mouseout', onMouseOut, { capture: true, passive: true });
        document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('visibilitychange', () => { if (document.hidden) flushCache(); else pump(); });
        window.addEventListener('pagehide', flushCache);

        new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true, characterData: true });
        listenRemoteConfig();

        if (config.autoTranslate) startAuto();
        createFloatPill();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
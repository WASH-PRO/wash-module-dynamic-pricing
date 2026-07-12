/**
 * WASH Module UI SDK — settings pages, status, PyOrchestrator logs.
 */
(function (global) {
  const API_PREFIX = '/api/crm/modules';

  function getToken() {
    return localStorage.getItem('wash_crm_token') || '';
  }

  function getLocale() {
    return localStorage.getItem('wash_crm_locale') || 'ru';
  }

  function t(map) {
    const locale = getLocale();
    return (map && (map[locale] || map.ru || map.en)) || '';
  }

  async function api(path, options) {
    const token = getToken();
    const res = await fetch(`${API_PREFIX}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options && options.headers ? options.headers : {}),
      },
    });
    const json = await res.json();
    if (!res.ok || json.success !== true) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.data;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDateTime(value) {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString(getLocale() === 'en' ? 'en-GB' : 'ru-RU');
    } catch {
      return String(value);
    }
  }

  function resolveStatus(statusPayload) {
    const state = statusPayload && statusPayload.state;
    const run = (statusPayload && statusPayload.activeRunStatus) || '';
    if (run === 'running') {
      return { className: 'wm-status--running', label: t({ ru: 'Запущен', en: 'Running' }) };
    }
    if (run === 'queued') {
      return { className: 'wm-status--queued', label: t({ ru: 'В очереди', en: 'Queued' }) };
    }
    if (state && state.status === 'error') {
      return { className: 'wm-status--error', label: t({ ru: 'Ошибка', en: 'Error' }) };
    }
    if (state && state.status === 'updating') {
      return { className: 'wm-status--queued', label: t({ ru: 'Обновление', en: 'Updating' }) };
    }
    if (state && state.status === 'running') {
      return { className: 'wm-status--running', label: t({ ru: 'Запущен', en: 'Running' }) };
    }
    return { className: 'wm-status--stopped', label: t({ ru: 'Остановлен', en: 'Stopped' }) };
  }

  function isModuleRunning(statusPayload) {
    if (!statusPayload || !statusPayload.state) return false;
    if (statusPayload.activeRunStatus === 'running') return true;
    return statusPayload.state.status === 'running';
  }

  function renderMetrics(container, metrics, snap, status) {
    if (!container) return;
    if (!isModuleRunning(status) && (!snap || !snap.recordedAt)) {
      container.innerHTML = `<div class="wm-empty">${escapeHtml(t({ ru: 'Нет метрик — запустите модуль', en: 'No metrics — start the module' }))}</div>`;
      return;
    }
    if (!metrics || !metrics.length) {
      const msg = isModuleRunning(status)
        ? t({ ru: 'Ожидание первого цикла…', en: 'Waiting for first poll…' })
        : t({ ru: 'Нет метрик — запустите модуль', en: 'No metrics — start the module' });
      container.innerHTML = `<div class="wm-empty">${escapeHtml(msg)}</div>`;
      return;
    }
    container.innerHTML = metrics
      .map(function (m) {
        const tone = m.tone ? ` wm-metric-value--${m.tone}` : m.accent ? ' wm-metric-value--accent' : '';
        const hint = m.hint ? `<span class="wm-metric-hint">${escapeHtml(m.hint)}</span>` : '';
        return (
          '<article class="wm-metric">' +
          `<span class="wm-metric-label">${escapeHtml(m.label)}</span>` +
          `<strong class="wm-metric-value${tone}">${escapeHtml(m.value)}</strong>` +
          hint +
          '</article>'
        );
      })
      .join('');
  }

  function renderLogs(container, payload, metaEl) {
    if (!container) return;
    const logs = (payload && payload.logs) || [];
    const runId = payload && payload.runId;
    const runStatus = payload && payload.runStatus;
    if (metaEl) {
      if (payload && payload.unavailable) {
        metaEl.textContent = payload.unavailable;
      } else if (runId) {
        metaEl.textContent = `${t({ ru: 'Запуск', en: 'Run' })} ${runId.slice(0, 8)}… · ${runStatus || '—'} · ${logs.length} ${t({ ru: 'строк', en: 'lines' })}`;
      } else {
        metaEl.textContent = t({ ru: 'Нет активного запуска', en: 'No active run' });
      }
    }
    if (!logs.length) {
      container.innerHTML = `<div class="wm-empty">${escapeHtml(t({ ru: 'Логи появятся после запуска модуля', en: 'Logs appear after the module starts' }))}</div>`;
      return;
    }
    container.innerHTML = logs
      .map(function (line) {
        const level = String(line.level || 'info').toLowerCase();
        return (
          `<div class="wm-log-line wm-log-${escapeHtml(level)}">` +
          `<time>${escapeHtml(formatDateTime(line.ts))}</time>` +
          `<span class="wm-log-level">${escapeHtml(line.level || 'info')}</span>` +
          `<span class="wm-log-msg">${escapeHtml(line.message)}</span>` +
          '</div>'
        );
      })
      .join('');
    container.scrollTop = container.scrollHeight;
  }

  function bindTabs(root, onChange) {
    const tabs = root.querySelectorAll('.wm-tab');
    const panels = root.querySelectorAll('.wm-tab-panel');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        const name = tab.getAttribute('data-tab');
        tabs.forEach(function (el) {
          el.classList.toggle('is-active', el === tab);
        });
        panels.forEach(function (panel) {
          panel.classList.toggle('is-active', panel.getAttribute('data-panel') === name);
        });
        if (onChange) onChange();
      });
    });
  }

  function resolveThemeFromStorage() {
    const stored = localStorage.getItem('wash_theme');
    if (stored === 'dark') return 'dark';
    if (stored === 'light') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.classList.toggle('wm-dark', theme === 'dark');
  }

  function isEmbedMode() {
    return new URLSearchParams(window.location.search).get('embed') === '1';
  }

  function notifyResize() {
    if (!isEmbedMode()) return;
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.offsetHeight
    );
    window.parent.postMessage({ type: 'wash-module-resize', height: height }, '*');
  }

  function initEmbed() {
    if (!isEmbedMode()) return;
    document.documentElement.classList.add('wm-embed');
    applyTheme(resolveThemeFromStorage());

    window.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'wash-module-theme') {
        applyTheme(event.data.theme === 'dark' ? 'dark' : 'light');
        notifyResize();
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(function () {
        notifyResize();
      });
      observer.observe(document.body);
    }

    window.addEventListener('load', notifyResize);
    setTimeout(notifyResize, 50);
    setTimeout(notifyResize, 300);
  }

  initEmbed();

  /**
   * @param {object} cfg
   * @param {string} cfg.moduleId
   * @param {Record<string,string>} cfg.title
   * @param {Record<string,string>=} cfg.subtitle
   * @param {string=} cfg.accent
   * @param {number=} cfg.refreshInterval
   * @param {string} cfg.settingsHtml
   * @param {(settings: object, form: HTMLFormElement) => void=} cfg.applySettings
   * @param {(form: HTMLFormElement) => object} cfg.collectSettings
   * @param {(snap: object|null, status: object) => Array<{label:string,value:string,hint?:string,accent?:boolean,tone?:string}>} cfg.metrics
   * @param {(snap: object|null, status: object) => string} cfg.renderOverview
   */
  function createPage(cfg) {
    const app = document.getElementById('wm-app');
    if (!app) throw new Error('#wm-app not found');

    if (cfg.accent) {
      document.documentElement.style.setProperty('--wm-accent', cfg.accent);
    }

    app.className = 'wm-app';
    app.innerHTML =
      '<header class="wm-header">' +
      '<div><h1 class="wm-title"></h1><p class="wm-subtitle"></p></div>' +
      '<div class="wm-header-meta"><span id="wm-status-badge" class="wm-status wm-status--stopped">—</span>' +
      '<div id="wm-meta-line" class="wm-meta-line">—</div></div></header>' +
      '<div id="wm-alert" class="wm-alert" hidden></div>' +
      '<section id="wm-metrics" class="wm-metrics"></section>' +
      '<nav class="wm-tab-bar">' +
      `<button type="button" class="wm-tab is-active" data-tab="overview">${escapeHtml(t({ ru: 'Обзор', en: 'Overview' }))}</button>` +
      `<button type="button" class="wm-tab" data-tab="settings">${escapeHtml(t({ ru: 'Настройки', en: 'Settings' }))}</button>` +
      `<button type="button" class="wm-tab" data-tab="logs">${escapeHtml(t({ ru: 'Логи', en: 'Logs' }))}</button>` +
      '</nav>' +
      '<div class="wm-panels">' +
      '<div class="wm-tab-panel is-active" data-panel="overview"><div id="wm-overview"></div></div>' +
      '<div class="wm-tab-panel" data-panel="settings">' +
      '<div class="wm-settings-panel">' +
      '<div class="wm-settings-head">' +
      `<h2 class="wm-settings-title">${escapeHtml(t({ ru: 'Параметры', en: 'Parameters' }))}</h2>` +
      `<p class="wm-settings-desc">${escapeHtml(t({ ru: 'Сохраните изменения — они применятся в PyOrchestrator. Секретные поля можно оставить пустыми.', en: 'Save to apply in PyOrchestrator. Leave secret fields empty to keep current values.' }))}</p>` +
      '</div>' +
      `<form id="wm-settings-form" class="wm-form-grid">${cfg.settingsHtml || ''}` +
      '<div class="wm-form-actions">' +
      `<button type="submit" class="wm-btn wm-btn-primary" id="wm-save-btn">${escapeHtml(t({ ru: 'Сохранить', en: 'Save' }))}</button>` +
      `<span class="wm-field-hint" style="margin:0">${escapeHtml(t({ ru: 'После сохранения перезапустите модуль, если он уже запущен.', en: 'Restart the module after saving if it is already running.' }))}</span>` +
      '</div></form></div></div>' +
      '<div class="wm-tab-panel" data-panel="logs">' +
      '<div class="wm-logs-toolbar"><span id="wm-logs-meta">—</span>' +
      `<button type="button" class="wm-btn wm-btn-ghost" id="wm-logs-refresh">${escapeHtml(t({ ru: 'Обновить', en: 'Refresh' }))}</button></div>` +
      '<div id="wm-logs" class="wm-logs"></div></div></div>';

    app.querySelector('.wm-title').textContent = t(cfg.title);
    app.querySelector('.wm-subtitle').textContent = cfg.subtitle ? t(cfg.subtitle) : '';

    bindTabs(app, function () {
      const activeTab = app.querySelector('.wm-tab.is-active');
      if (activeTab && activeTab.getAttribute('data-tab') === 'logs') {
        void loadLogs();
      }
      notifyResize();
    });

    const els = {
      statusBadge: app.querySelector('#wm-status-badge'),
      metaLine: app.querySelector('#wm-meta-line'),
      alert: app.querySelector('#wm-alert'),
      metrics: app.querySelector('#wm-metrics'),
      overview: app.querySelector('#wm-overview'),
      logs: app.querySelector('#wm-logs'),
      logsMeta: app.querySelector('#wm-logs-meta'),
      form: app.querySelector('#wm-settings-form'),
      saveBtn: app.querySelector('#wm-save-btn'),
    };

    let lastStatus = null;
    let lastLogs = null;
    let settingsDirty = false;

    async function loadLogs() {
      try {
        lastLogs = await api(`/installed/${cfg.moduleId}/logs?limit=400`);
        renderLogs(els.logs, lastLogs, els.logsMeta);
      } catch (err) {
        renderLogs(
          els.logs,
          { logs: [], unavailable: err instanceof Error ? err.message : String(err) },
          els.logsMeta
        );
      }
    }

    async function refresh() {
      try {
        lastStatus = await api(`/installed/${cfg.moduleId}/status`);
        const st = resolveStatus(lastStatus);
        els.statusBadge.className = `wm-status ${st.className}`;
        els.statusBadge.textContent = st.label;

        const snap = lastStatus.snapshot;
        const version = (lastStatus.manifest && lastStatus.manifest.version) || (lastStatus.state && lastStatus.state.version) || '—';
        const updated = snap && snap.recordedAt ? formatDateTime(snap.recordedAt) : '—';
        els.metaLine.textContent = `v${version} · ${t({ ru: 'Обновлено', en: 'Updated' })} ${updated}`;

        if (lastStatus.state && lastStatus.state.lastError) {
          els.alert.hidden = false;
          els.alert.className = 'wm-alert wm-alert--error';
          els.alert.textContent = lastStatus.state.lastError;
        } else if (!lastStatus.state || lastStatus.state.status === 'installed') {
          els.alert.hidden = false;
          els.alert.className = 'wm-alert';
          els.alert.textContent = t({
            ru: 'Модуль установлен, но не запущен. Запустите его на странице «Модули».',
            en: 'Module is installed but not running. Start it from the Modules page.',
          });
        } else {
          els.alert.hidden = true;
        }

        renderMetrics(
          els.metrics,
          cfg.metrics ? cfg.metrics(snap, lastStatus) : [],
          snap,
          lastStatus
        );
        els.overview.innerHTML = cfg.renderOverview ? cfg.renderOverview(snap, lastStatus) : '';

        if (cfg.applySettings && lastStatus.settings && els.form && !settingsDirty) {
          cfg.applySettings(lastStatus.settings, els.form);
        }
      } catch (err) {
        els.alert.hidden = false;
        els.alert.className = 'wm-alert wm-alert--error';
        els.alert.textContent = err instanceof Error ? err.message : String(err);
        if (cfg.metrics && els.metrics) {
          const snap = lastStatus && lastStatus.snapshot;
          renderMetrics(
            els.metrics,
            cfg.metrics(snap, lastStatus),
            snap,
            lastStatus
          );
        }
      }

      await loadLogs();
      notifyResize();
    }

    if (els.form && cfg.collectSettings) {
      els.form.addEventListener('input', function () {
        settingsDirty = true;
      });
      els.form.addEventListener('change', function () {
        settingsDirty = true;
      });
      els.form.addEventListener('submit', async function (e) {
        e.preventDefault();
        els.saveBtn.disabled = true;
        try {
          const settings = cfg.collectSettings(els.form);
          await api(`/installed/${cfg.moduleId}/settings`, {
            method: 'PUT',
            body: JSON.stringify({ settings }),
          });
          els.saveBtn.textContent = t({ ru: 'Сохранено', en: 'Saved' });
          settingsDirty = false;
          setTimeout(function () {
            els.saveBtn.textContent = t({ ru: 'Сохранить', en: 'Save' });
          }, 1600);
          await refresh();
        } catch (err) {
          els.alert.hidden = false;
          els.alert.className = 'wm-alert wm-alert--error';
          els.alert.textContent = err instanceof Error ? err.message : String(err);
        } finally {
          els.saveBtn.disabled = false;
        }
      });
    }

    app.querySelector('#wm-logs-refresh').addEventListener('click', function () {
      void loadLogs();
    });

    refresh().then(notifyResize);
    setInterval(refresh, cfg.refreshInterval || 12000);
  }

  global.WashModule = {
    api,
    t,
    getLocale,
    formatDateTime,
    escapeHtml,
    createPage,
    renderMetrics,
    renderLogs,
    notifyResize,
    applyTheme,
  };
})(window);

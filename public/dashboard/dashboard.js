const state = {
  dashboard: null,
  history: [],
  marketQuery: '',
  ecoMode: localStorage.getItem('bstock-dashboard-eco') === 'true',
  dashboardTimer: null,
  historyTimer: null,
  logTimer: null,
  logCursor: null,
  logPaused: false,
  logLevel: 'all',
  receivedBytes: 0,
  toastTimer: null,
};

const elements = Object.fromEntries(
  [
    'connection-pill', 'connection-label', 'data-mode', 'data-mode-label', 'system-card', 'system-title',
    'system-summary', 'health-score', 'last-sync', 'metric-markets', 'metric-markets-note', 'metric-pools',
    'metric-block', 'metric-dex-age', 'metric-spread', 'metric-spread-asset', 'market-search', 'market-count',
    'market-rows', 'market-cards', 'opportunity-count', 'opportunity-list', 'infra-cex', 'infra-dex',
    'infra-quotes', 'infra-snapshots', 'infra-db-size', 'infra-uptime', 'session-transfer', 'footer-config',
    'log-panel', 'log-state', 'log-pause', 'log-clear', 'log-output', 'toast',
  ].map((id) => [id, document.getElementById(id)]),
);

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

init();

function init() {
  elements['market-search'].addEventListener('input', (event) => {
    state.marketQuery = event.target.value.trim().toUpperCase();
    renderMarkets();
  });
  elements['data-mode'].addEventListener('click', toggleEcoMode);
  elements['log-panel'].addEventListener('toggle', handleLogPanelToggle);
  elements['log-pause'].addEventListener('click', toggleLogPause);
  elements['log-clear'].addEventListener('click', clearLogOutput);
  document.querySelectorAll('.log-filter').forEach((button) => {
    button.addEventListener('click', () => setLogLevel(button.dataset.level || 'all'));
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', () => void refreshDashboard());
  window.addEventListener('offline', () => renderConnection('offline', '浏览器已离线'));

  renderDataMode();
  void dashboardLoop();
  void historyLoop();
}

async function dashboardLoop() {
  clearTimeout(state.dashboardTimer);
  await refreshDashboard();
  const interval = document.hidden ? 30_000 : state.ecoMode ? 5_000 : 2_000;
  state.dashboardTimer = setTimeout(() => void dashboardLoop(), interval);
}

async function historyLoop() {
  clearTimeout(state.historyTimer);
  if (!document.hidden) await refreshHistory();
  state.historyTimer = setTimeout(() => void historyLoop(), state.ecoMode ? 90_000 : 30_000);
}

async function refreshDashboard() {
  try {
    const data = await fetchJson('/v1/dashboard');
    state.dashboard = data;
    renderDashboard();
  } catch (error) {
    renderConnection('offline', '连接中断');
    elements['system-card'].className = 'system-card reveal reveal-2 is-offline';
    elements['system-title'].textContent = '状态连接已中断';
    elements['system-summary'].textContent = error instanceof Error ? error.message : '无法连接监控服务。';
  }
}

async function refreshHistory() {
  try {
    const history = await fetchJson('/v1/opportunities?source=history&limit=24');
    state.history = Array.isArray(history) ? history : [];
    renderOpportunities();
  } catch {
    if (state.dashboard) renderOpportunities();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
  const textBody = await response.text();
  const encodedLength = Number(response.headers.get('content-length'));
  state.receivedBytes += Number.isFinite(encodedLength) && encodedLength > 0
    ? encodedLength
    : new TextEncoder().encode(textBody).byteLength;
  renderSessionTransfer();
  let payload;
  try {
    payload = textBody ? JSON.parse(textBody) : null;
  } catch {
    throw new Error(`服务返回了无法解析的数据（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  return payload;
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  const health = data;
  const markets = Array.isArray(data.markets) ? data.markets : [];
  const dexAge = health.dexLastPollAt === null ? Infinity : Math.max(0, data.serverTime - health.dexLastPollAt);
  const freshDex = dexAge <= data.monitor.maxPriceAgeMs * 2;
  const score = Math.round(
    (health.cexConnected ? 35 : 0) +
    (freshDex ? 30 : 0) +
    (health.activeMarkets > 0 ? 20 : 0) +
    (health.pools > 0 ? 15 : 0),
  );
  const mode = data.status === 'ok' ? 'online' : 'degraded';

  renderConnection(mode, data.status === 'ok' ? '全通道在线' : '服务降级');
  elements['system-card'].className = `system-card reveal reveal-2 is-${mode}`;
  elements['system-title'].textContent = data.status === 'ok' ? '所有通道运行正常' : '部分信号需要注意';
  elements['system-summary'].textContent = data.status === 'ok'
    ? `Binance 深度与链上价格均保持新鲜，当前覆盖 ${health.activeMarkets} 个可比较市场。`
    : buildDegradedSummary(data, freshDex);
  elements['health-score'].textContent = `${score}`;
  elements['last-sync'].textContent = time.format(data.serverTime);

  elements['metric-markets'].textContent = integer.format(health.activeMarkets);
  elements['metric-markets-note'].textContent = `${health.assets} 个资产目录 / ${markets.length} 个有价市场`;
  elements['metric-pools'].textContent = integer.format(health.pools);
  elements['metric-block'].textContent = health.dexLastBlock ? `#${integer.format(health.dexLastBlock)}` : '—';
  elements['metric-dex-age'].textContent = Number.isFinite(dexAge) ? `${formatDuration(dexAge)} 前更新` : '等待首次轮询';

  const strongest = strongestSpread(markets);
  elements['metric-spread'].textContent = strongest ? formatBps(strongest.bps) : '—';
  elements['metric-spread-asset'].textContent = strongest
    ? `${strongest.assetCode} · ${shortDirection(strongest.direction)}`
    : '暂无有效市场';

  renderMarkets();
  renderOpportunities();
  renderInfrastructure(data, dexAge);
  elements['footer-config'].textContent = `${number.format(data.monitor.notionalUsd)} USDT notional · ${integer.format(data.monitor.alertThresholdBps)} bps alert · ${settlementName(data.monitor.settlementMode)}`;

  if (!data.monitor.logsEnabled) {
    elements['log-state'].textContent = '已由配置关闭';
    elements['log-panel'].classList.add('is-disabled');
  }
}

function buildDegradedSummary(data, freshDex) {
  const issues = [];
  if (!data.cexConnected) issues.push('Binance WebSocket 未连接');
  if (!freshDex) issues.push('链上价格已过期');
  if (data.pools === 0) issues.push('尚未发现有效池');
  if (data.activeMarkets === 0) issues.push('暂无新鲜的双边市场');
  return issues.length ? `${issues.join('；')}。监控仍在自动恢复。` : '监控服务处于降级状态，正在自动恢复。';
}

function renderConnection(mode, label) {
  elements['connection-pill'].className = `connection-pill is-${mode}`;
  elements['connection-label'].textContent = label;
}

function renderMarkets() {
  const markets = Array.isArray(state.dashboard?.markets) ? [...state.dashboard.markets] : [];
  const threshold = state.dashboard?.monitor?.alertThresholdBps ?? 30;
  const filtered = markets
    .filter((market) => !state.marketQuery || market.assetCode.toUpperCase().includes(state.marketQuery) || market.cexSymbol.toUpperCase().includes(state.marketQuery))
    .map((market) => ({ ...market, ...marketSpreads(market) }))
    .sort((left, right) => Math.max(right.cexToDex, right.dexToCex) - Math.max(left.cexToDex, left.dexToCex));

  elements['market-count'].textContent = `${filtered.length} markets`;
  if (filtered.length === 0) {
    const message = markets.length === 0 ? '暂无可比较的市场快照' : '没有符合筛选条件的资产';
    elements['market-rows'].innerHTML = `<tr class="empty-row"><td colspan="6">${message}</td></tr>`;
    elements['market-cards'].innerHTML = `<div class="quiet-state"><p>${message}</p></div>`;
    return;
  }

  elements['market-rows'].innerHTML = filtered.map((market) => {
    const age = Math.max(market.cexAgeMs, market.dexAgeMs);
    const stale = age > (state.dashboard?.monitor?.maxPriceAgeMs ?? 5_000);
    return `<tr>
      <td><div class="asset-cell"><span class="asset-glyph">${escapeHtml(glyph(market.assetCode))}</span><span class="asset-meta"><strong>${escapeHtml(market.assetCode)}</strong><small>${escapeHtml(market.cexSymbol)}</small></span></div></td>
      <td><span class="price-stack"><span><span class="bid">${formatPrice(market.cexBid)}</span> / <span class="ask">${formatPrice(market.cexAsk)}</span></span><small>bid / ask</small></span></td>
      <td><a class="pool-link" href="https://dexscreener.com/bsc/${encodeURIComponent(market.poolAddress)}" target="_blank" rel="noopener noreferrer">${formatPrice(market.dexMid)}</a></td>
      <td><span class="spread ${spreadClass(market.cexToDex, threshold)}">${formatBps(market.cexToDex)}</span></td>
      <td><span class="spread ${spreadClass(market.dexToCex, threshold)}">${formatBps(market.dexToCex)}</span></td>
      <td><span class="age ${stale ? 'is-stale' : ''}">${formatDuration(age)}</span></td>
    </tr>`;
  }).join('');

  elements['market-cards'].innerHTML = filtered.map((market) => {
    const age = Math.max(market.cexAgeMs, market.dexAgeMs);
    return `<article class="market-card">
      <div class="market-card-top"><strong>${escapeHtml(market.assetCode)}</strong><small>${formatDuration(age)} old</small></div>
      <div class="market-card-prices"><span>Binance<b>${formatPrice(market.cexBid)} / ${formatPrice(market.cexAsk)}</b></span><span>Pancake mid<b>${formatPrice(market.dexMid)}</b></span></div>
      <div class="market-card-spreads"><span><small>CEX 买 → DEX 卖</small><span class="spread ${spreadClass(market.cexToDex, threshold)}">${formatBps(market.cexToDex)}</span></span><span><small>DEX 买 → CEX 卖</small><span class="spread ${spreadClass(market.dexToCex, threshold)}">${formatBps(market.dexToCex)}</span></span></div>
    </article>`;
  }).join('');
}

function renderOpportunities() {
  const latest = Array.isArray(state.dashboard?.latestOpportunities) ? state.dashboard.latestOpportunities : [];
  const opportunities = (state.history.length ? state.history : latest)
    .slice()
    .sort((left, right) => right.detectedAt - left.detectedAt)
    .slice(0, 10);
  elements['opportunity-count'].textContent = `${opportunities.length} signals`;
  if (opportunities.length === 0) {
    elements['opportunity-list'].innerHTML = '<div class="quiet-state"><span class="quiet-pulse" aria-hidden="true"></span><p>监听中，暂无达到最低利润的精确报价。</p></div>';
    return;
  }
  elements['opportunity-list'].innerHTML = opportunities.map((item) => `<article class="opportunity-item">
    <div class="opportunity-asset"><strong>${escapeHtml(item.assetCode)}</strong><small>${time.format(item.detectedAt)} · ${item.actionable ? 'ACTIONABLE' : 'INDICATIVE'}</small></div>
    <div class="opportunity-route"><strong>${escapeHtml(directionName(item.direction))}</strong><small>${formatPrice(item.cexEffectivePrice)} ↔ ${formatPrice(item.dexEffectivePrice)} · ${integer.format(item.quoteLatencyMs)} ms</small></div>
    <div class="opportunity-stat profit ${item.netProfitUsd < 0 ? 'is-loss' : ''}"><strong>${formatUsd(item.netProfitUsd)}</strong><small>净收益</small></div>
    <div class="opportunity-stat"><strong>${formatBps(item.netBps)}</strong><small>净收益率</small></div>
  </article>`).join('');
}

function renderInfrastructure(data, dexAge) {
  setInfraValue('infra-cex', data.cexConnected ? 'CONNECTED' : 'DISCONNECTED', data.cexConnected);
  elements['infra-dex'].textContent = Number.isFinite(dexAge) ? formatDuration(dexAge) : 'NO DATA';
  elements['infra-quotes'].textContent = `${integer.format(data.exactQuotesInFlight)} IN FLIGHT`;
  elements['infra-snapshots'].textContent = integer.format(data.database.snapshots);
  elements['infra-db-size'].textContent = formatBytes(data.database.databaseBytes);
  elements['infra-uptime'].textContent = formatLongDuration(Math.max(0, data.serverTime - data.startedAt));
}

function setInfraValue(id, text, good) {
  elements[id].textContent = text;
  elements[id].className = good ? 'is-good' : 'is-bad';
}

function strongestSpread(markets) {
  let strongest = null;
  for (const market of markets) {
    const spreads = marketSpreads(market);
    const candidate = spreads.cexToDex >= spreads.dexToCex
      ? { assetCode: market.assetCode, direction: 'CEX_BUY_DEX_SELL', bps: spreads.cexToDex }
      : { assetCode: market.assetCode, direction: 'DEX_BUY_CEX_SELL', bps: spreads.dexToCex };
    if (!strongest || candidate.bps > strongest.bps) strongest = candidate;
  }
  return strongest;
}

function marketSpreads(market) {
  return {
    cexToDex: market.cexAsk > 0 ? (market.dexSellMarginal / market.cexAsk - 1) * 10_000 : 0,
    dexToCex: market.dexBuyMarginal > 0 ? (market.cexBid / market.dexBuyMarginal - 1) * 10_000 : 0,
  };
}

function spreadClass(value, threshold) {
  if (value >= threshold) return 'is-strong';
  if (value > 0) return 'is-positive';
  return '';
}

function toggleEcoMode() {
  state.ecoMode = !state.ecoMode;
  localStorage.setItem('bstock-dashboard-eco', String(state.ecoMode));
  renderDataMode();
  clearTimeout(state.dashboardTimer);
  clearTimeout(state.historyTimer);
  void dashboardLoop();
  void historyLoop();
  if (elements['log-panel'].open && !state.logPaused) scheduleLogPoll(0);
  showToast(state.ecoMode ? '已启用节流模式：状态每 5 秒更新。' : '已启用智能模式：前台每 2 秒更新。');
}

function renderDataMode() {
  elements['data-mode'].setAttribute('aria-pressed', String(state.ecoMode));
  elements['data-mode-label'].textContent = state.ecoMode ? '节流模式' : '智能流量';
}

function handleVisibilityChange() {
  clearTimeout(state.dashboardTimer);
  clearTimeout(state.historyTimer);
  clearTimeout(state.logTimer);
  void dashboardLoop();
  void historyLoop();
  if (!document.hidden && elements['log-panel'].open && !state.logPaused) scheduleLogPoll(0);
}

function handleLogPanelToggle() {
  if (!elements['log-panel'].open) {
    clearTimeout(state.logTimer);
    elements['log-state'].textContent = '已停止传输';
    return;
  }
  if (state.dashboard && !state.dashboard.monitor.logsEnabled) {
    elements['log-state'].textContent = '日志接口已关闭';
    return;
  }
  elements['log-state'].textContent = state.logPaused ? '已暂停' : '正在连接';
  if (!state.logPaused) scheduleLogPoll(0);
}

function scheduleLogPoll(delay) {
  clearTimeout(state.logTimer);
  if (!elements['log-panel'].open || state.logPaused || document.hidden) return;
  state.logTimer = setTimeout(() => void loadLogs(), delay);
}

async function loadLogs() {
  try {
    const params = new URLSearchParams({ limit: state.logCursor ? '240' : '120' });
    if (state.logCursor) {
      params.set('stdout', String(state.logCursor.stdout));
      params.set('stderr', String(state.logCursor.stderr));
    }
    const batch = await fetchJson(`/v1/logs?${params}`);
    state.logCursor = batch.cursor;
    appendLogEntries(Array.isArray(batch.entries) ? batch.entries : []);
    elements['log-state'].textContent = state.logPaused ? '已暂停' : '增量跟随中';
    if (batch.truncated) showToast('日志增长较快，已自动跳到最近内容。');
  } catch (error) {
    elements['log-state'].textContent = '日志不可用';
    if (!document.querySelector('.log-line')) {
      elements['log-output'].innerHTML = `<div class="log-empty">${escapeHtml(error instanceof Error ? error.message : '无法读取日志')}</div>`;
    }
  } finally {
    scheduleLogPoll(state.ecoMode ? 8_000 : 3_000);
  }
}

function appendLogEntries(entries) {
  const output = elements['log-output'];
  const placeholder = output.querySelector('.log-empty');
  if (placeholder && entries.length) placeholder.remove();
  if (entries.length === 0 && !output.querySelector('.log-line')) {
    output.innerHTML = '<div class="log-empty">当前日志为空，或 PM2 日志文件尚未创建。</div>';
    return;
  }
  const shouldStick = output.scrollHeight - output.scrollTop - output.clientHeight < 70;
  for (const entry of entries) output.appendChild(createLogLine(entry));
  while (output.querySelectorAll('.log-line').length > 400) output.querySelector('.log-line')?.remove();
  applyLogFilter();
  if (shouldStick) output.scrollTop = output.scrollHeight;
}

function createLogLine(entry) {
  const parsed = parseLogText(entry);
  const line = document.createElement('div');
  line.className = 'log-line';
  line.dataset.level = parsed.level;

  const timestamp = document.createElement('time');
  timestamp.textContent = parsed.timestamp ? time.format(parsed.timestamp) : '--:--:--';
  const level = document.createElement('span');
  level.className = 'log-level';
  level.textContent = parsed.level;
  const content = document.createElement('code');
  content.textContent = parsed.message;
  line.append(timestamp, level, content);
  return line;
}

function parseLogText(entry) {
  try {
    const value = JSON.parse(entry.text);
    const ignored = new Set(['level', 'time', 'pid', 'hostname', 'service', 'msg']);
    const context = Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
    const detail = Object.keys(context).length ? ` ${JSON.stringify(context)}` : '';
    return {
      level: String(entry.level || pinoLevel(value.level) || entry.stream || 'info').toLowerCase(),
      timestamp: entry.timestamp || value.time || null,
      message: `${value.msg || 'structured log'}${detail}`,
    };
  } catch {
    return {
      level: String(entry.level || (entry.stream === 'stderr' ? 'error' : 'info')).toLowerCase(),
      timestamp: entry.timestamp || null,
      message: entry.text,
    };
  }
}

function pinoLevel(value) {
  if (typeof value !== 'number') return null;
  if (value >= 60) return 'fatal';
  if (value >= 50) return 'error';
  if (value >= 40) return 'warn';
  if (value >= 30) return 'info';
  if (value >= 20) return 'debug';
  return 'trace';
}

function toggleLogPause() {
  state.logPaused = !state.logPaused;
  elements['log-pause'].textContent = state.logPaused ? '继续' : '暂停';
  elements['log-state'].textContent = state.logPaused ? '已暂停' : '增量跟随中';
  if (state.logPaused) clearTimeout(state.logTimer);
  else scheduleLogPoll(0);
}

function clearLogOutput() {
  elements['log-output'].innerHTML = '<div class="log-empty">屏幕已清空；游标保留，只显示后续新增日志。</div>';
}

function setLogLevel(level) {
  state.logLevel = level;
  document.querySelectorAll('.log-filter').forEach((button) => button.classList.toggle('is-active', button.dataset.level === level));
  applyLogFilter();
}

function applyLogFilter() {
  document.querySelectorAll('.log-line').forEach((line) => {
    const level = line.dataset.level || 'info';
    const visible = state.logLevel === 'all' || level === state.logLevel || (state.logLevel === 'error' && level === 'fatal');
    line.classList.toggle('is-filtered', !visible);
  });
}

function renderSessionTransfer() {
  elements['session-transfer'].textContent = `本次会话 ≈ ${formatBytes(state.receivedBytes)}`;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 3_000);
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 100 ? 2 : Math.abs(value) >= 1 ? 4 : 6;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(value);
}

function formatBps(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${number.format(value)} bps`;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '-'}$${number.format(Math.abs(value))}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${number.format(milliseconds / 1_000)} s`;
  return `${number.format(milliseconds / 60_000)} min`;
}

function formatLongDuration(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}D ${hours}H`;
  if (hours > 0) return `${hours}H ${minutes}M`;
  return `${minutes}M`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${number.format(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${number.format(bytes / 1024 / 1024)} MB`;
  return `${number.format(bytes / 1024 / 1024 / 1024)} GB`;
}

function directionName(direction) {
  return direction === 'CEX_BUY_DEX_SELL' ? 'Binance 买入 → Pancake 卖出' : 'Pancake 买入 → Binance 卖出';
}

function shortDirection(direction) {
  return direction === 'CEX_BUY_DEX_SELL' ? 'CEX → DEX' : 'DEX → CEX';
}

function settlementName(mode) {
  return mode === 'prepositioned' ? '预置库存' : '转账结算';
}

function glyph(assetCode) {
  return assetCode.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase() || 'BS';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

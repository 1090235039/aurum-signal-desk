const STORAGE_KEY = "gold-trend-desk-v3";
const LEGACY_STORAGE_KEY = "gold-trend-desk-v2";
const DISCLAIMER_VERSION = "2026-06-16";

const DEFAULT_UP_COLOR = "#45d49c";
const DEFAULT_DOWN_COLOR = "#ff6f7d";

const HORIZONS = [
  { key: "d1", label: "1天", days: 1, macroWeight: 0.18, techWeight: 1.18, professionalWeight: 0.55, newsWeight: 0.9, meanReversionWeight: 1.15 },
  { key: "w1", label: "1周", days: 5, macroWeight: 0.34, techWeight: 1.05, professionalWeight: 0.75, newsWeight: 0.72, meanReversionWeight: 0.95 },
  { key: "m1", label: "1月", days: 21, macroWeight: 0.68, techWeight: 0.92, professionalWeight: 0.82, newsWeight: 0.48, meanReversionWeight: 0.62 },
  { key: "m3", label: "3个月", days: 63, macroWeight: 0.92, techWeight: 0.78, professionalWeight: 0.7, newsWeight: 0.28, meanReversionWeight: 0.34 },
  { key: "m6", label: "半年", days: 126, macroWeight: 1.08, techWeight: 0.62, professionalWeight: 0.55, newsWeight: 0.18, meanReversionWeight: 0.2 },
  { key: "y1", label: "1年", days: 252, macroWeight: 1.2, techWeight: 0.48, professionalWeight: 0.42, newsWeight: 0.12, meanReversionWeight: 0.12 },
];

const REVIEW_HORIZONS = [
  { key: "d1", label: "1天", dueDays: 1 },
  { key: "w1", label: "1周", dueDays: 7 },
];

const DEFAULT_STATE = {
  settings: {
    goldCnyPerGram: 735,
    goldUsdPerOz: 3385,
    usdCny: 6.75,
    changePct: null,
    source: "示例数据",
    updatedAt: null,
  },
  preferences: {
    theme: "simple",
    upColor: DEFAULT_UP_COLOR,
    downColor: DEFAULT_DOWN_COLOR,
  },
  macro: {
    dollarScore: 0,
    rateScore: 0,
    riskScore: 1,
    inflationScore: 1,
  },
  history: [],
  professional: {
    indicators: [],
    news: [],
    updatedAt: null,
  },
  compliance: {
    riskAccepted: false,
    riskVersion: DISCLAIMER_VERSION,
    riskAcceptedAt: null,
  },
  review: {
    forecastLogs: [],
    priceAlerts: [],
    events: [],
  },
};

let state = loadState();
let toastTimer = null;
let licenseStatus = null;
let licenseLoading = true;
let updateInfo = null;
let updateLoading = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      preferences: normalizePreferences(parsed.preferences || {}),
      macro: { ...DEFAULT_STATE.macro, ...(parsed.macro || {}) },
      history: Array.isArray(parsed.history) ? parsed.history : [],
      professional: {
        ...DEFAULT_STATE.professional,
        ...(parsed.professional || {}),
        indicators: Array.isArray(parsed.professional?.indicators) ? parsed.professional.indicators : [],
        news: Array.isArray(parsed.professional?.news) ? parsed.professional.news : [],
      },
      compliance: { ...DEFAULT_STATE.compliance, ...(parsed.compliance || {}) },
      review: normalizeReview(parsed.review || {}),
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function normalizeReview(review) {
  return {
    forecastLogs: Array.isArray(review.forecastLogs) ? review.forecastLogs : [],
    priceAlerts: Array.isArray(review.priceAlerts) ? review.priceAlerts : [],
    events: Array.isArray(review.events) ? review.events : [],
  };
}

function normalizePreferences(preferences) {
  return {
    ...DEFAULT_STATE.preferences,
    ...preferences,
    theme: preferences.theme === "professional" ? "professional" : "simple",
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function isAuthorized() {
  return Boolean(licenseStatus && (!licenseStatus.required || licenseStatus.usable));
}

async function refreshLicenseStatus() {
  try {
    const response = await fetch("/api/license/status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "授权状态读取失败");
    licenseStatus = data;
  } catch (error) {
    licenseStatus = {
      required: true,
      configured: false,
      state: "unreachable",
      usable: false,
      readOnly: true,
      message: error.message || "无法连接本地授权服务。",
      features: [],
    };
  } finally {
    licenseLoading = false;
  }
  return licenseStatus;
}

function licenseStateLabel(status = licenseStatus) {
  if (licenseLoading || !status) return "验证中";
  if (status.state === "development") return "开发模式";
  if (status.state === "active") return "授权有效";
  if (status.state === "grace") return "离线宽限";
  if (status.state === "expired") return "授权过期";
  if (status.state === "unlicensed") return "未激活";
  if (status.state === "unconfigured") return "未配置";
  if (status.state === "clock_error") return "时间异常";
  return "授权异常";
}

function licenseDate(value) {
  if (!value) return "未设置";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未设置" : date.toLocaleString("zh-CN");
}

function licenseDetailHtml(status = licenseStatus) {
  if (!status) return "";
  const rows = [
    ["产品", status.productId || "gold-trend-desk"],
    ["客户", status.customerName || (status.required ? "未签发" : "开发预览")],
    ["版本", status.plan || (status.required ? "未签发" : "开发版")],
    ["正式到期", licenseDate(status.licenseExpiresAt)],
    ["最近在线验证", licenseDate(status.lastOnlineCheck)],
    ["设备", status.deviceLabel || "当前设备"],
  ];
  return rows
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function renderLicenseGate() {
  const authorized = isAuthorized();
  $("#authGate").hidden = authorized;
  $("#appShell").hidden = !authorized;
  const message = $("#authMessage");
  if (message && !authorized) {
    message.textContent = licenseStatus?.message || "正在验证软件授权。";
  }
  const device = $("#authDevice");
  if (device && !authorized && licenseStatus?.installationId) {
    device.innerHTML = `
      <span>本机安装编号</span>
      <code>${escapeHtml(licenseStatus.installationId)}</code>
      <small>${escapeHtml(licenseStatus.deviceLabel || "")}</small>
    `;
  }
}

async function renderAuthState(options = {}) {
  if (options.refetch !== false) await refreshLicenseStatus();
  renderLicenseGate();
  if (isAuthorized()) {
    applyPreferences();
    renderAll();
    void refreshUpdateStatus();
  }
}

function applyPreferences() {
  document.body.classList.toggle("theme-simple", state.preferences.theme === "simple");
  document.body.classList.toggle("theme-professional", state.preferences.theme === "professional");
  document.documentElement.style.setProperty("--up-color", state.preferences.upColor || DEFAULT_UP_COLOR);
  document.documentElement.style.setProperty("--down-color", state.preferences.downColor || DEFAULT_DOWN_COLOR);
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

function pct(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number >= 0 ? "+" : ""}${formatNumber(number, digits)}%`;
}

function fileSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes >= 1024 * 1024 * 1024) return `${formatNumber(bytes / 1024 / 1024 / 1024, 2)} GB`;
  if (bytes >= 1024 * 1024) return `${formatNumber(bytes / 1024 / 1024, 1)} MB`;
  return `${formatNumber(bytes / 1024, 0)} KB`;
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function normalizedHistoryPoints(points = state.history) {
  points = Array.isArray(points) ? points : [];
  const byDate = new Map();
  points
    .map((point) => Number(point.close))
    .forEach((close, index) => {
      const raw = points[index] || {};
      if (!Number.isFinite(close) || close <= 0) return;
      const date = String(raw.date || index).slice(0, 32);
      byDate.set(date, {
        ...raw,
        date,
        close,
      });
    });

  const sorted = Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const cleaned = [];
  for (const point of sorted) {
    const previous = cleaned.at(-1)?.close;
    const move = previous ? Math.abs(((point.close - previous) / previous) * 100) : 0;
    if (previous && move > 12) continue;
    cleaned.push(point);
  }
  return cleaned.slice(-360);
}

function closes() {
  return normalizedHistoryPoints().map((point) => point.close);
}

function validHistoryCount(points = state.history) {
  return normalizedHistoryPoints(points).length;
}

function liveGoldUsd() {
  const latest = Number(state.settings.goldUsdPerOz || 0);
  return Number.isFinite(latest) && latest > 0 ? latest : 0;
}

function historyQuality(count) {
  if (count >= 180) return 1;
  if (count >= 120) return 0.84;
  if (count >= 60) return 0.68;
  if (count >= 30) return 0.5;
  if (count >= 10) return 0.34;
  if (count >= 1) return 0.2;
  return 0.1;
}

function buildModelSeries(observedValues) {
  const live = liveGoldUsd();
  const values = observedValues.slice(-360);
  if (live) {
    const last = values.at(-1);
    if (!last || Math.abs(distancePct(live, last)) > 0.08) values.push(live);
  }
  const observedCount = values.length;
  if (observedCount >= 30) {
    return {
      values,
      observedCount,
      synthetic: false,
      quality: historyQuality(observedCount),
    };
  }
  const fallback = buildFallbackSeries(80, values.at(-1) || live || Number(state.settings.goldUsdPerOz || 3385));
  const merged = observedCount ? fallback.slice(0, Math.max(0, fallback.length - observedCount)).concat(values) : fallback;
  return {
    values: merged,
    observedCount,
    synthetic: true,
    quality: historyQuality(observedCount),
  };
}

function lookbackCoverage(observedCount, days) {
  if (observedCount > days) return 1;
  if (observedCount <= 1) return 0;
  return clamp((observedCount - 1) / Math.max(1, days), 0, 1);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function movingAverage(values, days) {
  return average(values.slice(-days));
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function returnForDays(values, days) {
  const latest = values.at(-1) || Number(state.settings.goldUsdPerOz || 0);
  const fallback = values[0] || latest;
  const index = Math.max(0, values.length - 1 - days);
  const previous = values[index] || fallback;
  if (!latest || !previous) return 0;
  return ((latest - previous) / previous) * 100;
}

function distancePct(value, base) {
  const number = Number(value);
  const denominator = Number(base);
  if (!Number.isFinite(number) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return ((number - denominator) / denominator) * 100;
}

function directionColor(className) {
  if (className === "up") return "var(--up-color)";
  if (className === "down") return "var(--down-color)";
  return "var(--gold)";
}

function directionPreviewClass(className) {
  if (className === "up") return "preview-up";
  if (className === "down") return "preview-down";
  return "preview-neutral";
}

function macroBreakdown() {
  const opportunityCost =
    Number(state.macro.dollarScore || 0) * -7 +
    Number(state.macro.rateScore || 0) * -7;
  const riskUncertainty = Number(state.macro.riskScore || 0) * 6;
  const economicExpansion = Number(state.macro.inflationScore || 0) * 6;
  return {
    opportunityCost,
    riskUncertainty,
    economicExpansion,
    total: opportunityCost + riskUncertainty + economicExpansion,
  };
}

function macroScore() {
  return macroBreakdown().total;
}

function technicalProfile() {
  const observedValues = closes();
  const modelSeries = buildModelSeries(observedValues);
  const values = modelSeries.values;
  const latest = values.at(-1) || Number(state.settings.goldUsdPerOz || 0);
  const ma20 = movingAverage(values, 20);
  const ma60 = movingAverage(values, 60);
  const ma120 = movingAverage(values, 120);
  const ret5 = returnForDays(values, 5);
  const ret20 = returnForDays(values, 20);
  const ret60 = returnForDays(values, 60);
  const ret120 = returnForDays(values, 120);
  const ret252 = returnForDays(values, 252);
  const recent20 = values.slice(-20);
  const recent60 = values.slice(-60);
  const dailyReturns = values
    .slice(-90)
    .map((value, index, array) => (index === 0 ? 0 : ((value - array[index - 1]) / array[index - 1]) * 100))
    .slice(1);
  const volatility = Math.max(modelSeries.synthetic ? 0.85 : 0, stdDev(dailyReturns));
  const ma20Std = stdDev(recent20);
  const zScore20 = ma20 && ma20Std ? (latest - ma20) / ma20Std : 0;
  const high60 = recent60.length ? Math.max(...recent60) : latest;
  const low60 = recent60.length ? Math.min(...recent60) : latest;
  const rangePosition60 = high60 > low60 ? ((latest - low60) / (high60 - low60)) * 100 : 50;
  const trendBias = clamp(
    (latest && ma20 ? (latest > ma20 ? 5 : -5) : 0) +
      (ma20 && ma60 ? (ma20 > ma60 ? 7 : -7) : 0) +
      (ma60 && ma120 ? (ma60 > ma120 ? 5 : -5) : 0) +
      clamp(distancePct(ma20, ma60) * 2.2, -8, 8) +
      clamp(distancePct(ma60, ma120) * 1.4, -6, 6),
    -28,
    28
  );

  return {
    values,
    latest,
    ma20,
    ma60,
    ma120,
    ret5,
    ret20,
    ret60,
    ret120,
    ret252,
    volatility,
    zScore20,
    high60,
    low60,
    rangePosition60,
    distanceMa20: distancePct(latest, ma20),
    distanceMa60: distancePct(latest, ma60),
    trendBias,
    historyCount: modelSeries.observedCount,
    dataQuality: modelSeries.quality,
    syntheticHistory: modelSeries.synthetic,
    lookbackCoverage: Object.fromEntries(HORIZONS.map((horizon) => [horizon.key, lookbackCoverage(modelSeries.observedCount, horizon.days)])),
  };
}

function momentumForHorizon(profile, horizon) {
  if (horizon.days <= 5) return profile.ret5 * 3.1 + profile.ret20 * 0.45;
  if (horizon.days <= 21) return profile.ret20 * 1.75 + profile.ret5 * 0.65;
  if (horizon.days <= 63) return profile.ret60 * 1.05 + profile.ret20 * 0.55;
  if (horizon.days <= 126) return profile.ret120 * 0.78 + profile.ret60 * 0.45;
  return profile.ret252 * 0.48 + profile.ret120 * 0.52;
}

function forecastFor(horizon, profile, context) {
  const rawReturn = returnForDays(profile.values, horizon.days);
  const momentum = clamp(momentumForHorizon(profile, horizon), -28, 28);
  const trend = clamp(profile.trendBias * horizon.techWeight, -28, 28);
  const news = clamp(context.news.score * horizon.newsWeight, -10, 10);
  const meanReversion = clamp(-profile.zScore20 * 2.4 * horizon.meanReversionWeight, -9, 9);
  const volatilityPenalty = clamp(profile.volatility * (horizon.days <= 5 ? 1.55 : horizon.days <= 21 ? 1.05 : 0.72), 0, 8);
  const macroDrivers = context.macroDrivers || macroBreakdown();
  const professionalGroups = context.professional.groups || {};
  const driverGroups = {
    economicExpansion: clamp(macroDrivers.economicExpansion * horizon.macroWeight + news * 0.12, -18, 18),
    riskUncertainty: clamp(
      macroDrivers.riskUncertainty * horizon.macroWeight +
        Number(professionalGroups.riskUncertainty || 0) * horizon.professionalWeight +
        news * 0.88,
      -22,
      22
    ),
    opportunityCost: clamp(
      macroDrivers.opportunityCost * horizon.macroWeight +
        Number(professionalGroups.opportunityCost || 0) * horizon.professionalWeight,
      -26,
      26
    ),
    momentum: clamp(momentum + trend + Number(professionalGroups.momentum || 0) * horizon.professionalWeight, -34, 34),
  };
  const rawScore =
    driverGroups.economicExpansion +
    driverGroups.riskUncertainty +
    driverGroups.opportunityCost +
    driverGroups.momentum +
    meanReversion;
  const riskAdjustedScore = rawScore - Math.sign(rawScore) * volatilityPenalty * 0.38;
  const score = clamp(Math.round(50 + riskAdjustedScore), 1, 99);
  const className = score >= 53 ? "up" : score <= 47 ? "down" : "neutral";
  const direction = className === "up" ? "偏涨" : className === "down" ? "偏跌" : "震荡";
  const factorValues = [...Object.values(driverGroups), meanReversion].filter((value) => Math.abs(value) >= 1);
  const positiveCount = factorValues.filter((value) => value > 0).length;
  const negativeCount = factorValues.filter((value) => value < 0).length;
  const agreement = factorValues.length ? Math.max(positiveCount, negativeCount) / factorValues.length : 0.5;
  const coverage = profile.lookbackCoverage?.[horizon.key] ?? lookbackCoverage(profile.historyCount || 0, horizon.days);
  const historyBonus = profile.dataQuality >= 0.84 ? 8 : profile.dataQuality >= 0.5 ? 4 : 0;
  const professionalQuality = Number(context.professional.quality || context.professional.coverage || 0);
  const professionalBonus = professionalQuality >= 0.8 ? 6 : professionalQuality >= 0.45 ? 3 : 0;
  const dataPenalty = (1 - Number(profile.dataQuality || 0.1)) * 12 + (1 - coverage) * 5;
  const confidence = clamp(
    Math.round(38 + Math.abs(score - 50) * 1.12 + agreement * 18 + historyBonus + professionalBonus - volatilityPenalty * 1.6 - dataPenalty),
    28,
    92
  );
  const qualityScale = 0.72 + Number(profile.dataQuality || 0.1) * 0.28;
  const expectedMove = clamp(
    (riskAdjustedScore / (horizon.days <= 5 ? 12 : horizon.days <= 21 ? 8 : horizon.days <= 63 ? 6 : 5)) * qualityScale,
    -14,
    14
  );
  const components = { ...driverGroups, meanReversion, risk: -volatilityPenalty };
  const keyDrivers = topForecastDrivers(components);

  return {
    ...horizon,
    score,
    direction,
    className,
    arrow: className === "up" ? "↗" : className === "down" ? "↘" : "→",
    confidence,
    expectedMove,
    rawReturn,
    historyLabel: coverage >= 0.95 ? "历史同周期变化" : profile.historyCount >= 2 ? "可用历史变化" : "参考变化",
    driverGroups,
    components,
    keyDrivers,
  };
}

function professionalBiasDetail() {
  const dxy = findIndicator("dxy");
  const us10y = findIndicator("us10y");
  const gld = findIndicator("gld");
  const gdx = findIndicator("gdx");
  const vix = findIndicator("vix");
  let score = 0;
  const details = [];
  const groups = {
    opportunityCost: 0,
    riskUncertainty: 0,
    economicExpansion: 0,
    momentum: 0,
  };

  function sourceQuality(item) {
    if (!item?.available) return 0;
    if (item.proxy) return 0.25;
    if (item.fallback) return 0.7;
    return 1;
  }

  function add(item, label, factorScore, group, positiveText, negativeText) {
    if (!item?.available || !Number.isFinite(Number(item.changePct))) return;
    const rounded = clamp(factorScore, -8, 8) * sourceQuality(item);
    score += rounded;
    if (groups[group] !== undefined) groups[group] += rounded;
    details.push({
      label,
      score: rounded,
      text: rounded >= 0 ? positiveText : negativeText,
    });
  }

  add(dxy, "美元", Number(dxy?.changePct) * -7, "opportunityCost", "美元走弱支撑黄金", "美元走强压制黄金");
  add(us10y, "利率", Number(us10y?.changePct) * -0.75, "opportunityCost", "长端收益率回落降低持有成本", "长端收益率上行抬高持有成本");
  add(gld, "ETF", Number(gld?.changePct) * 4, "momentum", "GLD 走强代表资金愿意配置黄金", "GLD 走弱代表资金偏谨慎");
  add(gdx, "矿股", Number(gdx?.changePct) * 2.2, "momentum", "金矿股共振走强", "金矿股偏弱削弱风险偏好");
  add(vix, "波动", Number(vix?.changePct) * 0.45, "riskUncertainty", "波动率上行带来避险支撑", "波动率回落降低避险溢价");

  const indicators = [dxy, us10y, gld, gdx, vix];
  const available = indicators.filter((item) => item?.available).length;
  const quality = indicators.reduce((sum, item) => sum + sourceQuality(item), 0) / indicators.length;
  return {
    score: clamp(score, -18, 18),
    details,
    coverage: available / 5,
    quality,
    groups,
  };
}

function professionalBias() {
  return professionalBiasDetail().score;
}

function newsSentimentScore() {
  const stats = newsMoodStats();
  if (!state.professional.news.length) return { score: 0, signal: stats.signal, coverage: 0 };
  const score = clamp((stats.score / Math.max(1, state.professional.news.length)) * 3.5, -10, 10);
  return { score, signal: stats.signal, coverage: Math.min(1, state.professional.news.length / 6) };
}

function buildForecastContext() {
  return {
    macro: macroScore(),
    macroDrivers: macroBreakdown(),
    professional: professionalBiasDetail(),
    news: newsSentimentScore(),
  };
}

function topForecastDrivers(components) {
  const labels = {
    economicExpansion: "经济/通胀",
    riskUncertainty: "风险不确定性",
    opportunityCost: "机会成本",
    momentum: "价格动量",
    meanReversion: "均值回归",
    risk: "波动风险",
  };
  return Object.entries(components)
    .filter(([, value]) => Math.abs(value) >= 1.2)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([key, value]) => ({
      key,
      label: labels[key] || key,
      value,
      className: value > 0 ? "positive" : "negative",
    }));
}

function buildForecasts() {
  const profile = technicalProfile();
  const context = buildForecastContext();
  return {
    profile,
    context,
    forecasts: HORIZONS.map((horizon) => forecastFor(horizon, profile, context)),
  };
}

function findIndicator(key) {
  return state.professional.indicators.find((item) => item.key === key);
}

function renderMarket() {
  const syncedText = state.settings.updatedAt
    ? `已同步：${new Date(state.settings.updatedAt).toLocaleString("zh-CN")}`
    : "使用本地示例数据";

  setText("#goldCny", `${formatNumber(state.settings.goldCnyPerGram)} 元/克`);
  setText("#goldUsd", `${formatNumber(state.settings.goldUsdPerOz)} 美元/盎司`);
  setText("#usdCny", formatNumber(state.settings.usdCny, 4));
  setText(
    "#goldChange",
    Number.isFinite(state.settings.changePct) ? `日内变化 ${pct(state.settings.changePct)}` : "等待真实行情"
  );
  setText("#sourceLabel", state.settings.source || "本地数据");
  setText("#updatedAt", state.settings.updatedAt ? new Date(state.settings.updatedAt).toLocaleString("zh-CN") : "未同步");
  setText("#syncStatus", syncedText);

  setText("#proSyncStatus", syncedText);
  setText("#proGoldCny", `${formatNumber(state.settings.goldCnyPerGram)} 元/克`);
  setText("#proDxy", indicatorValueText(findIndicator("dxy")));
  setText("#proYield", indicatorValueText(findIndicator("us10y"), 3));
  setText(
    "#proDataTime",
    state.professional.updatedAt ? new Date(state.professional.updatedAt).toLocaleString("zh-CN") : "未同步"
  );
}

function indicatorValueText(item, digits = 2) {
  if (!item?.available) return "--";
  return formatNumber(item.price, digits);
}

function renderForecasts() {
  const { forecasts, profile, context } = buildForecasts();
  const main = forecasts.find((item) => item.key === "w1") || forecasts[0];
  const longer = forecasts.find((item) => item.key === "m3") || main;
  setText("#mainDirection", main.direction);
  $("#mainDirection").style.color = directionColor(main.className);
  setText("#mainScore", `综合分 ${main.score}/100`);
  setText(
    "#heroSummary",
    `未来 1 周判断为${main.direction}，3 个月判断为${longer.direction}。模型现在综合技术面、宏观四因子、专业市场因子、新闻情绪和波动风险，当前主要驱动是${main.keyDrivers.map((item) => item.label).join("、") || "数据仍在积累"}。`
  );

  $("#forecastGrid").innerHTML = forecasts
    .map(
      (item) => `<article class="forecast-card ${item.className}">
        <div>
          <span>未来</span>
          <h3>${item.label}</h3>
        </div>
        <div class="direction">
          <i>${item.arrow}</i>
          <strong>${item.direction}</strong>
        </div>
        <div class="forecast-meta">
          <span>模型分 <b>${item.score}/100</b></span>
          <span>置信度 <b class="confidence">${item.confidence}%</b></span>
        </div>
        <p>隐含变化约 ${pct(item.expectedMove)}，${item.historyLabel} ${pct(item.rawReturn)}。</p>
        <div class="forecast-drivers">${forecastDriverTags(item)}</div>
      </article>`
    )
    .join("");

  setText("#momentumMetric", `${pct(profile.ret5)} / ${pct(profile.ret20)}`);
  setText("#trendMetric", profile.trendBias > 9 ? "强势" : profile.trendBias < -9 ? "弱势" : "中性");
  setText("#volatilityMetric", profile.volatility > 2.2 ? "高" : profile.volatility > 1.1 ? "中" : "低");

  renderProfessionalForecasts(forecasts, profile, context);
}

function forecastDriverTags(item) {
  if (!item.keyDrivers.length) return `<span>因子接近均衡</span>`;
  return item.keyDrivers
    .map((driver) => `<span class="${driver.className}">${driver.label} ${driver.value >= 0 ? "+" : ""}${formatNumber(driver.value, 1)}</span>`)
    .join("");
}

function renderProfessionalForecasts(forecasts, profile, context) {
  const main = forecasts.find((item) => item.key === "w1") || forecasts[0];
  const longTerm = forecasts.find((item) => item.key === "y1") || main;
  setText("#proMainDirection", main.direction);
  $("#proMainDirection").style.color = directionColor(main.className);
  const groups = main.driverGroups || {};
  setText(
    "#proMainScore",
    `模型分 ${main.score}/100 · 机会成本 ${Number(groups.opportunityCost || 0) >= 0 ? "+" : ""}${formatNumber(groups.opportunityCost || 0, 1)} · 风险 ${Number(groups.riskUncertainty || 0) >= 0 ? "+" : ""}${formatNumber(groups.riskUncertainty || 0, 1)} · 动量 ${Number(groups.momentum || 0) >= 0 ? "+" : ""}${formatNumber(groups.momentum || 0, 1)}`
  );
  setText(
    "#proSummary",
    `短期 ${main.direction}，长期 ${longTerm.direction}。专业模式参考黄金研究常用四驱动框架：经济/通胀、风险不确定性、机会成本、价格动量，并按数据质量修正置信度。`
  );
  setText(
    "#proTechnicalBadge",
    `MA20 ${profile.ma20 && profile.ma60 ? profile.ma20 > profile.ma60 ? "强于 MA60" : "弱于 MA60" : "数据不足"} · 真实历史 ${profile.historyCount} 日 · 质量 ${formatNumber(profile.dataQuality * 100, 0)}%`
  );

  $("#proForecastGrid").innerHTML = forecasts
    .map(
      (item) => `<article class="pro-forecast-card ${item.className}">
        <span>${item.label}</span>
        <strong>${item.direction}</strong>
        <small>分数 ${item.score}/100 · 置信度 ${item.confidence}% · 隐含 ${pct(item.expectedMove)}</small>
        <div class="forecast-drivers">${forecastDriverTags(item)}</div>
      </article>`
    )
    .join("");
}

function renderReasons() {
  const { profile, forecasts, context } = buildForecasts();
  const w1 = forecasts.find((item) => item.key === "w1");
  const m1 = forecasts.find((item) => item.key === "m1");
  const y1 = forecasts.find((item) => item.key === "y1");
  const professionalText = context.professional.details.length
    ? context.professional.details
        .slice(0, 3)
        .map((item) => `${item.label}${item.score >= 0 ? "+" : ""}${formatNumber(item.score, 1)}`)
        .join("，")
    : "等待专业行情同步";
  const historyText =
    profile.historyCount >= 60
      ? `真实历史 ${profile.historyCount} 日`
      : profile.historyCount > 0
        ? `真实历史仅 ${profile.historyCount} 日，已降低置信度`
        : "历史行情暂缺，已按参考序列低置信度处理";
  const reasons = [
    {
      icon: "1",
      title: "技术面",
      text: `${historyText}；近 5 日 ${pct(profile.ret5)}，近 1 月 ${pct(profile.ret20)}，近 3 月 ${pct(profile.ret60)}；1 周判断为${w1.direction}。`,
    },
    {
      icon: "2",
      title: "趋势与均值回归",
      text:
        profile.ma20 && profile.ma60
          ? `20 日均线${profile.ma20 > profile.ma60 ? "高于" : "低于"} 60 日均线，价格相对 20 日均线偏离 ${pct(profile.distanceMa20)}，1 月判断为${m1.direction}。`
          : "历史行情不足，暂时更多依赖当前价格和宏观校准。",
    },
    {
      icon: "3",
      title: "宏观四因子",
      text: `美元、实际利率、避险情绪、通胀/央行购金合计影响为 ${context.macro >= 0 ? "+" : ""}${formatNumber(context.macro, 1)} 分，长期 1 年判断为${y1.direction}。`,
    },
    {
      icon: "4",
      title: "专业与新闻",
      text: `专业因子：${professionalText}；新闻情绪：${context.news.signal}。这些会影响短中期置信度，而不是替代独立判断。`,
    },
  ];

  $("#reasonList").innerHTML = reasons
    .map(
      (item) => `<div class="reason-item">
        <b>${item.icon}</b>
        <div>
          <strong>${item.title}</strong>
          <p>${item.text}</p>
        </div>
      </div>`
    )
    .join("");
}

function renderProfessional() {
  const indicators = state.professional.indicators;
  $("#proFactorGrid").innerHTML = indicators.length
    ? indicators.map((item) => factorCard(item)).join("")
    : `<div class="factor-card"><span>暂无专业因子</span><p>点击同步行情后，会加载美元、利率、ETF、金矿股和波动率。</p></div>`;

  $("#proLinkedAssets").innerHTML = indicators.length
    ? indicators
        .filter((item) => ["gld", "gdx", "dxy", "us10y", "vix"].includes(item.key))
        .map((item) => linkedAsset(item))
        .join("")
    : `<div class="linked-item"><span>等待同步</span><strong>暂无联动资产</strong></div>`;

  $("#proNewsList").innerHTML = state.professional.news.length
    ? state.professional.news.map((item) => newsItem(item)).join("")
    : `<div class="news-item"><span>等待同步</span><h3>暂无专业新闻</h3><p>点击同步行情后，会尝试加载黄金、GLD、GDX 相关新闻。</p></div>`;

  $("#proResearchList").innerHTML = researchItems().map((item) => researchItem(item)).join("");
  renderNewsMood();
}

function factorCard(item) {
  if (!item.available) {
    return `<article class="factor-card">
      <div class="factor-top"><h3>${item.label}</h3><span class="factor-signal">暂无</span></div>
      <p>${item.error || "当前数据源暂不可用"}</p>
    </article>`;
  }
  const signal = factorSignal(item);
  const source = item.source ? `<small class="factor-source">数据源：${escapeHtml(item.source)}</small>` : "";
  const body = item.fallback || item.proxy ? source || "使用公开数据源" : `${item.impact}${source}`;
  return `<article class="factor-card">
    <div class="factor-top">
      <h3>${item.label}</h3>
      <span class="factor-signal ${signal.kind}">${signal.label}</span>
    </div>
    <div class="factor-value">
      <strong>${formatNumber(item.price, item.key === "us10y" ? 3 : 2)}</strong>
      <span class="${Number(item.changePct) >= 0 ? "preview-up" : "preview-down"}">${pct(item.changePct)}</span>
    </div>
    <p>${body}</p>
  </article>`;
}

function factorSignal(item) {
  const change = Number(item.changePct);
  if (!Number.isFinite(change)) return { label: "中性", kind: "" };
  if (item.proxy) return { label: "代理估算", kind: "" };
  if (Math.abs(change) < 0.05) return { label: item.fallback ? "兜底数据" : "中性", kind: "" };
  if (item.key === "dxy" || item.key === "us10y") {
    return change < 0 ? { label: "利多黄金", kind: "good" } : { label: "压制黄金", kind: "bad" };
  }
  if (item.key === "gld" || item.key === "gdx") {
    return change > 0 ? { label: "资金偏多", kind: "good" } : { label: "资金偏弱", kind: "bad" };
  }
  if (item.key === "vix") {
    return change > 0 ? { label: "避险升温", kind: "good" } : { label: "风险偏好升温", kind: "" };
  }
  return { label: "观察", kind: "" };
}

function linkedAsset(item) {
  if (!item.available) {
    return `<div class="linked-item"><span>${item.label}</span><strong>暂无数据</strong></div>`;
  }
  return `<div class="linked-item">
    <div class="linked-top">
      <h3>${item.label}</h3>
      <span>${item.symbol}</span>
    </div>
    <strong>${formatNumber(item.price, item.key === "us10y" ? 3 : 2)}</strong>
    <span class="${Number(item.changePct) >= 0 ? "preview-up" : "preview-down"}">${pct(item.changePct)}</span>
  </div>`;
}

function newsItem(item) {
  const tag = classifyNews(item.title);
  const sentiment = newsSentiment(item);
  const title = escapeHtml(item.title || "未命名新闻");
  const summary = escapeHtml(item.summary || "");
  const link = item.link ? escapeHtml(item.link) : "";
  const titleHtml = link ? `<a href="${link}" target="_blank" rel="noreferrer">${title}</a>` : title;
  return `<article class="news-item">
    <div class="news-top">
      <h3>${titleHtml}</h3>
      <div class="news-tags">
        <span class="news-tag ${sentiment.className}">${sentiment.label}</span>
        <span class="news-tag">${tag}</span>
      </div>
    </div>
    <p>${summary}</p>
    <span>${escapeHtml(item.source || "新闻源")} · ${formatNewsTime(item.publishedAt)}</span>
  </article>`;
}

function classifyNews(title) {
  const text = String(title || "").toLowerCase();
  if (text.includes("fed") || text.includes("rate") || text.includes("yield")) return "利率";
  if (text.includes("dollar") || text.includes("currency")) return "美元";
  if (text.includes("inflation") || text.includes("cpi")) return "通胀";
  if (text.includes("etf") || text.includes("fund")) return "资金";
  if (text.includes("war") || text.includes("risk")) return "避险";
  return "黄金";
}

function formatNewsTime(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN");
}

function researchItems() {
  const profile = technicalProfile();
  const dxy = findIndicator("dxy");
  const us10y = findIndicator("us10y");
  const gld = findIndicator("gld");
  const gdx = findIndicator("gdx");
  const checklist = [];
  checklist.push({
    title: "按四驱动框架复核",
    text: "先拆机会成本、风险不确定性、经济/通胀和价格动量，再看四类分数是否同向。若分歧较大，应降低结论置信度。",
  });
  const macroSupport =
    dxy?.available && us10y?.available && Number(dxy.changePct) < 0 && Number(us10y.changePct) < 0;
  checklist.push({
    title: macroSupport ? "宏观双支撑成立" : "核验美元与利率方向",
    text: macroSupport
      ? "美元指数和长端利率同时回落，短中期黄金支撑更强。"
      : "若美元和收益率同步上行，需要降低偏多结论的可信度。",
  });
  checklist.push({
    title: "检查 ETF 与矿股是否共振",
    text:
      gld?.available && gdx?.available
        ? `GLD ${pct(gld.changePct)}，GDX ${pct(gdx.changePct)}。矿股强弱可作为黄金风险偏好的二阶确认。`
        : "等待 GLD/GDX 数据同步后再确认资金面。",
  });
  checklist.push({
    title: "观察技术位",
    text:
      profile.ma20 && profile.ma60
        ? `当前 20 日均线${profile.ma20 > profile.ma60 ? "高于" : "低于"} 60 日均线，近 3 个月变化 ${pct(profile.ret60)}。`
        : "历史行情不足，先避免过度依赖均线结论。",
  });
  checklist.push({
    title: "新闻风险复核",
    text: "重点看美联储、通胀、美元、地缘冲突和 ETF 资金流新闻是否与模型方向一致。",
  });
  return checklist;
}

function researchItem(item) {
  return `<div class="research-item">
    <strong>${item.title}</strong>
    <p>${item.text}</p>
  </div>`;
}

function renderChart() {
  drawChart("#priceChart", false);
  drawChart("#proPriceChart", true);
}

function drawChart(selector, showMovingAverages) {
  const canvas = $(selector);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const values = closes();
  const data = values.length >= 4 ? values.slice(-252) : buildFallbackSeries();
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pad = 34;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const styles = getComputedStyle(document.documentElement);
  const gold = styles.getPropertyValue("--gold").trim() || "#f0bd62";
  const up = styles.getPropertyValue("--up-color").trim() || DEFAULT_UP_COLOR;
  const ink = styles.getPropertyValue("--ink").trim() || "#f6f3ea";

  ctx.fillStyle = state.preferences.theme === "simple" ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.025)";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = state.preferences.theme === "simple" ? "rgba(29,35,41,0.09)" : "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = pad + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  const points = pointsForChart(data, min, max, pad, plotW, plotH);
  const gradient = ctx.createLinearGradient(0, pad, 0, height - pad);
  gradient.addColorStop(0, colorToRgba(gold, 0.35));
  gradient.addColorStop(1, colorToRgba(gold, 0));

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(width - pad, height - pad);
  ctx.lineTo(pad, height - pad);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  drawLine(ctx, points, gold, 3);

  if (showMovingAverages && data.length > 30) {
    const ma20 = rollingAverage(data, 20);
    const ma60 = rollingAverage(data, 60);
    drawLine(ctx, pointsForChart(ma20, min, max, pad, plotW, plotH), up, 1.8);
    drawLine(ctx, pointsForChart(ma60, min, max, pad, plotW, plotH), "#72a7ff", 1.8);
  }

  const latest = points.at(-1);
  if (latest) {
    ctx.fillStyle = up;
    ctx.beginPath();
    ctx.arc(latest.x, latest.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = colorToRgba(ink, 0.68);
  ctx.font = "14px Microsoft YaHei, sans-serif";
  ctx.fillText(`高 ${formatNumber(max)} 美元`, pad, 22);
  ctx.fillText(`低 ${formatNumber(min)} 美元`, pad, height - 12);
  if (showMovingAverages) {
    ctx.fillText("MA20 / MA60", width - 130, 22);
  }
}

function rollingAverage(values, windowSize) {
  return values.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1);
    return average(values.slice(start, index + 1));
  });
}

function pointsForChart(data, min, max, pad, plotW, plotH) {
  return data.map((value, index) => ({
    x: pad + (index / Math.max(1, data.length - 1)) * plotW,
    y: pad + (1 - (value - min) / Math.max(1, max - min)) * plotH,
    value,
  }));
}

function drawLine(ctx, points, color, width) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function colorToRgba(hex, alpha) {
  const normalized = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return `rgba(240,189,98,${alpha})`;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildFallbackSeries(length = 80, baseValue = Number(state.settings.goldUsdPerOz || 3385)) {
  const base = Number(baseValue) || Number(state.settings.goldUsdPerOz || 3385);
  const changeSignal = clamp(Number(state.settings.changePct || 0), -2.5, 2.5) / 100;
  return Array.from({ length }, (_, index) => {
    const wave = Math.sin(index / 8) * 0.0025;
    const slope = ((index - (length - 1)) / Math.max(1, length - 1)) * changeSignal * 0.35;
    return base * (1 + wave + slope);
  });
}

function updateMacroLabels() {
  const labels = {
    "-2": "明显利空",
    "-1": "轻微利空",
    0: "中性",
    1: "轻微利多",
    2: "明显利多",
  };
  const reverseLabels = {
    "-2": "明显利多",
    "-1": "轻微利多",
    0: "中性",
    1: "轻微利空",
    2: "明显利空",
  };
  setText("#dollarScoreLabel", reverseLabels[$("#dollarScore").value]);
  setText("#rateScoreLabel", reverseLabels[$("#rateScore").value]);
  setText("#riskScoreLabel", labels[$("#riskScore").value]);
  setText("#inflationScoreLabel", labels[$("#inflationScore").value]);
}

function renderControls() {
  Object.entries(state.macro).forEach(([key, value]) => {
    const input = $(`#${key}`);
    if (input) input.value = value;
  });
  updateMacroLabels();
}

function renderSettings() {
  $("#upColor").value = state.preferences.upColor || DEFAULT_UP_COLOR;
  $("#downColor").value = state.preferences.downColor || DEFAULT_DOWN_COLOR;
  $$(".theme-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeOption === state.preferences.theme);
  });
  setText("#authStatus", licenseStateLabel());
  setText("#licenseSettingsCopy", licenseStatus?.message || "正在读取中央授权状态。");
  const detail = $("#licenseDetail");
  if (detail) detail.innerHTML = licenseDetailHtml();
  const refreshButton = $("#refreshLicenseBtn");
  if (refreshButton) {
    refreshButton.hidden = licenseStatus?.required === false;
    refreshButton.disabled = !licenseStatus?.required || ["unlicensed", "unconfigured"].includes(licenseStatus?.state);
  }
  renderUpdatePanel();
}

function renderUpdatePanel() {
  const info = updateInfo || {};
  const release = info.release;
  const downloaded = info.downloaded;
  const progress = info.downloadProgress;
  setText("#currentVersion", info.currentVersion || "--");
  setText("#availableVersion", release?.version || (info.updateAvailable === false ? "暂无新版本" : "点击检查后显示"));
  setText(
    "#availableVersionMeta",
    release
      ? `${release.filename || "更新包"} · ${fileSize(release.fileSize)} · ${formatLocalDateTime(release.createdAt)}`
      : "暂无更新信息"
  );
  setText("#downloadedVersion", downloaded?.version || "未下载");
  setText(
    "#downloadedVersionMeta",
    downloaded
      ? `${downloaded.filename || "已下载"} · ${formatLocalDateTime(downloaded.downloadedAt)}`
      : info.applyEnabled === false
        ? "当前环境只允许下载和校验"
        : "下载后才可应用"
  );
  setText(
    "#updateStatusCopy",
    updateLoading
      ? "正在处理云端更新请求。"
      : release
        ? `发现 ${release.version} 版本，可下载并校验。`
        : info.currentVersion
          ? "当前版本状态已读取。点击检查更新可同步中央授权中心。"
          : "正在读取云端更新状态。"
  );

  const progressPanel = $("#updateProgress");
  if (progressPanel) {
    const visible = Boolean(progress && progress.status && progress.status !== "idle");
    progressPanel.hidden = !visible;
    if (visible) {
      setText("#updateProgressTitle", progress.status === "completed" ? "下载完成" : progress.status === "failed" ? "下载失败" : "正在下载更新包");
      setText("#updateProgressMeta", progress.message || progress.filename || "");
      setText("#updateProgressPercent", `${Number(progress.percent || 0)}%`);
      $("#updateProgressBar").style.width = `${clamp(Number(progress.percent || 0), 0, 100)}%`;
    }
  }

  const list = $("#announcementList");
  if (list) {
    const announcements = Array.isArray(info.announcements) ? info.announcements : [];
    list.innerHTML = announcements.length
      ? announcements
          .map(
            (item) => `<article class="announcement-card ${escapeHtml(item.level || "info")}">
              <strong>${escapeHtml(item.title || "公告")}</strong>
              <span>${escapeHtml(formatLocalDateTime(item.startsAt || item.createdAt))}</span>
              <p>${escapeHtml(item.body || "")}</p>
            </article>`
          )
          .join("")
      : `<div class="announcement-empty">暂无公告。点击“检查更新”后同步读取。</div>`;
  }

  const checkButton = $("#checkUpdateBtn");
  const downloadButton = $("#downloadUpdateBtn");
  const applyButton = $("#applyUpdateBtn");
  if (checkButton) checkButton.disabled = updateLoading || !isAuthorized();
  if (downloadButton) downloadButton.disabled = updateLoading || !release?.id;
  if (applyButton) applyButton.disabled = updateLoading || !downloaded || !info.applyEnabled;
}

function hasAcceptedCurrentRisk() {
  return state.compliance?.riskAccepted === true && state.compliance?.riskVersion === DISCLAIMER_VERSION;
}

function formatLocalDateTime(value) {
  if (!value) return "尚未确认";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚未确认" : date.toLocaleString("zh-CN");
}

function ensureReviewState() {
  if (!state.review) state.review = normalizeReview({});
  return state.review;
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function datePlusDays(dateKey, days) {
  const date = dateFromKey(dateKey);
  if (!date) return "未知";
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function daysSince(dateKey) {
  const date = dateFromKey(dateKey);
  if (!date) return 0;
  const today = dateFromKey(localDateKey());
  return Math.floor((today - date) / 86400000);
}

function currentGoldCny() {
  const value = Number(state.settings.goldCnyPerGram);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function captureForecastSnapshot() {
  const review = ensureReviewState();
  const priceCny = currentGoldCny();
  const priceUsd = Number(state.settings.goldUsdPerOz);
  const { forecasts } = buildForecasts();
  const dateKey = localDateKey();
  const snapshot = {
    id: uid("forecast"),
    dateKey,
    capturedAt: new Date().toISOString(),
    priceCny,
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
    forecasts: forecasts.map((item) => ({
      key: item.key,
      label: item.label,
      direction: item.direction,
      className: item.className,
      score: item.score,
      confidence: item.confidence,
      expectedMove: item.expectedMove,
    })),
    evaluated: {},
  };
  const existingIndex = review.forecastLogs.findIndex((item) => item.dateKey === dateKey);
  if (existingIndex >= 0) {
    review.forecastLogs[existingIndex] = { ...snapshot, id: review.forecastLogs[existingIndex].id };
  } else {
    review.forecastLogs.unshift(snapshot);
  }
  review.forecastLogs = review.forecastLogs.slice(0, 90);
  saveState();
  renderReview();
  showToast(existingIndex >= 0 ? "今日预测已更新" : "今日预测已记录");
}

function evaluateForecastLogs() {
  const review = ensureReviewState();
  const price = currentGoldCny();
  if (!price) return 0;
  let updated = 0;
  review.forecastLogs.forEach((log) => {
    REVIEW_HORIZONS.forEach((horizon) => {
      if (log.evaluated?.[horizon.key]) return;
      if (daysSince(log.dateKey) < horizon.dueDays) return;
      const forecast = log.forecasts?.find((item) => item.key === horizon.key);
      if (!forecast || !Number.isFinite(log.priceCny)) return;
      const movePct = ((price - log.priceCny) / log.priceCny) * 100;
      const hit =
        forecast.className === "neutral"
          ? Math.abs(movePct) <= 0.6
          : forecast.className === "up"
            ? price >= log.priceCny
            : price <= log.priceCny;
      log.evaluated = {
        ...(log.evaluated || {}),
        [horizon.key]: {
          checkedAt: new Date().toISOString(),
          checkedPriceCny: price,
          movePct,
          hit,
        },
      };
      updated += 1;
    });
  });
  if (updated) saveState();
  renderReview();
  return updated;
}

function addPriceAlert(formData) {
  const review = ensureReviewState();
  const target = Number(formData.get("target"));
  if (!Number.isFinite(target) || target <= 0) {
    showToast("请输入有效的提醒价格");
    return;
  }
  review.priceAlerts.unshift({
    id: uid("alert"),
    operator: formData.get("operator") === "below" ? "below" : "above",
    target,
    note: String(formData.get("note") || "").trim(),
    createdAt: new Date().toISOString(),
    triggered: false,
    triggeredAt: null,
    triggeredPrice: null,
  });
  review.priceAlerts = review.priceAlerts.slice(0, 40);
  saveState();
  renderReview();
  showToast("价格提醒已添加");
}

function evaluatePriceAlerts() {
  const review = ensureReviewState();
  const price = currentGoldCny();
  if (!price) return [];
  const triggered = [];
  review.priceAlerts.forEach((alert) => {
    if (alert.triggered) return;
    const hit = alert.operator === "below" ? price <= Number(alert.target) : price >= Number(alert.target);
    if (!hit) return;
    alert.triggered = true;
    alert.triggeredAt = new Date().toISOString();
    alert.triggeredPrice = price;
    triggered.push(alert);
  });
  if (triggered.length) saveState();
  return triggered;
}

function addEventItem(formData) {
  const review = ensureReviewState();
  const date = String(formData.get("date") || "");
  const title = String(formData.get("title") || "").trim();
  if (!date || !title) {
    showToast("请填写事件日期和标题");
    return;
  }
  review.events.push({
    id: uid("event"),
    date,
    type: String(formData.get("type") || "其他"),
    title,
    impact: String(formData.get("impact") || "watch"),
    createdAt: new Date().toISOString(),
  });
  review.events = review.events.slice(-60);
  saveState();
  renderReview();
  showToast("高波动事件已添加");
}

function removeReviewItem(kind, id) {
  const review = ensureReviewState();
  if (kind === "alert") {
    review.priceAlerts = review.priceAlerts.filter((item) => item.id !== id);
  }
  if (kind === "event") {
    review.events = review.events.filter((item) => item.id !== id);
  }
  saveState();
  renderReview();
  showToast(kind === "alert" ? "提醒已删除" : "事件已删除");
}

function reviewStats(horizonKey) {
  const review = ensureReviewState();
  const results = review.forecastLogs
    .map((log) => log.evaluated?.[horizonKey])
    .filter(Boolean);
  const hits = results.filter((item) => item.hit).length;
  return {
    total: results.length,
    hits,
    rate: results.length ? `${Math.round((hits / results.length) * 100)}%` : "--",
  };
}

function renderReview() {
  const review = ensureReviewState();
  const d1 = reviewStats("d1");
  const w1 = reviewStats("w1");
  const activeAlerts = review.priceAlerts.filter((item) => !item.triggered).length;
  const last = review.forecastLogs[0];
  const alertTarget = $("#alertTarget");
  const eventDate = $("#eventDate");
  const price = currentGoldCny();
  if (alertTarget && price) alertTarget.placeholder = `当前约 ${formatNumber(price)} 元/克`;
  if (eventDate && !eventDate.value) eventDate.value = localDateKey();

  setText("#reviewTotalCount", review.forecastLogs.length);
  setText("#reviewD1HitRate", d1.rate);
  setText("#reviewW1HitRate", w1.rate);
  setText("#reviewD1Meta", d1.total ? `${d1.hits}/${d1.total} 命中` : "等待样本到期");
  setText("#reviewW1Meta", w1.total ? `${w1.hits}/${w1.total} 命中` : "等待样本到期");
  setText("#activeAlertCount", activeAlerts);
  setText("#reviewLastCapture", last ? `${last.dateKey} 已记录` : "尚未记录");

  const reviewList = $("#forecastReviewList");
  if (reviewList) {
    reviewList.innerHTML = review.forecastLogs.length
      ? review.forecastLogs.slice(0, 8).map(forecastLogItem).join("")
      : `<div class="empty-state">点击“记录今日判断”后，这里会显示每天的预测和后续核验结果。</div>`;
  }

  const alertList = $("#priceAlertList");
  if (alertList) {
    alertList.innerHTML = review.priceAlerts.length
      ? review.priceAlerts.slice(0, 10).map(priceAlertItem).join("")
      : `<div class="empty-state">添加一个关键价格后，同步行情时会自动检查是否触发。</div>`;
  }

  const eventList = $("#eventList");
  if (eventList) {
    const events = [...review.events].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    eventList.innerHTML = events.length
      ? events.slice(0, 12).map(eventListItem).join("")
      : `<div class="empty-state">可以把 CPI、非农、美联储议息、央行购金等日期加入这里。</div>`;
  }

  renderNewsMood();
}

function forecastLogItem(log) {
  const d1 = forecastResultText(log, "d1");
  const w1 = forecastResultText(log, "w1");
  const d1Forecast = log.forecasts?.find((item) => item.key === "d1");
  const w1Forecast = log.forecasts?.find((item) => item.key === "w1");
  return `<article class="review-item">
    <div class="review-item-top">
      <div>
        <strong>${escapeHtml(log.dateKey)}</strong>
        <span>${formatNumber(log.priceCny)} 元/克</span>
      </div>
      <span class="muted-pill">${formatLocalDateTime(log.capturedAt)}</span>
    </div>
    <div class="review-outcomes">
      ${reviewOutcome("1天", d1Forecast, d1)}
      ${reviewOutcome("1周", w1Forecast, w1)}
    </div>
  </article>`;
}

function forecastResultText(log, key) {
  const horizon = REVIEW_HORIZONS.find((item) => item.key === key);
  const result = log.evaluated?.[key];
  if (result) {
    return {
      label: result.hit ? "命中" : "未中",
      className: result.hit ? "hit" : "miss",
      detail: `${pct(result.movePct)} · ${formatNumber(result.checkedPriceCny)} 元/克`,
    };
  }
  return {
    label: "待核验",
    className: "pending",
    detail: `预计 ${datePlusDays(log.dateKey, horizon?.dueDays || 1)}`,
  };
}

function reviewOutcome(label, forecast, result) {
  const direction = forecast?.direction || "--";
  const className = forecast?.className || "";
  return `<div class="review-outcome ${result.className}">
    <span>${label}</span>
    <strong class="${directionPreviewClass(className)}">${direction}</strong>
    <small>${result.label} · ${result.detail}</small>
  </div>`;
}

function priceAlertItem(alert) {
  const operatorText = alert.operator === "below" ? "低于或等于" : "高于或等于";
  const status = alert.triggered ? `已触发 ${formatNumber(alert.triggeredPrice)} 元/克` : "监控中";
  return `<article class="review-item alert-item ${alert.triggered ? "triggered" : ""}">
    <div>
      <strong>金价${operatorText} ${formatNumber(alert.target)} 元/克</strong>
      <p>${escapeHtml(alert.note || "未填写备注")}</p>
      <span>${status}</span>
    </div>
    <button class="secondary-action small" type="button" data-remove-alert="${escapeHtml(alert.id)}">删除</button>
  </article>`;
}

function eventListItem(item) {
  const impact = eventImpactText(item.impact);
  return `<article class="review-item event-item">
    <div>
      <strong>${escapeHtml(item.date)} · ${escapeHtml(item.title)}</strong>
      <p>${escapeHtml(item.type)} · ${impact.label}</p>
    </div>
    <button class="secondary-action small" type="button" data-remove-event="${escapeHtml(item.id)}">删除</button>
  </article>`;
}

function eventImpactText(impact) {
  if (impact === "bullish") return { label: "偏利多" };
  if (impact === "bearish") return { label: "偏利空" };
  return { label: "观察" };
}

function newsSentiment(item) {
  const text = `${item?.title || ""} ${item?.summary || ""}`.toLowerCase();
  const bullishWords = [
    ["safe haven", 2],
    ["safe-haven", 2],
    ["geopolitical", 1.6],
    ["war", 1.7],
    ["risk", 1.1],
    ["inflation", 1.2],
    ["stagflation", 1.8],
    ["rate cut", 1.8],
    ["cuts rates", 1.8],
    ["dollar falls", 1.6],
    ["weaker dollar", 1.6],
    ["yields fall", 1.5],
    ["yields drop", 1.5],
    ["central bank buying", 2],
    ["etf inflow", 1.4],
    ["recession", 1.4],
    ["uncertainty", 1.2],
  ];
  const bearishWords = [
    ["rate hike", 1.8],
    ["higher rates", 1.7],
    ["hawkish", 1.5],
    ["stronger dollar", 1.7],
    ["dollar rises", 1.6],
    ["dollar rally", 1.6],
    ["yields rise", 1.5],
    ["yields climb", 1.5],
    ["risk-on", 1.1],
    ["outflow", 1.3],
    ["etf outflow", 1.6],
    ["selloff", 1.2],
    ["profit-taking", 1.2],
    ["gold falls", 1.5],
    ["gold slips", 1.3],
    ["truce", 1.1],
    ["ceasefire", 1.1],
  ];
  const bullishScore = bullishWords.reduce((sum, [word, weight]) => sum + (text.includes(word) ? weight : 0), 0);
  const bearishScore = bearishWords.reduce((sum, [word, weight]) => sum + (text.includes(word) ? weight : 0), 0);
  const score = bullishScore - bearishScore;
  if (score > 0.35) return { label: "利多", className: "bullish", score };
  if (score < -0.35) return { label: "利空", className: "bearish", score };
  return { label: "中性", className: "neutral", score: 0 };
}

function newsMoodStats() {
  const stats = { bullish: 0, bearish: 0, neutral: 0, score: 0 };
  state.professional.news.forEach((item) => {
    const sentiment = newsSentiment(item);
    stats[sentiment.className] += 1;
    stats.score += sentiment.score || 0;
  });
  const signal =
    stats.score > 0.6
      ? "新闻偏利多"
      : stats.score < -0.6
        ? "新闻偏利空"
        : state.professional.news.length
          ? "新闻中性"
          : "等待同步";
  return { ...stats, signal };
}

function renderNewsMood() {
  const stats = newsMoodStats();
  setText("#proMoodSignal", stats.signal);
  setText("#proMoodBullish", stats.bullish);
  setText("#proMoodBearish", stats.bearish);
  setText("#proMoodNeutral", stats.neutral);
  setText("#reviewMoodSignal", stats.signal);
  setText("#reviewMoodBullish", stats.bullish);
  setText("#reviewMoodBearish", stats.bearish);
  setText("#reviewMoodNeutral", stats.neutral);
}

function renderRisk() {
  const acceptedCurrent = hasAcceptedCurrentRisk();
  const acceptedAt = formatLocalDateTime(state.compliance?.riskAcceptedAt);
  const status = acceptedCurrent
    ? "已确认当前版本"
    : state.compliance?.riskAccepted
      ? "声明已更新，需重新确认"
      : "未确认";
  const shortStatus = acceptedCurrent ? "已确认" : "未确认";

  setText("#riskVersion", DISCLAIMER_VERSION);
  setText("#riskStatus", status);
  setText("#settingsRiskStatus", status);
  setText("#riskInlineStatus", shortStatus);
  setText("#proRiskInlineStatus", shortStatus);
  setText("#riskAcceptedAt", acceptedAt);
  setText("#settingsRiskAcceptedAt", acceptedAt);

  const label = acceptedCurrent ? "重新确认当前版本" : "我已阅读并理解";
  $("#riskAcceptBtn").textContent = label;
  $("#settingsRiskAcceptBtn").textContent = label;
}

function acceptRiskDisclaimer() {
  state.compliance = {
    riskAccepted: true,
    riskVersion: DISCLAIMER_VERSION,
    riskAcceptedAt: new Date().toISOString(),
  };
  saveState();
  renderRisk();
  showToast("风险声明已确认");
}

function renderAll() {
  applyPreferences();
  renderMarket();
  renderForecasts();
  renderReasons();
  renderProfessional();
  renderChart();
  renderControls();
  renderSettings();
  renderReview();
  renderRisk();
  updatePageTitle();
}

async function syncGold() {
  const button = $("#syncBtn");
  button.disabled = true;
  button.textContent = "同步中";
  try {
    const [goldResponse, proResponse] = await Promise.all([fetch("/api/gold"), fetch("/api/professional")]);
    const goldData = await goldResponse.json();
    const proData = await proResponse.json();
    if (goldData.code === "LICENSE_REQUIRED") {
      licenseStatus = goldData.license || licenseStatus;
      renderLicenseGate();
      renderSettings();
      throw new Error(goldData.error || "请先完成软件授权");
    }
    if (!goldResponse.ok) throw new Error(goldData.error || "行情同步失败");
    state.settings.goldCnyPerGram = goldData.goldCnyPerGram;
    state.settings.goldUsdPerOz = goldData.goldUsdPerOz;
    state.settings.usdCny = goldData.usdCny;
    state.settings.changePct = goldData.changePct;
    state.settings.source = goldData.source;
    state.settings.updatedAt = goldData.updatedAt;
    const incomingHistory = Array.isArray(goldData.history) ? goldData.history : [];
    const incomingHistoryCount = validHistoryCount(incomingHistory);
    const currentHistoryCount = validHistoryCount(state.history);
    if (incomingHistoryCount >= 10 || (incomingHistoryCount > 0 && currentHistoryCount === 0)) {
      state.history = incomingHistory;
    }
    if (proResponse.ok) {
      state.professional = {
        indicators: proData.indicators || [],
        news: proData.news || [],
        updatedAt: proData.updatedAt,
      };
    }
    const triggeredAlerts = evaluatePriceAlerts();
    const evaluatedForecasts = evaluateForecastLogs();
    saveState();
    renderAll();
    const extras = [
      triggeredAlerts.length ? `${triggeredAlerts.length} 个价格提醒已触发` : "",
      evaluatedForecasts ? `${evaluatedForecasts} 条复盘已核验` : "",
    ]
      .filter(Boolean)
      .join("，");
    showToast(
      `${proResponse.ok ? "行情与专业数据已同步" : "行情已同步，专业数据稍后再试"}${extras ? `，${extras}` : ""}`
    );
  } catch (error) {
    showToast(error.message || "同步失败");
  } finally {
    button.disabled = false;
    button.textContent = "同步行情";
  }
}

function switchView(view) {
  view = ["dashboard", "review", "settings", "risk"].includes(view) ? view : "dashboard";
  $$(".view-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $("#dashboardView").classList.toggle("active", view === "dashboard");
  $("#reviewView").classList.toggle("active", view === "review");
  $("#settingsView").classList.toggle("active", view === "settings");
  $("#riskView").classList.toggle("active", view === "risk");
  updatePageTitle(view);
}

function currentView() {
  if ($("#reviewView")?.classList.contains("active")) return "review";
  if ($("#settingsView")?.classList.contains("active")) return "settings";
  if ($("#riskView")?.classList.contains("active")) return "risk";
  return "dashboard";
}

function updatePageTitle(view = currentView()) {
  $("#pageTitle").textContent =
    view === "review"
      ? "复盘与提醒"
      : view === "settings"
        ? "设置你的工作台"
        : view === "risk"
          ? "风险与声明"
          : state.preferences.theme === "professional"
            ? "专业黄金研究台"
            : "先看结论，再看原因";
}

async function authorize(code) {
  const response = await fetch("/api/license/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey: code }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "授权失败");
  licenseStatus = data;
  licenseLoading = false;
  await renderAuthState({ refetch: false });
  showToast("授权成功");
}

async function refreshLicenseFromSettings() {
  const button = $("#refreshLicenseBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "验证中";
  }
  try {
    const response = await fetch("/api/license/refresh", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "在线验证失败");
    licenseStatus = data;
    licenseLoading = false;
    renderLicenseGate();
    renderSettings();
    showToast(data.message || "授权状态已更新");
  } catch (error) {
    await refreshLicenseStatus();
    renderLicenseGate();
    renderSettings();
    showToast(error.message || "在线验证失败");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "在线验证";
    }
  }
}

async function refreshUpdateStatus() {
  if (!isAuthorized()) {
    updateInfo = null;
    renderUpdatePanel();
    return;
  }
  try {
    const response = await fetch("/api/system/update/status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取更新状态失败");
    updateInfo = data;
  } catch (error) {
    updateInfo = {
      updateAvailable: false,
      currentVersion: "--",
      runtime: "server",
      applyEnabled: false,
      announcements: [],
      error: error.message || "读取更新状态失败",
    };
  } finally {
    renderUpdatePanel();
  }
}

async function checkUpdateFromSettings() {
  const button = $("#checkUpdateBtn");
  updateLoading = true;
  if (button) button.textContent = "检查中";
  renderUpdatePanel();
  try {
    const response = await fetch("/api/system/update/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: $("#updateChannel")?.value || "stable" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "检查更新失败");
    updateInfo = data;
    showToast(data.updateAvailable ? `发现 ${data.release?.version || "新"} 版本` : "当前已经是最新版本");
  } catch (error) {
    showToast(error.message || "检查更新失败");
  } finally {
    updateLoading = false;
    if (button) button.textContent = "检查更新";
    renderUpdatePanel();
  }
}

async function downloadUpdateFromSettings() {
  const releaseId = updateInfo?.release?.id;
  if (!releaseId) return;
  const button = $("#downloadUpdateBtn");
  updateLoading = true;
  if (button) button.textContent = "下载中";
  renderUpdatePanel();
  try {
    const response = await fetch("/api/system/update/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "下载更新失败");
    updateInfo = { ...data, release: updateInfo.release, announcements: updateInfo.announcements || data.announcements || [] };
    showToast("更新包已下载并通过签名校验");
  } catch (error) {
    await refreshUpdateStatus();
    showToast(error.message || "下载更新失败");
  } finally {
    updateLoading = false;
    if (button) button.textContent = "下载并校验";
    renderUpdatePanel();
  }
}

async function applyUpdateFromSettings() {
  if (!window.confirm("确认应用已下载的更新？服务器部署版会涉及服务文件替换和重启，建议先确认数据已备份。")) return;
  updateLoading = true;
  renderUpdatePanel();
  try {
    const response = await fetch("/api/system/update/apply", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "应用更新失败");
    showToast(data.message || "更新已应用");
  } catch (error) {
    showToast(error.message || "应用更新失败");
  } finally {
    updateLoading = false;
    await refreshUpdateStatus();
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setupEvents() {
  $("#authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#authMessage");
    message.textContent = "";
    try {
      await authorize($("#authCode").value);
      $("#authCode").value = "";
    } catch (error) {
      message.textContent = error.message || "授权失败";
    }
  });

  $("#syncBtn").addEventListener("click", syncGold);

  $$(".view-tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  $$("[data-view-link]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.viewLink));
  });

  $("#macroForm").addEventListener("input", (event) => {
    const target = event.target;
    if (!target.name) return;
    state.macro[target.name] = Number(target.value);
    saveState();
    renderAll();
  });

  $$(".theme-option").forEach((button) => {
    button.addEventListener("click", () => {
      state.preferences.theme = button.dataset.themeOption;
      saveState();
      renderAll();
      switchView($("#settingsView").classList.contains("active") ? "settings" : "dashboard");
      showToast(state.preferences.theme === "simple" ? "已切换为简易模式" : "已切换为专业模式");
    });
  });

  $("#upColor").addEventListener("input", (event) => {
    state.preferences.upColor = event.target.value;
    saveState();
    renderAll();
  });

  $("#downColor").addEventListener("input", (event) => {
    state.preferences.downColor = event.target.value;
    saveState();
    renderAll();
  });

  $("#resetColorBtn").addEventListener("click", () => {
    state.preferences.upColor = DEFAULT_UP_COLOR;
    state.preferences.downColor = DEFAULT_DOWN_COLOR;
    saveState();
    renderAll();
    showToast("涨跌颜色已恢复默认");
  });

  $("#riskAcceptBtn").addEventListener("click", acceptRiskDisclaimer);
  $("#settingsRiskAcceptBtn").addEventListener("click", acceptRiskDisclaimer);

  $("#captureForecastBtn").addEventListener("click", captureForecastSnapshot);
  $("#evaluateForecastBtn").addEventListener("click", () => {
    const updated = evaluateForecastLogs();
    showToast(updated ? `${updated} 条复盘已核验` : "暂无到期复盘可核验");
  });

  $("#alertForm").addEventListener("submit", (event) => {
    event.preventDefault();
    addPriceAlert(new FormData(event.currentTarget));
    event.currentTarget.reset();
  });

  $("#eventForm").addEventListener("submit", (event) => {
    event.preventDefault();
    addEventItem(new FormData(event.currentTarget));
    event.currentTarget.reset();
    $("#eventDate").value = localDateKey();
  });

  $("#reviewView").addEventListener("click", (event) => {
    const alertButton = event.target.closest("[data-remove-alert]");
    if (alertButton) {
      removeReviewItem("alert", alertButton.dataset.removeAlert);
      return;
    }
    const eventButton = event.target.closest("[data-remove-event]");
    if (eventButton) {
      removeReviewItem("event", eventButton.dataset.removeEvent);
    }
  });

  $("#refreshLicenseBtn").addEventListener("click", refreshLicenseFromSettings);
  $("#checkUpdateBtn").addEventListener("click", checkUpdateFromSettings);
  $("#downloadUpdateBtn").addEventListener("click", downloadUpdateFromSettings);
  $("#applyUpdateBtn").addEventListener("click", applyUpdateFromSettings);
  $("#updateChannel").addEventListener("change", () => {
    if (updateInfo) {
      updateInfo = { ...updateInfo, release: undefined, updateAvailable: false };
      renderUpdatePanel();
    }
  });
}

setupEvents();
void renderAuthState();

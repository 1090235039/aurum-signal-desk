const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");
const { TextDecoder, promisify } = require("util");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const execFileAsync = promisify(execFile);
const AUTH_CODE = process.env.GOLD_WORKBENCH_AUTH_CODE || process.env.AUTH_CODE || "";
const DEFAULT_LICENSE_SERVER_URL = "";
const LICENSE_REQUIRED = process.env.LICENSE_REQUIRED === "true";
const LICENSE_SERVER_URL = String(process.env.LICENSE_SERVER_URL || DEFAULT_LICENSE_SERVER_URL).replace(/\/+$/, "");
const PRODUCT_ID = String(process.env.PRODUCT_ID || "gold-trend-desk");
const APP_VERSION = String(process.env.APP_VERSION || readPackageVersion() || "1.0.0");
const UPDATE_APPLY_ENABLED = process.env.UPDATE_APPLY_ENABLED === "true";
const UPDATE_DOWNLOAD_MAX_BYTES = Math.max(10 * 1024 * 1024, Number(process.env.UPDATE_DOWNLOAD_MAX_BYTES || 512 * 1024 * 1024));
const LICENSE_PUBLIC_KEY_PATH = process.env.LICENSE_PUBLIC_KEY_PATH
  ? path.resolve(process.env.LICENSE_PUBLIC_KEY_PATH)
  : path.join(ROOT, "license-public.pem");
const LICENSE_DATA_DIR = process.env.LICENSE_DATA_DIR
  ? path.resolve(process.env.LICENSE_DATA_DIR)
  : path.join(ROOT, ".license-data");
const LICENSE_STATE_FILE = path.join(LICENSE_DATA_DIR, "license-state.json");
const UPDATE_STATE_FILE = path.join(LICENSE_DATA_DIR, "update-state.json");
const UPDATE_DIR = path.join(LICENSE_DATA_DIR, "updates");
const AUTH_BODY_LIMIT = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS = new Map();

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const STATIC_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const PUBLIC_STATIC_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".ico",
]);
const PRIVATE_STATIC_SEGMENTS = new Set([".git", ".license-data", "node_modules", "backups", "data"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const OZ_TO_GRAM = 31.1034768;

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        req.destroy();
        reject(new Error("请求内容过大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readPackageVersion() {
  try {
    const packageJson = readJsonFile(path.join(ROOT, "package.json"), {});
    return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version.trim() : "";
  } catch {
    return "";
  }
}

function secureLicenseStateFile() {
  try {
    fs.mkdirSync(LICENSE_DATA_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(LICENSE_DATA_DIR, 0o700);
    if (fs.existsSync(LICENSE_STATE_FILE)) fs.chmodSync(LICENSE_STATE_FILE, 0o600);
    if (fs.existsSync(UPDATE_STATE_FILE)) fs.chmodSync(UPDATE_STATE_FILE, 0o600);
    if (fs.existsSync(UPDATE_DIR)) fs.chmodSync(UPDATE_DIR, 0o700);
  } catch {
    // Best effort on Windows and restricted filesystems.
  }
}

function saveUpdateState(value) {
  writeJsonFile(UPDATE_STATE_FILE, value);
  secureLicenseStateFile();
}

function readUpdateState() {
  return readJsonFile(UPDATE_STATE_FILE, {});
}

function nowIso() {
  return new Date().toISOString();
}

function licensePublicKey() {
  const inline = String(process.env.LICENSE_PUBLIC_KEY || "").replace(/\\n/g, "\n").trim();
  if (inline) return inline;
  return fs.existsSync(LICENSE_PUBLIC_KEY_PATH) ? fs.readFileSync(LICENSE_PUBLIC_KEY_PATH, "utf8") : "";
}

function licenseLocalState() {
  const stored = readJsonFile(LICENSE_STATE_FILE, {});
  if (stored.installationId && stored.deviceSalt) {
    secureLicenseStateFile();
    return stored;
  }
  const created = {
    installationId: crypto.randomUUID(),
    deviceSalt: crypto.randomBytes(32).toString("hex"),
    highestObservedAt: nowIso(),
  };
  saveLicenseLocalState(created);
  return created;
}

function saveLicenseLocalState(state) {
  writeJsonFile(LICENSE_STATE_FILE, state);
  secureLicenseStateFile();
}

function deviceLabel() {
  return `${os.hostname()} - ${os.platform()} ${os.arch()}`.slice(0, 80);
}

function deviceHash(state) {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((item) => item.mac)
    .filter((value) => value && value !== "00:00:00:00:00:00")
    .sort()
    .join("|");
  return crypto
    .createHash("sha256")
    .update([state.deviceSalt, os.hostname(), os.platform(), os.arch(), macs].join("|"))
    .digest("hex");
}

function signedTokenParts(token, label = "签名载荷") {
  const raw = String(token || "");
  if (raw.length > 8192) throw new Error(`${label}过大。`);
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`${label}格式无效。`);
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    throw new Error(`${label}格式无效。`);
  }
  return parts;
}

function verifySignedPayload(token, label = "签名载荷") {
  const key = licensePublicKey();
  if (!key) throw new Error("客户实例没有配置中央授权公钥。");
  const [encodedPayload, encodedSignature] = signedTokenParts(token, label);
  const valid = crypto.verify(
    null,
    Buffer.from(encodedPayload),
    key,
    Buffer.from(encodedSignature, "base64url")
  );
  if (!valid) throw new Error(`${label}签名无效。`);
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
}

function verifyLease(token) {
  const payload = verifySignedPayload(token, "授权租约");
  if (payload.version !== 1) throw new Error("授权租约版本不受支持。");
  return payload;
}

function observeLicenseClock(state) {
  const timestamp = Date.now();
  const highest = state.highestObservedAt ? new Date(state.highestObservedAt).getTime() : 0;
  const rollback = highest > 0 && timestamp + 5 * 60 * 1000 < highest;
  if (timestamp > highest + 5 * 60 * 1000) {
    state.highestObservedAt = new Date(timestamp).toISOString();
    saveLicenseLocalState(state);
  }
  return rollback;
}

function getLicenseStatus() {
  const state = licenseLocalState();
  const installationId = state.installationId;
  const label = deviceLabel();
  const configured = Boolean(LICENSE_SERVER_URL && licensePublicKey());

  if (!LICENSE_REQUIRED) {
    return {
      required: false,
      configured,
      state: "development",
      usable: true,
      readOnly: false,
      message: "当前为开发模式，尚未强制商业授权。",
      centralUrl: LICENSE_SERVER_URL,
      installationId,
      deviceLabel: label,
      productId: PRODUCT_ID,
      features: [],
    };
  }

  if (!configured) {
    return {
      required: true,
      configured: false,
      state: "unconfigured",
      usable: false,
      readOnly: true,
      message: "商业授权参数未配置，请联系软件提供方。",
      centralUrl: LICENSE_SERVER_URL,
      installationId,
      deviceLabel: label,
      productId: PRODUCT_ID,
      features: [],
    };
  }

  if (!state.lease) {
    return {
      required: true,
      configured: true,
      state: state.blockedReason ? "invalid" : "unlicensed",
      usable: false,
      readOnly: true,
      message: state.blockedReason || "黄金走势工作台尚未激活。",
      centralUrl: LICENSE_SERVER_URL,
      installationId,
      deviceLabel: label,
      productId: PRODUCT_ID,
      features: [],
    };
  }

  try {
    const payload = verifyLease(state.lease);
    if (payload.installationId !== state.installationId || payload.deviceHash !== deviceHash(state)) {
      throw new Error("授权租约与当前设备不匹配。");
    }
    if (payload.productId && payload.productId !== PRODUCT_ID) {
      throw new Error("授权租约不属于当前产品。");
    }
    if (observeLicenseClock(state)) {
      return {
        required: true,
        configured: true,
        state: "clock_error",
        usable: false,
        readOnly: true,
        message: "检测到系统时间异常，请联网重新验证授权。",
        centralUrl: LICENSE_SERVER_URL,
        installationId,
        deviceLabel: label,
        productId: PRODUCT_ID,
        features: payload.features || [],
        customerName: payload.customerName,
        plan: payload.plan,
        maxUsers: payload.maxUsers,
        onlineExpiresAt: payload.onlineExpiresAt,
        offlineUntil: payload.offlineUntil,
        licenseExpiresAt: payload.licenseExpiresAt,
        lastOnlineCheck: state.lastOnlineCheck,
      };
    }

    const timestamp = Date.now();
    const base = {
      required: true,
      configured: true,
      centralUrl: LICENSE_SERVER_URL,
      installationId,
      deviceLabel: label,
      productId: PRODUCT_ID,
      features: payload.features || [],
      customerName: payload.customerName,
      plan: payload.plan,
      maxUsers: payload.maxUsers,
      onlineExpiresAt: payload.onlineExpiresAt,
      offlineUntil: payload.offlineUntil,
      licenseExpiresAt: payload.licenseExpiresAt,
      lastOnlineCheck: state.lastOnlineCheck,
    };
    if (timestamp < new Date(payload.onlineExpiresAt).getTime()) {
      return { ...base, state: "active", usable: true, readOnly: false, message: "许可证有效，中央租约已验证。" };
    }
    if (timestamp < new Date(payload.offlineUntil).getTime()) {
      return { ...base, state: "grace", usable: true, readOnly: false, message: "中央授权服务暂时不可用，当前处于离线宽限期。" };
    }
    return { ...base, state: "expired", usable: false, readOnly: true, message: "授权租约已过期，请联网续签或输入新的许可证。" };
  } catch (error) {
    return {
      required: true,
      configured: true,
      state: "invalid",
      usable: false,
      readOnly: true,
      message: error.message || "授权租约无效。",
      centralUrl: LICENSE_SERVER_URL,
      installationId,
      deviceLabel: label,
      productId: PRODUCT_ID,
      features: [],
    };
  }
}

class CentralLicenseError extends Error {}

async function centralLicenseRequest(pathname, body) {
  if (!LICENSE_SERVER_URL) throw new Error("中央授权服务器地址未配置。");
  const response = await fetch(`${LICENSE_SERVER_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let result = {};
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("中央授权服务器返回了无效内容。");
  }
  if (!response.ok) throw new CentralLicenseError(result.error || `中央授权请求失败：${response.status}`);
  return result;
}

function acceptLicenseLease(lease) {
  const state = licenseLocalState();
  const payload = verifyLease(lease);
  if (payload.installationId !== state.installationId || payload.deviceHash !== deviceHash(state)) {
    throw new Error("中央授权返回了不匹配的设备租约。");
  }
  if (payload.productId && payload.productId !== PRODUCT_ID) {
    throw new Error("中央授权返回了不属于当前产品的租约。");
  }
  state.lease = lease;
  state.lastOnlineCheck = nowIso();
  state.highestObservedAt = nowIso();
  state.lastError = "";
  state.blockedReason = "";
  saveLicenseLocalState(state);
  return getLicenseStatus();
}

async function activateLicense(licenseKey) {
  const state = licenseLocalState();
  const result = await centralLicenseRequest("/api/public/activate", {
    productId: PRODUCT_ID,
    licenseKey,
    installationId: state.installationId,
    deviceHash: deviceHash(state),
    label: deviceLabel(),
  });
  return acceptLicenseLease(String(result.lease || ""));
}

async function refreshLicense() {
  const state = licenseLocalState();
  if (!state.lease) throw new Error("当前实例还没有可续签的授权。");
  try {
    const result = await centralLicenseRequest("/api/public/refresh", { lease: state.lease });
    return acceptLicenseLease(String(result.lease || ""));
  } catch (error) {
    state.lastError = error.message || "续签失败";
    if (error instanceof CentralLicenseError) {
      state.lease = undefined;
      state.blockedReason = state.lastError;
    }
    saveLicenseLocalState(state);
    throw error;
  }
}

async function refreshLicenseQuietly() {
  if (!LICENSE_REQUIRED || !LICENSE_SERVER_URL || !licenseLocalState().lease) return;
  const status = getLicenseStatus();
  const due = !status.lastOnlineCheck || Date.now() - new Date(status.lastOnlineCheck).getTime() > 15 * 60 * 1000;
  if (!due) return;
  try {
    await refreshLicense();
  } catch {
    // Offline grace is evaluated from the existing signed lease.
  }
}

function activeLeaseForUpdate() {
  const state = licenseLocalState();
  if (!state.lease) throw new Error("当前实例还没有可用于更新校验的授权。");
  const status = getLicenseStatus();
  if (!status.required || status.usable) return state.lease;
  throw new Error(status.message || "当前授权不可用于检查更新。");
}

function normalizeUpdateChannel(value) {
  const channel = String(value || "stable").trim().toLowerCase();
  if (!["stable", "beta"].includes(channel)) throw new Error("升级通道只能是 stable 或 beta。");
  return channel;
}

function safeReleaseId(value) {
  const releaseId = String(value || "").trim();
  if (!/^[a-f0-9-]{36}$/i.test(releaseId)) throw new Error("更新版本编号无效。");
  return releaseId;
}

function safeReleaseFilename(value, fallback) {
  return path.basename(String(value || fallback)).replace(/[^\w\u4e00-\u9fff .()+-]/g, "_").slice(0, 160) || fallback;
}

function releaseFileExtension(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return ".tar.gz";
  if (lower.endsWith(".exe")) return ".exe";
  return ".tar.gz";
}

function releaseFilePath(releaseId, filename = "") {
  const root = path.resolve(UPDATE_DIR);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const resolved = path.resolve(root, `${safeReleaseId(releaseId)}${releaseFileExtension(filename)}`);
  if (resolved.startsWith(`${root}${path.sep}`)) return resolved;
  throw new Error("更新包保存路径无效。");
}

function sanitizeAnnouncement(item) {
  return {
    id: String(item?.id || "").slice(0, 80),
    title: String(item?.title || "公告").slice(0, 120),
    body: String(item?.body || "").slice(0, 1000),
    level: ["info", "success", "warning", "critical"].includes(item?.level) ? item.level : "info",
    startsAt: item?.startsAt || item?.createdAt || "",
    endsAt: item?.endsAt || "",
  };
}

function sanitizeRelease(release) {
  if (!release || !release.id) return undefined;
  return {
    id: String(release.id).slice(0, 80),
    productId: String(release.productId || PRODUCT_ID).slice(0, 80),
    version: String(release.version || "").slice(0, 40),
    channel: String(release.channel || "stable").slice(0, 20),
    packageType: String(release.packageType || "server-archive").slice(0, 40),
    notes: String(release.notes || "").slice(0, 1200),
    filename: String(release.filename || "").slice(0, 180),
    fileSize: Number(release.fileSize || 0),
    sha256: String(release.sha256 || "").slice(0, 128),
    signature: String(release.signature || "").slice(0, 8192),
    createdAt: release.createdAt || "",
  };
}

function publicDownloadedUpdate(downloaded) {
  if (!downloaded || typeof downloaded !== "object") return null;
  return {
    releaseId: String(downloaded.releaseId || ""),
    version: String(downloaded.version || ""),
    packageType: String(downloaded.packageType || ""),
    filename: String(downloaded.filename || ""),
    fileSize: Number(downloaded.fileSize || 0),
    sha256: String(downloaded.sha256 || ""),
    downloadedAt: downloaded.downloadedAt || "",
    appliedAt: downloaded.appliedAt || "",
  };
}

function getUpdateStatus() {
  const state = readUpdateState();
  return {
    updateAvailable: false,
    currentVersion: APP_VERSION,
    runtime: "server",
    applyEnabled: UPDATE_APPLY_ENABLED,
    downloaded: publicDownloadedUpdate(state.downloaded),
    downloadProgress: state.downloadProgress,
    announcements: [],
  };
}

async function checkForUpdate(channel = "stable") {
  const result = await centralLicenseRequest("/api/public/updates/latest", {
    productId: PRODUCT_ID,
    currentVersion: APP_VERSION,
    channel: normalizeUpdateChannel(channel),
    packageType: "server-archive",
    lease: activeLeaseForUpdate(),
  });
  return {
    ...getUpdateStatus(),
    updateAvailable: Boolean(result.updateAvailable),
    release: sanitizeRelease(result.release),
    announcements: Array.isArray(result.announcements) ? result.announcements.map(sanitizeAnnouncement).slice(0, 8) : [],
  };
}

async function downloadUpdate(releaseId) {
  const safeId = safeReleaseId(releaseId);
  const response = await fetch(`${LICENSE_SERVER_URL}/api/public/updates/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ releaseId: safeId, lease: activeLeaseForUpdate() }),
    signal: AbortSignal.timeout(180000),
  });
  const contentType = String(response.headers.get("content-type") || "");
  if (!response.ok || contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      // Keep the generic status error below.
    }
    throw new Error(payload.error || `更新包下载失败：${response.status}`);
  }
  const filename = safeReleaseFilename(
    response.headers.get("x-release-filename") ? decodeURIComponent(String(response.headers.get("x-release-filename"))) : "",
    `${safeId}.tar.gz`
  );
  const packageType = String(response.headers.get("x-release-package-type") || "server-archive");
  if (packageType !== "server-archive") throw new Error("当前是服务器部署版，只接受 server-archive 更新包。");
  const expectedSha = String(response.headers.get("x-release-sha256") || "").toLowerCase();
  const signature = String(response.headers.get("x-release-signature") || "");
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > UPDATE_DOWNLOAD_MAX_BYTES) throw new Error("更新包超过允许大小。");
  const signed = verifySignedPayload(signature, "更新包签名");
  if (signed.version !== 1 || signed.productId !== PRODUCT_ID || signed.releaseId !== safeId) {
    throw new Error("更新包签名与当前产品不匹配。");
  }
  if (signed.packageType && signed.packageType !== "server-archive") throw new Error("更新包类型签名不匹配。");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > UPDATE_DOWNLOAD_MAX_BYTES) throw new Error("更新包超过允许大小。");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!expectedSha || sha256 !== expectedSha || signed.sha256 !== sha256 || signed.fileSize !== bytes.length) {
    throw new Error("更新包 SHA256 或签名元数据校验失败。");
  }
  const file = releaseFilePath(safeId, filename);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const downloaded = {
    releaseId: safeId,
    version: String(signed.releaseVersion || ""),
    file,
    filename,
    packageType: "server-archive",
    sha256,
    downloadedAt: nowIso(),
  };
  saveUpdateState({
    downloaded,
    downloadProgress: {
      releaseId: safeId,
      filename,
      status: "completed",
      downloadedBytes: bytes.length,
      totalBytes: bytes.length,
      percent: 100,
      speedBytesPerSecond: 0,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      message: "更新包已下载并通过签名校验。",
    },
  });
  return { ...getUpdateStatus(), downloaded: publicDownloadedUpdate(downloaded), updateAvailable: true };
}

function applyDownloadedUpdate() {
  if (!UPDATE_APPLY_ENABLED) throw new Error("当前环境未开启 UPDATE_APPLY_ENABLED，只能下载并校验更新包。");
  throw new Error("服务器自动应用更新尚未在本版本启用，请先通过部署流程备份后手动上线。");
}

function licenseRequiredForApi(url) {
  if (!url.pathname.startsWith("/api/")) return false;
  return ![
    "/api/health",
    "/api/auth/status",
    "/api/auth/authorize",
    "/api/license/status",
    "/api/license/activate",
    "/api/license/refresh",
  ].includes(url.pathname);
}

function ensureLicensedForApi(res, url) {
  if (!licenseRequiredForApi(url)) return true;
  const status = getLicenseStatus();
  if (!status.required || status.usable) return true;
  sendJson(res, 402, { error: status.message, code: "LICENSE_REQUIRED", license: status });
  return false;
}

function isCodeValid(code) {
  const configuredCode = String(AUTH_CODE || "").trim();
  if (!configuredCode) return false;
  const input = Buffer.from(String(code || "").trim());
  const expected = Buffer.from(configuredCode);
  if (!input.length || input.length !== expected.length) return false;
  return crypto.timingSafeEqual(input, expected);
}

function clientAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);
  return String(req.headers["x-real-ip"] || forwarded || req.socket.remoteAddress || "unknown").slice(0, 80);
}

function consumeRateLimit(req, res, scope, maxAttempts = 8) {
  const now = Date.now();
  const key = `${scope}:${clientAddress(req)}`;
  const current = RATE_LIMITS.get(key);
  if (!current || current.resetAt <= now) {
    RATE_LIMITS.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  if (current.count > maxAttempts) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.writeHead(429, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfter),
    });
    res.end(JSON.stringify({ error: "请求过于频繁，请稍后再试。" }));
    return false;
  }
  return true;
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, value] of RATE_LIMITS.entries()) {
    if (value.resetAt <= now) RATE_LIMITS.delete(key);
  }
}

function sameOriginRequest(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host) return false;
  for (const header of ["origin", "referer"]) {
    const value = req.headers[header];
    if (!value) continue;
    try {
      return new URL(String(value)).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  return true;
}

function requireSameOriginPost(req, res) {
  if (sameOriginRequest(req)) return true;
  sendJson(res, 403, { error: "授权请求必须来自当前网站页面。" });
  return false;
}

async function readJsonBody(req, maxBytes = AUTH_BODY_LIMIT) {
  const body = await readBody(req, maxBytes);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("请求格式不是有效 JSON。");
    error.statusCode = 400;
    throw error;
  }
}

function normalizeLicenseKey(payload) {
  const licenseKey = String(payload.licenseKey || payload.code || "").trim();
  if (!licenseKey) {
    const error = new Error("请输入许可证密钥");
    error.statusCode = 400;
    throw error;
  }
  if (licenseKey.length < 6 || licenseKey.length > 512 || /\s/.test(licenseKey) || /[\x00-\x1f\x7f]/.test(licenseKey)) {
    const error = new Error("许可证密钥格式不正确");
    error.statusCode = 400;
    throw error;
  }
  return licenseKey;
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${body.slice(0, 120)}`);
    }
    return response.json();
  } catch (error) {
    if (url.includes("query1.finance.yahoo.com") && process.platform === "win32") {
      return fetchJsonViaPowerShell(url);
    }
    throw error;
  }
}

async function fetchJsonViaPowerShell(url) {
  const safeUrl = url.replace(/'/g, "''");
  const command = `$ProgressPreference='SilentlyContinue'; Invoke-RestMethod -Uri '${safeUrl}' -TimeoutSec 25 | ConvertTo-Json -Depth 40 -Compress`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
  );
  return JSON.parse(stdout.trim());
}

async function fetchText(url, encoding = "utf-8") {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      Accept: "text/plain,*/*",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${body.slice(0, 120)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return new TextDecoder(encoding).decode(bytes);
}

function latestNumber(values = []) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = Number(values[i]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function normalizeYahooChart(data, symbol) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`没有拿到 ${symbol} 的 Yahoo 行情`);
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const closeSeries = result.indicators?.adjclose?.[0]?.adjclose || quote.close || [];
  const price = Number(meta.regularMarketPrice) || latestNumber(closeSeries);
  const previousClose = Number(meta.chartPreviousClose) || latestNumber(closeSeries.slice(0, -1));
  if (!Number.isFinite(price) || price <= 0) throw new Error(`没有拿到 ${symbol} 的有效价格`);
  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || "",
    price,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    change: Number.isFinite(previousClose) ? price - previousClose : null,
    changePct:
      Number.isFinite(previousClose) && previousClose > 0
        ? ((price - previousClose) / previousClose) * 100
        : null,
    timestamp: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
    source: "Yahoo Finance",
  };
}

async function getYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d`;
  return normalizeYahooChart(await fetchJson(url), symbol);
}

function parseCsvObservations(csv) {
  return String(csv || "")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [date, rawValue] = line.split(",");
      const value = Number(rawValue);
      return {
        date,
        value: Number.isFinite(value) && value > 0 ? value : null,
      };
    })
    .filter((item) => item.date);
}

function latestTwoObservations(rows) {
  const valid = rows.filter((item) => Number.isFinite(item.value) && item.value > 0);
  if (!valid.length) throw new Error("公开数据源没有返回有效观测值");
  return {
    latest: valid.at(-1),
    previous: valid.length > 1 ? valid.at(-2) : null,
  };
}

async function fetchFredCsv(url) {
  const response = await fetch(url, {
    headers: { Accept: "text/csv,*/*" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`FRED HTTP ${response.status} ${body.slice(0, 120)}`);
  }
  return response.text();
}

async function getFredQuote(seriesId, symbol, name, impact) {
  const start = new Date(Date.now() - 370 * 86400000).toISOString().slice(0, 10);
  const csv = await fetchFredCsv(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}&cosd=${start}`
  );
  const { latest, previous } = latestTwoObservations(parseCsvObservations(csv));
  const previousClose = previous?.value || null;
  return {
    symbol,
    name,
    currency: "",
    price: latest.value,
    previousClose,
    change: previousClose ? latest.value - previousClose : null,
    changePct: previousClose ? ((latest.value - previousClose) / previousClose) * 100 : 0,
    timestamp: new Date(`${latest.date}T00:00:00Z`).getTime(),
    source: `FRED ${seriesId}`,
    fallback: true,
    impact,
  };
}

async function getGoldProxyQuote(symbol, name, scale, impact) {
  const quote = await getGoldApiQuote();
  return {
    symbol,
    name,
    currency: "USD",
    price: quote.price * scale,
    previousClose: null,
    change: null,
    changePct: 0,
    timestamp: quote.timestamp,
    source: "Gold API proxy",
    fallback: true,
    proxy: true,
    impact,
  };
}

async function getProfessionalQuote(config) {
  try {
    return await getYahooQuote(config.symbol);
  } catch (primaryError) {
    try {
      if (config.key === "dxy") {
        return await getFredQuote(
          "DTWEXBGS",
          "DTWEXBGS",
          "美元广义指数代理",
          "Yahoo DXY 被阻断时，使用 FRED 广义美元指数作为美元强弱代理。"
        );
      }
      if (config.key === "us10y") {
        return await getFredQuote(
          "DGS10",
          "DGS10",
          "美国10年期国债收益率",
          "Yahoo 收益率被阻断时，使用 FRED 10年期美国国债收益率。"
        );
      }
      if (config.key === "vix") {
        return await getFredQuote(
          "VIXCLS",
          "VIXCLS",
          "VIX 波动率",
          "Yahoo VIX 被阻断时，使用 FRED CBOE VIX 收盘序列。"
        );
      }
      if (config.key === "gld") {
        return await getGoldProxyQuote(
          "XAU-GLD-PROXY",
          "GLD 黄金ETF代理",
          0.0917,
          "Yahoo GLD 被阻断时，按黄金现货价格折算为 GLD 近似代理值，仅用于方向研究。"
        );
      }
      if (config.key === "gdx") {
        return await getGoldProxyQuote(
          "XAU-GDX-PROXY",
          "GDX 金矿股ETF代理",
          0.02,
          "Yahoo GDX 被阻断时，按黄金现货价格折算为矿股敏感度代理值，仅用于方向研究。"
        );
      }
    } catch (fallbackError) {
      throw new Error(`${primaryError.message || "Yahoo 同步失败"}；兜底源也失败：${fallbackError.message}`);
    }
    throw primaryError;
  }
}

async function getYahooHistory(symbol, range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${encodeURIComponent(range)}&interval=1d`;
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`没有拿到 ${symbol} 的历史行情`);
  const quote = result.indicators?.quote?.[0] || {};
  const closes = result.indicators?.adjclose?.[0]?.adjclose || quote.close || [];
  const timestamps = result.timestamp || [];
  const points = closes
    .map((close, index) => ({
      date: timestamps[index] ? new Date(timestamps[index] * 1000).toISOString().slice(0, 10) : "",
      close: Number(close),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      open: Number(quote.open?.[index]),
    }))
    .filter((item) => Number.isFinite(item.close) && item.close > 0);
  if (points.length < 10) throw new Error(`${symbol} 历史行情太少`);
  return {
    symbol,
    currency: result.meta?.currency || "",
    points,
    source: "Yahoo Finance",
    updatedAt: new Date().toISOString(),
  };
}

async function getGold() {
  const [goldQuote, usdCnyQuote, history] = await Promise.all([
    getYahooQuote("GC=F").catch(getGoldApiQuote),
    getYahooQuote("USDCNY=X").catch(getUsdCnyQuote),
    getYahooHistory("GC=F", "1y").catch(() => ({ points: [] })),
  ]);
  const goldUsdPerOz = goldQuote.price;
  const usdCny = usdCnyQuote.price;
  const goldCnyPerGram = (goldUsdPerOz * usdCny) / OZ_TO_GRAM;
  const previousGoldCnyPerGram =
    goldQuote.previousClose && usdCnyQuote.previousClose
      ? (goldQuote.previousClose * usdCnyQuote.previousClose) / OZ_TO_GRAM
      : null;
  return {
    goldUsdPerOz,
    usdCny,
    goldCnyPerGram,
    previousGoldCnyPerGram,
    changePct:
      previousGoldCnyPerGram && previousGoldCnyPerGram > 0
        ? ((goldCnyPerGram - previousGoldCnyPerGram) / previousGoldCnyPerGram) * 100
        : goldQuote.changePct,
    source: `${goldQuote.source} + ${usdCnyQuote.source}`,
    updatedAt: new Date().toISOString(),
    history: history.points,
  };
}

async function getProfessionalData() {
  const quoteConfigs = [
    {
      key: "dxy",
      label: "美元指数 DXY",
      symbol: "DX-Y.NYB",
      impact: "美元走弱通常利多黄金，美元走强通常压制黄金。",
    },
    {
      key: "us10y",
      label: "美国10年期收益率",
      symbol: "^TNX",
      impact: "长端利率回落通常降低黄金持有成本。",
    },
    {
      key: "gld",
      label: "GLD 黄金ETF",
      symbol: "GLD",
      impact: "黄金ETF走强代表资金愿意配置黄金风险敞口。",
    },
    {
      key: "gdx",
      label: "GDX 金矿股ETF",
      symbol: "GDX",
      impact: "金矿股相对黄金更敏感，可观察风险偏好和杠杆弹性。",
    },
    {
      key: "vix",
      label: "VIX 波动率",
      symbol: "^VIX",
      impact: "波动率上升时，黄金可能获得避险需求支撑。",
    },
  ];

  const settledQuotes = await Promise.allSettled(
    quoteConfigs.map(async (config) => ({
      ...config,
      quote: await getProfessionalQuote(config),
    }))
  );

  const indicators = settledQuotes.map((result, index) => {
    const config = quoteConfigs[index];
    if (result.status !== "fulfilled") {
      return {
        ...config,
        available: false,
        error: result.reason?.message || "暂无数据",
      };
    }
    return {
      ...config,
      available: true,
      ...result.value.quote,
      impact: result.value.quote.impact || config.impact,
    };
  });

  const news = await getGoldNews().catch((error) => [
    {
      title: "专业新闻暂时无法同步",
      link: "",
      source: "系统",
      publishedAt: new Date().toISOString(),
      summary: error.message || "新闻源临时不可用",
    },
  ]);

  return {
    updatedAt: new Date().toISOString(),
    indicators,
    news,
  };
}

async function getGoldNews() {
  const xml = await fetchText(
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F,GLD,GDX&region=US&lang=en-US",
    "utf-8"
  );
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8);
  const parsed = items.map((match) => {
    const item = match[1];
    return {
      title: decodeXml(readXmlTag(item, "title")),
      link: decodeXml(readXmlTag(item, "link")),
      source: "Yahoo Finance",
      publishedAt: decodeXml(readXmlTag(item, "pubDate")),
      summary: stripHtml(decodeXml(readXmlTag(item, "description"))).slice(0, 220),
    };
  });
  const filtered = parsed.filter(isGoldRelatedNews);
  return (filtered.length ? filtered : parsed).slice(0, 8);
}

function isGoldRelatedNews(item) {
  const text = `${item?.title || ""} ${item?.summary || ""}`.toLowerCase();
  const marketTerms = [
    "gold price",
    "gold etf",
    "gold miner",
    "gold miners",
    "bullion",
    "precious metal",
    "xau",
    "gld",
    "gdx",
    "newmont",
    "barrick",
    "b2gold",
    "silver",
    "copper",
    "mining",
    "drilling",
    "fed",
    "federal reserve",
    "treasury",
    "yield",
    "dollar",
    "inflation",
    "cpi",
  ];
  const offTopicPhrases = [
    "gold rush",
    "social security",
    "ponzi",
    "snowmobile",
    "ad spending",
    "llms",
    "ai to a",
  ];
  if (offTopicPhrases.some((phrase) => text.includes(phrase)) && !marketTerms.some((keyword) => text.includes(keyword))) {
    return false;
  }
  const keywords = [
    "gold",
    "bullion",
    "precious metal",
    "xau",
    "gld",
    "gdx",
    "miner",
    "mining",
    "fed",
    "federal reserve",
    "rate",
    "yield",
    "treasury",
    "dollar",
    "inflation",
    "cpi",
    "central bank",
    "safe haven",
    "safe-haven",
    "geopolitical",
    "war",
    "vix",
  ];
  return keywords.some((keyword) => text.includes(keyword));
}

function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function getGoldApiQuote() {
  const data = await fetchJson("https://api.gold-api.com/price/XAU");
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Gold API 没有返回有效金价");
  return {
    symbol: "XAU",
    name: "Gold",
    currency: "USD",
    price,
    previousClose: null,
    change: null,
    changePct: null,
    timestamp: data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now(),
    source: "Gold API",
  };
}

async function getUsdCnyQuote() {
  const data = await fetchJson("https://api.frankfurter.app/latest?from=USD&to=CNY");
  const price = Number(data?.rates?.CNY);
  if (!Number.isFinite(price) || price <= 0) throw new Error("汇率接口没有返回有效 USD/CNY");
  return {
    symbol: "USDCNY",
    name: "USD/CNY",
    currency: "CNY",
    price,
    previousClose: null,
    change: null,
    changePct: null,
    timestamp: Date.now(),
    source: "Frankfurter",
  };
}

function eastmoneySecid(symbol) {
  const raw = String(symbol || "").trim().toLowerCase();
  const digits = raw.replace(/^(sh|sz|bj)/, "");
  if (!/^\d{6}$/.test(digits)) throw new Error("A 股代码需要是 6 位数字，例如 600547");
  if (raw.startsWith("sh") || digits.startsWith("6") || digits.startsWith("9")) return `1.${digits}`;
  if (raw.startsWith("bj") || digits.startsWith("8") || digits.startsWith("4")) return `0.${digits}`;
  return `0.${digits}`;
}

async function getCnStockQuote(symbol) {
  const secid = eastmoneySecid(symbol);
  const url =
    "https://push2.eastmoney.com/api/qt/stock/get?fields=f43,f58,f169,f170,f46,f44,f45,f47,f60,f86&secid=" +
    encodeURIComponent(secid);
  const data = await fetchJson(url);
  if (data.rc !== 0 || !data.data) throw new Error(`没有拿到 ${symbol} 的 A 股行情`);
  const item = data.data;
  const price = Number(item.f43) / 100;
  const previousClose = Number(item.f60) / 100;
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${symbol} 当前价格无效`);
  return {
    symbol,
    name: item.f58 || symbol,
    currency: "CNY",
    price,
    previousClose,
    change: Number(item.f169) / 100,
    changePct: Number(item.f170) / 100,
    timestamp: item.f86 ? Number(item.f86) * 1000 : Date.now(),
    source: "东方财富",
  };
}

async function getCnFundQuote(symbol) {
  const code = String(symbol || "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("基金代码需要是 6 位数字，例如 000216");
  const text = await fetchText(`https://fundgz.1234567.com.cn/js/${code}.js`, "utf-8");
  const match = text.match(/jsonpgz\((.*)\);?/);
  if (!match) throw new Error(`没有拿到 ${code} 的基金估值`);
  const data = JSON.parse(match[1]);
  const estimated = Number(data.gsz);
  const nav = Number(data.dwjz);
  const price = Number.isFinite(estimated) && estimated > 0 ? estimated : nav;
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${code} 当前价格无效`);
  return {
    symbol: data.fundcode || code,
    name: data.name || code,
    currency: "CNY",
    price,
    previousClose: nav || null,
    change: nav ? price - nav : null,
    changePct: Number(data.gszzl),
    timestamp: data.gztime ? new Date(data.gztime.replace(/-/g, "/")).getTime() : Date.now(),
    source: "天天基金估值",
    navDate: data.jzrq || "",
  };
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, now: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/api/auth/status") {
      sendJson(res, 200, { enabled: true, mode: "license", license: getLicenseStatus() });
      return;
    }
    if (url.pathname === "/api/license/status") {
      sendJson(res, 200, getLicenseStatus());
      return;
    }
    if (url.pathname === "/api/license/activate") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "只支持 POST 激活请求" });
        return;
      }
      if (!requireSameOriginPost(req, res)) return;
      if (!consumeRateLimit(req, res, "license-activate", 8)) return;
      const payload = await readJsonBody(req);
      if (!LICENSE_REQUIRED) {
        sendJson(res, 200, getLicenseStatus());
        return;
      }
      const licenseKey = normalizeLicenseKey(payload);
      try {
        sendJson(res, 200, await activateLicense(licenseKey));
      } catch (error) {
        sendJson(res, 400, { error: error.message || "授权激活失败。" });
      }
      return;
    }
    if (url.pathname === "/api/license/refresh") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "只支持 POST 授权验证请求" });
        return;
      }
      if (!requireSameOriginPost(req, res)) return;
      if (!consumeRateLimit(req, res, "license-refresh", 24)) return;
      if (!LICENSE_REQUIRED) {
        sendJson(res, 200, getLicenseStatus());
        return;
      }
      try {
        sendJson(res, 200, await refreshLicense());
      } catch (error) {
        sendJson(res, 400, { error: error.message || "授权刷新失败。" });
      }
      return;
    }
    if (url.pathname === "/api/auth/authorize") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "只支持 POST 授权请求" });
        return;
      }
      if (!requireSameOriginPost(req, res)) return;
      if (!consumeRateLimit(req, res, "auth-authorize", 8)) return;
      const payload = await readJsonBody(req);
      if (LICENSE_REQUIRED) {
        const licenseKey = normalizeLicenseKey(payload);
        try {
          sendJson(res, 200, { ok: true, license: await activateLicense(licenseKey) });
        } catch (error) {
          sendJson(res, 400, { error: error.message || "授权激活失败。" });
        }
        return;
      }
      if (isCodeValid(payload.code)) {
        sendJson(res, 200, { ok: true, license: getLicenseStatus() });
      } else {
        sendJson(res, 401, { error: "授权码不正确" });
      }
      return;
    }
    if (url.pathname === "/api/gold") {
      if (!ensureLicensedForApi(res, url)) return;
      sendJson(res, 200, await getGold());
      return;
    }
    if (url.pathname === "/api/professional") {
      if (!ensureLicensedForApi(res, url)) return;
      sendJson(res, 200, await getProfessionalData());
      return;
    }
    if (url.pathname === "/api/system/update/status") {
      if (!ensureLicensedForApi(res, url)) return;
      sendJson(res, 200, getUpdateStatus());
      return;
    }
    if (url.pathname === "/api/system/update/check") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "只支持 POST 检查更新请求" });
        return;
      }
      if (!ensureLicensedForApi(res, url)) return;
      if (!requireSameOriginPost(req, res)) return;
      if (!consumeRateLimit(req, res, "update-check", 20)) return;
      const payload = await readJsonBody(req, AUTH_BODY_LIMIT);
      sendJson(res, 200, await checkForUpdate(payload.channel));
      return;
    }
    if (url.pathname === "/api/system/update/download") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "只支持 POST 下载更新请求" });
        return;
      }
      if (!ensureLicensedForApi(res, url)) return;
      if (!requireSameOriginPost(req, res)) return;
      if (!consumeRateLimit(req, res, "update-download", 6)) return;
      const payload = await readJsonBody(req, AUTH_BODY_LIMIT);
      sendJson(res, 200, await downloadUpdate(payload.releaseId));
      return;
    }
    if (url.pathname === "/api/system/update/apply") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "只支持 POST 应用更新请求" });
        return;
      }
      if (!ensureLicensedForApi(res, url)) return;
      if (!requireSameOriginPost(req, res)) return;
      if (!consumeRateLimit(req, res, "update-apply", 6)) return;
      sendJson(res, 200, applyDownloadedUpdate());
      return;
    }
    if (url.pathname === "/api/quote") {
      if (!ensureLicensedForApi(res, url)) return;
      const type = (url.searchParams.get("type") || "yahoo").toLowerCase();
      const symbol = url.searchParams.get("symbol") || "";
      if (!symbol.trim()) throw new Error("缺少代码");
      if (type === "cnstock") {
        sendJson(res, 200, await getCnStockQuote(symbol));
        return;
      }
      if (type === "cnfund") {
        sendJson(res, 200, await getCnFundQuote(symbol));
        return;
      }
      sendJson(res, 200, await getYahooQuote(symbol));
      return;
    }
    sendJson(res, 404, { error: "未知接口" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || String(error) });
  }
}

function serveStatic(req, res, url) {
  let requested = "";
  try {
    requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  const segments = requested
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  const extension = path.extname(segments.at(-1) || "").toLowerCase();
  const blockedSegment = segments.some((segment) => segment.startsWith(".") || PRIVATE_STATIC_SEGMENTS.has(segment));
  if (blockedSegment || !PUBLIC_STATIC_EXTENSIONS.has(extension)) {
    sendText(res, 404, "Not found");
    return;
  }
  const fullPath = path.resolve(ROOT, "." + requested);
  const relative = path.relative(ROOT, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(fullPath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const type = MIME_TYPES[path.extname(fullPath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      ...STATIC_SECURITY_HEADERS,
      "Content-Type": type,
      "Cache-Control": type.startsWith("text/html") ? "no-store" : "public, max-age=300",
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

void refreshLicenseQuietly();
const licenseRefreshTimer = setInterval(() => {
  void refreshLicenseQuietly();
}, 15 * 60 * 1000);
licenseRefreshTimer.unref?.();
const rateLimitCleanupTimer = setInterval(cleanupRateLimits, 15 * 60 * 1000);
rateLimitCleanupTimer.unref?.();

server.listen(PORT, () => {
  console.log(`黄金工作台已启动: http://localhost:${PORT}`);
});

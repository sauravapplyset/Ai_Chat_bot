// middleware/security.js
// Bot / scanner protection. Runs before every other middleware so junk
// requests never reach the logger, body parser or DB.
//
// Layers (checked in memory only; the DB is never queried per request):
//   1. Hard block list + permanent IP bans + temporary /24 subnet bans
//   2. Scanner paths and scanner tool user-agents -> reject + strike
//   3. Only "/" and "/api/..." are routed further
//   4. App-only: /api requests without the app signature must come from a native
//      app HTTP client, not a browser / curl / Postman / script
//   5. Per-IP request rate limit
//   6. Behaviour: too many 401/403/404/409 responses from one IP -> ban
//
// IP bans are permanent: stored in the security_bans table, loaded into memory at
// startup and refreshed every few minutes, so they survive restarts and deploys and
// are shared by every Cloud Run instance. Genuine app requests (valid signature)
// still pass a banned IP, because real users can share an IP with an attacker.
//
// Every rejection looks exactly like the normal "Route Not Found" 404, so a
// banned client cannot tell it is banned.

const CryptoJS = require("crypto-js");
const SecurityBan = require("../model/securityBan.model");
const { sendError } = require("../helper/statusCodes");

const toInt = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Permanently blocked IPs (add more via BLOCKED_IPS="1.2.3.4,5.6.7.8")
const BLOCKED_IPS = new Set(
  ["20.196.208.116", ...(process.env.BLOCKED_IPS || "").split(",")]
    .map((ip) => ip.trim())
    .filter(Boolean)
);

// Never blocked or banned, e.g. developer / office IPs (ALLOWED_IPS="1.2.3.4,2a09:...")
const ALLOWED_IPS = new Set(
  (process.env.ALLOWED_IPS || "").split(",").map((ip) => ip.trim().toLowerCase()).filter(Boolean)
);

const SCAN_STRIKE_LIMIT = toInt(process.env.SCAN_STRIKE_LIMIT, 3);       // scanner hits before ban
const ERROR_STRIKE_LIMIT = toInt(process.env.ERROR_STRIKE_LIMIT, 30);    // 401/403/404/409 before ban
const STRIKE_WINDOW_MS = toInt(process.env.SCAN_STRIKE_WINDOW_MIN, 10) * MIN;
// Permanent unless SCAN_BAN_HOURS is set
const BAN_MS = process.env.SCAN_BAN_HOURS ? toInt(process.env.SCAN_BAN_HOURS, 36) * HOUR : Infinity;
const BAN_LABEL = BAN_MS === Infinity ? "permanently" : `for ${BAN_MS / HOUR}h`;
const MAX_BANS = toInt(process.env.SECURITY_MAX_BANS, 200000);
// Paid AI calls per device per minute; a person cannot type faster than this, a script can
const AI_RATE_LIMIT = toInt(process.env.AI_RATE_PER_MIN, 20);
const AI_PATH = /^\/api\/(conversation\/|assi\/runassi|thirdparty\/|plan\/subscribe)/i;
// APP_ONLY=0 switches off the app-only gate without a code change
const APP_ONLY = process.env.APP_ONLY !== "0";
const SUBNET_BAN_IPS = toInt(process.env.SUBNET_BAN_IPS, 3);             // banned IPs in one /24 before the /24 is banned
// Shorter than BAN_MS: a /24 can also hold real users (shared mobile IPs)
const SUBNET_BAN_MS = toInt(process.env.SUBNET_BAN_HOURS, 6) * HOUR;
const RATE_LIMIT = toInt(process.env.RATE_LIMIT_PER_MIN, 300);           // requests per IP per minute
const RATE_WINDOW_MS = MIN;
// Upper bound per tracking table so an attack from millions of IPs cannot exhaust memory
const MAX_TRACKED = toInt(process.env.SECURITY_MAX_TRACKED, 50000);
const MAX_LOGS_PER_MIN = 20;
// Only enable when the domain is proxied through Cloudflare
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === "1";

// Paths only vulnerability scanners ask for (this API has no PHP / WordPress / dotfiles)
const SCANNER_PATTERN = new RegExp(
  [
    "\\.(php\\d?|phtml|asp|aspx|jsp|cgi|pl|env|git|svn|sql|bak|old|orig|swp|ini|conf|cfg|log|zip|tar|gz|tgz|rar|7z|yml|yaml|sh|exe|dll)(?:$|[/?#])",
    "(?:^|/)(wp-|wordpress|cgi-bin|phpmyadmin|pma|myadmin|xmlrpc|\\.well-known/(?!acme)|\\.aws|\\.ssh|\\.docker|\\.vscode|vendor/|actuator|boaform|hnap1|autodiscover|owa/|ecp/|solr|druid|server-status|telescope|_ignition|containers/json|setup\\.cgi|shell|backup|config\\.json)",
    "\\.\\.(?:/|\\\\|%2f|%5c)|%2e%2e|%00|<script|%3cscript|union(?:\\s|%20|\\+)+select",
  ].join("|"),
  "i"
);

// Attack / recon tools. Real app traffic comes from okhttp, Dart, CFNetwork etc.
const SCANNER_UA = /(sqlmap|nikto|nmap|masscan|zgrab|zmap|nuclei|wpscan|dirbuster|gobuster|ffuf|feroxbuster|wfuzz|acunetix|nessus|openvas|netsparker|qualys|whatweb|l9explore|l9tcpid|censys|expanse|odin\.io|internet-measurement|python-requests|python-urllib|aiohttp|go-http-client|libwww-perl|java\/1\.|fasthttp)/i;

// Clients that are never the app: browsers, bots, and manual / scripted HTTP tools.
// The app talks through a native HTTP client (okhttp on Android, Dart, CFNetwork /
// Alamofire on iOS), none of which send these.
const NON_APP_UA = /(mozilla|curl|wget|postman|insomnia|httpie|thunder client|python|go-http|java\/|node-fetch|undici|axios|ruby|perl|php|powershell|winhttp|libcurl|bot|spider|crawl|slurp|scan)/i;
const looksLikeApp = (ua) => !!ua && !NON_APP_UA.test(ua);

// Google load balancer / health-check ranges. If one of these shows up as the
// client IP, TRUST_PROXY_HOPS is wrong; never ban it or every user gets blocked.
const isGoogleProxy = (ip) => /^(35\.191\.|130\.211\.[0-3]\.)/.test(ip || "");

// Shared egress ranges (Cloudflare WARP / 1.1.1.1 app): thousands of unrelated users
// sit behind the same /24 or /64, so only the exact address may ever be banned
const isSharedEgress = (ip) => /^(104\.28\.|2a09:bac[0-7]:|2606:4700:)/i.test(ip || "");

// IPv6 clients own whole /64 blocks, so track them per /64 instead of per address
const keyOf = (ip) => {
  if (!ip.includes(":") || isSharedEgress(ip)) return ip.toLowerCase();
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${full.slice(0, 4).join(":")}::/64`;
};

const subnetOf = (ip) =>
  /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !isSharedEgress(ip) ? ip.split(".").slice(0, 3).join(".") : null;

const scanStrikes = new Map();  // key -> { count, first }
const errorStrikes = new Map(); // key -> { count, first }
const bans = new Map();         // key -> bannedUntil
const subnetBans = new Map();   // "a.b.c" -> bannedUntil
const subnetHits = new Map();   // "a.b.c" -> Map(key -> bannedAt)
const hits = new Map();         // key -> { count, start }
const deviceHits = new Map();   // x-request-id -> { count, start }

// Map keeps insertion order, so the first key is the oldest entry
const capSet = (map, key, value, max = MAX_TRACKED) => {
  if (!map.has(key) && map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
};

let logWindowStart = 0;
let logsInWindow = 0;
let suppressedLogs = 0;
const securityLog = (msg) => {
  const now = Date.now();
  if (now - logWindowStart > MIN) {
    if (suppressedLogs > 0) console.warn(`[security] ... ${suppressedLogs} more ban messages suppressed in the last minute`);
    logWindowStart = now;
    logsInWindow = 0;
    suppressedLogs = 0;
  }
  if (logsInWindow < MAX_LOGS_PER_MIN) {
    logsInWindow += 1;
    console.warn(msg);
  } else {
    suppressedLogs += 1;
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [k, until] of bans) if (until <= now) bans.delete(k);
  for (const [k, until] of subnetBans) if (until <= now) subnetBans.delete(k);
  for (const store of [scanStrikes, errorStrikes])
    for (const [k, s] of store) if (now - s.first > STRIKE_WINDOW_MS) store.delete(k);
  for (const store of [hits, deviceHits])
    for (const [k, h] of store) if (now - h.start > RATE_WINDOW_MS) store.delete(k);
  for (const [k, ips] of subnetHits) {
    for (const [ip, at] of ips) if (now - at > HOUR) ips.delete(ip);
    if (ips.size === 0) subnetHits.delete(k);
  }
}, 5 * MIN).unref();

const clientIp = (req) => {
  const cf = TRUST_CLOUDFLARE && req.headers["cf-connecting-ip"];
  return String(cf || req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
};

const isBanned = (ip, key) => {
  const now = Date.now();
  if ((bans.get(key) || 0) > now) return true;
  const subnet = subnetOf(ip);
  return !!subnet && (subnetBans.get(subnet) || 0) > now;
};

/* ---------- Permanent ban storage (DB, batched; never on the request path) ---------- */

const pendingBans = new Map(); // key -> row waiting to be written
let dbReady = false;
let lastLoadedAt = null;

const loadBans = async (full) => {
  const where = !full && lastLoadedAt ? { createdAt: { [require("sequelize").Op.gt]: lastLoadedAt } } : undefined;
  const rows = await SecurityBan.findAll({
    where,
    attributes: ["ipKey", "createdAt"],
    order: [["createdAt", "DESC"]],
    limit: MAX_BANS,
    raw: true,
  });
  if (full) {
    // Rebuild so rows deleted from the table (unbans) take effect; keep temporary and unsaved bans
    for (const [k, until] of bans) if (until === Infinity && !pendingBans.has(k)) bans.delete(k);
  }
  for (const r of rows.reverse()) capSet(bans, r.ipKey, Infinity, MAX_BANS);
  if (rows.length) {
    const newest = rows[rows.length - 1].createdAt;
    if (!lastLoadedAt || newest > lastLoadedAt) lastLoadedAt = newest;
  }
  return rows.length;
};

const flushBans = async () => {
  if (!dbReady || pendingBans.size === 0) return;
  const batch = [...pendingBans.values()].slice(0, 500);
  try {
    await SecurityBan.bulkCreate(batch, { ignoreDuplicates: true });
    for (const r of batch) pendingBans.delete(r.ipKey);
  } catch (err) {
    console.error("[security] could not save bans:", err.message);
  }
};

const initBanStore = async () => {
  try {
    await SecurityBan.sync(); // CREATE TABLE IF NOT EXISTS
    dbReady = true;
    const n = await loadBans(true);
    console.log(`[security] loaded ${n} permanent bans`);
  } catch (err) {
    console.error("[security] ban store unavailable, retrying in 1 min:", err.message);
    setTimeout(initBanStore, MIN).unref();
  }
};

if (BAN_MS === Infinity && process.env.SECURITY_DB !== "0") {
  initBanStore();
  setInterval(flushBans, 15 * 1000).unref();
  let ticks = 0;
  setInterval(() => {
    if (!dbReady) return;
    ticks += 1;
    loadBans(ticks % 12 === 0).catch((err) => console.error("[security] ban refresh failed:", err.message));
  }, 5 * MIN).unref();
}

const ban = (ip, key, req, reason) => {
  const now = Date.now();
  capSet(bans, key, now + BAN_MS, MAX_BANS);
  if (BAN_MS === Infinity) {
    capSet(pendingBans, key, {
      ipKey: key.slice(0, 64),
      reason: reason.slice(0, 64),
      path: String(req.originalUrl || "").slice(0, 255),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 255),
    });
  }
  securityLog(`[security] 🚫 Banned ${key} ${BAN_LABEL} | ${reason} | path: ${req.originalUrl} | ua: ${req.headers["user-agent"] || "-"} | xff: ${req.headers["x-forwarded-for"] || "-"}`);

  // Same /24 keeps sending new attackers -> ban the whole /24
  const subnet = subnetOf(ip);
  if (!subnet) return;
  const ips = subnetHits.get(subnet) || new Map();
  ips.set(key, now);
  capSet(subnetHits, subnet, ips);
  if (ips.size >= SUBNET_BAN_IPS && !((subnetBans.get(subnet) || 0) > now)) {
    capSet(subnetBans, subnet, now + SUBNET_BAN_MS);
    securityLog(`[security] 🚫 Banned subnet ${subnet}.0/24 for ${SUBNET_BAN_MS / HOUR}h | ${ips.size} attacking IPs`);
  }
};

const addStrike = (store, limit, ip, key, req, reason) => {
  if (isGoogleProxy(ip)) return;
  const now = Date.now();
  const s = store.get(key);
  if (!s || now - s.first > STRIKE_WINDOW_MS) {
    capSet(store, key, { count: 1, first: now });
    if (limit > 1) return;
  } else {
    s.count += 1;
    if (s.count < limit) return;
  }
  store.delete(key);
  ban(ip, key, req, reason);
};

const isRateLimited = (ip, key) => {
  if (isGoogleProxy(ip)) return false;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > RATE_WINDOW_MS) {
    capSet(hits, key, { count: 1, start: now });
    return false;
  }
  h.count += 1;
  // Many real users share one WARP exit IP, so give those IPs more room
  return h.count > (isSharedEgress(ip) ? RATE_LIMIT * 5 : RATE_LIMIT);
};

// The app sends x-request-id = AES(deviceId, SECRET_KEY); bots cannot produce a value that
// decrypts. Checked in memory only (no DB); middAuth still does the full check later.
const hasAppSignature = (req) => {
  const sig = req.headers["x-request-id"];
  if (!sig || typeof sig !== "string" || sig.length > 512 || !process.env.SECRET_KEY) return false;
  try {
    return CryptoJS.AES.decrypt(sig, process.env.SECRET_KEY).toString(CryptoJS.enc.Utf8).length > 0;
  } catch (err) {
    return false;
  }
};

// Identical to the 404 handler in server.js, so blocked and banned clients see nothing special
const notFound = (res) => res.status(404).json({ success: false, message: "Route Not Found" });

// Responses that real app users almost never get, but probing bots get constantly
const SUSPICIOUS_STATUS = new Set([401, 403, 404, 409]);

const guard = (req, res, next) => {
  const ip = clientIp(req);
  const key = keyOf(ip);
  const path = req.path || "/";

  if (ALLOWED_IPS.has(ip.toLowerCase())) return next();

  // 1. Permanently blocked or temporarily banned IPs / subnets.
  // A banned IP can still be shared with real users, so genuine app requests get through.
  if (BLOCKED_IPS.has(ip)) return notFound(res);
  if (isBanned(ip, key) && !(path.startsWith("/api/") && hasAppSignature(req))) return notFound(res);

  // 2. Known scanner paths or scanner tools -> reject + strike towards a ban
  if (SCANNER_PATTERN.test(req.originalUrl || path)) {
    addStrike(scanStrikes, SCAN_STRIKE_LIMIT, ip, key, req, "scanner path");
    return notFound(res);
  }
  if (SCANNER_UA.test(req.headers["user-agent"] || "")) {
    addStrike(scanStrikes, SCAN_STRIKE_LIMIT, ip, key, req, "scanner user-agent");
    return notFound(res);
  }

  // 3. Only "/" (health check) and "/api/..." exist on this server
  if (path !== "/" && !path.startsWith("/api/")) {
    if (path !== "/favicon.ico" && path !== "/robots.txt") {
      addStrike(errorStrikes, ERROR_STRIKE_LIMIT, ip, key, req, "too many unknown paths");
    }
    return notFound(res);
  }

  // 4. App-only: unsigned /api calls must come from the app's native HTTP client
  if (APP_ONLY && path.startsWith("/api/") && !looksLikeApp(req.headers["user-agent"]) && !hasAppSignature(req)) {
    addStrike(errorStrikes, ERROR_STRIKE_LIMIT, ip, key, req, "non-app client on /api");
    return notFound(res);
  }

  // 5. Per-IP flood protection
  if (isRateLimited(ip, key)) {
    return sendError(res, "TOO_MANY_REQUESTS");
  }

  // 5b. Per-device limit on paid AI routes (stops a stolen device signature from draining credits)
  const sig = req.headers["x-request-id"];
  if (AI_PATH.test(path) && typeof sig === "string" && sig) {
    const now = Date.now();
    const d = deviceHits.get(sig);
    if (!d || now - d.start > RATE_WINDOW_MS) {
      capSet(deviceHits, sig, { count: 1, start: now });
    } else if (++d.count > AI_RATE_LIMIT) {
      return sendError(res, "TOO_MANY_REQUESTS");
    }
  }

  // 6. Behaviour: an IP that keeps hitting unknown routes / failing auth gets banned
  res.on("finish", () => {
    if (SUSPICIOUS_STATUS.has(res.statusCode)) {
      addStrike(errorStrikes, ERROR_STRIKE_LIMIT, ip, key, req, `too many ${res.statusCode} responses`);
    }
  });

  next();
};

// A bug in the guard must never take the API down: fail open and keep serving
exports.securityGuard = (req, res, next) => {
  let passed = false;
  try {
    guard(req, res, () => {
      passed = true;
      next();
    });
  } catch (err) {
    console.error("[security] guard error, request allowed:", err.message);
    if (!passed && !res.headersSent) next();
  }
};

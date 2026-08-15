import { timingSafeEqual, createHmac, randomBytes, scryptSync } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

export type Account = {
  username: string;
  password?: string;
  passwordHash?: string;
  permissions?: string[];
};

type AuthOptions = {
  accounts?: Account[] | string | null;
  sessionSecret?: string | null;
  token?: string | null;
};

type AuthUser = {
  username: string;
  permissions: string[];
};

const COOKIE_NAME = "honeyrail_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const DEFAULT_PERMISSIONS = ["console"];

function parseAccounts(input: Account[] | string | null | undefined): Account[] {
  if (Array.isArray(input)) return input;
  const raw = String(input || process.env.HONEYRAIL_ACCOUNTS || process.env.AGENT_GATEWAY_ACCOUNTS || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.accounts || [];
  }
  return raw.split(",").map((entry) => {
    const [username, password, permissions = "console"] = entry.split(":");
    return {
      username: username?.trim(),
      password,
      permissions: permissions.split("|").map((permission) => permission.trim()).filter(Boolean)
    };
  });
}

function normalizeAccounts(input: Account[] | string | null | undefined) {
  return parseAccounts(input)
    .map((account) => ({
      username: String(account.username || "").trim(),
      password: account.password ? String(account.password) : undefined,
      passwordHash: account.passwordHash ? String(account.passwordHash) : undefined,
      permissions: Array.isArray(account.permissions) && account.permissions.length ? account.permissions : DEFAULT_PERMISSIONS
    }))
    .filter((account) => account.username && (account.password || account.passwordHash));
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hashPassword(password: string) {
  // Salt is a fixed crypto value, not a brand name — changing it would invalidate all stored password hashes.
  return scryptSync(password, "agent-gateway", 64).toString("hex");
}

function verifyPassword(account: Account, password: string) {
  if (account.passwordHash) return safeEqual(hashPassword(password), account.passwordHash);
  return safeEqual(account.password || "", password);
}

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

function signPayload(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function sessionCookieValue(username: string, secret: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ username, exp: now + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${signPayload(payload, secret)}`;
}

function readSessionCookie(req: Request, secret: string) {
  const cookie = parseCookies(req.headers.cookie).get(COOKIE_NAME);
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature || !safeEqual(signature, signPayload(payload, secret))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.username || Number(session.exp) < Date.now()) return null;
    return session.username;
  } catch {
    return null;
  }
}

function cookieOptions(req: Request) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0]?.trim();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: req.secure || forwardedProto === "https",
    path: "/",
    maxAge: SESSION_TTL_MS
  };
}

function publicUser(user: AuthUser | null) {
  return user ? { username: user.username, permissions: user.permissions } : null;
}

function getHeader(req: Request, name: string) {
  const getter = (req as any).get;
  if (typeof getter === "function") return getter.call(req, name) ?? "";
  return String((req.headers || {})[name.toLowerCase()] || "");
}

export function createAuthenticator({ accounts: rawAccounts, sessionSecret, token }: AuthOptions = {}) {
  const accounts = normalizeAccounts(rawAccounts);
  const accountByName = new Map(accounts.map((account) => [account.username, account]));
  const secret = sessionSecret || process.env.HONEYRAIL_SESSION_SECRET || process.env.AGENT_GATEWAY_SESSION_SECRET || randomBytes(32).toString("hex");
  const enabled = Boolean(token || accounts.length);

  const authenticate = (req: Request): AuthUser | null => {
    const header = getHeader(req, "authorization");
    if (token && header === `Bearer ${token}`) {
      return { username: "api-token", permissions: ["console", "admin"] };
    }
    const username = readSessionCookie(req, secret);
    if (!username) return null;
    const account = accountByName.get(username);
    if (!account) return null;
    return { username: account.username, permissions: account.permissions || DEFAULT_PERMISSIONS };
  };

  const verifyCredentials = (username: string, password: string): AuthUser | null => {
    const account = accountByName.get(username);
    if (!account || !verifyPassword(account, password)) return null;
    return { username: account.username, permissions: account.permissions || DEFAULT_PERMISSIONS };
  };

  const requirePermission = (permission: string): RequestHandler => (req, res, next) => {
    if (!enabled) return next();
    const user = authenticate(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!user.permissions.includes(permission) && !user.permissions.includes("admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    (req as any).user = user;
    return next();
  };

  const routes = (app: any) => {
    app.get("/api/auth/config", (req: Request, res: Response) => {
      res.json({ enabled, loginEnabled: accounts.length > 0 });
    });

    app.get("/api/auth/me", (req: Request, res: Response) => {
      if (!enabled) return res.json({ authenticated: true, user: { username: "local", permissions: ["console", "admin"] } });
      const user = authenticate(req);
      res.status(user ? 200 : 401).json({ authenticated: Boolean(user), user: publicUser(user) });
    });

    app.post("/api/auth/login", (req: Request, res: Response) => {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const account = accountByName.get(username);
      if (!account || !verifyPassword(account, password)) {
        return res.status(401).json({ error: "Invalid username or password" });
      }
      const permissions = account.permissions || DEFAULT_PERMISSIONS;
      if (!permissions.includes("console") && !permissions.includes("admin")) {
        return res.status(403).json({ error: "User does not have console access" });
      }
      res.cookie(COOKIE_NAME, sessionCookieValue(account.username, secret), cookieOptions(req));
      res.json({ authenticated: true, user: { username: account.username, permissions } });
    });

    app.post("/api/auth/logout", (req: Request, res: Response) => {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      res.json({ ok: true });
    });
  };

  const requireConsole: RequestHandler = requirePermission("console");
  const canAccessConsole = (req: Request) => !enabled || Boolean(authenticate(req)?.permissions.some((permission) => permission === "console" || permission === "admin"));
  return {
    enabled,
    accountsEnabled: accounts.length > 0,
    secret,
    routes,
    authenticate,
    verifyCredentials,
    requireConsole,
    canAccessConsole
  };
}

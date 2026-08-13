import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { createAuthenticator } from "./auth.js";

type Authenticator = ReturnType<typeof createAuthenticator>;

type OAuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  username: string;
  expiresAt: number;
};

type OAuthTokenPayload = {
  iss: string;
  sub: string;
  aud: string;
  resource: string;
  scope: string;
  iat: number;
  exp: number;
};

type OAuthOptions = {
  auth: Authenticator;
  publicBaseUrl?: string | null;
};

const DEFAULT_SCOPES = ["mcp:read", "mcp:write"];
const CODE_TTL_MS = 1000 * 60 * 5;
const TOKEN_TTL_SECONDS = 60 * 60;

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function publicBaseUrl(req: Request, configured?: string | null) {
  if (configured) return normalizeBaseUrl(configured);
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0]?.trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host");
  return normalizeBaseUrl(`${proto}://${host}`);
}

function resourceUrl(req: Request, configured?: string | null) {
  return new URL("/api/mcp", publicBaseUrl(req, configured)).toString();
}

function metadataUrl(req: Request, configured?: string | null) {
  return new URL("/.well-known/oauth-protected-resource", publicBaseUrl(req, configured)).toString();
}

function scopeString(scope: unknown) {
  const requested = String(scope || "").trim();
  if (!requested) return DEFAULT_SCOPES.join(" ");
  const scopes = requested.split(/\s+/).filter(Boolean);
  const allowed = new Set(DEFAULT_SCOPES);
  const unknown = scopes.filter((item) => !allowed.has(item));
  if (unknown.length) throw new Error(`Unsupported scope: ${unknown.join(" ")}`);
  return scopes.join(" ");
}

function isAllowedRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.origin === "https://chatgpt.com" && url.pathname.startsWith("/connector/oauth/")) return true;
    if (url.href === "https://chatgpt.com/connector_platform_oauth_redirect") return true;
    if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && ["http:", "https:"].includes(url.protocol)) return true;
    return false;
  } catch {
    return false;
  }
}

function htmlPage(title: string, body: string, status = 200) {
  return { status, html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f7f8; color: #111827; }
    main { width: min(420px, calc(100vw - 32px)); margin: 12vh auto; background: #fff; border: 1px solid #d7dde4; border-radius: 8px; padding: 24px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { line-height: 1.5; color: #4b5563; }
    label { display: block; font-size: 13px; font-weight: 600; margin: 16px 0 6px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px 12px; font-size: 15px; }
    button { margin-top: 18px; width: 100%; border: 0; border-radius: 6px; background: #111827; color: #fff; padding: 11px 14px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .error { color: #b42318; }
  </style>
</head>
<body><main>${body}</main></body>
</html>` };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char] || char));
}

function hiddenInputs(params: URLSearchParams) {
  return Array.from(params.entries())
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("\n");
}

function sha256Base64url(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function issueAccessToken(payload: OAuthTokenPayload, secret: string) {
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

function verifyAccessToken(token: string, secret: string): OAuthTokenPayload | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !safeEqual(signature, sign(encoded, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthTokenPayload;
    if (!payload.sub || !payload.iss || !payload.aud || !payload.exp) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function bearerToken(req: Request) {
  const header = String(req.get("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || null;
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).json({ error, error_description: description });
}

function readAuthorizeParams(req: Request) {
  const source = req.method === "POST" ? req.body : req.query;
  return {
    responseType: String(source.response_type || ""),
    clientId: String(source.client_id || ""),
    redirectUri: String(source.redirect_uri || ""),
    state: source.state ? String(source.state) : "",
    codeChallenge: String(source.code_challenge || ""),
    codeChallengeMethod: String(source.code_challenge_method || ""),
    resource: source.resource ? String(source.resource) : "",
    scope: source.scope ? String(source.scope) : ""
  };
}

function validateAuthorizeParams(req: Request, configuredBaseUrl?: string | null) {
  const params = readAuthorizeParams(req);
  if (params.responseType !== "code") throw new Error("response_type must be code");
  if (!params.clientId) throw new Error("client_id is required");
  if (!params.redirectUri || !isAllowedRedirectUri(params.redirectUri)) throw new Error("redirect_uri is not allowed");
  if (!params.codeChallenge) throw new Error("code_challenge is required");
  if (params.codeChallengeMethod !== "S256") throw new Error("code_challenge_method must be S256");
  const expectedResource = resourceUrl(req, configuredBaseUrl);
  const requestedResource = params.resource || expectedResource;
  if (!checkResourceAllowed({ requestedResource, configuredResource: expectedResource })) {
    throw new Error("resource is not allowed");
  }
  return {
    ...params,
    resource: requestedResource,
    scope: scopeString(params.scope)
  };
}

function redirectWithCode(input: { redirectUri: string; code: string; state?: string }) {
  const redirect = new URL(input.redirectUri);
  redirect.searchParams.set("code", input.code);
  if (input.state) redirect.searchParams.set("state", input.state);
  return redirect.toString();
}

export function createOAuthSupport({ auth, publicBaseUrl: configuredBaseUrl }: OAuthOptions) {
  const router = Router();
  const codes = new Map<string, OAuthCode>();

  const pruneCodes = () => {
    const now = Date.now();
    for (const [code, record] of codes) {
      if (record.expiresAt <= now) codes.delete(code);
    }
  };

  const challenge = (req: Request, error = "invalid_token", description = "A valid OAuth access token is required") =>
    `Bearer resource_metadata="${metadataUrl(req, configuredBaseUrl)}", scope="${DEFAULT_SCOPES.join(" ")}", error="${error}", error_description="${description}"`;

  const requireMcpAccess: RequestHandler = (req, res, next) => {
    if (auth.canAccessConsole(req)) return next();
    const token = bearerToken(req);
    const expectedIssuer = publicBaseUrl(req, configuredBaseUrl);
    const expectedResource = resourceUrl(req, configuredBaseUrl);
    const payload = token ? verifyAccessToken(token, auth.secret) : null;
    const scopes = new Set((payload?.scope || "").split(/\s+/).filter(Boolean));
    if (
      payload &&
      payload.iss === expectedIssuer &&
      checkResourceAllowed({ requestedResource: payload.aud, configuredResource: expectedResource }) &&
      checkResourceAllowed({ requestedResource: payload.resource, configuredResource: expectedResource }) &&
      DEFAULT_SCOPES.every((scope) => scopes.has(scope))
    ) {
      (req as any).user = { username: payload.sub, permissions: ["console", "admin"] };
      return next();
    }
    res.setHeader("WWW-Authenticate", challenge(req));
    res.status(401).json({ error: "Unauthorized" });
  };

  const protectedResourceMetadata = (req: Request, res: Response) => {
    const base = publicBaseUrl(req, configuredBaseUrl);
    res.json({
      resource: resourceUrl(req, configuredBaseUrl),
      authorization_servers: [base],
      scopes_supported: DEFAULT_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "HoneyRail MCP",
      resource_documentation: new URL("/api/mcp", base).toString()
    });
  };

  router.get(/^\/\.well-known\/oauth-protected-resource(?:\/.*)?$/, protectedResourceMetadata);

  router.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = publicBaseUrl(req, configuredBaseUrl);
    res.json({
      issuer: base,
      authorization_endpoint: new URL("/oauth/authorize", base).toString(),
      token_endpoint: new URL("/oauth/token", base).toString(),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      scopes_supported: DEFAULT_SCOPES
    });
  });

  const renderLogin = (req: Request, res: Response, message = "") => {
    let params: ReturnType<typeof validateAuthorizeParams>;
    try {
      params = validateAuthorizeParams(req, configuredBaseUrl);
    } catch (error) {
      const page = htmlPage("Invalid OAuth request", `<h1>Invalid OAuth request</h1><p class="error">${escapeHtml(error instanceof Error ? error.message : "Invalid request")}</p>`, 400);
      res.status(page.status).type("html").send(page.html);
      return;
    }

    const hidden = new URLSearchParams({
      response_type: params.responseType,
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod,
      resource: params.resource,
      scope: params.scope
    });
    if (params.state) hidden.set("state", params.state);

    const body = `<h1>Connect HoneyRail</h1>
<p>Sign in with a gateway account to let ChatGPT access the project MCP server.</p>
${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hiddenInputs(hidden)}
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Connect</button>
</form>`;
    const page = htmlPage("Connect HoneyRail", body);
    res.status(page.status).type("html").send(page.html);
  };

  const completeAuthorization = (req: Request, res: Response, username: string) => {
    pruneCodes();
    let params: ReturnType<typeof validateAuthorizeParams>;
    try {
      params = validateAuthorizeParams(req, configuredBaseUrl);
    } catch (error) {
      oauthError(res, 400, "invalid_request", error instanceof Error ? error.message : "Invalid authorization request");
      return;
    }
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      resource: params.resource,
      scope: params.scope,
      username,
      expiresAt: Date.now() + CODE_TTL_MS
    });
    res.redirect(302, redirectWithCode({ redirectUri: params.redirectUri, code, state: params.state }));
  };

  router.get("/oauth/authorize", (req, res) => {
    const existing = auth.authenticate(req);
    if (existing?.permissions.some((permission) => permission === "console" || permission === "admin")) {
      completeAuthorization(req, res, existing.username);
      return;
    }
    if (!auth.enabled) {
      completeAuthorization(req, res, "local");
      return;
    }
    if (!auth.accountsEnabled) {
      const page = htmlPage(
        "OAuth unavailable",
        "<h1>OAuth unavailable</h1><p class=\"error\">Gateway account auth is required for OAuth. Configure AGENT_GATEWAY_ACCOUNTS before connecting from ChatGPT.</p>",
        400
      );
      res.status(page.status).type("html").send(page.html);
      return;
    }
    renderLogin(req, res);
  });

  router.post("/oauth/authorize", express.urlencoded({ extended: false }), (req, res) => {
    if (!auth.accountsEnabled) {
      oauthError(res, 400, "access_denied", "Gateway account auth is required for OAuth");
      return;
    }
    const username = String(req.body?.username || "");
    const password = String(req.body?.password || "");
    const user = auth.verifyCredentials(username, password);
    if (!user || !user.permissions.some((permission) => permission === "console" || permission === "admin")) {
      renderLogin(req, res, "Invalid username or password.");
      return;
    }
    completeAuthorization(req, res, user.username);
  });

  router.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
    pruneCodes();
    const grantType = String(req.body?.grant_type || "");
    if (grantType !== "authorization_code") {
      oauthError(res, 400, "unsupported_grant_type", "Only authorization_code is supported");
      return;
    }
    const code = String(req.body?.code || "");
    const record = codes.get(code);
    if (!record) {
      oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
      return;
    }
    codes.delete(code);
    if (record.expiresAt <= Date.now()) {
      oauthError(res, 400, "invalid_grant", "Authorization code is expired");
      return;
    }
    if (String(req.body?.redirect_uri || "") !== record.redirectUri) {
      oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
      return;
    }
    const clientId = String(req.body?.client_id || "");
    if (clientId && clientId !== record.clientId) {
      oauthError(res, 400, "invalid_client", "client_id does not match the authorization request");
      return;
    }
    const requestedResource = String(req.body?.resource || record.resource);
    if (!checkResourceAllowed({ requestedResource, configuredResource: record.resource })) {
      oauthError(res, 400, "invalid_target", "resource does not match the authorization request");
      return;
    }
    const verifier = String(req.body?.code_verifier || "");
    if (!verifier || sha256Base64url(verifier) !== record.codeChallenge) {
      oauthError(res, 400, "invalid_grant", "code_verifier is invalid");
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const token = issueAccessToken({
      iss: publicBaseUrl(req, configuredBaseUrl),
      sub: record.username,
      aud: record.resource,
      resource: record.resource,
      scope: record.scope,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS
    }, auth.secret);

    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: record.scope
    });
  });

  return { routes: router, requireMcpAccess, challenge };
}

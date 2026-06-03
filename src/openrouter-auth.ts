import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import open from "open";
import chalk from "chalk";
import { ensureBaseDirs } from "./paths.js";
import { getSecret, setSecret } from "./keychain.js";

const ACCOUNT = "openrouter";
const AUTH_URL = "https://openrouter.ai/auth";
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const DEFAULT_PORT_START = 3000;
const PORT_ATTEMPTS = 10;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface OpenRouterLoginOptions {
  preferredPort?: number;
}

export async function openrouterLogin(options: OpenRouterLoginOptions = {}): Promise<void> {
  await ensureBaseDirs();
  const verifier = generateCodeVerifier();
  const challenge = toCodeChallenge(verifier);

  const startPort = options.preferredPort ?? DEFAULT_PORT_START;
  const { server, port } = await bindCallbackServer(startPort);
  const callbackUrl = `http://localhost:${port}/callback`;
  const loginUrl = buildAuthUrl(callbackUrl, challenge);
  console.log(chalk.cyan(`Opening browser for OpenRouter authorization at ${loginUrl}`));
  await open(loginUrl);

  try {
    const code = await waitForAuthorizationCode(server);
    const apiKey = await exchangeCodeForKey(code, verifier);
    const result = await setSecret(ACCOUNT, apiKey, { fallbackFile: "credentials" });
    if (result.usedFallback) {
      console.warn(
        chalk.yellow(
          "Keychain unavailable; saved OpenRouter key to ~/.spec-builder/credentials.json (mode 0600).",
        ),
      );
    }
    console.log(chalk.green("Stored OpenRouter API key."));
  } finally {
    server.close();
  }
}

export async function resolveOpenRouterKey(): Promise<string | null> {
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  return getSecret(ACCOUNT, { fallbackFile: "credentials" });
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(64).toString("base64url");
}

function toCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function buildAuthUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function bindCallbackServer(startPort: number): Promise<{ server: http.Server; port: number }> {
  const preferred = Number.isFinite(startPort) ? startPort : DEFAULT_PORT_START;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = preferred + attempt;
    try {
      const server = await listenOnPort(port);
      return { server, port };
    } catch {
      continue;
    }
  }
  throw new Error("Unable to bind a callback port in the range 3000-3009.");
}

function listenOnPort(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(port, () => resolve(server));
  });
}

function waitForAuthorizationCode(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for OpenRouter authorization. Try again."));
    }, LOGIN_TIMEOUT_MS);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>You can close this tab and return to spec-builder.</body></html>");
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function exchangeCodeForKey(code: string, verifier: string): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter key exchange failed: ${response.status} ${body}`);
  }
  const payload = (await response.json()) as { api_key?: string; key?: string };
  const key = payload.api_key ?? payload.key;
  if (!key) {
    throw new Error("OpenRouter response did not include an API key.");
  }
  return key;
}

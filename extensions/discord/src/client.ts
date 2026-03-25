import { RateLimitError, RequestClient } from "@buape/carbon";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RetryConfig } from "openclaw/plugin-sdk/infra-runtime";
import type { RetryRunner } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { makeDiscordProxyFetch } from "./proxy.js";
import { createDiscordRetryRunner } from "./retry.js";
import { normalizeDiscordToken } from "./token.js";

export type DiscordClientOpts = {
  cfg?: ReturnType<typeof loadConfig>;
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { accountId: string; fallbackToken?: string }) {
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

/** Default timeout for Discord API requests in milliseconds */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Builds a query string from a query object.
 * Handles array values using Discord API's comma-separated format.
 */
export function buildQueryString(
  query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
): string {
  if (!query || Object.keys(query).length === 0) {
    return "";
  }
  const queryPart = Object.entries(query)
    .flatMap(([key, value]) => {
      // Handle array values - Discord API supports array params like roles=1,2,3
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return [];
        }
        // Discord API uses comma-separated values for array params
        return [
          `${encodeURIComponent(key)}=${value.map((v) => encodeURIComponent(String(v))).join(",")}`,
        ];
      }
      return [`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`];
    })
    .join("&");
  return queryPart ? `?${queryPart}` : "";
}

/**
 * Creates a RequestClient that routes all Discord API requests through the specified proxy.
 * Carbon's RequestClient doesn't support custom fetch, so we create a subclass that
 * overrides the internal request execution to use our proxied fetch.
 */
export class ProxiedRequestClient extends RequestClient {
  private readonly proxyFetch: typeof fetch;
  private readonly discordToken: string;

  constructor(token: string, proxyUrl: string) {
    super(token);
    this.discordToken = token;
    this.proxyFetch = makeDiscordProxyFetch(proxyUrl);
  }

  // Carbon's RequestClient uses fetch internally in executeRequest, which is private.
  // We override the public methods to use our proxied fetch instead.
  // This is a workaround until Carbon supports custom fetch natively.
  override async get(
    path: string,
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("GET", path, undefined, query);
  }

  override async post(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("POST", path, data, query);
  }

  override async patch(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("PATCH", path, data, query);
  }

  override async put(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("PUT", path, data, query);
  }

  override async delete(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("DELETE", path, data, query);
  }

  private async proxiedRequest(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ): Promise<unknown> {
    const queryString = buildQueryString(query);
    const url = `${this.options.baseUrl}/v${this.options.apiVersion}${path}${queryString}`;

    // Strip any existing "Bot" prefix to avoid "Bot Bot token" format
    const normalizedToken = this.discordToken.replace(/^Bot\s+/i, "");
    const headers: Record<string, string> = {
      Authorization: `Bot ${normalizedToken}`,
      "User-Agent": this.options.userAgent ?? "OpenClaw/Discord",
      ...data?.headers,
    };

    let body: string | undefined;
    if (data?.body !== undefined) {
      if (data.rawBody) {
        body = typeof data.body === "string" ? data.body : JSON.stringify(data.body);
      } else {
        body = JSON.stringify(data.body);
        headers["Content-Type"] = "application/json";
      }
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      controller.abort();
      timeoutId = undefined;
    }, DEFAULT_TIMEOUT_MS);

    try {
      const response = await this.proxyFetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      // Handle rate limiting (429)
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = undefined;
        }

        const calculateRetryAfter = (): number => {
          // First priority: retry_after in body (seconds)
          if (
            parsedBody &&
            typeof parsedBody === "object" &&
            "retry_after" in parsedBody &&
            typeof (parsedBody as { retry_after: unknown }).retry_after === "number"
          ) {
            return (parsedBody as { retry_after: number }).retry_after;
          }

          // Second priority: Retry-After header (seconds)
          const retryAfterHeader = response.headers.get("Retry-After");
          if (retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))) {
            return Number(retryAfterHeader);
          }

          // Third priority: X-RateLimit-Reset header (Unix timestamp in seconds)
          const resetHeader = response.headers.get("X-RateLimit-Reset");
          if (resetHeader) {
            const resetTimestamp = Number(resetHeader);
            if (!Number.isNaN(resetTimestamp)) {
              // Convert Unix timestamp to seconds from now
              const now = Math.floor(Date.now() / 1000);
              const waitSeconds = Math.max(0, resetTimestamp - now);
              return waitSeconds;
            }
          }

          // Default fallback: 1 second
          return 1;
        };

        const rateLimitBody =
          parsedBody &&
          typeof parsedBody === "object" &&
          "retry_after" in parsedBody &&
          "message" in parsedBody
            ? {
                message: (parsedBody as { message: string }).message,
                retry_after: (parsedBody as { retry_after: number }).retry_after,
                global: !!(parsedBody as { global?: boolean }).global,
              }
            : {
                message:
                  typeof parsedBody === "string" ? parsedBody : "You are being rate limited.",
                retry_after: calculateRetryAfter(),
                global: response.headers.get("X-RateLimit-Scope") === "global",
              };

        throw new RateLimitError(response, rateLimitBody);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = undefined;
        }
        const error = new Error(
          `Discord API error (${response.status}): ${text.slice(0, 500)}`,
        ) as Error & {
          status: number;
          code?: number;
          rawError?: unknown;
          body?: unknown;
        };
        error.status = response.status;
        // Preserve Discord error fields for downstream error handling
        if (parsedBody && typeof parsedBody === "object") {
          const body = parsedBody as { code?: unknown; message?: unknown };
          if (typeof body.code === "number") {
            error.code = body.code;
          }
          error.body = parsedBody;
          error.rawError = parsedBody;
        }
        throw error;
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined;
      }

      return response.json();
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}

function resolveRest(token: string, proxyUrl?: string, rest?: RequestClient): RequestClient {
  if (rest) {
    return rest;
  }
  const proxy = proxyUrl?.trim();
  if (proxy) {
    try {
      return new ProxiedRequestClient(token, proxy);
    } catch (error) {
      // Fall back to default RequestClient if proxy is invalid
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(
        `Failed to create proxied request client: ${errorMessage}. Using default client.`,
      );
      return new RequestClient(token);
    }
  }
  return new RequestClient(token);
}

function resolveAccountWithoutToken(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    token: "",
    tokenSource: "none",
    config: merged,
  };
}

export function createDiscordRestClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
) {
  const resolvedCfg = opts.cfg ?? cfg ?? loadConfig();
  const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
  const account = explicitToken
    ? resolveAccountWithoutToken({ cfg: resolvedCfg, accountId: opts.accountId })
    : resolveDiscordAccount({ cfg: resolvedCfg, accountId: opts.accountId });
  const token =
    explicitToken ??
    resolveToken({
      accountId: account.accountId,
      fallbackToken: account.token,
    });
  const proxyUrl = account.config.proxy;
  const rest = resolveRest(token, proxyUrl, opts.rest);
  return { token, rest, account };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
): { token: string; rest: RequestClient; request: RetryRunner } {
  const { token, rest, account } = createDiscordRestClient(opts, opts.cfg ?? cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts, opts.cfg).rest;
}

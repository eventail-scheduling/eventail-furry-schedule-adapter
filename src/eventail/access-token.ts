import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { type Configuration, clientCredentialsGrant, customFetch } from "openid-client";
import { z } from "zod";
import { logger } from "../util/logger.js";

// Refreshing this far ahead is what lets nothing here react to a 401: a token
// handed out is unexpired by construction, so a rejection is a
// misconfiguration that minting again reproduces.
const refreshLeeway = Temporal.Duration.from("PT60S");

const firstBackoff = 60_000;
const maximumBackoff = 60 * 60_000;

const claimsSchema = z.object({ exp: z.int().positive() });

const cacheEntrySchema = z.object({
    key: z.string(),
    accessToken: z.string().min(1),
    expiresAt: z.string(),
});

export type CredentialIdentity = {
    issuer: string;
    clientId: string;
    clientSecret: string;
    audience?: string | undefined;
    scope?: string | undefined;
};

export type TokenProviderOptions = {
    configuration: Configuration;
    /** Both the grant parameters and the cache key, so the two cannot disagree. */
    identity: CredentialIdentity;
    cachePath?: string | undefined;
    /** Monotonic milliseconds, so the backoff survives a clock that steps backwards. */
    now?: () => number;
    instantNow?: () => Temporal.Instant;
};

export type AccessTokenProvider = {
    get: (signal?: AbortSignal) => Promise<string>;
};

type HeldToken = {
    accessToken: string;
    expiresAt: Temporal.Instant;
};

/**
 * Keys a cached token by what minted it.
 *
 * An operator iterating on configuration changes the edition far more often
 * than the credentials, so a cache keyed on this survives the whole
 * setup loop. The secret is part of it because rotating one should discard the
 * token it minted.
 */
const credentialKey = (identity: CredentialIdentity): string =>
    createHash("sha256")
        .update(
            JSON.stringify([
                identity.issuer,
                identity.clientId,
                identity.clientSecret,
                identity.audience ?? null,
                identity.scope ?? null,
            ]),
        )
        .digest("hex");

/**
 * Reads the expiry from the token rather than the response around it.
 *
 * `expires_in` is only RECOMMENDED by RFC 6749 section 5.1, while `exp` is what
 * the API will actually check.
 */
const expiryOf = (
    accessToken: string,
    expiresIn: number | undefined,
    now: Temporal.Instant,
): Temporal.Instant => {
    const payload = accessToken.split(".")[1];

    if (payload !== undefined) {
        try {
            const claims = claimsSchema.parse(
                JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
            );

            return Temporal.Instant.fromEpochMilliseconds(claims.exp * 1000);
        } catch {
            // Opaque, or a JWT without an exp; expires_in is all there is.
        }
    }

    if (expiresIn === undefined) {
        throw new Error("The token carries no exp and the response no expires_in");
    }

    return now.add({ seconds: expiresIn });
};

const errorCode = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;

const writeAtomically = async (path: string, contents: string): Promise<void> => {
    // Random, not the pid: in a container the adapter is pid 1 on every
    // start, so one temp file left by a kill would block every later write.
    const temporary = `${path}.${randomUUID()}.tmp`;

    try {
        await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
};

/**
 * Proves the cache is usable before a token is spent finding out it is not.
 *
 * Readable as well as writable, and a file rather than a directory. Each
 * failure is otherwise a warning per attempt while the adapter quietly mints
 * on every start, which is what configuring a cache was meant to stop. A
 * volume mounted where the file should be, or a file left behind by another
 * user, both land here.
 */
export const verifyCacheUsable = async (path: string): Promise<void> => {
    const existing = await stat(path).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") {
            return null;
        }

        throw error;
    });

    if (existing !== null) {
        if (!existing.isFile()) {
            throw new Error(`${path} is not a file, so the access token cache cannot be used`);
        }

        await readFile(path, "utf8");
    }

    await writeAtomically(`${path}.probe`, "");
    await unlink(`${path}.probe`);
};

export const createAccessTokenProvider = (options: TokenProviderOptions): AccessTokenProvider => {
    const monotonic = options.now ?? (() => performance.now());
    const instantNow = options.instantNow ?? (() => Temporal.Now.instant());
    const key = credentialKey(options.identity);

    // clientCredentialsGrant takes no signal, so a caller's one reaches the
    // request only through the transport. Without this a shutdown during a
    // mint waits out the configured timeout instead of returning.
    let mintSignal: AbortSignal | undefined;
    const transport = options.configuration[customFetch] ?? fetch;
    options.configuration[customFetch] = async (url, init) =>
        await transport(url, {
            ...init,
            signal: AbortSignal.any(
                [init?.signal, mintSignal].filter((signal) => signal !== undefined),
            ),
        });

    let held: HeldToken | null = null;
    let readCache = options.cachePath === undefined;
    let pending: Promise<HeldToken> | null = null;
    let failures = 0;
    let nextAttemptAt = 0;

    const isUsable = (token: HeldToken, now: Temporal.Instant): boolean =>
        Temporal.Instant.compare(now, token.expiresAt.subtract(refreshLeeway)) < 0;

    const loadFromCache = async (): Promise<HeldToken | null> => {
        if (options.cachePath === undefined) {
            return null;
        }

        try {
            const entry = cacheEntrySchema.parse(
                JSON.parse(await readFile(options.cachePath, "utf8")),
            );

            if (entry.key !== key) {
                return null;
            }

            return {
                accessToken: entry.accessToken,
                expiresAt: Temporal.Instant.from(entry.expiresAt),
            };
        } catch (error) {
            // Past the startup probe, anything left is a cache that went bad
            // while running: warn and mint, and the next write replaces it.
            if (errorCode(error) !== "ENOENT") {
                logger.warn("Could not read the access token cache", { error });
            }

            return null;
        }
    };

    const request = async (): Promise<HeldToken> => {
        const granted = await clientCredentialsGrant(options.configuration, {
            ...(options.identity.audience !== undefined && {
                audience: options.identity.audience,
            }),
            ...(options.identity.scope !== undefined && { scope: options.identity.scope }),
        });

        const token = {
            accessToken: granted.access_token,
            expiresAt: expiryOf(granted.access_token, granted.expiresIn(), instantNow()),
        };

        // Checked here rather than trusted. A token already inside the leeway
        // is one the next call mints again, so handing it out turns every poll
        // into a mint while every mint succeeds and no backoff ever arms.
        if (!isUsable(token, instantNow())) {
            throw new Error(
                `The token endpoint issued a token expiring at ${token.expiresAt.toString()}, ` +
                    "which is already inside the refresh leeway",
            );
        }

        logger.info("Minted an access token", { expiresAt: token.expiresAt.toString() });

        if (options.cachePath !== undefined) {
            await writeAtomically(
                options.cachePath,
                JSON.stringify({
                    key,
                    accessToken: token.accessToken,
                    expiresAt: token.expiresAt.toString(),
                }),
            ).catch((error: unknown) => {
                logger.warn("Could not write the access token cache", { error });
            });
        }

        return token;
    };

    // A failing mint is reached once per poll, so a fixed floor shorter than
    // the poll interval would never fire.
    const mint = async (signal?: AbortSignal): Promise<HeldToken> => {
        if (pending !== null) {
            return pending;
        }

        if (failures > 0 && monotonic() < nextAttemptAt) {
            throw new Error(
                `Waiting out the backoff after ${failures} failed attempts to mint a token`,
            );
        }

        signal?.throwIfAborted();
        mintSignal = signal;
        pending = request();

        try {
            const token = await pending;
            failures = 0;

            return token;
        } catch (error) {
            // A caller that withdrew has not told us anything about the
            // provider, so it must not push the next real attempt behind a
            // backoff.
            if (!(error instanceof Error && error.name === "AbortError")) {
                failures += 1;
                nextAttemptAt =
                    monotonic() + Math.min(firstBackoff * 2 ** (failures - 1), maximumBackoff);
            }

            throw error;
        } finally {
            pending = null;
            mintSignal = undefined;
        }
    };

    return {
        get: async (signal) => {
            if (held !== null && isUsable(held, instantNow())) {
                return held.accessToken;
            }

            if (!readCache) {
                readCache = true;
                const cached = await loadFromCache();

                if (cached !== null && isUsable(cached, instantNow())) {
                    held = cached;
                    logger.debug("Reusing the cached access token");

                    return cached.accessToken;
                }
            }

            held = await mint(signal);

            return held.accessToken;
        },
    };
};

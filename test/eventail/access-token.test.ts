import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
    allowInsecureRequests,
    ClientSecretBasic,
    Configuration,
    customFetch,
} from "openid-client";
import {
    type CredentialIdentity,
    createAccessTokenProvider,
    type TokenProviderOptions,
    verifyCacheUsable,
} from "../../src/eventail/access-token.js";

type Call = { url: string; init: RequestInit };

const jwt = (expiresAtSeconds: number): string => {
    const payload = Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString("base64url");

    return `header.${payload}.signature`;
};

const inSeconds = (seconds: number): number =>
    Math.floor(Temporal.Now.instant().epochMilliseconds / 1000) + seconds;

// token_type is REQUIRED by RFC 6749 section 5.1, and the library enforces it.
const granted = (body: Record<string, unknown>) => ({
    status: 200,
    body: { token_type: "Bearer", ...body },
});

/**
 * The grant, the client authentication and the request shape are the
 * library's, so what is worth driving here is only what this module adds.
 */
const createProvider = (
    responses: Array<{ status: number; body: unknown }>,
    overrides: Omit<Partial<TokenProviderOptions>, "identity"> & {
        clientSecret?: string;
        issuer?: string;
        clientId?: string;
        identity?: Partial<CredentialIdentity>;
    } = {},
) => {
    const calls: Call[] = [];
    const {
        clientSecret = "shhh",
        issuer = "https://idp.test",
        clientId = "adapter",
        identity = {},
        ...rest
    } = overrides;

    const configuration = new Configuration(
        {
            issuer,
            token_endpoint: `${issuer}/oauth/token`,
        },
        clientId,
        {},
        ClientSecretBasic(clientSecret),
    );
    allowInsecureRequests(configuration);

    configuration[customFetch] = (async (input, init) => {
        calls.push({ url: String(input), init: (init ?? {}) as RequestInit });
        const next = responses.shift();
        assert.ok(next, "the stub ran out of responses");

        return new Response(JSON.stringify(next.body), {
            status: next.status,
            headers: { "content-type": "application/json" },
        });
    }) as NonNullable<(typeof configuration)[typeof customFetch]>;

    const provider = createAccessTokenProvider({
        configuration,
        identity: { issuer, clientId, clientSecret, audience: "eventail", ...identity },
        ...rest,
    });

    return { provider, calls };
};

const cacheFile = async () => join(await mkdtemp(join(tmpdir(), "adapter-")), "token.json");

describe("createAccessTokenProvider", () => {
    it("asks for the audience and scope it was configured with", async () => {
        // The library owns the request shape; which parameters go into it is
        // still ours, and a dropped audience yields a token the API refuses.
        const { provider, calls } = createProvider(
            [granted({ access_token: jwt(inSeconds(86_400)) })],
            { identity: { scope: "schedule:read" } },
        );
        await provider.get();

        const body = new URLSearchParams(String(calls[0].init.body));
        assert.equal(body.get("audience"), "eventail");
        assert.equal(body.get("scope"), "schedule:read");
    });

    it("reuses one token rather than minting per call", async () => {
        const { provider, calls } = createProvider([
            granted({ access_token: jwt(inSeconds(86_400)) }),
        ]);

        await provider.get();
        await provider.get();
        await provider.get();

        assert.equal(calls.length, 1);
    });

    it("mints again once the held token enters the refresh leeway", async () => {
        // Reached by moving the clock rather than by issuing a stale token.
        let instant = Temporal.Instant.from("2027-01-01T00:00:00Z");
        const { provider, calls } = createProvider(
            [
                granted({ access_token: jwt(instant.epochMilliseconds / 1000 + 3600) }),
                granted({ access_token: jwt(instant.epochMilliseconds / 1000 + 7200) }),
            ],
            { instantNow: () => instant },
        );

        const first = await provider.get();
        assert.equal(await provider.get(), first, "it minted again while the token was fresh");

        // Inside the last minute of the first token's life.
        instant = instant.add({ seconds: 3590 });
        assert.notEqual(await provider.get(), first);
        assert.equal(calls.length, 2);
    });

    it("takes the expiry from the token, not from expires_in", async () => {
        // A generous expires_in must not keep a short token alive.
        let instant = Temporal.Instant.from("2027-01-01T00:00:00Z");
        const { provider, calls } = createProvider(
            [
                granted({
                    access_token: jwt(instant.epochMilliseconds / 1000 + 300),
                    expires_in: 86_400,
                }),
                granted({ access_token: jwt(instant.epochMilliseconds / 1000 + 7200) }),
            ],
            { instantNow: () => instant },
        );

        await provider.get();
        instant = instant.add({ seconds: 290 });
        await provider.get();

        assert.equal(calls.length, 2);
    });

    it("refuses a token that arrives already inside the refresh leeway", async () => {
        const { provider, calls } = createProvider([
            granted({ access_token: jwt(inSeconds(10)) }),
            granted({ access_token: jwt(inSeconds(10)) }),
        ]);

        await assert.rejects(async () => await provider.get(), /inside the refresh leeway/);
        assert.equal(calls.length, 1);
    });

    it("accepts a token that carries no exp by falling back to expires_in", async () => {
        const { provider } = createProvider([
            granted({ access_token: "opaque-token", expires_in: 86_400 }),
        ]);

        assert.equal(await provider.get(), "opaque-token");
    });
});

describe("createAccessTokenProvider backoff", () => {
    it("holds off longer after each failure rather than retrying every poll", async () => {
        // A fixed floor shorter than the poll interval never fires.
        let clock = 0;
        const { provider, calls } = createProvider(
            Array.from({ length: 10 }, () => ({ status: 401, body: { error: "invalid_client" } })),
            { now: () => clock },
        );

        const poll = async () => {
            await provider.get().catch(() => undefined);
        };

        await poll();
        assert.equal(calls.length, 1);

        for (let minute = 1; minute <= 60; minute += 1) {
            clock = minute * 60_000;
            await poll();
        }

        assert.ok(calls.length <= 7, `made ${calls.length} attempts in an hour`);
    });

    it("starts the next backoff from the bottom once a mint succeeds", async () => {
        // Without the reset a provider that blips hourly is locked out for
        // hours.
        let clock = 0;
        let instant = Temporal.Instant.from("2027-01-01T00:00:00Z");
        const at = (seconds: number) => jwt(instant.epochMilliseconds / 1000 + seconds);
        const { provider, calls } = createProvider(
            [
                { status: 500, body: {} },
                { status: 500, body: {} },
                { status: 500, body: {} },
                granted({ access_token: at(86_400) }),
                { status: 500, body: {} },
                granted({ access_token: at(172_800) }),
            ],
            { now: () => clock, instantNow: () => instant },
        );

        const attempt = async () => {
            await provider.get().catch(() => undefined);
        };

        // Three failures take the delay to four minutes.
        await attempt();
        clock = 60_000;
        await attempt();
        clock += 120_000;
        await attempt();
        assert.equal(calls.length, 3);

        clock += 240_000;
        await attempt();
        assert.equal(calls.length, 4, "the fourth attempt was still held back");

        // That success must put the next failure back on the one-minute step
        // rather than the eight-minute one it had reached. Moving the wall
        // clock past the token's life is what forces another mint.
        instant = instant.add({ seconds: 86_400 });
        await attempt();
        assert.equal(calls.length, 5);

        clock += 60_000;
        await attempt();
        assert.equal(calls.length, 6, "the backoff did not reset after a success");
    });

    it("mints once for concurrent callers rather than rejecting one", async () => {
        const { provider, calls } = createProvider([
            granted({ access_token: jwt(inSeconds(86_400)) }),
        ]);

        const [first, second] = await Promise.all([provider.get(), provider.get()]);

        assert.equal(first, second);
        assert.equal(calls.length, 1);
    });
});

describe("createAccessTokenProvider cache file", () => {
    it("creates the cache readable only by its owner", async () => {
        const path = await cacheFile();
        const { provider } = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await provider.get();

        assert.equal((await stat(path)).mode & 0o777, 0o600);
    });

    it("keeps 0600 even when a laxer file is already there", async () => {
        // writeFile's mode applies only on creation, so writing in place would
        // leave a bearer token in a world-readable file.
        const path = await cacheFile();
        await writeFile(path, "{}");
        await chmod(path, 0o644);

        const { provider } = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await provider.get();

        assert.equal((await stat(path)).mode & 0o777, 0o600);
    });

    it("writes the cache even when a temp file from a killed process is in the way", async () => {
        // In a container the adapter is pid 1 on every start, so a temp name
        // derived from the pid collides with its own leftovers and blocks
        // every later write behind flag "wx".
        const path = await cacheFile();
        await writeFile(`${path}.${process.pid}.tmp`, "leftover");

        const { provider } = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await provider.get();

        assert.match(await readFile(path, "utf8"), /"accessToken"/);
    });

    it("reuses a cached token instead of minting", async () => {
        const path = await cacheFile();
        const first = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        const token = await first.provider.get();

        const second = createProvider([], { cachePath: path });
        assert.equal(await second.provider.get(), token);
        assert.equal(second.calls.length, 0);
    });

    it("ignores an entry minted with other credentials", async () => {
        const path = await cacheFile();
        const first = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await first.provider.get();

        const rotated = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
            clientSecret: "rotated",
        });
        await rotated.provider.get();

        assert.equal(rotated.calls.length, 1);
    });

    it("ignores an entry minted for another audience", async () => {
        const path = await cacheFile();
        const first = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await first.provider.get();

        const elsewhere = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
            identity: { audience: "another-api" },
        });
        await elsewhere.provider.get();

        assert.equal(elsewhere.calls.length, 1);
    });

    it("ignores an entry minted under another scope", async () => {
        // Two deployments sharing a cache path must not swap tokens whose
        // claims differ, which surfaces as an opaque 403 rather than a miss.
        const path = await cacheFile();
        const first = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await first.provider.get();

        const scoped = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
            identity: { scope: "schedule:read" },
        });
        await scoped.provider.get();

        assert.equal(scoped.calls.length, 1);
    });

    it("ignores an entry minted against another issuer", async () => {
        const path = await cacheFile();
        const first = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await first.provider.get();

        const moved = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
            issuer: "https://other.test",
        });
        await moved.provider.get();

        assert.equal(moved.calls.length, 1);
    });

    it("ignores a cached token that has expired", async () => {
        // The key has to match, or the credential guard rejects the entry
        // before the expiry is ever consulted.
        const path = await cacheFile();
        const first = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await first.provider.get();

        const entry = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        await writeFile(path, JSON.stringify({ ...entry, expiresAt: "2020-01-01T00:00:00Z" }));

        const second = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await second.provider.get();

        assert.equal(second.calls.length, 1);
    });

    it("hashes the credentials rather than storing them", async () => {
        const path = await cacheFile();
        const { provider } = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await provider.get();

        const written = await readFile(path, "utf8");
        assert.equal(written.includes("shhh"), false);
        assert.match(JSON.parse(written).key, /^[0-9a-f]{64}$/);
    });

    it("mints rather than failing when the cache cannot be read", async () => {
        const { provider } = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: "/nonexistent/dir/token.json",
        });

        assert.equal(await provider.get(), await provider.get());
    });
});

describe("aborting a mint", () => {
    it("gives up an in-flight request rather than waiting out the timeout", async () => {
        // On shutdown index.ts aborts and awaits the refresh loop, so a mint
        // that ignored the signal would hold the process past its grace.
        const controller = new AbortController();
        const configuration = new Configuration(
            { issuer: "https://idp.test", token_endpoint: "https://idp.test/token" },
            "adapter",
            "shhh",
        );
        configuration[customFetch] = async (_url, init) => {
            await new Promise((resolve, reject) => {
                const stall = setTimeout(resolve, 5_000);
                init?.signal?.addEventListener("abort", () => {
                    clearTimeout(stall);
                    reject(new DOMException("aborted", "AbortError"));
                });
                setTimeout(() => {
                    controller.abort();
                }, 10);
            });

            return new Response("{}");
        };

        const provider = createAccessTokenProvider({
            configuration,
            identity: { issuer: "https://idp.test", clientId: "adapter", clientSecret: "shhh" },
        });

        await assert.rejects(async () => await provider.get(controller.signal), /abort/i);
    });
});

describe("loadFromCache error handling", () => {
    it("mints past a cache whose contents are not a token, without escaping", async () => {
        const path = await cacheFile();
        await writeFile(path, "this is not json");

        const { provider, calls } = createProvider(
            [granted({ access_token: jwt(inSeconds(86_400)) })],
            { cachePath: path },
        );

        await provider.get();
        assert.equal(calls.length, 1);
    });

    it("mints past a cache holding a token whose expiry will not parse", async () => {
        const path = await cacheFile();
        const seed = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
        });
        await seed.provider.get();

        const entry = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        await writeFile(path, JSON.stringify({ ...entry, expiresAt: "not-an-instant" }));

        const { provider, calls } = createProvider(
            [granted({ access_token: jwt(inSeconds(86_400)) })],
            { cachePath: path },
        );

        await provider.get();
        assert.equal(calls.length, 1);
    });
});

describe("verifyCacheUsable", () => {
    it("passes for a writable directory and leaves nothing behind", async () => {
        const path = await cacheFile();
        await verifyCacheUsable(path);

        await assert.rejects(async () => await stat(`${path}.probe`));
    });

    it("refuses a path that cannot be written", async () => {
        await assert.rejects(async () => await verifyCacheUsable("/nonexistent/dir/token.json"));
    });

    it("refuses a directory where the file should be", async () => {
        // A volume mounted at the path rather than at its parent.
        const directory = await mkdtemp(join(tmpdir(), "adapter-"));

        await assert.rejects(async () => await verifyCacheUsable(directory), /is not a file/);
    });

    it("refuses an existing cache it cannot read", { skip: process.getuid?.() === 0 }, async () => {
        // Writable directory, unreadable file: every read would warn and mint
        // while a write-only probe reported the path fine.
        const path = await cacheFile();
        await writeFile(path, "{}");
        await chmod(path, 0o000);

        await assert.rejects(async () => await verifyCacheUsable(path));
    });
});

describe("the credential key", () => {
    it("separates values that a delimiter alone would let collide", async () => {
        // Joining on a separator lets a newline inside one value produce the
        // same key as a different split of the same characters.
        const path = await cacheFile();
        const first = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
            clientId: "a\nb",
            clientSecret: "c",
        });
        await first.provider.get();

        const collides = createProvider([granted({ access_token: jwt(inSeconds(86_400)) })], {
            cachePath: path,
            clientId: "a",
            clientSecret: "b\nc",
        });
        await collides.provider.get();

        assert.equal(collides.calls.length, 1, "it reused a cache entry from other credentials");
    });
});

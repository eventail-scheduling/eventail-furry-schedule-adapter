import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { serve } from "@taxum/core/server";
import { createDocumentStore, type DocumentStore } from "../src/document-store.js";
import { createRouter } from "../src/server.js";

const window = {
    start: Temporal.Instant.from("2027-06-01T00:00:00Z"),
    end: Temporal.Instant.from("2027-06-04T23:59:59Z"),
};

const body = JSON.stringify({ schemaVersion: "1.0.0", events: [] });

const startServer = async (store: DocumentStore) => {
    const controller = new AbortController();
    const listening = Promise.withResolvers<AddressInfo>();

    const closed = serve(createRouter(store), {
        abortSignal: controller.signal,
        unrefOnStart: true,
        onListen: (address) => {
            listening.resolve(address);
        },
    });

    const address = await listening.promise;

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: async (): Promise<void> => {
            controller.abort();
            await closed;
        },
    };
};

/** fetch combines repeated header values, so this sends them as separate lines. */
const statusWithRepeatedHeader = (base: string, name: string, values: string[]): Promise<number> =>
    new Promise((resolve, reject) => {
        const request = httpRequest(
            `${base}/schedule.json`,
            { headers: { [name]: values } },
            (response) => {
                response.resume();
                response.on("end", () => {
                    resolve(response.statusCode ?? 0);
                });
            },
        );

        request.on("error", reject);
        request.end();
    });

const createServed = async () => {
    const store = createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") });
    store.store(body, window, Temporal.Now.instant());

    return startServer(store);
};

describe("the schedule endpoint", () => {
    const servers: Array<{ close: () => Promise<void> }> = [];

    after(async () => {
        await Promise.all(servers.map(async (server) => await server.close()));
    });

    const track = <T extends { close: () => Promise<void> }>(server: T): T => {
        servers.push(server);

        return server;
    };

    it("serves the document as json under a validator", async () => {
        const server = track(await createServed());
        const response = await fetch(`${server.url}/schedule.json`);

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.match(response.headers.get("etag") ?? "", /^"[0-9a-f]{64}"$/);
        assert.equal(await response.text(), body);
    });

    it("answers a matching validator with a 304 that still carries the validator", async () => {
        const server = track(await createServed());
        const entityTag = (await fetch(`${server.url}/schedule.json`)).headers.get("etag") ?? "";
        const response = await fetch(`${server.url}/schedule.json`, {
            headers: { "if-none-match": entityTag },
        });

        assert.equal(response.status, 304);
        assert.equal(response.headers.get("etag"), entityTag);
    });

    it("serves the document when the validator does not match", async () => {
        const server = track(await createServed());
        const response = await fetch(`${server.url}/schedule.json`, {
            headers: {
                "if-none-match":
                    '"0000000000000000000000000000000000000000000000000000000000000000"',
            },
        });

        assert.equal(response.status, 200);
        assert.equal(await response.text(), body);
    });

    it("matches a validator among several on one comma-separated line", async () => {
        const server = track(await createServed());
        const entityTag = (await fetch(`${server.url}/schedule.json`)).headers.get("etag") ?? "";
        const response = await fetch(`${server.url}/schedule.json`, {
            headers: { "if-none-match": `"something-else", ${entityTag}` },
        });

        assert.equal(response.status, 304);
    });

    it("matches a validator sent as one of several header lines", async () => {
        const server = track(await createServed());
        const entityTag = (await fetch(`${server.url}/schedule.json`)).headers.get("etag") ?? "";

        assert.equal(
            await statusWithRepeatedHeader(server.url, "if-none-match", [
                '"something-else"',
                entityTag,
            ]),
            304,
        );
    });

    it("lets a cache revalidate the document but never store a problem", async () => {
        const server = track(await createServed());
        const served = await fetch(`${server.url}/schedule.json`);
        assert.equal(served.headers.get("cache-control"), "public, no-cache");

        const store = createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") });
        store.markNotPublished(Temporal.Now.instant());
        const empty = track(await startServer(store));

        const refused = await fetch(`${empty.url}/schedule.json`);
        assert.equal(refused.headers.get("cache-control"), "no-store");
    });

    it("compares validators weakly, as RFC 9110 requires of if-none-match", async () => {
        const server = track(await createServed());
        const entityTag = (await fetch(`${server.url}/schedule.json`)).headers.get("etag") ?? "";
        const response = await fetch(`${server.url}/schedule.json`, {
            headers: { "if-none-match": `W/${entityTag}` },
        });

        assert.equal(response.status, 304);
    });

    it("reports an edition that has published nothing as a problem, not an error", async () => {
        const store = createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") });
        store.markNotPublished(Temporal.Now.instant());
        const server = track(await startServer(store));

        const response = await fetch(`${server.url}/schedule.json`);
        assert.equal(response.status, 404);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
        assert.deepEqual(await response.json(), {
            title: "Not Found",
            status: 404,
            detail: "This edition has no published schedule.",
        });
    });

    it("refuses a document it has held past the ceiling, and dates the failure", async () => {
        const store = createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") });
        store.store(body, window, Temporal.Instant.from("2026-01-01T00:00:00Z"));
        const server = track(await startServer(store));

        const response = await fetch(`${server.url}/schedule.json`);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("content-type"), "application/problem+json");

        const problem = (await response.json()) as { title: string; detail: string };
        assert.equal(problem.title, "Service Unavailable");
        assert.match(problem.detail, /2026-01-01T00:00:00Z/);
    });

    it("reports a service that has not read the schedule yet as unavailable", async () => {
        const store = createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") });
        const server = track(await startServer(store));

        const response = await fetch(`${server.url}/schedule.json`);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
    });

    it("answers an unknown path in the same format as everything else", async () => {
        const server = track(await createServed());
        const response = await fetch(`${server.url}/nope`);

        assert.equal(response.status, 404);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
    });

    it("refuses a method it does not serve", async () => {
        const server = track(await createServed());
        const response = await fetch(`${server.url}/schedule.json`, { method: "POST" });

        assert.equal(response.status, 405);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
    });

    it("answers the health check while the process is up, stale or not", async () => {
        const served = track(await createServed());
        const healthy = await fetch(`${served.url}/health`);

        assert.equal(healthy.status, 200);
        assert.equal(((await healthy.json()) as { stale: boolean }).stale, false);

        const store = createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") });
        store.store(body, window, Temporal.Instant.from("2026-01-01T00:00:00Z"));
        const stale = track(await startServer(store));
        const refused = await fetch(`${stale.url}/health`);

        assert.equal(refused.status, 200);
        assert.deepEqual(await refused.json(), {
            state: "ready",
            stale: true,
            lastSuccessAt: "2026-01-01T00:00:00Z",
        });
    });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventailClient } from "../../src/eventail/client.js";
import { scheduleDocument } from "../fixtures/schedule-document.js";

type Call = { url: URL; init: RequestInit };

const staticTokens = (accessToken: string) => ({ get: async () => accessToken });

const createClient = (respond: (call: Call) => Response) => {
    const calls: Call[] = [];

    const client = createEventailClient({
        baseUrl: "http://api.test",
        accessTokens: staticTokens("a-token"),
        editionId: "ed-1",
        requestTimeout: Temporal.Duration.from("PT5S"),
        fetch: (async (input, init) => {
            const call = { url: input as URL, init: init ?? {} };
            calls.push(call);

            return respond(call);
        }) as typeof globalThis.fetch,
    });

    return { client, calls };
};

const documentResponse = (headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(scheduleDocument), {
        status: 200,
        headers: { "content-type": "application/vnd.api+json", ...headers },
    });

describe("createEventailClient", () => {
    it("asks the current schedule for every relationship the document needs", async () => {
        const { client, calls } = createClient(() => documentResponse());
        await client.fetchCurrentSchedule(null);

        const url = calls[0].url;
        assert.equal(url.pathname, "/editions/ed-1/schedules/current");
        assert.deepEqual(url.searchParams.get("include")?.split(","), [
            "slots.location",
            "slots.session.hosts",
            "slots.session.track",
            "slots.session.sessionType",
        ]);
    });

    it("presents the token and asks for JSON:API", async () => {
        const { client, calls } = createClient(() => documentResponse());
        await client.fetchCurrentSchedule(null);

        const headers = calls[0].init.headers as Record<string, string>;
        assert.equal(headers.authorization, "Bearer a-token");
        assert.equal(headers.accept, "application/vnd.api+json");
    });

    it("sends no validator on the first fetch and the last one afterwards", async () => {
        const { client, calls } = createClient(() => documentResponse({ etag: 'W/"abc"' }));

        await client.fetchCurrentSchedule(null);
        assert.equal((calls[0].init.headers as Record<string, string>)["if-none-match"], undefined);

        await client.fetchCurrentSchedule('W/"abc"');
        assert.equal((calls[1].init.headers as Record<string, string>)["if-none-match"], 'W/"abc"');
    });

    it("returns the document and the validator it was served with", async () => {
        const { client } = createClient(() => documentResponse({ etag: 'W/"abc"' }));
        const result = await client.fetchCurrentSchedule(null);

        assert.equal(result.status, "fetched");
        assert.equal(result.status === "fetched" && result.entityTag, 'W/"abc"');
        assert.equal(
            result.status === "fetched" && result.document.data.edition.name,
            "Testing Edition 2027",
        );
    });

    it("reports an unchanged schedule rather than parsing an empty body", async () => {
        const { client } = createClient(() => new Response(null, { status: 304 }));

        assert.deepEqual(await client.fetchCurrentSchedule('W/"abc"'), { status: "not_modified" });
    });

    it("throws rather than returning on a refusal", async () => {
        const { client } = createClient(
            () =>
                new Response(JSON.stringify({ errors: [{ status: "403", code: "forbidden" }] }), {
                    status: 403,
                    headers: { "content-type": "application/vnd.api+json" },
                }),
        );

        await assert.rejects(() => client.fetchCurrentSchedule(null));
    });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonApiError } from "@jsonapi-serde/client";
import { createDocumentStore, type DocumentStore } from "../src/document-store.js";
import type { CurrentSchedule, EventailClient } from "../src/eventail/client.js";
import { deserializeScheduleDocument } from "../src/eventail/schedule-document.js";
import type { MapScheduleOptions } from "../src/furry-schedule/map-schedule.js";
import { createRefresher, type RefreshIntervals, selectInterval } from "../src/refresher.js";
import { scheduleDocument } from "./fixtures/schedule-document.js";

const intervals = {
    idle: Temporal.Duration.from("PT15M"),
    live: Temporal.Duration.from("PT1M"),
};

const window = {
    start: Temporal.Instant.from("2027-06-01T00:00:00Z"),
    end: Temporal.Instant.from("2027-06-04T23:59:59Z"),
};

const at = (value: string) => Temporal.Instant.from(value);

const createStubClient = (
    responses: Array<CurrentSchedule | Error>,
): EventailClient & { tags: Array<string | null>; signals: Array<AbortSignal | undefined> } => {
    const tags: Array<string | null> = [];
    const signals: Array<AbortSignal | undefined> = [];

    return {
        tags,
        signals,
        fetchCurrentSchedule: async (entityTag, signal) => {
            tags.push(entityTag);
            signals.push(signal);
            const next = responses.shift();

            if (next instanceof Error) {
                throw next;
            }

            assert.ok(next, "the stub ran out of responses");

            return next;
        },
    };
};

const fetched = (entityTag: string | null): CurrentSchedule => ({
    status: "fetched",
    document: deserializeScheduleDocument(scheduleDocument),
    entityTag,
});

const recordCalls = (store: DocumentStore) => {
    const calls: string[] = [];

    return {
        calls,
        store: {
            ...store,
            store: (...args: Parameters<DocumentStore["store"]>) => {
                calls.push("store");
                store.store(...args);
            },
            confirmUnchanged: (...args: Parameters<DocumentStore["confirmUnchanged"]>) => {
                calls.push("confirmUnchanged");
                store.confirmUnchanged(...args);
            },
            markNotPublished: (...args: Parameters<DocumentStore["markNotPublished"]>) => {
                calls.push("markNotPublished");
                store.markNotPublished(...args);
            },
        },
    };
};

const mapping = {
    locale: new Intl.Locale("en"),
    descriptionSource: "abstract",
    venue: { id: "main", name: "Test Hotel" },
    sourceName: "eventail",
    appVersion: "1.2.3",
} satisfies Omit<MapScheduleOptions, "schedule" | "updatedAt">;

const createSubject = (
    responses: Array<CurrentSchedule | Error>,
    overrideIntervals: RefreshIntervals = intervals,
) => {
    const recorded = recordCalls(
        createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") }),
    );
    const store = recorded.store;
    const client = createStubClient(responses);
    const refresher = createRefresher({
        client,
        store,
        intervals: overrideIntervals,
        mapping,
    });

    return { store, client, refresher, calls: recorded.calls };
};

describe("createRefresher", () => {
    it("stores a rebuilt document and presents its validator on the next fetch", async () => {
        const { store, client, refresher } = createSubject([
            fetched('W/"one"'),
            { status: "not_modified" },
        ]);

        await refresher.refresh();
        assert.equal(store.read(Temporal.Now.instant()).kind, "document");

        await refresher.refresh();
        assert.deepEqual(client.tags, [null, 'W/"one"']);
    });

    it("counts a 304 as a successful refresh rather than doing nothing", async () => {
        const { refresher, calls } = createSubject([
            fetched('W/"one"'),
            { status: "not_modified" },
        ]);

        await refresher.refresh();
        await refresher.refresh();

        assert.deepEqual(calls, ["store", "confirmUnchanged"]);
    });

    it("leaves the stamp and the validator alone when a rebuild changes nothing", async () => {
        const { store, refresher, calls } = createSubject([fetched('W/"one"'), fetched('W/"two"')]);

        await refresher.refresh();
        const first = store.read(Temporal.Now.instant());

        await refresher.refresh();
        const second = store.read(Temporal.Now.instant());

        assert.deepEqual(calls, ["store", "confirmUnchanged"]);
        assert.equal(
            first.kind === "document" && second.kind === "document"
                ? first.entityTag === second.entityTag && first.body === second.body
                : null,
            true,
        );
    });

    it("hands the store the window the publication announced", async () => {
        const { store, refresher } = createSubject([fetched(null)]);
        await refresher.refresh();

        assert.equal(store.window()?.start.toString(), "2027-05-31T22:00:00Z");
        assert.equal(store.window()?.end.toString(), "2027-06-04T21:59:59Z");
    });

    it("treats a 404 as an unpublished edition only while nothing has been served", async () => {
        const { store, refresher } = createSubject([new JsonApiError("gone", 404, [])]);

        await refresher.refresh();
        assert.equal(store.read(Temporal.Now.instant()).kind, "not_published");
    });

    it("keeps serving a document when the schedule later 404s", async () => {
        const { store, refresher } = createSubject([
            fetched('W/"one"'),
            new JsonApiError("gone", 404, []),
        ]);

        await refresher.refresh();
        await refresher.refresh();

        assert.equal(store.read(Temporal.Now.instant()).kind, "document");
    });

    it("keeps the document when a refresh fails outright", async () => {
        const { store, refresher } = createSubject([
            fetched('W/"one"'),
            new Error("connection refused"),
        ]);

        await refresher.refresh();
        await refresher.refresh();

        assert.equal(store.read(Temporal.Now.instant()).kind, "document");
    });
});

/**
 * Stubs the store's read rather than reaching the ceiling through real time.
 *
 * Waiting one out would stall the test, and a zero ceiling makes every later
 * read stale too, including the one the recovery is supposed to produce.
 */
const withCeilingPassed = async (
    store: DocumentStore,
    body: () => Promise<void>,
): Promise<void> => {
    const real = store.read;
    store.read = () => ({
        kind: "too_stale",
        since: Temporal.Instant.from("2020-01-01T00:00:00Z"),
    });

    try {
        await body();
    } finally {
        store.read = real;
    }
};

describe("createRefresher recovery", () => {
    it("serves an identical schedule again after a 404 discarded the document", async () => {
        const { store, refresher } = createSubject([
            fetched('W/"one"'),
            new JsonApiError("gone", 404, []),
            fetched('W/"one"'),
        ]);

        await refresher.refresh();
        await withCeilingPassed(store, async () => {
            await refresher.refresh();
        });
        assert.equal(store.read(Temporal.Now.instant()).kind, "not_published");

        await refresher.refresh();
        assert.equal(store.read(Temporal.Now.instant()).kind, "document");
    });

    it("keeps a served document when a 404 arrives while it is still fresh", async () => {
        const { store, refresher } = createSubject([
            fetched('W/"one"'),
            new JsonApiError("gone", 404, []),
        ]);

        await refresher.refresh();
        await refresher.refresh();

        assert.equal(store.read(Temporal.Now.instant()).kind, "document");
    });

    it("sends no validator on the fetch after the document was discarded", async () => {
        const { store, client, refresher } = createSubject([
            fetched('W/"one"'),
            new JsonApiError("gone", 404, []),
            fetched('W/"one"'),
        ]);

        await refresher.refresh();
        await withCeilingPassed(store, async () => {
            await refresher.refresh();
        });
        await refresher.refresh();

        assert.deepEqual(client.tags, [null, 'W/"one"', null]);
    });

    it("hands the shutdown signal to the request so it can be canceled", async () => {
        const { refresher, client } = createSubject([fetched(null)]);
        const controller = new AbortController();

        await refresher.refresh(controller.signal);

        assert.equal(client.signals.length, 1);
        assert.equal(client.signals[0]?.aborted, false);
        controller.abort();
        assert.equal(client.signals[0]?.aborted, true);
    });
});

describe("createRefresher().run", () => {
    it("wakes out of the sleep on the signal rather than serving out the interval", async () => {
        const { refresher, client } = createSubject([fetched(null), fetched(null)]);
        const controller = new AbortController();
        const running = refresher.run(controller.signal);

        while (client.tags.length === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }

        const started = Date.now();
        controller.abort();
        await running;

        assert.ok(Date.now() - started < 1_000, "shutdown waited on the sleep");
        assert.equal(client.tags.length, 1, "a second refresh ran after the abort");
    });

    it("does not reach the upstream at all when the signal is already aborted", async () => {
        const { refresher, client } = createSubject([fetched(null)]);
        const controller = new AbortController();
        controller.abort();

        await refresher.run(controller.signal);

        assert.deepEqual(client.tags, []);
    });

    it("keeps looping when the failure is outside what refreshing catches", async () => {
        // A 404 is what makes refresh() consult the store inside its own
        // catch block, which is where the throw then escapes from.
        const { store, client, refresher } = createSubject(
            [new JsonApiError("gone", 404, []), new JsonApiError("gone", 404, [])],
            {
                idle: Temporal.Duration.from("PT0.01S"),
                live: Temporal.Duration.from("PT0.01S"),
            },
        );
        let thrown = 0;
        store.read = () => {
            thrown += 1;
            throw new Error("the store is wedged");
        };

        const controller = new AbortController();
        const running = refresher.run(controller.signal);
        const deadline = Date.now() + 5_000;

        while (client.tags.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        controller.abort();
        await running;

        assert.ok(thrown > 0, "the store was never reached");
        assert.ok(client.tags.length >= 2, "the loop stopped after the first throw");
    });
});

describe("selectInterval", () => {
    it("idles while there is no window to be near", () => {
        assert.equal(selectInterval(at("2027-06-02T12:00:00Z"), null, intervals), intervals.idle);
    });

    it("idles well before and after the convention", () => {
        assert.equal(selectInterval(at("2027-05-01T00:00:00Z"), window, intervals), intervals.idle);
        assert.equal(selectInterval(at("2027-06-05T00:00:00Z"), window, intervals), intervals.idle);
    });

    it("goes live a day before it opens and stays until it closes", () => {
        assert.equal(selectInterval(at("2027-05-30T23:59:59Z"), window, intervals), intervals.idle);
        assert.equal(selectInterval(at("2027-05-31T00:00:00Z"), window, intervals), intervals.live);
        assert.equal(selectInterval(at("2027-06-04T23:59:59Z"), window, intervals), intervals.live);
        assert.equal(selectInterval(at("2027-06-05T00:00:00Z"), window, intervals), intervals.idle);
    });
});

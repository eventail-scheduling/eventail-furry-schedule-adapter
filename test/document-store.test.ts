import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDocumentStore } from "../src/document-store.js";

const at = (value: string) => Temporal.Instant.from(value);

const window = {
    start: at("2027-06-01T00:00:00Z"),
    end: at("2027-06-04T23:59:59Z"),
};

const createStore = () => createDocumentStore({ maxStaleness: Temporal.Duration.from("PT12H") });

describe("createDocumentStore", () => {
    it("reports nothing fetched before the first refresh", () => {
        assert.deepEqual(createStore().read(at("2027-01-01T00:00:00Z")), {
            kind: "never_fetched",
        });
    });

    it("tags a document by its own bytes, not by when it was built", () => {
        const tagOf = (body: string, storedAt: string): string => {
            const store = createStore();
            store.store(body, window, at(storedAt));
            const read = store.read(at(storedAt).add({ seconds: 1 }));
            assert.equal(read.kind, "document");

            return read.kind === "document" ? read.entityTag : "";
        };

        assert.equal(
            tagOf('{"a":1}', "2027-01-01T00:00:00Z"),
            tagOf('{"a":1}', "2027-05-05T05:05:05Z"),
        );
        assert.notEqual(
            tagOf('{"a":1}', "2027-01-01T00:00:00Z"),
            tagOf('{"a":2}', "2027-01-01T00:00:00Z"),
        );
    });

    it("serves a document up to the ceiling and refuses it past", () => {
        const store = createStore();
        store.store('{"a":1}', window, at("2027-01-01T00:00:00Z"));

        assert.equal(store.read(at("2027-01-01T11:59:59Z")).kind, "document");
        assert.equal(store.read(at("2027-01-01T12:00:00Z")).kind, "document");
        assert.equal(store.read(at("2027-01-01T12:00:01Z")).kind, "too_stale");
    });

    it("counts an unchanged refresh as a success", () => {
        const store = createStore();
        store.store('{"a":1}', window, at("2027-01-01T00:00:00Z"));
        store.confirmUnchanged(at("2027-01-01T11:00:00Z"));

        assert.equal(store.read(at("2027-01-01T22:00:00Z")).kind, "document");
        assert.equal(store.read(at("2027-01-01T23:00:01Z")).kind, "too_stale");
    });

    it("names when it last succeeded, so the failure can be dated", () => {
        const store = createStore();
        store.store('{"a":1}', window, at("2027-01-01T00:00:00Z"));
        const read = store.read(at("2027-01-02T00:00:00Z"));

        assert.equal(read.kind === "too_stale" && read.since.toString(), "2027-01-01T00:00:00Z");
    });

    it("reports staleness without judging whether the service should be restarted", () => {
        const store = createStore();
        assert.deepEqual(store.health(at("2027-01-01T00:00:00Z")), {
            state: "empty",
            stale: true,
            lastSuccessAt: null,
        });

        store.store('{"a":1}', window, at("2027-01-01T00:00:00Z"));
        assert.equal(store.health(at("2027-01-01T06:00:00Z")).stale, false);
        assert.equal(store.health(at("2027-01-02T06:00:00Z")).stale, true);
    });

    it("stays healthy while an edition has published nothing", () => {
        const store = createStore();
        store.markNotPublished(at("2027-01-01T00:00:00Z"));

        assert.equal(store.read(at("2027-01-01T00:00:01Z")).kind, "not_published");
        assert.equal(store.health(at("2027-01-01T00:00:01Z")).stale, false);
    });

    it("stops asserting an edition published nothing once refreshing has broken", () => {
        const store = createStore();
        store.markNotPublished(at("2027-01-01T00:00:00Z"));

        assert.equal(store.read(at("2027-01-01T06:00:00Z")).kind, "not_published");
        assert.equal(store.read(at("2027-01-02T06:00:00Z")).kind, "too_stale");
        assert.equal(store.health(at("2027-01-02T06:00:00Z")).stale, true);
    });

    it("has no window until a document is stored, which is what picks the interval", () => {
        const store = createStore();
        assert.equal(store.window(), null);

        store.store('{"a":1}', window, at("2027-01-01T00:00:00Z"));
        assert.equal(store.window()?.start.toString(), "2027-06-01T00:00:00Z");
    });
});

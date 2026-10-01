import { createHash } from "node:crypto";
import type { ConventionWindow } from "./furry-schedule/map-schedule.js";

type StoredDocument = {
    body: string;
    entityTag: string;
    window: ConventionWindow;
};

type State =
    | { kind: "empty" }
    | { kind: "not_published" }
    | { kind: "ready"; document: StoredDocument };

export type Served =
    | { kind: "document"; body: string; entityTag: string }
    | { kind: "not_published" }
    | { kind: "never_fetched" }
    | { kind: "too_stale"; since: Temporal.Instant };

export type Health = {
    state: State["kind"];
    stale: boolean;
    lastSuccessAt: string | null;
};

type StoreOptions = {
    maxStaleness: Temporal.Duration;
};

export const createDocumentStore = (options: StoreOptions) => {
    let state: State = { kind: "empty" };
    let lastSuccessAt: Temporal.Instant | null = null;

    const isTooStale = (now: Temporal.Instant): boolean => {
        if (lastSuccessAt === null) {
            return true;
        }

        return Temporal.Instant.compare(lastSuccessAt.add(options.maxStaleness), now) < 0;
    };

    return {
        store: (body: string, window: ConventionWindow, at: Temporal.Instant): void => {
            state = {
                kind: "ready",
                document: {
                    body,
                    // Over the bytes served, not eventail's validator, which
                    // does not move when the mapping changes those bytes.
                    entityTag: `"${createHash("sha256").update(body).digest("hex")}"`,
                    window,
                },
            };
            lastSuccessAt = at;
        },

        confirmUnchanged: (at: Temporal.Instant): void => {
            lastSuccessAt = at;
        },

        markNotPublished: (at: Temporal.Instant): void => {
            state = { kind: "not_published" };
            lastSuccessAt = at;
        },

        window: (): ConventionWindow | null =>
            state.kind === "ready" ? state.document.window : null,

        read: (now: Temporal.Instant): Served => {
            if (state.kind === "empty" || lastSuccessAt === null) {
                return { kind: "never_fetched" };
            }

            if (isTooStale(now)) {
                return { kind: "too_stale", since: lastSuccessAt };
            }

            if (state.kind === "not_published") {
                return { kind: "not_published" };
            }

            return {
                kind: "document",
                body: state.document.body,
                entityTag: state.document.entityTag,
            };
        },

        health: (now: Temporal.Instant): Health => ({
            state: state.kind,
            stale: isTooStale(now),
            lastSuccessAt: lastSuccessAt?.toString() ?? null,
        }),
    };
};

export type DocumentStore = ReturnType<typeof createDocumentStore>;

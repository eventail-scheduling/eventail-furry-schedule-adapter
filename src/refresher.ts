import { JsonApiError } from "@jsonapi-serde/client";
import type { DocumentStore } from "./document-store.js";
import type { EventailClient } from "./eventail/client.js";
import {
    type ConventionWindow,
    conventionWindow,
    type MapScheduleOptions,
    mapSchedule,
} from "./furry-schedule/map-schedule.js";
import { logger } from "./util/logger.js";

// Hours rather than a day: an instant carries no calendar, and subtracting a
// date unit from one throws.
const liveLead = Temporal.Duration.from("PT24H");

export type RefreshIntervals = {
    idle: Temporal.Duration;
    live: Temporal.Duration;
};

type RefresherOptions = {
    client: EventailClient;
    store: DocumentStore;
    intervals: RefreshIntervals;
    mapping: Omit<MapScheduleOptions, "schedule" | "updatedAt">;
};

export const selectInterval = (
    now: Temporal.Instant,
    window: ConventionWindow | null,
    intervals: RefreshIntervals,
): Temporal.Duration => {
    if (window === null) {
        return intervals.idle;
    }

    const live =
        Temporal.Instant.compare(now, window.start.subtract(liveLead)) >= 0 &&
        Temporal.Instant.compare(now, window.end) <= 0;

    return live ? intervals.live : intervals.idle;
};

const isNotPublished = (error: unknown): boolean =>
    error instanceof JsonApiError && error.status === 404;

export const createRefresher = (options: RefresherOptions) => {
    const { client, store, intervals } = options;
    let entityTag: string | null = null;
    let contentFingerprint: string | null = null;

    const refresh = async (signal?: AbortSignal): Promise<void> => {
        const now = Temporal.Now.instant();

        try {
            const current = await client.fetchCurrentSchedule(entityTag, signal);

            if (current.status === "not_modified") {
                store.confirmUnchanged(now);

                return;
            }

            const schedule = current.document.data;
            const timeZone = schedule.timeZone ?? schedule.edition.timeZone;
            const document = mapSchedule({ ...options.mapping, schedule, updatedAt: now });
            const { updatedAt: _stamp, ...content } = document;
            const fingerprint = JSON.stringify(content);

            entityTag = current.entityTag;

            if (fingerprint === contentFingerprint) {
                store.confirmUnchanged(now);

                return;
            }

            contentFingerprint = fingerprint;
            store.store(JSON.stringify(document), conventionWindow(schedule, timeZone), now);

            logger.info("Schedule document rebuilt", {
                events: document.events.length,
                entityTag,
            });
        } catch (error) {
            if (isNotPublished(error) && store.read(now).kind !== "document") {
                entityTag = null;
                contentFingerprint = null;
                store.markNotPublished(now);

                return;
            }

            if (error instanceof Error && error.name === "AbortError") {
                return;
            }

            logger.error("Could not refresh the schedule document", { error });
        }
    };

    return {
        refresh,

        /**
         * Runs until the signal aborts, sleeping between attempts rather than
         * on a timer, so a slow response cannot stack refreshes.
         *
         * Nothing thrown here may escape: a rejection would take the process
         * down while it is still serving requests.
         */
        run: async (signal: AbortSignal): Promise<void> => {
            while (!signal.aborted) {
                try {
                    await refresh(signal);
                } catch (error) {
                    logger.error("The refresh loop caught what refreshing did not", { error });
                }

                if (signal.aborted) {
                    return;
                }

                await sleep(
                    selectInterval(Temporal.Now.instant(), store.window(), intervals),
                    signal,
                );
            }
        },
    };
};

const sleep = (duration: Temporal.Duration, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted) {
            resolve();

            return;
        }

        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, duration.total("milliseconds"));

        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };

        signal.addEventListener("abort", onAbort, { once: true });
    });

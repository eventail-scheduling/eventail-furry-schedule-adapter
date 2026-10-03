import { handleJsonApiError } from "@jsonapi-serde/client";
import type { AccessTokenProvider } from "./access-token.js";
import { deserializeScheduleDocument, type ScheduleDocument } from "./schedule-document.js";

/**
 * Everything the document is built from, in one request.
 *
 * `slots.session.hosts` is a prefix of an allowed path rather than one itself,
 * which the query parser accepts. The full path would also load a host's own
 * answers, which nothing reads; a session's are named in full because the
 * membership levels come from one.
 */
const includePaths = [
    "slots.location",
    "slots.location.venue",
    "slots.session.hosts",
    "slots.session.track",
    "slots.session.sessionType",
    "slots.session.responses.customField",
].join(",");

export type CurrentSchedule =
    | { status: "not_modified" }
    | { status: "fetched"; document: ScheduleDocument; entityTag: string | null };

type ClientOptions = {
    baseUrl: string;
    accessTokens: AccessTokenProvider;
    editionId: string;
    requestTimeout: Temporal.Duration;
    fetch?: typeof globalThis.fetch;
};

export type EventailClient = {
    fetchCurrentSchedule: (
        entityTag: string | null,
        signal?: AbortSignal,
    ) => Promise<CurrentSchedule>;
};

export const createEventailClient = (options: ClientOptions): EventailClient => {
    const url = new URL(
        `${options.baseUrl}/editions/${options.editionId}/schedules/current?include=${includePaths}`,
    );
    const fetchImplementation = options.fetch ?? globalThis.fetch;

    return {
        fetchCurrentSchedule: async (entityTag, signal) => {
            const authorization = `Bearer ${await options.accessTokens.get(signal)}`;
            // After the token, not before: minting has its own budget, and a
            // slow provider would otherwise spend this one.
            const timeout = AbortSignal.timeout(options.requestTimeout.total("milliseconds"));

            const response = await fetchImplementation(url, {
                signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
                headers: {
                    accept: "application/vnd.api+json",
                    authorization,
                    ...(entityTag !== null && { "if-none-match": entityTag }),
                },
            });

            if (response.status === 304) {
                return { status: "not_modified" };
            }

            await handleJsonApiError(response);

            return {
                status: "fetched",
                document: deserializeScheduleDocument(await response.json()),
                entityTag: response.headers.get("etag"),
            };
        },
    };
};

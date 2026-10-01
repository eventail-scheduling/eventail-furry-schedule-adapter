import {
    type HeaderEntryLike,
    type HttpRequest,
    type HttpResponseLike,
    jsonResponse,
    StatusCode,
} from "@taxum/core/http";
import { createExtractHandler, m, Router } from "@taxum/core/routing";
import { match } from "ts-pattern";
import type { DocumentStore } from "./document-store.js";

/**
 * With no `type` the document is implicitly `about:blank`, for which RFC 9457
 * section 4.2.1 says `title` is the status phrase and the occurrence-specific
 * message belongs in `detail`.
 */
const problem = (status: StatusCode, detail: string): HttpResponseLike => [
    status,
    [
        ["content-type", "application/problem+json"],
        ["cache-control", "no-store"],
    ],
    JSON.stringify({ title: status.phrase, status: status.code, detail }),
];

/** The `header` extractor reads only the first; a client may send one per line. */
const ifNoneMatchValues = (req: HttpRequest): string[] =>
    req.headers.getAll("if-none-match").map((value) => value.value);

/** Weak comparison per RFC 9110 section 13.1.2, which ignores the W/ marker. */
const stripWeakPrefix = (tag: string): string => (tag.startsWith("W/") ? tag.slice(2) : tag);

const matchesEntityTag = (ifNoneMatch: string[], entityTag: string): boolean =>
    ifNoneMatch
        .flatMap((value) => value.split(","))
        .map((candidate) => stripWeakPrefix(candidate.trim()))
        .some((candidate) => candidate === "*" || candidate === stripWeakPrefix(entityTag));

export const createRouter = (store: DocumentStore): Router => {
    const scheduleHandler = createExtractHandler(ifNoneMatchValues).handler(async (ifNoneMatch) =>
        match(store.read(Temporal.Now.instant()))
            .with({ kind: "document" }, ({ body, entityTag }): HttpResponseLike => {
                const headers: HeaderEntryLike[] = [
                    ["etag", entityTag],
                    ["cache-control", "public, no-cache"],
                ];

                if (matchesEntityTag(ifNoneMatch, entityTag)) {
                    return [StatusCode.NOT_MODIFIED, headers, null];
                }

                return [StatusCode.OK, [...headers, ["content-type", "application/json"]], body];
            })
            .with({ kind: "not_published" }, () =>
                problem(StatusCode.NOT_FOUND, "This edition has no published schedule."),
            )
            .with({ kind: "never_fetched" }, () =>
                problem(StatusCode.SERVICE_UNAVAILABLE, "The schedule has not been read yet."),
            )
            .with({ kind: "too_stale" }, ({ since }) =>
                problem(
                    StatusCode.SERVICE_UNAVAILABLE,
                    `The schedule could not be refreshed since ${since.toString()} and is no` +
                        " longer served. See the service logs.",
                ),
            )
            .exhaustive(),
    );

    const healthHandler = (): HttpResponseLike => [
        StatusCode.OK,
        [["cache-control", "no-store"]],
        jsonResponse(store.health(Temporal.Now.instant())),
    ];

    return new Router()
        .route("/schedule.json", m.get(scheduleHandler))
        .route("/health", m.get(healthHandler))
        .fallback(() => problem(StatusCode.NOT_FOUND, "This service serves /schedule.json."))
        .methodNotAllowedFallback(() =>
            problem(StatusCode.METHOD_NOT_ALLOWED, "This service answers GET and HEAD."),
        );
};

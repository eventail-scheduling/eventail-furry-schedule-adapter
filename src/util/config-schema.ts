import { LogLevel } from "logforth";
import { z } from "zod";
import { zt } from "zod-temporal";

const logLevels = {
    trace: LogLevel.Trace,
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
    fatal: LogLevel.Fatal,
} as const;
type LogLevelName = keyof typeof logLevels;
const logLevelNames = Object.keys(logLevels) as [LogLevelName, ...LogLevelName[]];

const portSchema = z.int().min(1).max(65_535);

// total() needs a reference point for years, months, weeks and days, and
// throws without one, so every later check has to pass these through: zod runs
// a whole chain rather than stopping at the first failure.
const carriesCalendarUnits = (duration: Temporal.Duration): boolean =>
    duration.years !== 0 || duration.months !== 0 || duration.weeks !== 0 || duration.days !== 0;

const timeUnitDurationSchema = zt
    .duration()
    .refine(
        (duration) => !carriesCalendarUnits(duration),
        "Must use time units only, such as PT30M or PT24H",
    );

// setTimeout counts milliseconds in a signed 32-bit integer and fires at once
// past that; AbortSignal.timeout is built on it.
const timerLimit = 2_147_483_647;

const intervalDurationSchema = timeUnitDurationSchema.refine(
    (duration) =>
        carriesCalendarUnits(duration) ||
        (duration.total("milliseconds") >= 1_000 && duration.total("milliseconds") <= timerLimit),
    "Must be between PT1S and PT596H",
);

const positiveDurationSchema = timeUnitDurationSchema.refine(
    (duration) => carriesCalendarUnits(duration) || duration.total("milliseconds") > 0,
    "Must be positive",
);

const intervalDescription = "An ISO 8601 duration in time units only.";

const isLoopback = (value: string): boolean =>
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(value).hostname);

/**
 * Whether openid-client has to be told to accept this issuer.
 *
 * Answers false for an https issuer whatever else is set: the flag it gates
 * disables the HTTPS rule for every later request too, including the token
 * endpoint that carries the client secret, so it is never worth passing for
 * an issuer that does not need it.
 */
export const issuerNeedsInsecureRequests = (issuer: string, allowInsecure: boolean): boolean =>
    new URL(issuer).protocol !== "https:" && (isLoopback(issuer) || allowInsecure);

const issuerIsReachable = (issuer: string, allowInsecure: boolean): boolean =>
    new URL(issuer).protocol === "https:" || isLoopback(issuer) || allowInsecure;

/**
 * The pattern the schema names for a localized key, which it does not enforce.
 *
 * Every localized object declares it under `patternProperties` and none of
 * them sets `additionalProperties: false`, so a key outside it is carried
 * unvalidated rather than rejected. A consumer looking text up by matching
 * this pattern would still miss it, which is worth a warning and not a
 * refusal.
 */
export const documentKeyPattern = /^[a-z]{2}(-[A-Z]{2})?$/;

/** `Intl.Locale` normalizes case, so `en-gb` is accepted as the `en-GB` the schema names. */
const languageTagSchema = z.string().transform((value, ctx) => {
    try {
        return new Intl.Locale(value);
    } catch {
        ctx.addIssue({ code: "custom", message: `Not a language tag: ${value}` });

        return z.NEVER;
    }
});

export const configSchema = z.object({
    port: portSchema.default(3000).meta({ description: "The port the document is served on." }),
    log: z
        .object({
            level: z
                .enum(logLevelNames)
                .default("info")
                .transform((name) => logLevels[name]),
        })
        .prefault({})
        .meta({
            description:
                "Logging to standard output: JSON lines when NODE_ENV is production, readable " +
                "text otherwise.",
        }),
    eventail: z
        .object({
            baseUrl: z
                .url({ protocol: /^https?$/ })
                .transform((value) => value.replace(/\/+$/, ""))
                .meta({
                    description:
                        "The root of the eventail API. A trailing slash is ignored. The access " +
                        "token is sent here, so reach the API over https or over a network you " +
                        "trust. Plaintext is not refused, because an in-cluster address is the " +
                        "normal case and no rule separates one from a public host.",
                }),
            auth: z
                .object({
                    issuer: z.url({ protocol: /^https?$/ }).meta({
                        description:
                            "The OpenID Connect issuer to mint access tokens from. Its " +
                            "discovery document is fetched at startup, so the adapter does " +
                            "not start while the issuer is unreachable, and the document " +
                            "must name this same issuer back.",
                    }),
                    clientId: z.string().min(1).meta({
                        description: "The client credentials client the adapter authenticates as.",
                    }),
                    clientSecret: z
                        .string()
                        .min(1)
                        .meta({
                            description:
                                "Supply this through the environment rather than a config file: " +
                                "EVENTAIL_AUTH_CLIENT_SECRET. Anyone holding it can mint tokens " +
                                "with the adapter's access.",
                        }),
                    scope: z
                        .string()
                        .min(1)
                        .optional()
                        .meta({
                            description:
                                "Sent with the client credentials request when a provider " +
                                "needs one to issue a token carrying the right claims.",
                        }),
                    audience: z
                        .string()
                        .min(1)
                        .optional()
                        .meta({
                            description:
                                "Sent with the client credentials request. Auth0 needs it to " +
                                "issue a token for the API; a provider that maps the audience " +
                                "on the client instead, as Keycloak does, needs it left out. " +
                                "Either way it has to end up matching the API's jwt.audience.",
                        }),
                    allowInsecureIssuer: z
                        .boolean()
                        .default(false)
                        .meta({
                            description:
                                "Accept a plaintext issuer that is not on loopback. Needed " +
                                "only for a provider reached inside a cluster or a compose " +
                                "network, where there is no TLS to terminate. It also tells " +
                                "openid-client to drop its HTTPS rule for every request to " +
                                "that provider, including the one carrying the client secret.",
                        }),
                    tokenCachePath: z
                        .string()
                        .min(1)
                        .optional()
                        .meta({
                            description:
                                "A file to hold the access token between restarts, created " +
                                "0600. Left out, the token lives only in memory and every " +
                                "start mints a new one, which some providers meter. The entry " +
                                "is keyed by the credentials, so editing other settings " +
                                "reuses it. The adapter refuses to start if it cannot write " +
                                "here.",
                            examples: ["/var/cache/adapter/token.json"],
                        }),
                })
                .refine((auth) => issuerIsReachable(auth.issuer, auth.allowInsecureIssuer), {
                    error: "A plaintext issuer off loopback needs allowInsecureIssuer",
                    path: ["issuer"],
                })
                .meta({
                    description:
                        "The client credentials the adapter authenticates with. The API must " +
                        "accept the resulting token as an integration; any other kind of " +
                        "caller reads more, not less, and would publish unconfirmed sessions.",
                }),
            editionId: z.uuid().meta({ description: "The edition whose schedule is published." }),
            pollInterval: intervalDurationSchema.default(Temporal.Duration.from("PT15M")).meta({
                description:
                    "How often the published schedule is checked for a new revision outside " +
                    `the convention itself. ${intervalDescription}`,
                examples: ["PT5M", "PT1H"],
            }),
            livePollInterval: intervalDurationSchema.default(Temporal.Duration.from("PT1M")).meta({
                description:
                    "How often it is checked from the day before the convention opens until " +
                    "it closes, when a schedule moves far more than it does the rest of the " +
                    `year. ${intervalDescription}`,
                examples: ["PT30S"],
            }),
            requestTimeout: intervalDurationSchema.default(Temporal.Duration.from("PT30S")).meta({
                description:
                    "How long a single request may take, to the eventail API and to the " +
                    `identity provider alike. ${intervalDescription}`,
                examples: ["PT10S"],
            }),
        })
        .meta({ description: "Where the schedule is read from." }),
    document: z
        .object({
            language: languageTagSchema.meta({
                description:
                    "The language tag every localized string is keyed by. eventail stores one " +
                    "language per edition without naming it, so the tag is stated here. Case " +
                    "is normalized. A tag beyond a language and a region is accepted but " +
                    "warned about, since a consumer matching the pattern the schema names " +
                    "would not find the text.",
                examples: ["en", "de", "en-GB"],
            }),
            descriptionSource: z
                .enum(["abstract", "description"])
                .default("abstract")
                .meta({
                    description:
                        "Which session field becomes the event description. Both are optional " +
                        "per edition, so an edition that collects only one has to name it.",
                }),
            membershipCustomFieldKey: z
                .string()
                .min(1)
                .optional()
                .meta({
                    description:
                        "The external key of the choice question asked of sessions whose " +
                        "options are the membership levels, and whose answer says which ones " +
                        "an event is open to. Single and multiple choice both work. Left " +
                        "out, the document names no membership levels and restricts no " +
                        "event, and a key no session question carries does the same.",
                    examples: ["membership"],
                }),
            maxStaleness: positiveDurationSchema.default(Temporal.Duration.from("PT12H")).meta({
                description:
                    "How long the last document keeps being served once refreshing it stops " +
                    "working, measured from the last refresh that succeeded rather than the " +
                    "last attempted. Past it the document is refused rather than served " +
                    `stale, which is the only signal a consumer gets. ${intervalDescription}`,
                examples: ["PT6H", "PT24H"],
            }),
        })
        .meta({ description: "What the emitted document says." }),
    source: z
        .object({
            name: z.string().min(1).default("eventail"),
            vendorId: z.string().min(1).optional(),
        })
        .prefault({})
        .meta({ description: "Identifies this publisher to whoever consumes the document." }),
});

export type Config = z.output<typeof configSchema>;

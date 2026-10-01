import { serve } from "@taxum/core/server";
import { allowInsecureRequests, ClientSecretBasic, discovery } from "openid-client";
import { createDocumentStore } from "./document-store.js";
import { createAccessTokenProvider, verifyCacheUsable } from "./eventail/access-token.js";
import { createEventailClient } from "./eventail/client.js";
import { createRefresher } from "./refresher.js";
import { createRouter } from "./server.js";
import { appConfig } from "./util/app-config.js";
import { documentKeyPattern, isLoopback } from "./util/config-schema.js";
import { logger } from "./util/logger.js";
import { version } from "./util/version.js";

const language = appConfig.document.language.baseName;

if (!documentKeyPattern.test(language)) {
    logger.warn(
        "The configured language is outside the pattern the schema names for a localized key",
        { language, pattern: documentKeyPattern.source },
    );
}

const store = createDocumentStore({ maxStaleness: appConfig.document.maxStaleness });

// Before the first mint, so a path that cannot be written is a boot failure
// rather than something discovered after a token has been spent on it.
if (appConfig.eventail.auth.tokenCachePath !== undefined) {
    await verifyCacheUsable(appConfig.eventail.auth.tokenCachePath);
}

// Discovery validates that the document names the issuer it was fetched for.
const configuration = await discovery(
    new URL(appConfig.eventail.auth.issuer),
    appConfig.eventail.auth.clientId,
    {},
    ClientSecretBasic(appConfig.eventail.auth.clientSecret),
    {
        // Carried onto the Configuration, so it bounds every later token
        // request too rather than leaving them on the library's own default.
        timeout: appConfig.eventail.requestTimeout.total("seconds"),
        execute: isLoopback(appConfig.eventail.auth.issuer) ? [allowInsecureRequests] : [],
    },
);

const accessTokens = createAccessTokenProvider({
    configuration,
    identity: {
        issuer: appConfig.eventail.auth.issuer,
        clientId: appConfig.eventail.auth.clientId,
        clientSecret: appConfig.eventail.auth.clientSecret,
        audience: appConfig.eventail.auth.audience,
        scope: appConfig.eventail.auth.scope,
    },
    cachePath: appConfig.eventail.auth.tokenCachePath,
});

const refresher = createRefresher({
    client: createEventailClient({
        baseUrl: appConfig.eventail.baseUrl,
        accessTokens,
        editionId: appConfig.eventail.editionId,
        requestTimeout: appConfig.eventail.requestTimeout,
    }),
    store,
    intervals: {
        idle: appConfig.eventail.pollInterval,
        live: appConfig.eventail.livePollInterval,
    },
    mapping: {
        locale: appConfig.document.language,
        descriptionSource: appConfig.document.descriptionSource,
        venue: appConfig.venue,
        sourceName: appConfig.source.name,
        vendorId: appConfig.source.vendorId,
        appVersion: version,
    },
});

// Started before the listener rather than awaited before it, so a slow
// upstream answers 503 rather than leaving a startup probe with no socket.
const refreshes = new AbortController();
const running = refresher.run(refreshes.signal);

await serve(createRouter(store), {
    trustProxy: true,
    port: appConfig.port,
    catchCtrlC: true,
    shutdownTimeout: 5000,
    onListen: (address) => {
        logger.info(`Serving the schedule document on port ${address.port}`);
    },
});

refreshes.abort();
await running;

process.exit(0);

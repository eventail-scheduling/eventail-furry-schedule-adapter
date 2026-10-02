import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    configSchema,
    documentKeyPattern,
    issuerNeedsInsecureRequests,
} from "../../src/util/config-schema.js";

const parse = (language: string) =>
    configSchema.safeParse({
        eventail: {
            baseUrl: "http://localhost:12001",
            auth: { issuer: "http://localhost:12003/default", clientId: "c", clientSecret: "s" },
            editionId: "01a00548-4998-72d4-ad19-52975e052880",
        },
        document: { language },
    });

describe("configSchema language", () => {
    it("normalizes the case a tag is written in", () => {
        assert.equal(parse("en-gb").data?.document.language.baseName, "en-GB");
        assert.equal(parse("EN").data?.document.language.baseName, "en");
    });

    it("keeps a tag that is already normalized", () => {
        assert.equal(parse("de").data?.document.language.baseName, "de");
    });

    it("accepts a tag the schema's key pattern does not cover", () => {
        assert.equal(parse("zh-Hant").data?.document.language.baseName, "zh-Hant");
        assert.equal(parse("fil").data?.document.language.baseName, "fil");
        assert.equal(documentKeyPattern.test("zh-Hant"), false);
        assert.equal(documentKeyPattern.test("fil"), false);
    });

    it("refuses what cannot be parsed as a language tag", () => {
        assert.equal(parse("!!").success, false);
        assert.equal(parse("").success, false);
        assert.equal(parse("en-GB-").success, false);
    });
});

describe("configSchema baseUrl", () => {
    it("drops a trailing slash so a path can be appended to it", () => {
        const config = configSchema.safeParse({
            eventail: {
                baseUrl: "http://localhost:12001/",
                auth: {
                    issuer: "http://localhost:12003/default",
                    clientId: "c",
                    clientSecret: "s",
                },
                editionId: "01a00548-4998-72d4-ad19-52975e052880",
            },
            document: { language: "en" },
        });

        assert.equal(config.data?.eventail.baseUrl, "http://localhost:12001");
    });

    it("accepts a plaintext host, which is how the API is reached in a cluster", () => {
        // Deliberately unguarded, unlike the issuer: every working topology
        // reaches the API over plaintext on an internal address, and no rule
        // separates `api.eventail.svc.cluster.local` from a public host.
        assert.equal(parseBaseUrl("http://api:3000").success, true);
        assert.equal(parseBaseUrl("http://api.eventail.svc.cluster.local").success, true);
        assert.equal(parseBaseUrl("https://api.example.com").success, true);
    });

    it("still refuses a scheme that is not http at all", () => {
        assert.equal(parseBaseUrl("file:///etc/passwd").success, false);
    });
});

const parseInterval = (pollInterval: string) =>
    configSchema.safeParse({
        eventail: {
            baseUrl: "http://localhost:12001",
            auth: { issuer: "http://localhost:12003/default", clientId: "c", clientSecret: "s" },
            editionId: "01a00548-4998-72d4-ad19-52975e052880",
            pollInterval,
        },
        document: { language: "en" },
    });

const parseBaseUrl = (baseUrl: string) =>
    configSchema.safeParse({
        eventail: {
            baseUrl,
            auth: { issuer: "https://idp.example.com", clientId: "c", clientSecret: "s" },
            editionId: "01a00548-4998-72d4-ad19-52975e052880",
        },
        document: { language: "en" },
    });

const parseIssuer = (issuer: string, allowInsecureIssuer?: boolean) =>
    configSchema.safeParse({
        eventail: {
            baseUrl: "http://localhost:12001",
            editionId: "01a00548-4998-72d4-ad19-52975e052880",
            auth: {
                issuer,
                clientId: "c",
                clientSecret: "s",
                ...(allowInsecureIssuer !== undefined && { allowInsecureIssuer }),
            },
        },
        document: { language: "en" },
    });

describe("configSchema issuer", () => {
    it("refuses a plaintext issuer off loopback", () => {
        assert.equal(parseIssuer("http://idp.example.com").success, false);
        assert.equal(parseIssuer("https://idp.example.com").success, true);
    });

    it("allows plaintext on a loopback host, where it is a development provider", () => {
        assert.equal(parseIssuer("http://localhost:12003/default").success, true);
        assert.equal(parseIssuer("http://127.0.0.1:12003/default").success, true);
    });

    it("allows a plaintext issuer off loopback once it is opted into", () => {
        // A provider reached inside a cluster has no TLS to terminate.
        assert.equal(parseIssuer("http://oidc:8080/default", true).success, true);
    });

    it("refuses a scheme that is not http at all", () => {
        assert.equal(parseIssuer("file:///etc/passwd").success, false);
        assert.equal(parseIssuer("ftp://idp.example.com").success, false);
        assert.equal(parseIssuer("file:///etc/passwd", true).success, false);
    });

    it("keeps the issuer exactly as written", () => {
        // Auth0 issuers end in a slash and their discovery document says so,
        // so trimming one here makes the two disagree and discovery refuse.
        assert.equal(
            parseIssuer("https://idp.example.com/").data?.eventail.auth.issuer,
            "https://idp.example.com/",
        );
    });
});

describe("issuerNeedsInsecureRequests", () => {
    it("is false for an https issuer however it is opted into", () => {
        // The flag drops openid-client's HTTPS rule for every later request,
        // including the one carrying the client secret, so an issuer that
        // does not need it must never get it.
        assert.equal(issuerNeedsInsecureRequests("https://idp.example.com", true), false);
        assert.equal(issuerNeedsInsecureRequests("https://idp.example.com", false), false);
    });

    it("is true for plaintext on loopback or once opted into, and false otherwise", () => {
        assert.equal(issuerNeedsInsecureRequests("http://localhost:12003", false), true);
        assert.equal(issuerNeedsInsecureRequests("http://oidc:8080", true), true);
        assert.equal(issuerNeedsInsecureRequests("http://oidc:8080", false), false);
    });
});

describe("configSchema intervals", () => {
    it("refuses an interval short enough to make the loop a hot loop", () => {
        assert.equal(parseInterval("PT0.5S").success, false);
        assert.equal(parseInterval("PT1S").success, true);
    });

    it("refuses one longer than setTimeout can hold, which fires immediately", () => {
        assert.equal(parseInterval("PT596H").success, true);
        assert.equal(parseInterval("PT597H").success, false);
    });

    it("names the unit problem rather than throwing out of the parse", () => {
        const result = parseInterval("P1Y");

        assert.equal(result.success, false);
        assert.match(result.error?.issues[0]?.message ?? "", /time units only/);
    });

    it("polls faster during the convention than outside it", () => {
        const config = parseInterval("PT15M");

        assert.equal(config.data?.eventail.pollInterval.toString(), "PT15M");
        assert.equal(config.data?.eventail.livePollInterval.toString(), "PT1M");
    });
});

describe("configSchema staleness", () => {
    it("is not held to the timer bound the poll intervals are", () => {
        // It is compared against an instant rather than handed to setTimeout.
        const config = configSchema.safeParse({
            eventail: {
                baseUrl: "http://localhost:12001",
                auth: {
                    issuer: "http://localhost:12003/default",
                    clientId: "c",
                    clientSecret: "s",
                },
                editionId: "01a00548-4998-72d4-ad19-52975e052880",
            },
            document: { language: "en", maxStaleness: "PT720H" },
        });

        assert.equal(config.data?.document.maxStaleness.toString(), "PT720H");
    });

    it("holds a document for twelve hours by default", () => {
        assert.equal(
            parse("en").data?.document.maxStaleness.toString(),
            Temporal.Duration.from("PT12H").toString(),
        );
    });
});

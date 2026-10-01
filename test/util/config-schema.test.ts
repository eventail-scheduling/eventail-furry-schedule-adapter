import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configSchema, documentKeyPattern } from "../../src/util/config-schema.js";

const parse = (language: string) =>
    configSchema.safeParse({
        eventail: {
            baseUrl: "http://localhost:12001",
            auth: { issuer: "http://localhost:12003/default", clientId: "c", clientSecret: "s" },
            editionId: "01a00548-4998-72d4-ad19-52975e052880",
        },
        document: { language },
        venue: { id: "main", name: "Test Hotel" },
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
            venue: { id: "main", name: "Test Hotel" },
        });

        assert.equal(config.data?.eventail.baseUrl, "http://localhost:12001");
    });

    it("refuses plaintext, which would put the access token on the wire", () => {
        assert.equal(parseBaseUrl("http://api.example.com").success, false);
        assert.equal(parseBaseUrl("https://api.example.com").success, true);
    });

    it("allows plaintext on a loopback host, where it is a development API", () => {
        assert.equal(parseBaseUrl("http://localhost:12001").success, true);
        assert.equal(parseBaseUrl("http://127.0.0.1:12001").success, true);
    });

    it("refuses a scheme that is not http at all", () => {
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
        venue: { id: "main", name: "Test Hotel" },
    });

const parseBaseUrl = (baseUrl: string) =>
    configSchema.safeParse({
        eventail: {
            baseUrl,
            auth: { issuer: "https://idp.example.com", clientId: "c", clientSecret: "s" },
            editionId: "01a00548-4998-72d4-ad19-52975e052880",
        },
        document: { language: "en" },
        venue: { id: "main", name: "Test Hotel" },
    });

const parseIssuer = (issuer: string) =>
    configSchema.safeParse({
        eventail: {
            baseUrl: "http://localhost:12001",
            editionId: "01a00548-4998-72d4-ad19-52975e052880",
            auth: { issuer, clientId: "c", clientSecret: "s" },
        },
        document: { language: "en" },
        venue: { id: "main", name: "Test Hotel" },
    });

describe("configSchema issuer", () => {
    it("refuses plaintext, which would put the client secret on the wire", () => {
        assert.equal(parseIssuer("http://idp.example.com").success, false);
        assert.equal(parseIssuer("https://idp.example.com").success, true);
    });

    it("allows plaintext on a loopback host, where it is a development provider", () => {
        assert.equal(parseIssuer("http://localhost:12003/default").success, true);
        assert.equal(parseIssuer("http://127.0.0.1:12003/default").success, true);
    });

    it("refuses a scheme that is not http at all", () => {
        assert.equal(parseIssuer("file:///etc/passwd").success, false);
        assert.equal(parseIssuer("ftp://idp.example.com").success, false);
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
            venue: { id: "main", name: "Test Hotel" },
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

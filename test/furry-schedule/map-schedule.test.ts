import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deserializeScheduleDocument } from "../../src/eventail/schedule-document.js";
import { type MapScheduleOptions, mapSchedule } from "../../src/furry-schedule/map-schedule.js";
import { scheduleDocument } from "../fixtures/schedule-document.js";

const map = (overrides: Partial<MapScheduleOptions> = {}) =>
    mapSchedule({
        schedule: deserializeScheduleDocument(scheduleDocument).data,
        updatedAt: Temporal.Instant.from("2026-05-01T10:00:00Z"),
        locale: new Intl.Locale("en"),
        descriptionSource: "abstract",
        sourceName: "eventail",
        appVersion: "1.2.3",
        ...overrides,
    });

describe("mapSchedule", () => {
    it("drops sessions that are internal by track or by type", () => {
        const document = map();

        assert.deepEqual(
            document.events.map((event) => event.id),
            ["session-1", "session-2"],
        );
        assert.deepEqual(
            document.tracks.map((track) => track.id),
            ["track-1"],
        );
        assert.deepEqual(
            document.eventTypes.map((eventType) => eventType.id),
            ["type-1"],
        );
    });

    it("gives a session slotted twice one event with both time slots", () => {
        const event = map().events.find((candidate) => candidate.id === "session-1");

        assert.deepEqual(event?.timeSlots, [
            {
                startTime: "2027-06-01T14:00:00+02:00",
                endTime: "2027-06-01T15:00:00+02:00",
                venueId: "venue-1",
                roomId: "room-1",
            },
            {
                startTime: "2027-06-03T14:00:00+02:00",
                endTime: "2027-06-03T15:00:00+02:00",
                venueId: "venue-1",
                roomId: "room-1",
            },
        ]);
    });

    it("dates the convention across the publication's window in its own zone", () => {
        const { convention } = map();

        assert.equal(convention.startDate, "2027-06-01T00:00:00+02:00");
        assert.equal(convention.endDate, "2027-06-04T23:59:59+02:00");
        assert.equal(convention.timezone, "Europe/Berlin");
    });

    it("takes the event description from the configured field", () => {
        const fromAbstract = map().events.find((event) => event.id === "session-1");
        const fromDescription = map({ descriptionSource: "description" }).events.find(
            (event) => event.id === "session-1",
        );

        assert.deepEqual(fromAbstract?.description, { en: "A short teaser." });
        assert.deepEqual(fromDescription?.description, { en: "The long text." });
    });

    it("omits the description when the configured field is empty", () => {
        const event = map().events.find((candidate) => candidate.id === "session-2");

        assert.equal("description" in (event ?? {}), false);
    });

    it("references only ids it also carries", () => {
        const document = map();

        // Every loop below is over events, so an empty set passes vacuously.
        assert.ok(document.events.length > 0);

        const trackIds = new Set(document.tracks.map((track) => track.id));
        const typeIds = new Set(document.eventTypes.map((eventType) => eventType.id));
        const roomIds = new Set(document.rooms.map((room) => room.id));
        const venueIds = new Set(document.venues.map((venue) => venue.id));
        const hostIds = new Set(document.hosts.map((host) => host.id));

        for (const event of document.events) {
            assert.ok(typeIds.has(event.typeId), `event ${event.id} names an absent type`);

            if (event.trackId !== null) {
                assert.ok(trackIds.has(event.trackId), `event ${event.id} names an absent track`);
            }

            for (const hostId of event.hostIds) {
                assert.ok(hostIds.has(hostId), `event ${event.id} names an absent host`);
            }

            for (const timeSlot of event.timeSlots) {
                assert.ok(roomIds.has(timeSlot.roomId), `event ${event.id} names an absent room`);
                assert.ok(
                    venueIds.has(timeSlot.venueId),
                    `event ${event.id} names an absent venue`,
                );
            }
        }

        for (const room of document.rooms) {
            assert.ok(venueIds.has(room.venueId), `room ${room.id} names an absent venue`);
        }
    });

    it("orders a session's time slots chronologically, not as the document listed them", () => {
        // The document lists slot-3 first; only `included` reads in order.
        const event = map().events.find((candidate) => candidate.id === "session-1");

        assert.deepEqual(
            event?.timeSlots.map((timeSlot) => timeSlot.startTime),
            ["2027-06-01T14:00:00+02:00", "2027-06-03T14:00:00+02:00"],
        );
    });

    it("orders events by when they first start", () => {
        assert.deepEqual(
            map().events.map((event) => event.timeSlots[0].startTime),
            ["2027-06-01T14:00:00+02:00", "2027-06-02T11:00:00+02:00"],
        );
    });

    it("carries only the rooms the kept sessions use, in their configured order", () => {
        // room-3 is used by internal sessions alone, and the positions run
        // against the order the rooms are first used in, so neither the filter
        // nor the sort can pass by accident.
        assert.deepEqual(
            map().rooms.map((room) => room.id),
            ["room-2", "room-1"],
        );
    });

    it("carries each room's own venue, and only the venues a kept room sits in", () => {
        // venue-3 holds room-3 alone, which internal sessions alone use. The
        // venues come out of the slots, which are in time order, and venue-1 is
        // used first while sorting last, so neither the filter nor the sort can
        // pass by accident.
        assert.deepEqual(
            map().venues.map((entry) => entry.id),
            ["venue-2", "venue-1"],
        );
        assert.deepEqual(
            map().rooms.map((room) => [room.id, room.venueId]),
            [
                ["room-2", "venue-2"],
                ["room-1", "venue-1"],
            ],
        );
    });

    it("carries a venue's address only when it has one", () => {
        const venues = map().venues;

        const congress = venues.find((entry) => entry.id === "venue-1");
        const annex = venues.find((entry) => entry.id === "venue-2");

        assert.ok(congress);
        assert.ok(annex);
        assert.equal(congress.address, "1 Example Street");
        assert.ok(!("address" in annex));
    });

    describe("membership levels", () => {
        const mapped = () => map({ membershipCustomFieldKey: "membership" });

        it("names nothing and restricts nothing until a question is configured", () => {
            const document = map();

            assert.equal(document.membershipLevels, undefined);
            assert.ok(document.events.every((event) => event.allowedMemberships === undefined));
        });

        it("catalogs every level the question offers, not only the ones an event names", () => {
            // session-1 answers two of the three, and a level nobody is on is
            // still a level the convention sells.
            assert.deepEqual(mapped().membershipLevels, [
                { id: "level-standard", name: { en: "Standard" } },
                { id: "level-vip", name: { en: "VIP" } },
                { id: "level-day", name: { en: "Day pass" } },
            ]);
        });

        it("restricts an event to the levels its session answered", () => {
            const event = mapped().events.find((candidate) => candidate.id === "session-1");

            assert.deepEqual(event?.allowedMemberships, ["level-vip", "level-day"]);
        });

        // Absent rather than empty: an empty list reads as open to nobody.
        it("leaves an event that answered nothing unrestricted", () => {
            const event = mapped().events.find((candidate) => candidate.id === "session-2");

            assert.ok(event);
            assert.ok(!("allowedMemberships" in event));
        });

        // A key can land on a question that offers no options at all, and a
        // bare answer would otherwise become an id the document never defines.
        it("names nothing when the key points at a question offering no options", () => {
            const document = map({ membershipCustomFieldKey: "notes" });

            assert.equal(document.membershipLevels, undefined);
            assert.ok(document.events.every((event) => event.allowedMemberships === undefined));
        });

        it("reads a single choice answer as the one level it names", () => {
            const singleChoice = structuredClone(scheduleDocument) as typeof scheduleDocument;
            const included = singleChoice.included as Record<string, unknown>[];
            const answer = included.find((entry) => entry.id === "response-1");
            const question = included.find((entry) => entry.id === "cf-membership");
            (answer as { attributes: Record<string, unknown> }).attributes.value = "level-vip";
            (
                (question as { attributes: Record<string, unknown> }).attributes as {
                    options: Record<string, unknown>;
                }
            ).options.type = "single_choice";

            const document = mapSchedule({
                schedule: deserializeScheduleDocument(singleChoice).data,
                updatedAt: Temporal.Instant.from("2026-05-01T10:00:00Z"),
                locale: new Intl.Locale("en"),
                descriptionSource: "abstract",
                membershipCustomFieldKey: "membership",
                sourceName: "eventail",
                appVersion: "1.2.3",
            });
            const event = document.events.find((candidate) => candidate.id === "session-1");

            assert.deepEqual(event?.allowedMemberships, ["level-vip"]);
        });

        it("names nothing when the configured question is not the one asked", () => {
            const document = map({ membershipCustomFieldKey: "not-a-question" });

            assert.equal(document.membershipLevels, undefined);
            assert.ok(document.events.every((event) => event.allowedMemberships === undefined));
        });
    });

    it("gives a host an image only when they have one", () => {
        const hosts = map().hosts;

        assert.equal(
            hosts.find((host) => host.id === "host-2")?.imageBannerUrl,
            "http://localhost:12006/uploads/hosts/host-2/avatar.webp",
        );
        assert.equal("imageBannerUrl" in (hosts.find((host) => host.id === "host-1") ?? {}), false);
    });

    it("carries only the hosts of the sessions it kept", () => {
        // host-3 hosts nothing else, so their absence is what proves the
        // filter reaches hosts. host-1 hosts an internal session as well as a
        // kept one, and has to survive it.
        assert.deepEqual(
            map().hosts.map((host) => host.id),
            ["host-2", "host-1"],
        );
    });
});

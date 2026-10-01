import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deserializeScheduleDocument } from "../../src/eventail/schedule-document.js";
import { scheduleDocument } from "../fixtures/schedule-document.js";

describe("deserializeScheduleDocument", () => {
    it("reads the publication window and the edition's separately", () => {
        const { data } = deserializeScheduleDocument(scheduleDocument);

        assert.equal(data.startDate?.toString(), "2027-06-01");
        assert.equal(data.timeZone, "Europe/Berlin");
        assert.equal(data.edition.startDate.toString(), "2027-07-01");
        assert.equal(data.edition.timeZone, "America/New_York");
    });

    it("keeps the slots in the order the document listed them", () => {
        // The mapper sorts; the deserializer must not, or the mapper's sort
        // would be untestable through it.
        const { data } = deserializeScheduleDocument(scheduleDocument);

        assert.deepEqual(
            data.slots.map((slot) => slot.startsAt.toString()),
            [
                "2027-06-03T12:00:00Z",
                "2027-06-02T09:00:00Z",
                "2027-06-01T12:00:00Z",
                "2027-06-01T07:00:00Z",
                "2027-06-01T08:00:00Z",
            ],
        );
    });

    it("resolves a slot through to its session, location and hosts", () => {
        const { data } = deserializeScheduleDocument(scheduleDocument);
        const slot = data.slots[0];

        assert.equal(slot.startsAt.toString(), "2027-06-03T12:00:00Z");
        assert.equal(slot.location.name, "Main Stage");
        assert.equal(slot.session.title, "Opening Ceremony");
        assert.equal(slot.session.sessionType.name, "Panel");
        assert.deepEqual(
            slot.session.hosts.map((host) => host.displayName),
            ["Zoe Speaker", "Adrian Speaker"],
        );
    });

    it("keeps a session that is on no track", () => {
        const { data } = deserializeScheduleDocument(scheduleDocument);

        assert.equal(data.slots[0].session.track?.name, "Main");
        assert.equal(data.slots[1].session.track, null);
    });
});

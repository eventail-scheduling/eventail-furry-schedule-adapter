type SessionOptions = {
    title: string;
    abstract: string;
    description: string;
    hostIds: string[];
    typeId: string;
    trackId: string | null;
    teaserImage?: Record<string, unknown>;
};

const slot = (
    id: string,
    startsAt: string,
    endsAt: string,
    sessionId: string,
    locationId: string,
) => ({
    type: "slot",
    id,
    attributes: {
        stableId: `stable-${id}`,
        startsAt,
        endsAt,
        setupTime: "PT0S",
        teardownTime: "PT0S",
    },
    relationships: {
        session: { data: { type: "session", id: sessionId } },
        location: { data: { type: "location", id: locationId } },
    },
});

const session = (id: string, options: SessionOptions) => ({
    type: "session",
    id,
    attributes: {
        createdAt: "2026-04-01T09:00:00Z",
        state: "confirmed",
        title: options.title,
        abstract: options.abstract,
        description: options.description,
        duration: null,
        setupTime: null,
        teardownTime: null,
        teaserImage: options.teaserImage ?? null,
    },
    relationships: {
        hosts: { data: options.hostIds.map((hostId) => ({ type: "host", id: hostId })) },
        sessionType: { data: { type: "session_type", id: options.typeId } },
        track: {
            data: options.trackId === null ? null : { type: "track", id: options.trackId },
        },
    },
});

const location = (
    id: string,
    name: string,
    externalKey: string,
    position: number,
    venueId: string,
) => ({
    type: "location",
    id,
    attributes: { name, externalKey, position },
    relationships: { venue: { data: { type: "venue", id: venueId } } },
});

const venue = (id: string, name: string, position: number, address: string | null = null) => ({
    type: "venue",
    id,
    attributes: { name, address, externalKey: null, position },
});

const host = (id: string, displayName: string, avatar: Record<string, unknown> | null = null) => ({
    type: "host",
    id,
    attributes: { displayName, biography: "Writes things.", avatar },
});

const avatar = {
    key: "hosts/host-2/avatar.webp",
    filename: "avatar.webp",
    url: "http://localhost:12006/uploads/hosts/host-2/avatar.webp",
    thumbnailUrl: "http://localhost:12006/uploads/hosts/host-2/thumb.webp",
    processing: false,
};

const sessionType = (id: string, name: string, internal: boolean) => ({
    type: "session_type",
    id,
    attributes: {
        name,
        externalKey: null,
        defaultDuration: "PT1H",
        internal,
        selectionDefault: false,
    },
});

const track = (id: string, name: string, description: string, internal: boolean) => ({
    type: "track",
    id,
    attributes: { name, externalKey: null, description, color: "#ff0000", internal },
});

/**
 * A published schedule as eventail serves an integration.
 *
 * Hand-built from the serializers in eventail's api/src/json-api, so only a
 * request against a running API can show the two still agree.
 *
 * The shape is load-bearing in several tests at once, so simplifying any of
 * it makes a filter or a sort pass by accident. Note that `included` lists
 * the slots in chronological order while the relationship driving them does
 * not: the order that matters is the one in `data.relationships.slots`.
 */
export const scheduleDocument = {
    data: {
        type: "schedule",
        id: "schedule-1",
        attributes: {
            createdAt: "2026-05-01T09:00:00Z",
            publishedAt: "2026-05-01T10:00:00Z",
            startDate: "2027-06-01",
            endDate: "2027-06-04",
            timeZone: "Europe/Berlin",
            preliminary: false,
        },
        relationships: {
            edition: { data: { type: "edition", id: "ed-1" } },
            slots: {
                data: [
                    { type: "slot", id: "slot-3" },
                    { type: "slot", id: "slot-2" },
                    { type: "slot", id: "slot-1" },
                    { type: "slot", id: "slot-5" },
                    { type: "slot", id: "slot-4" },
                ],
            },
        },
    },
    included: [
        {
            type: "edition",
            id: "ed-1",
            attributes: {
                name: "Testing Edition 2027",
                // Deliberately not the publication's window, which moved after
                // the schedule went out.
                startDate: "2027-07-01",
                endDate: "2027-07-04",
                timeZone: "America/New_York",
                submissionDeadline: null,
            },
        },
        slot("slot-1", "2027-06-01T12:00:00Z", "2027-06-01T13:00:00Z", "session-1", "room-1"),
        slot("slot-2", "2027-06-02T09:00:00Z", "2027-06-02T10:30:00Z", "session-2", "room-2"),
        slot("slot-3", "2027-06-03T12:00:00Z", "2027-06-03T13:00:00Z", "session-1", "room-1"),
        slot("slot-4", "2027-06-01T08:00:00Z", "2027-06-01T09:00:00Z", "session-3", "room-3"),
        slot("slot-5", "2027-06-01T07:00:00Z", "2027-06-01T08:00:00Z", "session-4", "room-3"),
        session("session-1", {
            title: "Opening Ceremony",
            abstract: "A short teaser.",
            description: "The long text.",
            hostIds: ["host-1", "host-2"],
            typeId: "type-1",
            trackId: "track-1",
            teaserImage: {
                key: "sessions/session-1/teaser.webp",
                filename: "teaser.webp",
                url: "http://localhost:12006/uploads/sessions/session-1/teaser.webp",
                thumbnailUrl: "http://localhost:12006/uploads/sessions/session-1/thumb.webp",
                processing: false,
            },
        }),
        session("session-2", {
            title: "Trackless Panel",
            abstract: "",
            description: "Only a description.",
            hostIds: [],
            typeId: "type-1",
            trackId: null,
        }),
        session("session-3", {
            title: "Staff Briefing",
            abstract: "Internal by track.",
            description: "",
            hostIds: ["host-1", "host-3"],
            typeId: "type-1",
            trackId: "track-2",
        }),
        session("session-4", {
            title: "Tech Rehearsal",
            abstract: "Internal by type.",
            description: "",
            hostIds: ["host-1"],
            typeId: "type-2",
            trackId: "track-1",
        }),
        location("room-1", "Main Stage", "main", 1, "venue-1"),
        location("room-2", "Panel Room", "panels", 0, "venue-2"),
        location("room-3", "Staff Room", "staff", 2, "venue-3"),
        venue("venue-1", "Congress Center", 1, "1 Example Street"),
        venue("venue-2", "Annex", 0),
        venue("venue-3", "Staff Building", 2),
        host("host-1", "Zoe Speaker"),
        host("host-2", "Adrian Speaker", avatar),
        host("host-3", "Mallory Staff"),
        sessionType("type-1", "Panel", false),
        sessionType("type-2", "Rehearsal", true),
        track("track-1", "Main", "The main track.", false),
        track("track-2", "Staff", "", true),
    ],
};

import type { Schedule, Session, Slot } from "../eventail/schedule-document.js";
import type {
    Convention,
    EventType,
    FurryScheduleDocument,
    Host,
    LocalizedText,
    Room,
    ScheduleEvent,
    Track,
    Venue,
} from "./document.js";

const schemaVersion = "1.0.0";

export type MapScheduleOptions = {
    schedule: Schedule;
    /** When the content last changed, which is not when the document was last built. */
    updatedAt: Temporal.Instant;
    locale: Intl.Locale;
    descriptionSource: "abstract" | "description";
    sourceName: string;
    vendorId?: string | undefined;
    appVersion: string;
};

/**
 * `internal` marks where a session belongs, a rehearsal or a briefing, rather
 * than who may read it, so the integration is served it and filters it here.
 */
const isPublic = (session: Session): boolean =>
    !session.sessionType.internal && session.track?.internal !== true;

const byId = <T extends { id: string }>(items: T[]): T[] => {
    const unique = new Map(items.map((item) => [item.id, item]));

    return [...unique.values()];
};

const groupSlotsBySession = (slots: Slot[]): Map<string, Slot[]> => {
    const grouped = new Map<string, Slot[]>();

    for (const slot of slots) {
        const existing = grouped.get(slot.session.id);

        if (existing) {
            existing.push(slot);
            continue;
        }

        grouped.set(slot.session.id, [slot]);
    }

    return grouped;
};

/**
 * Turns one publication into the document a consumer reads.
 *
 * Every timestamp but `updatedAt` is rendered in the convention's zone with an
 * offset rather than as UTC, which the schema files do not say but its guide
 * does: "Provide event startTime/endTime in local time with an offset, and
 * store the official con timezone at the top level" (docs/index.md). Both
 * forms name the same instant and both validate, so nothing catches the
 * wrong one.
 */
export const mapSchedule = (options: MapScheduleOptions): FurryScheduleDocument => {
    const { schedule, locale } = options;
    const localized = (text: string): LocalizedText => ({ [locale.baseName]: text });
    const timeZone = schedule.timeZone ?? schedule.edition.timeZone;

    const slots = schedule.slots
        .filter((slot) => isPublic(slot.session))
        .toSorted((left, right) => Temporal.Instant.compare(left.startsAt, right.startsAt));
    const sessions = byId(slots.map((slot) => slot.session));

    const events: ScheduleEvent[] = [...groupSlotsBySession(slots)].map(
        ([sessionId, sessionSlots]) => {
            const session = sessionSlots[0].session;
            const description = session[options.descriptionSource];

            return {
                id: sessionId,
                title: localized(session.title),
                ...(description !== "" && { description: localized(description) }),
                typeId: session.sessionType.id,
                trackId: session.track?.id ?? null,
                hostIds: session.hosts.map((host) => host.id),
                ...(session.teaserImage && { imageBannerUrl: session.teaserImage.url }),
                timeSlots: sessionSlots.map((slot) => ({
                    startTime: slot.startsAt.toString({ timeZone }),
                    endTime: slot.endsAt.toString({ timeZone }),
                    venueId: slot.location.venue.id,
                    roomId: slot.location.id,
                })),
            };
        },
    );

    const tracks: Track[] = byId(
        sessions.map((session) => session.track).filter((track) => track !== null),
    ).map((track) => ({
        id: track.id,
        name: localized(track.name),
        ...(track.description !== "" && { description: localized(track.description) }),
    }));

    const eventTypes: EventType[] = byId(sessions.map((session) => session.sessionType)).map(
        (sessionType) => ({ id: sessionType.id, name: localized(sessionType.name) }),
    );

    const rooms: Room[] = byId(slots.map((slot) => slot.location))
        .toSorted((left, right) => left.position - right.position)
        .map((location) => ({
            id: location.id,
            name: localized(location.name),
            venueId: location.venue.id,
        }));

    // The schema gives a host one image and calls it a banner. An avatar is
    // the only one eventail holds, and the wrong aspect ratio beats no image.
    const hosts: Host[] = byId(sessions.flatMap((session) => session.hosts))
        .toSorted((left, right) => left.displayName.localeCompare(right.displayName))
        .map((host) => ({
            id: host.id,
            displayName: host.displayName,
            ...(host.avatar && { imageBannerUrl: host.avatar.url }),
        }));

    const venues: Venue[] = byId(slots.map((slot) => slot.location.venue))
        .toSorted((left, right) => left.position - right.position)
        .map((venue) => ({
            id: venue.id,
            name: localized(venue.name),
            ...(venue.address !== null && { address: venue.address }),
        }));

    return {
        schemaVersion,
        updatedAt: options.updatedAt.toString(),
        source: {
            name: options.sourceName,
            appVersion: options.appVersion,
            ...(options.vendorId !== undefined && { vendorId: options.vendorId }),
        },
        convention: mapConvention(schedule, timeZone, localized),
        tracks: tracks.toSorted((left, right) => left.id.localeCompare(right.id)),
        eventTypes: eventTypes.toSorted((left, right) => left.id.localeCompare(right.id)),
        labels: [],
        venues,
        rooms,
        hosts,
        events,
    };
};

export type ConventionWindow = {
    start: Temporal.Instant;
    end: Temporal.Instant;
};

/**
 * Reads the window the publication announced, not the edition's current one.
 *
 * An edition is free to move after a schedule goes out, and the publication
 * stamps what was announced. Only a draft leaves the stamp unset.
 *
 * The window runs from the first moment of the first day to the last of the
 * last, which is how the schema's sample document dates a convention.
 */
export const conventionWindow = (schedule: Schedule, timeZone: string): ConventionWindow => {
    const startDate = schedule.startDate ?? schedule.edition.startDate;
    const endDate = schedule.endDate ?? schedule.edition.endDate;

    return {
        start: startDate.toZonedDateTime(timeZone).toInstant(),
        end: endDate
            .add({ days: 1 })
            .toZonedDateTime(timeZone)
            .subtract({ seconds: 1 })
            .toInstant(),
    };
};

const mapConvention = (
    schedule: Schedule,
    timeZone: string,
    localized: (text: string) => LocalizedText,
): Convention => {
    const window = conventionWindow(schedule, timeZone);

    return {
        id: schedule.edition.id,
        name: localized(schedule.edition.name),
        startDate: window.start.toString({ timeZone }),
        endDate: window.end.toString({ timeZone }),
        timezone: timeZone,
    };
};

/**
 * The document as https://github.com/Alofoxx/furry-schedule-schema defines it.
 *
 * Only the members this adapter emits are typed. The schema forbids unknown
 * members everywhere but `x-meta`, so adding one here means it is emitted.
 */
export type FurryScheduleDocument = {
    schemaVersion: string;
    updatedAt: string;
    source: Source;
    convention: Convention;
    tracks: Track[];
    eventTypes: EventType[];
    labels: Label[];
    venues: Venue[];
    rooms: Room[];
    hosts: Host[];
    events: ScheduleEvent[];
    membershipLevels?: MembershipLevel[];
};

/** Text keyed by language tag. */
export type LocalizedText = Record<string, string>;

export type Source = {
    name: string;
    appVersion: string;
    vendorId?: string;
};

export type Convention = {
    id: string;
    name: LocalizedText;
    startDate: string;
    endDate: string;
    timezone: string;
};

export type Track = {
    id: string;
    name: LocalizedText;
    description?: LocalizedText;
};

export type EventType = {
    id: string;
    name: LocalizedText;
};

export type Label = {
    id: string;
    name: LocalizedText;
    category: string;
    description?: LocalizedText;
};

export type Venue = {
    id: string;
    name: LocalizedText;
    address?: string;
};

export type Room = {
    id: string;
    name: LocalizedText;
    venueId: string;
};

export type Host = {
    id: string;
    displayName: string;
    imageBannerUrl?: string;
};

export type TimeSlot = {
    startTime: string;
    endTime: string;
    venueId: string;
    roomId: string;
};

export type ScheduleEvent = {
    id: string;
    title: LocalizedText;
    description?: LocalizedText;
    typeId: string;
    trackId: string | null;
    hostIds: string[];
    allowedMemberships?: string[];
    imageBannerUrl?: string;
    timeSlots: TimeSlot[];
};

export type MembershipLevel = {
    id: string;
    name: LocalizedText;
};

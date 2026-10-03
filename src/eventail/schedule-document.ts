import { createDeserializer, type Relationships } from "@jsonapi-serde/client";
import { z } from "zod";
import { zt } from "zod-temporal";

const imageSchema = z.object({
    url: z.url(),
    thumbnailUrl: z.url(),
    processing: z.boolean(),
});

/**
 * A choice answer holds the option ids.
 *
 * The API types a value as unknown because its shape follows the question, so
 * the shapes a membership mapping can read are named here and anything else
 * deserializes to no ids rather than refusing a document over a question
 * nobody reads.
 */
const choiceAnswerSchema = z.unknown().transform((value) => {
    if (typeof value === "string") {
        return [value];
    }

    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
});

const sessionRelationships = {
    responses: {
        type: "response",
        cardinality: "many",
        included: {
            attributesSchema: z.object({ value: choiceAnswerSchema }),
            relationships: {
                customField: {
                    type: "custom_field",
                    cardinality: "one",
                    included: {
                        attributesSchema: z.object({
                            externalKey: z.string().nullable(),
                            options: z
                                .object({
                                    items: z.array(z.object({ id: z.string(), label: z.string() })),
                                })
                                .nullable()
                                .catch(null),
                        }),
                    },
                },
            },
        },
    },
    hosts: {
        type: "host",
        cardinality: "many",
        included: {
            attributesSchema: z.object({
                displayName: z.string(),
                biography: z.string(),
                avatar: imageSchema.nullable(),
            }),
        },
    },
    sessionType: {
        type: "session_type",
        cardinality: "one",
        included: {
            attributesSchema: z.object({
                name: z.string(),
                externalKey: z.string().nullable(),
                internal: z.boolean(),
            }),
        },
    },
    track: {
        type: "track",
        cardinality: "one_nullable",
        included: {
            attributesSchema: z.object({
                name: z.string(),
                externalKey: z.string().nullable(),
                description: z.string(),
                internal: z.boolean(),
            }),
        },
    },
} satisfies Relationships;

/**
 * Deserializes the current schedule as an integration token is served it.
 *
 * Only the members the document is built from are declared. An attribute this
 * leaves out is dropped rather than refused, so adding one here is what makes
 * it arrive.
 */
export const deserializeScheduleDocument = createDeserializer({
    type: "schedule",
    cardinality: "one",
    attributesSchema: z.object({
        publishedAt: zt.instant().nullable(),
        startDate: zt.plainDate().nullable(),
        endDate: zt.plainDate().nullable(),
        timeZone: z.string().nullable(),
        preliminary: z.boolean(),
    }),
    relationships: {
        edition: {
            type: "edition",
            cardinality: "one",
            included: {
                attributesSchema: z.object({
                    name: z.string(),
                    startDate: zt.plainDate(),
                    endDate: zt.plainDate(),
                    timeZone: z.string(),
                }),
            },
        },
        slots: {
            type: "slot",
            cardinality: "many",
            included: {
                attributesSchema: z.object({
                    startsAt: zt.instant(),
                    endsAt: zt.instant(),
                }),
                relationships: {
                    location: {
                        type: "location",
                        cardinality: "one",
                        included: {
                            attributesSchema: z.object({
                                name: z.string(),
                                externalKey: z.string().nullable(),
                                position: z.int(),
                            }),
                            relationships: {
                                venue: {
                                    type: "venue",
                                    cardinality: "one",
                                    included: {
                                        attributesSchema: z.object({
                                            name: z.string(),
                                            address: z.string().nullable(),
                                            externalKey: z.string().nullable(),
                                            position: z.int(),
                                        }),
                                    },
                                },
                            },
                        },
                    },
                    session: {
                        type: "session",
                        cardinality: "one",
                        included: {
                            attributesSchema: z.object({
                                title: z.string(),
                                abstract: z.string(),
                                description: z.string(),
                                teaserImage: imageSchema.nullable(),
                            }),
                            relationships: sessionRelationships,
                        },
                    },
                },
            },
        },
    },
});

export type ScheduleDocument = ReturnType<typeof deserializeScheduleDocument>;
export type Schedule = ScheduleDocument["data"];
export type Slot = Schedule["slots"][number];
export type Session = Slot["session"];
export type Host = Session["hosts"][number];

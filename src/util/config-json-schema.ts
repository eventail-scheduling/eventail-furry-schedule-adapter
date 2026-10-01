import { noCase } from "change-case";
import { z } from "zod";
import { configSchema } from "./config-schema.js";

export type JsonSchemaNode = {
    type?: string;
    description?: string;
    properties?: Record<string, JsonSchemaNode>;
    "x-env"?: string;
    [keyword: string]: unknown;
};

/**
 * Mirrors how stilla's env provider matches a variable to a setting.
 *
 * Each path segment is split into words on case changes, and the words and
 * segments are joined with underscores, so `eventail.pollInterval` is
 * `EVENTAIL_POLL_INTERVAL`.
 */
const envName = (path: string[]): string =>
    path.map((segment) => noCase(segment, { delimiter: "_" }).toUpperCase()).join("_");

const addEnvNames = (node: JsonSchemaNode, path: string[]): void => {
    if (node.properties !== undefined) {
        for (const [key, child] of Object.entries(node.properties)) {
            addEnvNames(child, [...path, key]);
        }

        return;
    }

    node["x-env"] = node.type === "array" ? `${envName(path)}_<n>` : envName(path);
};

/**
 * Documents the settings as an operator writes them, before any transform.
 *
 * Throws when a setting has no JSON Schema form, rather than documenting it as
 * accepting anything. Every setting carries its environment variable in `x-env`.
 */
export const buildConfigJsonSchema = (): JsonSchemaNode => {
    const schema = z.toJSONSchema(configSchema, {
        io: "input",
        unrepresentable: "throw",
        override: ({ zodSchema, jsonSchema }) => {
            // zod drops examples from a transforming schema's input side,
            // counting them as output values; ours are all written as input.
            const examples = z.globalRegistry.get(zodSchema)?.examples;

            if (Array.isArray(examples)) {
                jsonSchema.examples = examples;
            }
        },
    }) as JsonSchemaNode;
    addEnvNames(schema, []);

    return schema;
};

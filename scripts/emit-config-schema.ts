import { writeFileSync } from "node:fs";
import { buildConfigJsonSchema } from "../src/util/config-json-schema.js";

writeFileSync("config.schema.json", `${JSON.stringify(buildConfigJsonSchema(), null, 4)}\n`);

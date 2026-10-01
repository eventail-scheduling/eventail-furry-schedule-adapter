import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// From the working directory, not the module: the image copies dist flat, so
// a module-relative path does not resolve at boot.
export const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")));

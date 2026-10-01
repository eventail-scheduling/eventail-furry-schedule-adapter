import { ConfigResolver } from "stilla";
import { configSchema } from "./config-schema.js";

const configResolver = ConfigResolver.default(configSchema);

export const appConfig = await configResolver.resolve();

import { Logger, NdJsonTransport, PrettyTransport } from "logforth";
import { appConfig } from "./app-config.js";

export const logger = new Logger({
    transport:
        process.env.NODE_ENV === "production" ? new NdJsonTransport() : new PrettyTransport(),
    minLevel: appConfig.log.level,
});

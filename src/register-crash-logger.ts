import { Logger, NdJsonTransport, PrettyTransport } from "logforth";

process.on("uncaughtException", (error: Error) => {
    const logger = new Logger({
        transport:
            process.env.NODE_ENV === "production" ? new NdJsonTransport() : new PrettyTransport(),
    });

    logger.fatal("Uncaught exception", { error });
    process.exit(1);
});

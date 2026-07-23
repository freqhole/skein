// vitest global setup: configures the shared logger for a debug-level
// default matching the app's own dev-mode default (boot.ts, the real entry
// point, is never imported in unit tests, so nothing else sets this).
import { configureLogging } from "@freqhole/reliquary/utils";

configureLogging({ level: "debug" });

// Entry point the runner starts (runs.main in action.yml).
import { main } from "./action.mjs";

process.exitCode = await main();

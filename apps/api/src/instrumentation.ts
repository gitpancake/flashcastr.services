import { config } from "dotenv";
import { initTracing } from "./tracing.js";

config();
initTracing();

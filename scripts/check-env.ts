import "dotenv/config";
import {
  printRuntimeValidation,
  validateRuntimeEnv,
} from "../src/server/config/env.js";

const result = validateRuntimeEnv();
printRuntimeValidation(result);

if (!result.ok) {
  console.error("[env] validation failed.");
  process.exit(1);
}

console.log("[env] validation passed.");

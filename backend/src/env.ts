import { config } from "dotenv";
import { join } from "path";

// Walk up from src/ to backend/ to find .env
config({ path: join(__dirname, "..", ".env") });

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

dotenv.config({ path: ".env.local" });
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("Missing DATABASE_URL environment variable.");
  process.exit(1);
}

const schemaPath = path.resolve("supabase", "schema.sql");
const sql = fs.readFileSync(schemaPath, "utf8");

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log("Supabase schema deployed successfully.");
}

run().catch(async (error) => {
  console.error("Schema deployment failed:", error.message);
  try {
    await client.end();
  } catch {
    // ignore cleanup errors
  }
  process.exit(1);
});
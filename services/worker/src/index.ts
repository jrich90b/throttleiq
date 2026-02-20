import "dotenv/config";

const tickSeconds = Number.parseInt(process.env.WORKER_TICK_SECONDS ?? "10", 10);
console.log("✅ Worker started");

setInterval(() => {
  console.log(`[worker] tick ${new Date().toISOString()}`);
}, tickSeconds * 1000);

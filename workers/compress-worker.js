const { parentPort } = require("node:worker_threads");
const zlib = require("node:zlib");

parentPort.on("message", (msg) => {
  const startedAt = process.hrtime.bigint();
  const input = Buffer.from(msg.buffer);
  const compressed = zlib.brotliCompressSync(input);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  parentPort.postMessage({ id: msg.id, buffer: compressed, durationMs });
});

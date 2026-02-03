function createProgressRenderer() {
  if (!process.stdout.isTTY) return null;
  try {
    const logUpdateModule = require("log-update");
    const logUpdate = logUpdateModule?.default || logUpdateModule;
    const ansiEscapes = require("ansi-escapes");
    const hideCursor = ansiEscapes?.cursorHide || "";
    const showCursor = ansiEscapes?.cursorShow || "";
    let rows = [];
    let active = true;

    const start = (total) => {
      rows = Array.from({ length: total }, () => "");
      if (hideCursor) process.stdout.write(hideCursor);
    };

    const update = (index, line) => {
      if (!active) return;
      const i = Math.max(1, index) - 1;
      rows[i] = line;
      logUpdate(rows.join("\n"));
    };

    const stop = () => {
      if (!active) return;
      active = false;
      logUpdate.done();
      if (showCursor) process.stdout.write(showCursor);
    };

    return { start, update, stop };
  } catch {
    return null;
  }
}

module.exports = {
  createProgressRenderer,
};

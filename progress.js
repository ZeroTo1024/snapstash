function createProgressRenderer({ windowSize = 30 } = {}) {
  if (!process.stdout.isTTY) return null;
  try {
    const logUpdateModule = require("log-update");
    const logUpdate = logUpdateModule?.default || logUpdateModule;
    const ansiEscapes = require("ansi-escapes");
    const hideCursor = ansiEscapes?.cursorHide || "";
    const showCursor = ansiEscapes?.cursorShow || "";
    let rows = [];
    let statuses = [];
    let total = 0;
    let active = true;

    const start = (count) => {
      total = count || 0;
      rows = Array.from({ length: total }, () => "");
      statuses = Array.from({ length: total }, () => "");
      if (hideCursor) process.stdout.write(hideCursor);
    };

    const update = (index, line, status) => {
      if (!active) return;
      const i = Math.max(1, index) - 1;
      rows[i] = line;
      statuses[i] = status || statuses[i] || "";
      const visible = rows.filter(Boolean);
      const windowRows = visible.slice(-windowSize);
      const doneCount = statuses.filter((s) => s === "done").length;
      const header = `\x1b[2mProgress: ${doneCount}/${total}\x1b[0m`;
      logUpdate([header, ...windowRows].join("\n"));
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

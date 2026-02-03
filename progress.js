const { COLORS, colorize } = require("./colorize");
const { STATUS_LABEL_WIDTH } = require("./constants");

function createProgressRenderer({ label = "progress", force = false } = {}) {
  if (!force && !process.stdout.isTTY) return null;
  try {
    const logUpdateModule = require("log-update");
    const create =
      logUpdateModule?.create ||
      logUpdateModule?.default?.create;
    const stream = process.stderr;
    const output = process.stdout;
    const logUpdate = create ? create(stream) : (logUpdateModule?.default || logUpdateModule);
    const ansiEscapes = require("ansi-escapes");
    const hideCursor = ansiEscapes?.cursorHide || "";
    const showCursor = ansiEscapes?.cursorShow || "";
    let statuses = [];
    let processingLine = "";
    let processingIndex = null;
    let total = 0;
    let doneCount = 0;
    let active = true;
    const render = () => {
      const labelText = String(label ?? "progress");
      const labelPadded = labelText.padEnd(STATUS_LABEL_WIDTH, " ");
      const progressLine = `${colorize(labelPadded, COLORS.cyan)} ${colorize(`${doneCount}/${total}`, COLORS.green)}`;
      logUpdate([processingLine || "", progressLine].join("\n"));
    };
    const setProcessing = (line) => {
      if (!active) return;
      processingLine = line || "";
      render();
    };
    const writeLine = (line) => {
      if (!active) return;
      if (typeof logUpdate.clear === "function") {
        logUpdate.clear();
      }
      output.write(`${line}\n`);
      render();
    };

    const start = (count) => {
      total = count || 0;
      statuses = Array.from({ length: total }, () => "");
      processingLine = "";
      processingIndex = null;
      doneCount = 0;
      if (hideCursor) stream.write(hideCursor);
      render();
    };

    const update = (index, line, status) => {
      if (!active) return;
      const i = Math.max(1, index) - 1;
      const nextStatus = status || statuses[i] || "";
      if (nextStatus && statuses[i] !== nextStatus) {
        if (nextStatus === "done") {
          doneCount += 1;
        }
        statuses[i] = nextStatus;
      }
      if (nextStatus === "processing") {
        processingLine = line;
        processingIndex = index;
        render();
        return;
      }
      if (nextStatus === "done" && processingIndex === index) {
        processingLine = "";
        processingIndex = null;
        render();
        return;
      }
      render();
    };

    const stop = () => {
      if (!active) return;
      active = false;
      if (typeof logUpdate.clear === "function") {
        logUpdate.clear();
      } else {
        logUpdate("");
      }
      logUpdate.done();
      if (showCursor) stream.write(showCursor);
    };

    return { start, update, stop, write: writeLine, setProcessing };
  } catch {
    return null;
  }
}

module.exports = {
  createProgressRenderer,
};

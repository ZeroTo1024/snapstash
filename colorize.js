const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
};

const COLOR_ENABLED = process.stdout.isTTY;

function colorize(text, color) {
  if (!COLOR_ENABLED) return text;
  return `${color}${text}${COLORS.reset}`;
}

module.exports = {
  COLORS,
  COLOR_ENABLED,
  colorize,
};

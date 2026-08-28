#!/usr/bin/env node

// Handoff-owned Claude statusline for a worker. It renders the same segments,
// order, colors and spacing as the controller's own ~/.claude/statusline.sh so
// a remote Claude looks like a local one. The only difference is honest: the
// synchronized tree carries no .git, so the two Git segments degrade to the
// same dim placeholders that script already uses when it finds no repository.

const { spawnSync } = require("node:child_process");

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

function heat(value) {
  if (value >= 90) return RED;
  if (value >= 70) return YELLOW;
  return GREEN;
}

function rounded(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

// "Opus 4.8 (1M context)" -> "Opus4.8_1M", "Sonnet 4.6" -> "Sonnet4.6".
function shortModel(value) {
  const name = String(value || "?");
  const match = name.match(/\(([^)]*) context\)/);
  const suffix = match ? `_${match[1]}` : "";
  const head = match ? name.slice(0, name.indexOf(" (")) : name;
  return `${head.replaceAll(" ", "")}${suffix}`;
}

function clock(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h${minutes}` : `${minutes}`;
}

function countdown(resetAt, weekly) {
  const seconds = Math.floor(Number(resetAt) - Date.now() / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (weekly && Math.floor(seconds / 86400) > 1) return `${Math.floor(seconds / 86400)}d`;
  return clock(seconds);
}

function usageSegment(label, window, weekly) {
  const used = rounded(window?.used_percentage);
  if (used === null) return `${DIM}—${RESET}`;
  const timer = (window?.resets_at && countdown(window.resets_at, weekly)) || label;
  return `${DIM}${timer}${RESET} ${heat(used)}${used}%${RESET}`;
}

// One spawn answers both Git segments. The tree usually has no .git here, in
// which case Git exits non-zero and both segments degrade.
function gitStatus(cwd) {
  if (!cwd) return null;
  try {
    const result = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--branch"], {
      encoding: "utf8",
      timeout: 800,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    const lines = String(result.stdout || "").split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    const header = lines[0].replace(/^## /, "");
    const tracking = header.match(/\[(.*)\]$/);
    let branch = header.replace(/\s*\[.*\]$/, "").split("...")[0];
    if (branch === "HEAD (no branch)") {
      const head = spawnSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        timeout: 800,
        windowsHide: true,
      });
      branch = head.status === 0 ? String(head.stdout).trim() : "";
    }
    return { branch, tracking: tracking ? tracking[1] : "", dirty: lines.length - 1 };
  } catch {
    return null;
  }
}

function render(data) {
  const usedContext = rounded(data?.context_window?.used_percentage);
  const segContext = usedContext === null
    ? `${DIM}CTX:${RESET} —`
    : `${DIM}CTX:${RESET} ${heat(usedContext)}${usedContext}%${RESET}`;

  const segFiveHour = usageSegment("5h", data?.rate_limits?.five_hour, false);
  const segSevenDay = usageSegment("7d", data?.rate_limits?.seven_day, true);

  const usedFable = rounded(
    data?.rate_limits?.fable?.used_percentage ?? data?.rate_limits?.seven_day_fable?.used_percentage,
  );
  const segFable = usedFable === null
    ? ""
    : ` ${DIM}F${RESET}${heat(usedFable)}${usedFable}%${RESET}`;

  const segModel = `${CYAN}${shortModel(data?.model?.display_name)}${RESET}`;

  const cwd = String(data?.workspace?.current_dir || data?.cwd || "");
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const segDir = cwd
    ? `${BLUE}${home && cwd.toLowerCase().startsWith(home.toLowerCase()) ? `~${cwd.slice(home.length)}` : cwd}${RESET}`
    : `${DIM}~${RESET}`;

  const git = gitStatus(cwd);
  const segGit = git?.branch
    ? `${MAGENTA}⎇ ${git.branch}${RESET}`
    : `${DIM}⎇ —${RESET}`;

  let segInfo = `${DIM}—${RESET}`;
  if (git) {
    const parts = [];
    if (git.tracking) parts.push(git.tracking);
    if (git.dirty > 0) parts.push(`${git.dirty} files`);
    segInfo = parts.length ? `${YELLOW}${parts.join(", ")}${RESET}` : `${DIM}clean${RESET}`;
  }

  const sep = `${DIM} | ${RESET}`;
  return [
    segContext, sep, segFiveHour, sep, segSevenDay + segFable, sep,
    segModel, sep, segGit, sep, segDir, sep, segInfo,
  ].join("");
}

module.exports = { render, shortModel, countdown, gitStatus };

if (require.main === module) {
  let input = "";
  const timeout = setTimeout(() => process.exit(0), 2000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    clearTimeout(timeout);
    try {
      process.stdout.write(render(JSON.parse(input)));
    } catch {
      // A statusline must never delay or break Claude.
    }
  });
}

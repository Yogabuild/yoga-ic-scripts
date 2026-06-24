#!/usr/bin/env node
// migrate-canister.mjs
// Last updated: Tuesday, 24 June 2026
// Usage:
//   node migrate-canister.mjs --canister <name|id> --target-subnet <subnet-id> [--preserve-id] [--yes]
//                             [--target-id <id>] [--snapshot-dir <path>]
//                             [--nns-name <label>] [--nns-identity <identity>]

import { execSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { parseArgs } from "util";

const { values: args } = parseArgs({
  options: {
    canister:        { type: "string" },
    "target-subnet": { type: "string" },
    "preserve-id":   { type: "boolean", default: false },
    "target-id":     { type: "string" },
    "snapshot-dir":  { type: "string", default: "./migration-snapshot" },
    yes:             { type: "boolean", default: false },
    "nns-name":      { type: "string" },
    "nns-identity":  { type: "string" },
  },
});

const canister     = args["canister"];
const targetSubnet = args["target-subnet"];
const preserveId   = args["preserve-id"];
const snapshotDir  = args["snapshot-dir"];
const skipConfirm  = args["yes"] ? "-y" : "";
const nnsName      = args["nns-name"];
const nnsIdentity  = args["nns-identity"];
const totalSteps   = nnsName ? 8 : 7;

const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  blue:   (s) => `\x1b[34m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

if (!canister || !targetSubnet) {
  console.error(
    "Usage: node migrate-canister.mjs --canister <name|id> --target-subnet <id> [--preserve-id] [--yes] [--nns-name <label>] [--nns-identity <identity>]"
  );
  process.exit(1);
}

// If --canister is a raw principal ID, use -n ic (no project manifest needed).
// If it's a canister name from icp.yaml, use -e ic (requires running from project dir).
const isRawId = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(canister);
const srcNet  = isRawId ? "-n ic" : "-e ic";

function run(cmd) {
  console.log(c.dim(`\n$ ${cmd}`));
  return execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim();
}

// Use for commands where seeing live output matters (e.g. snapshot download).
function runLive(cmd) {
  console.log(c.dim(`\n$ ${cmd}`));
  execSync(cmd, { stdio: "inherit" });
}

// ── Step 1: Create target canister ───────────────────────────────────────────
let targetId = args["target-id"];
if (!targetId) {
  console.log(`\n${c.cyan(`[1/${totalSteps}]`)} Creating target canister on destination subnet...`);
  const out = run(
    `icp canister create --detached -n ic --subnet ${targetSubnet} -q`
  );
  targetId = out.trim();
  console.log(`Target canister ID: ${c.green(targetId)}`);
} else {
  console.log(`\n${c.cyan(`[1/${totalSteps}]`)} Using existing target canister: ${c.green(targetId)}`);
}

// ── Step 2: Top up target ─────────────────────────────────────────────────────
if (preserveId) {
  console.log(`\n${c.cyan(`[2/${totalSteps}]`)} Topping up target canister with 5T (source cycles will be burned)...`);
  run(`icp canister top-up ${targetId} --amount 5T -n ic`);
} else {
  console.log(`\n${c.cyan(`[2/${totalSteps}]`)} Topping up target canister with 1T (snapshot upload/restore cost)...`);
  run(`icp canister top-up ${targetId} --amount 1T -n ic`);
}

// ── Step 3: Stop source and create snapshot ───────────────────────────────────
console.log(`\n${c.cyan(`[3/${totalSteps}]`)} Stopping source canister and creating snapshot...`);
run(`icp canister stop ${canister} ${srcNet}`);

// From this point, the source canister is stopped. Wrap everything in try/catch
// so a failure always tells you how to recover.
try {
  const snapshotId = run(`icp canister snapshot create ${canister} ${srcNet} -q`);
  console.log(`Snapshot ID: ${c.green(snapshotId)}`);

  // ── Step 4: Download snapshot ───────────────────────────────────────────────
  console.log(`\n${c.cyan(`[4/${totalSteps}]`)} Downloading snapshot locally...`);
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  runLive(
    `icp canister snapshot download ${canister} ${snapshotId} -o ${snapshotDir} ${srcNet}`
  );

  // ── Step 5: Upload and restore on target ────────────────────────────────────
  console.log(`\n${c.cyan(`[5/${totalSteps}]`)} Uploading snapshot to target canister...`);
  let newSnapshotId;
  {
    const maxAttempts = 6;
    const delayMs = 12_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resumeFlag = attempt > 1 ? '--resume' : '';
      const cmd = `icp canister snapshot upload ${targetId} -i ${snapshotDir} ${resumeFlag} -n ic -q`.replace(/\s+/g, ' ').trim();
      try {
        newSnapshotId = run(cmd);
        break;
      } catch (err) {
        const isRateLimit = err.message?.includes('rate limited') || err.message?.includes('IC0210') || err.message?.includes('heap delta');
        if (attempt < maxAttempts && isRateLimit) {
          console.log(c.yellow(`\n⚠️  Upload rate limited (attempt ${attempt}/${maxAttempts}). Waiting ${delayMs / 1000}s then resuming...`));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        } else {
          throw err;
        }
      }
    }
  }
  console.log(`New snapshot ID on target: ${c.green(newSnapshotId)}`);

  run(`icp canister stop ${targetId} -n ic`);
  run(`icp canister snapshot restore ${targetId} ${newSnapshotId} -n ic`);

  // ── Step 6: Copy settings and controllers ──────────────────────────────────
  console.log(`\n${c.cyan(`[6/${totalSteps}]`)} Fetching source canister settings...`);
  const settingsOut = run(`icp canister settings show ${canister} ${srcNet}`);
  console.log("Source settings:\n", settingsOut);

  // Parse non-default settings
  const computeMatch     = settingsOut.match(/compute.allocation[:\s]+(\d+)/i);
  const freezingMatch    = settingsOut.match(/freezing.threshold[:\s]+(\d+)/i);
  const wasmMemoryMatch  = settingsOut.match(/wasm.memory.limit[:\s]+([\d]+\s*\w+)/i);

  const settingsFlags = [
    computeMatch    && computeMatch[1]    !== "0"       ? `--compute-allocation ${computeMatch[1]}`              : null,
    freezingMatch   && freezingMatch[1]   !== "2592000" ? `--freezing-threshold ${freezingMatch[1]}`             : null,
    wasmMemoryMatch                                     ? `--wasm-memory-limit ${wasmMemoryMatch[1].replace(/\s+/, "")}` : null,
  ].filter(Boolean);

  if (settingsFlags.length > 0) {
    console.log(`\n${c.cyan(`[6/${totalSteps}]`)} Applying non-default settings to target canister...`);
    run(`icp canister settings update ${targetId} ${settingsFlags.join(" ")} -n ic`);
    console.log(c.green('Settings applied:'), settingsFlags.join(" "));
  } else {
    console.log(`\n${c.cyan(`[6/${totalSteps}]`)} All settings appear to be defaults; nothing to copy.`);
  }

  // Parse and copy controllers
  // Note: for full migration, controllers are restored automatically by migrate-id.
  // For snapshot transfer, we copy them manually.
  if (!preserveId) {
    const controllersMatch = settingsOut.match(/controllers[:\s]+([^\n]+)/i);
    if (controllersMatch) {
      const controllers = controllersMatch[1]
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);

      if (controllers.length > 0) {
        console.log(`\n${c.cyan(`[7/${totalSteps}]`)} Adding controllers to target canister...`);
        for (const controller of controllers) {
          console.log(`  Adding controller: ${controller}`);
          run(`icp canister settings update ${targetId} --add-controller ${controller} -n ic`);
        }
        console.log(c.green('Controllers applied:'), controllers.join(", "));
      }
    } else {
      console.log(`\n${c.cyan(`[7/${totalSteps}]`)} No controllers found in settings output; skipping.`);
    }
  } else {
    console.log(
      `\n${c.cyan(`[7/${totalSteps}]`)} Skipping controller copy — controllers are restored automatically by migrate-id.`
    );
  }

  // ── Full migration: delete snapshot on target, then migrate ID ──────────────
  if (preserveId) {
    console.log(`\n${c.cyan('[Full migration]')} Deleting snapshot on target (required by migrate-id)...`);
    run(`icp canister snapshot delete ${targetId} ${newSnapshotId} -n ic`);

    console.log(`\n${c.cyan('[Full migration]')} Stopping target canister...`);
    run(`icp canister stop ${targetId} -n ic`);

    console.log(`\n${c.cyan('[Full migration]')} Running icp canister migrate-id...`);
    run(`icp canister migrate-id ${canister} --replace ${targetId} ${srcNet} ${skipConfirm}`);

    console.log(c.bold(c.green("\n✅ Full migration complete.")));
    console.log(`   Canister ID now lives on the target subnet.`);
    console.log(`   Update .icp/data/mappings/<env>.ids.json if needed.`);
    console.log(`   Verify settings: icp canister settings show ${c.green(canister)} ${srcNet}`);
  } else {
    // Snapshot transfer: start target, clean up source
    run(`icp canister start ${targetId} -n ic`);

    console.log(c.bold(c.green(`\n✅ Snapshot transfer complete.`)));
    console.log(`   Target canister (${c.green(targetId)}) is running on the new subnet.`);
    console.log(`   Verify settings:  icp canister settings show ${c.green(targetId)} -n ic`);
    console.log(`   Source (${c.blue(canister)}) is now stopped.`);
    console.log(`   Replace old references everywhere needed: ${c.blue(canister)} → ${c.green(targetId)}`);
  }

  // ── Optional: attach canister name in NNS ────────────────────────────────
  if (nnsName) {
    if (!nnsIdentity) {
      console.log(c.yellow(`\n⚠️  --nns-name set but --nns-identity not provided. Skipping NNS attach.`));
      console.log(`   Run manually: icp canister call -n ic qoctq-giaaa-aaaaa-aaaea-cai attach_canister '(record { name = "${nnsName}"; canister_id = principal "${preserveId ? canister : targetId}"; })'`);
    } else {
      const attachId = preserveId ? run(`icp canister id ${canister} ${srcNet}`) : targetId;
      console.log(`\n${c.cyan(`[8/${totalSteps}]`)} Attaching canister ${c.green(attachId)} as "${nnsName}" in NNS (via ${nnsIdentity})...`);
      const prevIdentity = run(`icp identity default`);
      try {
        run(`icp identity default ${nnsIdentity}`);
        run(`icp canister call -n ic qoctq-giaaa-aaaaa-aaaea-cai attach_canister '(record { name = "${nnsName}"; canister_id = principal "${attachId}"; })'`);
        console.log(c.green(`   ✅ Canister named "${nnsName}" in NNS.`));
      } finally {
        run(`icp identity default ${prevIdentity}`);
      }
    }
  }

} catch (err) {
  console.error(c.red("\n❌ Migration failed:"), err.message ?? err);
  console.error(c.yellow(`\n⚠️  Source canister '${canister}' is stopped. Restart it with:`));
  console.error(`   icp canister start ${canister} ${srcNet}`);
  if (targetId) {
    const errStr = (err.message ?? err).toString();
    const isOutOfCycles = errStr.includes("IC0207") || errStr.includes("out of cycles");
    if (isOutOfCycles) {
      const match = errStr.match(/at least ([\d_]+) additional cycles/);
      const cyclesHint = match
        ? `${Math.ceil(Number(match[1].replace(/_/g, '')) / 1e12) + 1}T`
        : "2T";
      console.error(c.yellow("\n💰 Target canister is out of cycles. Top it up with:"));
      console.error(`   icp canister top-up ${targetId} --amount ${cyclesHint} -n ic`);
    }
    const preserveFlag = preserveId ? " --preserve-id --yes" : "";
    console.error(c.yellow("\n▶  Then resume the migration (skips canister creation):"));
    console.error(`   node migrate-canister.mjs --canister ${canister} --target-subnet ${targetSubnet} --target-id ${targetId}${preserveFlag}`);
  }
  process.exit(1);
}
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { validatePool } from "./lib/runner-pool.mjs";

const [config, output, durationArg = "3600", intervalArg = "10"] = process.argv.slice(2);
const duration = Number(durationArg);
const interval = Number(intervalArg);
if (!config || !output || !Number.isFinite(duration) || duration < 1 || !Number.isFinite(interval) || interval < 1) {
  throw new Error("Usage: node scripts/sample-ci-host.mjs pool.json samples.jsonl duration-seconds interval-seconds");
}
const pool = validatePool(JSON.parse(readFileSync(config, "utf8")));
/** @param {string} executable @param {string[]} args */
function read(executable, args) {
  return execFileSync(executable, args, { encoding: "utf8", timeout: 10_000 });
}
const until = Date.now() + duration * 1000;
while (Date.now() < until) {
  const rows = read("/bin/ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="])
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              cpu: Number(match[3]),
              rssKiB: Number(match[4]),
              executable: match[5],
            },
          ]
        : [];
    });
  const owned = new Set(rows.filter((row) => /\/Runner\.Worker$/.test(row.executable)).map((row) => row.pid));
  for (let previous = -1; previous !== owned.size; ) {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  }
  const sample = {
    timestamp: new Date().toISOString(),
    swap: read("/usr/sbin/sysctl", ["vm.swapusage"]),
    pressure: read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).trim(),
    memory: read("vm_stat", []),
    disk: read("df", ["-k", pool.root]),
    cpu: read("top", ["-l", "1", "-n", "0"])
      .split("\n")
      .filter((line) => /CPU usage|PhysMem|VM:/.test(line)),
    listeners: rows.filter((row) => /\/Runner\.Listener$/.test(row.executable)),
    jobProcesses: rows.filter((row) => owned.has(row.pid)),
    slotProcesses: rows.filter((row) =>
      pool.slots.some((/** @type {import('./lib/runner-pool.mjs').Slot} */ slot) =>
        row.executable.startsWith(`${slot.directory}/`),
      ),
    ),
  };
  appendFileSync(output, `${JSON.stringify(sample)}\n`);
  await setTimeout(interval * 1000);
}
console.log(`Saved host samples to ${output}`);

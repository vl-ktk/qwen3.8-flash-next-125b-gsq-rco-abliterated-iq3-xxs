import { stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

// Directory and marker ACLs will be provisioned by the Windows installer.
// Any read failure other than ENOENT must block origin traffic.
export function createEmergencyLock(lockPath, { fileSystem = { stat, writeFile, unlink }, platform = process.platform } = {}) {
  if (typeof lockPath !== "string" || !lockPath || !(platform === "win32" ? path.win32.isAbsolute(lockPath) : path.isAbsolute(lockPath))) {
    throw Error("invalid_emergency_lock_path");
  }
  return {
    async isLocked() {
      try { await fileSystem.stat(lockPath); return true; }
      catch (error) {
        if (error?.code !== "ENOENT") throw Error("emergency_lock_unavailable");
        // ENOENT must mean 'marker absent', not 'security directory missing'.
        try { if (!(await fileSystem.stat(platform === "win32" ? path.win32.dirname(lockPath) : path.dirname(lockPath))).isDirectory()) throw Error(); }
        catch { throw Error("emergency_lock_unavailable"); }
        return false;
      }
    },
    async lock() {
      try { await fileSystem.writeFile(lockPath, "LOCKED\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error?.code !== "EEXIST") throw Error("emergency_lock_unavailable"); }
      return { status: "locked" };
    },
    async unlock() {
      try { await fileSystem.unlink(lockPath); }
      catch (error) { if (error?.code !== "ENOENT") throw Error("emergency_lock_unavailable"); }
      return { status: "unlocked" };
    },
  };
}

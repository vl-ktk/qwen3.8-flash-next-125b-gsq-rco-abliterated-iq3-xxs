# Local SC117 IQ3_XXS installation via Windows MCP — implementation blocks

## Target and sources (verified 2026-11-20)

- Machine **to be installed later**: Windows, i9-12900K, RTX 3090 Ti 24 GiB VRAM, 64 GiB RAM, NVMe drives C: and D: (actual disk space and installed software not yet measured).
- Exact model: `SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF`, `IQ3_XXS`, both shards. Model repository rounds them to **47.34 GB + 28.80 GB = 76.14 GB**: https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF
- Engine: Strata. This **particular** abliterated model needs its *own* native pack generated from its GGUF; an official-model pack has incompatible offsets. Also fetch the published Strata MTP runtime (`strata/rt`). Source: https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF/blob/main/strata/README.md
- **130 GB recommended free on one fixed volume** is a conservative planning allowance, not an upstream minimum or a promise of successful download/pack. The true required space must be measured during B/C before downloading. Storage-bus inventory alone cannot map a specific drive letter to an NVMe device.
- Cloudflare Worker is not an inference host: only the future local Windows Strata process can run inference. Do not quietly switch to llama.cpp/remote APIs/a different quantization.

## A — Read-only inventory and plan (source implementation)

1. `pc_preflight()`: Windows edition/architecture, CPU/threads, RAM total/free, Windows service execution context, NVIDIA GPU/driver/VRAM. Missing data explicitly marked unknown; no AVX/CUDA execution test.
2. `storage_check()`: bounded fixed-volume inventory, free bytes, recommended-space candidates, physical media/bus information **without asserting a volume-to-physical-device mapping**.
3. `runtime_check()`: Strata machine-wide HKLM uninstall registrations, exact process names, NVIDIA driver inventory. Per-user installations, Python venv and CUDA code execution **not** checked. A missing registration is *not* proof of absent Strata.
4. `installation_plan()`: reuses these three live read-only checks, always reports **no writes**, target/model/space estimates, missing evidence, and six explicit unstarted next steps. Fails closed on partial observations.

All four tools have empty parameter objects (`additionalProperties: false`); PowerShell scripts are static, non-interactive, bounded, run without inherited OAuth/environment secrets or a shell. There is **no** execute/install/download/modify/PowerShell tool added. No machine has been tested by introducing this source code; tools only become available after a future signed/reviewed Windows MCP update and an MCP tool-list refresh.

## B — Pinned Strata Terminal and GPU engine installer (source implementation)

- **Publisher:** `Niko1221/Strata` GitHub release [v0.2.17](https://github.com/Niko1221/Strata/releases/tag/v0.2.17), released 2026-11-20. It ships an independently versioned **Control 0.1.63** and Windows GPU engines. Exact asset names, sizes and SHA-256 digests are pinned in `src/windows/strata-runtime.lock.json` from release metadata.
- `src/windows/strata-installer.mjs`: `strataInstallPlan()` is always read-only; `installStrata()` requires local installer approval and Windows x64. `scripts/Install-KTKStrata.mjs` provides the future one-click wizard's static actions `--plan`, `--install --installer-approved` and `--recover --installer-approved` (no arbitrary paths or commands accepted on its CLI).
- Downloads only the **pinned official 16,171-byte `install.ps1`**, validates SHA-256 before running; no `irm | iex` or GitHub `latest` URL. The vendor script fetches the Terminal package and checks its SHA-256 and the signed Strata feed. It receives `STRATA_FEED=https://github.com/Niko1221/Strata/releases/download/v0.2.17`, `STRATA_NO_PATH=1`, `STRATA_DATA_DIR=<current-user LOCALAPPDATA>/KTK/Strata` in a restricted subprocess environment.
- Invokes the bundled Python interpreter directly (no `cmd.exe` shell), checks `strata.py --version`, runs the upstream **signed engine updater** (`update --no-control --feed ... --output json`), and queries installed engine inventory. No model weights are downloaded by this block. NVIDIA driver/CUDA compatibility and actual generation are *not* proven until model startup in D/E.
- A fresh install uses an exclusive KTK-owned directory and a marker. On failure, cleanup touches **only that newly created KTK runtime tree**; unknown existing folders or user Strata folders are never overwritten. A separately approved recovery removes only an abandoned `installing` KTK tree, never a `ready` one. On repeated success the module is idempotent.
- The staged Windows package contains the lock, module and wrapper. **Existing Setup.exe does not yet invoke this new stage**, because B/C/D must be connected to one integrated acceptance wizard in E. The remote Windows MCP remains read-only. No admin service, Windows host, Cloudflare or model is modified by these source changes.
- The repo's Windows CI runs offline mocks of the installer and resolves the packaged `--plan` on native Windows; it does **not** run the signed 740 MB engine download, a real vendor installation, or inference on the owner's machine. These are explicitly deferred to the combined acceptance test.

## Future blocks — not yet implemented

- **C**: resumable two-shard SC117 + MTP download, version-pinned manifest, per-file hash integrity, safe pack generation, storage planning and cleanup on failure.
- **D**: localhost-only launch/control/health/inference test; explicit GPU/RAM tuning and bounded parallelism; no automatic public network exposure.
- **E**: one integrated GUI acceptance installer on owner's primary Windows first; friend PC installation only after owner's approval, maintenance, monitored AI/games mode, rollback/recovery. No individual manual PowerShell smoke tests imposed on the owner.

**Not verified on the actual target:** PowerShell 5.1 sensor execution, mapping NVMe to C/D, running the genuine Strata 0.2.17 installer and GPU update, model download/pack, target free space and inference performance. Passing source CI is not the same as a completed installation.

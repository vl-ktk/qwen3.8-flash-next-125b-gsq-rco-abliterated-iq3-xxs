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

## Future blocks — not yet implemented

- **B**: one-click pinned Strata runtime installation, with source/signature/hash verification, uninstall/rollback and explicit install-location safeguards.
- **C**: resumable two-shard SC117 + MTP download, version-pinned manifest, per-file hash integrity, safe pack generation, storage planning and cleanup on failure.
- **D**: localhost-only launch/control/health/inference test; explicit GPU/RAM tuning and bounded parallelism; no automatic public network exposure.
- **E**: one integrated GUI acceptance installer on owner's primary Windows first; friend PC installation only after owner's approval, maintenance, monitored AI/games mode, rollback/recovery. No individual manual PowerShell smoke tests imposed on the owner.

**Not verified in A:** Windows PowerShell 5.1 execution on the actual target, mapping NVMe to C/D, Strata compatibility and version, GPU inference, model download/pack, available target storage and performance. The source CI checks for A must pass independently; never report A as an installed application.

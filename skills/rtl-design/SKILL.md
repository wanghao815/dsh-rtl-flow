---
name: rtl-design
description: Design and modify synthesizable RTL, reference models, verification, synthesis and ASIC physical flows from an architecture contract. Use for digital IP such as controllers, FIFOs, buses, DSP, processors, memories and accelerators; select the stages needed for the requested delivery.
---

# RTL design through evidence

Read the project's current AGENTS.md, TODO.md, key_milestone.md and agent_ability_report.md (accept existing aliases). Continue from the latest authorized task with satisfied dependencies. Latest stop/pause decisions override old queues. Do not restart a paused design because a template or earlier report says to continue.

Read the canonical [core workflow](../../docs/core-workflow.md) first. Use `rtl_plan_work` to distinguish new/adopt/modify/eco/resume, identify reusable versus invalid evidence, and select feature topics. `rtl_scaffold` previews new management files; for existing projects use the CLI adoption preview and reconcile existing conventions before writing. `rtl_check_evidence` checks declarations; the CLI audit also binds actual files, physical manifests and native report metrics. Neither certifies foundry signoff.

1. Establish the requested delivery (RTL, verification, or ASIC implementation), supported configurations, interfaces, clocks/resets, throughput/latency, numerical semantics, storage boundary, verification scope and resource budget. Keep confirmed requirements, assumptions, proposals and measured evidence distinct. Reuse existing authorization; ask only for consequential missing choices or evidenced contract conflicts.
2. Decompose the hardware by responsibilities, state ownership and timing boundaries. For a fresh flow, validate the actual tool chain and the smallest representative design before large scale execution. An established flow can reuse unchanged, evidenced prerequisites. Do not force a linear rebuild for a local fix.
3. Write the reference/state model, cycle and layout contracts, then implement the smallest critical leaf. Verify primitive behavior, protocol/control, cycle edges, negative checks and early synthesis/timing before expanding hierarchy. Apply arithmetic guidance only to arithmetic designs. CDC/RDC and memories require their own contracts when present.
4. Integrate incrementally using the same verified leaf and source manifests. Check real output interfaces, ordering, loss/duplication, reset, backpressure and completion. Select tests by actual features. Do not inherit a single-task interface, two-stage arithmetic, a dataflow, fixed widths or fixed PDK from the source case study.
5. For ASIC delivery, bind matching technology, library corners, macro views, RC, SDC and physical checkpoints. Run implementation and applicable STA/DRC/LVS/antenna/power checks. Label unperformed or uncovered checks. Use the original constraints after an ECO and rerun affected checks from the new checkpoint.
6. Keep management documents short and link raw evidence. Record first failures, retries, human decisions, resource costs and actual generalization scope. At the agreed delivery or stop boundary, archive the selected baseline, limitations and restart conditions; refresh diagrams and handoff.

Before any heavy execution, use the configured `rtl_resource_check` or `rtl-flow resources` on the actual project. Account for elapsed time and every remaining task, measured memory demand, device total/available memory, and disk growth/free space. Unknown/stale estimates block heavy work. `rtl-flow run --task` is a foreground, serial, resource-guarded native command; host jobs may supervise it. Do not launch an unguarded heavy alternative after a denial. Separate execution completion from hardware acceptance.

Delivery intent is full/scoped/closeout, while lifecycle is active/paused/archived. A decided scope exclusion keeps original check status visible; experiment closeout can finish the archive without passing failed physical checks. Never clear pause through a work-entry choice.

Do not loosen acceptance thresholds, add hidden pipeline stages, change II, remove functionality, cut physical capacity, add timing exceptions or swap platforms to make a test pass. A justified change follows the project's authority and decision process. Do not infer full verification from zero markers without checking rule and model coverage.

## Load the relevant reference

| Topic | Read when |
| --- | --- |
| [workflow](../../docs/core-workflow.md) | Selecting entry, gates, scope, resource policy and delivery outcome |
| [architecture](references/architecture.md) | Requirements, microarchitecture, interfaces, state, cycles or design research |
| [toolchain](references/toolchain.md) | Setting up or changing tools, libraries, PDK or memory views |
| [rtl](references/rtl.md) | Generating, modifying, integrating or synthesizing RTL |
| [verification](references/verification.md) | Building a reference model, scoreboard, assertions, regression or formal environment |
| [physical](references/physical.md) | Implementing, measuring or repairing a physical checkpoint |
| [operations](references/operations.md) | Resource estimates, long tasks, recovery, pause or archive |
| [arithmetic](references/arithmetic.md), [stream](references/stream.md), [protocol](references/protocol.md) | The selected design contains numerical, streaming or transaction behavior |
| [multiclock](references/multiclock.md), [memory](references/memory.md), [macros](references/macros.md), [formal](references/formal.md) | These features are present; combine topics rather than forcing one module category |

Detailed architecture, numeric, cycle, verification, physical and handoff templates are in `templates/project/` at the package root. Replace undecided fields from the current project; drafts contain no passing evidence.

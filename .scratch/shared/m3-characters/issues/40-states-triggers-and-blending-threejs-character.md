# 40: States, triggers and blending (threejs-character)

**What to build:** An animation such as running is a state: the character's current state, such as running, walking or turning. Blend between states based on triggers, which are environmental or personal reasons for change. For example, an agent can have a trigger that changes it from running to ragdoll when it is hit at a certain velocity. Once that velocity is met, the agent stops running and switches to ragdoll.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#30](https://github.com/AskAlice/threejs-worldgen/issues/30)
- State: OPEN
- Milestone: threejs-worldgen · M3 — Characters (CHARACTERS.md)
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, area:characters
- Packages: shared
- Opened: 2026-10-13

## Request

An animation such as running is a state: the character's current state, such as running, walking or turning. Blend between states based on triggers, which are environmental or personal reasons for change. For example, an agent can have a trigger that changes it from running to ragdoll when it is hit at a certain velocity. Once that velocity is met, the agent stops running and switches to ragdoll.

Per CHARACTERS.md: Mixamo/glTF bone map + retargeting, poses as data, state machine with blend trees and synced crossfades, JSON triggers (impact velocity, contact tags, fall height, timers, chance, …) → actions (change state, full/partial ragdoll, motor strength curve, get up), foot IK on HeightFn terrain, MoGraph-style effector layers.

---
<sub>Migrated from Linear ASK-28 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-28 -->

# 15: Epic: Houdini-style ragdoll + MoGraph/Mixamo animation hybrid for crowd agents

**What to build:** Once the current work is done, spec a hybrid between ragdoll character animation and MoGraph/Mixamo-style animation, with rules for AAA-game-style ragdoll skeleton joint-angle constraints and animation blending, similar to Houdini.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** epic · imported from GitHub

## Imported issue

- Imported from: [#20](https://github.com/AskAlice/threejs-worldgen/issues/20)
- State: OPEN
- Milestone: threejs-worldgen · M3 — Characters (CHARACTERS.md)
- Labels: enhancement, ready-for-human, epic, project:threejs-worldgen, area:characters
- Packages: shared
- Opened: 2026-10-13

## Request

Once the current work is done, spec a hybrid between ragdoll character animation and MoGraph/Mixamo-style animation, with rules for AAA-game-style ragdoll skeleton joint-angle constraints and animation blending, similar to Houdini.

The agents are the crowds that have been built, with a traditional bipedal structure. An animation such as running is a state: the character's current state, such as running, walking or turning. The character blends between states based on triggers, which are environmental or personal reasons for change. For example, an agent can have a trigger that changes it from running to ragdoll when it is hit at a certain velocity. Once that velocity is met, the agent stops running and switches to ragdoll.

A ragdoll is the bone structure (the joints) with low-res collision geometry on top that reaches out and interacts with the world. The simple system triggers one state and then another, for example from running into a full-flop ragdoll. Houdini has ways to add more life to a ragdoll, because traditional ragdolls are infinitely floppy, which is amusing but not realistic.

First, give every joint limits on how far it can bend or move. For example, the leg's cone can only rotate so far, because rotating further is not realistic. With the motion of all joints limited, add motors inside the joints. Given an animation, for example a character writhing in pain, motors on certain joints are turned on during ragdoll, and those joints fight to reach that pose. Depending on motor strength, they may only get halfway there and writhe a little, or, with a very strong motor, simply play the animation. If something blocks a motor, the joint still interacts with the environment. This blends some life into the ragdolls.

## Spec

CHARACTERS.md (written 2026-10-09, 707 lines): packages `threejs-character` (bone map, retargeting, pose-as-data animation graph, foot IK, triggers, MoGraph-style effector layers), `threejs-ragdoll` (collision proxies, swing-twist joint limits, PD motors, active/partial ragdoll, get-up, balance; engine adapter with Jolt primary and Rapier fallback), `threejs-crowd` (spawning, navigation, ORCA avoidance, LOD with baked bone-matrix textures, ragdoll budget).

## Decisions

* Jolt over Rapier: Rapier JS bindings lack limits/motors on ball joints.
* Poses as plain data (not AnimationMixer) so motors, IK and blending read them directly.
* No `threejs-mograph` package: effectors are a layer type in `threejs-character`.

## Next

User review of CHARACTERS.md, then implementation (after M1).

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] Spec written (CHARACTERS.md)
- [ ] User review of the spec
- [ ] threejs-ragdoll (#29)
- [ ] threejs-character (#30)
- [ ] threejs-crowd (#31)

Evidence:
- CHARACTERS.md spec (707 lines) committed: threejs-character, threejs-ragdoll and threejs-crowd (CHARACTERS.md (2a9baab))
- No character, ragdoll or crowd package or code exists (packages/ (none); git grep ragdoll in packages: no hits)

---
<sub>Migrated from Linear ASK-17 · created 2026-10-09 by Alice Knag · priority: High</sub>
<!-- linear-id: ASK-17 -->

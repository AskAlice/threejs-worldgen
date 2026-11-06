# 16: Ragdoll joint limits and motors (threejs-ragdoll)

**What to build:** Give every ragdoll joint limits on how far it can bend or move; for example, the leg's cone can only rotate so far. Then add motors inside the joints. Depending on motor strength, a joint may only get halfway to the target pose, or, with a very strong motor, simply play the animation. If something blocks a motor, the joint still interacts with the environment.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#29](https://github.com/AskAlice/threejs-worldgen/issues/29)
- State: OPEN
- Milestone: threejs-worldgen · M3 — Characters (CHARACTERS.md)
- Labels: enhancement, ready-for-agent, story, project:threejs-worldgen, area:characters
- Packages: shared
- Opened: 2026-10-13

## Request

Give every ragdoll joint limits on how far it can bend or move; for example, the leg's cone can only rotate so far. Then add motors inside the joints. Depending on motor strength, a joint may only get halfway to the target pose, or, with a very strong motor, simply play the animation. If something blocks a motor, the joint still interacts with the environment.

Per CHARACTERS.md: low-res collision proxies per bone with a mass table; swing-twist (elliptical cone) and hinge limits for every major joint; PD motors driving toward a clip pose with per-bone strength and strength-over-time curves; Jolt adapter (Rapier fallback). Tests: swing-twist decomposition, limit clamping, PD convergence.

---
<sub>Migrated from Linear ASK-27 · created 2026-10-09 by Alice Knag · </sub>
<!-- linear-id: ASK-27 -->

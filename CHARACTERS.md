# Characters, ragdolls and crowds design

How threejs-worldgen gets people: bipedal agents that walk, run and turn on clip-based animation, react to the world
through declarative triggers, and fall into physical ragdolls that are never fully limp, because joint limits and
motors keep pulling them toward an animated pose. It is the same mix Houdini's crowd solver uses (agent clips, a
transition graph, ragdolls with motors), built for three.js WebGPU and streamed over the worldgen terrain.

## Goals

- **One agent, three bodies.** Every agent has an animated pose, a physical skeleton, and a blend between them per
  bone. Any bone can be fully animated, fully physical, or anywhere in between.
- **Ragdolls with life.** Anatomical joint limits (swing-twist cones, hinges) plus PD motors that chase a target clip.
  Motor strength decides whether a body barely tenses or plays the clip through contact.
- **Declarative behaviour.** States, transitions and triggers are plain JSON, so they save, diff, ship to a worker and
  bind to a GUI like every other option in the monorepo.
- **Crowds that scale.** Hundreds of agents on screen, thousands at distance, a hard cap on simultaneous physical
  ragdolls, all deterministic from `seed`.
- **Fits the world.** Agents stand on any `Terrain` (`HeightFn` from `threejs-biomes`, or a mesh), walk the road graph
  of `threejs-city`, and push `threejs-grass` aside through its existing `Interactor` list.

**Non-goals:** facial animation, cloth and hair simulation, motion matching and learned controllers (DeepMimic-style
policies), a general game-object physics API (the physics adapter only covers what ragdolls and agents need), and
networked multiplayer sync.

## Packages

| Package | Contents | Builds on |
|---|---|---|
| `threejs-character` | humanoid bone map and retargeting, pose buffers, clip library, animation graph (state machine, blend trees, layers, masks, root motion), foot IK, procedural effectors, trigger system | `threejs-heightfield` |
| `threejs-ragdoll` | collision proxies, mass table, swing-twist and hinge limits, PD motors and strength curves, active/partial ragdoll, hit reactions, get-up, balance; `PhysicsAdapter` interface with `./jolt` and `./rapier` adapters | `threejs-character` |
| `threejs-crowd` | spawning, navigation over terrain and roads, ORCA avoidance, LOD tiers, baked-animation instancing, ragdoll budget, grass interactors | `threejs-ragdoll`, `threejs-scatter` |

The names read like their neighbours (`threejs-grass`, `threejs-scatter`, `threejs-city`): one noun for the thing you
put in the world. All three are free on npm. The MoGraph-style effectors are not a fourth package: they only read
and write a local pose, so they are a layer type inside `threejs-character` (`effectors` in the graph options).
Split them out if a non-character use appears.

`threejs-character` works without physics (animated agents only). Physics engines are optional peer dependencies of
`threejs-ragdoll`, imported only by the adapter subpath you choose, so nobody downloads WASM they do not use.

### Physics engine

| | Jolt (`jolt-physics`) | Rapier (`@dimforge/rapier3d-compat`) | cannon-es |
|---|---|---|---|
| Ball joint with cone limits | `SwingTwistConstraint`: elliptical cone (`mNormalHalfConeAngle`, `mPlaneHalfConeAngle`) or pyramid, twist min/max | `JointData.spherical`: **no limits or motors in the JS API** (`SphericalImpulseJoint`, `GenericImpulseJoint` expose none) | `ConeTwistConstraint`: circular cone only, one twist angle |
| Hinge with limits and motor | `HingeConstraint`, limits with spring, motor | `JointData.revolute`: `setLimits`, `configureMotorPosition(target, stiffness, damping)`, `setMotorMaxForce` | `HingeConstraint`, velocity motor only |
| Joint motors | swing and twist motors per constraint; `MotorSettings` with spring frequency/damping and min/max torque; implicit (solved in the constraint) | revolute/prismatic only | velocity motors, explicit |
| Ragdoll helpers | `RagdollSettings`, `Ragdoll`, `SkeletonPose`, `DriveToPoseUsingMotors`, `DriveToPoseUsingKinematics`, parent-child collision filtering | none | none |
| CCD | linear cast motion quality per body | per-body CCD | none |
| Determinism | deterministic for identical inputs and insertion order; cross-platform needs a `JPH_CROSS_PLATFORM_DETERMINISTIC` build | enhanced-determinism builds, cross-platform | same engine, same order only |
| Runs in Node | yes (tests) | yes | yes |
| Licence | MIT | Apache-2.0 | MIT |

**Choice: Jolt, with Rapier as the fallback adapter.** Jolt has every primitive this design needs as a native,
implicitly solved constraint: elliptical swing-twist cones, per-axis motors with torque limits, and a ragdoll builder
used in shipped AAA games (Horizon Forbidden West). Rapier is the better-known name in the R3F world
(`@react-three/rapier`) and is excellent for hinges, but its JS bindings give ball joints no limits and no motors.
The Rapier adapter therefore uses `spherical` joints for position only and applies swing-twist limits and PD motors
itself as torque impulses each substep (stable PD, below). It is softer and needs ~2× the substeps, so it is the
fallback for projects already on Rapier, not the default. cannon-es is rejected: circular cones only, no position
motors, unmaintained.

Everything above the adapter is engine-agnostic: limits are specified once (in degrees, anatomical terms) and the
adapter maps them to native constraints or emulates them. The Jolt adapter builds bodies and constraints through
`RagdollSettings` (for its parent-child collision filtering) but sets each constraint's motor target and spring
settings itself every tick, rather than calling `DriveToPoseUsingMotors`, because strength changes per joint and over
time.

```ts
interface PhysicsAdapter {
  step(dt: number): void                                     // one fixed step, substeps inside
  createBody(desc: BodyDesc): BodyId                         // capsule | box | sphere, mass, inertia scale, group
  setBodyMode(id: BodyId, mode: 'dynamic' | 'kinematic'): void
  setKinematicTarget(id: BodyId, pos: Vec3, rot: Quat, dt: number): void
  createJoint(desc: JointDesc): JointId                      // 'swingTwist' | 'hinge' | 'fixed', frames, limits
  setMotor(id: JointId, targetRel: Quat, spring: SpringParams, maxTorque: number): void
  disableMotor(id: JointId, frictionTorque: number): void
  read(id: BodyId, out: BodyState): void                     // position, rotation, linear and angular velocity
  applyImpulse(id: BodyId, impulse: Vec3, point: Vec3): void
  drainContacts(out: ContactEvent[]): number                 // impacts since last call
  setStaticPatch(center: Vec3, heights: Float32Array, size: number, cells: number): void
  dispose(): void
}
```

## Skeleton

### Bone map

A canonical humanoid of 22 bones, named like VRM's humanoid spec. `autoBoneMap(skeleton)` matches Mixamo, VRM and
Unreal Mannequin names (case-insensitive, with three.js's sanitised names: `GLTFLoader` runs node names through
`PropertyBinding.sanitizeNodeName`, so `mixamorig:Hips` arrives as `mixamorigHips`). Anything else takes an explicit
`boneMap` option.

| Canonical | Mixamo | VRM | Unreal Mannequin | Ragdoll body |
|---|---|---|---|---|
| `hips` | `mixamorigHips` | `hips` | `pelvis` | pelvis |
| `spine` | `Spine` | `spine` | `spine_01` | spine |
| `chest` | `Spine1` | `chest` | `spine_02` | chest |
| `upperChest` | `Spine2` | `upperChest` | `spine_03` | chest (merged) |
| `neck` | `Neck` | `neck` | `neck_01` | neck |
| `head` | `Head` | `head` | `head` | head |
| `left/rightShoulder` | `LeftShoulder` | `leftShoulder` | `clavicle_l` | chest (fixed) |
| `left/rightUpperArm` | `LeftArm` | `leftUpperArm` | `upperarm_l` | upper arm |
| `left/rightLowerArm` | `LeftForeArm` | `leftLowerArm` | `lowerarm_l` | forearm |
| `left/rightHand` | `LeftHand` | `leftHand` | `hand_l` | hand, or forearm (merged) |
| `left/rightUpperLeg` | `LeftUpLeg` | `leftUpperLeg` | `thigh_l` | thigh |
| `left/rightLowerLeg` | `LeftLeg` | `leftLowerLeg` | `calf_l` | shin |
| `left/rightFoot` | `LeftFoot` | `leftFoot` | `foot_l` | foot |
| `left/rightToes` | `LeftToeBase` | `leftToes` | `ball_l` | foot (merged) |

Fingers, twist bones and end bones are carried along but never simulated: they keep their animated local rotation.

### Retargeting

Clips are retargeted by world-space rest-pose alignment. Let `S(b)` and `T(b)` be the source and target rest world
rotations of bone `b`, and `A(b)` the animated source world rotation. The target world rotation is the same delta
from rest, `B(b) = A(b) · S(b)⁻¹ · T(b)`, and the local rotation is `B(parent)⁻¹ · B(b)`. Hips translation is scaled
by the ratio of hip heights. If the two rests differ (T-pose vs A-pose), the source rest is first rotated so each
limb direction matches the target's (a per-bone shortest-arc correction), then the formula above applies.
Retargeting runs once per clip at load and produces clips in canonical bone order.

### Collision proxies

One body per simulated segment (15 by default, 17 with `hands: true`). Each is a capsule along the bone from its head
to its child's head, except the feet (box: foot length × 0.1 m × 0.09 m) and the head (sphere).

- **Length** `L` = distance to the child joint (for `chest`, to the neck; for `head`, the `HeadTop_End` bone or
  `0.12 × height`).
- **Radius** from skin weights: for each vertex with weight ≥ 0.5 on the bone (or the bones merged into it), take its
  distance to the bone segment; the radius is the 65th percentile, which ignores clothing spikes. Without a skinned
  mesh, `radius = L × ratio` with ratios pelvis 0.55, spine 0.6, chest 0.55, neck 0.5, upper arm 0.18, forearm 0.15,
  thigh 0.2, shin 0.14.
- **Capsule half-height** = `max(0.01, L/2 − r × inset)`, `inset = 0.7`, so neighbours touch without deep overlap.
- Parent-child pairs, pelvis-thighs and chest-upper arms never collide with each other.

### Mass

Segment masses as a share of total body mass, from Winter, *Biomechanics and Motor Control of Human Movement* (after
Dempster 1955). Default total 70 kg, set per agent.

| Body | % | Body | % |
|---|---|---|---|
| head | 6.9 | upper arm (each) | 2.8 |
| neck | 1.2 | forearm (each) | 1.6 |
| chest (thorax) | 21.6 | hand (each) | 0.6 (into forearm when `hands: false`) |
| spine (abdomen) | 13.9 | thigh (each) | 10.0 |
| pelvis | 14.2 | shin (each) | 4.65 |
| | | foot (each) | 1.45 |

The totals sum to 100. Inertia comes from the proxy shape at that mass, then small bodies get `inertiaScale` (head,
hands, feet: 2.0) so joint chains stay stable (see Motors).

## Joint constraints

Limits are anatomical, measured from **anatomical neutral** (standing, arms at the sides, palms in, feet forward), not
from the bind pose. Joint frames are built from canonical directions in the pelvis frame (+Y up, +Z forward), so a
T-pose rig and an A-pose rig get identical limits. The twist axis is the child bone direction at neutral; swing 1 is
about the flexion axis (side-to-side, +X), swing 2 is about the remaining axis (front-to-back).

| Joint | Bodies | Type | Swing 1: flexion / extension | Swing 2: abduction / adduction (or lateral) | Twist (int. / ext.) | Max torque N·m | Strength × |
|---|---|---|---|---|---|---|---|
| lumbar | pelvis → spine | swing-twist | 35 / 15 | ±20 | ±10 | 250 | 1.0 |
| thoracic | spine → chest | swing-twist | 30 / 15 | ±20 | ±25 | 200 | 1.0 |
| lower neck | chest → neck | swing-twist | 30 / 30 | ±25 | ±40 | 50 | 0.6 |
| upper neck | neck → head | swing-twist | 20 / 25 | ±15 | ±30 | 30 | 0.4 |
| shoulder | chest → upper arm | swing-twist | 100 / 45 | 90 / 30 | 60 / 70 | 80 | 0.8 |
| elbow | upper arm → forearm | hinge | 0 to 145 flexion | — | — | 60 | 0.6 |
| wrist (`hands: true`) | forearm → hand | swing-twist | 70 / 60 | 20 radial / 30 ulnar | ±60 (forearm pronation) | 15 | 0.3 |
| hip | pelvis → thigh | swing-twist | 110 / 20 | 45 / 25 | 35 / 45 | 250 | 1.0 |
| knee | thigh → shin | hinge | 0 to 140 flexion | — | — | 200 | 0.8 |
| ankle | shin → foot | swing-twist | 20 dorsi / 45 plantar | 25 inversion / 15 eversion | ±5 | 120 | 0.5 |

Degrees. Ranges are deliberately inside full human range of motion (AAOS normal values): a ragdoll at the extreme of
real range already looks broken. The neck and the spine are split across two joints each, so each joint takes about
half of the region's range. Max torques are roughly peak isometric human joint torques for a 70 kg adult and scale
linearly with agent mass.

**Asymmetric limits.** Engines take symmetric half-angles, so each asymmetric pair (`lo`, `hi`) becomes a joint frame
rotated by the midpoint `(hi − lo)/2` about that swing axis, with half-angle `(hi + lo)/2`. The shoulder cone, for
example, is centred 27.5° forward and 30° outward with half-angles 72.5° and 60°.

**Soft limits and friction.**

| Parameter | Default | Meaning |
|---|---|---|
| `limitSoftness` | 0.15 | fraction of the range near each end where a spring starts resisting (0 = hard stop) |
| `limitFrequency` | 8 Hz | stiffness of the limit spring as a natural frequency |
| `limitDamping` | 1.0 | damping ratio of the limit spring (1 = critical) |
| `frictionTorque` | 2 N·m | constant joint friction when the motor is off; stops the "wet noodle" jiggle of limp ragdolls |

Stiffness is given as frequency `f` and damping ratio `ζ`, not raw `k` and `c`, because the same `f` behaves the same
on a 0.4 kg hand and a 15 kg chest: `k = I·(2πf)²`, `c = 2ζ·I·(2πf)`, with `I` the effective inertia about the
joint. Jolt's `SpringSettings` takes frequency and damping directly; the Rapier adapter converts.

### Swing-twist decomposition

Any relative rotation `q = (w, v)` between parent and child joint frames splits into a twist about the bone axis `t`
followed by a swing that moves the axis: `q = q_swing · q_twist`.

1. Project the vector part onto the axis: `p = (v · t) t`.
2. `q_twist = normalize(w, p)`. If `|(w, p)| < 1e-6` (swing of exactly 180°), the twist is undefined: use identity.
3. `q_swing = q · q_twist⁻¹`. Its vector part is perpendicular to `t`.
4. Twist angle `θ = 2·atan2(p · t, w)`, wrapped to (−180°, 180°].
5. Swing as a rotation vector `r = φ·n`, with `φ = 2·atan2(|v_s|, w_s)` and `n = v_s / |v_s|`. Its components on the
   two swing axes are `r₁ = r · x`, `r₂ = r · z`.

**Elliptical cone.** The swing is inside the limit when `(r₁/A)² + (r₂/B)² ≤ 1`, with `A`, `B` the two half-angles
(Jolt's plane and normal half-cone angles). To clamp, scale `r` radially by `1/√f`, `f` being the left side. Radial
scaling is continuous and cheap but not the closest point on the ellipse: for a swing twice outside the cone it lands
0.6° farther than the closest point on the shoulder (72.5° × 60°) and up to 9° on the wrist (65° × 25°). Jolt's
native constraint does not use it; it only clamps motor targets and drives the Rapier adapter, where that is
invisible. Eberly's exact point-to-ellipse distance is the upgrade. Twist clamps to `[θmin, θmax]`. The clamped
rotation is rebuilt as `q_swing(r) · q_twist(θ)`. Hinges are the one-axis case: decompose about the hinge axis and
clamp the twist.

This is the formulation of Jolt's `SwingTwistConstraint`, PhysX's D6 joint and Unity's `CharacterJoint`; the
decomposition is from Dobrowolski, *Swing-twist decomposition in Clifford algebra* (2015). We implement it in JS for
the Rapier adapter, for the debug draw, and to clamp motor targets (a target outside the limits makes the motor fight
the limit forever).

## Motors

Each joint has a motor that drives the child's rotation relative to the parent toward a target. The control law is a
PD controller on the rotation error:

```
q_err = q_target · q_current⁻¹              (relative rotations, in the parent frame; negate if w < 0)
e     = axis(q_err) · angle(q_err)           (rotation vector, rad)
τ     = s·k · e  +  √s·c · (ω_target − ω_rel)
τ     = τ · min(1, τ_max / |τ|)              applied +τ to the child, −τ to the parent
```

`k` and `c` come from `motorFrequency` and `motorDamping` as above. `s` is the joint's effective strength. Damping is
scaled by `√s` so the damping ratio stays constant as strength changes (`c = 2ζ√(kI)`). `ω_target` is the target's
angular velocity, finite-differenced from the last two targets, which removes the lag a pure P term has on moving
clips.

**Effective strength** of joint `j` at time `t`: `s = global(t) × perBone(j) × mask(j)`, clamped to [0, 1]. `global`
is the strength curve, `perBone` the multiplier column in the joint table, `mask` an optional per-bone override from a
trigger action (for example "arms only").

**Why "half way there" emerges.** A motor is a spring toward the target pose; gravity, contacts and momentum push
back. At rest the limb settles where they balance. A forearm of mass `m`, centre of mass at `l`, held horizontal by
the elbow, has steady-state error `e ≈ m·g·l / (s·k)`. At `s = 1` and 6 Hz that is a few degrees (the clip plays). At
`s = 0.1` it is ten times larger (the arm sags but still reaches). Past the point where gravity needs more than
`τ_max`, the torque clamp gives in and the limb drops. A limb blocked by the ground or a wall gets the full clamped
torque pushing into the contact, so it presses and slides along it instead of passing through. Nothing in the code
says "half way": it is the equilibrium of a spring with a limited force.

**Strength curve.** A JSON curve `[[t, value], …]` in seconds since it was set, linear between keys, last value held.
Named presets:

| Preset | Keys | Look |
|---|---|---|
| `limp` | `[[0, 0]]` | dead weight |
| `stunned` | `[[0, 0.02], [0.6, 0.02], [2.0, 0.25]]` | collapses, then slowly tenses |
| `writhe` | `[[0, 0.05], [0.4, 0.05], [1.5, 0.6]]` | goes down, then plays the pain clip at 60% |
| `brace` | `[[0, 0.3], [0.15, 0.8]]` | hit while standing, catches itself |
| `full` | `[[0, 1]]` | clip plays through physics |

**Targets from clips.** Motor targets are sampled from the same animation graph that drives animated agents, at the
physics time (not the render time). Ragdoll bodies may merge several bones (`chest` = `chest` + `upperChest`), so the
target is computed from model-space transforms: `q_target = W(parentBody)⁻¹ · W(childBody)`, where `W` is the
model-space rotation of the bone each body follows, then expressed in the joint frame and clamped to the limits. Root
motion does not enter: motors only control relative rotations; the pelvis is free.

**Stability.**

| Parameter | Default | Why |
|---|---|---|
| `physicsHz` | 60 | fixed step, accumulator, render interpolates between the last two states |
| `substeps` | 2 (Jolt), 4 (Rapier) | stiff motors and contacts at 120–240 Hz |
| `velocityIterations` / `positionIterations` | 10 / 2 | Jolt defaults; enough for 15-body chains |
| `motorFrequency` | 6 Hz | explicit springs diverge once `2πf·Δt` nears 2 (`f` ≈ 0.3× the substep rate); 6 Hz is far below that |
| `motorDamping` | 1.0 | critically damped, no overshoot |
| max mass ratio across a joint | 1:10 | enforced by `inertiaScale` and a minimum body mass of 0.5 kg |
| `maxAngularVelocity` | 30 rad/s | caps explosions after deep penetrations |

Engine motors (Jolt) are implicit: the spring is solved inside the constraint, so they stay stable at high gains. The
Rapier adapter's explicit torques use stable PD (Tan, Liu and Turk, *Stable Proportional-Derivative Controllers*,
2011), which evaluates the error at the next step's predicted state: `τ = −k(q + Δt·q̇ − q_target) − c·(q̇ + Δt·q̈)`.

## Animation layer

**Clips.** Assets are glTF. For Mixamo: download FBX "without skin" per clip (and with "in place" off, to keep root
motion), convert with `FBX2glTF` or Blender, merge clips onto one skeleton, resample to 30 fps with `gltf-transform`.
Mixamo stores root motion on `Hips`; at load it is extracted into a root track (hips XZ translation and yaw), leaving
hips height, pitch and roll on the hips. Each clip gets metadata: `loop`, `speed` (root speed, m/s), and sync markers.
Foot markers (`L`, `R` = foot down) are detected automatically: the frame where a foot's height is within 2 cm of its
clip minimum and its horizontal speed falls below 0.3 m/s.

**Pose buffers, not `AnimationMixer`.** The graph samples tracks with three.js interpolants into flat `Float32Array`
poses (translation + quaternion per canonical bone), blends them with pure functions, and writes the final pose to the
bones once. `AnimationMixer` hides the pose, and this design needs it as data: motor targets, physics blends, IK and
baking all read it. Pure pose functions also make the whole layer testable under `node --test` and deterministic.

**State machine.** States are nodes playing a clip or a blend tree. Transitions are edges with conditions over graph
parameters (`speed`, `turn`, `grounded`, any user variable):

| Transition field | Default | Meaning |
|---|---|---|
| `from`, `to` | — | state names; `from: "*"` for any state |
| `when` | — | condition, same grammar as triggers |
| `duration` | 0.25 s | crossfade length |
| `sync` | `"markers"` | `"markers"`: target starts at the source's phase between foot markers; `"none"`: from 0 |
| `exitTime` | — | earliest normalised time in the source clip (e.g. 0.8 to finish a get-up) |
| `interrupt` | `true` | whether another transition may cut this one off |

Crossfades blend `pose = slerp(from, to, w)` with `w` on a smoothstep over `duration`. Inertialisation (Bollo,
*Inertialization: High-Performance Animation Transitions in Gears of War*, GDC 2018) is the upgrade if crossfade cost
or foot sliding becomes an issue.

**Blend trees.** 1D by speed: idle 0, walk 1.4, jog 3.0, run 5.5 m/s. The two clips around the agent's speed blend
linearly, with phase locked through markers, and playback rate scales so clip speed matches agent speed (clamped to
±20% before switching segments). 2D by velocity in the agent's frame (strafe, backpedal): gradient band
interpolation (Johansen, *Automated Semi-Procedural Animation for Character Locomotion*, 2009), whose weights are
exact at each sample and sum to 1. Turning: above 60° of heading error at speed under 0.5 m/s, play a turn-in-place
clip (90° or 180°); in motion, an additive lean proportional to yaw rate.

**Layers.** Each layer is a graph with a `weight`, a per-bone `mask` (weights per canonical bone, inherited by
children unless set) and a mode. Override layers slerp toward their pose; additive layers apply
`q = q_base · slerp(I, q_clip · q_ref⁻¹, w)` where `q_ref` is the clip's first frame. Typical stack: base locomotion,
upper-body override (carry, aim), additive breathing and lean, effectors, IK.

**Root motion.** `rootMotion: "clip"` moves the agent by the clip's root track (get-ups, turns in place);
`"steering"` (default for locomotion) moves the agent by its steering velocity and only uses clip speed to pick
playback rate. The agent's height is always `terrain(x, z)`.

**Foot IK on terrain.** Per foot, while its plant weight (1 near a foot marker, fading out over 0.15 s) is above 0:

1. Ground at the animated foot: `y = h(x, z)`, normal from central differences of `h` over 0.1 m.
2. Pelvis offset `= clamp(min(Δleft, Δright), −0.35, 0.1)` m, where `Δ` is the ground height minus the foot's
   animated height above the agent's root plane; smoothed with a critically damped spring of half-life 0.08 s.
3. Two-bone IK from hip to the target ankle. With thigh `a`, shin `b`, and `c = clamp(|target − hip|, |a − b| + ε,
   0.999(a + b))`, the knee's interior angle is `acos((a² + b² − c²) / 2ab)`; the bend plane comes from the animated
   knee direction (the pole), so knees never flip.
4. Foot rotation aligns to the ground normal, at most 30°, scaled by the plant weight.

**Effectors (MoGraph-style).** Layers that modify the pose procedurally, borrowed from Cinema 4D MoGraph effectors.
Each has `weight`, `mask`, an optional spherical falloff around a world point, and a seed from the agent id.

| Effector | Does | Main parameters (defaults) |
|---|---|---|
| `noise` | per-bone rotation from seeded value noise in time | `amplitude` 3°, `frequency` 0.4 Hz, `bones` spine/neck/head |
| `delay` | follow-through: each bone chases its animated rotation through a damped spring | `frequency` 3 Hz, `damping` 0.5 |
| `lookAt` | aims chest/neck/head at a target, distributed along the chain | split 0.2/0.3/0.5, `maxYaw` 70°, `maxPitch` 40° |
| `step` | offsets clip time and rate per agent so a crowd never marches in sync | `timeOffset` 0–1 cycle, `rate` ±8% |
| `random` | per-agent variation of stride, arm swing amplitude and posture | ±10% |

`step` and `random` are the crowd's "variation" tools; `noise`, `delay` and `lookAt` add life to single agents and to
active ragdoll targets.

## Triggers

Triggers are JSON rules evaluated once per fixed tick, after the physics step, in a fixed order (priority descending,
then index). A trigger fires when its condition holds and it is not in cooldown; its actions run in order. Of several
firing triggers that change state or ragdoll mode in one tick, the highest priority wins; other actions (variables,
events) all run.

| Condition | Fields | True when |
|---|---|---|
| `impact` | `minImpulse` N·s, `minSpeed` m/s, `bones`, `tag` | a contact this tick exceeds the impulse or relative normal speed, on the listed bodies, from a body with the tag |
| `contact` | `tag`, `bones` | any body touches a body with the tag |
| `fall` | `minHeight` m | the agent has been airborne and dropped this far from the highest point |
| `slope` | `minDeg` | ground slope under the agent exceeds the angle |
| `near` | `tag`, `radius` | an object or agent with the tag is within the radius |
| `timeInState` | `min`, `max` s | time in the current state |
| `state` | list of names | current state is one of them |
| `ragdoll` | `settled`, `minTime` | ragdoll mode, optionally settled (below) for `minTime` |
| `balanceLost` | — | capture point outside the support polygon (Balance) |
| `var` | `name`, `op`, `value` | agent variable compare (`health`, `fear`, user variables) |
| `chance` | probability | seeded draw from `hash(seed, agentId, triggerIndex, tick)` |
| `all`, `any`, `not` | conditions | boolean combinators |

| Action | Fields | Effect |
|---|---|---|
| `setState` | name | transition the graph (bypasses transition conditions, keeps the crossfade) |
| `ragdoll` | `mode` (`powered` or `limp` for the whole body, `partial` for `bones` and their children), `strength`, `target`, `blendIn` | switch bodies to physics (below) |
| `motorStrength` | curve or preset name, `bones` | set the strength curve |
| `motorTarget` | clip or state name | what the motors chase |
| `hitReaction` | `strength` | short motor weakening on the hit chain (below) |
| `getUp` | `clips` | start the get-up sequence |
| `setVar` / `addVar` | `name`, `value` | write a variable; `impact` damage is `addVar health −(impulse − threshold) × scale` |
| `emit` | event name | `agent.on(name, …)` callback for game code |

Common fields: `priority` (0), `cooldown` seconds (0), `once` (false).

```json
{ "triggers": [
  { "name": "knockdown", "priority": 10,
    "when": { "all": [{ "state": ["walk", "run", "idle"] }, { "impact": { "minImpulse": 180, "tag": "projectile" } }] },
    "do": [{ "ragdoll": { "mode": "powered", "strength": "writhe", "target": "writhe_ground", "blendIn": 0.05 } },
           { "addVar": { "name": "health", "value": -40 } }] },
  { "name": "stagger", "priority": 5, "cooldown": 0.5,
    "when": { "impact": { "minImpulse": 40, "bones": ["chest", "spine", "head"] } },
    "do": [{ "hitReaction": { "strength": "brace" } }] },
  { "name": "arm-shot", "priority": 6,
    "when": { "impact": { "minImpulse": 60, "bones": ["leftUpperArm", "leftLowerArm"] } },
    "do": [{ "ragdoll": { "mode": "partial", "bones": ["leftUpperArm"], "strength": "stunned" } }] },
  { "name": "fell-off-ledge", "when": { "fall": { "minHeight": 2.5 } },
    "do": [{ "ragdoll": { "mode": "powered", "strength": "stunned", "target": "protect_head" } }] },
  { "name": "get-up",
    "when": { "all": [{ "ragdoll": { "settled": true, "minTime": 1.5 } }, { "var": { "name": "health", "op": ">", "value": 0 } }] },
    "do": [{ "getUp": {} }] },
  { "name": "panic", "once": true,
    "when": { "all": [{ "near": { "tag": "downed", "radius": 6 } }, { "chance": 0.5 }] },
    "do": [{ "setVar": { "name": "fear", "value": 1 } }, { "setState": "flee" }] }
] }
```

A JSON schema ships with the package; `Character.set({ triggers })` validates and rejects unknown conditions.

## Ragdoll and animation blending

Every simulated body is in one of three modes, and every bone has a visual blend weight `w ∈ [0, 1]` between the
animated pose and the physical pose: `q_bone = slerp(q_anim, q_phys, w)`, ramped over `blendIn` / `blendOut`.

| Body mode | Physics | Use |
|---|---|---|
| `kinematic` | follows the animated pose (`setKinematicTarget` every step) | animated agents near the camera: projectiles hit them and raise `impact` |
| `powered` | dynamic, motors on | active ragdoll, hit reactions |
| `limp` | dynamic, motors off, joint friction only | death, `limp` preset |

| Agent mode | Bodies | Visual `w` |
|---|---|---|
| `animated` | all kinematic (or no bodies at LOD 1+) | 0 |
| `partial` | the listed bones and their descendants powered; the rest kinematic | 1 on the physical part |
| `powered` | all powered | 1 |
| `limp` | all limp | 1 |

**Going physical.** When bodies switch from kinematic to dynamic, they keep the velocity of the animation: linear and
angular velocity are the finite difference of the last two kinematic targets. A runner hit mid-stride tumbles
forward with its momentum instead of dropping straight down.

**Partial ragdoll.** The physical part always hangs off a kinematic body (for "upper body physical, legs animate", the
pelvis and legs stay kinematic and drive the spine joint), so the physical chain is anchored and the animated part is
unaffected. Typical uses: shot in the arm while running, carrying a wobbling load, grabbing a ledge.

**Hit reaction.** Without leaving animation:

1. Apply the contact impulse at the contact point on the hit body.
2. Switch the hit body and its chain up to the pelvis to `powered`; drop strength on the hit body to 0.1, and on
   bodies `d` joints away to `0.1 + 0.9·(1 − 0.5^d)`; hold 0.15 s, recover to 1 over 0.4 s.
3. The legs stay kinematic and keep walking. If the pelvis tilts beyond 35° or `balanceLost` fires, escalate to a full
   `powered` ragdoll (a stumble that becomes a fall).
4. When strength is back to 1, ramp `w` to 0 over 0.3 s and return the bodies to kinematic.

**Settled.** Pelvis speed below 0.2 m/s and angular speed below 0.5 rad/s for 0.5 s, or 6 s in ragdoll, whichever
first.

**Getting up.**

1. **Orientation.** Pelvis forward axis (+Z) dotted with world up: above 0.3 face up (`getup_back`), below −0.3 face
   down (`getup_front`), otherwise side (`getup_side`, or roll to front by a short powered `roll` target).
2. **Root alignment.** Agent position = pelvis XZ projected onto the terrain. Yaw is chosen so the clip's first-frame
   pelvis-to-head direction (projected on XZ) matches the ragdoll's.
3. **Blend.** Freeze the ragdoll pose (model-space rotations), set all bodies kinematic, start the clip at 0 and blend
   from the frozen pose to the clip over `getUpBlend` (0.35 s). The clip uses `rootMotion: "clip"`, and its exit
   transition has `exitTime` 0.85.
4. **Space check.** If the slope is over 30° or a capsule cast above the body hits something, stay down and retry
   after 1 s.

A `physical` get-up option drives the powered ragdoll to the get-up clip with strength ramped to 1 instead; it looks
more grounded but fails on rough ground, so it is opt-in.

**Balance (optional).** Centre of mass `x = Σ mᵢxᵢ / Σ mᵢ`. Support polygon: convex hull of foot contact points, or
of the foot boxes' soles when the feet are kinematic. Capture point (Pratt et al., *Capture Point*, 2006):
`x_cp = x + v·√(h/g)`, with `h` the COM height. When it leaves the polygon by more than 5 cm, `balanceLost` fires.
For powered agents with `balance: true`, a SIMBICON-style correction (Yin, Loken and van de Panne, 2007) adjusts the
target hip and ankle angles of the stance leg by `c_d·d + c_v·v` (`d`, `v` the horizontal COM offset and velocity
from the stance ankle; defaults `c_d = 0.5`, `c_v = 0.2` rad per m and m/s), which lets a pushed character recover
from small shoves.

## Crowds

**Spawning.** Agents are placed by the tiled blue-noise sampler of `threejs-scatter` inside a region (circle, polygon
or `density` map), seeded per tile. Each agent draws its parameters from distributions keyed by
`hash(seed, agentId, field)`:

| Parameter | Default distribution |
|---|---|
| `walkSpeed` | normal(1.35, 0.15) m/s, clamped 0.9–1.8 |
| `runSpeed` | normal(4.5, 0.6) m/s, clamped 3–7 |
| `radius` | 0.28 m |
| `mass` | normal(70, 10) kg |
| `scale` | normal(1, 0.05) |
| `variant` | weighted choice of meshes and material tints |
| `phase` | uniform(0, 1) clip cycle offset (the `step` effector) |

**Navigation.** Each agent has a goal. Open terrain: a coarse grid (2 m cells) around the crowd, with cost from slope
(impassable above 35°) and water; A* per agent group toward its goal, or a shared flow field when many agents share
a goal. City: A* on the road graph of `threejs-city` (WORLDGEN.md §7), walking sidewalk lanes offset 2 m from the
road centre line, crossing at junctions. The path gives a preferred velocity toward the next waypoint.

**Avoidance.** ORCA (van den Berg, Guy, Lin and Manocha, *Reciprocal n-Body Collision Avoidance*, 2011): each
neighbour adds a half-plane of allowed velocities, and a small linear program picks the velocity closest to the
preferred one, falling back to the 3D program when the constraints are infeasible (as in RVO2). Defaults: 10
neighbours within 6 m from a uniform hash grid (2 m cells), time horizon 2 s for agents and 1 s for obstacles.
Downed agents become static disc obstacles, which also feeds the `near` condition ("downed" tag). ORCA is chosen over
social forces (Helbing and Molnár, 1995) because it is collision-free by construction and needs no tuning per crowd
density; a social-force term can be added to the preferred velocity for panic behaviour.

**Agent update, per fixed tick.** Triggers → navigation → ORCA → integrate position, `y = terrain(x, z)` → graph
parameters (`speed`, `turn`) → animation graph (by LOD) → physics targets.

**Level of detail.**

| Tier | Default distance | Animation | Physics | Rendering |
|---|---|---|---|---|
| L0 | ≤ 15 m, at most 32 agents | full graph, effectors, foot IK | kinematic proxies; can go ragdoll | `SkinnedMesh` |
| L1 | ≤ 60 m | graph at 30 Hz, no IK, base layer and `step` only | one capsule per agent for ray hits; a hit promotes to L0 if the budget allows, else plays a hit clip | `SkinnedMesh`, skinning at 30 Hz |
| L2 | ≤ 250 m | locomotion state and clip time only | none | one `InstancedMesh` per variant, GPU skinning from a baked bone texture |
| — | > 250 m | — | — | culled |

Far agents use **baked bone textures**: every clip is sampled at 30 fps into a float texture of bone matrices (3
texels per bone per frame), and a TSL vertex node skins each instance from its clip index, time and rate (instance
attributes). That is far smaller than vertex animation textures (bones × frames instead of vertices × frames) and
blends two clips per instance for free. Tier changes cross-fade over 0.3 s with hysteresis of 10%.

**Ragdoll budget.** `maxRagdolls` (24) caps dynamic ragdolls and `maxPowered` (8) caps those with motors. Priority =
on-screen × `1/(1 + distance)` × recency. Over budget, the lowest-priority settled ragdoll is frozen: its bodies are
removed and its last pose stays as a static pose, which L2 can still render. If no ragdoll can be frozen, new hits
play a canned hit-and-fall clip instead.

**World collision.** Terrain colliders exist only around active ragdolls and L0 agents: a heightfield patch of
32 × 32 m at 0.5 m spacing sampled from `HeightFn`, re-centred when a body nears its edge. Tree trunks from
`threejs-scatter` and building footprints from `threejs-city` within the patch become capsules and boxes.

**Grass.** `threejs-grass` takes up to 16 `Interactor`s (`MAX_INTERACTORS`). The crowd owns a pool of 16 proxy
`Object3D`s, assigned each frame to the agents nearest the camera: feet while walking (radius 0.35 m), the pelvis
while ragdolled (radius 0.6 m). Pass `crowd.interactors` to the grass options; no grass change is needed.

**Determinism.** Fixed timestep; agents updated in id order; every random draw from `hash(seed, agentId, purpose,
tick)`; no `Math.random` or wall-clock time. Physics is deterministic on the same engine build with the same
creation order. `Math.sin`, `Math.exp` and friends are not specified bit-exactly across JS engines, so code on the
deterministic path that branches on results (trigger chance, ORCA, noise) uses only `+ − × /` and our own polynomial
approximations.

**Performance budgets.** Targets for a mid-range desktop (Apple M1, single-threaded WASM), to be confirmed by the
phase-2 benchmark:

| Work | Budget |
|---|---|
| physics: 24 dynamic ragdolls (8 powered) + 32 kinematic L0 agents, 60 Hz, 2 substeps | ≤ 4 ms per frame |
| animation: 32 L0 agents (graph, IK, effectors) | ≤ 2 ms |
| animation: 300 L1 agents at 30 Hz | ≤ 2 ms |
| ORCA and navigation: 1,000 agents | ≤ 1.5 ms |
| L2: 5,000 instanced agents | ≤ 0.5 ms CPU (instance attributes only) |

Physics runs on the main thread at first. Multi-threaded WASM needs `SharedArrayBuffer`, which needs COOP/COEP
headers that GitHub Pages (the demo host) cannot set, so the upgrade is moving the whole physics world into one
worker and posting transforms back.

## API

Options are plain JSON (every table default above is the option's default); `deps` holds the non-JSON inputs
(terrain, physics world, road graph), like the `terrain` input of `threejs-grass`. Each class has `set(partial)`,
`reset(full)`, `update()` and `dispose()`, omitted below.

```ts
// threejs-character: pure pose functions plus the agent class
function autoBoneMap(skeleton: Skeleton): BoneMap                       // Partial<Record<HumanoidBone, string>>
function samplePose(clip: AnimationClip, time: number, rig: Rig, out: Pose): Pose
function blendPoses(a: Pose, b: Pose, w: number, mask: Float32Array | null, out: Pose): Pose
function twoBoneIK(hip: Vector3, knee: Vector3, ankle: Vector3, target: Vector3, pole: Vector3, out: Quaternion[]): void

interface CharacterOptions {
  seed: number                                    // 1
  model: { url: string; boneMap?: BoneMap }
  clips: { url: string }[]
  graph: GraphOptions                             // states, transitions, blendTrees, layers, effectors
  triggers: TriggerOptions[]
  ik: { feet: boolean; maxPelvisDrop: number; maxFootAngle: number }
  mass: number
}
class Character {
  static create(input: Partial<CharacterOptions>, deps: { terrain: Terrain; world?: RagdollWorld }): Promise<Character>
  readonly object: Object3D
  readonly state: string
  readonly vars: Record<string, number>
  setParam(name: string, value: number): void    // graph parameters: speed, turn, user values
  on(event: string, fn: (agent: Character) => void): () => void
}

// threejs-ragdoll
function swingTwist(q: Quaternion, axis: Vector3, swing: Quaternion, twist: Quaternion): number   // twist angle
function clampSwingTwist(q: Quaternion, frame: JointFrame, limits: JointLimits, out: Quaternion): boolean
function pdTorque(cur: Quaternion, target: Quaternion, wRel: Vector3, wTarget: Vector3, m: MotorParams, out: Vector3): Vector3

class RagdollWorld {                              // owns the adapter, the fixed-step clock and terrain patches
  static create(o: { engine: 'jolt' | 'rapier'; physicsHz?: number; substeps?: number }): Promise<RagdollWorld>
  readonly adapter: PhysicsAdapter
}
class Ragdoll {
  static create(character: Character, world: RagdollWorld, input?: Partial<RagdollOptions>): Ragdoll
  readonly mode: 'animated' | 'partial' | 'powered' | 'limp'
  readonly settled: boolean
  goPhysical(mode: 'partial' | 'powered' | 'limp', o?: { bones?: HumanoidBone[]; blendIn?: number }): void
  setStrength(curve: string | [number, number][], bones?: HumanoidBone[]): void   // default "full"
  setTarget(clipOrState: string): void
  hit(bone: HumanoidBone, impulse: Vector3, point: Vector3): void
  getUp(): void
}

// threejs-crowd
class Crowd {
  static create(input: Partial<CrowdOptions>, deps: { terrain: Terrain; world?: RagdollWorld; roads?: RoadGraph }): Promise<Crowd>
  readonly object: Object3D
  readonly agents: readonly Agent[]               // id, position, velocity, state, mode, vars, lod
  readonly interactors: Interactor[]              // hand to threejs-grass
  impulseAt(point: Vector3, impulse: Vector3, radius: number, tag?: string): void
  update(dt: number, camera: Camera): void
}
// CrowdOptions: seed, region, count (100), variants, distributions, goal, character, ragdoll, orca, lod,
// maxRagdolls, maxPowered, debug
```

**React** (`./react` in each package): props are the options; components call `reset(props)` on render and
`update()` in `useFrame`.

```tsx
<RagdollWorld engine="jolt">                      {/* provides the world through context */}
  <Crowd terrain={height} count={200} region={{ center: [0, 0], radius: 40 }} goal={[120, 0]}
         character={{ clips, graph, triggers }} onReady={(c) => setInteractors(c.interactors)} />
  <Agent model={{ url: '/hero.glb' }} clips={clips} graph={graph} terrain={height}>
    <Ragdoll strength="brace" debug={{ limits: true }} />
  </Agent>
</RagdollWorld>
```

`<Agent>` wraps `Character`, `<Ragdoll>` attaches to its parent agent, and `<Crowd>` runs animation-only when there
is no `<RagdollWorld>` above it.

## Debug views

| Flag | Draws |
|---|---|
| `proxies` | collision capsules and boxes, coloured by body mode (grey kinematic, blue powered, orange limp) |
| `limits` | each swing-twist joint's elliptical cone and twist arc at the joint, current bone axis as a line; red when on the limit |
| `targets` | motor target pose as a ghost skeleton; each joint coloured green → red by `|τ| / τ_max` (saturation) |
| `contacts` | contact points and impulses, impacts above a trigger threshold highlighted |
| `com` | centre of mass, capture point, support polygon |
| `states` | text label per agent: state, mode, LOD tier, last trigger fired |
| `orca` | neighbour links and the chosen velocity vs preferred velocity |
| `paths` | each agent's path and current waypoint |

All are `LineSegments` and sprites rebuilt per frame from buffers, off by default, and bound to the demo GUI.

## Tests

Pure logic under `node --test`, no DOM or GPU:

- **Swing-twist:** `swing · twist` reconstructs `q` within 1e-6 for 10,000 seeded random rotations; twist is about
  `t` and swing is perpendicular to it; 180° swing returns identity twist without NaN.
- **Limit clamping:** points inside the ellipse are unchanged; outside points land on it (`f = 1 ± 1e-6`); asymmetric
  limits map to the right frame offset and half-angles; hinge clamp.
- **PD controller:** a one-DOF pendulum integrated at 240 Hz converges to a target with < 2% overshoot at
  `ζ = 1`; steady-state error under gravity matches `m·g·l / (s·k)` within 5%; torque never exceeds `τ_max`.
- **Strength curves and presets:** interpolation, hold after the last key, `√s` damping scaling.
- **Triggers:** each condition in isolation; combinators; priority, cooldown and `once`; `chance` gives the same draws
  for the same seed; schema rejects unknown keys.
- **Animation:** crossfade weights sum to 1; marker sync starts the target at the same foot phase; 1D and gradient-band
  2D weights are exact at samples and sum to 1; additive of the reference pose is identity.
- **IK:** two-bone IK reaches reachable targets within 1 mm, keeps the knee in the pole plane, and stretches straight
  toward unreachable ones.
- **Rig:** auto bone map for Mixamo, VRM and Unreal name sets; retargeting a clip onto its own rig is identity;
  T-pose → A-pose keeps hand positions within 1 cm.
- **Mass table** sums to 100%; proxies of a reference rig fall within 10% of hand-measured radii.
- **Get-up:** face-up, face-down and side classification from pelvis orientation; yaw alignment.
- **Balance:** capture point formula; polygon containment.
- **ORCA:** two agents head-on, and 8 agents swapping places on a circle, never overlap over a 20 s simulation; the
  result is symmetric under mirroring.

Integration, also in Node (Jolt and Rapier both run there):

- A limp ragdoll dropped from 1 m settles with every joint within its limits + 2°.
- A powered ragdoll at strength 1 holds a standing T-pose against gravity within 5° per joint for 5 s.
- Two runs with the same seed and inputs give bit-identical body transforms after 600 steps (same engine build).

## Demos

1. **Ragdoll lab** (`example/ragdoll.html`): one agent on flat ground, GUI for every ragdoll option, buttons to hit
   (pick a bone), go limp, go powered with a chosen target clip, and get up; all debug views.
2. **Crowd on the world** (`example/crowd.html` and its R3F twin): `threejs-biomes` terrain with grass, 200 agents
   spawned in a meadow running toward a goal over the hills with foot IK, grass parting around the nearest 16. Click
   to fire a 5 kg projectile at 40 m/s from the camera (CCD on): agents hit above the `knockdown` threshold go into
   powered ragdolls writhing on the `writhe_ground` clip, nearby agents `panic` and flee, and the downed get up after
   settling and rejoin the run.

Demo assets must be redistributable. Mixamo characters and clips can be used in projects but not redistributed as
assets, so the demos use CC0 characters and animations (such as Quaternius' animation library, licence checked before
committing), and the Mixamo pipeline above is documented for users' own assets.

## Phases

1. **Character core:** bone map, retargeting, pose buffers, clips with markers and root motion, state machine,
   1D blend tree, crossfades, foot IK on `HeightFn`. Demo: one agent walking and running over the terrain.
2. **Ragdoll:** `PhysicsAdapter`, Jolt adapter, proxies and mass, swing-twist limits, limp ragdoll, kinematic
   proxies, terrain patch colliders, debug views, performance benchmark. Ragdoll lab demo.
3. **Active ragdoll:** motors, strength curves, clip targets, hit reactions, partial ragdoll, get-up.
4. **Triggers:** conditions, actions, schema, wiring into character and ragdoll.
5. **Crowd:** spawning, navigation on terrain, ORCA, LOD L0 and L1, ragdoll budget, grass interactors. Crowd demo.
6. **Scale and cities:** L2 baked bone textures with instanced GPU skinning; road-graph navigation once
   `threejs-city` lands.
7. **Extras:** 2D blend trees, `delay`/`lookAt` effectors, balance controller, physical get-up, Rapier adapter,
   physics worker.

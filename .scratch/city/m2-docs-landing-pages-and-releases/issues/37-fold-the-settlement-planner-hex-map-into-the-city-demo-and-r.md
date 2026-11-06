# 37: Fold the settlement-planner hex map into the city demo and retire the separate population pages

**What to build:** threejs-city does not need four demo pages. The city demo (three.js and React Three Fiber) already places its settlement with the settlement planner; the separate planner pages exist only to show the hexagonal density map.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#91](https://github.com/AskAlice/threejs-worldgen/issues/91)
- State: OPEN
- Milestone: threejs-worldgen · M2 — Docs, landing pages and releases
- Labels: enhancement, ready-for-agent, task, project:threejs-worldgen, package:population, package:city, area:site
- Packages: city, population
- Opened: 2026-10-16

## Request

threejs-city does not need four demo pages. The city demo (three.js and React Three Fiber) already places its settlement with the settlement planner; the separate planner pages exist only to show the hexagonal density map.

## Plan

- Add a planner-map view to `city.html` and `city-r3f.html`: the H3 density / land-use overlay from the population pages, toggled from the options panel.
- Remove `population.html` / `population-r3f.html` (or redirect them to the city demo) and update every link: the city package landing page, root and package READMEs, SEO metadata, and the readme-cards test.
- Keep the options-coverage check passing: every planner option stays reachable from the city sandbox.

## Acceptance criteria

- [ ] The city demo can show the planner's hex map in both versions.
- [ ] No page or doc links to the retired planner pages.
- [ ] Options coverage and site checks pass.

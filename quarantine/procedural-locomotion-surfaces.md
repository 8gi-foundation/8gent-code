# Quarantine: Procedural Locomotion on Arbitrary Surfaces

## Source
- X: @rubenfro (RUBEN FRO, Mar 24, 2026)
- 471 likes, 43K views
- Procedural locomotion on GaussianSplat environments from @theworldlabs

## Key Insights
- Robot raycasts against environment data to find foot placement
- No meshes or colliders needed - works on arbitrary surface geometry
- Hexapod telemetry: speed, heading, tilt, terrain clarity, leg status, gait type
- Surface detection via raycasting = finding walkable surfaces without predefined paths

## Relevance to 8gent
- Lil Eight window physics needs to detect window surfaces to walk on
- CGWindowListCopyWindowInfo gives us window rects - these are the "surfaces"
- Raycasting approach: pet position + direction -> check if any window rect intersects
- Foot placement = snapping to window top edges, sides, bottom
- Gait system = walk animation speed adapts to surface angle (horizontal vs climbing)

## What to Build for Lil Eight Window Physics
- Surface detector: poll CGWindowList every 1-2s, build surface array
- Raycast function: given pet position + direction, find nearest surface
- Gravity: when no surface below, fall until hitting one
- Climbing: when surface is vertical (window side), switch to climb animation
- Edge detection: when reaching end of surface, either jump to adjacent or descend

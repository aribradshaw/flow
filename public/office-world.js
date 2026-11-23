// The worlds of the 3D office (docs/concepts/12-office.md). office.js owns the people, the agents and the
// camera; a world owns everything they stand in. Every world answers the same interface:
//
//   layout(keys, {commonR, org})     lay out for these members (the owner first) and rebuild the scenery. Answers
//                                    the plan, in the shape of office-layout.js: rooms [{key, x, y, z, facing}],
//                                    mainWall, boardAnchors(), meterAnchors(), radius, and doors(portals) when the world places them.
//                                    A plan may also answer, and office.js uses them when it does:
//                                      places() -> [{id, kind, name, x, z, heading, key?}]   where to stand at each place ("Go to…")
//                                      plan()   -> {bounds, zones:[{id, kind, name, x, z, w, d}]}   the floor as rectangles (a minimap)
//                                      route(from, to) -> [{x, z}]   the corners of a walk between two points
//                                      lounge [{x, z, fx, fz}]       where idle characters stand about
//                                      entrance {x, z}               where new characters walk in
//                                      roomWalls {glass, back}       glass over the rooms' low walls; back: false when the
//                                                                    world's own wall is the room's back wall
//                                      arriveAtSpawn                 people arrive at the spawn, not in their room
//   org(list, keys)                  optional: where the AgentFlow org stands in this world for these members,
//                                    {pos: Map(id -> {x, z, yaw}), radius, sig}; sig changes when the floor must be
//                                    laid out again. Without it the org is an org chart round the origin (office-figures.js)
//   adoptRooms(rooms)                optional: the rooms office.js built, for a world that fades walls
//   walls    [box]                   what else stops people and the camera (officeBox: height is the top)
//   terrain  {ground, floor, limit}  for office-controls.js to walk decks and stairs; null on one flat floor
//   ground(x, z)                     floor height there, or null where there is no floor (water)
//   floors   [Mesh]                  what a click or tap lands on
//   spawn, respawn(pos)              where people arrive, and come back after falling in
//   signs    [{x, y, z, text}]       names of places
//   center                           what the overview looks at
//   sea                              water level (-Infinity without water); splash(pos, t)
//   common(radius)                   the common area grew or shrank with the AgentFlow org
//   update(t, dt, {camera, motion})  each frame: water, sky, the deck's sway (motion: false stops it)
//   dispose()
//
// The layout math is in office-layout.js and office-world-core.js (no Three.js, tested by node);
// office-world-classic.js and office-world-yacht.js draw it.
import {worldId,WORLDS,DEFAULT_WORLD,wallsFrom} from './office-world-core.js';
import {createClassicWorld} from './office-world-classic.js';
import {createYachtWorld} from './office-world-yacht.js';
export {WORLDS,DEFAULT_WORLD,worldId,wallsFrom};

// ctx: {scene, deck} — deck is the group office.js adds rooms, people and agents to.
export const createWorld=(id,ctx)=>worldId(id)==='yacht'?createYachtWorld(ctx):createClassicWorld(ctx);

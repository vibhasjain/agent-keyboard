// Scene registry. Boot looks a scene up by its data-scene id (falling back to
// ship) for both the pre-mount script and the post-mount timeline.

import { expand } from './expand'
import { login } from './login'
import { photo } from './photo'
import type { Scene } from './scene'
import { ship } from './ship'
import { voice } from './voice'

export const SCENES: Record<string, Scene> = { ship, photo, voice, expand, login }
export const SCENE_NAMES = ['ship', 'photo', 'voice', 'expand', 'login'] as const

export function getScene(name: string): Scene {
  return SCENES[name] ?? ship
}

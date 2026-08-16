/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { SpindleMountPoint } from 'lumiverse-spindle-types'
import {
  HOST_MOUNT_POINTS,
  LEGACY_HOST_MOUNT_POINTS,
  isKnownMountPoint,
  type HostMountPoint,
  type WidenedMountPoint,
} from './mount-points'

const AUTHORITATIVE_HOST_MOUNT_POINTS = [
  'chat_header_left',
  'chat_header_center',
  'chat_header_right',
  'chat_top_dock',
  'chat_bottom_dock',
  'chat_surface_side',
  'chat_sidebar_left',
  'chat_sidebar_right',
  'chat_stream_before',
  'chat_stream_after',
  'chat_empty_state',
  'chat_composer_above',
  'chat_composer_below',
  'chat_input_tools_left',
  'chat_input_tools_right',
  'chat_actions',
  'chat_toolbar',
  'message_header',
  'message_body_before',
  'message_body_after',
  'message_footer',
  'message_actions',
  'message_edit_actions',
  'message_context_menu',
  'message_swipe_indicators',
  'landing_header',
  'landing_hero',
  'landing_characters',
  'landing_recent_chats',
  'landing_footer',
  'sidebar_top',
  'sidebar_bottom',
  'drawer_tab',
  'drawer_header_actions',
  'drawer_footer',
  'character_editor_tab',
  'character_browser_card_actions',
  'preset_editor_tab',
  'preset_editor_toolbar',
  'persona_editor_tab',
  'world_book_entry_table',
  'world_book_entry_row',
  'world_book_entry_editor',
  'world_book_entry_toolbar',
  'lorebook_workspace',
  'lorebook_half_workspace',
  'loom_builder_toolbar',
  'loom_builder_inspector',
  'regex_entry_row',
  'settings_tab',
  'settings_section',
  'settings_card_actions',
  'settings_extensions',
  'modal_header_actions',
  'modal_footer_actions',
  'command_palette_actions',
  'manage_chats_actions',
  'prompt_variables_toolbar',
] as const

const publishedPoint: SpindleMountPoint = 'sidebar'
const hostPoint: WidenedMountPoint = 'landing_main'
const chatSurfaceSidePoint: HostMountPoint = 'chat_surface_side'
const customPoint: WidenedMountPoint = 'third_party_custom_mount'
const widenedPoints: readonly WidenedMountPoint[] = [publishedPoint, hostPoint, chatSurfaceSidePoint, customPoint]

describe('host mount points', () => {
  test('publishes the authoritative catalog in exact order', () => {
    expect(HOST_MOUNT_POINTS).toEqual(AUTHORITATIVE_HOST_MOUNT_POINTS)
  })

  test('asserts exactly 58 canonical mount literals', () => {
    expect(HOST_MOUNT_POINTS).toHaveLength(58)
    expect(new Set(HOST_MOUNT_POINTS).size).toBe(58)
    expect(LEGACY_HOST_MOUNT_POINTS.every((point) => !(HOST_MOUNT_POINTS as readonly string[]).includes(point))).toBe(true)
  })

  test('accepts every point in the host catalog', () => {
    for (const point of AUTHORITATIVE_HOST_MOUNT_POINTS) {
      expect(isKnownMountPoint(point)).toBe(true)
    }
  })

  test('accepts legacy alias mount points without counting them in the catalog', () => {
    for (const point of LEGACY_HOST_MOUNT_POINTS) {
      expect(isKnownMountPoint(point)).toBe(true)
    }
    expect(HOST_MOUNT_POINTS).toHaveLength(58)
  })

  test('rejects an unknown point', () => {
    expect(isKnownMountPoint(customPoint)).toBe(false)
  })

  test('supports published, host, and custom widened mount-point values', () => {
    expect(widenedPoints).toEqual([
      'sidebar',
      'landing_main',
      'chat_surface_side',
      'third_party_custom_mount',
    ])
  })

  test('keeps landing_characters on the character panel, not recent chats', async () => {
    const srcRoot = resolve(import.meta.dir, '../..')
    const glob = new Bun.Glob('**/*.tsx')
    const paths: string[] = []

    for await (const path of glob.scan({ cwd: srcRoot, onlyFiles: true })) {
      if (!path.includes('.test.') && !path.includes('.isolated.')) paths.push(path)
    }

    const source = (await Promise.all(
      paths.map(path => Bun.file(resolve(srcRoot, path)).text()),
    )).join('\n')
    expect(source).toMatch(/data-component="LandingPageCharacterPanel"[\s\S]{0,160}data-spindle-mount="landing_characters"/)
    expect(source).not.toMatch(/data-component="LandingPageChats"[\s\S]{0,160}data-spindle-mount="landing_characters"/)
  })
})

/**
 * Bespoke, lightweight Excalidraw chrome.
 *
 * Excalidraw's stock UI assumes a FILE-backed document -- Open, Save to file,
 * "Excalidraw+", socials, a library browser. None of that applies here: a canvas
 * is broker-hosted, autosaved, and shared by link, so those entries are dead
 * weight at best and misleading at worst (Save-to-file writes a copy the broker
 * never sees). We keep the drawing surface and strip the rest.
 *
 * Two mechanisms, because Excalidraw exposes two:
 *   - UIOptions.canvasActions -- the supported switch for the file actions.
 *   - a <MainMenu> child      -- passing one REPLACES the default hamburger
 *                               wholesale, so what is listed here is all there is.
 * The library button has NO prop (renderTopRightUI only adds UI *next to* it), so
 * it goes in canvas-chrome.css against excalidraw's own class hooks.
 */

import { type Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import type { ComponentProps } from 'react'
import './canvas-chrome.css'

type ExcalidrawProps = ComponentProps<typeof Excalidraw>

/**
 * File actions off. `export: false` also drops the "Export scene" dialog (with
 * its Excalidraw+ upsell); image export survives via the menu item below.
 */
export const CANVAS_UI_OPTIONS: ExcalidrawProps['UIOptions'] = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false,
    saveAsImage: true,
    toggleTheme: true,
    clearCanvas: true,
    changeViewBackgroundColor: true,
  },
}

/**
 * The replacement hamburger -- only actions that mean something for a hosted
 * canvas. Renaming, sharing and save-state live in OUR header bar, not in here.
 */
export function CanvasMainMenu() {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
      <MainMenu.DefaultItems.ToggleTheme />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ClearCanvas />
    </MainMenu>
  )
}

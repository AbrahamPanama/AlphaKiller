# AlphaKiller UI Specification

## 1. Product Overview

AlphaKiller is a desktop image editing app for cleaning problematic transparent and semi-transparent pixels in PNG, JPEG, WebP, and TIFF assets. Its primary use case is fixing anti-aliased edges, halos, dirty mattes, and texture bleed issues in graphics, icons, sprites, UI assets, and exported artwork.

The interface should feel like a precise, modern production tool: fast, focused, visual, and confidence-building. Users should be able to load an image, immediately see the transparency problem, adjust cleanup tools, compare before and after, and export the result without navigating through unnecessary panels.

## 2. Target Users

- Digital artists cleaning PNG exports.
- Game developers preparing sprites and texture atlases.
- UI designers fixing icons or interface assets.
- Web developers removing fringe artifacts from transparent images.
- Technical users batch-processing large image sets.

The UI should support both casual one-off fixes and repeated professional workflows.

## 3. Core Design Goals

- Make transparent edge problems visually obvious.
- Provide immediate before/after feedback.
- Keep destructive operations reversible until export.
- Offer simple controls first, with advanced controls available but not dominant.
- Make batch processing feel reliable, inspectable, and safe.
- Favor clarity and precision over decorative visuals.
- Ensure the app feels native enough for desktop use while retaining a modern creative-tool polish.

## 4. Primary User Workflows

### 4.1 Single Image Cleanup

1. User opens or drags in a PNG, JPEG, WebP, TIF, or TIFF file.
2. App displays the image on a checkerboard canvas.
3. User switches preview background between checkerboard, black, white, gray, and custom color.
4. User selects a cleanup tool.
5. User adjusts sliders and sees live preview.
6. User toggles before/after, split view, or difference view.
7. User optionally trims transparent padding from the cleaned alpha.
8. User exports the cleaned image.

### 4.2 Batch Cleanup

1. User adds multiple images or a folder.
2. App shows a file queue with thumbnails and status.
3. User applies a preset or current cleanup settings to all files.
4. User previews selected files before export.
5. User chooses output folder and naming behavior.
6. App processes images with progress and clear success/error states.

### 4.3 Preset Workflow

1. User adjusts cleanup settings on an image.
2. User saves settings as a preset.
3. User reuses the preset on future files or batch jobs.
4. User can rename, duplicate, delete, import, and export presets.

## 5. App Structure

### 5.1 Main Window Layout

The main screen should be the editor, not a landing page.

Recommended layout:

- Top app bar: file actions, undo/redo, view controls, export button.
- Left sidebar: file/source panel and optional layer/source metadata.
- Center canvas: primary image preview and comparison tools.
- Right inspector: cleanup tools, settings, presets, and export options.
- Bottom status bar: zoom, dimensions, color under cursor, alpha under cursor, processing status.

The center canvas should dominate the window. Side panels should be useful but not visually heavy.

### 5.2 Empty State

The empty state should invite drag-and-drop directly into the editor canvas area.

Required elements:

- App name: AlphaKiller.
- Primary action: Open Image.
- Secondary action: Open Folder / Batch.
- Supported formats shown compactly: PNG, JPEG, WebP, TIFF.
- Recent files list if available.

Avoid marketing copy. The empty state should feel like a tool waiting for work.

## 6. Navigation and Information Architecture

Suggested top-level modes:

- Editor
- Batch
- Presets
- Settings

Editor should be the default mode. Batch may be a tab or a separate workspace, but users should be able to move between single-file editing and batch application without losing settings.

## 7. Canvas and Preview Requirements

### 7.1 Canvas Behavior

The canvas is the heart of the app.

Required capabilities:

- Pan.
- Zoom in/out.
- Fit to screen.
- 100% zoom.
- Pixel grid at high zoom.
- Transparent checkerboard background.
- Background preview color selector.
- Toggle original/processed.
- Split comparison view.
- Difference view.
- Alpha mask view.
- Edge inspection view.

### 7.2 Preview Backgrounds

Provide quick background swatches:

- Checkerboard.
- Black.
- White.
- Neutral gray.
- Custom color.

Users often only notice matte/fringe problems against certain colors, so these controls must be always available near the canvas.

### 7.3 Comparison Modes

Required comparison modes:

- Processed only.
- Original only.
- Horizontal split.
- Vertical split.
- Hold-to-preview original.
- Difference overlay.
- Alpha-only mask.

The split handle should be draggable and keyboard accessible.

## 8. Editing Tools

### 8.1 Edge Finishing

Purpose: Produce crisp, print-ready (1-bit) edges by binarizing alpha at a cutoff so no semi-transparent pixels remain, and optionally recolor the edge band to a chosen color (e.g. a black keyline) to "kill" the anti-aliased rim — useful for UV printing. Consolidates the former Alpha Threshold and Alpha Hardening tools.

Controls:

- Cutoff slider: 1-254 (alpha at/above becomes opaque, below becomes transparent).
- Edge color toggle + color swatch (default black).
- Edge width slider: 0-16 px (0 recolors only the existing rim; higher dilates an outward colored keyline).

Expected UI behavior:

- Show live preview.
- Warn subtly when hard cutoff may create jagged edges.
- Provide reset-to-default for each control.

### 8.2 Defringe / Matte Removal

Purpose: Remove color halos caused by transparent pixels carrying white, black, or colored matte values.

Controls:

- Matte color picker.
- Auto-detect matte color button.
- Strength slider.
- Matte tolerance slider (max color distance from the matte that still gets corrected).
- Edge depth slider (how far into the anti-aliased edge, by alpha, defringing reaches).
- Protect saturated colors toggle.
- Preview fringe map toggle.

Expected UI behavior:

- Matte color should be shown as a swatch.
- Auto-detect should explain confidence using simple UI language, not technical logs.

### 8.3 Color Bleed / Edge Padding

Purpose: Extend nearby opaque colors into transparent or semi-transparent pixels to prevent edge artifacts.

Controls:

- Reach slider (bleed distance in pixels).
- Affect transparent pixels toggle.
- Affect semi-transparent pixels toggle.
- Preserve alpha toggle.

Expected UI behavior:

- Especially useful for game assets and sprites.
- The UI should not imply this removes transparency; it fixes hidden RGB data around edges.

### 8.4 Cleanup Stack

Users should be able to enable multiple cleanup operations in order.

Required stack behavior:

- Each operation has an enable/disable toggle.
- Operations can be reordered.
- Each operation can be reset.
- Users can compare result with and without an individual operation.
- Stack can be saved as a preset.

For MVP, operation order may be fixed, but the UI should leave room for a future editable stack.

### 8.6 Delete Pen

Purpose: Manually remove unwanted pixels by painting transparency directly onto the source image buffer.

Controls:

- Tool toggle: Pan / Delete Pen.
- Brush size slider.
- Visible circular brush cursor.
- Drag to erase pixels to alpha 0.
- Preserve pan, zoom, and before/after split interactions.

Expected UI behavior:

- The brush size is measured in image pixels.
- The brush stroke should interpolate between pointer positions so quick strokes do not leave gaps.
- The split comparison handle should remain draggable even when Delete Pen is active.
- Deleted pixels should flow through the normal preview and export pipeline.

## 9. Inspector Panel Requirements

The right inspector should be compact and scannable.

Recommended sections:

- Preset selector.
- Cleanup tools.
- Tool-specific controls.
- Preview toggles.
- Export settings.

Controls should use familiar UI patterns:

- Sliders for continuous values.
- Steppers or numeric inputs for reach/depth.
- Toggles for boolean options.
- Swatches for colors.
- Segmented controls for modes.
- Icon buttons for undo, redo, zoom, split view, mask view, and export where appropriate.

Avoid long explanatory paragraphs inside the UI. Use tooltips and concise labels.

## 10. File Panel Requirements

The left panel should show:

- Current file thumbnail.
- Filename.
- Pixel dimensions.
- File size.
- Color type if known.
- Transparency presence indicator.
- Recent files or batch queue depending on mode.

For batch mode, each row should show:

- Thumbnail.
- Filename.
- Dimensions.
- Status: pending, processing, complete, warning, error.
- Preview button.
- Remove button.

## 11. Export Requirements

### 11.1 Single Export

Required options:

- Export as PNG.
- Export as JPEG.
- Export as TIFF.
- Export as PDF, with the bitmap placed at the current working DPI.
- Export as SVG, using the current vector contour.
- Export as WebP if supported.
- Choose destination.
- Overwrite warning.
- Add suffix option, default: `-cleaned`.
- Preserve dimensions.
- Preserve metadata toggle if supported.
- Protect pure white toggle (opt-in): nudges RGB 255,255,255 (CMYK 0,0,0,0) to 254,254,254 on visible pixels for all raster formats, so RIP software does not read paper-white as a knockout/alpha value. Not applicable to SVG.

### 11.2 Batch Export

Required options:

- Output folder.
- Preserve folder structure toggle.
- Filename suffix/prefix.
- Skip existing files.
- Overwrite existing files.
- Export report after completion.

Progress UI should include:

- Overall progress.
- Current file.
- Completed count.
- Failed count.
- Cancel button.
- Error details per file.

## 12. Preset System

Required preset features:

- Built-in presets.
- User presets.
- Save current settings as preset.
- Rename preset.
- Duplicate preset.
- Delete preset.
- Import/export presets as JSON.

Suggested built-in presets:

- Hard Alpha Cutout.
- Gentle Edge Cleanup.
- White Matte Defringe.
- Black Matte Defringe.
- Sprite Edge Padding.
- Icon Cleanup.

Preset names should be practical and tied to outcomes.

## 13. Visual Design Direction

AlphaKiller should feel like a modern desktop utility for visual production work.

Recommended style:

- Neutral, high-contrast workspace.
- Dark theme first, with light theme support.
- Canvas area slightly darker than panels.
- Subtle borders and separators.
- Compact controls with clear hit targets.
- No oversized marketing sections.
- No decorative background shapes.
- No card-heavy landing-page layout.

The visual tone should communicate precision and speed. It should not feel like a photo editor clone with dozens of unrelated tools.

## 14. Color and Theme Requirements

Required themes:

- Dark.
- Light.
- System.

Dark theme should avoid becoming a single dark-blue/slate palette. Use neutral grays with restrained accent colors.

Accent color:

- Use a sharp, high-visibility accent for active controls and preview overlays.
- Ensure WCAG contrast for text and controls.
- Avoid relying only on color for status.

Transparency checkerboard:

- Must be adjustable for light/dark themes.
- Should not visually overpower the image.

## 15. Typography

Typography should prioritize compact readability.

Requirements:

- Use a clean sans-serif UI font.
- Support system fonts by default.
- Avoid viewport-scaled font sizes.
- Use small but readable labels in inspector panels.
- Use tabular numbers for pixel values, alpha values, dimensions, and processing counts.

## 16. Accessibility Requirements

Required:

- Full keyboard access for menus, panels, sliders, comparison controls, and export actions.
- Visible focus states.
- Screen reader labels for icon buttons.
- Tooltips for icon-only controls.
- Sufficient color contrast.
- Non-color status indicators.
- Respect reduced motion settings.
- Sliders must support arrow-key adjustment and numeric entry where precision matters.

Keyboard shortcuts should be discoverable through menus and tooltips.

Suggested shortcuts:

- Open: Ctrl/Cmd+O.
- Export: Ctrl/Cmd+E.
- Undo: Ctrl/Cmd+Z.
- Redo: Ctrl/Cmd+Shift+Z.
- Fit to Screen: Ctrl/Cmd+0.
- 100% Zoom: Ctrl/Cmd+1.
- Toggle Original: Space or a hold key.
- Toggle Split View: S.
- Toggle Alpha Mask: A.

## 17. Responsive Desktop Behavior

The app is desktop-first, but should handle varied window sizes.

Requirements:

- Minimum useful window size should be defined.
- Side panels should be collapsible.
- Canvas should remain usable when panels are collapsed.
- Inspector controls should scroll independently.
- Toolbars should not wrap awkwardly.
- Text must not overflow buttons or controls.

## 18. Electron-Specific Requirements

The UI should account for native desktop behavior:

- Drag-and-drop files into the window.
- Native open/save dialogs.
- Native app menu integration.
- Recent files.
- Unsaved changes prompts.
- Safe overwrite confirmations.
- OS theme detection.
- Window state restoration.
- Offline operation.

Use the renderer for live preview and the main process for filesystem operations. Long-running image processing should use a worker thread or separate process so the UI remains responsive.

## 19. States and Error Handling

Required states:

- Empty.
- Loading image.
- Image loaded.
- Processing preview.
- Exporting.
- Batch processing.
- Export success.
- Recoverable warning.
- Blocking error.

Common error cases:

- Unsupported file format.
- Image too large for available memory.
- File cannot be read.
- Export destination unavailable.
- File already exists.
- Batch item failed.

Errors should be specific, calm, and actionable.

## 20. Performance UX

The app should feel immediate even on large images.

UI requirements:

- Show preview processing progress for large files.
- Debounce slider updates while preserving responsiveness.
- Use lower-resolution preview while dragging if necessary, then refine on release.
- Never freeze the interface during batch operations.
- Clearly indicate when preview is approximate.

## 21. Data Display Requirements

The status bar should display:

- Zoom percentage.
- Image dimensions.
- Cursor x/y position.
- RGBA under cursor.
- Alpha value under cursor.
- Current preview background.

Optional advanced inspection:

- Count of affected pixels.
- Percentage of semi-transparent pixels.
- Detected matte color.
- Estimated fringe severity.

## 22. Menus

Required menu groups:

- File: Open, Open Folder, Recent Files, Export, Batch Export, Close.
- Edit: Undo, Redo, Reset Settings, Preferences.
- View: Zoom In, Zoom Out, Fit, 100%, Toggle Grid, Toggle Alpha Mask, Toggle Split View.
- Tools: Defringe, Color Bleed, Edge Finishing.
- Help: Documentation, Keyboard Shortcuts, About AlphaKiller.

## 23. Design Deliverables Requested From Claude Design

Claude Design should produce:

- Main editor screen.
- Empty state.
- Single image loaded state.
- Inspector panel with each cleanup tool.
- Split comparison mode.
- Alpha mask mode.
- Batch processing screen.
- Preset management screen.
- Export dialog.
- Error and success states.
- Dark and light theme examples.

Each design should include component states:

- Default.
- Hover.
- Active.
- Disabled.
- Focused.
- Loading.
- Error.

## 24. Component Inventory

Required components:

- App shell.
- Top toolbar.
- Native-style menu affordances.
- Left file panel.
- Right inspector panel.
- Canvas viewport.
- Zoom controls.
- Background swatch selector.
- Comparison mode segmented control.
- Slider with numeric input.
- Toggle switch.
- Color picker/swatch.
- Preset dropdown.
- Cleanup operation row.
- Batch queue row.
- Export dialog.
- Toast notification.
- Blocking modal.
- Progress bar.
- Status bar.
- Tooltip.

## 25. MVP Scope

The first build should include:

- Single image open/import.
- Canvas preview.
- Checkerboard, black, white, gray, and custom preview backgrounds.
- Edge Finishing.
- Defringe.
- Color Bleed.
- Before/after toggle.
- Split view.
- Trim transparent padding.
- Export PNG.
- Export JPEG, flattened against a solid preview background because JPEG has no alpha channel.
- Export PDF with the cleaned bitmap embedded at the current working DPI.
- Export SVG vector contours from the current cleaned preview alpha.
- Basic presets.
- Dark theme.

Batch mode, light theme, advanced stack reordering, and preset import/export can follow after the MVP if needed.

## 26. Success Criteria

The UI is successful if:

- A new user can fix a halo or anti-aliased transparency issue within one minute.
- The canvas makes transparency artifacts easy to inspect.
- Users can confidently compare original and cleaned output.
- Controls feel precise without being intimidating.
- Export behavior is predictable and safe.
- The app remains responsive while previews update.
- The interface feels like a focused production tool, not a generic image editor.

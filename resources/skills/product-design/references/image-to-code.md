# Image To Code

Build a faithful responsive prototype from a selected image, screenshot, mockup, or generated
Product Design option after the design brief is confirmed.

## Workflow

1. Verify there is a visual target. A written brief alone is not enough.
2. Inspect the target image directly with `Read`.
   - If the current request includes a `Recent visual artifacts` context block with attached
     images, file paths, or URLs, treat those artifacts as the selected visual target and inspect
     them before asking the user to re-upload.
   - If the target is described as a previously generated image, first resolve it to an actual
     readable file path, uploaded attachment, URL, or saved Product Design asset.
   - If only chat text refers to the generated image and no readable image artifact is available,
     stop and ask the user to save, upload, or attach that exact image before building.
3. Catalog visible image assets: hero images, thumbnails, textures, illustrations, logos, product
   images, avatars, and decorative imagery.
4. Generate missing image assets with `ImageGenerate`, passing the target image in
   `reference_images` when helpful.
5. Use a real icon library that matches the design. Do not create custom CSS art, text glyphs, or
   inline SVG stand-ins for meaningful assets.
6. Measure layout, spacing, type hierarchy, colors, radii, and component density.
7. Bootstrap a standalone Vite React prototype unless the user explicitly asked to edit an existing
   app.
8. Implement visible controls and states: navigation, menus, tabs, forms, hover/focus, modals,
   filters, toggles, loading/error/empty states when shown or implied.
9. Run the app, capture the same viewport/state in Browser, and run `design-qa`.
10. Handoff only after `design-qa.md` says `final result: passed`.

If source capture or visual comparison is blocked, write a blocked QA report and explain the
blocker.

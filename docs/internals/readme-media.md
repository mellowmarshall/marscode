# README media

The images and GIFs in the root `README.md` come from the real web components, rendered with
neutral fixtures. They never come from a screenshot of a live app.

## Where things are

| Path                                          | What it holds                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/web/test/readme/*.media.tsx`            | One browser test per area. Each test renders a component and captures a frame.       |
| `apps/web/test/readme/readmeMediaFixtures.ts` | The neutral data the captures show (`host-a`, `example-org/example-repo`, ...).      |
| `apps/web/test/readme/readmeMediaCapture.tsx` | `MediaFrame` (the cropped element, dark theme), `captureMedia`, `holdAnimationsAt`.  |
| `scripts/readme-media.ts`                     | Runs the captures, converts PNG frames to WebP or GIF, and writes the source hashes. |
| `docs/readme/media.json`                      | Maps each image to the source files it shows, with a hash of those files.            |

## Commands

- `vp run readme:media` renders every image again and updates the hashes. It needs `ffmpeg` and an
  installed Playwright Chromium headless shell. It does not download a browser.
- `node scripts/readme-media.ts --check` fails when a mapped source changed after its image was
  made. It does not start a browser. The ship gate runs this check.

## Adding an image

1. Add a test to a `*.media.tsx` file. Wrap the component in `MediaFrame name="<image>"` and call
   `captureMedia("<image>")`.
2. For a GIF, capture each frame as `frames/<image>/NN` and pin the frame height
   (`MediaFrame minHeight`), because every frame must have the same size. Add the GIF to `GIFS` in
   `scripts/readme-media.ts` with its frame time and width.
3. To show a CSS animation, hold it at a phase with `holdAnimationsAt(frame, seconds)` and capture
   with `animations: "allow"`. The default capture stops infinite animations, so a pulse would not
   show.
4. Add an entry to `docs/readme/media.json` that lists the component files the image shows, the
   test, and the fixtures.
5. Run `vp run readme:media`, then look at every new image before you commit it.

## Privacy

This repository is public. Fixtures use neutral names only: `host-a`, `example-org/example-repo`,
`project-a`, `model-a`. Never use a real host, user, path, repository, email, token, or usage
figure. Look at each image you make and check that it shows none of these.

Add an image only where a picture explains a feature better than a sentence, and keep each one
small (WebP for stills, a short GIF for motion).

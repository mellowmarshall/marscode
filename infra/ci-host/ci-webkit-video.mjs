// Headless WebKit H.264 playback probe (`node ci-webkit-video.mjs PLAYWRIGHT_CORE CLIP SECONDS [NAME=VALUE...]`).
// Prints `frames=N time=T error=E` and always closes the browser before exiting.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";

const FRAMES_ENOUGH = 10;
const [core, clip, seconds, ...words] = process.argv.slice(2);
const { webkit } = NodeModule.createRequire(import.meta.url)(core);
const data = NodeFS.readFileSync(clip);
const env = { ...process.env };
for (const w of words) {
  const at = w.indexOf("=");
  if (at < 1) throw new Error(`not NAME=VALUE: ${w}`);
  const [name, value] = [w.slice(0, at), w.slice(at + 1)];
  if (value === "") delete env[name];
  else env[name] = value;
}

// The clip with byte ranges, as a real server gives a video.
const server = NodeHttp.createServer((req, res) => {
  if (req.url !== "/clip.mp4") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      '<!doctype html><video id=v muted playsinline src="/clip.mp4" width=640 height=360></video>',
    );
  }
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  const [from, to] = range
    ? [Number(range[1]), range[2] ? Number(range[2]) : data.length - 1]
    : [0, data.length - 1];
  res.writeHead(range ? 206 : 200, {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "content-length": to - from + 1,
    ...(range ? { "content-range": `bytes ${from}-${to}/${data.length}` } : {}),
  });
  res.end(data.subarray(from, to + 1));
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const limit = Number(seconds) * 1000;
const browser = await webkit.launch({ headless: true, env, timeout: limit });
let seen = { frames: 0, time: 0, error: "none" };
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(limit);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => document.getElementById("v").play());
  const end = Date.now() + limit;
  while (Date.now() < end) {
    seen = await page.evaluate(() => {
      const v = document.getElementById("v");
      return {
        frames: v.getVideoPlaybackQuality().totalVideoFrames,
        time: Number(v.currentTime.toFixed(2)),
        error: v.error ? `code${v.error.code}` : "none",
      };
    });
    if (seen.frames >= FRAMES_ENOUGH || seen.error !== "none") break;
    await new Promise((later) => setTimeout(later, 200));
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`frames=${seen.frames} time=${seen.time} error=${seen.error}`);

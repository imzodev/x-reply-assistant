const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const root = __dirname;
const outdir = path.join(root, "dist");
const staticFiles = ["manifest.json", "src/options.html", "src/content.css"];

function copyStaticFile(relativePath) {
  const source = path.join(root, relativePath);
  const destination = path.join(outdir, path.basename(relativePath));
  fs.copyFileSync(source, destination);
}

function copyStaticFiles() {
  for (const file of staticFiles) copyStaticFile(file);

  const icons = path.join(root, "icons");
  if (fs.existsSync(icons)) {
    fs.cpSync(icons, path.join(outdir, "icons"), { recursive: true });
  }
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
copyStaticFiles();

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: "src/background.js",
    content: "src/content.js",
    options: "src/options.js",
  },
  bundle: true,
  outdir,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
};

async function main() {
  if (!watch) {
    await esbuild.build(options);
    console.log("Built extension to ./dist");
    return;
  }

  const context = await esbuild.context(options);
  await context.watch();

  // esbuild watches the JavaScript graph. Copy standalone extension files too.
  for (const file of staticFiles) {
    fs.watchFile(path.join(root, file), { interval: 300 }, () => {
      try {
        copyStaticFile(file);
        console.log(`Copied ${file}`);
      } catch (error) {
        console.error(`Could not copy ${file}:`, error);
      }
    });
  }

  console.log("Watching source files… Press Ctrl+C to stop.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

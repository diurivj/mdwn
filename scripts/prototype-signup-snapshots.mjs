// THROWAWAY: render fake-data design snapshots without starting a server.
// Run `npm run build` first for the app's real base stylesheet.
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const output = resolve(".scratch/mdwn/prototypes/signup-onboarding");
const temporary = await mkdtemp(join(tmpdir(), "mdwn-signup-snapshots-"));
const rendererFile = join(temporary, "render.cjs");
await mkdir(output, { recursive: true });
await build({
  stdin: {
    contents: `import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { MemoryRouter } from "react-router";
      import Prototype from "./app/routes/sign-up.prototype.tsx";
      export function render(variant, step) {
        return renderToStaticMarkup(createElement(MemoryRouter, {
          initialEntries: ["/sign-up?variant=" + variant + "&step=" + step]
        }, createElement(Prototype)));
      }`,
    resolveDir: process.cwd(), loader: "tsx",
  },
  platform: "node", format: "cjs", bundle: true, jsx: "automatic", outfile: rendererFile,
  define: { "import.meta.env.DEV": "true", "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "omit-css-import", setup(api) {
    api.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
  } }],
});
const { render } = (await import(pathToFileURL(rendererFile).href)).default;
const rootCss = (await readdir("build/client/assets")).find((file) => /^root-.*\.css$/.test(file));
if (!rootCss) throw new Error("Run npm run build first.");
const styles = `${await readFile(join("build/client/assets", rootCss), "utf8")}\n${await readFile("app/routes/sign-up.prototype.css", "utf8")}`;
const browser = await chromium.launch({ headless: true });
const gallery = [];
try {
  for (const variant of ["A", "B", "C"]) {
    for (const step of ["phrase", "confirm"]) {
      const markup = render(variant, step);
      for (const [viewport, width, height] of [["desktop", 1440, 1050], ["mobile", 390, 844]]) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body>${markup}</body></html>`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        if (overflow) throw new Error(`Horizontal overflow: ${variant}, ${step}, ${viewport}`);
        if (step === "confirm" && await page.locator(".proto-phrase").count()) throw new Error("Phrase display remains during confirmation");
        const name = `${variant.toLowerCase()}-${step}-${viewport}.png`;
        await page.screenshot({ path: join(output, name), fullPage: true, style: ".proto-switcher { visibility: hidden; }" });
        gallery.push({ variant, step, viewport, name });
        await page.close();
        console.log(`Captured ${name}`);
      }
    }
  }
} finally {
  await browser.close();
}
const names = { A: "Field notes", B: "One thing at a time", C: "Recovery booklet" };
const sections = ["A", "B", "C"].map((variant) => `<section id="${variant}"><h2>${variant} / ${names[variant]}</h2>${["phrase", "confirm"].map((step) => `<h3>${step === "phrase" ? "Save your phrase" : "Confirm from your saved copy"}</h3><div class="pair">${gallery.filter((item) => item.variant === variant && item.step === step).map((item) => `<figure class="${item.viewport}"><a href="${item.name}"><img src="${item.name}" alt="${names[variant]}, ${step}, ${item.viewport}"></a><figcaption>${item.viewport} · click for full size</figcaption></figure>`).join("")}</div>`).join("")}</section>`).join("");
await writeFile(join(output, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>mdwn / Signup design study</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf0e9;color:#26392e;font:15px/1.6 system-ui,sans-serif}main{max-width:1350px;padding:40px 30px;margin:auto}h1{font:48px Georgia,serif;margin:12px 0}header p{max-width:760px;color:#58675b}nav{display:flex;gap:20px;flex-wrap:wrap;margin:25px 0}a{color:inherit;text-underline-offset:4px}section{padding:35px 0;border-top:1px solid #b8c5b7}h2{font:30px Georgia,serif}h3{font-size:13px;font-weight:500}.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(200px,300px);gap:24px;align-items:start;margin-bottom:45px}figure{margin:0}img{display:block;width:100%;height:auto;box-shadow:0 4px 25px #24372e12}figcaption{font-size:11px;color:#58675b;margin-top:8px}code{background:#dce3d7;padding:3px 6px;border-radius:3px}@media(max-width:700px){main{padding:24px 16px}h1{font-size:36px}.pair{grid-template-columns:1fr}.mobile{max-width:390px}}
</style></head><body><main><header><small>MDWN / DESIGN STUDY 35 / FAKE DATA ONLY</small><h1>Three ways to begin.</h1><p>Actual desktop and mobile mockups. Each option separates saving the phrase from checking your saved copy. These are static snapshots; no real accounts or recovery material are involved.</p><p>For the clickable flow, run <code>npm run prototype:signup</code>, then open <a href="http://127.0.0.1:5174/sign-up?variant=A&step=phrase">the local preview</a>. Its bottom bar switches designs and screens.</p><nav><a href="#A">A — Field notes</a><a href="#B">B — One thing at a time</a><a href="#C">C — Recovery booklet</a></nav></header>${sections}</main></body></html>`);
console.log(`Open ${join(output, "index.html")} directly; no server required.`);

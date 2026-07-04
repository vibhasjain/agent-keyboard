// Zero-dep Gemini image generation. Usage:
//   node generate.mjs "<prompt>" <output.png> [input-image ...]
// Reads GEMINI_API_KEY from the environment (a Fly secret on configured
// deployments — never hardcoded, never committed).

import { readFile, writeFile } from "node:fs/promises";

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";
const [prompt, outPath, ...inputPaths] = process.argv.slice(2);

if (!prompt || !outPath) {
  console.error('usage: node generate.mjs "<prompt>" <output.png> [input-image ...]');
  process.exit(2);
}
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY is not configured — image generation is disabled on this deployment.");
  process.exit(3);
}

const mimeFor = (p) => {
  const l = p.toLowerCase();
  return l.endsWith(".png") ? "image/png" : l.endsWith(".webp") ? "image/webp" : "image/jpeg";
};

const parts = [{ text: prompt }];
for (const p of inputPaths) {
  parts.push({ inline_data: { mime_type: mimeFor(p), data: (await readFile(p)).toString("base64") } });
}

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
  {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  },
);
if (!res.ok) {
  console.error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const body = await res.json();
const outParts = body?.candidates?.[0]?.content?.parts ?? [];
const img = outParts.find((p) => p.inlineData?.data || p.inline_data?.data);
if (!img) {
  const text = outParts.map((p) => p.text).filter(Boolean).join(" ").slice(0, 300);
  console.error(`No image in the response${text ? ` — model said: ${text}` : ""}`);
  process.exit(1);
}
const data = img.inlineData?.data ?? img.inline_data?.data;
await writeFile(outPath, Buffer.from(data, "base64"));
console.log(`wrote ${outPath}`);

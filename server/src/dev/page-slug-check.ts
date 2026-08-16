// Unit-style check of pageSlugFor — the normalizer that maps a raw page path to
// a per-page conversation slug on a page-scoped site ("" = the site root). The
// output must be filename-safe by construction ([a-z0-9-] only, capped at 80)
// because it lands in pointer-file paths on the data volume.
// Run: `npx tsx src/dev/page-slug-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";
import { pageSlugFor } from "../sites.js";
import type { Site } from "../config.js";

const paged: Site = { id: "cv", repo: "https://x/y.git", branch: "main", domain: "vibhasjain.com", sessionScope: "page" };
const plain: Site = { id: "makemepixels", repo: "https://x/y.git", branch: "main", domain: "makemepixels.com" };

// The opt-in gate: a site-scoped site always maps to the root conversation.
assert.equal(pageSlugFor(plain, "/about"), "", "site-scoped site → always root");
assert.equal(pageSlugFor(plain, "/deep/path"), "", "site-scoped site → always root");

// Root and degenerate inputs → the site-root conversation.
assert.equal(pageSlugFor(paged, "/"), "", "root path → root conversation");
assert.equal(pageSlugFor(paged, undefined), "", "missing page → root");
assert.equal(pageSlugFor(paged, 42), "", "non-string page → root");
assert.equal(pageSlugFor(paged, "/???"), "", "all-unsafe path → root");

// Normalization: case, trailing slash, and .html all collapse to one page.
assert.equal(pageSlugFor(paged, "/About/"), "about");
assert.equal(pageSlugFor(paged, "/a.html"), "a");
assert.equal(pageSlugFor(paged, "/a/"), "a");
assert.equal(pageSlugFor(paged, "/a"), "a");
assert.equal(pageSlugFor(paged, "/a/index.html"), "a", "index.html ≡ the directory");

// Full pathname, slashes flattened — every page is its own conversation.
assert.equal(pageSlugFor(paged, "/blog/post-1"), "blog-post-1");

// Query/hash stripped; traversal collapses to a harmless bucket.
assert.equal(pageSlugFor(paged, "/a?q=1#frag"), "a");
assert.equal(pageSlugFor(paged, "/../etc/passwd"), "etc-passwd", "traversal-safe by construction");

// Length cap with no trailing hyphen.
const long = "/" + "x".repeat(79) + "-abc";
const capped = pageSlugFor(paged, long);
assert.ok(capped.length <= 80, "capped at 80");
assert.ok(!capped.endsWith("-"), "no trailing hyphen after the cap");

console.log("page-slug-check OK — opt-in gate, root mapping, normalization, safety, and cap all pass.");

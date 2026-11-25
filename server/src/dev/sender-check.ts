// Sender parsing for transcript name tags: `tsx src/dev/sender-check.ts`.
import assert from "node:assert/strict";
import { cleanUserText } from "../conversation.js";

const tagged = cleanUserText("[Sent from https://agentkeyboard.com/ by a@b.co]\n\nfix the footer");
assert.equal(tagged.sender, "a@b.co");
assert.equal(tagged.text, "fix the footer");

const legacy = cleanUserText("[Sent from https://agentkeyboard.com/]\n\nfix the footer");
assert.equal(legacy.sender, undefined);
assert.equal(legacy.text, "fix the footer");

const withAttach = cleanUserText(
  "[Sent from https://x.com/report by c@d.io]\n\nlook\n\nAttachment(s) attached — use the Read tool to inspect: /data/.tmp/a.png",
);
assert.equal(withAttach.sender, "c@d.io");
assert.equal(withAttach.attachments, 1);
assert.equal(withAttach.text, "look");

const withPhoto = cleanUserText(
  "hi\n\nAttachment(s) attached — use the Read tool to inspect: .tmp/uploads/09b0c6ce-118b-4b0e-96c8-60e25a74c35a.jpg, .tmp/uploads/09b0c6ce-118b-4b0e-96c8-60e25a74c35b-doc.pdf",
);
assert.deepEqual(withPhoto.thumbs, ["09b0c6ce-118b-4b0e-96c8-60e25a74c35a.jpg"]);
assert.equal(withPhoto.attachments, 1);

console.log("sender-check ok");

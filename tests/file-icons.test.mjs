import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FileIcons = require("../renderer/ai/components/attachments/file-icons.js");

test("unknown file types use the shared external file icon", () => {
    const markup = FileIcons.getIconMarkup("unknown.extension");

    assert.match(markup, /--file-icon:url\('\.\.\/assets\/icons\/file\.svg'\)/);
    assert.doesNotMatch(markup, /data:image\/svg/);
});

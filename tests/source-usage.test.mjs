import test from "node:test";
import assert from "node:assert/strict";

import { selectUsedSources } from "../ai-agent/rag/source-inference.js";

test("a filename by itself is not evidence that a source was used", () => {
  const source = {
    path: "docs/Interview_Prep.docx",
    body: "Prompt engineering is the process of designing clear instructions for language models.",
  };

  assert.deepEqual(selectUsedSources("Interview_Prep.docx is the source.", [source]), []);
});

test("two or more matching three-word phrases select a source", () => {
  const source = {
    path: "docs/guide.docx",
    body: "Prompt engineering is the process of designing clear instructions for language models.",
  };

  assert.deepEqual(
    selectUsedSources(
      "Prompt engineering is the process of designing better instructions.",
      [source]
    ),
    [source]
  );
});

test("distinctive terms select a paraphrased source", () => {
  const source = {
    path: "docs/botany.docx",
    body: "Photosynthesis uses chlorophyll and carbon to convert sunlight into glucose, oxygen, and chemical energy in plants.",
  };

  assert.deepEqual(
    selectUsedSources(
      "Photosynthesis uses chlorophyll and carbon to convert sunlight into glucose and oxygen.",
      [source]
    ),
    [source]
  );
});

test("general answers with insufficient content overlap do not show sources", () => {
  const source = {
    path: "docs/botany.docx",
    body: "Photosynthesis uses chlorophyll and carbon to convert sunlight into glucose, oxygen, and chemical energy in plants.",
  };

  assert.deepEqual(selectUsedSources("Plants need sunlight and oxygen.", [source]), []);
});

test("opening refusals suppress sources, even when the answer later quotes a passage", () => {
  const source = {
    path: "docs/MCP_Guide.docx",
    body: "The protocol supports tools and resources through a client-server architecture.",
  };
  const answers = [
    "I can't find MCP in the attached file. The protocol supports tools and resources.",
    "The file doesn't mention MCP. The protocol supports tools and resources.",
    "This is general knowledge, not from your files. The protocol supports tools and resources.",
    "MCP is not in the provided documents. The protocol supports tools and resources.",
  ];

  for (const answer of answers) assert.deepEqual(selectUsedSources(answer, [source]), []);
});

test("refusal detection covers the expanded answer window", () => {
  const source = {
    path: "docs/MCP_Guide.docx",
    body: "The protocol supports tools and resources through a client-server architecture.",
  };
  const answer = `${"Additional context follows. ".repeat(11)}I can't find the requested budget.`;

  assert.deepEqual(selectUsedSources(answer, [source]), []);
});

test("saved sources without a full body can still use their excerpt", () => {
  const source = {
    path: "docs/legacy.docx",
    excerpt: "Photosynthesis uses chlorophyll to convert sunlight into glucose and oxygen.",
  };

  assert.deepEqual(
    selectUsedSources(
      "Photosynthesis uses chlorophyll to convert sunlight into glucose and oxygen.",
      [source]
    ),
    [source]
  );
});

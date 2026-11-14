import test from "node:test";
import assert from "node:assert/strict";
import { isSmallTalk } from "../shared/small-talk.js";

test("greetings, thanks and acknowledgements are small talk", () => {
  for (const t of ["hi", "Hello!", "hey", "cool", "okay", "ok cool", "thanks", "thank you so much",
    "got it", "nice", "👍", "accha", "theek hai", "bye", "good morning", "how are you?", "ok?"]) {
    assert.equal(isSmallTalk(t), true, t);
  }
});

test("anything with content is not small talk", () => {
  for (const t of ["", "   ", "name", "email", "what is his email", "ok now what is his email",
    "hi what is rag", "cool tell me about the diploma", "yes", "no", "sure", "continue", "more",
    "summarize", "thanks, now explain chunking", "it", "you"]) {
    assert.equal(isSmallTalk(t), false, JSON.stringify(t));
  }
});

/**
 * ============================================================================
 * ARTEMIS CHAT VIEW (renderer/js/views/chat.js)
 * ============================================================================
 * Mounts the Artemis AI components inside the main panel.
 * Orchestrates greeting, chat rendering, thinking state and SSE streaming.
 * Returns a cleanup function so navigating between views releases timers,
 * global listeners and other view resources.
 * ============================================================================
 */

import { DEFAULT_AI_BASE_URL, streamChat, waitForBackend } from '../ai/ai-client.js';
import { VoiceRecorder } from '../ai/voice-recorder.js';
import { buildFileContext, compactHistoryFileBlocks, measureFiles, prefetchFiles } from '../ai/file-context.js';
import { buildImageNote, compactHistoryImages, partitionAttachments, prepareImages } from '../ai/image-pipeline.js';
import { createVisionGuard } from '../ai/vision-guard.js';
import { imageLimits } from '../ai/vision-model.js';
import {
  deleteCollection,
  describeIngestResults,
  getRagStatus,
  indexableFiles,
  ingestFiles,
  RAG_UNAVAILABLE_CODES,
} from '../ai/rag-client.js';
import { bus } from '../core/events.js';
import { ChatSession } from '../core/chat-session.js';
import { buildHistory, renderSavedChat, restoreHistoryImages } from '../core/chat-restore.js';

/* Inline head per file (chars) when the knowledge base already holds the full
 * text; retrieval supplies the detail, so the inline copy only orients. */
const OUTLINE_HEAD_CHARS = 2000;

// Up to ~6k tokens of file text is cheaper to send inline than to wait for
// embeddings. Above this, wait for the index and use outline + retrieval.
const INLINE_FIRST_MAX_CHARS = 24000;

const ATTACH_ONLY_NOTE = '(The user attached file(s) without a message.)';

/** One short, truthful line. No model call, so no tokens and no invention. */
function buildFileReadyLine(files, fileCtx, ragSummary) {
  const names = Array.from(files || []).map((f) => f.webkitRelativePath || f.name);
  const total = names.length;
  const readable = fileCtx?.readCount ?? 0;

  if (readable === 0) {
    return `I couldn't read ${total === 1 ? 'that file' : 'those files'}. The note above says why.`;
  }
  const shown = names.slice(0, 3).map((n) => `**${n}**`).join(', ');
  const more = total > 3 ? ` and ${total - 3} more` : '';
  const unread = total - readable;
  const tail = unread > 0 ? ` (${unread} couldn't be read, see the note above)` : '';

  const searchable = (ragSummary?.indexed || 0) + (ragSummary?.unchanged || 0);
  if (searchable > 0) {
    return `Ready — I've read and indexed ${shown}${more} (${ragSummary.chunks} searchable passages)${tail}. What would you like to know?`;
  }
  return `Ready — I've read ${shown}${more}${tail}, but couldn't build the search index, so I'll answer from the file text directly. What would you like to know?`;
}

function buildReadyMessage(files, fileCtx, ragSummary, images = { ok: 0, requested: 0 }) {
  const fileLine = files.length ? buildFileReadyLine(files, fileCtx, ragSummary) : '';
  if (images.requested === 0) return fileLine;

  if (images.ok === 0) {
    const missed = `I couldn't read ${images.requested === 1 ? 'that image' : 'those images'}. The note above says why.`;
    return fileLine ? `${fileLine} ${missed}` : missed;
  }
  const seen = images.ok === 1 ? 'I can see your image' : `I can see your ${images.ok} images`;
  return fileLine ? `${fileLine} ${seen}.` : `Ready — ${seen}. What would you like to know?`;
}

export function mountChatView(root, params = {}) {
  root.classList.add('main--ai');

  root.innerHTML = `
    <div class="ai-app-shell" id="artemis-ai-shell">
      <div class="ai-flex-spacer top-spacer"></div>

      <section class="ai-header" id="hero-greeting">
        <h1 class="ai-header-title">
          <span class="greeting__text"></span>
        </h1>
      </section>

      <main class="ai-chat-viewport">
        <div class="ai-chat-messages" id="chat-stream"></div>
      </main>

      <footer class="ai-input-dock">
        <div id="ai-input-mount"></div>
      </footer>

      <div class="ai-flex-spacer bottom-spacer"></div>
    </div>`;

  const shell = root.querySelector('#artemis-ai-shell');
  const chatStream = root.querySelector('#chat-stream');
  const inputMount = root.querySelector('#ai-input-mount');

  const greeting = new DynamicGreeting(shell.querySelector('#hero-greeting'), {
    titleSelector: '.ai-header-title',
    locale: 'en-US',
    refreshInterval: 30000,
    dayOverrideProbability: 0.65,
    data: window.ARTEMIS_GREETINGS || null,
  });

  const chatManager = new ChatManager(chatStream);
  const history = [];
  let isFirstMessage = true;
  let isSending = false;
  let activeAbort = null;
  let disposed = false;

  /*
   * Chat history. The session saves this conversation as it happens; when the
   * view is opened with a chatId it also restores the saved messages.
   * `restoring` is the in-flight load, which onSend waits for.
   */
  const session = new ChatSession({ id: params.chatId || undefined });
  let restoring = null;
  let imageRestore = null;

  /*
   * Knowledge-base state.
   *
   * One collection per mount. The renderer keeps no conversation id of its own
   * and this view's `history` dies on unmount, so the index gets the same
   * lifetime - see the cleanup at the bottom of the file.
   *
   * ragAvailable stays null until the first status check, so "not asked yet" is
   * distinguishable from "asked, and the answer was no".
   */
  // The chat id IS the collection id: reopening a chat finds its index again.
  const ragCollection = session.id;
  let ragAvailable = null;
  let ragHasContent = false;

  const checkRagAvailable = async (signal) => {
    if (ragAvailable !== null) return ragAvailable;
    try {
      const status = await getRagStatus({ signal });
      ragAvailable = Boolean(status?.enabled);
    } catch (error) {
      // A cancelled message says nothing about the configuration. Swallowing it
      // here would switch retrieval off for the rest of the mount, so the next
      // message would silently lose the knowledge base.
      if (error?.name === 'AbortError') throw error;
      // No agent, no route, no API key. Retrieval is off for this mount and the
      // chat carries on exactly as it did before the knowledge base existed.
      ragAvailable = false;
    }
    return ragAvailable;
  };

  /*
   * Background indexing.
   *
   * Indexing starts the moment files are attached (onAttachment), not when the
   * user hits send, so the embedding work overlaps with the time the user
   * spends typing. By send, the promise has usually already resolved and the
   * send path only awaits whatever is still in flight.
   */
  const indexAbort = new AbortController();
  let pendingIndex = [];
  const indexStarted = new Set();

  /* Latest "Indexing file 2 of 5" line, and the per-send hook that puts it on
   * the thinking panel - which does not exist until a message starts, so the
   * attach-time updates can only remember the text until then. */
  let indexProgress = '';
  let showIndexStatus = null;
  let backgroundIndex = null; // answer-first indexing that is still running

  const fileKey = (file) =>
    `${file?.webkitRelativePath || file?.name}|${file?.size}|${file?.lastModified}`;

  const mergeSummaries = (summaries) => {
    const merged = { results: [], indexed: 0, unchanged: 0, skipped: 0, chunks: 0 };
    for (const summary of summaries) {
      if (!summary) continue;
      merged.results.push(...(summary.results || []));
      merged.indexed += summary.indexed || 0;
      merged.unchanged += summary.unchanged || 0;
      merged.skipped += summary.skipped || 0;
      merged.chunks += summary.chunks || 0;
    }
    return merged;
  };

  const startIndexing = (files) => {
    // Converters are slow; start reading (and converting documents) now so the
    // send path's buildFileContext() finds every entry ready in the cache.
    prefetchFiles(files);

    const fresh = Array.from(files || []).filter((file) => {
      const key = fileKey(file);
      if (indexStarted.has(key)) return false;
      indexStarted.add(key);
      return true;
    });
    const indexable = indexableFiles(fresh);
    if (!indexable.length) return;

    const promise = (async () => {
      if (!await checkRagAvailable(indexAbort.signal)) return null;
      return ingestFiles({
        collection: ragCollection,
        files: indexable,
        signal: indexAbort.signal,
        // Drives "Indexing file 2 of 5 (notes.txt, 3 chunks)" on the thinking
        // panel while the send path waits for anything still in flight.
        onProgress: (done, total, result) => {
          const chunks = result?.chunks ? `, ${result.chunks} chunks` : '';
          indexProgress = `Indexing file ${done} of ${total} (${result?.path || 'file'}${chunks})`;
          showIndexStatus?.(indexProgress);
        },
      });
    })().then((summary) => {
      // Set the flag at the source, not at whichever send happens to drain the
      // queue: a follow-up turn with no new attachments must see it too.
      if (summary && (summary.indexed > 0 || summary.unchanged > 0)) ragHasContent = true;
      return summary;
    }).catch((error) => {
      if (error?.name === 'AbortError') return null;

      // "Not configured" will not fix itself during this mount. A timeout or a
      // 502 might, so leave ragAvailable alone and let the next message retry.
      if (RAG_UNAVAILABLE_CODES.has(error?.code)) ragAvailable = false;

      // Forget the attempt so the send path retries it: an attach-time failure
      // should not permanently exclude a file that merely hit a transient
      // error. Permanent skips (too large, no text) come back as results, not
      // throws, so they are unaffected.
      for (const key of indexable.map(fileKey)) indexStarted.delete(key);

      return {
        results: indexable.map((file) => ({
          status: 'skipped',
          path: file.webkitRelativePath || file.name,
          chunks: 0,
          skippedReason: error?.message || 'the knowledge base could not be reached',
        })),
        indexed: 0,
        unchanged: 0,
        skipped: indexable.length,
        chunks: 0,
      };
    });

    pendingIndex.push(promise);
  };

  const scrollToBottom = () => chatManager.scrollToBottom(true);

  const errorText = (error) => {
    const message = String(error?.message || error || 'Unknown error');
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return `**The AI service is not running.** Artemis could not reach the local AI agent at \`${DEFAULT_AI_BASE_URL.replace(/^https?:\/\//, '')}\`. Restart the app and try again.`;
    }
    return `**AI request failed:** ${message}`;
  };

  let voiceRecorder = null;
  let micErrorMessage = '';

  const visionGuard = createVisionGuard({
    getModels: () => aiInput.getModels(),
    getModel: () => aiInput.getModel(),
    selectModel: (id, options) => aiInput.selectModelById(id, options),
    notify: (text, options) => aiInput.showNotice(text, options),
    clearNotice: () => aiInput.hideNotice(),
    getProviderStatus: () => window.apiKeys?.status?.(),
  });
  void visionGuard.refreshConfigured();

  const aiInput = new AIInputBox(inputMount, {
    placeholder: 'How can I help you today?',
    modelDataSource: `${DEFAULT_AI_BASE_URL}/api/models`,
    // Kick off knowledge-base indexing the moment files land, so the embedding
    // work overlaps with the user typing instead of blocking the send.
    onAttachment: (files) => startIndexing(files),
    onAttachmentsChange: (files) => visionGuard.onAttachmentsChanged(files),
    onModelChange: () => visionGuard.onModelChanged(aiInput.getAttachments()),
    beforeSend: (context) => visionGuard.beforeSend(context),
    onMic: () => { void voiceRecorder?.toggle(); },
    onMicCancel: () => {
      const cancelled = voiceRecorder?.cancel() || false;
      if (cancelled) aiInput.focus();
      return cancelled;
    },
    onMicStop: () => voiceRecorder?.stop(),

    onSend: async (payload) => {
      const { text = '', model = null, attachments = [] } = payload;
      const { images: imageFiles, others: otherFiles } = partitionAttachments(attachments);

      // A saved chat must finish loading first, or its history would be missing.
      if (restoring) await restoring;
      if (imageRestore) await imageRestore;

      if (isSending) {
        // Keep the user's text instead of silently dropping it.
        aiInput.setValue(text);
        return;
      }

      isSending = true;
      activeAbort = new AbortController();

      if (isFirstMessage) {
        shell.classList.add('is-chatting');
        aiInput.setDocked(true);
        isFirstMessage = false;
        bus.emit('chat:active', { chatId: session.id, isEmpty: false });
      }

      const userMessage = chatManager.addUserMessage({ text, attachments });

      const attachOnly = !text.trim() && attachments.length > 0;
      const userText = text.trim()
        ? text
        : (attachOnly ? ATTACH_ONLY_NOTE : '');

      let thinkingSession = null;
      let msgController = null;
      let errorMessage = '';

      /*
       * Retrieval events arrive before response.start, so the assistant row
       * does not exist yet when they land. Buffer them here, and render the
       * sources row only once the answer itself is finished: while the model
       * is still writing, the panel would sit above a half-written answer and
       * present the search before the reply it belongs to exists.
       */
      let ragInfo = null;
      let usedEvent = null;
      let usedInfo = null;
      let sourcesShown = false;
      const renderSources = () => {
        if (sourcesShown || !msgController || (!usedEvent && !ragInfo)) return;
        sourcesShown = true;
        if (usedEvent) {
          usedInfo = {
            kind: 'hits',
            mode: usedEvent.mode,
            hits: ragInfo?.hits ?? 0,
            sources: Array.isArray(usedEvent.sources) ? usedEvent.sources : [],
            citations: Array.isArray(usedEvent.citations) ? usedEvent.citations : [],
            searched: usedEvent.searched || null,
          };
        } else if (ragInfo?.kind === 'error') {
          usedInfo = ragInfo;
        } else {
          usedInfo = { kind: 'hits', mode: 'none', sources: [] };
        }
        chatManager.showSources(msgController, usedInfo);
      };

      const ensureResponse = () => {
        if (msgController) return msgController;
        if (thinkingSession && typeof thinkingSession.finish === 'function') {
          thinkingSession.finish();
        }
        msgController = chatManager.initiateEmptyAssistantResponse();
        scrollToBottom();
        return msgController;
      };

      const showError = (message) => {
        errorMessage = message;
        const controller = ensureResponse();
        chatManager.appendChunkToResponse(controller, `\n\n*${message.replace(/^\*\*|\*\*$/g, '')}*`);
      };

      try {
        // The local agent is started with the app; give it a short grace
        // period if the first request races its startup.
        await waitForBackend({ attempts: 8, signal: activeAbort.signal });

        thinkingSession = chatManager.startThinking({
          model: model?.name || 'AI Model',
          capabilities: model?.capabilities || { reasoningSummary: true, tools: true },
        });

        /*
         * A message that is only files must be fully embedded before we say
         * "Ready", so the next question is answered by retrieval. And a
         * follow-up turn must not start before answer-first indexing from an
         * earlier turn has landed, or it would run with the index missing.
         */
        if (backgroundIndex) {
          showIndexStatus = (line) => thinkingSession?.setStatus?.(line);
          showIndexStatus(indexProgress || 'Indexing files');
          await backgroundIndex;
          showIndexStatus = null;
        }

        let ragSummary = null;
        let answerFirst = false;
        if (otherFiles.length) {
          // Covers attach paths that do not fire onAttachment (e.g. drag-drop).
          startIndexing(otherFiles);

          if (pendingIndex.length) {
            // attach-only never answers first: embedding IS the job.
            const totalChars = attachOnly ? 0 : await measureFiles(otherFiles);
            answerFirst = !attachOnly && totalChars > 0 && totalChars <= INLINE_FIRST_MAX_CHARS;

            if (answerFirst) {
              // Do not wait. Indexing keeps running; the next send awaits it
              // above. A failure here is harmless for this turn (the full text
              // is inline) and startIndexing() already forgets failed attempts
              // so the next send retries them.
              const inFlight = pendingIndex;
              pendingIndex = [];
              backgroundIndex = Promise.all(inFlight)
                .catch(() => {})
                .finally(() => { backgroundIndex = null; });
            } else {
              // Route progress onto this turn's thinking panel. The hook stays
              // open during the await, so updates that land mid-indexing are
              // shown live instead of overwriting the status once at the end.
              showIndexStatus = (line) => thinkingSession?.setStatus?.(line);
              showIndexStatus(indexProgress || 'Indexing files');
              console.time('[rag] index');
              const summaries = await Promise.all(pendingIndex);
              console.timeEnd('[rag] index');
              pendingIndex = [];
              showIndexStatus = null;
              ragSummary = mergeSummaries(summaries);
              // `unchanged` counts as content too: the file was indexed on an
              // earlier turn, which makes it exactly as searchable as a fresh one.
              ragHasContent = ragHasContent
                || ragSummary.indexed > 0
                || ragSummary.unchanged > 0;
            }
          }
        }

        if (ragSummary) {
          chatManager.showFileNotes(userMessage?.row, describeIngestResults(ragSummary));
        }

        let imagePack = { images: [], warnings: [] };
        if (imageFiles.length) {
          thinkingSession?.setStatus?.('Preparing images');
          imagePack = await prepareImages(imageFiles, { maxImages: imageLimits(model).maxImages });
        }

        /*
         * Outline mode when the knowledge base already holds these files AND
         * we are not answering first: the retrieved_context block supplies the
         * passages that answer, so the inline copy stays a short head instead
         * of ~100k chars the model must re-read on every turn. Full content
         * remains the fallback whenever retrieval is unavailable, indexing
         * failed, or the files are small enough to answer from directly
         * (answer-first: a not-yet-indexed small file goes inline in FULL).
         */
        const fileCtx = otherFiles.length
          ? await buildFileContext(otherFiles, {
            outlineHeadChars: ragHasContent && !answerFirst ? OUTLINE_HEAD_CHARS : null,
          })
          : { block: '', warnings: [], readCount: 0 };

        // Whatever the model could not read has to be visible to the user too,
        // otherwise a skipped document looks like a model that ignored it.
        chatManager.showFileNotes(userMessage?.row, [...fileCtx.warnings, ...imagePack.warnings]);

        const content = [userText, fileCtx.block, buildImageNote(imagePack.images)]
          .filter(Boolean)
          .join('\n\n');

        if (content) {
          history.push({
            role: 'user',
            content,
            ...(imagePack.images.length ? { images: imagePack.images } : {}),
          });
          compactHistoryFileBlocks(history, { indexed: ragHasContent });
          compactHistoryImages(history, { keep: imageLimits(model).maxImages });

          // Save the turn (and keep the attached files). Not awaited: saving
          // must never slow the answer down.
          session.recordUser({
            text,
            content, // text note only: image bytes are never written into chat JSON
            files: attachments,
            notes: [
              ...(ragSummary ? describeIngestResults(ragSummary) : []),
              ...fileCtx.warnings,
              ...imagePack.warnings,
            ],
            modelId: model?.id || null,
            ragIndexed: ragHasContent,
          });
        }

        // Files with no question: acknowledge locally. The file block is already
        // in history, so the next question is answered from it (and from the
        // index, which small files finish in the background and large files
        // finished above before we got here).
        if (attachOnly) {
          const controller = ensureResponse();
          const ack = buildReadyMessage(otherFiles, fileCtx, ragSummary, {
            ok: imagePack.images.length,
            requested: imageFiles.length,
          });
          chatManager.appendChunkToResponse(controller, ack);
          chatManager.finalizeResponse(controller);
          history.push({ role: 'assistant', content: ack });
          session.recordAssistant({ content: ack, ragIndexed: ragHasContent });
          return; // the existing `finally` resets isSending
        }

        // Split the wait into "indexing" (above) and "model" (here) so a slow
        // turn can be attributed without guessing.
        const startedAt = Date.now();
        let firstTokenAt = null;

        const result = await streamChat({
          baseUrl: DEFAULT_AI_BASE_URL,
          messages: history,
          model,
          signal: activeAbort.signal,
          // Stays on for the rest of the conversation once anything is indexed,
          // so a follow-up question with no new attachment still searches what
          // the earlier ones put there.
          rag: ragHasContent ? { enabled: true, collection: ragCollection } : null,

          onEvent: (event) => {
            const type = event.type;

            if (type === 'thinking.status') {
              thinkingSession?.setStatus?.(event.text || event.status || 'Thinking');
            } else if (type === 'reasoning.delta') {
              thinkingSession?.addReasoning?.(event.text || '');
            } else if (type === 'reasoning.start') {
              thinkingSession?.setStatus?.('Reasoning');
            } else if (type === 'tool.start') {
              thinkingSession?.startTool?.(event.tool || event.name || 'tool', event);
            } else if (type === 'tool.update') {
              thinkingSession?.updateTool?.(event.tool || event.name, event.message);
            } else if (type === 'tool.end') {
              thinkingSession?.endTool?.(event.tool || event.name);
            } else if (type === 'rag.start') {
              thinkingSession?.setStatus?.('Searching the knowledge base');
            } else if (type === 'rag.hits') {
              ragInfo = {
                kind: 'hits',
                hits: event.hits || 0,
                dropped: event.dropped || 0,
                sources: Array.isArray(event.sources) ? event.sources : [],
                skipped: event.skipped || null,
                collection: event.collection || ragCollection,
              };
            } else if (type === 'rag.error') {
              ragInfo = {
                kind: 'error',
                message: event.message || 'The knowledge base could not be searched.',
              };
            } else if (type === 'sources.used') {
              usedEvent = event;
            } else if (type === 'response.start') {
              ensureResponse();
            } else if (type === 'response.delta') {
              if (!event.text) return;
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
                console.info(`[rag] first token ${firstTokenAt - startedAt}ms after send`);
              }
              const controller = ensureResponse();
              chatManager.appendChunkToResponse(controller, event.text);
            } else if (type === 'response.end' || type === 'done') {
              if (msgController) {
                chatManager.finalizeResponse(msgController);
                renderSources();
              }
            } else if (type === 'error' || event.error) {
              if (thinkingSession) {
                thinkingSession.finish();
              }
              showError(event.message || event.error || 'The AI request failed.');
            }
          },
        });

        if (thinkingSession) {
          thinkingSession.finish();
        }

        if (msgController) {
          chatManager.finalizeResponse(msgController);
        }
        renderSources();

        const responseText = String(result.text || '').trim();

        if (!errorMessage && responseText) {
          history.push({ role: 'assistant', content: responseText });
          session.recordAssistant({
            content: responseText,
            sources: usedInfo,
            modelId: model?.id || null,
            ragIndexed: ragHasContent,
          });
        } else if (!errorMessage && !responseText) {
          // Keep the conversation honest when a model burns its tokens on
          // reasoning and never emits visible content.
          const controller = ensureResponse();
          chatManager.appendChunkToResponse(
            controller,
            '*The model returned an empty response. Try again or pick another model.*'
          );
          chatManager.finalizeResponse(controller);
          renderSources();
        }
      } catch (error) {
        if (error?.name === 'AbortError') {
          renderSources();
          // The user switched chats mid-answer. Keep what was already shown.
          const partial = String(msgController?.accumulatedText || '').trim();
          if (partial) {
            session.recordAssistant({
              content: partial,
              sources: usedInfo,
              interrupted: true,
              modelId: model?.id || null,
              ragIndexed: ragHasContent,
            });
          }
          return;
        }
        if (thinkingSession) {
          thinkingSession.finish();
        }
        showError(errorText(error));
        if (msgController) {
          chatManager.finalizeResponse(msgController);
        }
        renderSources();
      } finally {
        activeAbort = null;
        isSending = false;
        if (shell.isConnected) {
          aiInput.focus();
        }
      }
    },
  });

  voiceRecorder = new VoiceRecorder({
    apiBase: DEFAULT_AI_BASE_URL,
    onState: (state) => {
      aiInput.setMicState(state);
      if (state === 'idle') {
        if (!micErrorMessage) aiInput.setMicMessage('');
        return;
      }

      micErrorMessage = '';
      const status = {
        requesting: 'Waiting for microphone permission...',
        recording: '',
        transcribing: 'Transcribing audio...',
      };
      aiInput.setMicMessage(status[state] || '');
    },
    onStream: (stream) => {
      if (stream) aiInput.startMicWaveform(stream);
    },
    onText: (text) => {
      aiInput.insertText(text);
    },
    onLevel: (level) => {
      aiInput.setMicLevel(level);
    },
    onError: (message) => {
      micErrorMessage = message;
      aiInput.setMicMessage(message);
    },
  });

  chatManager.setInputController(aiInput);
  aiInput.focus();

  const offFocus = bus.on('chat:focus-input', () => aiInput.focus());
  let ragIndexedAtLoad = false;

  // Tell the sidebar/navigation which chat is on screen, and whether it is blank.
  bus.emit('chat:active', { chatId: session.id, isEmpty: !params.chatId });

  if (params.chatId) {
    shell.classList.add('is-restoring', 'is-chatting');
    aiInput.setDocked(true);

    const reveal = () => {
      if (disposed) return;
      requestAnimationFrame(() => shell.classList.remove('is-restoring'));
    };

    restoring = (async () => {
      try {
        const saved = await session.load();
        if (disposed) return;

        history.push(...buildHistory(saved.messages, saved.meta));
        ragHasContent = Boolean(saved.meta.ragIndexed);
        ragIndexedAtLoad = ragHasContent;

        isFirstMessage = false;
        await renderSavedChat({ chatManager, chatId: session.id, messages: saved.messages });
        imageRestore = restoreHistoryImages(history, { chatId: session.id }).catch(() => {});
        bus.emit('chat:active', { chatId: session.id, isEmpty: false });
      } catch (error) {
        if (disposed) return;
        console.warn('[history] could not open chat:', error?.message || error);
        const notice = chatManager.initiateEmptyAssistantResponse();
        chatManager.appendChunkToResponse(notice, '**This conversation could not be opened.** It may have been deleted, or the AI agent is not running.');
        chatManager.finalizeResponse(notice);
      } finally {
        reveal();
        restoring = null;
      }
    })();
  }

  // Return cleanup for the main-view router.
  return () => {
    try { activeAbort?.abort(); } catch { /* ignore */ }
    activeAbort = null;
    try { indexAbort.abort(); } catch { /* ignore */ }
    pendingIndex = [];
    backgroundIndex = null;
    showIndexStatus = null;

    disposed = true;
    offFocus();

    /*
     * Leaving a chat no longer deletes its index: the chat is saved, so its
     * knowledge base stays with it and is removed when the chat is deleted
     * (DELETE /api/chats/:id). Two cases remain:
     *   - files were indexed but nothing was ever sent, so the chat will never
     *     exist and its index would be orphaned: delete it now;
     *   - the index appeared during this visit: remember that on the chat.
     */
    if (!session.started && ragHasContent) {
      deleteCollection(ragCollection).catch(() => { /* unreachable, or already deleted */ });
    } else if (ragHasContent && !ragIndexedAtLoad) {
      session.markIndexed();
    }

    try { voiceRecorder?.destroy(); } catch { /* ignore */ }
    try { aiInput.destroy(); } catch { /* ignore */ }
    try { chatManager.destroy(); } catch { /* ignore */ }
    try { greeting.destroy(); } catch { /* ignore */ }

    root.classList.remove('main--ai');
    document.body.classList.remove('ai-modal-open');
  };
}

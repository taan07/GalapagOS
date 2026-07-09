# Open WebUI chat internals — implementation reference

Digest of REAL code from github.com/open-webui/open-webui (`main` branch, fetched 2026-07-09).
Purpose: reference while porting these behaviors to our React/Next.js app. Focus is on logic
and edge cases, not Svelte syntax. All snippets are verbatim quotes; source path above each.

---

## 1. Message queue

### Enqueue condition (submitHandler)

`src/lib/components/chat/Chat.svelte` — "generation in progress" is detected purely from the
tree: the current leaf is an assistant message with `done !== true`. Background tasks (title
gen, tags, follow-ups) deliberately do NOT count as "generating".

```js
// Check if the assistant is still generating the main response
// (don't block on background tasks like title gen, follow-ups, tags)
const lastMessage = history.currentId ? history.messages[history.currentId] : null;
const isGenerating = lastMessage && lastMessage.role === 'assistant' && !lastMessage.done;

if (isGenerating) {
    if ($settings?.enableMessageQueue ?? true) {
        // Enqueue the request
        const _files = structuredClone(files);
        chatRequestQueues.update((q) => ({
            ...q,
            [$chatId]: [...(q[$chatId] ?? []), { id: uuidv4(), prompt: userPrompt, files: _files }]
        }));
        // Clear input
        messageInput?.setText('');
        prompt = '';
        files = [];
        return;
    } else {
        // Interrupt: stop current generation and proceed
        await stopResponse();
        await tick();
    }
}
```

Notes:
- The queue is a **global in-memory store keyed by chatId** (`src/lib/stores/index.ts`):

```ts
export const chatRequestQueues: Writable<
    Record<string, { id: string; prompt: string; files: any[] }[]>
> = writable({});
```

  Not persisted — survives chat switches within the session, lost on reload.
- Queueing is a user setting (`enableMessageQueue`, default ON). With it OFF, submit while
  generating becomes **interrupt-and-send** (stop + tick + proceed).
- Files are `structuredClone`d at enqueue time, so later edits to the attachment tray don't
  mutate queued items.

### processNextInQueue — AGGREGATES, does not drain one-at-a-time

`src/lib/components/chat/Chat.svelte`. Key finding: they do NOT send queued messages one per
turn. On turn end they **join all queued prompts into ONE message** (`\n\n` separator) and
flat-merge all files, then submit once. A per-chat `Set` guards re-entrancy.

```js
let processingQueueChats = new Set<string>();

const processNextInQueue = async (targetChatId: string) => {
    if (processingQueueChats.has(targetChatId)) return;

    const queue = $chatRequestQueues[targetChatId];
    if (!queue || queue.length === 0) return;

    processingQueueChats.add(targetChatId);
    try {
        const combinedPrompt = queue.map((m) => m.prompt).join('\n\n');
        const combinedFiles = queue.flatMap((m) => m.files);

        chatRequestQueues.update((q) => {
            const { [targetChatId]: _, ...rest } = q;
            return rest;
        });

        await submitPrompt(combinedPrompt, combinedFiles);
    } finally {
        processingQueueChats.delete(targetChatId);
    }
};
```

The queue for that chat is deleted from the store BEFORE `submitPrompt` runs (so a message
enqueued while the combined prompt is being submitted starts a fresh queue — no loss, no dupe).

### Where processNextInQueue is triggered

All in `Chat.svelte`:
1. **Turn completion** — in the socket completion handler, right after firing
   `chatCompletedHandler` (which is explicitly fire-and-forget so it doesn't block queue drain):
   ```js
   // Fire-and-forget: run chatCompletedHandler for background work
   // (outlet filters, chat save, title gen, follow-ups, tags)
   // without blocking the user from sending new messages.
   chatCompletedHandler(chatId, message.model, message.id, createMessagesList(history, message.id));
   // Process next queued request if any
   await processNextInQueue(chatId);
   ```
2. **stopResponse** — stopping generation drains the queue by default:
   ```js
   const stopResponse = async (processQueue = true) => {
       // ... stop backend tasks, mark all sibling responses done ...
       if (generating) {
           generating = false;
           generationController?.abort();
           generationController = null;
       }
       if (processQueue) {
           await processNextInQueue($chatId);
       }
   };
   ```
3. **Chat load / switch back** — on `loadChat()` success, queued items for that chat are
   processed only if the chat is idle:
   ```js
   // Process any queued requests if the chat is idle
   const lastMessage = history.currentId ? history.messages[history.currentId] : null;
   const isIdle = !lastMessage || lastMessage.role !== 'assistant' || lastMessage.done;
   if (isIdle) {
       await processNextInQueue(chatIdProp);
   }
   ```
   And for completions that finish while you're viewing ANOTHER chat:
   ```js
   } else {
       // Non-active chat completion: queue stays in the global store.
       // navigateHandler will process it when the user returns to that chat.
   }
   ```
4. **Task-cancel event** (`chat:tasks:cancel`) — after marking all sibling responses done:
   `await processNextInQueue($chatId);`

### Queued-item actions (send now / edit / delete)

`Chat.svelte` (handlers passed into MessageInput) + `MessageInput/QueuedMessageItem.svelte`
(pure presentational row: forward-arrow icon, truncated prompt text, file/image chips, three
icon buttons: Send now / Edit / Delete).

```js
onQueueSendNow={async (id) => {
    const queue = $chatRequestQueues[$chatId] ?? [];
    const item = queue.find((m) => m.id === id);
    if (item) {
        // Remove from queue
        chatRequestQueues.update((q) => ({
            ...q,
            [$chatId]: queue.filter((m) => m.id !== id)
        }));
        await stopResponse(false);
        await tick();
        await submitPrompt(item.prompt, item.files);
    }
}}
onQueueEdit={(id) => {
    const queue = $chatRequestQueues[$chatId] ?? [];
    const item = queue.find((m) => m.id === id);
    if (item) {
        // Remove from queue
        chatRequestQueues.update((q) => ({
            ...q,
            [$chatId]: queue.filter((m) => m.id !== id)
        }));
        // Set files and restore prompt to input
        files = item.files;
        messageInput?.setText(item.prompt);
    }
}}
onQueueDelete={(id) => {
    const queue = $chatRequestQueues[$chatId] ?? [];
    chatRequestQueues.update((q) => ({
        ...q,
        [$chatId]: queue.filter((m) => m.id !== id)
    }));
}}
```

Critical detail: **"Send now" calls `stopResponse(false)`** — the `false` suppresses the
default queue drain inside stopResponse, so the send-now item (already removed from the queue)
is submitted alone, mid-generation, by aborting the current turn first. The OTHER queued items
stay queued and get aggregated when the send-now turn finishes. "Edit" removes the item and
restores prompt + files into the composer (does not stop generation).

### Queue edge cases worth copying

- **Error path**: `submitHandler` refuses to submit if the current leaf has `error` and empty
  content — but this check runs AFTER the enqueue branch, so messages can still be queued
  behind a generation; the drain happens via stopResponse/completion regardless.
- **Empty-content queued items**: QueuedMessageItem renders italic "Empty message" if content
  is empty and no files (a queued item can be files-only).
- **Race between completion and enqueue**: the `processingQueueChats` Set plus
  delete-queue-before-submit means an enqueue that lands during `submitPrompt` of the combined
  batch is preserved for the next drain.
- **Multi-chat**: queues are per-chatId; completing a background chat does NOT auto-send its
  queue (would fight with whatever chat the user is viewing) — it waits for navigation back.

---

## 2. Copy message action

### Assistant message copy — preprocessing

`src/lib/components/chat/Messages/ResponseMessage.svelte`. The copied text is NOT the raw
content: reasoning/tool `<details>` blocks are stripped, an optional server-configured
watermark is appended, and a user setting picks plain vs formatted (rich HTML) copy.

```js
const copyToClipboard = async (text) => {
    text = removeAllDetails(text);

    if (($config?.ui?.response_watermark ?? '').trim() !== '') {
        text = `${text}\n\n${$config?.ui?.response_watermark}`;
    }

    const res = await _copyToClipboard(text, null, $settings?.copyFormatted ?? false);
    if (res) {
        toast.success($i18n.t('Copying to clipboard was successful!'));
    }
};
```

The button passes `visibleResponseContent`, which is already details-stripped for display:

```js
$: visibleResponseContent =
    getOutputText(message.output) || removeAllDetails(message.content ?? '');
```

`removeAllDetails` (`src/lib/utils/index.ts`) is code-fence-aware — it must not strip
`<details>`-looking text inside code blocks, but must catch details blocks that CONTAIN fences:

```js
export const removeAllDetails = (content) => {
    // First pass: strip <details> blocks on the full string before code-fence
    // splitting, so blocks whose body contains triple backticks are caught.
    // (replaceOutsideCode splits on ``` fences, which breaks the <details>
    // regex when the opening and closing tags land in different segments.)
    content = content.replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '');
    // Second pass: catch any remaining blocks that live outside code fences
    return replaceOutsideCode(content, (segment) => {
        return segment.replace(/<details[^>]*>.*?<\/details>/gis, '');
    }).trim();
};
```

### The shared util — formatted copy + fallbacks

`src/lib/utils/index.ts`, `copyToClipboard(text, html = null, formatted = false)`:
- `formatted: true` → runs `marked.parse(text)` (with katex + hljs highlight), wraps it in a
  `<div><style>…github-ish pre/code/table/blockquote styles…</style>${htmlContent}</div>`, and
  writes a dual-flavor `ClipboardItem`:

```js
const data = new ClipboardItem({
    'text/html': blob,
    'text/plain': new Blob([text], { type: 'text/plain' })
});
await navigator.clipboard.write([data]);
```

  On failure it falls back to plain-text copy.
- Plain path: `navigator.clipboard.writeText(text)`; if `navigator.clipboard` is unavailable
  (non-HTTPS), a legacy fallback creates an invisible `<span style="white-space:pre">`,
  selects it, and uses `document.execCommand('copy')`.

### Selection-copy interception

ResponseMessage also intercepts native Cmd-C on selected rendered content (`contentCopyHandler`
attached via `contentContainerElement.addEventListener('copy', …)`): it clones the selected
range into a temp div and strips background/color/font inline styles so pasted rich text isn't
theme-colored.

### Feedback pattern

- **Message-level copy button**: toast ("Copying to clipboard was successful!"), no icon swap.
- **Code-block copy button** (`Messages/CodeBlock.svelte`): label swap with a 1s timer —

```js
const copyCode = async () => {
    copied = true;
    await copyToClipboard(_code);

    setTimeout(() => {
        copied = false;
    }, 1000);
};
```
```svelte
<button class="copy-code-button ..." on:click={copyCode}>{copied ? $i18n.t('Copied') : $i18n.t('Copy')}</button>
```

User message copy (`UserMessage.svelte`) copies `message.content` raw via the same util (no
details-stripping, no watermark).

---

## 3. Markdown rendering pipeline

Chain: `ResponseMessage` → `ContentRenderer` → `Markdown.svelte` → `marked.lexer` → recursive
token renderers (`Markdown/MarkdownTokens.svelte` block-level, `MarkdownInlineTokens.svelte`
inline) → leaf components (`CodeBlock`, `HTMLToken`, `KatexRenderer`, `TextToken`, …). No
`innerHTML` of the whole document — tokens render as real components.

### Parser setup + streaming throttle

`src/lib/components/chat/Messages/Markdown.svelte`. Library is **marked** with custom
extensions (katex, custom `<details>`/attribute extension, citations, footnotes, colon-fences,
`@`/`#`/`$` mentions, single-tilde-strikethrough disabled). Parsing is diffed and throttled to
one rAF while streaming; when `done` flips true it parses immediately:

```js
const parseTokens = () => {
    if (content === lastContent) return;
    lastContent = content;

    const processed = replaceTokens(processResponseContent(content), model?.name, $user?.name);
    if (processed === lastParsedContent) return;
    lastParsedContent = processed;

    tokens = marked.lexer(processed);
};

const updateHandler = (content) => {
    if (content) {
        if (done) {
            cancelAnimationFrame(pendingUpdate);
            pendingUpdate = null;
            parseTokens();
        } else if (!pendingUpdate) {
            pendingUpdate = requestAnimationFrame(() => {
                pendingUpdate = null;
                parseTokens();
            });
        }
    }
};

$: updateHandler(content);
```

### Streaming vs done text

`Markdown/MarkdownInlineTokens/TextToken.svelte` — done text renders plainly; streaming text is
split into word spans with a fade-in animation (this is the "smooth streaming" look):

```svelte
{#if done}
    {raw}
{:else}
    {#each raw.split(' ') as text}
        <span class="fade-in-token">
            {text}{' '}
        </span>
    {/each}
{/if}
```

`done` is threaded from the message node through every token component.

### Code blocks

`MarkdownTokens.svelte` renders `token.type === 'code'` via `CodeBlock` ONLY if the raw token
actually had a ``` fence (indented code renders as plain text — deliberate):

```svelte
{:else if token.type === 'code'}
    {#if token.raw.includes('```')}
        <CodeBlock
            id={`${id}-${tokenIdx}`}
            collapsed={$settings?.collapseCodeBlocks ?? false}
            {token}
            lang={token?.lang ?? ''}
            code={token?.text ?? ''}
            ...
        />
    {:else}
        {token.text}
    {/if}
```

`CodeBlock.svelte`: highlight.js (`hljs.highlight(code, { language: lang, ignoreIllegals: true })`,
falls back to plain text for unknown langs), sticky header bar with language label +
Copy/Save/Run/Preview buttons, collapsible with "{{COUNT}} hidden lines", optional inline
CodeMirror editing, python execution via pyodide, html/svg preview hook.

### Sanitization / XSS

- Raw `html` tokens (block and inline) go through `Markdown/HTMLToken.svelte`:
  ```js
  $: html = text ? DOMPurify.sanitize(text) : null;
  ```
  Then special-cases: `<video>`/`<audio>` re-rendered as native controlled elements,
  YouTube-embed iframes matched by strict regex and rebuilt, generic `<iframe>` rebuilt with
  the `sandbox` attribute, `<status …>` and `<file type="html" id=…>` pseudo-tags rendered as
  components/sandboxed iframes (sandbox flags `allow-forms`/`allow-same-origin` are opt-in
  settings). Anything else sanitized-then-inlined.
- Inline footnote sup markup also goes through `DOMPurify.sanitize`.
- Links render with `target="_blank" rel="nofollow"` plus a click handler that reroutes
  same-origin URLs through the SPA router.
- hljs output is injected with `{@html}` — trusted because hljs escapes its input.

Takeaway for React port: parse to a token tree, render tokens as components, DOMPurify only
the raw-HTML leaves, throttle re-lexing to rAF during streaming, and key code blocks by stable
ids so they don't remount every chunk.

---

## 4. Message tree / branching

### History structure

There is no type file for it; the shape is established at node-creation sites (Chat.svelte):
`history = { messages: { [id]: MessageNode }, currentId: string | null }`.

User node (`submitPrompt`, Chat.svelte):

```js
// Create user message
let userMessageId = uuidv4();
let userMessage = {
    id: userMessageId,
    parentId: history.currentId ?? null,
    childrenIds: [],
    role: 'user',
    content: inputContent,
    files: _files.length > 0 ? _files : undefined,
    timestamp: Math.floor(Date.now() / 1000), // Unix epoch
    models: selectedModels
};

// Add message to history and Set currentId to messageId
history.messages[userMessageId] = userMessage;

// Append messageId to childrenIds of parent message
if (history.currentId !== null) {
    history.messages[history.currentId].childrenIds.push(userMessageId);
}

history.currentId = userMessageId;
```

Assistant node (`sendMessage`, Chat.svelte) — one per selected model (multi-model = multiple
assistant siblings under the same user parent, distinguished by `modelIdx`):

```js
let responseMessageId = uuidv4();
let responseMessage = {
    parentId: parentId,
    id: responseMessageId,
    childrenIds: [],
    role: 'assistant',
    content: '',
    done: false,
    model: model.id,
    modelName: model.name ?? model.id,
    modelIdx: modelIdx ? modelIdx : _modelIdx,
    timestamp: Math.floor(Date.now() / 1000) // Unix epoch
};

// Add message to history and Set currentId to messageId
history.messages[responseMessageId] = responseMessage;
history.currentId = responseMessageId;

// Append messageId to childrenIds of parent message
if (parentId !== null && history.messages[parentId]) {
    history.messages[parentId].childrenIds = [
        ...history.messages[parentId].childrenIds,
        responseMessageId
    ];
}
```

Key invariants: `currentId` always points at a LEAF; the rendered conversation is the
root→currentId path; siblings = parent's `childrenIds` (order = creation order); "root
siblings" are all nodes with `parentId === null` (multiple roots are legal — editing the very
first message creates a second root).

### sanitizeHistory — repair on load

`src/lib/utils/index.ts`, called in `loadChat()` right after history is read
("Sanitize history: repair orphaned references and structurally-malformed nodes from failed
regenerations (#24424, #24157, #20474)"):

```js
export const sanitizeHistory = (history) => {
    if (!history?.messages || typeof history.messages !== 'object') return;

    // Purge entries that aren't usable objects
    for (const [id, message] of Object.entries(history.messages)) {
        if (!message || typeof message !== 'object') {
            delete history.messages[id];
        }
    }

    // Ensure every surviving node has its canonical id and a childrenIds array
    for (const [id, message] of Object.entries(history.messages)) {
        if (message.id !== id) message.id = id;
        if (!Array.isArray(message.childrenIds)) message.childrenIds = [];
    }

    // Build reverse lookup: parent, indexed by child id
    const parentByChildId = {};
    for (const [id, message] of Object.entries(history.messages)) {
        for (const childId of message.childrenIds) {
            parentByChildId[childId] = id;
        }
    }

    // Recover currentId before role reconstruction can make a malformed node
    // look valid.
    const currentMessage = history.messages?.[history.currentId];
    if (!currentMessage?.id || !currentMessage?.role) {
        let latestLeafId = null;
        let latestTimestamp = -1;

        for (const [id, message] of Object.entries(history.messages)) {
            if (message.childrenIds.length === 0 && (message.timestamp ?? 0) > latestTimestamp) {
                latestLeafId = id;
                latestTimestamp = message.timestamp ?? 0;
            }
        }

        history.currentId = latestLeafId ?? Object.keys(history.messages)[0] ?? null;
    }

    // Reconstruct missing parentId and role
    for (const [id, message] of Object.entries(history.messages)) {
        // Well-formed: has role and explicit parentId (null is valid for root)
        if (message.role && message.parentId !== undefined) continue;

        if (message.parentId === undefined) {
            message.parentId = parentByChildId[id] ?? null;
        }

        if (!message.role) {
            const parent = message.parentId ? history.messages[message.parentId] : null;
            message.role =
                parent?.role === 'user'
                    ? 'assistant'
                    : parent?.role === 'assistant'
                        ? 'user'
                        : message.model || message.usage || message.done !== undefined
                            ? 'assistant'
                            : 'user';
        }
    }

    // Prune childrenIds referencing deleted/missing nodes
    for (const message of Object.values(history.messages)) {
        message.childrenIds = message.childrenIds.filter((childId) => history.messages[childId]);
    }
};
```

Recovery heuristics worth keeping: broken `currentId` → newest-timestamp leaf; missing role
inferred by alternation from parent, else "looks like assistant" if it has model/usage/done.

### Sibling navigation — always land on the deepest LAST descendant

`src/lib/components/chat/Messages.svelte`. All three (`gotoMessage`, `showPreviousMessage`,
`showNextMessage`) share the same landing rule: after picking the sibling, walk down taking
`childrenIds.at(-1)` (the most recent branch at every level) until a leaf, and set `currentId`
to that leaf. Indices clamp at the ends (no wraparound). `gotoMessage` is the general form
(used by the editable "n / m" counter):

```js
const gotoMessage = async (message, idx) => {
    // Determine the correct sibling list (either parent's children or root messages)
    let siblings;
    if (message.parentId !== null) {
        siblings = history.messages[message.parentId].childrenIds;
    } else {
        siblings = Object.values(history.messages)
            .filter((msg) => msg.parentId === null)
            .map((msg) => msg.id);
    }

    // Clamp index to a valid range
    idx = Math.max(0, Math.min(idx, siblings.length - 1));

    let messageId = siblings[idx];

    // If we're navigating to a different message
    if (message.id !== messageId) {
        // Drill down to the deepest child of that branch
        let messageChildrenIds = history.messages[messageId].childrenIds;
        while (messageChildrenIds.length !== 0) {
            messageId = messageChildrenIds.at(-1);
            messageChildrenIds = history.messages[messageId].childrenIds;
        }

        history.currentId = messageId;
    }

    await tick();

    // Optional auto-scroll
    if ($settings?.scrollOnBranchChange ?? true) {
        const element = document.getElementById('messages-container');
        autoScroll = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;

        setTimeout(() => {
            scrollToBottom();
        }, 100);
    }
};
```

`showPreviousMessage` is the same with `idx = indexOf(message.id) - 1` (clamped ≥ 0);
`showNextMessage` with `+ 1` (clamped ≤ length-1); both duplicate the root-siblings special
case. The sibling arrows are rendered on BOTH user and assistant messages; sibling list for a
node = `history.messages[node.parentId]?.childrenIds` (Message.svelte), root case = all
`parentId === null` ids.

### Edit flow (UserMessage)

`Messages/UserMessage.svelte`: entering edit copies content+files into local state
(`editedContent`, `editedFiles`); two commit buttons — "Save" calls
`editMessageConfirmHandler(false)`, "Send" calls `editMessageConfirmHandler()` (submit=true);
both funnel to `editMessage(message.id, { content, files }, submit)` in `Messages.svelte`:

```js
if (history.messages[messageId].role === 'user') {
    if (submit) {
        // New user message
        let userPrompt = content;
        let userMessageId = uuidv4();

        let userMessage = {
            id: userMessageId,
            parentId: history.messages[messageId].parentId,
            childrenIds: [],
            role: 'user',
            content: userPrompt,
            ...(files && { files: files }),
            models: selectedModels,
            timestamp: Math.floor(Date.now() / 1000) // Unix epoch
        };

        let messageParentId = history.messages[messageId].parentId;

        if (messageParentId !== null) {
            history.messages[messageParentId].childrenIds = [
                ...history.messages[messageParentId].childrenIds,
                userMessageId
            ];
        }

        history.messages[userMessageId] = userMessage;
        history.currentId = userMessageId;

        await tick();
        await sendMessage(history, userMessageId);
    } else {
        // Edit user message
        history.messages[messageId].content = content;
        history.messages[messageId].files = files;
        await updateChat();
    }
}
```

So: **"Send" = new SIBLING user node** (same parentId as the edited message, appended to the
parent's childrenIds; the old message and its whole subtree survive as a branch) followed by
`sendMessage` which attaches a fresh assistant child. **"Save" = in-place mutation** of
content/files, no new node, tree shape unchanged, then persist (`updateChat`). Note the
edited-away-from subtree keeps existing — that's what the sibling arrows page through.

Assistant-message edit is the same pattern: "Save As Copy" (submit=true) clones the node as a
new sibling (`{...message, id: new, childrenIds: [], files: undefined, timestamp: now}`) and
sets `currentId` to it; plain save mutates in place but stashes
`originalContent = message.content` first.

### regenerateResponse — new assistant sibling

`Chat.svelte` — regenerate just re-sends from the response's PARENT (the user message);
`sendMessage` then creates a new assistant node whose parentId is that user message, i.e. a
new sibling of the regenerated response:

```js
const regenerateResponse = async (message, suggestionPrompt = null) => {
    if (history.currentId) {
        let userMessage = history.messages[message.parentId];

        if (!userMessage) {
            toast.error($i18n.t('Parent message not found'));
            return;
        }

        await sendMessage(history, userMessage.id, {
            ...(suggestionPrompt
                ? {
                        messages: createMessagesList(history, message.id),
                        regenerationPrompt: suggestionPrompt
                    }
                : {}),
            ...((userMessage?.models ?? [...selectedModels]).length > 1
                ? {
                        // If multiple models are selected, use the model from the message
                        modelId: message.model,
                        modelIdx: message.modelIdx
                    }
                : {})
        });
    }
};
```

(`suggestionPrompt` is the "regenerate with guidance" variant — it passes the old path as
context plus a steering prompt.)

### deleteMessage — splice node out, reattach grandchildren

`Messages.svelte`. Deleting message M also deletes M's direct children (the paired responses),
but the CHILDREN OF THOSE (grandchildren) are re-parented onto M's parent. Then `currentId` is
recomputed by drilling last-child from the reattachment point:

```js
const deleteMessage = async (messageId) => {
    const messageToDelete = history.messages[messageId];
    const parentMessageId = messageToDelete.parentId;
    const childMessageIds = messageToDelete.childrenIds ?? [];

    // Collect all grandchildren
    const grandchildrenIds = childMessageIds.flatMap(
        (childId) => history.messages[childId]?.childrenIds ?? []
    );

    // Update parent's children
    if (parentMessageId && history.messages[parentMessageId]) {
        history.messages[parentMessageId].childrenIds = [
            ...history.messages[parentMessageId].childrenIds.filter((id) => id !== messageId),
            ...grandchildrenIds
        ];
    }

    // Update grandchildren's parent
    grandchildrenIds.forEach((grandchildId) => {
        if (history.messages[grandchildId]) {
            history.messages[grandchildId].parentId = parentMessageId;
        }
    });

    // Delete the message and its children
    [messageId, ...childMessageIds].forEach((id) => {
        delete history.messages[id];
    });

    let nextMessageId = parentMessageId;
    let nextChildrenIds =
        nextMessageId === null
            ? Object.keys(history.messages).filter((id) => history.messages[id].parentId === null)
            : (history.messages[nextMessageId]?.childrenIds ?? []);
    while (nextChildrenIds.length > 0) {
        nextMessageId = nextChildrenIds.at(-1);
        nextChildrenIds = history.messages[nextMessageId]?.childrenIds ?? [];
    }
    history.currentId = nextMessageId;
    history = history;

    if (!$temporaryChatEnabled) {
        const res = await deleteChatMessageById(localStorage.token, chatId, messageId);
        if (res?.chat?.history) {
            history = res.chat.history;
        }
        // ...
    }
};
```

Semantics: deleting a user message removes that user turn AND its assistant responses, then
grafts the following user turns up one level. Deleting near the root with `parentMessageId ===
null` leaves grandchildren as new roots (their parentId becomes null via the forEach). The
server is also told and may return an authoritative history that replaces the local repair.

### Flat list from tree

Canonical util (`src/lib/utils/index.ts`) — walk parentId links UP from a leaf, reverse:

```js
export const createMessagesList = (history, messageId) => {
    const list = [];
    let currentId = messageId;

    while (currentId !== null && currentId !== undefined) {
        const message = history.messages[currentId];
        if (message === undefined) {
            break;
        }
        list.push(message);
        currentId = message.parentId;
    }

    return list.reverse();
};
```

The rendered list in `Messages.svelte` (`buildMessages`) is the same walk from
`history.currentId` plus a **cycle guard** and pagination cap, throttled to rAF during
streaming with immediate rebuild on `currentId` change:

```js
const buildMessages = () => {
    let _messages = [];

    let message = history.messages[history.currentId];
    const visitedMessageIds = new Set();

    while (message && (messagesCount !== null ? _messages.length <= messagesCount : true)) {
        if (visitedMessageIds.has(message.id)) {
            console.warn('Circular dependency detected in message history', message.id);
            break;
        }
        visitedMessageIds.add(message.id);

        _messages.push(message);
        message = message.parentId !== null ? history.messages[message.parentId] : null;
    }

    messages = _messages.reverse();
};
```

Rendering perf note: each message row uses CSS `content-visibility: auto;
contain-intrinsic-size: auto 150px;` ("browser-native virtualization" — Message.svelte style
block) instead of JS list virtualization.

---

## 5. Modes / controls (per-chat system prompt, tool toggles)

`Controls/Controls.svelte` is dumb UI over a `params` object owned by Chat.svelte
(`let params = {}` per chat, loaded from `chatContent.params`, persisted back on change). The
per-chat system prompt is literally `<textarea bind:value={params.system}>`; advanced params
(temperature etc.) also live in `params`.

Threading into the request (`Chat.svelte`, `sendMessageSocket`): chat-level `params` override
global settings, and the system prompt is materialized as message[0]:

```js
let messages: any[] = [
    params?.system || $settings.system
        ? { role: 'system', content: `${params?.system ?? $settings?.system ?? ''}` }
        : undefined
].filter(Boolean);
```
```js
const res = await generateOpenAIChatCompletion(localStorage.token, {
    stream: stream,
    model: model.id,
    ...(messages.length > 0 ? { messages } : {}),
    params: {
        ...$settings?.params,
        ...params,          // chat-level Controls override global settings
        stop: getStopTokens()
    },
    filter_ids: selectedFilterIds.length > 0 ? selectedFilterIds : undefined,
    tool_ids: toolIds.length > 0 ? toolIds : undefined,
    skill_ids: skillIds.length > 0 ? skillIds : undefined,
    features: getFeatures(),
    ...
});
```

`MessageInput/IntegrationsMenu.svelte` owns boolean/id-list state exported upward:
`selectedToolIds: string[]`, `selectedSkillIds`, `selectedFilterIds`, and booleans
`webSearchEnabled` / `imageGenerationEnabled` / `codeInterpreterEnabled`. Toggles just add or
remove ids from the arrays; stale ids are pruned reactively
(`selectedToolIds = selectedToolIds.filter((id) => Object.keys(tools).includes(id))`). The
booleans are folded into a `features` object, gated by server config + user permissions:

```js
features = {
    voice: $showCallOverlay,
    image_generation:
        $config?.features?.enable_image_generation &&
        ($user?.role === 'admin' || $user?.permissions?.features?.image_generation)
            ? imageGenerationEnabled
            : false,
    code_interpreter: /* same pattern */,
    web_search: webSearchActive
};
```

Shape summary: request = `{ params: {merged overrides}, messages[0] = system, tool_ids,
skill_ids, filter_ids, features: {booleans} }`. Input state (selected toggles) is also saved
into the per-chat draft.

---

## 6. Paste / attachments

`src/lib/components/chat/MessageInput.svelte`, textarea `on:paste`. Two behaviors: any
non-plain-text clipboard item (images, files) becomes an attachment; plain text longer than
`PASTED_TEXT_CHARACTER_LIMIT` (1000, `src/lib/constants.ts`) optionally becomes a .txt file
attachment (setting `largeTextAsFile`, and holding Shift bypasses it):

```js
on:paste={async (e) => {
    e = e.detail.event;

    const clipboardData = e.clipboardData || window.clipboardData;

    if (clipboardData && clipboardData.items) {
        for (const item of clipboardData.items) {
            if (item.type === 'text/plain') {
                if (($settings?.largeTextAsFile ?? false) && !shiftKey) {
                    const text = clipboardData.getData('text/plain');

                    if (text.length > PASTED_TEXT_CHARACTER_LIMIT) {
                        e.preventDefault();
                        const blob = new Blob([text], { type: 'text/plain' });
                        const file = new File([blob], `Pasted_Text_${Date.now()}.txt`, {
                            type: 'text/plain'
                        });

                        await uploadFileHandler(file, true, { context: 'full' });
                    }
                }
            } else {
                const file = item.getAsFile();
                if (file) {
                    await inputFilesHandler([file]);
                    e.preventDefault();
                }
            }
        }
    }
}}
```

Notes: `e.preventDefault()` only fires on the intercepted paths (large text / files), so normal
text pastes fall through to the browser default. Pasted images route through the same
`inputFilesHandler` as drag-drop/file-picker uploads.

---

## License note

This digest quotes source code from **Open WebUI** (github.com/open-webui/open-webui), which is
distributed under the Open WebUI License — a BSD-3-Clause-style license with an additional
branding-protection clause:

> Copyright (c) 2023- Open WebUI Inc. [Created by Timothy Jaeryang Baek]
> All rights reserved.

Full license text: https://github.com/open-webui/open-webui/blob/main/LICENSE

The quotes here are for interoperability/implementation reference. If any of this code is
copied into our product (rather than re-implemented), retain the copyright notice above and
review the license's branding clause.

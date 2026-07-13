// Chat domain: model streaming and chat routes for every non-Pi mode —
// cloud (OpenAI/Anthropic/Mistral/Google), Ollama (incl. native tool
// calling / agent mode), LM Studio and llama.cpp — plus the model-listing
// endpoints. The heavy helper web is injected from server.js and will
// migrate here incrementally.
const { randomUUID } = require("crypto");
const http = require("http");
const { buildChatLibraryContext } = require("../library/store");
const {
  buildForcedSkillToolCall,
  isDatabaseSlashCommand,
  isSkillSlashCommand,
  parseSlashCommand,
} = require("../slash_commands.js");
const {
  executeSkill,
  readLessons,
  skillRequiresShellConfirmation,
} = require("../skills.js");
const { getMcpOllamaTools, executeMcpTool } = require("../mcp.js");
const { getPluginToolDefs } = require("../plugins.js");

module.exports = function createChatDomain(deps) {
  const {
    DATA_DIR,
    PORT,
    CLOUD_DEFAULT_MODELS,
    CLOUD_PROVIDER_SET,
    appendSecurityEvent,
    clampNumber,
    emitSlashCommand,
    getCommandMessage,
    getLibraryContextSourceResults,
    getLibraryRequestForCommand,
    loadCloudSettings,
    normalizeAttachmentImages,
    normalizeStoredConversationMessages,
    ollamaChat,
    ollamaConn,
    parseJsonBody,
    sanitizeModelMessages,
    sanitizeTraceEventForStorage,
    serializeLibraryResults,
    streamCloudCompletion,
    upsertConversation,
    LOCAL_MODE_DEFAULTS,
    loadLocalModelSettings,
    normalizeLocalBaseUrl,
    sanitizeLocalParams,
    streamLocalOpenAiCompletion,
    loadSkillsConfig,
    defaultSkillsConfig,
    buildCloudEndpoint,
    createHttpError,
    getCloudApiKey,
    ALL_SKILLS,
    loadCustomSkills,
    MAX_HISTORY_MESSAGES,
    clampOllamaInteger,
    clampOllamaNumber,
    DB_ON_PROMPT,
  } = deps;

  function getModels() {
    return new Promise((resolve, reject) => {
      const opts = {
        ...ollamaConn(),
        path: "/api/tags",
        method: "GET",
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).models.map((m) => m.name));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  async function handleLocalModeStream(modeId, req, res, send) {
    let finished = false;
    const abortController = new AbortController();
    const traceEvents = [];
    const emit = (event) => {
      const stored = sanitizeTraceEventForStorage(event);
      if (stored) traceEvents.push(stored);
      if (!res.writableEnded) res.write(JSON.stringify(event) + "\n");
    };
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body.message !== "string" || !body.message.trim()) {
        send(400, { error: "message is required" });
        return;
      }
      const settings = loadLocalModelSettings();
      const conf = settings[modeId] || {};
      const baseUrl = normalizeLocalBaseUrl(
        conf.baseUrl,
        LOCAL_MODE_DEFAULTS[modeId].baseUrl,
      );
      // Client sends explicit "" when "Automatic" is selected.
      // Prefer the client's explicit choice; fall back to server saved setting only
      // when the client sent nothing (undefined), not when it sent empty string.
      let model =
        body.model !== undefined
          ? typeof body.model === "string"
            ? body.model.trim()
            : ""
          : conf.model || "";
      // "Automatic" (empty model): name a concrete model so LM Studio can load
      // it, instead of erroring with "No models loaded". llama.cpp is unaffected
      // (it serves whatever it was started with), and if nothing resolves we
      // leave it empty and proceed as before.
      if (!model) {
        model = await resolveAutomaticLocalModel(modeId, baseUrl);
      }
      // Prefer params from the request; fall back to the saved per-mode config.
      const params = sanitizeLocalParams(body.params || conf.params);
      const { history = [], saveConv, convTitle, library } = body;
      const originalMessage = body.message;
      const slashCommand = parseSlashCommand(originalMessage);
      const message = getCommandMessage(slashCommand, originalMessage);
      const messages = normalizeCloudHistoryMessages(history, message);
      const storedMessages = normalizeStoredConversationMessages(
        history,
        originalMessage,
      );
      // Hard-mode override (proofread / translate): bypass policy, library, skills.
      const systemOverride =
        typeof body.systemOverride === "string"
          ? body.systemOverride.trim()
          : "";
      let requestMessages = systemOverride
        ? [{ role: "system", content: systemOverride }, ...messages]
        : withSharedSystemPrompt(messages);
      let librarySourceResults = [];
      let libraryPassages = [];
      let databaseContextEnabled = false;
      let output = "";
      let usage = null;
      let thinking = "";
      let emittedThinkingStart = false;

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      req.on("close", () => {
        if (!finished) abortController.abort();
      });
      emitSlashCommand(emit, slashCommand);

      // Tracks whether model-callable skills are offered this turn.
      // Stays false in hard-mode (systemOverride), DB-context, and slash commands.
      let localSkillsEnabled = false;
      // Native OpenAI tool calling (per-mode setting, default on). Falls back to
      // the XML path mid-request if the server rejects the `tools` parameter.
      let nativeToolsEnabled = false;
      let nativeTools = [];
      let skillsPromptMessage = null;
      // Agent mode raises the tool-call budget and switches the prompt to a
      // plan-first workflow. The default budget suits quick lookups only.
      const agentModeEnabled = conf.agentMode === true;
      const maxRounds = agentModeEnabled
        ? Math.min(50, Math.max(1, Number(conf.agentMaxRounds) || 25))
        : 6;
      if (!systemOverride) {
        try {
          const libraryContext = await buildChatLibraryContext(
            message,
            getLibraryRequestForCommand(library, slashCommand, history, modeId),
          );
          if (libraryContext.enabled) {
            databaseContextEnabled = true;
            requestMessages[0] = {
              role: "system",
              content: getSharedAssistantPolicyPrompt(true),
            };
            requestMessages = insertLibraryContextMessage(
              requestMessages,
              libraryContext.contextMessage,
            );
            librarySourceResults = serializeLibraryResults(
              getLibraryContextSourceResults(libraryContext),
              getLibraryRequestForCommand(library, slashCommand, history),
            );
            libraryPassages = Array.isArray(libraryContext.contextResults)
              ? libraryContext.contextResults
              : [];
            emit({
              type: "library_results",
              results: librarySourceResults,
              passages: libraryPassages,
              meta: libraryContext.contextMeta,
            });
          }
        } catch (e) {
          emit({ type: "library_error", error: e.message });
        }

        // Optional user-selected system prompt overlay (topbar prompt dropdown),
        // applied only when Database Context is off, right after the base policy.
        const promptOverlay =
          typeof body.promptOverlay === "string"
            ? body.promptOverlay.trim()
            : "";
        if (promptOverlay && !databaseContextEnabled) {
          requestMessages = [
            requestMessages[0],
            {
              role: "system",
              content: `Additional user-selected overlay instructions (secondary to the built-in default policy):\n\n${promptOverlay}`,
            },
            ...requestMessages.slice(1),
          ];
        }

        // Skills work exactly like Cloud: offered only when Database Context is off
        // (the DB-on prompt answers strictly from library passages) and not a slash
        // command. Tool-calling-trained models get them as native OpenAI tools;
        // the <call:...> XML mechanism stays as the fallback.
        localSkillsEnabled = !slashCommand && !databaseContextEnabled;
        if (localSkillsEnabled) {
          if (conf.nativeTools !== false) {
            nativeTools = getLocalNativeTools();
            nativeToolsEnabled = nativeTools.length > 0;
          }
          const skillsPrompt = getCloudSkillsPolicyPrompt({
            nativeToolCalling: nativeToolsEnabled,
            agentMode: agentModeEnabled,
            agentMaxRounds: maxRounds,
          });
          if (skillsPrompt) {
            skillsPromptMessage = { role: "system", content: skillsPrompt };
            requestMessages = [
              requestMessages[0],
              skillsPromptMessage,
              ...requestMessages.slice(1),
            ];
          }
        }
      }

      if (isSkillSlashCommand(slashCommand)) {
        try {
          const toolCall = buildForcedSkillToolCall(slashCommand);
          emit({
            type: "tool_start",
            toolName: slashCommand.skillName,
            argsPreview: toolCall.function.arguments.slice(0, 300),
          });
          const result = await executeToolCallWithConfirmation(toolCall, emit);
          appendForcedSkillResult(requestMessages, slashCommand, result);
          emit({
            type: "tool_end",
            toolName: slashCommand.skillName,
            outputPreview: String(result || "").slice(0, 300),
            isError: /^Error:/i.test(String(result || "")),
          });
        } catch (e) {
          emit({ type: "error", error: e.message });
          if (!res.writableEnded) res.end();
          return;
        }
      }

      const seenSkillCalls = new Set();
      // Text the model wrote in a round that ended with a tool call is interim
      // (plan, notes, false starts) — it belongs in the thinking stream, never
      // in the reply bubble.
      const moveInterimTextToThinking = () => {
        if (!output.trim()) return;
        if (!emittedThinkingStart) {
          emittedThinkingStart = true;
          emit({ type: "thinking_start" });
        }
        const interim = `\n\n[Interim notes]\n${output.trim()}\n`;
        thinking += interim;
        emit({ type: "thinking_delta", delta: interim, thinking });
      };
      // When the budget runs out, end with an answer instead of an error: stop
      // offering tools and tell the model to write its final reply.
      const exhaustToolBudget = () => {
        localSkillsEnabled = false;
        nativeToolsEnabled = false;
        requestMessages = [
          ...requestMessages,
          {
            role: "user",
            content:
              "[TOOL BUDGET EXHAUSTED] You have used every allowed tool call for this request. Do not call any more tools. Write your complete final answer now from everything you already found.",
          },
        ];
        if (!emittedThinkingStart) {
          emittedThinkingStart = true;
          emit({ type: "thinking_start" });
        }
        const note = "\n\n[Tool budget exhausted — writing final answer]\n";
        thinking += note;
        emit({ type: "thinking_delta", delta: note, thinking });
        output = "";
        emit({ type: "delta", delta: "", response: output });
      };
      // Runs a single tool call (shared by the native and XML paths): emits the
      // trace events, applies the repeated-call guard, executes, and reports
      // any sources the skill returned.
      const runLocalToolCall = async (toolCall) => {
        if (!emittedThinkingStart) {
          emittedThinkingStart = true;
          emit({ type: "thinking_start" });
        }
        const startMsg = `\n\n[Running tool: ${toolCall.function.name}...]\n`;
        thinking += startMsg;
        emit({ type: "thinking_delta", delta: startMsg, thinking });
        emit({
          type: "tool_start",
          toolName: toolCall.function.name,
          argsPreview: toolCall.function.arguments.slice(0, 300),
        });

        // Loop guard: if the model repeats the exact same call (a common failure
        // mode for small models that keep re-searching), don't run it again —
        // tell it to answer from what it has. This prevents runaway recursion.
        const callKey = `${toolCall.function.name}:${toolCall.function.arguments
          .replace(/\s+/g, "")
          .toLowerCase()}`;
        let result;
        if (seenSkillCalls.has(callKey)) {
          result = `You already ran ${toolCall.function.name} with these exact arguments and have the results above. Do not repeat this call. Answer the user's question now using what you already found.`;
        } else {
          seenSkillCalls.add(callKey);
          try {
            result = await executeToolCallWithConfirmation(toolCall, emit);
          } catch (toolError) {
            result = `Error: ${toolError.message}`;
          }
        }

        emit({
          type: "tool_end",
          toolName: toolCall.function.name,
          outputPreview: String(result || "").slice(0, 300),
          isError: /^Error:/i.test(String(result || "")),
        });
        const localSources = extractSkillSources(
          toolCall.function.name,
          safeParseArgs(toolCall.function.arguments),
          result,
        );
        if (localSources.length) {
          librarySourceResults = mergeWebSourceResults(
            librarySourceResults,
            localSources,
          );
          emit({ type: "web_sources", sources: localSources });
        }
        const endMsg = `[Finished tool: ${toolCall.function.name}]\n`;
        thinking += endMsg;
        emit({ type: "thinking_delta", delta: endMsg, thinking });
        return result;
      };

      // Load the chosen model if LM Studio doesn't have it in memory yet, so the
      // user never gets "No models loaded" after the indexer loaded only an
      // embedder. Surfaced as a thinking line during the (one-time) load.
      await ensureLocalChatModelLoaded(
        modeId,
        baseUrl,
        model,
        (loadingModel) => {
          if (!emittedThinkingStart) {
            emittedThinkingStart = true;
            emit({ type: "thinking_start" });
          }
          const note = `\n\n[Loading model ${loadingModel} into ${modeId}…]\n`;
          thinking += note;
          emit({ type: "thinking_delta", delta: note, thinking });
        },
      );

      let round = 0;
      for (;;) {
        // Once a native tool call starts streaming, everything the model wrote
        // this round is interim — stop mirroring it to the reply bubble.
        let sawToolCallThisRound = false;
        let streamResult;
        try {
          streamResult = await streamLocalOpenAiCompletion({
            baseUrl,
            model,
            messages: requestMessages,
            // Attach the image only on the first (user) round.
            images: round === 0 ? body.images : undefined,
            params,
            tools: nativeToolsEnabled ? nativeTools : undefined,
            signal: abortController.signal,
            onToolCall: () => {
              if (sawToolCallThisRound) return;
              sawToolCallThisRound = true;
              emit({ type: "delta", delta: "", response: "" });
            },
            onDelta: (delta) => {
              output += delta;
              if (sawToolCallThisRound) return;
              if (output.includes("<call:")) return;
              // Send the raw output (including any trailing partial "<call") so the
              // client can hide it and show the animated drum icon, matching Ollama.
              emit({
                type: "delta",
                delta,
                response: output,
              });
            },
            onReasoning: (chunk) => {
              if (!emittedThinkingStart) {
                emittedThinkingStart = true;
                emit({ type: "thinking_start" });
              }
              thinking += chunk;
              emit({ type: "thinking_delta", delta: chunk, thinking });
            },
            onUsage: (nextUsage) => {
              usage = nextUsage;
            },
          });
        } catch (streamError) {
          // The server rejected the native `tools` parameter (e.g. llama.cpp
          // started without --jinja): retry the same round on the XML path.
          if (nativeToolsEnabled && streamError?.statusCode === 400) {
            nativeToolsEnabled = false;
            if (skillsPromptMessage) {
              skillsPromptMessage.content = getCloudSkillsPolicyPrompt({
                agentMode: agentModeEnabled,
                agentMaxRounds: maxRounds,
              });
            }
            output = "";
            continue;
          }
          throw streamError;
        }
        if (streamResult.usage) usage = streamResult.usage;

        // Native path: the model asked for tools through the OpenAI schema.
        const nativeCalls = localSkillsEnabled ? streamResult.toolCalls : [];
        if (nativeCalls.length) {
          if (round >= maxRounds) {
            exhaustToolBudget();
            continue;
          }
          round += 1;
          const assistantToolCalls = nativeCalls.map((call, i) => ({
            id: call.id || `call_${round}_${i}`,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments || "{}",
            },
          }));
          requestMessages = [
            ...requestMessages,
            {
              role: "assistant",
              content: output,
              tool_calls: assistantToolCalls,
            },
          ];
          for (const assistantCall of assistantToolCalls) {
            const result = await runLocalToolCall({
              function: {
                name: assistantCall.function.name,
                arguments: assistantCall.function.arguments,
              },
            });
            requestMessages = [
              ...requestMessages,
              {
                role: "tool",
                tool_call_id: assistantCall.id,
                content: String(result ?? ""),
              },
            ];
          }
          // Reset the accumulated text so the final reply is ONLY what the model
          // writes after the tool results; anything interim goes to thinking.
          moveInterimTextToThinking();
          output = "";
          emit({ type: "delta", delta: "", response: output });
          continue;
        }

        // XML fallback path: models without native tool support (or servers
        // that ignore `tools`) emit the prompt-taught <call:...> syntax.
        const xmlMatch = localSkillsEnabled
          ? output.match(/<call:([^>]+)>(.*?)<\/call>/is)
          : null;
        if (!xmlMatch) break;

        output = output.replace(xmlMatch[0], "").trim();
        if (round >= maxRounds) {
          exhaustToolBudget();
          continue;
        }
        round += 1;

        const toolCall = {
          function: { name: xmlMatch[1].trim(), arguments: xmlMatch[2].trim() },
        };
        const result = await runLocalToolCall(toolCall);

        if (output) {
          requestMessages = [
            ...requestMessages,
            { role: "assistant", content: output },
          ];
        }
        requestMessages = [
          ...requestMessages,
          {
            role: "user",
            content: `[SKILL RESULT: ${toolCall.function.name}]\n\n${result}\n\nUsing this skill result, write your complete final answer to the user's question now. Do not repeat this skill call.`,
          },
        ];
        // Reset the accumulated text so the final reply is ONLY what the model
        // writes after seeing the skill result. Otherwise any answer it produced
        // BEFORE calling the skill stays prepended and the reply looks duplicated.
        moveInterimTextToThinking();
        output = "";
        emit({ type: "delta", delta: "", response: output });
      }

      // Final safety net: never let raw skill-call syntax reach the bubble, even
      // if a call was malformed or emitted while skills were disabled (DB on).
      output = stripLeakedSkillCalls(output);
      emit({ type: "delta", delta: "", response: output });

      if (emittedThinkingStart) {
        emit({ type: "thinking_end", thinking });
      }

      finished = true;
      upsertConversation(
        saveConv,
        convTitle,
        originalMessage,
        storedMessages,
        output,
        modeId,
        {
          librarySources: librarySourceResults,
          passages: libraryPassages,
          thinking,
          traceEvents,
        },
      );
      emit({ type: "done", response: output, usage, model });
      if (!res.writableEnded) res.end();
    } catch (e) {
      const isAbort = e?.name === "AbortError";
      if (!finished) finished = true;
      if (!res.writableEnded) {
        if (!res.headersSent) {
          send(isAbort ? 499 : e.statusCode || 500, {
            error: isAbort ? "Request cancelled." : e.message,
          });
        } else {
          emit({
            type: "error",
            error: isAbort ? "Request cancelled." : e.message,
          });
          res.end();
        }
      }
    }
  }

  async function resolveAutomaticLocalModel(modeId, baseUrl) {
    const root = baseUrl.replace(/\/v\d+$/, "");
    // 1) An already-loaded model (LM Studio's native endpoint reports state).
    try {
      const r = await fetch(root + "/api/v0/models", { method: "GET" });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        const list = Array.isArray(d?.data) ? d.data : [];
        const loaded = list.find(
          (m) => m && m.state === "loaded" && !/embed/i.test(m.id || ""),
        );
        if (loaded && loaded.id) return loaded.id;
      }
    } catch (_e) {
      // best-effort; fall through to the OpenAI-compatible list
    }
    // 2) First non-embedding model the server has available to load.
    try {
      const { models } = await fetchLocalModels(modeId);
      if (Array.isArray(models) && models.length) return models[0];
    } catch (_e) {
      // leave unresolved
    }
    return "";
  }

  async function ensureLocalChatModelLoaded(modeId, baseUrl, model, onStatus) {
    if (modeId !== "lmstudio" || !model) return;
    if ((await lmStudioModelIsLoaded(baseUrl, model)) === true) return;
    if (typeof onStatus === "function") onStatus(model);
    await loadLmStudioModel(baseUrl, model);
  }

  async function loadLmStudioModel(baseUrl, model) {
    if (!model) return false;
    const root = baseUrl.replace(/\/v\d+$/, "");
    // v1 is the current endpoint; fall back to the legacy v0 path.
    for (const path of ["/api/v1/models/load", "/api/v0/models/load"]) {
      try {
        const r = await fetch(root + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
          // Loading a large model can take a while; allow up to 10 minutes.
          signal: AbortSignal.timeout(600000),
        });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          if (!d || d.status === "loaded" || d.instance_id || d.type)
            return true;
        }
        // 404 -> try the next path; other non-OK -> give up on this path.
        if (r.status !== 404) break;
      } catch (_e) {
        // network error: stop trying, let the chat request report it
        break;
      }
    }
    return false;
  }

  async function lmStudioModelIsLoaded(baseUrl, model) {
    const root = baseUrl.replace(/\/v\d+$/, "");
    try {
      const r = await fetch(root + "/api/v0/models", {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return null; // endpoint absent -> unknown
      const d = await r.json().catch(() => null);
      const list = Array.isArray(d?.data) ? d.data : [];
      return list.some((m) => m && m.id === model && m.state === "loaded");
    } catch (_e) {
      return null;
    }
  }

  function appendForcedSkillResult(messages, command, result) {
    messages.push({
      role: "user",
      content: `[FORCED SKILL RESULT: ${command.skillName}]\n\n${result}\n\nAnswer the user's request using this forced skill result. If the result is insufficient, say so. Do not call another skill unless the user asked for it explicitly.`,
    });
  }

  async function executeToolCallWithConfirmation(toolCall, emit) {
    // A disabled skill must NOT crash the stream. Return an instructive result
    // so the model recovers by using one of its enabled skills instead.
    try {
      assertBuiltinSkillEnabled(toolCall.function.name);
    } catch (error) {
      const enabled = Object.entries(loadSkillsConfig())
        .filter(([, v]) => v !== false)
        .map(([k]) => k)
        .join(", ");
      return `${error.message} Do NOT call it again. Use one of your ENABLED skills instead (${enabled}) to answer the question.`;
    }
    const requiresShellConfirmation = skillRequiresShellConfirmation(
      toolCall.function.name,
      DATA_DIR,
    );
    let executeAllowed = true;
    if (requiresShellConfirmation) {
      executeAllowed = await requestShellConfirmation({
        emit,
        title: "Shell Command Execution Request",
        command: toolCall.function.arguments,
        toolName: toolCall.function.name,
      });
    }

    if (!executeAllowed) {
      appendSecurityEvent("shell_command_denied", {
        command: toolCall.function.arguments,
        tool: toolCall.function.name,
      });
      return "User denied permission to execute this shell command.";
    }

    if (toolCall.function.name.startsWith("mcp__")) {
      return await executeMcpTool(toolCall);
    }

    if (requiresShellConfirmation) {
      appendSecurityEvent("shell_command_executed", {
        command: toolCall.function.arguments,
        tool: toolCall.function.name,
      });
    }
    return await executeSkill(toolCall, {
      dataDir: DATA_DIR,
      allowShellCommand: requiresShellConfirmation,
      cloudKeys: getCloudSearchKeys(),
    });
  }

  async function requestShellConfirmation({ emit, title, command, toolName }) {
    return await new Promise((resolve) => {
      const reqId = "ollama_req_" + Date.now() + "_" + randomUUID();
      const denialTimer = setTimeout(
        () => {
          if (ollamaToolRequests.has(reqId)) {
            ollamaToolRequests.delete(reqId);
            resolve(false);
            appendSecurityEvent("shell_command_timeout_denied", { reqId });
          }
        },
        5 * 60 * 1000,
      );
      ollamaToolRequests.set(reqId, {
        resolve,
        timer: denialTimer,
      });
      emit({
        type: "needs_ui",
        sessionId: reqId,
        request: {
          method: "confirm",
          title,
          message: `The AI wants to run the following shell command:\n\n${command}\n\nDo you want to allow this?`,
          requireUserInteraction: true,
          danger: true,
        },
      });
      appendSecurityEvent("shell_command_confirmation_requested", {
        reqId,
        tool: toolName,
      });
    });
  }

  function assertBuiltinSkillEnabled(skillName) {
    if (
      !Object.prototype.hasOwnProperty.call(defaultSkillsConfig(), skillName)
    ) {
      return;
    }
    const config = loadSkillsConfig();
    if (config[skillName] === false) {
      throw new Error(`Skill "${skillName}" is disabled in Skills settings.`);
    }
  }

  function extractSkillSources(toolName, argsObj, resultText) {
    const text = String(resultText || "");
    const sources = [];
    const seen = new Set();
    const add = (title, url) => {
      const clean = String(url || "").trim();
      if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
      seen.add(clean);
      sources.push({
        title: String(title || hostTitleFromUrl(clean)).slice(0, 140),
        url: clean,
      });
    };
    // web_search list: "N. Title" line followed by a "URL: <url>" line.
    const lines = text.split("\n");
    let lastTitle = "";
    for (const line of lines) {
      const t = line.match(/^\s*\d+\.\s*(.+?)\s*$/);
      if (t) {
        lastTitle = t[1].trim();
        continue;
      }
      const u = line.match(/^\s*URL:\s*(\S+)/i);
      if (u) {
        add(lastTitle, u[1]);
        lastTitle = "";
      }
    }
    // Citation comments used by wikipedia/britannica/wiktionary: <!-- https://... -->
    const commentRe = /<!--\s*(https?:\/\/\S+?)\s*-->/g;
    let m;
    while ((m = commentRe.exec(text)) !== null)
      add(hostTitleFromUrl(m[1]), m[1]);
    // web_scraper reads a single URL passed as an argument.
    if (toolName === "web_scraper" && argsObj && argsObj.url) {
      add(hostTitleFromUrl(argsObj.url), argsObj.url);
    }
    // book_search lists its providers as markdown links on a "Sources:" line.
    if (toolName === "book_search") {
      const BOOK_PROVIDER_LABELS = {
        openlibrary: "Open Library",
        google: "Google Books",
        goodreads: "Goodreads",
        storygraph: "StoryGraph",
        hardcover: "Hardcover",
        librarything: "LibraryThing",
        calibre: "Calibre",
      };
      // Only the links inside the sources comment become pills — the Cover
      // link stays a plain hyperlink in the reply.
      const sourcesComment = text.match(/<!--\s*sources:([\s\S]*?)-->/i);
      const scope = sourcesComment ? sourcesComment[1] : text;
      const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
      let link;
      while ((link = linkRe.exec(scope)) !== null) {
        add(BOOK_PROVIDER_LABELS[link[1]] || link[1], link[2]);
      }
    }
    return sources;
  }

  function hostTitleFromUrl(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  async function fetchLocalModels(modeId) {
    const settings = loadLocalModelSettings();
    const baseUrl = normalizeLocalBaseUrl(
      settings[modeId]?.baseUrl,
      LOCAL_MODE_DEFAULTS[modeId].baseUrl,
    );
    let res;
    try {
      const endpoint =
        modeId === "lmstudio"
          ? baseUrl.replace(/\/v1$/, "") + "/api/v1/models"
          : buildCloudEndpoint(baseUrl, "/models");
      res = await fetch(endpoint, {
        method: "GET",
      });
    } catch (e) {
      throw createHttpError(
        502,
        `Could not reach the local server at ${baseUrl}. Is it running? (${e.message})`,
      );
    }
    if (!res.ok) {
      throw createHttpError(res.status, `Model list failed (${res.status}).`);
    }
    const data = await res.json().catch(() => null);
    const modelsList = Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data?.data)
        ? data.data
        : [];
    const allIds = modelsList.map((m) => m?.key || m?.id).filter(Boolean);
    // Embedding models (e.g. LM Studio's bundled
    // text-embedding-nomic-embed-text-v1.5) are listed by /v1/models but cannot
    // chat — keep them out of the chat dropdown and report them separately so
    // the Database settings can offer them as embedding backends.
    const models = allIds.filter((id) => !/embed/i.test(id));
    const embeddingModels = allIds.filter((id) => /embed/i.test(id));
    // The OpenAI-compat /v1/models list is used for model IDs, but we extract the
    // actual loaded context window from the v1 loaded_instances config (or
    // llama.cpp's /props), so the UI can show "used / context".
    const root = baseUrl.replace(/\/v\d+$/, "");
    let contextLength = null;
    try {
      if (modeId === "lmstudio") {
        const loadedModel = modelsList.find(
          (m) => m && m.loaded_instances?.length > 0,
        );
        if (loadedModel) {
          contextLength =
            loadedModel.loaded_instances[0].config?.context_length;
        }
      } else {
        const r = await fetch(root + "/props", { method: "GET" });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          const n = d?.default_generation_settings?.n_ctx ?? d?.n_ctx;
          if (typeof n === "number") contextLength = n;
        }
      }
    } catch (_e) {
      // context length is best-effort
    }
    return { models, embeddingModels, contextLength };
  }

  function getCloudSearchKeys() {
    const settings = loadCloudSettings();
    return {
      openai: getCloudApiKey(settings, "openai") || "",
      anthropic: getCloudApiKey(settings, "anthropic") || "",
      google: getCloudApiKey(settings, "google") || "",
    };
  }

  function getCloudSkillsPolicyPrompt(options = {}) {
    const nativeToolCalling = options.nativeToolCalling === true;
    const agentMode = options.agentMode === true;
    const agentMaxRounds = Number(options.agentMaxRounds) || 25;
    const skillsConfig = loadSkillsConfig();
    const enabledSkills = ALL_SKILLS.filter(
      (skill) => skillsConfig[skill.function.name] !== false,
    );
    const customSkills = loadCustomSkills().filter(
      (skill) =>
        skill && typeof skill.name === "string" && skill.name.trim().length > 0,
    );
    const pluginSkills = getPluginToolDefs().filter(
      (skill) => skillsConfig[skill.function.name] !== false,
    );
    if (!enabledSkills.length && !customSkills.length && !pluginSkills.length)
      return "";

    const lines = [
      "### SKILLS & TOOL USAGE (MANDATORY)",
      "You have access to external tools (skills) that fetch live, verifiable information or perform local actions. Skill results are your primary source of truth.",
      "",
      "RULES:",
      "1. If Database Context/local library passages are provided in the current turn, the local database has priority. Answer from those passages first and call skills only if they are insufficient or the user explicitly requested a specific tool.",
      "2. Otherwise, for ANY question involving facts, people, places, events, news, dates, definitions, word origins, calculations, unit conversions, the current time or date, or the content of a URL, you MUST call the relevant skill BEFORE answering, even if you believe you already know the answer.",
      "3. Base your answer on the skill results. Use your own training knowledge only when the skills return no useful result or an error, and in that case explicitly tell the user that the lookup failed or returned nothing.",
      "4. Purely creative, conversational, or text-transformation requests (rewriting, translating, proofreading, or summarizing text the user provided) do not require skills.",
      "",
    ];
    if (nativeToolCalling) {
      // Native mode: the tool list (names, descriptions, JSON schemas) travels
      // in the request's `tools` array, so don't duplicate it in the prompt.
      lines.push(
        "HOW TO CALL A SKILL:",
        "Call tools ONLY through your native function-calling mechanism. NEVER write tool-call syntax (XML, JSON, or code blocks) in your reply text.",
        "Call one tool at a time. After receiving a result you may call another tool if needed.",
        "",
        "ONLY the tools provided in your tool list exist and are enabled. Never invent a tool name. If a tool result says a tool is disabled, do not call it again; use an enabled one.",
        "",
      );
    } else {
      lines.push("Available skills:");
      let index = 1;
      for (const skill of enabledSkills) {
        const name = skill.function.name;
        const example = CLOUD_SKILL_EXAMPLES[name] || "{}";
        lines.push(
          `${index}. **${name}:** ${skill.function.description}\n   - Example: <call:${name}>${example}</call>`,
        );
        index += 1;
      }
      for (const pluginSkill of pluginSkills) {
        lines.push(
          `${index}. **${pluginSkill.function.name}:** ${pluginSkill.function.description}\n   - Example: <call:${pluginSkill.function.name}>{}</call>`,
        );
        index += 1;
      }
      for (const custom of customSkills) {
        lines.push(
          `${index}. **${custom.name}:** ${custom.description || "User-defined custom skill."}\n   - Example: <call:${custom.name}>{}</call>`,
        );
        index += 1;
      }
      // Connected MCP tools are callable through the same XML mechanism (the
      // executor routes mcp__ names to the MCP client), so list them for the
      // XML-driven modes: Cloud and local-mode fallback. Ollama gets MCP tools
      // natively via its own tools API instead.
      for (const mcpTool of getMcpOllamaTools()) {
        lines.push(
          `${index}. **${mcpTool.function.name}:** ${mcpTool.function.description}\n   - Example: <call:${mcpTool.function.name}>{}</call>`,
        );
        index += 1;
      }
      lines.push(
        "",
        "HOW TO CALL A SKILL:",
        "Output exactly one XML block in this exact format and then stop writing:",
        '<call:skill_name>{"arg": "value"}</call>',
        "The system intercepts the block, executes the skill, and sends you the result so you can continue your answer.",
        "Call one skill at a time. After receiving a result you may call another skill if needed.",
        "",
        "ONLY the skills listed above exist and are enabled. Any skill NOT in that list is disabled — never call it. If a skill result says a skill is disabled, do not call it again; use an enabled one.",
        "",
      );
    }
    if (agentMode) {
      lines.push(
        `AGENT WORKFLOW (up to ${agentMaxRounds} tool calls for this request):`,
        "For any task that needs multiple steps (research, comparing sources, gathering material, writing notes):",
        "1. FIRST think through a short numbered plan of the steps you intend to take. Keep it to one line per step.",
        "2. Execute the plan one tool call at a time. After each result, decide whether the plan still holds; revise it if a step failed or a result changed the picture.",
        "3. Never repeat a call that already failed with the same arguments — change the approach instead.",
        "4. When the plan is complete (or further calls stop adding information), write the final answer synthesizing everything you found.",
        "CRITICAL — WHERE TO WRITE WHAT: the plan and your notes between steps belong in your reasoning/thinking, NEVER in the reply text. While you still intend to call more tools, output NOTHING as reply text — no plan, no progress notes, no partial answers. The ONLY prose you ever write as reply text is the single final answer, after your last tool call.",
        "AMBIGUITY: If a name or term is ambiguous, resolve it with ONE clarifying lookup or answer for the most prominent match and note the assumption in one sentence.",
        "",
      );
    } else {
      lines.push(
        "RESEARCH CHAIN (follow strictly, maximum 4 skill calls per question):",
        "For factual, biographical, current-events, or 'who/what is X' questions:",
        "1. Call deep_research with 'queries' holding 2-4 VARIED angles (different phrasing and scope).",
        "2. If it returns nothing useful, retry deep_research ONCE with completely different phrasing.",
        "3. If that also fails, call wikipedia and britannica on the topic and answer from them.",
        "4. After at most 4 skill calls you MUST stop calling skills and write your answer from whatever you have; if nothing was found, say plainly that you could not verify the topic. Never repeat a failed call and never keep deliberating about whether to search again.",
        "AMBIGUITY: If a name or term is ambiguous (multiple people or topics match) or you cannot tell who the user means, do NOT search repeatedly — answer for the most prominent match and note the assumption in one sentence, or say you cannot confidently identify the subject and ask which one they mean.",
        "",
      );
    }
    lines.push(
      "ANSWER LENGTH AND STYLE:",
      "When the skill results contain rich material, write a COMPREHENSIVE, well-structured answer — multiple detailed paragraphs covering background, key facts, context, and significance, integrating all the sources. When the material is thin, write a shorter accurate answer instead of inflating it. FORBIDDEN: filler adverbs and adjectives, empty intensifiers ('truly remarkable', 'deeply fascinating', 'incredibly important'), and padding sentences that add no facts. Clean, precise, academic prose only — depth must come from information, never from decoration.",
      "",
      "SOURCES:",
      "Do NOT write source links, a 'Source:' line, a 'References' section, or URLs in your answer. The app shows every source used as a clickable pill automatically. Just write the answer itself.",
    );
    return lines.join("\n");
  }

  const CLOUD_SKILL_EXAMPLES = {
    wikipedia: '{"query": "Bob Dylan", "language": "en"}',
    britannica: '{"query": "Bob Dylan"}',
    wiktionary: '{"word": "algorithm", "language": "en"}',
    deep_etymology: '{"word": "eventualmente", "language": "es"}',
    deep_research:
      '{"queries": ["Dean Benedetti biography", "Dean Benedetti Charlie Parker recordings", "Dean Benedetti jazz saxophonist history"]}',
    duckduckgo: '{"query": "latest AI news"}',
    fact_check: '{"claim": "The moon is made of cheese"}',
    web_scraper: '{"url": "https://example.com"}',
    calculator: '{"expression": "2 + 2 * 4"}',
    local_notes: '{"action": "read"}',
    time_and_date: '{"timezone": "Australia/Sydney"}',
    shell_command: '{"command": "ls"}',
  };

  function getLocalNativeTools() {
    const skillsConfig = loadSkillsConfig();
    const tools = ALL_SKILLS.filter(
      (skill) => skillsConfig[skill.function.name] !== false,
    ).map((skill) => ({
      type: "function",
      function: {
        name: skill.function.name,
        description: skill.function.description,
        parameters: skill.function.parameters || {
          type: "object",
          properties: {},
        },
      },
    }));
    for (const pluginTool of getPluginToolDefs()) {
      if (skillsConfig[pluginTool.function.name] === false) continue;
      tools.push(pluginTool);
    }
    for (const custom of loadCustomSkills()) {
      if (!custom || typeof custom.name !== "string" || !custom.name.trim()) {
        continue;
      }
      tools.push({
        type: "function",
        function: {
          name: custom.name.trim(),
          description: custom.description || "User-defined custom skill.",
          parameters: { type: "object", properties: {} },
        },
      });
    }
    for (const mcpTool of getMcpOllamaTools()) tools.push(mcpTool);
    return tools;
  }

  function insertLibraryContextMessage(messages, contextMessage) {
    if (!contextMessage) return messages;
    const nextMessages = Array.isArray(messages) ? [...messages] : [];
    const firstNonSystemIndex = nextMessages.findIndex(
      (item) => item.role !== "system",
    );
    if (firstNonSystemIndex === -1) {
      nextMessages.push(contextMessage);
    } else {
      nextMessages.splice(firstNonSystemIndex, 0, contextMessage);
    }
    return nextMessages;
  }

  function mergeWebSourceResults(existing, incoming) {
    const merged = Array.isArray(existing) ? [...existing] : [];
    const seen = new Set(
      merged
        .map((item) => (item && item.url ? String(item.url) : ""))
        .filter(Boolean),
    );
    for (const source of Array.isArray(incoming) ? incoming : []) {
      if (!source) continue;
      const url = source.url ? String(source.url) : "";
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);
      merged.push(source);
    }
    return merged;
  }

  function normalizeCloudHistoryMessages(history, message) {
    const messages = [];
    const sourceHistory = Array.isArray(history) ? history : [];
    for (const item of sourceHistory) {
      if (!item || typeof item !== "object") continue;
      if (item.role !== "user" && item.role !== "assistant") continue;
      if (typeof item.content !== "string" || !item.content.trim()) continue;
      messages.push({
        role: item.role,
        content: item.content,
      });
    }
    messages.push({ role: "user", content: message });
    if (messages.length > MAX_HISTORY_MESSAGES) {
      return messages.slice(messages.length - MAX_HISTORY_MESSAGES);
    }
    return messages;
  }

  const ollamaToolRequests = new Map();

  function safeParseArgs(argStr) {
    try {
      return JSON.parse(argStr);
    } catch {
      return {};
    }
  }

  function sanitizeOllamaOptions(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const options = {
      temperature: clampOllamaNumber(raw.temperature, 0.3, 0, 2),
      top_p: clampOllamaNumber(raw.top_p, 0.75, 0, 1),
      top_k: clampOllamaInteger(raw.top_k, 40, 1, 1000),
      repeat_penalty: clampOllamaNumber(raw.repeat_penalty, 1.1, 0, 2),
      repeat_last_n: clampOllamaInteger(raw.repeat_last_n, 256, -1, 131072),
      num_predict: clampOllamaInteger(raw.num_predict, 2048, -1, 200000),
      num_ctx: clampOllamaInteger(raw.num_ctx, OLLAMA_DEFAULT_CTX, 256, 131072),
      seed: clampOllamaInteger(raw.seed, -1, -2147483648, 2147483647),
    };
    if (Array.isArray(raw.stop)) {
      const stop = raw.stop
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, 16);
      if (stop.length) options.stop = stop;
    }
    return options;
  }

  const OLLAMA_DEFAULT_CTX = 32768;

  function splitLeadingThought(raw) {
    const open = /^\s*<(thought|think)>/i.exec(raw);
    if (!open) {
      // The opener may still be arriving one character at a time — hold the
      // answer back until we know whether this is a reasoning block.
      const lead = raw.replace(/^\s*/, "").toLowerCase();
      if (
        lead &&
        lead.length < 9 &&
        ("<thought>".startsWith(lead) || "<think>".startsWith(lead))
      ) {
        return { thought: "", answer: "", opened: false, closed: false };
      }
      return { thought: "", answer: raw, opened: false, closed: false };
    }
    const close = `</${open[1].toLowerCase()}>`;
    const openEnd = open[0].length;
    const closeIdx = raw.toLowerCase().indexOf(close, openEnd);
    if (closeIdx === -1) {
      return {
        thought: raw.slice(openEnd),
        answer: "",
        opened: true,
        closed: false,
      };
    }
    return {
      thought: raw.slice(openEnd, closeIdx),
      answer: raw.slice(closeIdx + close.length),
      opened: true,
      closed: true,
    };
  }

  function stripLeakedSkillCalls(text) {
    return (
      String(text || "")
        // Completed call blocks: <call:name>args</call>.
        .replace(/<call:[^>]*>[\s\S]*?<\/call>/gi, "")
        // Malformed call: opener plus a JSON argument object but no closing tag.
        // Only the opener and its args are removed so real answer text survives.
        .replace(/<call:[^>]*>\s*\{[^{}]*\}/gi, "")
        // A bare opener/partial left dangling at the very end of the text.
        .replace(/<call:[^>]*>?\s*$/i, "")
        .trim()
    );
  }

  function withSharedSystemPrompt(messages, databaseEnabled = false) {
    const sourceMessages = Array.isArray(messages) ? messages : [];
    return [
      {
        role: "system",
        content: getSharedAssistantPolicyPrompt(databaseEnabled),
      },
      ...sourceMessages,
    ];
  }

  function getSharedAssistantPolicyPrompt(databaseEnabled = false) {
    const base = databaseEnabled === true ? DB_ON_PROMPT : DB_OFF_POLICY_PROMPT;
    // User-taught lessons (~/dive/lessons.md, managed via the remember_lesson
    // skill or Settings > Skills > Lessons) apply to every non-Pi chat.
    const lessons = readLessons(DATA_DIR);
    if (!lessons) return base;
    return (
      base +
      "\n\nLEARNED LESSONS — standing instructions the user taught you in past conversations. Follow them unless the current request explicitly overrides them:\n" +
      lessons
    );
  }

  const DB_OFF_POLICY_PROMPT = `You are an academic and concise assistant. You get straight to the point. Never use emojis.

  Always respond in the language the user speaks to you in. When you write in English, use British English spelling and conventions (e.g. "colour", "analyse", "recognise", "-ise" endings).

  If the user asks you to proofread or check grammar, return ONLY the corrected, polished text — no explanation, no commentary, no alternative versions.

  If the user asks you to translate a text, return ONLY the translation in the requested language — no explanation, no commentary, no notes.

  For any factual, encyclopedic, biographical, definitional, historical, or current-information question, use the available tools (Wikipedia, Britannica, Wiktionary, web search, etc.) rather than relying on your own training data, which is often outdated or inaccurate. Reserve your own knowledge for reasoning, explanation, writing, and language help. Never invent facts, citations, sources, dates, or page references; if no tool covers something and you cannot verify it, say so plainly.`;

  // The OpenAI `tools` array offered natively to LM Studio / llama.cpp:
  // built-in skills (already OpenAI function schemas), user custom skills, and
  // connected MCP tools. Tool-calling-trained models (Gemma, Qwen, Hermes,
  // Llama 3.x) are far more reliable with this than with prompt-injected XML;
  // the XML <call:...> path remains as fallback for servers that reject `tools`.
  async function dispatch(ctx) {
    const { req, res, urlPath, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/models") {
      try {
        send(200, { models: await getModels(), offline: false });
      } catch (_e) {
        // Ollama not running is a normal state for LM Studio / llama.cpp users:
        // report it as data, not as a 500 that spams the client console.
        send(200, { models: [], offline: true });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/ollama/tool-respond") {
      try {
        const body = await parseJsonBody(req);
        const { sessionId, uiResponse } = body || {};
        if (typeof sessionId !== "string" || !sessionId) {
          send(400, { error: "sessionId is required" });
          return;
        }

        const entry = ollamaToolRequests.get(sessionId);
        if (!entry) {
          send(404, { error: "Ollama tool request not found or expired" });
          return;
        }

        const approved =
          typeof uiResponse.confirmed === "boolean"
            ? uiResponse.confirmed
            : false;

        clearTimeout(entry.timer);
        entry.resolve(approved);
        ollamaToolRequests.delete(sessionId);

        send(200, { ok: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "GET" && urlPath.startsWith("/api/models/info")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const modelName = url.searchParams.get("model");
      if (!modelName) {
        send(400, { error: "model parameter required" });
        return;
      }
      try {
        const opts = {
          ...ollamaConn(),
          path: "/api/show",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        };
        const r = http.request(opts, (resProxy) => {
          let data = "";
          resProxy.on("data", (c) => (data += c));
          resProxy.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              // Only return a context length if the model has an explicit num_ctx
              // set in its Ollama parameters (i.e. the user ran `ollama run model
              // --num-ctx N` or set it via Modelfile). We deliberately ignore the
              // architectural context_length fields which reflect theoretical
              // maximums (e.g. 1 024 000 for Nemo) and have nothing to do with
              // what Ollama will actually load.
              let modelNumCtx = null;
              const paramsText =
                typeof parsed.parameters === "string" ? parsed.parameters : "";
              if (paramsText) {
                const m = paramsText.match(/\bnum_ctx\s+(\d+)/i);
                if (m && Number.isFinite(Number(m[1]))) {
                  modelNumCtx = Number(m[1]);
                }
              }
              send(200, { contextLength: modelNumCtx });
            } catch (e) {
              send(500, { error: "Failed to parse ollama show response" });
            }
          });
        });
        r.on("error", (e) => send(500, { error: e.message }));
        r.write(JSON.stringify({ name: modelName }));
        r.end();
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/cloud/chat/stream") {
      let finished = false;
      const abortController = new AbortController();
      const traceEvents = [];
      const emit = (event) => {
        const storedEvent = sanitizeTraceEventForStorage(event);
        if (storedEvent) traceEvents.push(storedEvent);
        if (!res.writableEnded) {
          res.write(JSON.stringify(event) + "\n");
        }
      };

      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body.message !== "string" || !body.message.trim()) {
          send(400, { error: "message is required" });
          return;
        }

        const settings = loadCloudSettings();
        const provider = CLOUD_PROVIDER_SET.has(settings.provider)
          ? settings.provider
          : "openai";
        const {
          history = [],
          saveConv,
          convTitle,
          mode = "cloud",
          library,
        } = body;
        const originalMessage = body.message;
        const slashCommand = parseSlashCommand(originalMessage);
        const message = getCommandMessage(slashCommand, originalMessage);
        const messages = normalizeCloudHistoryMessages(history, message);
        const storedMessages = normalizeStoredConversationMessages(
          history,
          originalMessage,
        );
        // Hard-mode override (proofread / translate): bypass policy, library, skills.
        const systemOverride =
          typeof body.systemOverride === "string"
            ? body.systemOverride.trim()
            : "";
        let requestMessages = systemOverride
          ? [{ role: "system", content: systemOverride }, ...messages]
          : withSharedSystemPrompt(messages);
        let librarySourceResults = [];
        let libraryPassages = [];
        let databaseContextEnabled = false;
        let output = "";
        let usage = null;

        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        req.on("close", () => {
          if (!finished) {
            abortController.abort();
          }
        });

        emitSlashCommand(emit, slashCommand);

        // Tracks whether model-callable skills are offered this turn.
        // Stays false in hard-mode (systemOverride), DB-context, and slash commands.
        let cloudSkillsEnabled = false;
        if (!systemOverride) {
          try {
            const libraryContext = await buildChatLibraryContext(
              message,
              getLibraryRequestForCommand(
                library,
                slashCommand,
                history,
                "cloud",
              ),
            );
            if (libraryContext.enabled) {
              databaseContextEnabled = true;
              // Database Context is on for this cloud turn: use the strict
              // library-only prompt instead of the default tool-enabled one.
              requestMessages[0] = {
                role: "system",
                content: getSharedAssistantPolicyPrompt(true),
              };
              requestMessages = insertLibraryContextMessage(
                requestMessages,
                libraryContext.contextMessage,
              );
              librarySourceResults = serializeLibraryResults(
                getLibraryContextSourceResults(libraryContext),
                getLibraryRequestForCommand(library, slashCommand, history),
              );
              libraryPassages = Array.isArray(libraryContext.contextResults)
                ? libraryContext.contextResults
                : [];
              emit({
                type: "library_results",
                results: librarySourceResults,
                passages: libraryPassages,
                meta: libraryContext.contextMeta,
              });
            }
          } catch (e) {
            emit({ type: "library_error", error: e.message });
          }

          // When this mode's Database Context is on, do not offer tools at all —
          // the DB-on prompt answers strictly from the library passages.
          cloudSkillsEnabled = !slashCommand && !databaseContextEnabled;
          if (cloudSkillsEnabled) {
            const skillsPrompt = getCloudSkillsPolicyPrompt({
              agentMode: settings.agentMode === true,
              agentMaxRounds: settings.agentMaxRounds || 25,
            });
            if (skillsPrompt) {
              // Merge into the FIRST system message instead of adding a second
              // one: OpenAI models (gpt-4o) weight the first system message and
              // often ignore later system turns, silently skipping the tools.
              requestMessages = [
                {
                  role: "system",
                  content: `${requestMessages[0].content}\n\n${skillsPrompt}`,
                },
                ...requestMessages.slice(1),
              ];
            }
          }
        }

        let thinking = "";
        let emittedThinkingStart = false;

        if (isSkillSlashCommand(slashCommand)) {
          try {
            const toolCall = buildForcedSkillToolCall(slashCommand);
            emit({
              type: "tool_start",
              toolName: slashCommand.skillName,
              argsPreview: toolCall.function.arguments.slice(0, 300),
            });
            const result = await executeToolCallWithConfirmation(
              toolCall,
              emit,
            );
            appendForcedSkillResult(requestMessages, slashCommand, result);
            emit({
              type: "tool_end",
              toolName: slashCommand.skillName,
              outputPreview: String(result || "").slice(0, 300),
              isError: /^Error:/i.test(String(result || "")),
            });
          } catch (e) {
            emit({ type: "error", error: e.message });
            if (!res.writableEnded) res.end();
            return;
          }
        }

        // Agent mode raises the tool budget; the default suits quick lookups.
        const maxCloudRounds =
          settings.agentMode === true
            ? clampNumber(settings.agentMaxRounds, 1, 50, 25)
            : 6;
        const seenSkillCalls = new Set();
        for (let round = 0; ; round += 1) {
          // Per-round parser state: peel a leading <thought>/<think> reasoning
          // block off this round's content stream and route it to the thinking
          // box; only the answer text flows into `output`.
          let roundRaw = "";
          let roundThoughtLen = 0;
          let roundAnswerLen = 0;
          usage = await streamCloudCompletion({
            provider,
            settings,
            messages: requestMessages,
            // Attach the image only on the first round (the user's turn); later
            // skill-continuation rounds must not re-send it.
            images: round === 0 ? body.images : undefined,
            signal: abortController.signal,
            onDelta: (delta) => {
              roundRaw += delta;
              const split = splitLeadingThought(roundRaw);
              // Stream the reasoning into the collapsed thinking box. While the
              // block is still open, hold back a short tail that might be a
              // partial closing tag so it never leaks into the thinking text.
              let safeThought = split.thought;
              if (split.opened && !split.closed) {
                safeThought = safeThought.slice(
                  0,
                  Math.max(0, safeThought.length - 10),
                );
              }
              if (safeThought.length > roundThoughtLen) {
                const chunk = safeThought.slice(roundThoughtLen);
                roundThoughtLen = safeThought.length;
                if (!emittedThinkingStart) {
                  emittedThinkingStart = true;
                  emit({ type: "thinking_start" });
                }
                thinking += chunk;
                emit({ type: "thinking_delta", delta: chunk, thinking });
              }
              // Forward only the answer text (after </thought>) to the bubble.
              const answerDelta = split.answer.slice(roundAnswerLen);
              roundAnswerLen = split.answer.length;
              if (!answerDelta) return;
              output += answerDelta;
              // Stop streaming visible text once a skill call starts; the
              // call block is excised below and streaming resumes next round.
              if (output.includes("<call:")) return;
              // Send the raw output (including any trailing partial "<call") so the
              // client can hide it and show the animated drum icon, matching Ollama.
              emit({
                type: "delta",
                delta: answerDelta,
                response: output,
              });
            },
            onUsage: (nextUsage) => {
              usage = nextUsage;
            },
          });

          const xmlMatch = cloudSkillsEnabled
            ? output.match(/<call:([^>]+)>(.*?)<\/call>/is)
            : null;
          if (!xmlMatch) break;

          output = output.replace(xmlMatch[0], "").trim();
          if (round >= maxCloudRounds) {
            // End with an answer instead of an error: stop offering tools and
            // tell the model to write its final reply from what it has.
            cloudSkillsEnabled = false;
            requestMessages = [
              ...requestMessages,
              {
                role: "user",
                content:
                  "[TOOL BUDGET EXHAUSTED] You have used every allowed tool call for this request. Do not call any more tools. Write your complete final answer now from everything you already found.",
              },
            ];
            if (!emittedThinkingStart) {
              emittedThinkingStart = true;
              emit({ type: "thinking_start" });
            }
            const note = "\n\n[Tool budget exhausted — writing final answer]\n";
            thinking += note;
            emit({ type: "thinking_delta", delta: note, thinking });
            output = "";
            emit({ type: "delta", delta: "", response: output });
            continue;
          }

          const toolCall = {
            function: {
              name: xmlMatch[1].trim(),
              arguments: xmlMatch[2].trim(),
            },
          };

          if (!emittedThinkingStart) {
            emittedThinkingStart = true;
            emit({ type: "thinking_start" });
          }
          const startMsg = `\n\n[Running tool: ${toolCall.function.name}...]\n`;
          thinking += startMsg;
          emit({ type: "thinking_delta", delta: startMsg, thinking });
          emit({
            type: "tool_start",
            toolName: toolCall.function.name,
            argsPreview: toolCall.function.arguments.slice(0, 300),
          });

          // Loop guard: repeated identical call -> answer from existing results
          // instead of re-running it, preventing runaway tool recursion.
          const callKey = `${toolCall.function.name}:${toolCall.function.arguments
            .replace(/\s+/g, "")
            .toLowerCase()}`;
          let result;
          if (seenSkillCalls.has(callKey)) {
            result = `You already ran ${toolCall.function.name} with these exact arguments and have the results above. Do not repeat this call. Answer the user's question now using what you already found.`;
          } else {
            seenSkillCalls.add(callKey);
            try {
              result = await executeToolCallWithConfirmation(toolCall, emit);
            } catch (toolError) {
              result = `Error: ${toolError.message}`;
            }
          }

          emit({
            type: "tool_end",
            toolName: toolCall.function.name,
            outputPreview: String(result || "").slice(0, 300),
            isError: /^Error:/i.test(String(result || "")),
          });
          const cloudSources = extractSkillSources(
            toolCall.function.name,
            safeParseArgs(toolCall.function.arguments),
            result,
          );
          if (cloudSources.length) {
            librarySourceResults = mergeWebSourceResults(
              librarySourceResults,
              cloudSources,
            );
            emit({ type: "web_sources", sources: cloudSources });
          }
          const endMsg = `[Finished tool: ${toolCall.function.name}]\n`;
          thinking += endMsg;
          emit({ type: "thinking_delta", delta: endMsg, thinking });

          if (output) {
            requestMessages = [
              ...requestMessages,
              { role: "assistant", content: output },
            ];
          }
          requestMessages = [
            ...requestMessages,
            {
              role: "user",
              content: `[SKILL RESULT: ${toolCall.function.name}]\n\n${result}\n\nUsing this skill result, write your complete final answer to the user's question now. Do not repeat this skill call.`,
            },
          ];
          // Reset the accumulated text so the final reply is ONLY what the model
          // writes after seeing the skill result. Otherwise any answer it produced
          // BEFORE calling the skill stays prepended and the reply looks duplicated.
          // Anything interim (plan, notes) belongs in the thinking stream.
          if (output.trim()) {
            if (!emittedThinkingStart) {
              emittedThinkingStart = true;
              emit({ type: "thinking_start" });
            }
            const interim = `\n\n[Interim notes]\n${output.trim()}\n`;
            thinking += interim;
            emit({ type: "thinking_delta", delta: interim, thinking });
          }
          output = "";
          emit({ type: "delta", delta: "", response: output });
        }

        // Final safety net: never let raw skill-call syntax reach the bubble, even
        // if a call was malformed or emitted while skills were disabled (DB on).
        output = stripLeakedSkillCalls(output);
        emit({ type: "delta", delta: "", response: output });

        if (emittedThinkingStart) {
          emit({ type: "thinking_end", thinking });
        }

        finished = true;
        upsertConversation(
          saveConv,
          convTitle,
          originalMessage,
          storedMessages,
          output,
          mode,
          {
            librarySources: librarySourceResults,
            passages: libraryPassages,
            thinking,
            traceEvents,
          },
        );
        emit({
          type: "done",
          response: output,
          thinking,
          usage,
          provider,
          model: settings.models?.[provider] || CLOUD_DEFAULT_MODELS[provider],
        });
        if (!res.writableEnded) res.end();
      } catch (e) {
        const isAbort = e?.name === "AbortError";
        if (!finished) {
          finished = true;
        }
        if (!res.writableEnded) {
          if (!res.headersSent) {
            send(isAbort ? 499 : e.statusCode || 500, {
              error: isAbort ? "Cloud request cancelled." : e.message,
            });
          } else {
            emit({
              type: "error",
              error: isAbort ? "Cloud request cancelled." : e.message,
            });
            res.end();
          }
        }
      }
      return;
    }

    // ---- Local OpenAI-compatible bespoke modes (LM Studio, llama.cpp) ----

    if (req.method === "POST" && urlPath === "/api/lmstudio/stream") {
      await handleLocalModeStream("lmstudio", req, res, send);
      return;
    }
    if (req.method === "POST" && urlPath === "/api/llamacpp/stream") {
      await handleLocalModeStream("llamacpp", req, res, send);
      return;
    }
    if (
      req.method === "GET" &&
      (urlPath === "/api/lmstudio/models" || urlPath === "/api/llamacpp/models")
    ) {
      const modeId = urlPath.includes("lmstudio") ? "lmstudio" : "llamacpp";
      try {
        send(200, await fetchLocalModels(modeId));
      } catch (e) {
        send(e.statusCode || 502, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/chat/stream") {
      let finished = false;
      let upstreamReq = null;
      let upstreamRes = null;
      try {
        const body = await parseJsonBody(req);
        const {
          message: requestMessage,
          model,
          history = [],
          saveConv,
          convTitle,
          mode = "ollama",
          options,
          library,
        } = body;
        const originalMessage = requestMessage;
        const slashCommand = parseSlashCommand(originalMessage);
        const message = getCommandMessage(slashCommand, originalMessage);
        const attachmentImages = normalizeAttachmentImages(body.images);
        const userMessage = { role: "user", content: message };
        if (attachmentImages.length) {
          // Ollama /api/chat takes base64 (no data: prefix) in images[]. Vision
          // models (llava, gemma3, qwen2-vl…) use them; others ignore them.
          userMessage.images = attachmentImages.map((img) => img.dataBase64);
        }
        const messages = [...history, userMessage];
        const storedMessages = [
          ...history,
          { role: "user", content: originalMessage },
        ];
        const safeOptions = sanitizeOllamaOptions(options);

        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        const opts = {
          ...ollamaConn(),
          path: "/api/chat",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        };

        let output = "";
        let thinking = "";
        let emittedThinkingStart = false;
        let librarySourceResults = [];
        let libraryPassages = [];
        const traceEvents = [];
        let transientLibraryContextMessage = null;
        let databasePriorityForLibraryTurn = false;

        const emit = (event) => {
          const storedEvent = sanitizeTraceEventForStorage(event);
          if (storedEvent) traceEvents.push(storedEvent);
          if (!res.writableEnded) {
            res.write(JSON.stringify(event) + "\n");
          }
        };

        emitSlashCommand(emit, slashCommand);

        try {
          const libraryContext = await buildChatLibraryContext(
            message,
            getLibraryRequestForCommand(
              library,
              slashCommand,
              history,
              "ollama",
            ),
          );
          if (libraryContext.enabled) {
            if (libraryContext.contextMessage) {
              transientLibraryContextMessage = libraryContext.contextMessage;
              const firstNonSystemIndex = messages.findIndex(
                (item) => item.role !== "system",
              );
              if (firstNonSystemIndex === -1) {
                messages.push(transientLibraryContextMessage);
              } else {
                messages.splice(
                  firstNonSystemIndex,
                  0,
                  transientLibraryContextMessage,
                );
              }
            }
            librarySourceResults = serializeLibraryResults(
              getLibraryContextSourceResults(libraryContext),
              getLibraryRequestForCommand(library, slashCommand, history),
            );
            libraryPassages = Array.isArray(libraryContext.contextResults)
              ? libraryContext.contextResults
              : [];
            databasePriorityForLibraryTurn =
              !slashCommand && librarySourceResults.length > 0;
            emit({
              type: "library_results",
              results: librarySourceResults,
              meta: libraryContext.contextMeta,
              passages: libraryPassages,
            });
          }
        } catch (e) {
          emit({ type: "library_error", error: e.message });
        }

        if (isSkillSlashCommand(slashCommand)) {
          try {
            const toolCall = buildForcedSkillToolCall(slashCommand);
            if (!emittedThinkingStart) {
              emittedThinkingStart = true;
              emit({ type: "thinking_start" });
            }
            emit({
              type: "tool_start",
              toolName: slashCommand.skillName,
              argsPreview: toolCall.function.arguments.slice(0, 300),
            });
            const result = await executeToolCallWithConfirmation(
              toolCall,
              emit,
            );
            appendForcedSkillResult(messages, slashCommand, result);
            emit({
              type: "tool_end",
              toolName: slashCommand.skillName,
              outputPreview: String(result || "").slice(0, 300),
              isError: /^Error:/i.test(String(result || "")),
            });
          } catch (e) {
            emit({ type: "error", error: e.message });
            if (!res.writableEnded) res.end();
            return;
          }
        }

        // Agent mode (client-driven for Ollama: the skills prompt is built by
        // the client) raises the tool budget; without it the legacy cap holds.
        const maxOllamaDepth =
          body.agentMode === true
            ? clampNumber(body.agentMaxRounds, 1, 50, 25)
            : 10;
        let budgetExhausted = false;
        const startStream = (depth = 0) => {
          if (depth > maxOllamaDepth && !budgetExhausted) {
            // End with an answer instead of an error: stop accepting tool calls
            // and tell the model to write its final reply from what it has.
            budgetExhausted = true;
            messages.push({
              role: "user",
              content:
                "[TOOL BUDGET EXHAUSTED] You have used every allowed tool call for this request. Do not call any more tools. Write your complete final answer now from everything you already found.",
            });
            if (!emittedThinkingStart) {
              emittedThinkingStart = true;
              emit({ type: "thinking_start" });
            }
            const note = "\n\n[Tool budget exhausted — writing final answer]\n";
            thinking += note;
            emit({ type: "thinking_delta", delta: note, thinking });
          }
          const payloadObject = {
            model,
            messages: sanitizeModelMessages(messages),
            stream: true,
          };
          if (safeOptions) payloadObject.options = safeOptions;

          if (
            !isDatabaseSlashCommand(slashCommand) &&
            !databasePriorityForLibraryTurn
          ) {
            // Native tool calling (OpenAI schema): when enabled, send skills +
            // custom skills + MCP as structured function schemas so tool-trained
            // models (Gemma, Qwen, Llama 3) can call them directly. The parse /
            // execute loop below already handles the resulting `tool_calls`
            // (that is how MCP tools already worked). The client-built XML skill
            // prompt stays in the messages as a fallback for models that ignore
            // `tools`. When disabled, only MCP tools are offered natively (legacy
            // behaviour) and skills go through the XML prompt.
            const nativeTools =
              body.nativeTools !== false
                ? getLocalNativeTools()
                : getMcpOllamaTools();
            if (nativeTools.length > 0) {
              payloadObject.tools = nativeTools;
            }
          }

          const payload = JSON.stringify(payloadObject);

          let lineBuffer = "";
          let promptEvalCount = 0;
          let evalCount = 0;
          let outputToolCalls = [];

          upstreamReq = http.request(opts, (ollamaRes) => {
            upstreamRes = ollamaRes;
            ollamaRes.on("data", (chunk) => {
              lineBuffer += chunk.toString();
              const lines = lineBuffer.split("\n");
              lineBuffer = lines.pop() || "";

              for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;
                let evt;
                try {
                  evt = JSON.parse(line);
                } catch (_e) {
                  continue;
                }

                const msg = evt?.message || {};

                if (msg.tool_calls) {
                  outputToolCalls = msg.tool_calls;
                }

                const thinkingDelta =
                  typeof msg.thinking === "string" ? msg.thinking : "";
                if (thinkingDelta) {
                  if (!emittedThinkingStart) {
                    emittedThinkingStart = true;
                    emit({ type: "thinking_start" });
                  }
                  thinking += thinkingDelta;
                  emit({
                    type: "thinking_delta",
                    delta: thinkingDelta,
                    thinking,
                  });
                }

                const delta =
                  typeof msg.content === "string" ? msg.content : "";
                if (delta) {
                  output += delta;
                  if (!output.includes("<call:")) {
                    emit({ type: "delta", delta, response: output });
                  }
                }

                if (evt.done === true) {
                  const xmlMatch = output.match(
                    /<call:([^>]+)>(.*?)<\/call>/is,
                  );
                  if (databasePriorityForLibraryTurn && xmlMatch) {
                    output = "";
                    outputToolCalls = [];
                    messages.push({
                      role: "user",
                      content:
                        "Database Context returned local library passages for this turn. Do not call tools. Answer the user's original question using the provided database passages. If the passages contain multiple accounts, causes, or origin details, explain each relevant distinction clearly.",
                    });
                    startStream(depth + 1);
                    return;
                  }
                  if (xmlMatch) {
                    output = output.replace(xmlMatch[0], "").trim();
                    if (!budgetExhausted) {
                      outputToolCalls.push({
                        function: {
                          name: xmlMatch[1].trim(),
                          arguments: xmlMatch[2].trim(),
                        },
                      });
                    }
                  }
                  if (slashCommand || budgetExhausted) {
                    outputToolCalls = [];
                  }

                  if (outputToolCalls.length > 0) {
                    messages.push({ role: "assistant", content: output });
                    // Text written before a tool call is interim (plan, notes)
                    // — move it to the thinking stream and clear the bubble so
                    // it never prefixes the final answer.
                    if (output.trim()) {
                      if (!emittedThinkingStart) {
                        emittedThinkingStart = true;
                        emit({ type: "thinking_start" });
                      }
                      const interim = `\n\n[Interim notes]\n${output.trim()}\n`;
                      thinking += interim;
                      emit({
                        type: "thinking_delta",
                        delta: interim,
                        thinking,
                      });
                    }
                    output = "";
                    emit({ type: "delta", delta: "", response: output });
                    (async () => {
                      for (const tc of outputToolCalls) {
                        if (!emittedThinkingStart) {
                          emittedThinkingStart = true;
                          emit({ type: "thinking_start" });
                        }
                        const startMsg = `\n\n[Running tool: ${tc.function.name}...]\n`;
                        thinking += startMsg;
                        emit({
                          type: "thinking_delta",
                          delta: startMsg,
                          thinking,
                        });
                        // Ollama native tool_calls carry arguments as an object;
                        // the XML path pushes a string. Preview either shape.
                        const argsPreview = (
                          typeof tc.function.arguments === "string"
                            ? tc.function.arguments
                            : JSON.stringify(tc.function.arguments || {})
                        ).slice(0, 300);
                        emit({
                          type: "tool_start",
                          toolName: tc.function.name,
                          argsPreview,
                        });

                        let result;
                        try {
                          result = await executeToolCallWithConfirmation(
                            tc,
                            emit,
                          );
                        } catch (toolError) {
                          result = `Error: ${toolError.message}`;
                        }
                        emit({
                          type: "tool_end",
                          toolName: tc.function.name,
                          outputPreview: String(result || "").slice(0, 300),
                          isError: /^Error:/i.test(String(result || "")),
                        });

                        const ollamaSources = extractSkillSources(
                          tc.function.name,
                          safeParseArgs(tc.function.arguments),
                          result,
                        );
                        if (ollamaSources.length) {
                          librarySourceResults = mergeWebSourceResults(
                            librarySourceResults,
                            ollamaSources,
                          );
                          emit({ type: "web_sources", sources: ollamaSources });
                        }

                        messages.push({
                          role: "user",
                          content: `[SKILL RESULT: ${tc.function.name}]\n\n${result}\n\nPlease continue your response based on this result.`,
                        });

                        const endMsg = `[Finished tool: ${tc.function.name}]\n`;
                        thinking += endMsg;
                        emit({
                          type: "thinking_delta",
                          delta: endMsg,
                          thinking,
                        });
                      }
                      startStream(depth + 1);
                    })();
                    return;
                  }

                  promptEvalCount =
                    typeof evt.prompt_eval_count === "number"
                      ? evt.prompt_eval_count
                      : 0;
                  evalCount =
                    typeof evt.eval_count === "number" ? evt.eval_count : 0;
                  if (emittedThinkingStart) {
                    emit({ type: "thinking_end", thinking });
                  }

                  if (finished) return;
                  finished = true;
                  upsertConversation(
                    saveConv,
                    convTitle,
                    originalMessage,
                    storedMessages,
                    output,
                    mode,
                    {
                      librarySources: librarySourceResults,
                      passages: libraryPassages,
                      thinking,
                      traceEvents,
                    },
                  );
                  emit({
                    type: "done",
                    response: output,
                    thinking,
                    promptTokens: promptEvalCount,
                    evalTokens: evalCount,
                  });
                  if (!res.writableEnded) res.end();
                }
              }
            });

            ollamaRes.on("end", () => {
              if (!finished && outputToolCalls.length === 0) {
                finished = true;
                upsertConversation(
                  saveConv,
                  convTitle,
                  originalMessage,
                  storedMessages,
                  output,
                  mode,
                  {
                    librarySources: librarySourceResults,
                    passages: libraryPassages,
                    thinking,
                    traceEvents,
                  },
                );
                emit({ type: "done", response: output, thinking });
                if (!res.writableEnded) res.end();
              }
            });

            ollamaRes.on("error", (e) => {
              if (!finished) {
                finished = true;
                emit({ type: "error", error: e.message });
                if (!res.writableEnded) res.end();
              }
            });
          });

          upstreamReq.on("error", (e) => {
            if (!finished) {
              finished = true;
              emit({ type: "error", error: e.message });
              if (!res.writableEnded) res.end();
            }
          });

          upstreamReq.write(payload);
          upstreamReq.end();
        };

        startStream(0);

        req.on("close", () => {
          if (!finished) {
            if (upstreamReq) upstreamReq.destroy();
            if (upstreamRes) upstreamRes.destroy();
          }
        });
      } catch (e) {
        if (!res.writableEnded) {
          if (!res.headersSent) {
            send(e.statusCode || 500, { error: e.message });
          } else {
            res.write(
              JSON.stringify({ type: "error", error: e.message }) + "\n",
            );
            res.end();
          }
        }
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/chat") {
      let finished = false;
      let cancel = null;
      try {
        const body = await parseJsonBody(req);
        const {
          message,
          model,
          history = [],
          saveConv,
          convTitle,
          mode = "ollama",
          options,
        } = body;
        const messages = [...history, { role: "user", content: message }];
        const safeOptions = sanitizeOllamaOptions(options);

        let { promise, abort } = ollamaChat(model, messages, safeOptions);
        cancel = abort;

        req.on("close", () => {
          if (!finished) {
            console.log(
              "Client aborted request. Aborting Ollama API request...",
            );
            cancel();
          }
        });

        let messageObj = await promise;

        if (messageObj && typeof messageObj.content === "string") {
          const xmlMatch = messageObj.content.match(
            /<call:([^>]+)>(.*?)<\/call>/is,
          );
          if (xmlMatch) {
            if (!messageObj.tool_calls) messageObj.tool_calls = [];
            messageObj.tool_calls.push({
              function: {
                name: xmlMatch[1].trim(),
                arguments: xmlMatch[2].trim(),
              },
            });
            messageObj.content = messageObj.content
              .replace(xmlMatch[0], "")
              .trim();
          }
        }

        if (
          messageObj &&
          messageObj.tool_calls &&
          messageObj.tool_calls.length > 0
        ) {
          messages.push(messageObj);
          for (const toolCall of messageObj.tool_calls) {
            let result;
            let disabledSkillError = "";
            try {
              assertBuiltinSkillEnabled(toolCall.function.name);
            } catch (error) {
              disabledSkillError = error.message;
            }
            if (disabledSkillError) {
              result = `Error: ${disabledSkillError}`;
            } else if (
              skillRequiresShellConfirmation(toolCall.function.name, DATA_DIR)
            ) {
              appendSecurityEvent("shell_command_denied_non_stream", {
                command: toolCall.function.arguments,
                tool: toolCall.function.name,
              });
              result =
                "Error: shell command execution requires interactive confirmation, which is not supported in the non-streaming API.";
            } else if (toolCall.function.name.startsWith("mcp__")) {
              result = await executeMcpTool(toolCall);
            } else {
              result = await executeSkill(toolCall, {
                dataDir: DATA_DIR,
                cloudKeys: getCloudSearchKeys(),
              });
            }
            messages.push({
              role: "tool",
              content: result,
            });
          }

          const secondCall = ollamaChat(model, messages, safeOptions);
          cancel = secondCall.abort;
          messageObj = await secondCall.promise;
        }

        const response = messageObj ? messageObj.content || "" : "";
        finished = true;

        upsertConversation(
          saveConv,
          convTitle,
          message,
          messages,
          response,
          mode,
        );
        send(200, { response });
      } catch (e) {
        if (req.destroyed) {
          console.log(
            "Request was destroyed (aborted). Skipping error response.",
          );
        } else {
          send(e.statusCode || 500, { error: e.message });
        }
      }
      return;
    }

    return false;
  }

  const CHAT_PATHS = new Set([
    "/api/models",
    "/api/ollama/tool-respond",
    "/api/cloud/chat/stream",
    "/api/lmstudio/stream",
    "/api/llamacpp/stream",
    "/api/lmstudio/models",
    "/api/llamacpp/models",
    "/api/chat/stream",
    "/api/chat",
  ]);

  async function handleRequest(ctx) {
    if (
      !CHAT_PATHS.has(ctx.urlPath) &&
      !ctx.urlPath.startsWith("/api/models/info")
    ) {
      return false;
    }
    await dispatch(ctx);
    return true;
  }

  return { handleRequest };
};

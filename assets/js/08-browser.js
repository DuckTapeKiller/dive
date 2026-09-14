// The agent browser panel: a window onto the page the model is driving.
//
// This panel is the reason the browser lives inside Dive rather than behind an
// MCP server. A headless tool that clicks things on your behalf is something
// you have to trust blind; one you can watch is something you can stop. So the
// panel shows the live page, which session it belongs to, and how many requests
// the network guard has refused.
//
// It is also a browser you can drive. The agent steers through browse_read and
// browse_act, and browse_act is gated because a page is untrusted input; none
// of that applies to the person at the keyboard, whose typed URL is the trusted
// instruction rather than the thing being guarded against. Taking over at a
// cookie wall or a login the agent cannot pass is the reason for having the
// browser in the app instead of behind a headless tool.
//
// Polling, not streaming: a screenshot is a whole PNG and the page only matters
// while somebody is looking at it, so the timer runs only while the panel is
// open and the tab is visible.

let browserPanelOpen = false;
let browserPollTimer = null;
let browserActiveSession = "";
let browserSessionsCache = [];
let browserEngineReady = true;
let browserStream = null;
let browserStreamSession = "";
let browserStreamLive = false;
// An error the user has not had time to read must not be overwritten by the
// next poll. A failed action used to be replaced by "No page open." within a
// second, so the action looked like it had simply done nothing.
let browserStatusHoldUntil = 0;
let browserShowingExtensionUi = false;
// The dimensions the current stream was started with. Frames arrive at that
// size, so when the panel stops being that size the stream has to be reopened.
let browserStreamSize = { width: 0, height: 0 };
// The uBlock tool the status line last described, so each is explained once.
let browserToolShown = "";
// What each uBlock tool does, said when it starts. The zapper and the picker
// look the same on the page and do different things.
const BROWSER_TOOL_HINTS = {
  picker:
    "Create a custom filter: move over the page to highlight, click to select, then Create. The filter is saved and survives a restart.",
  zapper:
    "Remove an element: click something to remove it. Dive saves it as a custom filter, so it stays gone after a reload or a restart.",
  unpicker:
    "Remove a custom filter: choose a filter in the list to highlight what it hides, then click the trash can to remove it.",
};

const BROWSER_POLL_MS = 1200;
// Wheel ticks arrive far faster than any round trip, so they are batched — but
// only just enough to coalesce one gesture. This was 90ms, chosen when a scroll
// cost ~275ms and the debounce hardly mattered; now that it does, it is the
// smallest delay that still avoids one request per notch.
const BROWSER_SCROLL_DEBOUNCE_MS = 30;

function getBrowserElements() {
  return {
    panel: document.getElementById("browserPanel"),
    resizer: document.getElementById("browserResizer"),
    viewport: document.getElementById("browserViewport"),
    address: document.getElementById("browserAddress"),
    takeover: document.getElementById("browserTakeover"),
    status: document.getElementById("browserStatus"),
    tabs: document.getElementById("browserTabs"),
    view: document.getElementById("browserView"),
    uiLayer: document.getElementById("browserUiLayer"),
    uiView: document.getElementById("browserUiView"),
    empty: document.getElementById("browserEmpty"),
    url: document.getElementById("browserUrl"),
  };
}

// Called by the other panels when they open. They share the same width, so two
// open at once would fight over it.
function closeBrowserPanel() {
  if (browserPanelOpen) toggleBrowserPanel();
}

function stopBrowserPolling() {
  if (browserPollTimer) {
    clearInterval(browserPollTimer);
    browserPollTimer = null;
  }
}

function startBrowserPolling() {
  stopBrowserPolling();
  browserPollTimer = window.setInterval(() => {
    if (!browserPanelOpen) return;
    // A hidden window still fires timers, and a screenshot nobody can see costs
    // a full page capture in the server process every tick — so the CAPTURE is
    // skipped while hidden, not the poll. Skipping both left the panel showing
    // "No page open" for a session that was open and running, which is worse
    // than the cost it saved.
    refreshBrowserPanel({ capture: !document.hidden });
  }, BROWSER_POLL_MS);
}

function toggleBrowserPanel() {
  browserPanelOpen = !browserPanelOpen;
  const { panel, resizer } = getBrowserElements();
  if (!panel) return;
  if (browserPanelOpen) {
    if (typeof historyOpen !== "undefined" && historyOpen) toggleHistory();
    if (typeof notesOpen !== "undefined" && notesOpen) toggleNotes();
    if (typeof settingsOpen !== "undefined" && settingsOpen) toggleSettings();
    panel.classList.add("open");
    if (resizer) resizer.style.display = "block";
    refreshBrowserPanel();
    startBrowserPolling();
  } else {
    panel.classList.remove("open");
    if (resizer) resizer.style.display = "none";
    stopBrowserPolling();
    // A stream nobody is watching still makes the agent's browser encode every
    // paint, so it ends with the panel.
    stopBrowserStream();
    stopBrowserUiLayer();
  }
}

function renderBrowserTabs() {
  const { tabs } = getBrowserElements();
  if (!tabs) return;
  tabs.textContent = "";
  if (!browserSessionsCache.length) return;
  browserSessionsCache.forEach((session) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className =
      "browser-tab" + (session.name === browserActiveSession ? " active" : "");
    const label = document.createElement("span");
    label.className = "browser-tab-name";
    label.textContent = session.name;
    tab.appendChild(label);
    // The guard's tally, surfaced rather than buried in a log: a page trying
    // repeatedly to reach a local address is worth seeing.
    if (session.blocked > 0) {
      const blocked = document.createElement("span");
      blocked.className = "browser-tab-blocked";
      blocked.textContent = String(session.blocked);
      blocked.title = `${session.blocked} request(s) refused by the network guard`;
      tab.appendChild(blocked);
    }
    const close = document.createElement("span");
    close.className = "browser-tab-close";
    close.textContent = "✕";
    close.title = `End the "${session.name}" session`;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      endBrowserSession(session.name);
    });
    tab.appendChild(close);
    tab.addEventListener("click", () => {
      browserActiveSession = session.name;
      refreshBrowserPanel();
    });
    tabs.appendChild(tab);
  });
}

// ---- The live stream ----
//
// Frames arrive when the page paints, pushed over SSE, instead of being asked
// for on a timer. Polling could not do better than about six frames a second —
// capture, encode, transfer, decode, repeat — and it kept working when the page
// was perfectly still.
//
// The polled screenshot stays as the fallback: if the stream cannot open, or
// drops and does not come back, the panel keeps showing a page rather than
// going blank.

function stopBrowserStream() {
  if (browserStream) {
    browserStream.close();
    browserStream = null;
  }
  browserStreamSession = "";
  browserStreamLive = false;
  browserStreamSize = { width: 0, height: 0 };
}

// Has the panel stopped being the size the stream is drawing for?
//
// The ResizeObserver below is the quick path, but it cannot be the only one: a
// hidden window runs no rendering steps, so its callbacks never fire, and the
// panel would sit on frames at the wrong aspect until something else disturbed
// it. This runs off the poll instead, which does not care about rendering.
function browserStreamSizeStale() {
  if (!browserStreamSession) return false;
  const { viewport } = getBrowserElements();
  const width = Math.round(viewport?.clientWidth || 0);
  const height = Math.round(viewport?.clientHeight || 0);
  if (!width || !height) return false;
  return (
    Math.abs(width - browserStreamSize.width) > 8 ||
    Math.abs(height - browserStreamSize.height) > 8
  );
}

function startBrowserStream(sessionName) {
  const { viewport } = getBrowserElements();
  if (!sessionName) return stopBrowserStream();
  const width = Math.round(viewport?.clientWidth || 0);
  const height = Math.round(viewport?.clientHeight || 0);
  if (!width || !height) return;
  stopBrowserStream();
  browserStreamSession = sessionName;
  browserStreamSize = { width, height };
  const url = apiUrl(
    `/api/browser/stream?session=${encodeURIComponent(sessionName)}&w=${width}&h=${height}`,
  );
  let stream;
  try {
    stream = new EventSource(url);
  } catch (error) {
    console.error("Could not open the browser stream", error);
    return;
  }
  browserStream = stream;
  stream.addEventListener("ready", () => {
    browserStreamLive = true;
  });
  stream.addEventListener("error", (event) => {
    // EventSource reconnects by itself; what must not happen is the panel
    // sitting on a frozen frame while believing it is live.
    if (stream.readyState === EventSource.CLOSED) browserStreamLive = false;
    if (event?.data) console.warn("Browser stream:", event.data);
  });
  stream.onmessage = (event) => {
    if (!event.data) return;
    const { view, empty } = getBrowserElements();
    if (!view) return;
    browserStreamLive = true;
    view.style.display = "block";
    view.src = `data:image/jpeg;base64,${event.data}`;
    if (empty) empty.style.display = "none";
  };
}

// ---- The extension panel, floating over the page ----
//
// Drawn on top rather than in place of the page. Replacing the page was the
// mistake: the popup exists to pick something OFF the page, and swapping the
// view meant the moment you opened it there was nothing left to pick from.
//
// It is polled rather than streamed. A popup does not animate, so a couple of
// frames a second is plenty, and a second screencast would cost far more than
// the panel is worth.
let browserUiTimer = null;

function stopBrowserUiLayer() {
  if (browserUiTimer) {
    clearInterval(browserUiTimer);
    browserUiTimer = null;
  }
  const { uiLayer, uiView } = getBrowserElements();
  if (uiLayer) uiLayer.hidden = true;
  // With the panel gone there is only the page to type into.
  browserKeyTarget = "page";
  // Cleared as well as hidden: a src left on a hidden element is still a
  // broken image waiting to reappear the moment anything unhides the layer.
  if (uiView) uiView.removeAttribute("src");
}

function refreshBrowserUiLayer() {
  const { uiLayer, uiView } = getBrowserElements();
  if (!uiLayer || !uiView || !browserActiveSession) return;
  // Decoded off-screen first, then swapped in. Assigning straight to the live
  // element leaves it at zero size while the new frame loads, and a click in
  // that gap has nothing to map against.
  //
  // The layer is revealed ONLY once a frame has actually arrived. Showing it
  // first meant that when the request 404'd — no panel open — the <img> sat
  // there as a broken-image placeholder with its alt text, permanently parked
  // in the corner of the page.
  const next = new Image();
  next.onload = () => {
    uiView.src = next.src;
    browserSurfaceSizes.set(uiView, {
      width: next.naturalWidth,
      height: next.naturalHeight,
    });
    uiLayer.hidden = false;
  };
  next.onerror = () => {
    // Nothing to show: there is no extension panel open any more.
    stopBrowserUiLayer();
  };
  next.src = apiUrl(
    `/api/browser/uiview?session=${encodeURIComponent(browserActiveSession)}&t=${Date.now()}`,
  );
}

function startBrowserUiLayer() {
  if (browserUiTimer) return;
  refreshBrowserUiLayer();
  browserUiTimer = window.setInterval(() => {
    if (!browserPanelOpen || document.hidden) return;
    refreshBrowserUiLayer();
  }, 500);
}

// The screenshot is fetched with a cache-buster because the URL is stable while
// the page behind it is not; without it the panel would show the first capture
// forever.
function refreshBrowserView() {
  const { view, empty, url, viewport } = getBrowserElements();
  if (!view || !empty || !url) return;
  const session = browserSessionsCache.find(
    (s) => s.name === browserActiveSession,
  );
  if (!session) {
    stopBrowserStream();
    view.style.display = "none";
    view.removeAttribute("src");
    empty.style.display = "";
    url.textContent = "";
    return;
  }
  empty.style.display = "none";
  // Explicitly "block", not "": the stylesheet hides this element by default so
  // an empty panel never flashes a broken-image placeholder, and clearing the
  // inline style would simply hand it back to that rule.
  view.style.display = "block";
  // The stream owns the picture while it is live; asking for a screenshot on
  // top of it would be the polling this replaced, running underneath it.
  if (browserStreamSession !== session.name) startBrowserStream(session.name);
  if (browserStreamLive) {
    url.textContent = session.url || "(blank page)";
    url.title = session.url || "";
    const bar = document.getElementById("browserAddress");
    if (bar && document.activeElement !== bar) bar.value = session.url || "";
    return;
  }
  // The panel's own size goes with the request, so the page is rendered at the
  // size it will be shown at. Sent as CSS pixels: the capture comes back at the
  // same number of pixels, so the image displays 1:1 rather than as a small
  // letterboxed strip scaled down from a fixed 1280x800.
  const width = Math.round(viewport?.clientWidth || 0);
  const height = Math.round(viewport?.clientHeight || 0);
  const size = width && height ? `&w=${width}&h=${height}` : "";
  view.src = apiUrl(
    `/api/browser/view?session=${encodeURIComponent(session.name)}${size}&t=${Date.now()}`,
  );
  url.textContent = session.url || "(blank page)";
  url.title = session.url || "";
  const address = document.getElementById("browserAddress");
  if (address && document.activeElement !== address) {
    address.value = session.url || "";
  }
}

// The panel that the user's own actions target. Their session when they have
// one, otherwise whichever the agent has open — so clicking Go with the agent's
// page in front of you drives that page, which is what it looks like it does.
function activeBrowserSessionName() {
  return browserActiveSession || "user";
}

// `light` skips the full session re-poll and just re-captures. Scrolling fires
// constantly; refetching the session list on every wheel tick would put a
// needless request behind each one.
async function browserUserRequest(
  path,
  payload,
  label,
  { light = false, quiet = false } = {},
) {
  try {
    const result = await postJson(
      path,
      { session: activeBrowserSessionName(), ...payload },
      label,
    );
    // A response carrying its own frame has already done the work a refresh
    // would repeat: show it directly.
    if (quiet) return result;
    if (result?.frame) {
      const { view, empty, url } = getBrowserElements();
      if (view) {
        view.style.display = "block";
        view.src = result.frame;
      }
      if (empty) empty.style.display = "none";
      if (url && result.url) url.textContent = result.url;
    } else if (light) {
      refreshBrowserView();
    } else {
      await refreshBrowserPanel();
    }
    return result;
  } catch (error) {
    setBrowserStatus(String(error.message || error).slice(0, 200), true);
    return null;
  }
}

// `hold` keeps a message on screen for a few seconds against the poll that
// would otherwise replace it.
function setBrowserStatus(text, warn = false, hold = warn ? 6000 : 0) {
  const { status } = getBrowserElements();
  if (!status) return;
  status.textContent = text;
  status.className = warn ? "browser-status warn" : "browser-status";
  browserStatusHoldUntil = hold ? Date.now() + hold : 0;
}

function navigateBrowserToAddress() {
  const { address } = getBrowserElements();
  const url = String(address?.value || "").trim();
  if (!url) return;
  // A session the user opens is theirs by default, so their browsing does not
  // land in the middle of whatever the agent is doing.
  if (!browserActiveSession) browserActiveSession = "user";
  browserUserRequest("/api/browser/navigate", { url }, "Browser navigate");
}

// Click-through. The capture is taken at the page's own viewport size, so the
// image's natural pixels ARE page pixels — but the element may be laid out at a
// different size for a moment after a resize, so the ratio is applied rather
// than assumed.
// Where a pointer event landed, in the coordinates of whichever surface it was
// over. The extension panel sits on top, so it is checked first.
// Where a pointer event landed, in the coordinates of the PAGE.
//
// The subtle part is object-fit. Both images are drawn with `contain`, so the
// picture is scaled to FIT its element and does not fill it: the moment the
// frame's aspect differs from the element's — every navigation, every resize,
// and continuously on a heavy page while the stream catches up — there is a
// band of empty element beside or below the picture.
//
// Dividing by the ELEMENT's width, as this did, therefore mapped the pointer to
// the wrong place, and got worse the more the two aspects diverged. Pointing at
// something and having uBlock highlight something else — or nothing — is that
// bug, not a fault in the extension.
//
// With `object-position: top left` the picture is anchored at the element's
// top-left, so the only correction needed is the scale; a point outside the
// drawn picture is not over the page at all and is rejected.
// The last size each surface was known to be. An <img> whose src is being
// replaced reports naturalWidth 0 until the new frame decodes, and the extension
// panel is re-fetched twice a second — so a click landing in that window was
// mapped to nothing and silently dropped. That is what made the popup's options
// feel dead: they worked, but roughly every other press went nowhere.
const browserSurfaceSizes = new WeakMap();

function mapToSurface(img, event, target) {
  const rect = img.getBoundingClientRect();
  const last = browserSurfaceSizes.get(img);
  const naturalWidth = img.naturalWidth || last?.width || 0;
  const naturalHeight = img.naturalHeight || last?.height || 0;
  if (img.naturalWidth && img.naturalHeight) {
    browserSurfaceSizes.set(img, {
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  }
  if (!rect.width || !rect.height || !naturalWidth || !naturalHeight) {
    return null;
  }
  const scale = Math.min(
    rect.width / naturalWidth,
    rect.height / naturalHeight,
  );
  if (!scale) return null;
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  // Outside the drawn picture: the empty band, not the page.
  if (
    offsetX < 0 ||
    offsetY < 0 ||
    offsetX > naturalWidth * scale ||
    offsetY > naturalHeight * scale
  ) {
    return null;
  }
  return {
    target,
    x: Math.round(offsetX / scale),
    y: Math.round(offsetY / scale),
  };
}

function browserPointFor(event) {
  const { view, uiView, uiLayer } = getBrowserElements();
  // The extension panel sits on top, so it is asked first.
  if (uiView && uiLayer && !uiLayer.hidden) {
    const point = mapToSurface(uiView, event, "ui");
    if (point) return point;
  }
  if (!view) return null;
  return mapToSurface(view, event, "page");
}

function browserViewClicked(event) {
  const { takeover } = getBrowserElements();
  // A drag ends with a click event too. That one selected text; letting it
  // through would also follow whatever link the drag started on.
  if (browserDragged) {
    browserDragged = false;
    return;
  }
  const point = browserPointFor(event);
  if (!point) return;
  // Typing follows the click: into the extension's panel after clicking it,
  // into the page after clicking the page.
  browserKeyTarget = point.target;
  // The extension panel is Dive's own control surface and is always clickable;
  // clicking INTO the page is what take-over gates.
  if (point.target === "page" && !takeover?.checked) return;
  // A click into the browser takes the typing with it. Focus used to stay in
  // Dive's address bar, which keeps its keys, so text meant for uBlock's filter
  // editor went into the address bar instead.
  if (isDiveTextField(document.activeElement)) document.activeElement.blur();
  browserUserRequest(
    "/api/browser/interact",
    { type: "click", ...point },
    "Browser click",
  );
}

// Scrolling is how you read a page, so it is not behind the take-over toggle —
// it changes nothing but which part of the document is visible. Wheel events
// arrive far faster than a screenshot round trip, so deltas are accumulated and
// flushed on a timer instead of one request per tick.
let browserScrollPending = 0;
let browserScrollTimer = null;
// Where the wheel turned, so the scroll reaches the surface under it. Every
// scroll used to go to the page, so an extension's settings drawn over it could
// not be scrolled at all.
let browserScrollPoint = null;

function browserViewScrolled(event) {
  if (!browserPanelOpen || !browserActiveSession) return;
  event.preventDefault();
  browserScrollPending += event.deltaY;
  browserScrollPoint = browserPointFor(event) || browserScrollPoint;
  if (browserScrollTimer) return;
  browserScrollTimer = window.setTimeout(() => {
    const deltaY = Math.round(browserScrollPending);
    const point = browserScrollPoint;
    browserScrollPending = 0;
    browserScrollPoint = null;
    browserScrollTimer = null;
    if (!deltaY) return;
    const { viewport } = getBrowserElements();
    browserUserRequest(
      "/api/browser/interact",
      {
        type: "scroll",
        deltaY,
        ...point,
        // Only ask for a frame back when nothing is streaming one. With the
        // stream live the paint arrives on its own, and requesting a capture
        // here would encode the same frame a second time.
        ...(browserStreamLive
          ? {}
          : {
              w: Math.round(viewport?.clientWidth || 0),
              h: Math.round(viewport?.clientHeight || 0),
            }),
      },
      "Browser scroll",
      { light: true },
    );
  }, BROWSER_SCROLL_DEBOUNCE_MS);
}

// Pointer movement, forwarded while taking over.
//
// A click is not enough for everything: uBlock's element picker highlights the
// element under the cursor and only commits when you click it. With no movement
// forwarded you could open the picker and never aim it — which is the whole
// point of the picker.
//
// Throttled to roughly 30/s: mousemove fires far faster than a round trip, and
// the frames it causes come back over the stream anyway.
let browserMoveAt = 0;
let browserMovePending = null;
let browserMoveTimer = null;

function sendBrowserMove(point) {
  browserMoveAt = Date.now();
  browserMovePending = null;
  browserUserRequest(
    "/api/browser/interact",
    { type: "move", ...point },
    "Browser move",
    { light: true, quiet: true },
  );
}

function browserViewMoved(event) {
  const { takeover } = getBrowserElements();
  if (!browserActiveSession) return;
  const point = browserPointFor(event);
  if (!point) return;
  if (point.target === "page" && !takeover?.checked) return;
  if (Date.now() - browserMoveAt < 33) {
    // The position where the cursor came to rest matters more than any it
    // passed through: the picker highlights wherever the pointer ENDED, so a
    // dropped final move leaves it aimed at whatever it saw last.
    browserMovePending = point;
    if (!browserMoveTimer) {
      browserMoveTimer = window.setTimeout(() => {
        browserMoveTimer = null;
        if (browserMovePending) sendBrowserMove(browserMovePending);
      }, 40);
    }
    return;
  }
  sendBrowserMove(point);
}

// ---- Selecting text ----
//
// The panel is a picture of the page, so the browser's own selection has
// nothing to grab: the text is in Chromium, in another process. A drag across
// the picture is sent over as a selection, and the text comes back with the
// response — a selection sitting in Chromium is no use to the person reading
// it here.
//
// Not behind TAKE OVER. Selecting is reading, and the server sets the selection
// from caret positions rather than dragging a real mouse, so it cannot click,
// drag or drop anything on the way.
// A hand's click moves a few pixels between press and release. At 4px a 5px
// wobble counted as a text-selection drag, and the click never reached the
// page: "Create a custom filter" in uBlock's popup did nothing at all.
const BROWSER_DRAG_THRESHOLD_PX = 12;
let browserDragStart = null;
let browserDragged = false;

// The frame a selection produces, requested with it. The screencast sends only
// what the compositor repaints, and a selection change did not reliably count:
// the text was selected and copied while the panel showed no highlight, which
// reads as nothing having happened.
function browserCaptureSize() {
  const { viewport } = getBrowserElements();
  return {
    w: Math.round(viewport?.clientWidth || 0),
    h: Math.round(viewport?.clientHeight || 0),
  };
}

async function copyBrowserSelection(text, emptyMessage) {
  const value = String(text || "");
  if (!value.trim()) {
    setBrowserStatus(emptyMessage, true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    setBrowserStatus(`Copied ${value.length} characters.`);
  } catch {
    // The async clipboard can be refused — a denied permission, or a page that
    // has lost focus by the time the selection comes back from the server —
    // and the older copy command still works then. The rest of Dive falls back
    // the same way.
    if (copyTextWithCommand(value)) {
      setBrowserStatus(`Copied ${value.length} characters.`);
    } else {
      // The selection was still made, and saying so beats appearing to do
      // nothing.
      setBrowserStatus("Selected, but the clipboard refused the write.", true);
    }
  }
}

function copyTextWithCommand(value) {
  const scratch = document.createElement("textarea");
  scratch.value = value;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  const previous = document.activeElement;
  scratch.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  scratch.remove();
  previous?.focus?.();
  return copied;
}

function browserViewPointerDown(event) {
  if (event.button !== 0) return;
  browserDragged = false;
  // A uBlock tool takes every click and has no use for a text selection, so
  // while one is running nothing counts as a drag.
  if (getBrowserElements().viewport?.classList.contains("picking")) {
    browserDragStart = null;
    return;
  }
  const point = browserPointFor(event);
  browserDragStart = point
    ? { ...point, clientX: event.clientX, clientY: event.clientY }
    : null;
  // The release has to come back here even when it happens off the picture,
  // or the drag never finishes.
  if (browserDragStart)
    event.currentTarget?.setPointerCapture?.(event.pointerId);
}

function browserViewPointerMoved(event) {
  if (!browserDragStart || browserDragged) return;
  const moved =
    Math.abs(event.clientX - browserDragStart.clientX) >
      BROWSER_DRAG_THRESHOLD_PX ||
    Math.abs(event.clientY - browserDragStart.clientY) >
      BROWSER_DRAG_THRESHOLD_PX;
  // Below the threshold this is a click with a shaky hand, not a drag.
  if (moved) browserDragged = true;
}

// The browser abandoned the gesture. Left set, the next ordinary click would be
// swallowed as the end of a drag that never happened.
function browserViewPointerCancelled() {
  browserDragStart = null;
  browserDragged = false;
}

async function browserViewPointerUp(event) {
  const start = browserDragStart;
  browserDragStart = null;
  if (!start || !browserDragged) return;
  const end = browserPointFor(event);
  // Released over the other surface, or off the picture entirely.
  if (!end || end.target !== start.target) return;
  const result = await browserUserRequest(
    "/api/browser/interact",
    {
      type: "select",
      target: start.target,
      x: start.x,
      y: start.y,
      x2: end.x,
      y2: end.y,
      ...browserCaptureSize(),
    },
    "Browser select",
    { light: true },
  );
  await copyBrowserSelection(
    result?.selection,
    "Nothing selectable under that drag.",
  );
}

// Cmd/Ctrl+A then Cmd/Ctrl+C, for taking the whole page rather than aiming at
// it with a drag.
async function browserSelectAllOrCopy(key) {
  const result = await browserUserRequest(
    "/api/browser/interact",
    { type: key === "a" ? "selectall" : "selection", ...browserCaptureSize() },
    "Browser selection",
    { light: true },
  );
  if (key === "a") {
    const length = String(result?.selection || "").length;
    setBrowserStatus(
      length
        ? `Selected the page — ${length} characters. Copy with Cmd+C.`
        : "Nothing on this page to select.",
      !length,
    );
    return;
  }
  await copyBrowserSelection(result?.selection, "Nothing is selected.");
}

// Where typing goes: the surface last clicked. The extension's panel is drawn
// over the page, and keys went to the page under it whatever had been clicked,
// so nothing could be typed into uBlock's filter editor.
let browserKeyTarget = "page";

function browserKeyTargetNow() {
  const { uiLayer } = getBrowserElements();
  return browserKeyTarget === "ui" && uiLayer && !uiLayer.hidden
    ? "ui"
    : "page";
}

// Dive's own text fields keep their keys. Only the address bar was excluded,
// so with take-over on, what was typed into the chat box went to the page.
function isDiveTextField(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test(
    el.type,
  );
}

// Keystrokes go to the page only while take-over is on and the address bar does
// not have focus — otherwise typing a URL would also be typed into the page.
// The extension's panel needs no take-over: typing into it, like clicking it,
// does nothing to the site.
function browserViewKeyed(event) {
  const { takeover, address } = getBrowserElements();
  if (!browserPanelOpen) return;
  if (document.activeElement === address) return;
  if (isDiveTextField(document.activeElement)) return;
  const target = browserKeyTargetNow();
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key !== "a" && key !== "c") return;
    if (!browserActiveSession) return;
    // Only when nothing is selected in Dive's own interface, or this would
    // take Cmd+C away from the conversation.
    const local = window.getSelection?.();
    if (key === "c" && local && !local.isCollapsed) return;
    event.preventDefault();
    if (target === "ui") {
      // In the panel these belong to the panel: select-all selects in its
      // editor, and copying takes what is selected there.
      if (key === "a") {
        browserUserRequest(
          "/api/browser/interact",
          { type: "key", key: "ControlOrMeta+A", target },
          "Browser key",
          { quiet: true },
        );
      } else {
        browserUserRequest(
          "/api/browser/interact",
          { type: "selection", target },
          "Browser selection",
          { quiet: true },
        ).then((result) =>
          copyBrowserSelection(result?.selection, "Nothing is selected."),
        );
      }
      return;
    }
    browserSelectAllOrCopy(key);
    return;
  }
  if (target === "page" && !takeover?.checked) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const named = [
    "Enter",
    "Tab",
    "Backspace",
    "Delete",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ];
  if (named.includes(event.key)) {
    event.preventDefault();
    browserUserRequest(
      "/api/browser/interact",
      { type: "key", key: event.key, target },
      "Browser key",
    );
    return;
  }
  if (event.key.length !== 1) return;
  event.preventDefault();
  browserUserRequest(
    "/api/browser/interact",
    { type: "type", text: event.key, target },
    "Browser type",
  );
}

// A paste goes where typing would, as one insertion rather than key by key.
function browserViewPasted(event) {
  const { takeover, address } = getBrowserElements();
  if (!browserPanelOpen || !browserActiveSession) return;
  if (document.activeElement === address) return;
  if (isDiveTextField(document.activeElement)) return;
  const target = browserKeyTargetNow();
  if (target === "page" && !takeover?.checked) return;
  const text = event.clipboardData?.getData("text/plain") || "";
  if (!text) return;
  event.preventDefault();
  browserUserRequest(
    "/api/browser/interact",
    { type: "insert", text, target },
    "Browser paste",
  );
}

async function refreshBrowserPanel({ capture = true } = {}) {
  const { status, empty } = getBrowserElements();
  try {
    const res = await fetch(apiUrl("/api/browser/sessions"), {
      cache: "no-store",
    });
    const data = await readJsonResponse(res, "Browser sessions");
    browserEngineReady = data.engineAvailable !== false;
    browserSessionsCache = Array.isArray(data.sessions) ? data.sessions : [];
    // A session the agent closed should not leave the panel pointing at it.
    if (!browserSessionsCache.some((s) => s.name === browserActiveSession)) {
      browserActiveSession = browserSessionsCache[0]?.name || "";
    }
    if (status && Date.now() >= browserStatusHoldUntil) {
      if (!browserEngineReady) {
        status.textContent =
          data.installHint || "The browser engine is not installed.";
        status.className = "browser-status warn";
      } else if (!browserSessionsCache.length) {
        status.textContent = "No page open.";
        status.className = "browser-status";
      } else {
        // Two different counts, and they mean different things: `adsBlocked` is
        // uBlock's filter lists doing their job, `blocked` is the network guard
        // refusing a local address — the second is worth noticing.
        const ads = browserSessionsCache.reduce(
          (sum, s) => sum + (s.adsBlocked || 0),
          0,
        );
        status.textContent =
          `${browserSessionsCache.length} session(s) open.` +
          (ads ? ` ${ads} ad/tracker request(s) blocked.` : "");
        status.className = "browser-status";
      }
    }
    if (empty && !browserEngineReady) {
      empty.textContent =
        data.installHint || "The browser engine is not installed.";
    }
    const showing = browserSessionsCache.find(
      (x) => x.name === browserActiveSession,
    );
    const backBtn = document.getElementById("browserBackToPageBtn");
    if (backBtn) backBtn.hidden = !showing?.extensionUi;
    if (showing?.extensionUi) startBrowserUiLayer();
    else stopBrowserUiLayer();
    // The picker consumes every click while it runs — links included — so its
    // exit has to be visible for as long as it is running.
    const stopBtn = document.getElementById("browserStopPickerBtn");
    if (stopBtn) stopBtn.hidden = !showing?.pickerActive;
    const { viewport } = getBrowserElements();
    viewport?.classList.toggle("picking", Boolean(showing?.pickerActive));
    // Say what the tool is waiting for. It gives no sign of its own: the popup
    // closes, the page comes back, and nothing indicates that the next click
    // will select something rather than follow a link. Which tool it is
    // matters too: only the picker's filter is kept.
    const tool = showing?.pickerActive ? showing.pickerKind || "picker" : "";
    if (tool && tool !== browserToolShown) {
      const { takeover } = getBrowserElements();
      if (takeover && !takeover.checked) {
        takeover.checked = true;
        takeover.dispatchEvent(new Event("change"));
      }
      setBrowserStatus(
        BROWSER_TOOL_HINTS[tool] || BROWSER_TOOL_HINTS.picker,
        false,
        30000,
      );
    }
    browserToolShown = tool;
    // A popup that closed itself hands the view back to the page, and the
    // stream is bound to the target that just went away.
    if (browserShowingExtensionUi && !showing?.extensionUi) {
      stopBrowserStream();
    }
    browserShowingExtensionUi = Boolean(showing?.extensionUi);
    renderBrowserTabs();
    // Reopened at the panel's current size before anything is drawn with it.
    if (browserStreamSizeStale()) startBrowserStream(browserStreamSession);
    if (capture) refreshBrowserView();
  } catch (error) {
    // A failed poll is not worth a dialog; the panel says so and keeps trying.
    if (status) {
      status.textContent = "Could not reach the browser service.";
      status.className = "browser-status warn";
    }
    console.error("Could not refresh the browser panel", error);
  }
}

async function endBrowserSession(name) {
  try {
    await postJson(
      "/api/browser/close",
      name ? { session: name } : {},
      "Close browser session",
    );
    // Ending a session is a real action on the agent's state, so it belongs in
    // the same audit trail as every other one.
    logSecurityEvent("browser_session_closed", { session: name || "(all)" });
  } catch (error) {
    console.error("Could not close the browser session", error);
  }
  refreshBrowserPanel();
}

async function endAllBrowserSessions() {
  if (!browserSessionsCache.length) return;
  const ok = await appConfirm(
    "End every agent browser session? Anything the agent has open, including a page you signed into, is discarded.",
    "Agent browser",
    { danger: true, confirmLabel: "End all" },
  );
  if (!ok) return;
  await endBrowserSession("");
}

// Dragging the edge, the same affordance every other panel has. Self-contained
// rather than folded into the shared handler in 07-chat.js: this panel owns its
// own file, and a drag that also has to resize the agent's page is its business.
function wireBrowserResizer() {
  const resizer = document.getElementById("browserResizer");
  const panel = document.getElementById("browserPanel");
  if (!resizer || !panel) return;
  let dragging = false;
  resizer.addEventListener("mousedown", () => {
    if (!browserPanelOpen) return;
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    const main = document.getElementById("main");
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const newWidth = rect.right - event.clientX;
    if (newWidth > 300 && newWidth < rect.width - 200) {
      panel.style.width = newWidth + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Re-render at the new size straight away rather than waiting up to a full
    // poll, which would leave the old capture stretched across the new width.
    // The stream was started with the old dimensions, so it is reopened too.
    if (browserStreamSession) startBrowserStream(browserStreamSession);
    refreshBrowserView();
  });
}

// ---- Extensions ----
//
// Installing puts third-party code inside the browser the agent drives, so it
// happens only here, only when asked, and never at the model's request. An
// enable does not take effect until the browser next launches, because the
// extension list is part of the launch command line — so the panel says that
// rather than leaving a switch that appears to do nothing.

let browserExtBusy = false;

function renderBrowserExtensions(data) {
  const list = document.getElementById("browserExtList");
  if (!list) return;
  list.textContent = "";

  const button = (text, title, handler, className = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    if (className) b.className = className;
    b.disabled = browserExtBusy;
    b.addEventListener("click", handler);
    return b;
  };

  // The same row the built-in skills use: name, description, controls. An
  // extension list is the same shape as a skill list, so it gets the same shape.
  const addRow = (name, description, controls) => {
    const row = document.createElement("div");
    row.className = "builtin-skill-row";
    const info = document.createElement("div");
    info.className = "builtin-skill-info";
    const strong = document.createElement("strong");
    strong.textContent = name;
    info.appendChild(strong);
    if (description) {
      const desc = document.createElement("div");
      desc.className = "builtin-skill-description";
      desc.textContent = description;
      info.appendChild(desc);
    }
    row.appendChild(info);
    const actions = document.createElement("div");
    actions.className = "browser-ext-actions";
    controls.forEach((c) => actions.appendChild(c));
    row.appendChild(actions);
    list.appendChild(row);
    return row;
  };

  for (const ext of data.extensions || []) {
    const controls = [];
    // OPTIONS opens the extension's OWN settings page in the panel. That is how
    // an extension is actually configured — filter lists, per-site rules — and
    // without it "manage extensions" would mean nothing but a switch.
    if (ext.optionsUrl) {
      controls.push(
        button(
          "OPTIONS",
          ext.enabled
            ? `Open ${ext.name}'s own settings in the browser`
            : "Enable it first, then open its settings",
          () => openBrowserExtensionPage(ext.extensionId, ext.name),
        ),
      );
      if (!ext.enabled) controls[controls.length - 1].disabled = true;
    }
    // BLOCK opens the extension's POPUP, which is where per-site blocking
    // lives: the filtering level for the current host, the element picker,
    // "create a custom filter". The dashboard behind OPTIONS is global
    // settings and cannot block anything on the page in front of you.
    if (ext.popupUrl) {
      const blockBtn = button(
        "BLOCK",
        ext.enabled
          ? `Block things on this page with ${ext.name}`
          : "Enable it first",
        () => openBrowserExtensionPopup(ext.extensionId, ext.name),
      );
      if (!ext.enabled) blockBtn.disabled = true;
      controls.push(blockBtn);
    }
    controls.push(
      button(
        "REMOVE",
        `Delete ${ext.name} from disk`,
        () => removeBrowserExtension(ext.id, ext.name),
        "danger",
      ),
    );
    const row = addRow(
      `${ext.name}${ext.version ? ` ${ext.version}` : ""}`,
      ext.valid
        ? ext.summary || ""
        : "This install has no readable manifest and will not be loaded.",
      controls,
    );
    // The app's toggle, in the app's control slot, rather than a button
    // pretending to be one.
    const control = document.createElement("div");
    control.className = "builtin-skill-control";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "brutalist-toggle";
    toggle.checked = Boolean(ext.enabled);
    toggle.disabled = browserExtBusy || !ext.valid;
    toggle.title = `Enable ${ext.name}`;
    toggle.setAttribute("aria-label", `Enable ${ext.name}`);
    toggle.addEventListener("change", () =>
      browserExtAction("/api/browser/extensions/enable", {
        id: ext.id,
        enabled: toggle.checked,
      }),
    );
    control.appendChild(toggle);
    row.insertBefore(control, row.lastChild);
  }

  for (const ext of data.available || []) {
    addRow(ext.name, ext.summary || "", [
      button("INSTALL", `Download and install ${ext.name}`, () =>
        browserExtAction("/api/browser/extensions/install", { id: ext.id }),
      ),
    ]);
  }

  if (!(data.extensions || []).length && !(data.available || []).length) {
    addRow("No extensions available.", "", []);
  }
}

// The popup acts on the page currently open, so it needs one — and it needs
// clicking, which means TAKE OVER.
async function openBrowserExtensionPopup(id, name) {
  const { takeover } = getBrowserElements();
  const result = await browserUserRequest(
    "/api/browser/extensions/popup",
    { id },
    "Open extension popup",
  );
  if (result?.ok) {
    // Both tools save now: the zapper's removals are kept as custom filters by
    // the server, so neither is the wrong one to reach for.
    setBrowserStatus(
      `${name}: "Remove an element" removes what you click; "Create a custom filter" lets you choose what the filter matches. Both are saved and survive a restart.`,
      false,
      15000,
    );
    // The extensions list has done its job and is now just taking the space
    // you need to see the page. Picking an element off a 110px sliver is not
    // possible however well the picker works.
    const extPanel = document.getElementById("browserExtPanel");
    if (extPanel && !extPanel.hidden) toggleBrowserExtensions();
    startBrowserUiLayer();
    // The stream was bound to the page; the panel is showing the popup now.
    stopBrowserStream();
    refreshBrowserView();
    if (takeover && !takeover.checked) {
      takeover.checked = true;
      takeover.dispatchEvent(new Event("change"));
    }
  }
}

// Cancel a running element picker.
//
// uBlock's overlay quits on Escape (tool-overlay.js:114 → quitTool), which is
// the same exit its own ✕ uses. Without a control for it the picker had no way
// out from inside the panel: it swallows every click, so the page underneath
// became unusable — you could not even follow a link.
async function stopBrowserPicker() {
  await browserUserRequest(
    "/api/browser/interact",
    // Pressed inside the tool: the unpicker ignores Escape, so sending Escape
    // left it running.
    { type: "quit-tool", target: "page" },
    "Stop picker",
  );
  setBrowserStatus("uBlock tool closed.", false, 4000);
  refreshBrowserPanel();
}

// Put the page back in front of an extension's UI.
async function dismissBrowserExtensionUi() {
  stopBrowserUiLayer();
  await browserUserRequest(
    "/api/browser/extensions/dismiss",
    {},
    "Close extension UI",
  );
  refreshBrowserView();
}

// Point the browser at the extension's own UI. It renders in the panel like any
// other page, and TAKE OVER makes it clickable — which is what turns this from
// a list into something you can actually configure.
async function openBrowserExtensionPage(id, name) {
  const { takeover } = getBrowserElements();
  const result = await browserUserRequest(
    "/api/browser/extensions/open",
    { id },
    "Open extension settings",
  );
  if (result?.ok) {
    setBrowserStatus(
      `${name} settings — click them directly. BACK TO PAGE when you are done.`,
      false,
      8000,
    );
    const list = document.getElementById("browserExtPanel");
    if (list && !list.hidden) toggleBrowserExtensions();
    startBrowserUiLayer();
    // Its own UI is useless read-only, so offer the thing that makes it work.
    if (takeover && !takeover.checked) {
      takeover.checked = true;
      takeover.dispatchEvent(new Event("change"));
    }
  }
}

async function refreshBrowserExtensions() {
  try {
    const res = await fetch(apiUrl("/api/browser/extensions"), {
      cache: "no-store",
    });
    renderBrowserExtensions(await readJsonResponse(res, "Browser extensions"));
  } catch (error) {
    console.error("Could not list browser extensions", error);
  }
}

async function browserExtAction(path, payload) {
  browserExtBusy = true;
  setBrowserStatus("Working…");
  refreshBrowserExtensions();
  try {
    const result = await postJson(path, payload, "Browser extensions");
    renderBrowserExtensions(result);
    if (result.restartRequired) {
      // The browser reloads itself on the next thing you do with it, because
      // extensions are fixed at launch and telling a person to go and restart
      // a session is not an answer.
      setBrowserStatus("Saved. The browser reloads to apply it.", true);
    }
  } catch (error) {
    setBrowserStatus(String(error.message || error).slice(0, 200), true);
  } finally {
    browserExtBusy = false;
    refreshBrowserExtensions();
  }
}

async function removeBrowserExtension(id, name) {
  const ok = await appConfirm(
    `Remove "${name}"? Its files are deleted from disk.`,
    "Agent browser",
    { danger: true, confirmLabel: "Remove" },
  );
  if (!ok) return;
  browserExtAction("/api/browser/extensions/remove", { id });
}

function toggleBrowserExtensions() {
  const panel = document.getElementById("browserExtPanel");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  document
    .getElementById("browserExtBtn")
    ?.setAttribute("aria-pressed", String(!panel.hidden));
  if (!panel.hidden) refreshBrowserExtensions();
}

(function wireBrowserPanel() {
  const on = (id, event, handler) => {
    document.getElementById(id)?.addEventListener(event, handler);
  };
  on("railBrowserBtn", "click", () => toggleBrowserPanel());
  on("sideBrowserBtn", "click", () => toggleBrowserPanel());
  on("closeBrowserBtn", "click", () => toggleBrowserPanel());
  on("browserRefreshBtn", "click", () => refreshBrowserPanel());
  on("browserCloseAllBtn", "click", () => endAllBrowserSessions());
  on("browserExtBtn", "click", () => toggleBrowserExtensions());
  on("browserBackToPageBtn", "click", () => dismissBrowserExtensionUi());
  on("browserGoBtn", "click", () => navigateBrowserToAddress());
  on("browserAddress", "keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateBrowserToAddress();
    }
  });
  for (const [id, action] of [
    ["browserBackBtn", "back"],
    ["browserForwardBtn", "forward"],
    ["browserReloadBtn", "reload"],
  ]) {
    on(id, "click", () =>
      browserUserRequest("/api/browser/history", { action }, "Browser history"),
    );
  }
  on("browserView", "click", browserViewClicked);
  on("browserView", "mousemove", browserViewMoved);
  on("browserUiView", "click", browserViewClicked);
  on("browserUiView", "mousemove", browserViewMoved);
  for (const id of ["browserView", "browserUiView"]) {
    on(id, "pointerdown", browserViewPointerDown);
    // An <img> is draggable by default; a native image drag cancels the
    // pointer stream and drops the screenshot on the chat's upload zone.
    on(id, "dragstart", (event) => event.preventDefault());
  }
  // On the document, not the picture: a drag that ends outside it still has to
  // finish, and one that never ends leaves the next click swallowed.
  document.addEventListener("pointermove", browserViewPointerMoved);
  document.addEventListener("pointerup", browserViewPointerUp);
  document.addEventListener("pointercancel", browserViewPointerCancelled);
  on("browserUiCloseBtn", "click", () => dismissBrowserExtensionUi());
  on("browserStopPickerBtn", "click", () => stopBrowserPicker());
  // Not passive: the wheel must scroll the remote page, not the panel.
  document
    .getElementById("browserViewport")
    ?.addEventListener("wheel", browserViewScrolled, { passive: false });
  on("browserTakeover", "change", () => {
    const { viewport, takeover } = getBrowserElements();
    viewport?.classList.toggle("takeover", Boolean(takeover?.checked));
  });
  document.addEventListener("keydown", browserViewKeyed);
  document.addEventListener("paste", browserViewPasted);
  wireBrowserResizer();
  // The stream is started with the viewport's dimensions, so anything that
  // changes them has to restart it or the frames keep arriving at the old
  // aspect. Dragging the edge and resizing the window were handled one at a
  // time; opening the extensions panel changes the height too, and was not.
  // Watching the element itself covers every cause, including the next one.
  if (typeof ResizeObserver === "function") {
    const viewport = document.getElementById("browserViewport");
    if (viewport) {
      let settle = null;
      new ResizeObserver(() => {
        if (!browserPanelOpen || !browserStreamSession) return;
        clearTimeout(settle);
        // A drag emits a great many sizes; restart once it stops.
        settle = window.setTimeout(() => {
          startBrowserStream(browserStreamSession);
        }, 250);
      }).observe(viewport);
    }
  }
  // The window changing size changes the panel's size too, and the capture has
  // to follow or the page is left rendered for the old one.
  window.addEventListener("resize", () => {
    if (browserPanelOpen) refreshBrowserView();
  });
  // Coming back to the tab should show the page as it is now, not as it was
  // when the tab was hidden and polling stopped.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && browserPanelOpen) refreshBrowserPanel();
  });
})();

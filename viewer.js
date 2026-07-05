(function () {
  const ROOM_ID = "main";
  const RETRY_MS = 2500;
  const READY_MS = 3000;
  const MAX_BUFFER_SECONDS = 20;

  const video = document.querySelector("#streamVideo");
  const emptyState = document.querySelector("#emptyState");
  const emptyTitle = document.querySelector("#emptyTitle");
  const statusText = document.querySelector("#statusText");
  const muteButton = document.querySelector("#muteButton");
  const muteText = document.querySelector("#muteText");
  const volumeOnIcon = document.querySelector("#volumeOnIcon");
  const volumeOffIcon = document.querySelector("#volumeOffIcon");

  const state = {
    socket: null,
    mediaSource: null,
    sourceBuffer: null,
    objectUrl: "",
    queue: [],
    reconnectTimer: null,
    readyTimer: null,
    muted: true,
    isLive: false,
    senderOnline: false,
    mimeType: ""
  };

  video.controls = false;
  video.disableRemotePlayback = true;
  video.setAttribute("disableRemotePlayback", "");
  video.muted = state.muted;
  video.addEventListener("contextmenu", (event) => event.preventDefault());
  muteButton.addEventListener("click", toggleMute);
  window.addEventListener("beforeunload", () => {
    closeSocket();
    resetMedia();
  });

  connectSocket();
  updateMuteButton();

  function connectSocket() {
    clearTimeout(state.reconnectTimer);
    closeSocket();
    setStatus("Verbindung wird aufgebaut");

    const socket = new WebSocket(getSocketUrl());
    socket.binaryType = "arraybuffer";
    state.socket = socket;

    socket.addEventListener("open", () => {
      setStatus("Sender wird gesucht");
      setEmpty("Sender wird gesucht");
      sendReady();
      startReadyLoop();
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        handleMediaChunk(event.data);
        return;
      }

      const message = parseMessage(event.data);

      if (message.type === "sender-state") {
        handleSenderState(message);
      }

      if (message.type === "media-start") {
        handleMediaStart(message);
      }

      if (message.type === "media-stop") {
        handleMediaStop(message);
      }
    });

    socket.addEventListener("close", () => {
      if (state.socket !== socket) {
        return;
      }

      stopReadyLoop();
      resetMedia();
      state.socket = null;
      state.senderOnline = false;
      setEmpty("Sender wird gesucht");
      setStatus("Verbindung getrennt");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      setStatus("Verbindung gestoert");
    });
  }

  function handleSenderState(message) {
    state.senderOnline = Boolean(message.online);

    if (!state.senderOnline) {
      resetMedia();
      setEmpty("Sender wird gesucht");
      setStatus("Sender offline");
      return;
    }

    if (!message.live && !state.isLive) {
      setEmpty("Warte auf Stream");
      setStatus("Sender verbunden");
    }
  }

  function handleMediaStart(message) {
    state.senderOnline = true;
    const playableMimeType = selectPlayableMimeType(message.mimeType);

    if (!playableMimeType) {
      resetMedia();
      setEmpty(getUnsupportedTitle(message.mimeType));
      setStatus(getUnsupportedStatus(message.mimeType));
      return;
    }

    resetMedia();
    state.mimeType = playableMimeType;
    state.isLive = true;
    emptyState.hidden = true;
    video.classList.add("is-live");
    setStatus("Puffer wird geladen");
    setupMediaSource();
    updateMuteButton();
  }

  function handleMediaStop(message) {
    resetMedia();
    state.senderOnline = Boolean(message.online);
    setEmpty(state.senderOnline ? "Stream beendet" : "Sender wird gesucht");
    setStatus(state.senderOnline ? "Stream beendet" : "Sender offline");
  }

  function setupMediaSource() {
    const MediaSourceApi = getMediaSourceApi();

    if (!MediaSourceApi) {
      resetMedia();
      setEmpty("Browser nicht kompatibel");
      setStatus("MediaSource fehlt");
      return;
    }

    const mediaSource = new MediaSourceApi();
    state.mediaSource = mediaSource;
    state.objectUrl = URL.createObjectURL(mediaSource);
    video.src = state.objectUrl;
    video.muted = state.muted;

    mediaSource.addEventListener("sourceopen", () => {
      if (state.mediaSource !== mediaSource || mediaSource.readyState !== "open") {
        return;
      }

      try {
        state.sourceBuffer = mediaSource.addSourceBuffer(state.mimeType);
        state.sourceBuffer.mode = "sequence";
        state.sourceBuffer.addEventListener("updateend", onSourceBufferUpdateEnd);
        appendNextChunk();
      } catch {
        resetMedia();
        setEmpty("Streamformat nicht unterstuetzt");
        setStatus("Browser nicht kompatibel");
      }
    });
  }

  function onSourceBufferUpdateEnd() {
    trimBuffer();
    appendNextChunk();
  }

  function handleMediaChunk(data) {
    if (!state.isLive || !data || !data.byteLength) {
      return;
    }

    state.queue.push(data);
    appendNextChunk();
  }

  function appendNextChunk() {
    if (!state.sourceBuffer || state.sourceBuffer.updating || state.queue.length === 0) {
      return;
    }

    if (!state.mediaSource || state.mediaSource.readyState !== "open") {
      return;
    }

    const chunk = state.queue.shift();

    try {
      state.sourceBuffer.appendBuffer(chunk);

      if (video.paused) {
        video.play().catch(() => {});
      }

      if (!emptyState.hidden) {
        emptyState.hidden = true;
      }

      setStatus("Live");
    } catch {
      resetMedia();
      setEmpty("Stream unterbrochen");
      setStatus("Stream unterbrochen");
    }
  }

  function trimBuffer() {
    if (!state.sourceBuffer || state.sourceBuffer.updating || video.currentTime < MAX_BUFFER_SECONDS) {
      return;
    }

    try {
      const removeEnd = video.currentTime - MAX_BUFFER_SECONDS;

      if (removeEnd > 0 && state.sourceBuffer.buffered.length > 0 && state.sourceBuffer.buffered.start(0) < removeEnd) {
        state.sourceBuffer.remove(0, removeEnd);
      }
    } catch {
      // Buffer trimming is opportunistic; playback can continue without it.
    }
  }

  function resetMedia() {
    state.queue = [];
    state.isLive = false;

    if (state.sourceBuffer) {
      state.sourceBuffer.removeEventListener("updateend", onSourceBufferUpdateEnd);
    }

    if (state.mediaSource && state.mediaSource.readyState === "open") {
      try {
        state.mediaSource.endOfStream();
      } catch {
        // The media source can already be closing.
      }
    }

    state.mediaSource = null;
    state.sourceBuffer = null;

    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = "";
    }

    video.removeAttribute("src");
    video.load();
    video.classList.remove("is-live");
    emptyState.hidden = false;
    updateMuteButton();
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectSocket, RETRY_MS);
  }

  function closeSocket() {
    if (!state.socket) {
      return;
    }

    stopReadyLoop();
    state.socket.close();
    state.socket = null;
  }

  function sendReady() {
    send({ type: "viewer-ready" });
  }

  function send(message) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(message));
    }
  }

  function startReadyLoop() {
    stopReadyLoop();
    state.readyTimer = window.setInterval(sendReady, READY_MS);
  }

  function stopReadyLoop() {
    if (state.readyTimer) {
      window.clearInterval(state.readyTimer);
      state.readyTimer = null;
    }
  }

  function toggleMute() {
    state.muted = !state.muted;
    video.muted = state.muted;
    updateMuteButton();
    video.play().catch(() => {});
  }

  function updateMuteButton() {
    video.muted = state.muted;
    muteButton.disabled = false;
    muteButton.setAttribute("aria-pressed", String(state.muted));

    if (state.muted) {
      muteButton.setAttribute("aria-label", "Ton einschalten");
      muteButton.title = "Ton einschalten";
      muteText.textContent = "Ton an";
      volumeOnIcon.hidden = true;
      volumeOffIcon.hidden = false;
      return;
    }

    muteButton.setAttribute("aria-label", "Ton stummschalten");
    muteButton.title = "Ton stummschalten";
    muteText.textContent = "Ton aus";
    volumeOnIcon.hidden = false;
    volumeOffIcon.hidden = true;
  }

  function selectPlayableMimeType(preferredMimeType) {
    const normalized = String(preferredMimeType || "").toLowerCase();
    const candidates = [];

    if (normalized.includes("mp4")) {
      candidates.push(
        preferredMimeType,
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1.4D401E,mp4a.40.2",
        "video/mp4;codecs=avc1.64001F,mp4a.40.2",
        "video/mp4;codecs=h264,aac",
        "video/mp4"
      );
    } else if (normalized.includes("webm")) {
      candidates.push(
        preferredMimeType,
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm"
      );
    } else {
      candidates.push(
        preferredMimeType,
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      );
    }

    return unique(candidates).find(isMimeTypeSupported) || "";
  }

  function isMimeTypeSupported(mimeType) {
    const MediaSourceApi = getMediaSourceApi();
    return Boolean(
      mimeType &&
      MediaSourceApi &&
      typeof MediaSourceApi.isTypeSupported === "function" &&
      MediaSourceApi.isTypeSupported(mimeType)
    );
  }

  function getMediaSourceApi() {
    return window.ManagedMediaSource || window.MediaSource || null;
  }

  function getUnsupportedTitle(mimeType) {
    if (isIOS() && String(mimeType || "").toLowerCase().includes("webm")) {
      return "iPhone braucht MP4/H.264";
    }

    return "Streamformat nicht unterstuetzt";
  }

  function getUnsupportedStatus(mimeType) {
    if (!getMediaSourceApi()) {
      return isIOS() ? "iOS 17.1 oder neuer benoetigt" : "MediaSource fehlt";
    }

    if (isIOS() && String(mimeType || "").toLowerCase().includes("webm")) {
      return "Sender muss MP4/H.264 senden";
    }

    return "Browser nicht kompatibel";
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function getSocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      role: "viewer",
      room: ROOM_ID
    });

    return `${protocol}//${window.location.host}/ws?${params.toString()}`;
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function setEmpty(text) {
    emptyTitle.textContent = text;
    emptyState.hidden = false;
  }

  function parseMessage(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
})();

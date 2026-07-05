(function () {
  const ROOM_ID = "main";
  const CHUNK_MS = 750;
  const VIDEO_BITS_PER_SECOND = 2200000;
  const AUDIO_BITS_PER_SECOND = 64000;
  const MIME_TYPE_CANDIDATES = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.4D401E,mp4a.40.2",
    "video/mp4;codecs=avc1.64001F,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm"
  ];

  const params = new URLSearchParams(window.location.search);
  const senderKey = params.get("key") || "";

  const startButton = document.querySelector("#startButton");
  const stopButton = document.querySelector("#stopButton");
  const senderStatus = document.querySelector("#senderStatus");
  const previewVideo = document.querySelector("#previewVideo");
  const previewEmpty = document.querySelector("#previewEmpty");
  const viewerCount = document.querySelector("#viewerCount");
  const viewerUrl = document.querySelector("#viewerUrl");

  const state = {
    socket: null,
    stream: null,
    recorder: null,
    restartingRecorder: false,
    viewers: new Set(),
    reconnectTimer: null,
    accepted: false,
    mimeType: ""
  };

  viewerUrl.textContent = `Zuschauer-Link: ${window.location.origin}/`;
  startButton.addEventListener("click", startStream);
  stopButton.addEventListener("click", stopStream);
  window.addEventListener("beforeunload", () => {
    state.restartingRecorder = false;
    stopRecorder();

    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
    }

    if (state.socket) {
      state.socket.close();
    }
  });

  if (!senderKey) {
    setStatus("Sender-Key fehlt");
    startButton.disabled = true;
  } else {
    connectSocket();
  }

  function connectSocket() {
    clearTimeout(state.reconnectTimer);
    closeSocket();
    setStatus("Sender-Verbindung wird aufgebaut");
    startButton.disabled = true;

    const socket = new WebSocket(getSocketUrl());
    socket.binaryType = "arraybuffer";
    state.socket = socket;

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      const message = parseMessage(event.data);

      if (message.type === "welcome") {
        state.accepted = true;
        state.viewers = new Set(message.viewerIds || []);
        updateViewerCount();
        startButton.disabled = Boolean(state.stream);
        stopButton.disabled = !state.stream;
        setStatus(state.stream ? "Live" : "Bereit");

        if (state.recorder && state.recorder.state === "recording") {
          restartRecorder();
        }
      }

      if (message.type === "error") {
        setStatus(message.error || "Sender-Verbindung abgelehnt");
        startButton.disabled = true;
      }

      if (message.type === "viewer-joined") {
        state.viewers.add(message.viewerId);
        updateViewerCount();
      }

      if (message.type === "viewer-left") {
        state.viewers.delete(message.viewerId);
        updateViewerCount();
      }
    });

    socket.addEventListener("close", () => {
      if (state.socket !== socket) {
        return;
      }

      state.socket = null;
      state.accepted = false;

      if (state.stream) {
        setStatus("Sender-Verbindung wird erneuert");
        scheduleReconnect();
        return;
      }

      setStatus("Sender offline");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (!state.accepted) {
        setStatus("Sender-Verbindung gestoert");
      }
    });
  }

  async function startStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setStatus("Bildschirmaufnahme wird nicht unterstuetzt");
      return;
    }

    try {
      state.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 854, max: 854 },
          height: { ideal: 480, max: 480 }
        },
        audio: true
      });
    } catch {
      setStatus("Auswahl abgebrochen");
      return;
    }

    state.mimeType = chooseRecorderMimeType();

    if (!state.mimeType) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
      setStatus("Browser unterstuetzt WebM nicht");
      return;
    }

    previewVideo.srcObject = state.stream;
    tuneCaptureTracks();
    previewEmpty.hidden = true;
    startButton.disabled = true;
    stopButton.disabled = false;

    state.stream.getTracks().forEach((track) => {
      track.addEventListener("ended", stopStream, { once: true });
    });

    startRecorder();
  }

  function stopStream() {
    if (!state.stream) {
      return;
    }

    state.restartingRecorder = false;
    stopRecorder();
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    previewVideo.srcObject = null;
    previewEmpty.hidden = false;
    startButton.disabled = !state.accepted;
    stopButton.disabled = true;
    send({ type: "media-stop" });
    setStatus(state.accepted ? "Bereit" : "Sender offline");
  }

  function startRecorder() {
    state.recorder = createRecorder();

    if (!state.recorder) {
      setStatus("Aufnahme konnte nicht gestartet werden");
      stopStream();
      return;
    }

    state.mimeType = state.recorder.mimeType || state.mimeType;

    state.recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size === 0) {
        return;
      }

      sendBlob(event.data);
    });

    state.recorder.addEventListener("stop", () => {
      state.recorder = null;

      if (state.restartingRecorder && state.stream) {
        state.restartingRecorder = false;
        startRecorder();
        return;
      }

      state.restartingRecorder = false;
    });

    sendMediaStart();
    state.recorder.start(CHUNK_MS);
    setStatus("Live");
  }

  function stopRecorder() {
    if (state.recorder && state.recorder.state !== "inactive") {
      state.recorder.stop();
    }
  }

  function restartRecorder() {
    if (!state.stream || !state.recorder || state.recorder.state !== "recording") {
      return;
    }

    state.restartingRecorder = true;
    state.recorder.stop();
  }

  function sendMediaStart() {
    send({
      type: "media-start",
      mimeType: state.mimeType
    });
  }

  function sendBlob(blob) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    blob.arrayBuffer().then((buffer) => {
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(buffer);
      }
    }).catch(() => {});
  }

  function send(message) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(message));
    }
  }

  function closeSocket() {
    if (!state.socket) {
      return;
    }

    state.socket.close();
    state.socket = null;
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectSocket, 2500);
  }

  function chooseRecorderMimeType() {
    return MIME_TYPE_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
  }

  function createRecorder() {
    const candidates = unique([state.mimeType].concat(MIME_TYPE_CANDIDATES))
      .filter((mimeType) => MediaRecorder.isTypeSupported(mimeType));

    for (const mimeType of candidates) {
      try {
        return new MediaRecorder(state.stream, {
          mimeType,
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
          audioBitsPerSecond: AUDIO_BITS_PER_SECOND
        });
      } catch {
        // Try the next container/codec variant.
      }
    }

    try {
      return new MediaRecorder(state.stream, {
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND
      });
    } catch {
      return null;
    }
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function tuneCaptureTracks() {
    const [videoTrack] = state.stream.getVideoTracks();

    if (videoTrack && "contentHint" in videoTrack) {
      videoTrack.contentHint = "detail";
    }

    const [audioTrack] = state.stream.getAudioTracks();

    if (audioTrack && "contentHint" in audioTrack) {
      audioTrack.contentHint = "speech";
    }
  }

  function getSocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      role: "sender",
      room: ROOM_ID,
      key: senderKey
    });

    return `${protocol}//${window.location.host}/ws?${params.toString()}`;
  }

  function updateViewerCount() {
    const count = state.viewers.size;
    viewerCount.textContent = count === 1 ? "1 Zuschauer" : `${count} Zuschauer`;
  }

  function setStatus(text) {
    senderStatus.textContent = text;
  }

  function parseMessage(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
})();

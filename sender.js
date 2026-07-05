(function () {
  const config = window.STREAM_CONFIG || {
    roomId: "screen-stream-4f8a9f9c8ef44d18",
    senderKey: ""
  };

  const params = new URLSearchParams(window.location.search);
  const senderKey = params.get("key") || "";
  const ROOM_ID = config.roomId;
  const SENDER_PEER_ID = `${ROOM_ID}-sender`;
  const EXPECTED_SENDER_KEY = config.senderKey;
  const VIDEO_MAX_BITRATE = 1600000;
  const AUDIO_MAX_BITRATE = 64000;

  const startButton = document.querySelector("#startButton");
  const stopButton = document.querySelector("#stopButton");
  const senderStatus = document.querySelector("#senderStatus");
  const previewVideo = document.querySelector("#previewVideo");
  const previewEmpty = document.querySelector("#previewEmpty");
  const viewerCount = document.querySelector("#viewerCount");
  const viewerUrl = document.querySelector("#viewerUrl");

  const state = {
    peer: null,
    stream: null,
    viewerConnections: new Map(),
    calls: new Map(),
    callTimers: new Map()
  };

  viewerUrl.textContent = `Zuschauer-Link: ${window.location.origin}${window.location.pathname.replace(/sender\.html$/, "")}`;
  startButton.addEventListener("click", startStream);
  stopButton.addEventListener("click", stopStream);

  if (senderKey !== EXPECTED_SENDER_KEY) {
    setStatus("Sender-Key fehlt oder ist falsch");
    startButton.disabled = true;
    return;
  }

  waitForPeerLibrary().then(startSender).catch(() => {
    setStatus("PeerJS konnte nicht geladen werden");
  });

  function startSender() {
    state.peer = new Peer(SENDER_PEER_ID, {
      debug: 1,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" }
        ]
      }
    });

    state.peer.on("open", () => {
      setStatus("Bereit");
      startButton.disabled = false;
    });

    state.peer.on("connection", (connection) => {
      state.viewerConnections.set(connection.peer, connection);
      updateViewerCount();

      connection.on("open", () => {
        connection.send({ type: state.stream ? "live" : "waiting" });

        if (state.stream) {
          requestCall(connection.peer);
        }
      });

      connection.on("data", (message) => {
        if (message && message.type === "viewer-ready" && state.stream) {
          requestCall(connection.peer);
        }
      });

      connection.on("close", () => {
        state.viewerConnections.delete(connection.peer);
        closeCall(connection.peer);
        updateViewerCount();
      });

      connection.on("error", () => {
        state.viewerConnections.delete(connection.peer);
        closeCall(connection.peer);
        updateViewerCount();
      });
    });

    state.peer.on("error", (error) => {
      if (error && error.type === "unavailable-id") {
        setStatus("Sender ist bereits offen");
        return;
      }

      setStatus("Sender-Verbindung gestoert");
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
          frameRate: { ideal: 20, max: 24 },
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 }
        },
        audio: true
      });
    } catch {
      setStatus("Auswahl abgebrochen");
      return;
    }

    previewVideo.srcObject = state.stream;
    tuneCaptureTracks();
    previewEmpty.hidden = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Live");

    state.stream.getTracks().forEach((track) => {
      track.addEventListener("ended", stopStream, { once: true });
    });

    broadcast({ type: "live" });

    for (const viewerId of state.viewerConnections.keys()) {
      requestCall(viewerId);
    }
  }

  function stopStream() {
    if (!state.stream) {
      return;
    }

    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    previewVideo.srcObject = null;
    previewEmpty.hidden = false;
    startButton.disabled = false;
    stopButton.disabled = true;

    for (const viewerId of Array.from(state.calls.keys())) {
      closeCall(viewerId);
    }

    for (const timer of state.callTimers.values()) {
      window.clearTimeout(timer);
    }

    state.callTimers.clear();

    broadcast({ type: "waiting" });
    setStatus("Bereit");
  }

  function requestCall(viewerId) {
    if (state.calls.has(viewerId) || state.callTimers.has(viewerId)) {
      return;
    }

    const timer = window.setTimeout(() => {
      state.callTimers.delete(viewerId);
      callViewer(viewerId);
    }, 250);

    state.callTimers.set(viewerId, timer);
  }

  function callViewer(viewerId) {
    if (!state.peer || !state.stream || !viewerId) {
      return;
    }

    if (!state.viewerConnections.has(viewerId)) {
      return;
    }

    if (state.calls.has(viewerId)) {
      return;
    }

    const call = state.peer.call(viewerId, state.stream);
    state.calls.set(viewerId, call);
    applyCallLimits(call);

    call.on("close", () => {
      state.calls.delete(viewerId);

      if (state.stream && state.viewerConnections.has(viewerId)) {
        requestCall(viewerId);
      }
    });

    call.on("error", () => {
      state.calls.delete(viewerId);

      if (state.stream && state.viewerConnections.has(viewerId)) {
        requestCall(viewerId);
      }
    });
  }

  function closeCall(viewerId) {
    const call = state.calls.get(viewerId);

    if (!call) {
      return;
    }

    call.close();
    state.calls.delete(viewerId);
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

  function applyCallLimits(call) {
    const peerConnection = call.peerConnection;

    if (!peerConnection || !peerConnection.getSenders) {
      return;
    }

    for (const sender of peerConnection.getSenders()) {
      if (!sender.track || !sender.getParameters || !sender.setParameters) {
        continue;
      }

      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings && parameters.encodings.length ? parameters.encodings : [{}];

      if (sender.track.kind === "video") {
        parameters.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
        parameters.encodings[0].maxFramerate = 20;
      }

      if (sender.track.kind === "audio") {
        parameters.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
      }

      sender.setParameters(parameters).catch(() => {});
    }
  }

  function broadcast(message) {
    for (const connection of state.viewerConnections.values()) {
      if (connection.open) {
        connection.send(message);
      }
    }
  }

  function updateViewerCount() {
    const count = state.viewerConnections.size;
    viewerCount.textContent = count === 1 ? "1 Zuschauer" : `${count} Zuschauer`;
  }

  function setStatus(text) {
    senderStatus.textContent = text;
  }

  function waitForPeerLibrary() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();

      const check = () => {
        if (window.Peer) {
          resolve();
          return;
        }

        if (Date.now() - startedAt > 8000) {
          reject(new Error("PeerJS timed out"));
          return;
        }

        window.setTimeout(check, 50);
      };

      check();
    });
  }
})();

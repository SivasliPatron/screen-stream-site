(function () {
  const config = window.STREAM_CONFIG || {
    roomId: "screen-stream-4f8a9f9c8ef44d18",
    senderKey: ""
  };

  const ROOM_ID = config.roomId;
  const SENDER_PEER_ID = `${ROOM_ID}-sender`;
  const RETRY_MS = 2500;

  const video = document.querySelector("#streamVideo");
  const emptyState = document.querySelector("#emptyState");
  const emptyTitle = document.querySelector("#emptyTitle");
  const statusText = document.querySelector("#statusText");
  const muteButton = document.querySelector("#muteButton");
  const muteText = document.querySelector("#muteText");
  const volumeOnIcon = document.querySelector("#volumeOnIcon");
  const volumeOffIcon = document.querySelector("#volumeOffIcon");

  const state = {
    peer: null,
    controlConnection: null,
    reconnectTimer: null,
    muted: true,
    hasAudio: false,
    isLive: false
  };

  video.controls = false;
  video.muted = state.muted;
  video.addEventListener("contextmenu", (event) => event.preventDefault());
  muteButton.addEventListener("click", toggleMute);

  waitForPeerLibrary().then(startViewer).catch(() => {
    setEmpty("Verbindung nicht moeglich");
    setStatus("PeerJS konnte nicht geladen werden");
  });

  function startViewer() {
    state.peer = new Peer(undefined, {
      debug: 1,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" }
        ]
      }
    });

    state.peer.on("open", () => {
      setStatus("Suche Stream");
      connectToSender();
    });

    state.peer.on("call", (call) => {
      call.answer();
      call.on("stream", (stream) => {
        video.srcObject = stream;
        state.hasAudio = stream.getAudioTracks().length > 0;
        state.isLive = true;
        emptyState.hidden = true;
        video.classList.add("is-live");
        setStatus("Live");
        updateMuteButton();
        video.play().catch(() => setStatus("Bereit"));
      });

      call.on("close", () => {
        stopVideo("Warte auf Stream", "Sender verbunden");
      });

      call.on("error", () => {
        stopVideo("Warte auf Stream", "Verbindung unterbrochen");
      });
    });

    state.peer.on("disconnected", () => {
      setStatus("Verbindung wird erneuert");
      state.peer.reconnect();
    });

    state.peer.on("error", () => {
      scheduleReconnect();
    });

    updateMuteButton();
  }

  function connectToSender() {
    clearTimeout(state.reconnectTimer);

    if (!state.peer || state.peer.disconnected || state.peer.destroyed) {
      scheduleReconnect();
      return;
    }

    closeControlConnection();

    const connection = state.peer.connect(SENDER_PEER_ID, {
      reliable: true,
      metadata: { role: "viewer" }
    });

    state.controlConnection = connection;

    connection.on("open", () => {
      setStatus("Sender verbunden");
      setEmpty("Warte auf Stream");
      connection.send({ type: "viewer-ready", viewerId: state.peer.id });
    });

    connection.on("data", (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "offline") {
        stopVideo("Stream ist offline", "Sender offline");
      }

      if (message.type === "waiting") {
        stopVideo("Warte auf Stream", "Sender verbunden");
      }

      if (message.type === "live") {
        setStatus("Verbinde");
      }
    });

    connection.on("close", () => {
      stopVideo("Stream ist offline", "Sender offline");
      scheduleReconnect();
    });

    connection.on("error", () => {
      setStatus("Sender offline");
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectToSender, RETRY_MS);
  }

  function closeControlConnection() {
    if (!state.controlConnection) {
      return;
    }

    state.controlConnection.close();
    state.controlConnection = null;
  }

  function stopVideo(emptyMessage, statusMessage) {
    video.srcObject = null;
    state.hasAudio = false;
    state.isLive = false;
    video.classList.remove("is-live");
    emptyState.hidden = false;
    setEmpty(emptyMessage);
    setStatus(statusMessage);
    updateMuteButton();
  }

  function toggleMute() {
    state.muted = !state.muted;
    video.muted = state.muted;
    updateMuteButton();
    video.play().catch(() => {});
  }

  function updateMuteButton() {
    video.muted = state.muted;
    muteButton.disabled = state.isLive && !state.hasAudio;
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

  function setStatus(text) {
    statusText.textContent = text;
  }

  function setEmpty(text) {
    emptyTitle.textContent = text;
    emptyState.hidden = false;
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

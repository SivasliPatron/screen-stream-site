(function () {
  const config = window.STREAM_CONFIG || {
    roomId: "screen-stream-4f8a9f9c8ef44d18",
    senderKey: ""
  };

  const ROOM_ID = config.roomId;
  const SENDER_PEER_ID = `${ROOM_ID}-sender`;
  const RETRY_MS = 2500;
  const READY_MS = 3000;
  const OFFER_RETRY_MS = 9000;
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:openrelay.metered.ca:80" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ];

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
    rtc: null,
    remoteStream: null,
    pendingCandidates: [],
    reconnectTimer: null,
    readyTimer: null,
    offerTimer: null,
    rtcStartedAt: 0,
    muted: true,
    hasAudio: false,
    isLive: false,
    wantsLive: false
  };

  video.controls = false;
  video.muted = state.muted;
  video.addEventListener("contextmenu", (event) => event.preventDefault());
  muteButton.addEventListener("click", toggleMute);
  window.addEventListener("beforeunload", () => {
    if (state.peer && !state.peer.destroyed) {
      state.peer.destroy();
    }
  });

  waitForPeerLibrary().then(startViewer).catch(() => {
    setEmpty("Verbindung nicht moeglich");
    setStatus("PeerJS konnte nicht geladen werden");
  });

  function startViewer() {
    state.peer = new Peer(undefined, {
      debug: 1,
      config: { iceServers: ICE_SERVERS }
    });

    state.peer.on("open", () => {
      setStatus("Suche Stream");
      connectToSender();
    });

    state.peer.on("disconnected", () => {
      setStatus("Verbindung wird erneuert");
      state.peer.reconnect();
    });

    state.peer.on("error", () => {
      setStatus("Sender wird gesucht");
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
      sendReady();
      startReadyLoop();
    });

    connection.on("data", (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "waiting") {
        state.wantsLive = false;
        resetRtc();
        setEmpty("Warte auf Stream");
        setStatus("Sender verbunden");
      }

      if (message.type === "offline") {
        state.wantsLive = false;
        resetRtc();
        setEmpty("Sender wird gesucht");
        setStatus("Sender offline");
      }

      if (message.type === "live") {
        state.wantsLive = true;
        setStatus("Verbinde");
        requestOffer();
      }

      if (message.type === "sender-answer") {
        handleAnswer(message.payload);
      }

      if (message.type === "sender-ice") {
        addRemoteCandidate(message.payload);
      }
    });

    connection.on("close", () => {
      if (state.controlConnection !== connection) {
        return;
      }

      state.controlConnection = null;
      stopReadyLoop();
      state.wantsLive = false;
      resetRtc();
      setEmpty("Sender wird gesucht");
      setStatus("Sender offline");
      scheduleReconnect();
    });

    connection.on("error", () => {
      if (state.controlConnection !== connection) {
        return;
      }

      stopReadyLoop();
      setStatus("Sender offline");
      scheduleReconnect();
    });
  }

  function requestOffer() {
    if (state.offerTimer) {
      return;
    }

    state.offerTimer = window.setTimeout(() => {
      state.offerTimer = null;
      createOffer();
    }, 200);
  }

  async function createOffer() {
    if (!state.controlConnection || !state.controlConnection.open || !state.peer || !state.peer.id) {
      return;
    }

    if (state.rtc && !["failed", "closed", "disconnected"].includes(state.rtc.connectionState)) {
      if (Date.now() - state.rtcStartedAt < OFFER_RETRY_MS) {
        return;
      }

      resetRtc();
    }

    const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.rtc = peerConnection;
    state.remoteStream = new MediaStream();
    state.pendingCandidates = [];
    state.rtcStartedAt = Date.now();

    peerConnection.addTransceiver("video", { direction: "recvonly" });
    peerConnection.addTransceiver("audio", { direction: "recvonly" });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendControl({ type: "viewer-ice", payload: event.candidate });
      }
    };

    peerConnection.ontrack = (event) => {
      if (state.rtc !== peerConnection) {
        return;
      }

      if (!state.remoteStream.getTracks().includes(event.track)) {
        state.remoteStream.addTrack(event.track);
      }

      video.srcObject = state.remoteStream;
      state.hasAudio = state.remoteStream.getAudioTracks().length > 0;
      state.isLive = true;
      emptyState.hidden = true;
      video.classList.add("is-live");
      setStatus("Live");
      updateMuteButton();
      video.play().catch(() => setStatus("Bereit"));
    };

    peerConnection.onconnectionstatechange = () => {
      if (state.rtc !== peerConnection) {
        return;
      }

      if (["failed", "closed", "disconnected"].includes(peerConnection.connectionState)) {
        resetRtc();

        if (state.wantsLive) {
          setStatus("Verbinde neu");
          requestOffer();
        }
      }
    };

    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      sendControl({ type: "viewer-offer", payload: peerConnection.localDescription });
    } catch {
      resetRtc();
      setStatus("Verbindung fehlgeschlagen");
    }
  }

  async function handleAnswer(answer) {
    if (!state.rtc || !answer) {
      return;
    }

    try {
      await state.rtc.setRemoteDescription(answer);

      for (const candidate of state.pendingCandidates.splice(0)) {
        await state.rtc.addIceCandidate(candidate).catch(() => {});
      }
    } catch {
      resetRtc();
      setStatus("Verbindung fehlgeschlagen");
    }
  }

  async function addRemoteCandidate(candidate) {
    if (!candidate || !state.rtc) {
      return;
    }

    if (!state.rtc.remoteDescription) {
      state.pendingCandidates.push(candidate);
      return;
    }

    await state.rtc.addIceCandidate(candidate).catch(() => {});
  }

  function resetRtc() {
    if (state.rtc) {
      state.rtc.onicecandidate = null;
      state.rtc.ontrack = null;
      state.rtc.onconnectionstatechange = null;
      state.rtc.close();
    }

    state.rtc = null;
    state.remoteStream = null;
    state.pendingCandidates = [];
    state.rtcStartedAt = 0;
    state.hasAudio = false;
    state.isLive = false;
    video.srcObject = null;
    video.classList.remove("is-live");
    emptyState.hidden = false;
    updateMuteButton();
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectToSender, RETRY_MS);
  }

  function closeControlConnection() {
    if (!state.controlConnection) {
      return;
    }

    stopReadyLoop();
    state.controlConnection.close();
    state.controlConnection = null;
  }

  function sendReady() {
    sendControl({ type: "viewer-ready", viewerId: state.peer && state.peer.id });
  }

  function sendControl(message) {
    if (state.controlConnection && state.controlConnection.open) {
      state.controlConnection.send(message);
    }
  }

  function startReadyLoop() {
    stopReadyLoop();
    state.readyTimer = window.setInterval(() => {
      sendReady();

      if (state.wantsLive && !state.isLive) {
        requestOffer();
      }
    }, READY_MS);
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

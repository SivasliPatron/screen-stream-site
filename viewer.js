(function () {
  const ROOM_ID = "main";
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
    socket: null,
    viewerId: "",
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
    wantsLive: false,
    senderOnline: false
  };

  video.controls = false;
  video.muted = state.muted;
  video.addEventListener("contextmenu", (event) => event.preventDefault());
  muteButton.addEventListener("click", toggleMute);
  window.addEventListener("beforeunload", () => {
    if (state.socket) {
      state.socket.close();
    }
  });

  connectSocket();
  updateMuteButton();

  function connectSocket() {
    clearTimeout(state.reconnectTimer);
    closeSocket();
    setStatus("Verbindung wird aufgebaut");

    const socket = new WebSocket(getSocketUrl("viewer"));
    state.socket = socket;

    socket.addEventListener("open", () => {
      setStatus("Sender wird gesucht");
      setEmpty("Sender wird gesucht");
      sendReady();
      startReadyLoop();
    });

    socket.addEventListener("message", (event) => {
      const message = parseMessage(event.data);

      if (message.type === "welcome") {
        state.viewerId = message.viewerId || "";
      }

      if (message.type === "stream-state") {
        handleStreamState(message);
      }

      if (message.type === "answer") {
        handleAnswer(message.payload);
      }

      if (message.type === "ice") {
        addRemoteCandidate(message.payload);
      }
    });

    socket.addEventListener("close", () => {
      if (state.socket !== socket) {
        return;
      }

      stopReadyLoop();
      resetRtc();
      state.socket = null;
      state.senderOnline = false;
      state.wantsLive = false;
      setEmpty("Sender wird gesucht");
      setStatus("Verbindung getrennt");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      setStatus("Verbindung gestoert");
    });
  }

  function handleStreamState(message) {
    state.senderOnline = Boolean(message.online);
    state.wantsLive = Boolean(message.live);

    if (!state.senderOnline) {
      resetRtc();
      setEmpty("Sender wird gesucht");
      setStatus("Sender offline");
      return;
    }

    if (!state.wantsLive) {
      resetRtc();
      setEmpty("Warte auf Stream");
      setStatus("Sender verbunden");
      return;
    }

    setStatus("Verbinde");
    requestOffer();
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
    if (!isSocketOpen()) {
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

    peerConnection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        send({ type: "ice", payload: event.candidate });
      }
    });

    peerConnection.addEventListener("track", (event) => {
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
    });

    peerConnection.addEventListener("connectionstatechange", () => {
      if (state.rtc !== peerConnection) {
        return;
      }

      if (["failed", "closed", "disconnected"].includes(peerConnection.connectionState)) {
        resetRtc();

        if (state.senderOnline && state.wantsLive) {
          setStatus("Verbinde neu");
          requestOffer();
        }
      }
    });

    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      send({ type: "offer", payload: peerConnection.localDescription });
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
    if (isSocketOpen()) {
      state.socket.send(JSON.stringify(message));
    }
  }

  function isSocketOpen() {
    return state.socket && state.socket.readyState === WebSocket.OPEN;
  }

  function startReadyLoop() {
    stopReadyLoop();
    state.readyTimer = window.setInterval(() => {
      sendReady();

      if (state.senderOnline && state.wantsLive && !state.isLive) {
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

  function getSocketUrl(role) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      role,
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

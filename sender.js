(function () {
  const ROOM_ID = "main";
  const LIVE_PULSE_MS = 3000;
  const VIDEO_MAX_BITRATE = 2200000;
  const AUDIO_MAX_BITRATE = 64000;
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
    viewers: new Set(),
    rtcPeers: new Map(),
    pendingCandidates: new Map(),
    liveTimer: null,
    reconnectTimer: null,
    accepted: false
  };

  viewerUrl.textContent = `Zuschauer-Link: ${window.location.origin}/`;
  startButton.addEventListener("click", startStream);
  stopButton.addEventListener("click", stopStream);
  window.addEventListener("beforeunload", () => {
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
    state.socket = socket;

    socket.addEventListener("message", (event) => {
      const message = parseMessage(event.data);

      if (message.type === "welcome") {
        state.accepted = true;
        state.viewers = new Set(message.viewerIds || []);
        updateViewerCount();
        startButton.disabled = Boolean(state.stream);
        stopButton.disabled = !state.stream;
        setStatus(state.stream ? "Live" : "Bereit");
        sendStreamState(Boolean(state.stream));
      }

      if (message.type === "error") {
        setStatus(message.error || "Sender-Verbindung abgelehnt");
        startButton.disabled = true;
      }

      if (message.type === "viewer-joined") {
        state.viewers.add(message.viewerId);
        updateViewerCount();
        sendStreamState(Boolean(state.stream));
      }

      if (message.type === "viewer-left") {
        state.viewers.delete(message.viewerId);
        closeViewerRtc(message.viewerId);
        state.pendingCandidates.delete(message.viewerId);
        updateViewerCount();
      }

      if (message.type === "viewer-ready") {
        sendStreamState(Boolean(state.stream));
      }

      if (message.type === "offer") {
        handleViewerOffer(message.viewerId, message.payload);
      }

      if (message.type === "ice") {
        addRemoteCandidate(message.viewerId, message.payload);
      }
    });

    socket.addEventListener("close", () => {
      if (state.socket !== socket) {
        return;
      }

      state.socket = null;
      state.accepted = false;
      stopLivePulse();

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

    previewVideo.srcObject = state.stream;
    tuneCaptureTracks();
    previewEmpty.hidden = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Live");

    state.stream.getTracks().forEach((track) => {
      track.addEventListener("ended", stopStream, { once: true });
    });

    sendStreamState(true);
    startLivePulse();
  }

  function stopStream() {
    if (!state.stream) {
      return;
    }

    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    previewVideo.srcObject = null;
    previewEmpty.hidden = false;
    startButton.disabled = !state.accepted;
    stopButton.disabled = true;

    for (const viewerId of Array.from(state.rtcPeers.keys())) {
      closeViewerRtc(viewerId);
    }

    state.pendingCandidates.clear();
    stopLivePulse();
    sendStreamState(false);
    setStatus(state.accepted ? "Bereit" : "Sender offline");
  }

  async function handleViewerOffer(viewerId, offer) {
    if (!state.stream || !viewerId) {
      sendStreamState(false);
      return;
    }

    if (!offer) {
      return;
    }

    closeViewerRtc(viewerId);
    state.pendingCandidates.set(viewerId, []);

    const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.rtcPeers.set(viewerId, peerConnection);

    state.stream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, state.stream);
    });

    applyPeerLimits(peerConnection);

    peerConnection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        send({ type: "ice", viewerId, payload: event.candidate });
      }
    });

    peerConnection.addEventListener("connectionstatechange", () => {
      if (state.rtcPeers.get(viewerId) !== peerConnection) {
        return;
      }

      if (["failed", "closed", "disconnected"].includes(peerConnection.connectionState)) {
        closeViewerRtc(viewerId);
        sendStreamState(Boolean(state.stream));
      }
    });

    try {
      await peerConnection.setRemoteDescription(offer);
      await flushPendingCandidates(viewerId, peerConnection);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      send({ type: "answer", viewerId, payload: peerConnection.localDescription });
    } catch {
      closeViewerRtc(viewerId);
      sendStreamState(Boolean(state.stream));
    }
  }

  async function addRemoteCandidate(viewerId, candidate) {
    if (!candidate || !viewerId) {
      return;
    }

    const peerConnection = state.rtcPeers.get(viewerId);

    if (!peerConnection || !peerConnection.remoteDescription) {
      const pending = state.pendingCandidates.get(viewerId) || [];
      pending.push(candidate);
      state.pendingCandidates.set(viewerId, pending);
      return;
    }

    await peerConnection.addIceCandidate(candidate).catch(() => {});
  }

  async function flushPendingCandidates(viewerId, peerConnection) {
    const pending = state.pendingCandidates.get(viewerId) || [];
    state.pendingCandidates.set(viewerId, []);

    for (const candidate of pending) {
      await peerConnection.addIceCandidate(candidate).catch(() => {});
    }
  }

  function closeViewerRtc(viewerId) {
    const peerConnection = state.rtcPeers.get(viewerId);

    if (!peerConnection) {
      return;
    }

    peerConnection.close();
    state.rtcPeers.delete(viewerId);
  }

  function sendStreamState(live) {
    send({
      type: "stream-state",
      payload: { live }
    });
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

  function startLivePulse() {
    stopLivePulse();
    state.liveTimer = window.setInterval(() => {
      sendStreamState(Boolean(state.stream));
    }, LIVE_PULSE_MS);
  }

  function stopLivePulse() {
    if (state.liveTimer) {
      window.clearInterval(state.liveTimer);
      state.liveTimer = null;
    }
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

  function applyPeerLimits(peerConnection) {
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
        parameters.encodings[0].maxFramerate = 60;
      }

      if (sender.track.kind === "audio") {
        parameters.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
      }

      sender.setParameters(parameters).catch(() => {});
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

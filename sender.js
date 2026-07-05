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
    rtcPeers: new Map(),
    pendingCandidates: new Map(),
    liveTimer: null
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
      config: { iceServers: ICE_SERVERS }
    });

    state.peer.on("open", () => {
      setStatus("Bereit");
      startButton.disabled = false;
    });

    state.peer.on("connection", (connection) => {
      const existing = state.viewerConnections.get(connection.peer);

      if (existing && existing !== connection) {
        existing.close();
      }

      state.viewerConnections.set(connection.peer, connection);
      updateViewerCount();

      connection.on("open", () => {
        sendToViewer(connection.peer, { type: state.stream ? "live" : "waiting" });
      });

      connection.on("data", (message) => {
        if (!message || typeof message !== "object") {
          return;
        }

        if (message.type === "viewer-ready") {
          sendToViewer(connection.peer, { type: state.stream ? "live" : "waiting" });
        }

        if (message.type === "viewer-offer") {
          handleViewerOffer(connection.peer, message.payload);
        }

        if (message.type === "viewer-ice") {
          addRemoteCandidate(connection.peer, message.payload);
        }
      });

      connection.on("close", () => {
        if (state.viewerConnections.get(connection.peer) === connection) {
          state.viewerConnections.delete(connection.peer);
          closeViewerRtc(connection.peer);
          state.pendingCandidates.delete(connection.peer);
          updateViewerCount();
        }
      });

      connection.on("error", () => {
        if (state.viewerConnections.get(connection.peer) === connection) {
          state.viewerConnections.delete(connection.peer);
          closeViewerRtc(connection.peer);
          state.pendingCandidates.delete(connection.peer);
          updateViewerCount();
        }
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

    broadcast({ type: "live" });
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
    startButton.disabled = false;
    stopButton.disabled = true;

    for (const viewerId of Array.from(state.rtcPeers.keys())) {
      closeViewerRtc(viewerId);
    }

    state.pendingCandidates.clear();
    stopLivePulse();
    broadcast({ type: "waiting" });
    setStatus("Bereit");
  }

  async function handleViewerOffer(viewerId, offer) {
    if (!state.stream) {
      sendToViewer(viewerId, { type: "waiting" });
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

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendToViewer(viewerId, { type: "sender-ice", payload: event.candidate });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (state.rtcPeers.get(viewerId) !== peerConnection) {
        return;
      }

      if (["failed", "closed", "disconnected"].includes(peerConnection.connectionState)) {
        closeViewerRtc(viewerId);

        if (state.stream && state.viewerConnections.has(viewerId)) {
          window.setTimeout(() => sendToViewer(viewerId, { type: "live" }), 1000);
        }
      }
    };

    try {
      await peerConnection.setRemoteDescription(offer);
      await flushPendingCandidates(viewerId, peerConnection);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendToViewer(viewerId, { type: "sender-answer", payload: peerConnection.localDescription });
    } catch {
      closeViewerRtc(viewerId);
      sendToViewer(viewerId, { type: "live" });
    }
  }

  async function addRemoteCandidate(viewerId, candidate) {
    if (!candidate) {
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

    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    state.rtcPeers.delete(viewerId);
  }

  function sendToViewer(viewerId, message) {
    const connection = state.viewerConnections.get(viewerId);

    if (connection && connection.open) {
      connection.send(message);
    }
  }

  function broadcast(message) {
    for (const [viewerId, connection] of state.viewerConnections) {
      if (connection.open) {
        connection.send(message);
      } else {
        state.viewerConnections.delete(viewerId);
        closeViewerRtc(viewerId);
      }
    }

    updateViewerCount();
  }

  function startLivePulse() {
    stopLivePulse();
    state.liveTimer = window.setInterval(() => {
      if (!state.stream) {
        stopLivePulse();
        return;
      }

      broadcast({ type: "live" });
    }, 3000);
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

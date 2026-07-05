# Screen Stream Site

Eine kleine Web-App fuer Live-Bildschirmstreaming mit eigenem Node/WebSocket-Relay.

## Start

```powershell
npm install
npm start
```

Danach:

- Zuschauer: `http://localhost:3000/`
- Sender: `http://localhost:3000/sender?key=sender-123a88d8f2b64f31`

## Render

Das Repo enthaelt `render.yaml` fuer einen Render Web Service.

Nach dem Deploy:

- Zuschauer: `https://<render-service>.onrender.com/`
- Sender: `https://<render-service>.onrender.com/sender?key=sender-123a88d8f2b64f31`

## Wichtig

Der Sender nimmt den Bildschirm im Browser mit `MediaRecorder` auf und schickt kleine WebM-Chunks ueber WebSocket an den Server. Der Server verteilt diese Chunks an alle Zuschauer. Dadurch funktioniert der Stream ueber normale HTTPS/WSS-Verbindungen, mit etwas mehr Verzoegerung als WebRTC.

Der Standard-Sender-Key kann ueber die Render-Umgebungsvariable `SENDER_KEY` geaendert werden.

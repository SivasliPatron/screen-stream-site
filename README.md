# Screen Stream Site

Eine kleine Web-App fuer Live-Bildschirmstreaming mit eigenem Node/WebSocket-Signaling.

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

Der Server vermittelt nur die WebRTC-Verbindung. Der eigentliche Bildschirmstream laeuft per WebRTC direkt zwischen Sender und Zuschauern oder ueber TURN, wenn direkte Verbindung nicht moeglich ist.

Der Standard-Sender-Key kann ueber die Render-Umgebungsvariable `SENDER_KEY` geaendert werden.

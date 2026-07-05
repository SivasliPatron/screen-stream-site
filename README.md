# GitHub Pages Screen Stream

Diese Version laeuft ohne eigenen Node-Server auf GitHub Pages.

## Dateien

- `index.html` ist der Zuschauer-Link.
- `sender.html?key=sender-123a88d8f2b64f31` ist dein Sender-Link.
- `config.js` enthaelt die Room-ID.

## Wichtig

GitHub Pages kann keinen eigenen Signaling-Server starten. Diese Version nutzt deshalb PeerJS Cloud fuer die WebRTC-Verbindungsvermittlung. Der eigentliche Bildschirmstream laeuft direkt per WebRTC zwischen deinem Browser und den Zuschauern.

GitHub Pages ist statisch. Der Sender-Key ist deshalb kein echter Passwortschutz gegen technisch versierte Personen, weil statische Dateien oeffentlich sind. Fuer echten Zugriffsschutz braucht die App einen richtigen Server.

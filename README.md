# Revalida Mastery

## Handwriting OCR setup

Online handwriting recognition uses Google Cloud Vision. The server requires Node.js 18 or newer. Enable the Cloud Vision API in a Google Cloud project, create an API key restricted to that API, and set the key on the machine running the app. Never put the key in `script.js` or another browser file.

In PowerShell:

```powershell
$env:GOOGLE_CLOUD_VISION_API_KEY = "your-restricted-google-api-key"
node server.js
```

Then open `http://localhost:8080`. On a deployed app, run `server.js` on a Node.js host that supports outbound HTTPS requests and set `GOOGLE_CLOUD_VISION_API_KEY` as a server environment variable.

On mobile, **Take photo / upload notes** opens the rear camera when supported. The app resizes the image and applies a light grayscale/contrast enhancement before recognition. Use even lighting, keep the page flat, and frame the writing closely. When online, photos are sent to Google Cloud Vision. If that service is unavailable, or when offline, the app falls back to local English OCR; handwriting recognition is less accurate in that mode. Flashcards and study progress remain stored on the device and available offline.

Card status follows your review choice: press **Got it** without flipping to mark it **mastered**; flip to reveal the answer and then press **Got it** to mark it **learning**; press **Review again** to mark it **needs**. Cards marked **needs** return later in the study queue. The Study screen and Deck both show status counts, and Study shows the latest result after each answer. Older cards without this status start as **learning**, avoiding stale saved streaks or flags from affecting their status.

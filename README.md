# GestCrypt (Phase 1: client-side prototype)

Hand gesture -> quantized signature -> PBKDF2 -> AES-256-GCM file encryption. Everything runs in the browser; no key or file leaves the machine.

## Run
Camera access needs `localhost`.

```
cd gestcrypt
python3 -m http.server 8000      # or: npx serve
```
Open http://localhost:8000 in Chrome and allow the camera.

## Pipeline
1. MediaPipe Hand Landmarker gives 21 3D world landmarks
2. Scale/rotation-invariant features: finger extension ratios + spread angles
3. Median over 25 frames, quantized with dead zones (ambiguous poses are rejected, not guessed)
4. `signature + PIN` -> PBKDF2-HMAC-SHA256 (600k iterations, random salt) -> 256-bit key
5. AES-256-GCM; salt, IV and filename live in the file header, which is authenticated as AAD

## Phase 2 (planned)
Server (auth, storage of ciphertext only), ECDH key exchange, ECDSA signatures, pentesting.

# ScreenHelper AI for Android

This is a native Expo client built with EAS. The web app remains at the repository root.

## What the Android app does

- Signs in with Supabase email and password or native Google Credential Manager; the session is stored with Android Keystore-backed SecureStore.
- Starts Android MediaProjection only after the user taps **Start screen sharing** and accepts Android's system consent.
- Keeps capture in a foreground service with a persistent notification and a **Stop sharing** action.
- Samples a JPEG frame locally about once per second, downscaled to at most 2000 pixels on its longest side. It does not record audio or save frames to storage.
- Shows a frame preview. A frame and the typed question go to the ScreenHelper server and Coarena only after the user taps **Get an answer**.
- Uses the existing authenticated M-Pesa checkout and payment-status endpoints. The server verifies payment with Lipwa before adding credits.

Android may offer capture of one app or the whole display, depending on Android version and device. On supported devices, place ScreenHelper and the other app in split screen. Apps that prevent screenshots can appear blank; the app does not bypass that protection. Stop capture in ScreenHelper or from Android's screen-sharing controls.

## Configure and run

1. Copy `.env.example` to `.env`. Set the public ScreenHelper API URL, Supabase URL, Supabase publishable key, and Google Web OAuth client ID. Production endpoints must use HTTPS. Never put Coarena, Supabase secret/service-role, or Lipwa keys in this mobile app.
2. Install dependencies with `npm install`.
3. For a local Android development build, run `npx expo run:android` after installing the Android SDK. Expo Go cannot load the custom MediaProjection module.
4. Sign in to Expo with `npx eas-cli login`, connect the project with `npx eas-cli init`, and set all four `EXPO_PUBLIC_*` values in the Expo project's `preview` and `production` environments.
5. Create an installable APK with `npx eas-cli build --platform android --profile preview`. The `production` profile creates an Android App Bundle for store upload.

For native Google sign-in, enable Google in Supabase Auth and use the same Web OAuth client ID in Supabase and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. In Google Cloud, create an Android OAuth client for package `com.screenhelperai.mobile` and the SHA-1 signing fingerprint of the APK. The current EAS preview keystore SHA-1 is `C1:05:BE:58:7F:DA:80:2A:E3:68:5F:57:C2:DC:78:3A:F1:D1:F7:2B`. If the Play Store app uses a different app-signing certificate, register its SHA-1 too. The app uses Android Credential Manager and does not send Google sign-in through a browser.

For password recovery, add `screenhelperai://auth/callback` to Supabase Auth's allowed redirect URLs. Supabase sends a recovery email through the configured Resend SMTP server, and the link opens the app's new-password screen.

The API server must already be deployed with Supabase and Lipwa configured. Expo SDK 58 is the current stable SDK and compiles against Android API 37; the project retains SDK 58's target API 36 default. EAS links and credentials belong to the Expo account, so cloud builds need this project and its public environment values configured there.

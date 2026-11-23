# Flow for iPhone and iPad

A SwiftUI app for Flow. The DevOps board and cards are native and use the REST API (`/api/v1`). The
mind map, timeline, AgentFlow and the 3D office are the web app in a `WKWebView`, already signed in.

Requirements: Xcode 26 or newer. The app targets iOS 18 and runs on both iPhone and iPad.

## Run it

1. Start Flow locally from the repository root (`npm start`), or use any Flow server.
2. Open `apps/ios/Flow.xcodeproj`, choose an iPhone or iPad simulator and run it.
3. On the sign-in screen, enter the server address (for example `localhost:4317`) and sign in.

To run on a real device, copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` and set your
`DEVELOPMENT_TEAM`. Git ignores that file.

## How sign-in works

The app adds no server routes. It uses the ones the web app already has:

1. A hidden `WKWebView` loads a page from the server's own origin (`Services/WebBridge.swift`). Sign-in
   requests go through that page's `fetch()`, so they carry the right `Origin`, and the cookies Flow
   sets are stored in the app's website data store.
2. **Continue with OneProfileID** runs the device flow (`/api/auth/device/start` and `/poll`). The
   approval page opens in an `ASWebAuthenticationSession`, which means passkeys and an existing
   OneProfileID session in Safari both work. **Sign in with email** posts to `/api/auth/sign-in` and
   `/api/auth/two-factor`. A server in local mode needs neither.
3. With that web session, the app makes its own API key with `POST /api/keys`: all environments,
   read and write, valid for one year, named `Flow app · <model> <device id>`. The key is kept in the
   Keychain. Signing in again on the same device revokes that device's earlier key first. The key is
   listed, and can be revoked, in Settings › Connect on the web.
4. The native views call `/api/v1` with that key. The web views share the website data store, so
   they open signed in.

Signing out revokes the key, ends the web session and clears the website data.

## Layout

| Path | What it holds |
| --- | --- |
| `Flow/App` | The app entry point and `AppModel` (server, credential, environments) |
| `Flow/Services` | `FlowAPI` (REST v1), `WebBridge`, `AuthService`, `Keychain` |
| `Flow/Model` | API models and `BoardStore` |
| `Flow/Views` | Sign-in, board, card detail, the web canvas and settings |
| `Config` | `Base.xcconfig`, `Info.plist` (local-network http for development) |

The project uses Xcode's synchronized folders, so a new file under `Flow/` is part of the app without
editing the project file.

## Testing in the simulator without tapping

Debug builds read two launch arguments: `-autoSignIn YES` continues as the user who is already
signed in (or the local-mode user), and `-startTab canvas|settings` opens that tab. Any launch
argument can also set the server for that launch:

```sh
xcrun simctl launch booted com.flygonlc.flow -server http://localhost:4317 -autoSignIn YES
```

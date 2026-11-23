# Flow for iPhone and iPad

A SwiftUI app for Flow. The inbox, the DevOps board, cards (create and edit), notifications and widgets are
native. The mind map, timeline, AgentFlow and the 3D office are the web app in a `WKWebView`, already signed
in. What it does and the server routes it uses: [docs/ios-app.md](../../docs/ios-app.md).

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
   read and write plus the `device` scope that `/api/app` needs, valid for one year, named
   `Flow app · <model> <device id>`. The key is kept in the
   Keychain. Signing in again on the same device revokes that device's earlier key first. The key is
   listed, and can be revoked, in Settings › Connect on the web.
4. The native views call `/api/v1` with that key. The web views share the website data store, so
   they open signed in.

Signing out revokes the key, ends the web session and clears the website data.

## Layout

| Path | What it holds |
| --- | --- |
| `Flow/App` | The app entry point and `AppModel` (server, credential, environments, routing) |
| `Flow/Services` | `FlowAPI` (REST v1 and `/api/app`), `WebBridge`, `AuthService`, `Keychain`, `Push` |
| `Flow/Model` | API models, `BoardStore`, `InboxStore` (also writes the widget snapshot, and runs the background refresh) |
| `Flow/Views` | Inbox, board, card detail and editor, the web canvas, settings |
| `FlowWidgets` | The WidgetKit extension: "Waiting on you" (home and lock screen) and "Doing" |
| `Shared` | Code both targets build: the widget snapshot in the App Group `group.com.flygonlc.flow` |
| `Config` | xcconfigs, Info.plists and entitlements (push, App Group) |

The project uses Xcode's synchronized folders, so a new file under `Flow/`, `FlowWidgets/` or `Shared/` is
part of its targets without editing the project file.

## Notifications

Push notifications need a server with APNs set up ("Push notifications" in
[docs/self-hosting.md](../../docs/self-hosting.md)), and a build signed by the same team with the same bundle
id as `APNS_TOPIC`. Debug builds register as sandbox devices, Release builds as production. The simulator
can't get real pushes, but `xcrun simctl push booted com.flygonlc.flow payload.json` shows how one looks
once notifications are allowed.

## TestFlight

1. Put your team in `Config/Local.xcconfig` (`DEVELOPMENT_TEAM = …`).
2. Raise `CURRENT_PROJECT_VERSION` in `Config/Shared.xcconfig` (every upload needs a new build number), and
   `MARKETING_VERSION` for a new version.
3. Archive, with automatic signing registering the bundle ids, the App Group and push:

   ```sh
   xcodebuild -project Flow.xcodeproj -scheme Flow -configuration Release -destination 'generic/platform=iOS' \
     -archivePath build/Flow.xcarchive -allowProvisioningUpdates archive
   ```

4. Copy the archive into `~/Library/Developer/Xcode/Archives/<date>/`, open it (Xcode's Organizer), and choose
   Distribute App › TestFlight Internal Only. The first upload also creates the app in App Store Connect.

`ITSAppUsesNonExemptEncryption` is `NO` (the app only uses HTTPS), so builds don't wait on export compliance.

## Testing in the simulator without tapping

Debug builds read three launch arguments. `-autoSignIn YES` continues as the user who is already
signed in (or the local-mode user). `-startTab inbox|canvas|settings` opens that tab. `-openCard <env>/<id>`
opens a card the way a notification or widget tap does. Any launch
argument can also set the server for that launch:

```sh
xcrun simctl launch booted com.flygonlc.flow -server http://localhost:4317 -autoSignIn YES
```

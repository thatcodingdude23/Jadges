# Jadges for Kettu

## Install

1. Open **Kettu Settings**.
2. Open **Plugins**.
3. Add a plugin from URL.
4. Paste:

```text
https://raw.githubusercontent.com/thatcodingdude23/Jadges/main/kettu-plugin/
```

5. Enable **Jadges Badges for Kettu** and reload Discord when prompted.

## Authorize profile reporting

1. Sign in to the Jadges website dashboard.
2. Find **Plugin authorization token** and select **Generate token**.
3. Copy the token immediately; the website does not show it again later.
4. Open the Jadges plugin settings inside Kettu.
5. Paste the token and select **Save token**.

The token is tied to the logged-in Discord account, expires after 90 days, and can only update that account's profile reports. Rotating or revoking it on the website invalidates the old token immediately.

## Included support

- Jadges profile badges
- Native Discord badge ordering
- Left/right badge placement
- Hidden badge synchronization
- Nitro appearance presets
- Jadges account-theme synchronization
- User-bound authorization for profile reporting

The Kettu entry point loads the maintained Jadges mobile modules, so mobile fixes are shared with the Revenge build without requiring separate feature implementations.

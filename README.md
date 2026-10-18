Skwiggle Mint Pin

Skwiggle Mint Pin is a small proxy used when someone mints a drawing from the Skwiggle game. It is for the owner.

It takes artwork from the app and pins it to a storage service so it can be minted. It accepts either of two kinds of credentials. A health route tests the credential without minting anything, and failures are logged on the server so the cause is easy to find.

This app is checked every morning by Control Troll.

Latest change. Created the pin proxy for minting. It now accepts two kinds of credentials, adds a health check that tests the credential, and logs the real cause when pinning fails. Triggered a redeploy on Railway.

See CHANGELOG.md for the full history.

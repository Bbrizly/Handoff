# Third-Party Notices

`hn` is an independent implementation.

## EnvHaven

EnvHaven (`envhaven/envhaven`) was studied as an architectural reference for the local-editor + remote-execution workflow. No EnvHaven source code is vendored in this repository.

## Mutagen

`hn` downloads the pinned official Mutagen v0.18.1 release archive at runtime from the upstream GitHub release, verifies it against the upstream `SHA256SUMS`, and stores the executable plus `mutagen-agents.tar.gz` under the user's `~/.hn/bin` directory. Mutagen binaries are not committed or redistributed in this repository. Mutagen licensing differs by build; review the upstream license before packaging or redistributing Mutagen as part of a public/commercial installer.

## Zellij

`hn` downloads the official Zellij release archive on the controller, verifies its SHA-256, extracts it locally, and copies the Zellij binary to the worker. Zellij is MIT licensed. The repository does not vendor or commit Zellij binaries.

The current prototype pins Zellij v0.45.0 for reproducibility.

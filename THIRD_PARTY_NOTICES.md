# Third-Party Notices

`hn` is an independent implementation.

## EnvHaven

EnvHaven (`envhaven/envhaven`) was studied as an architectural reference for the local-editor + remote-execution workflow. No EnvHaven source code is vendored in this repository.

## Mutagen

`hn` downloads the pinned official Mutagen v0.18.1 release archive at runtime from the upstream GitHub release, verifies it against the upstream `SHA256SUMS`, and stores the executable plus `mutagen-agents.tar.gz` under the user's `~/.hn/bin` directory. Mutagen binaries are not committed or redistributed in this repository. Mutagen licensing differs by build; review the upstream license before packaging or redistributing Mutagen as part of a public/commercial installer.

## Herdr

`hn` downloads the official Herdr release from the upstream GitHub release, verifies its SHA-256 on the controller, and copies it to the worker under `~/.hn/bin/herdr/<version>/`. Herdr is Apache-2.0 licensed. The repository does not vendor or commit Herdr binaries.

The persistent desk pins Herdr v0.8.2. The Windows release is a bundle: `herdr.exe` plus Microsoft's ConPTY components, which carry their own notices inside the archive. Handoff installs the bundle whole rather than lifting the executable out of it.

Herdr is used as a replaceable backend behind Handoff's persistence boundary. No Herdr source is copied into this repository.

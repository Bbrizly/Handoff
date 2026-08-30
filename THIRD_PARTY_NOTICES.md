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

### Windows thin-client compatibility

Official Herdr v0.8.2 does not support Windows as a `herdr --remote` target host. For the experimental local-client path, Handoff pins the unofficial Apache-2.0 `hdosys/herdr-win` release `v2026.08.27.5`, which is based on Herdr v0.8.2 and publishes matching macOS/Linux clients plus a Windows portable runtime from one protocol-compatible build.

Handoff downloads those release artifacts only from the immutable GitHub release, verifies exact pinned SHA-256 digests before execution, and does not commit or vendor the binaries. The normal persistent Handoff server remains the official Herdr v0.8.2 runtime under `~/.hn/bin/herdr/0.8.2/`; the herdr-win Windows runtime is used only as the Windows `remote-client-bridge` needed by the local Mac/Linux thin client. Handoff refuses to overwrite a different existing `~/.herdr/remote` runtime.

The herdr-win project documents its Windows executables as currently unsigned. This compatibility dependency is intentionally replaceable and should be removed when upstream Herdr provides equivalent Windows remote-host support.

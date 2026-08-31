# Third-Party Notices

`hn` is an independent implementation.

## EnvHaven

EnvHaven (`envhaven/envhaven`) was studied as an architectural reference for the local-editor + remote-execution workflow. No EnvHaven source code is vendored in this repository.

## Mutagen

`hn` downloads the pinned official Mutagen v0.18.1 release archive at runtime from the upstream GitHub release, verifies it against the upstream `SHA256SUMS`, and stores the executable plus `mutagen-agents.tar.gz` under the user's `~/.hn/bin` directory. Mutagen binaries are not committed or redistributed in this repository. Mutagen licensing differs by build; review the upstream license before packaging or redistributing Mutagen as part of a public/commercial installer.

## Herdr

The default persistent desk uses the official Herdr v0.8.2 release from `herdrdev/herdr`. Handoff verifies the pinned SHA-256 on the controller and installs it under `~/.hn/bin/herdr/0.8.2/`. Herdr v0.8.2 is Apache-2.0 licensed. The Windows release is kept as its full upstream bundle so its Microsoft ConPTY components and bundled notices remain together.

The default local-renderer path also uses the same official Herdr v0.8.2 client. Handoff owns only the local Unix-socket forwarding/relay layer and the connect-only Windows bridge to the already-running official server.

### Responsive mirror dogfood runtime

`HN_HERDR_TRANSPORT=mirror` is an explicit experimental path and does **not** use the official v0.8.2 protocol. It runs a separate, non-colliding Herdr desk built from exactly `rrnewton/herdr@20a0cd5294fb15ef17209612d80d5a2704169990` (Herdr 0.7.4 / protocol 17). That pinned source declares `AGPL-3.0-or-later` and also references a separate commercial-license option.

Handoff publishes the corresponding controller and Windows binaries as the prerelease `herdr-mirror-20a0cd5294fb15ef17209612d80d5a2704169990`, pins their SHA-256 values in source, and publishes the exact Corresponding Source archive plus the upstream license beside the binaries. The responsive runtime remains a separate executable process communicating with Handoff over sockets/SSH; it is isolated from the official v0.8.2 desk, config, state, and session name.

The Windows responsive executable is placed beside the already-installed official v0.8.2 Windows bundle components rather than replacing the official installation. The responsive desk has its own install/config directories under `~/.hn/bin/herdr-mirror/` and `~/.hn/herdr-mirror/`.

Herdr remains a replaceable persistence backend behind Handoff's boundary. Handoff does not vendor Herdr source into this repository; the exact responsive Corresponding Source is distributed with the pinned prerelease artifact.

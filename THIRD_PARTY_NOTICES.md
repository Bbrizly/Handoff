# Third-Party Notices

`hn` is an independent implementation.

## EnvHaven

EnvHaven (`envhaven/envhaven`) was studied as an architectural reference for the local-editor + remote-execution workflow. No EnvHaven source code is vendored in this repository.

## Mutagen

`hn` invokes a separately installed Mutagen executable for synchronization and forwarding. Mutagen is not vendored or redistributed by this repository. Mutagen licensing differs by build; review the upstream license before bundling Mutagen in a distributed product.

## Zellij

`hn` downloads the official Zellij release archive on the controller, verifies its SHA-256, extracts it locally, and copies the Zellij binary to the worker. Zellij is MIT licensed. The repository does not vendor or commit Zellij binaries.

The current prototype pins Zellij v0.45.0 for reproducibility.

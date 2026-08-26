# Third-Party Notices

Handoff is an independent implementation.

## EnvHaven

EnvHaven (`envhaven/envhaven`) was studied as an architectural reference for the local-editor + remote-execution workflow. No EnvHaven source code is vendored in this repository.

## Mutagen

Handoff invokes a separately installed Mutagen executable for synchronization and forwarding. Mutagen is not vendored or redistributed by this repository. Mutagen's licensing differs by build; review the Mutagen license before bundling it in a distributed product.

## Zellij

Handoff can bootstrap the official Zellij Windows binary from the upstream Zellij GitHub release. Zellij is MIT licensed. Handoff does not commit or vendor the Zellij binary in this repository.

The prototype currently pins Zellij v0.45.0 for reproducibility.
